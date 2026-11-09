const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  createSelfHostedMeetingSession,
  drainTimeoutMs,
} = require("../../src/helpers/selfHostedMeetingSession");
const { streamingUrl } = require("../../src/helpers/orukeetStreaming");

const RATE = 24000;

const tone = (ms, amplitude = 0.3, hz = 220) => {
  const n = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(
      Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * hz * i) / RATE)),
      i * 2
    );
  }
  return buf;
};
const silence = (ms) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);

// A stand-in for voice-stt's batch endpoint: checks auth, counts concurrency,
// answers with the uploaded WAV's length so tests can match chunks to text.
async function startMockServer({ key = "k", fail = () => null, delayMs = 20 } = {}) {
  const state = { requests: [], inFlight: 0, maxInFlight: 0 };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", async () => {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const body = Buffer.concat(parts);
      const riff = body.indexOf("RIFF");
      const request = {
        url: req.url,
        auth: req.headers.authorization || null,
        language: /name="language"\r\n\r\n([a-z]+)/.exec(body.toString("latin1"))?.[1] ?? null,
        sampleRate: riff >= 0 ? body.readUInt32LE(riff + 24) : null,
        channels: riff >= 0 ? body.readUInt16LE(riff + 22) : null,
        audioMs: riff >= 0 ? (body.readUInt32LE(riff + 40) / 2 / 16000) * 1000 : null,
      };
      state.requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.inFlight -= 1;
      const forced = fail(state.requests.length);
      if (forced) {
        res.writeHead(forced, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"detail":"invalid API key"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: `chunk ${state.requests.length}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Pushes audio in 100 ms pieces stamped on a virtual capture clock.
const push = (session, source, buffer, clock) => {
  const pieceBytes = (RATE / 10) * 2;
  for (let offset = 0; offset < buffer.length; offset += pieceBytes) {
    const piece = buffer.subarray(offset, offset + pieceBytes);
    clock.t += (piece.length / 2 / RATE) * 1000;
    session.pushAudio(source, piece, clock.t);
  }
};

test("drain budget scales with queued audio within bounds", () => {
  assert.equal(drainTimeoutMs(0), 10000);
  assert.equal(drainTimeoutMs(60_000), 25000);
  assert.equal(drainTimeoutMs(60 * 60 * 1000), 60000);
});

test("a meeting's chunks reach the server one at a time, as 16 kHz WAV, timed by capture", async (t) => {
  const mock = await startMockServer();
  t.after(mock.close);
  const transcripts = [];
  const session = createSelfHostedMeetingSession({
    baseUrl: mock.baseUrl,
    getApiKey: () => "k",
    language: "de",
    streamingUrl,
    onTranscript: (segment) => transcripts.push(segment),
  });
  assert.equal(session.url, `${mock.baseUrl}/v1/audio/transcriptions`);

  const system = { t: 100_000 };
  const mic = { t: 100_000 };
  push(session, "system", Buffer.concat([tone(4000), silence(700), tone(3500)]), system);
  push(session, "mic", Buffer.concat([silence(2000), tone(3000, 0.2, 330), silence(700)]), mic);
  push(session, "mic", tone(2000, 0.2, 330), mic);

  const result = await session.finish();
  assert.deepEqual(result, { drained: true, abandoned: 0, fatal: null });

  assert.equal(mock.state.maxInFlight, 1, "never more than one request in flight");
  for (const request of mock.state.requests) {
    assert.equal(request.url, "/v1/audio/transcriptions");
    assert.equal(request.auth, "Bearer k");
    assert.equal(request.language, "de");
    assert.equal(request.sampleRate, 16000);
    assert.equal(request.channels, 1);
  }
  // Two cuts at pauses plus the two tails.
  assert.equal(mock.state.requests.length, 4);

  const bySource = (source) => transcripts.filter((segment) => segment.source === source);
  const [systemFirst, systemTail] = bySource("system");
  assert.ok(Math.abs(systemFirst.startAt - 100_000) < 1);
  assert.ok(systemTail.startAt > systemFirst.startAt);
  const [micFirst] = bySource("mic");
  // Speech starts 2 s in; the segment carries that time, not the arrival time.
  assert.ok(
    Math.abs(micFirst.speechStartAt - 102_000) < 100,
    String(micFirst.speechStartAt - 102_000)
  );
  for (const segment of transcripts) assert.match(segment.text, /^chunk \d+$/);
});

test("silent and gated chunks never reach the server", async (t) => {
  const mock = await startMockServer();
  t.after(mock.close);
  const gated = [];
  const session = createSelfHostedMeetingSession({
    baseUrl: mock.baseUrl,
    getApiKey: () => "k",
    streamingUrl,
    gate: (source, { pcm16k }) => {
      gated.push({ source, bytes: pcm16k.length });
      return source === "mic" ? { send: false, reason: "system_dominant" } : { send: true };
    },
  });
  const clock = { t: 0 };
  push(session, "system", silence(8000), clock);
  push(session, "mic", tone(4000), { t: 0 });
  await session.finish();

  assert.equal(mock.state.requests.length, 0);
  assert.ok(
    gated.some((entry) => entry.source === "mic"),
    "speech reached the gate"
  );
  assert.equal(
    gated.some((entry) => entry.source === "system"),
    false,
    "silence is skipped before the gate"
  );
  assert.equal(session.stats.gated, 1);
  assert.ok(session.stats.silent >= 1);
});

test("a wrong key stops the session after one request and reports it once", async (t) => {
  const mock = await startMockServer({ key: "right" });
  t.after(mock.close);
  const notices = [];
  const session = createSelfHostedMeetingSession({
    baseUrl: mock.baseUrl,
    getApiKey: () => "wrong",
    streamingUrl,
    onNotice: (code) => notices.push(code),
  });
  const clock = { t: 0 };
  push(
    session,
    "system",
    Buffer.concat([tone(4000), silence(700), tone(4000), silence(700)]),
    clock
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  push(session, "system", Buffer.concat([tone(4000), silence(700)]), clock);
  const result = await session.finish();

  assert.deepEqual(notices, ["unauthorized"]);
  assert.equal(mock.state.requests.length, 1);
  assert.equal(result.fatal, "unauthorized");
  assert.equal(session.fatal, "unauthorized");
});

test("a 5xx is retried and the transcript keeps its order", async (t) => {
  const mock = await startMockServer({ fail: (n) => (n === 1 ? 503 : null) });
  t.after(mock.close);
  const transcripts = [];
  const session = createSelfHostedMeetingSession({
    baseUrl: mock.baseUrl,
    getApiKey: () => "k",
    streamingUrl,
    onTranscript: (segment) => transcripts.push(segment),
    transcriberOptions: { backoffMs: [10] },
  });
  push(session, "mic", Buffer.concat([tone(3500), silence(700), tone(3500)]), { t: 0 });
  await session.finish();

  assert.equal(mock.state.requests.length, 3);
  assert.equal(transcripts.length, 2);
  assert.ok(transcripts[0].startAt < transcripts[1].startAt);
});

test("an unreachable server: stop drains within its budget and abandons the rest", async () => {
  const notices = [];
  const session = createSelfHostedMeetingSession({
    // Nothing listens on port 9 (discard) on loopback in CI.
    baseUrl: "http://127.0.0.1:9",
    getApiKey: () => "k",
    streamingUrl,
    onNotice: (code) => notices.push(code),
    transcriberOptions: { backoffMs: [20], drainBackoffCapMs: 20 },
  });
  push(session, "mic", Buffer.concat([tone(3500), silence(700), tone(3500)]), { t: 0 });
  const started = Date.now();
  const result = await session.finish({ timeoutMs: 400 });
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.drained, false);
  assert.equal(result.abandoned, 2);
});

test("an address the dictation stream would refuse is refused up front", () => {
  assert.throws(
    () =>
      createSelfHostedMeetingSession({
        baseUrl: "http://192.168.1.10:8770",
        getApiKey: () => "k",
        streamingUrl,
      }),
    /HTTPS/
  );
});
