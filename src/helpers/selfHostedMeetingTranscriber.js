/**
 * Batch transcription of meeting chunks on a self-hosted server
 * (OpenAI-compatible `POST /v1/audio/transcriptions`).
 *
 * The server runs one inference at a time and also serves dictation, so this
 * keeps at most one request in flight per meeting: a dictation spoken during
 * a meeting only ever waits behind one short chunk. Chunks queue per source
 * (FIFO) and are sent oldest audio first, with a small bias toward system
 * audio so a remote utterance is usually committed before its mic echo, as the
 * local path does.
 *
 * Failures:
 * - network error, timeout, 408/425/429/5xx → retried with backoff, the chunk
 *   keeps its place (order and timestamps never change). After
 *   `unreachableWarnAfterMs` of failing, one `unreachable` notice; `recovered`
 *   when a request succeeds again.
 * - 401/403 → `unauthorized`, 404/405 → `not_found`: retrying can't help, so
 *   the queue is dropped and nothing more is accepted.
 * - any other 4xx (undecodable or oversized chunk) → that chunk is dropped.
 * Queued audio is capped (`maxQueuedAudioMs`); past it the oldest chunk is
 * dropped with one `audio_dropped` notice per outage.
 *
 * Fetch and timers are injected so the policy is unit-testable. Nothing here
 * logs transcript text, audio or the key.
 */

const DEFAULTS = Object.freeze({
  // A busy server may first finish a dictation, so the budget grows with the chunk.
  requestTimeoutMs: (audioMs) => 30000 + audioMs,
  backoffMs: [1000, 2000, 4000, 8000, 15000],
  // While stopping, a failing server is retried quickly until the drain deadline.
  drainBackoffCapMs: 2000,
  unreachableWarnAfterMs: 20000,
  // ~20 minutes of audio at 16 kHz is ~38 MB of WAV.
  maxQueuedAudioMs: 20 * 60 * 1000,
  systemBiasMs: 1500,
});

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

class SelfHostedChunkError extends Error {
  constructor(kind, status = null, message = null) {
    super(message || (status ? `Self-hosted server answered ${status}` : kind));
    this.name = "SelfHostedChunkError";
    this.kind = kind;
    this.status = status;
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404 || status === 405) return "not_found";
  if (status >= 500 || RETRYABLE_STATUSES.has(status)) return "transient";
  return "rejected";
}

/**
 * The batch endpoint for a self-hosted server URL, with the same rules as the
 * dictation stream (`streamingUrl`): no credentials or query, HTTPS unless the
 * host is this machine, and a trailing `/v1…` path folded away.
 */
function selfHostedBatchUrl(baseUrl, streamingUrl) {
  const url = new URL(streamingUrl(baseUrl));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/stream$/, "");
  return url.toString();
}

const normalizeLanguage = (language) => {
  const code = typeof language === "string" ? language.trim().toLowerCase() : "";
  return /^[a-z]{2,3}$/.test(code) ? code : null;
};

async function postMeetingChunk({ url, apiKey, wav, language, model, fetchImpl, signal }) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "meeting-chunk.wav");
  form.append("response_format", "json");
  const code = normalizeLanguage(language);
  if (code) form.append("language", code);
  if (model) form.append("model", model);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SelfHostedChunkError("transient", null, error?.message || "network error");
  }

  if (!response.ok) {
    // Drain the body so the connection can be reused; its text is not logged.
    await response.text?.().catch(() => {});
    throw new SelfHostedChunkError(classifyStatus(response.status), response.status);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new SelfHostedChunkError("rejected", response.status, "Response was not JSON");
  }
  return typeof body?.text === "string" ? body.text.trim() : "";
}

function createSelfHostedMeetingTranscriber({
  url,
  getApiKey = () => "",
  language = null,
  model = null,
  fetchImpl = (...args) => fetch(...args),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  now = () => Date.now(),
  onResult = () => {},
  onNotice = () => {},
  log = () => {},
  ...overrides
} = {}) {
  const config = { ...DEFAULTS, ...overrides };
  const queues = { system: [], mic: [] };
  let inFlight = null;
  let controller = null;
  let retryTimer = null;
  let closed = false;
  let fatal = null;
  let failures = 0;
  let failingSince = null;
  let warnedUnreachable = false;
  let warnedDropped = false;
  let draining = false;
  let idleWaiters = [];
  const stats = { sent: 0, failed: 0, dropped: 0, rejected: 0 };

  const queuedAudioMs = () =>
    [...queues.system, ...queues.mic].reduce((sum, chunk) => sum + (chunk.durationMs || 0), 0);
  const pendingCount = () => queues.system.length + queues.mic.length;
  const isIdle = () => !inFlight && (pendingCount() === 0 || fatal || closed);

  const settleIdle = () => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const notice = (code, detail = {}) => {
    try {
      onNotice(code, detail);
    } catch (error) {
      log("warn", "Self-hosted meeting notice handler failed", { code, error: error?.message });
    }
  };

  // Oldest audio first; system wins a near tie so its text is there to
  // de-duplicate the mic's echo of it.
  const pickSource = () => {
    const system = queues.system[0];
    const mic = queues.mic[0];
    if (!system) return mic ? "mic" : null;
    if (!mic) return "system";
    return system.startAt <= mic.startAt + config.systemBiasMs ? "system" : "mic";
  };

  const enforceCap = () => {
    let dropped = 0;
    while (queuedAudioMs() > config.maxQueuedAudioMs) {
      // Never the chunk on the wire: its result would land with no queue entry.
      const candidates = ["system", "mic"]
        .map((source) => {
          const queue = queues[source];
          const index = inFlight?.source === source ? 1 : 0;
          return queue[index] ? { source, index, chunk: queue[index] } : null;
        })
        .filter(Boolean)
        .sort((left, right) => left.chunk.startAt - right.chunk.startAt);
      if (!candidates.length) break;
      const oldest = candidates[0];
      queues[oldest.source].splice(oldest.index, 1);
      dropped += 1;
    }
    if (!dropped) return;
    stats.dropped += dropped;
    log("warn", "Self-hosted meeting queue full, dropped oldest audio", {
      dropped,
      queuedMs: Math.round(queuedAudioMs()),
    });
    if (!warnedDropped) {
      warnedDropped = true;
      notice("audio_dropped", { dropped });
    }
  };

  const scheduleRetry = () => {
    const step = config.backoffMs[Math.min(failures - 1, config.backoffMs.length - 1)] ?? 1000;
    const delay = draining ? Math.min(step, config.drainBackoffCapMs) : step;
    retryTimer = setTimer(() => {
      retryTimer = null;
      pump();
    }, delay);
  };

  const fail = (kind, status) => {
    fatal = kind;
    const lost = pendingCount();
    queues.system = [];
    queues.mic = [];
    log("error", "Self-hosted meeting transcription stopped", { kind, status, lost });
    notice(kind, { status, lost });
  };

  const send = async (source) => {
    const chunk = queues[source][0];
    inFlight = { source, chunk };
    controller = new AbortController();
    let timedOut = false;
    const timeoutMs = config.requestTimeoutMs(chunk.durationMs || 0);
    const timeout = setTimer(() => {
      timedOut = true;
      controller?.abort();
    }, timeoutMs);
    const startedAt = now();

    try {
      const text = await postMeetingChunk({
        url,
        apiKey: getApiKey(),
        wav: chunk.wav,
        language,
        model,
        fetchImpl,
        signal: controller.signal,
      });
      if (closed) return;
      queues[source].shift();
      stats.sent += 1;
      if (failingSince != null) {
        log("info", "Self-hosted meeting server reachable again", {
          downMs: now() - failingSince,
          attempts: failures,
        });
        if (warnedUnreachable) notice("recovered", { downMs: now() - failingSince });
      }
      failures = 0;
      failingSince = null;
      warnedUnreachable = false;
      warnedDropped = false;
      log("debug", "Self-hosted meeting chunk transcribed", {
        source,
        audioMs: Math.round(chunk.durationMs || 0),
        requestMs: now() - startedAt,
        chars: text.length,
        queued: pendingCount(),
      });
      try {
        onResult({ source, text, chunk });
      } catch (error) {
        log("error", "Self-hosted meeting result handler failed", { error: error?.message });
      }
    } catch (error) {
      if (closed) return;
      const kind = timedOut ? "transient" : error?.kind || "transient";
      const status = error?.status ?? null;
      if (kind === "unauthorized" || kind === "not_found") {
        fail(kind, status);
        return;
      }
      if (kind === "rejected") {
        queues[source].shift();
        stats.rejected += 1;
        log("warn", "Self-hosted server rejected a meeting chunk; skipping it", {
          source,
          status,
          audioMs: Math.round(chunk.durationMs || 0),
        });
        return;
      }
      failures += 1;
      stats.failed += 1;
      failingSince ??= startedAt;
      log("warn", "Self-hosted meeting chunk failed; will retry", {
        source,
        status,
        timedOut,
        attempt: failures,
        queued: pendingCount(),
        error: timedOut ? "timeout" : error?.message,
      });
      if (!warnedUnreachable && now() - failingSince >= config.unreachableWarnAfterMs) {
        warnedUnreachable = true;
        notice("unreachable", { downMs: now() - failingSince, queued: pendingCount() });
      }
      scheduleRetry();
    } finally {
      clearTimer(timeout);
      inFlight = null;
      controller = null;
      if (!retryTimer) pump();
      settleIdle();
    }
  };

  function pump() {
    if (inFlight || retryTimer || fatal || closed) {
      settleIdle();
      return;
    }
    const source = pickSource();
    if (!source) {
      settleIdle();
      return;
    }
    void send(source);
  }

  /** Queues a chunk ({ wav, startAt, durationMs, … }); false when nothing more is accepted. */
  const enqueue = (source, chunk) => {
    if (closed || fatal || !queues[source]) return false;
    queues[source].push(chunk);
    enforceCap();
    pump();
    return true;
  };

  const abort = () => {
    closed = true;
    if (retryTimer) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    controller?.abort();
    queues.system = [];
    queues.mic = [];
    settleIdle();
  };

  /**
   * Waits until every queued chunk is transcribed, the transcriber gave up, or
   * `timeoutMs` passes; then whatever is left is abandoned.
   */
  const drain = async ({ timeoutMs = 30000 } = {}) => {
    draining = true;
    if (retryTimer) {
      // Retry now rather than after a long backoff.
      clearTimer(retryTimer);
      retryTimer = null;
      pump();
    }
    let deadline = null;
    const idle = new Promise((resolve) => {
      idleWaiters.push(resolve);
      settleIdle();
    });
    const timedOut = await Promise.race([
      idle.then(() => false),
      new Promise((resolve) => {
        deadline = setTimer(() => resolve(true), timeoutMs);
      }),
    ]);
    clearTimer(deadline);
    const abandoned = pendingCount();
    if (timedOut) abort();
    return { drained: !timedOut && !fatal, abandoned: timedOut ? abandoned : 0, fatal };
  };

  return {
    enqueue,
    drain,
    abort,
    get fatal() {
      return fatal;
    },
    get pending() {
      return pendingCount();
    },
    get queuedAudioMs() {
      return queuedAudioMs();
    },
    stats,
  };
}

module.exports = {
  SELF_HOSTED_MEETING_DEFAULTS: DEFAULTS,
  SelfHostedChunkError,
  classifyStatus,
  createSelfHostedMeetingTranscriber,
  normalizeLanguage,
  postMeetingChunk,
  selfHostedBatchUrl,
};
