const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const frame = (tag) => {
  const data = new Int16Array(800);
  data[0] = tag;
  return data.buffer;
};
const tags = (frames) => frames.map((f) => new Int16Array(f)[0]);

// A manager that prepares for, then starts, a streaming dictation against fake
// Web Audio nodes. Every worklet node shares one port the test drives.
async function setup(t, cachePrefix, { startResult = { success: true } } = {}) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix,
    settingsKey: "__streamingPreRollSettings",
    settings: { useLocalWhisper: false, cloudTranscriptionMode: "byok" },
  });
  const nodes = [];
  globalThis.AudioWorkletNode = class {
    constructor(context, name) {
      this.context = context;
      this.name = name;
      this.port = { posted: [], postMessage: (m) => this.port.posted.push(m), onmessage: null };
      this.connections = [];
      this.disconnected = 0;
      nodes.push(this);
    }
    connect(target) {
      this.connections.push(target);
    }
    disconnect() {
      this.disconnected += 1;
    }
  };
  t.after(() => delete globalThis.AudioWorkletNode);
  const sources = [];
  const node = () => ({
    connections: [],
    disconnected: 0,
    connect(target) {
      this.connections.push(target);
    },
    disconnect() {
      this.disconnected += 1;
    },
  });
  const context = {
    sampleRate: 16000,
    state: "running",
    createMediaStreamSource: () => {
      const source = node();
      sources.push(source);
      return source;
    },
    createAnalyser: () => ({ ...node(), fftSize: 2048, getFloatTimeDomainData() {} }),
  };
  let stored = null;
  const sent = [];
  const start = deferred();
  const stream = { getAudioTracks: () => [], getTracks: () => [] };
  const manager = createManager({
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
    workletModuleLoaded: true,
    preparedMicCapture: {
      prepare: async (acquire) => (stored = await acquire()),
      take: async () => {
        const value = stored;
        stored = null;
        return value;
      },
    },
    isRecordingAllowedByPolicy: () => true,
    shouldUseStreaming: () => true,
    _beginActivationCapture: async () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    _startRecordingSpool: () => null,
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => context,
    getWorkletBlobUrl: () => "test",
    getStreamingProviderName: () => "openai-realtime",
    getStreamingProvider: () => ({
      onPartial: () => () => {},
      onFinal: () => () => {},
      onError: () => () => {},
      onSessionEnd: () => () => {},
      send: (data) => sent.push(data),
      start: async () => {
        await start.promise;
        return startResult;
      },
    }),
    beginMicRecovery: async () => {},
    getEffectiveSttLanguage: () => "en",
    getKeyterms: () => [],
    onStateChange() {},
  });
  t.after(() => manager._stopTailLevelTracker());
  return { manager, nodes, sources, sent, start, getPrepared: () => stored };
}

test("streaming pre-roll reaches the provider first, exactly once, then live audio", async (t) => {
  const { manager, nodes, sources, sent, start } = await setup(t, "openwhispr-preroll-order-");
  await manager.prepareMicCapture();
  assert.equal(nodes.length, 1);
  const [processor] = nodes;
  assert.equal(processor.name, "pcm-streaming-processor");
  assert.deepEqual(sources[0].connections, [processor]);
  // The opening words, spoken before the session exists.
  processor.port.onmessage({ data: frame(1) });
  processor.port.onmessage({ data: frame(2) });
  processor.port.onmessage({ data: "flushed" });

  const starting = manager.startStreamingRecording();
  await tick(10);
  // The session adopted the prepared node rather than building another, so the
  // frame sequence is continuous; no second source feeds it.
  assert.equal(nodes.length, 1);
  assert.equal(manager.streamingProcessor, processor);
  assert.equal(manager.streamingSource, sources[0]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].connections.filter((c) => c === processor).length, 1);
  // The waveform analyser listens to the adopted source too.
  assert.equal(sources[0].connections.length, 2);
  // Live audio while the session connects is held behind the pre-roll.
  processor.port.onmessage({ data: frame(3) });
  assert.deepEqual(sent, []);

  start.resolve();
  assert.equal(await starting, true);
  assert.deepEqual(tags(sent), [1, 2, 3]);
  processor.port.onmessage({ data: frame(4) });
  assert.deepEqual(tags(sent), [1, 2, 3, 4]);
  // The pre-roll frames went through the speech gate with the live ones.
  assert.equal(manager._streamingSpeechGateState.windowCount, 4);
});

test("frames between the take and the session's handler stay in order", async (t) => {
  const { manager, nodes, getPrepared } = await setup(t, "openwhispr-preroll-adopt-");
  await manager.prepareMicCapture();
  const [processor] = nodes;
  processor.port.onmessage({ data: frame(1) });
  const adopted = manager._adoptStreamingPreRoll(getPrepared());
  assert.equal(getPrepared().streamingPreRoll, null);
  processor.port.onmessage({ data: frame(2) });
  processor.port.onmessage({ data: "flushed" });
  assert.deepEqual(tags(adopted.pending), [1, 2]);
});

test("a stale prepare's pre-roll is dropped; its node still carries live audio", async (t) => {
  const { manager, nodes, sent, start, getPrepared } = await setup(t, "openwhispr-preroll-stale-");
  await manager.prepareMicCapture();
  const [processor] = nodes;
  processor.port.onmessage({ data: frame(1) });
  processor.port.onmessage({ data: frame(2) });
  // Prepared long before this start: audio from before the user meant to dictate.
  getPrepared().startedAt -= 60000;
  const starting = manager.startStreamingRecording();
  await tick(10);
  processor.port.onmessage({ data: frame(3) });
  start.resolve();
  assert.equal(await starting, true);
  assert.deepEqual(tags(sent), [3]);
});

test("a start that fails before adopting the node releases the prepared pre-roll", async (t) => {
  const { manager, nodes } = await setup(t, "openwhispr-preroll-failure-");
  await manager.prepareMicCapture();
  const [processor] = nodes;
  manager.getOrCreateAudioContext = async () => {
    throw new Error("audio context unavailable");
  };
  manager.onError = () => {};
  manager.cleanupStreaming = async () => {};
  manager.micStreamHold = { touch() {} };
  assert.equal(await manager.startStreamingRecording(), false);
  assert.equal(processor.port.onmessage, null);
  assert.ok(processor.port.posted.includes("stop"));
  assert.ok(processor.disconnected >= 1);
});

test("a prepared streaming pre-roll is released when a batch recording takes the capture", async (t) => {
  const { manager, nodes, getPrepared } = await setup(t, "openwhispr-preroll-to-batch-");
  await manager.prepareMicCapture();
  const [processor] = nodes;
  const { discardPreRoll } = await import("../../src/helpers/preparedMicCapture.js");
  // startRecording's path for a prepare with no batch recorder.
  discardPreRoll(getPrepared());
  assert.equal(processor.port.onmessage, null);
  assert.ok(processor.port.posted.includes("stop"));
});

test("a batch prepare buffers no streaming pre-roll", async (t) => {
  const { manager, nodes, getPrepared } = await setup(t, "openwhispr-preroll-batch-mode-");
  manager.shouldUseStreaming = () => false;
  manager._startPreRollRecorder = () => {};
  await manager.prepareMicCapture();
  assert.equal(nodes.length, 0);
  assert.equal(getPrepared().streamingPreRoll, null);
});
