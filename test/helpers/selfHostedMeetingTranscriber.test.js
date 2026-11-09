const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyStatus,
  createSelfHostedMeetingTranscriber,
  normalizeLanguage,
  selfHostedBatchUrl,
} = require("../../src/helpers/selfHostedMeetingTranscriber");
const { streamingUrl } = require("../../src/helpers/orukeetStreaming");

const URL_ = "http://127.0.0.1:8770/v1/audio/transcriptions";

// Manual clock: timers fire only when the test advances time.
function createClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pendingTimers: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const ok = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ text }),
  text: async () => "",
});
const status = (code) => ({
  ok: false,
  status: code,
  json: async () => ({}),
  text: async () => "",
});

// A fetch whose answers the test releases one at a time.
function createServer() {
  const requests = [];
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      const request = { url, init, resolve, reject, file: init.body.get("file") };
      init.signal?.addEventListener("abort", () =>
        reject(init.signal.reason ?? new Error("aborted"))
      );
      requests.push(request);
    });
  return { requests, fetchImpl };
}

const chunk = (startAt, label, durationMs = 4000) => ({
  wav: Buffer.from(label),
  startAt,
  endAt: startAt + durationMs,
  durationMs,
  label,
});

const setup = (overrides = {}) => {
  const clock = createClock(1_000_000);
  const server = createServer();
  const results = [];
  const notices = [];
  const transcriber = createSelfHostedMeetingTranscriber({
    url: URL_,
    getApiKey: () => "secret-key",
    language: "en",
    fetchImpl: server.fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    onResult: ({ source, text, chunk: sent }) => results.push({ source, text, label: sent.label }),
    onNotice: (code) => notices.push(code),
    ...overrides,
  });
  return { clock, server, results, notices, transcriber };
};

test("classifies statuses into retry, stop and skip", () => {
  assert.equal(classifyStatus(401), "unauthorized");
  assert.equal(classifyStatus(403), "unauthorized");
  assert.equal(classifyStatus(404), "not_found");
  assert.equal(classifyStatus(500), "transient");
  assert.equal(classifyStatus(503), "transient");
  assert.equal(classifyStatus(429), "transient");
  assert.equal(classifyStatus(408), "transient");
  assert.equal(classifyStatus(400), "rejected");
  assert.equal(classifyStatus(413), "rejected");
});

test("batch URL follows the dictation stream's address rules", () => {
  assert.equal(
    selfHostedBatchUrl("http://127.0.0.1:8770", streamingUrl),
    "http://127.0.0.1:8770/v1/audio/transcriptions"
  );
  assert.equal(
    selfHostedBatchUrl("https://stt.example.com/v1/", streamingUrl),
    "https://stt.example.com/v1/audio/transcriptions"
  );
  assert.equal(
    selfHostedBatchUrl("wss://stt.example.com/v1/audio/transcriptions/stream", streamingUrl),
    "https://stt.example.com/v1/audio/transcriptions"
  );
  assert.throws(() => selfHostedBatchUrl("http://10.0.0.2:8770", streamingUrl), /HTTPS/);
  assert.throws(() => selfHostedBatchUrl("https://a:b@stt.example.com", streamingUrl));
});

test("language is sent only as a plain code", () => {
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage(" DE "), "de");
  assert.equal(normalizeLanguage("auto"), null);
  assert.equal(normalizeLanguage(""), null);
  assert.equal(normalizeLanguage(null), null);
});

test("sends one request at a time with the key, WAV and language", async () => {
  const { server, results, transcriber } = setup();
  transcriber.enqueue("system", chunk(0, "s1"));
  transcriber.enqueue("mic", chunk(100, "m1"));
  await flush();

  assert.equal(server.requests.length, 1, "only one request in flight");
  const [first] = server.requests;
  assert.equal(first.url, URL_);
  assert.equal(first.init.method, "POST");
  assert.equal(first.init.headers.Authorization, "Bearer secret-key");
  assert.equal(first.init.body.get("language"), "en");
  assert.equal(first.init.body.get("response_format"), "json");
  assert.equal(first.file.type, "audio/wav");
  assert.equal(Buffer.from(await first.file.arrayBuffer()).toString(), "s1");

  first.resolve(ok("hello"));
  await flush();
  assert.equal(server.requests.length, 2);
  server.requests[1].resolve(ok("world"));
  await flush();

  assert.deepEqual(results, [
    { source: "system", text: "hello", label: "s1" },
    { source: "mic", text: "world", label: "m1" },
  ]);
});

test("no key saved → no Authorization header", async () => {
  const { server, transcriber } = setup({ getApiKey: () => "" });
  transcriber.enqueue("mic", chunk(0, "m1"));
  await flush();
  assert.equal(server.requests[0].init.headers.Authorization, undefined);
});

test("oldest audio goes first, system winning a near tie", async () => {
  const { server, transcriber } = setup();
  // Hold the queue with a first request so the rest line up behind it.
  transcriber.enqueue("mic", chunk(0, "m0"));
  await flush();
  transcriber.enqueue("mic", chunk(10_000, "m1"));
  transcriber.enqueue("system", chunk(11_000, "s1")); // within the 1.5 s bias
  transcriber.enqueue("system", chunk(20_000, "s2"));
  transcriber.enqueue("mic", chunk(15_000, "m2"));

  const order = [];
  for (let i = 0; i < 5; i += 1) {
    const request = server.requests[i];
    order.push(Buffer.from(await request.file.arrayBuffer()).toString());
    request.resolve(ok(""));
    await flush();
  }
  assert.deepEqual(order, ["m0", "s1", "m1", "m2", "s2"]);
});

test("transient failures retry the same chunk with backoff, keeping order", async () => {
  const { clock, server, results, notices, transcriber } = setup();
  transcriber.enqueue("mic", chunk(0, "m1"));
  transcriber.enqueue("mic", chunk(5000, "m2"));
  await flush();

  server.requests[0].resolve(status(503));
  await flush();
  assert.equal(server.requests.length, 1, "waits before retrying");
  await clock.advance(999);
  assert.equal(server.requests.length, 1);
  await clock.advance(1);
  assert.equal(server.requests.length, 2, "retries after 1 s");
  assert.equal(Buffer.from(await server.requests[1].file.arrayBuffer()).toString(), "m1");

  server.requests[1].reject(new TypeError("fetch failed"));
  await flush();
  await clock.advance(2000);
  assert.equal(server.requests.length, 3, "second retry after 2 s");
  server.requests[2].resolve(ok("first"));
  await flush();
  server.requests[3].resolve(ok("second"));
  await flush();

  assert.deepEqual(
    results.map((r) => r.label),
    ["m1", "m2"]
  );
  assert.deepEqual(notices, [], "a short outage stays quiet");
});

test("a request that hangs times out and is retried", async () => {
  const { clock, server, results, transcriber } = setup({ requestTimeoutMs: () => 5000 });
  transcriber.enqueue("system", chunk(0, "s1"));
  await flush();
  await clock.advance(5000);
  assert.equal(server.requests.length, 1);
  await clock.advance(1000);
  assert.equal(server.requests.length, 2);
  server.requests[1].resolve(ok("late"));
  await flush();
  assert.deepEqual(
    results.map((r) => r.text),
    ["late"]
  );
});

test("sustained failure warns once, then announces recovery", async () => {
  const { clock, server, results, notices, transcriber } = setup({
    requestTimeoutMs: () => 60000,
  });
  transcriber.enqueue("mic", chunk(0, "m1"));
  await flush();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    server.requests.at(-1).reject(new TypeError("ECONNREFUSED"));
    await flush();
    await clock.advance(15000);
  }
  assert.deepEqual(notices, ["unreachable"]);
  server.requests.at(-1).resolve(ok("back"));
  await flush();
  assert.deepEqual(notices, ["unreachable", "recovered"]);
  assert.equal(results[0].text, "back");
});

test("401 stops for good: one notice, queue dropped, nothing more accepted", async () => {
  const { clock, server, results, notices, transcriber } = setup();
  transcriber.enqueue("system", chunk(0, "s1"));
  transcriber.enqueue("mic", chunk(100, "m1"));
  await flush();
  server.requests[0].resolve(status(401));
  await flush();
  await clock.advance(60000);

  assert.deepEqual(notices, ["unauthorized"]);
  assert.equal(server.requests.length, 1, "never retried");
  assert.equal(transcriber.fatal, "unauthorized");
  assert.equal(transcriber.pending, 0);
  assert.equal(transcriber.enqueue("mic", chunk(9000, "m2")), false);
  assert.deepEqual(results, []);
});

test("404 stops with not_found", async () => {
  const { server, notices, transcriber } = setup();
  transcriber.enqueue("system", chunk(0, "s1"));
  await flush();
  server.requests[0].resolve(status(404));
  await flush();
  assert.deepEqual(notices, ["not_found"]);
});

test("a chunk the server can't decode is skipped, the rest continue", async () => {
  const { server, results, notices, transcriber } = setup();
  transcriber.enqueue("mic", chunk(0, "bad"));
  transcriber.enqueue("mic", chunk(4000, "good"));
  await flush();
  server.requests[0].resolve(status(400));
  await flush();
  server.requests[1].resolve(ok("fine"));
  await flush();
  assert.deepEqual(
    results.map((r) => r.label),
    ["good"]
  );
  assert.deepEqual(notices, []);
});

test("queued audio is capped: oldest dropped, one notice, in-flight chunk kept", async () => {
  const { server, results, notices, transcriber } = setup({ maxQueuedAudioMs: 10000 });
  transcriber.enqueue("mic", chunk(0, "m0")); // in flight
  await flush();
  transcriber.enqueue("mic", chunk(4000, "m1"));
  transcriber.enqueue("system", chunk(8000, "s1"));
  // 16 s queued (m0 + m1 + s1 + m2) → m1 then s1 go; m3 then pushes out m2.
  transcriber.enqueue("mic", chunk(12000, "m2"));
  transcriber.enqueue("mic", chunk(16000, "m3"));
  assert.deepEqual(notices, ["audio_dropped"]);
  assert.ok(transcriber.queuedAudioMs <= 10000);

  server.requests[0].resolve(ok("a"));
  await flush();
  server.requests[1].resolve(ok("b"));
  await flush();
  assert.deepEqual(
    results.map((r) => r.label),
    ["m0", "m3"]
  );
});

test("drain waits for the queue, retrying quickly while stopping", async () => {
  const { clock, server, results, transcriber } = setup();
  transcriber.enqueue("mic", chunk(0, "m1"));
  await flush();
  server.requests[0].resolve(status(502));
  await flush();
  // Several failures push the next backoff up…
  for (let i = 0; i < 3; i += 1) {
    await clock.advance(20000);
    server.requests.at(-1).resolve(status(502));
    await flush();
  }
  const before = server.requests.length;
  let drained = null;
  transcriber.drain({ timeoutMs: 30000 }).then((result) => {
    drained = result;
  });
  await flush();
  // …but stopping retries at once.
  assert.equal(server.requests.length, before + 1);
  server.requests.at(-1).resolve(ok("done"));
  await flush();
  assert.deepEqual(drained, { drained: true, abandoned: 0, fatal: null });
  assert.equal(results[0].text, "done");
});

test("drain gives up at its deadline and abandons what is left", async () => {
  const { clock, server, results, transcriber } = setup({ requestTimeoutMs: () => 120000 });
  transcriber.enqueue("mic", chunk(0, "m1"));
  transcriber.enqueue("mic", chunk(4000, "m2"));
  await flush();
  let drained = null;
  transcriber.drain({ timeoutMs: 10000 }).then((result) => {
    drained = result;
  });
  await clock.advance(10000);
  assert.deepEqual(drained, { drained: false, abandoned: 2, fatal: null });
  // A late answer to the aborted request delivers nothing.
  server.requests[0].resolve(ok("late"));
  await flush();
  assert.deepEqual(results, []);
  assert.equal(clock.pendingTimers(), 0);
});

test("drain with nothing queued resolves at once", async () => {
  const { transcriber } = setup();
  assert.deepEqual(await transcriber.drain({ timeoutMs: 1000 }), {
    drained: true,
    abandoned: 0,
    fatal: null,
  });
});

test("abort cancels the request in flight and pending retries", async () => {
  const { clock, server, results, transcriber } = setup();
  transcriber.enqueue("mic", chunk(0, "m1"));
  await flush();
  assert.equal(server.requests[0].init.signal.aborted, false);
  transcriber.abort();
  assert.equal(server.requests[0].init.signal.aborted, true);
  await flush();
  await clock.advance(60000);
  assert.equal(server.requests.length, 1);
  assert.deepEqual(results, []);
  assert.equal(transcriber.enqueue("mic", chunk(5000, "m2")), false);
});
