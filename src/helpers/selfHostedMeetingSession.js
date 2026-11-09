/**
 * Self-hosted meeting transcription session: the per-source pause-aware
 * segmenter feeding the one-request-at-a-time HTTP transcriber.
 *
 * ipcHandlers.js owns everything around it (the mic gate's echo evidence,
 * holdback/dedup, segment events, diarization) and talks to it only through
 * `pushAudio` / `finish` / `abort` plus the `gate`, `onTranscript` and
 * `onNotice` callbacks, so a future streaming client for a live meeting
 * WebSocket can replace this module behind the same shape.
 */
const { createMeetingChunkSegmenter } = require("./meetingChunkSegmenter");
const {
  createSelfHostedMeetingTranscriber,
  selfHostedBatchUrl,
} = require("./selfHostedMeetingTranscriber");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");

const INPUT_SAMPLE_RATE = 24000;
const SOURCES = ["system", "mic"];

/** Stop waits at most this long for queued chunks, scaled by how much is queued. */
function drainTimeoutMs(queuedAudioMs) {
  // ~15× real time on a 4-vCPU box; allow a quarter of real time plus slack.
  return Math.round(Math.min(60000, Math.max(10000, 10000 + queuedAudioMs / 4)));
}

function createSelfHostedMeetingSession({
  baseUrl,
  getApiKey,
  language = null,
  model = null,
  streamingUrl,
  // (source, { pcm16k, chunk }) → { send: boolean, reason?: string }
  gate = () => ({ send: true }),
  // ({ source, text, startAt, endAt, speechStartAt, durationMs })
  onTranscript = () => {},
  onNotice = () => {},
  log = () => {},
  segmenterOptions = {},
  transcriberOptions = {},
}) {
  const url = selfHostedBatchUrl(baseUrl, streamingUrl);
  const segmenters = Object.fromEntries(
    SOURCES.map((source) => [
      source,
      createMeetingChunkSegmenter({ sampleRate: INPUT_SAMPLE_RATE, ...segmenterOptions }),
    ])
  );
  const stats = { chunks: 0, silent: 0, gated: 0 };
  let finished = false;

  const transcriber = createSelfHostedMeetingTranscriber({
    url,
    getApiKey,
    language,
    model,
    log,
    onNotice,
    onResult: ({ source, text, chunk }) => {
      if (!text) return;
      onTranscript({
        source,
        text,
        startAt: chunk.startAt,
        endAt: chunk.endAt,
        speechStartAt: chunk.speechStartAt,
        durationMs: chunk.durationMs,
      });
    },
    ...transcriberOptions,
  });

  const submit = (source, chunk) => {
    stats.chunks += 1;
    if (chunk.silent) {
      stats.silent += 1;
      log("debug", "Skipping silent self-hosted meeting chunk", {
        source,
        audioMs: Math.round(chunk.durationMs),
      });
      return;
    }
    const pcm24k = Buffer.from(
      chunk.samples.buffer,
      chunk.samples.byteOffset,
      chunk.samples.byteLength
    );
    const pcm16k = downsample24kTo16k(pcm24k);
    const verdict = gate(source, { pcm16k, chunk });
    if (!verdict?.send) {
      stats.gated += 1;
      log("debug", "Gated self-hosted meeting chunk", {
        source,
        reason: verdict?.reason ?? null,
        audioMs: Math.round(chunk.durationMs),
      });
      return;
    }
    transcriber.enqueue(source, {
      wav: pcm16ToWav(pcm16k),
      startAt: chunk.startAt,
      endAt: chunk.endAt,
      speechStartAt: chunk.speechStartAt,
      durationMs: chunk.durationMs,
    });
  };

  /** 24 kHz mono s16le PCM captured ending at `at` (ms). */
  const pushAudio = (source, pcm24k, at) => {
    if (finished || !segmenters[source] || transcriber.fatal) return;
    for (const chunk of segmenters[source].append(pcm24k, at)) submit(source, chunk);
  };

  /** Cuts the tails and waits (bounded) for the queue to empty. */
  const finish = async ({ timeoutMs } = {}) => {
    if (!finished) {
      finished = true;
      for (const source of SOURCES) {
        const tail = segmenters[source].flush();
        if (tail) submit(source, tail);
      }
    }
    const budget = timeoutMs ?? drainTimeoutMs(transcriber.queuedAudioMs);
    const result = await transcriber.drain({ timeoutMs: budget });
    log(result.abandoned ? "warn" : "debug", "Self-hosted meeting transcription drained", {
      ...result,
      budgetMs: budget,
      ...stats,
      ...transcriber.stats,
    });
    return result;
  };

  const abort = () => {
    finished = true;
    for (const source of SOURCES) segmenters[source].reset();
    transcriber.abort();
  };

  return {
    url,
    pushAudio,
    finish,
    abort,
    get fatal() {
      return transcriber.fatal;
    },
    stats,
  };
}

module.exports = { createSelfHostedMeetingSession, drainTimeoutMs };
