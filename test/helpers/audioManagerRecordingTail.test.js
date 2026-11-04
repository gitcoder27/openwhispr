const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const policy = () => import("../../src/helpers/recordingTailPolicy.js");
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function load(t, cachePrefix) {
  return loadAudioManager(t, {
    cachePrefix,
    settingsKey: "__recordingTailSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
    },
  });
}

// A second of noise floor followed by half a second that is either still
// speech (released mid-word) or back at the floor (a pause before release),
// timestamped up to the present like the analyser sampler's readings.
async function levels({ speaking }) {
  const { createLevelHistory, recordLevel } = await policy();
  const history = createLevelHistory();
  const now = performance.now();
  const floor = 10 ** (-65 / 20);
  for (let at = now - 1500; at < now - 500; at += 25) recordLevel(history, floor, at);
  for (let at = now - 500; at <= now; at += 25) recordLevel(history, speaking ? 0.1 : floor, at);
  return { history, sample() {}, timer: null };
}

function batchRecorder() {
  return {
    state: "recording",
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
      this.state = "inactive";
    },
  };
}

function batchManager(createManager, overrides) {
  const recorder = batchRecorder();
  const manager = createManager({
    mediaRecorder: recorder,
    isRecording: true,
    isStreaming: false,
    _rotatingBatchRecorder: null,
    _recordingTail: null,
    _batchRecordingGeneration: 1,
    micRecovery: { stop() {} },
    ...overrides,
  });
  return { manager, recorder };
}

test("a batch stop with a settled tail stops the recorder at once, as before", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-batch-settled-");
  const { manager, recorder } = batchManager(createManager, {
    _tailLevels: await levels({ speaking: false }),
  });
  assert.equal(manager.stopRecording({ allowTail: true }), true);
  assert.equal(recorder.stopCalls, 1);
  assert.equal(manager.isRecordingTailActive(), false);
  assert.equal(await manager.waitForRecordingTail(), true);
});

test("a batch stop mid-word keeps recording for the tail, once, then stops", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-batch-active-");
  const { TAIL_INITIAL_MS, TAIL_MAX_MS } = await policy();
  const { manager, recorder } = batchManager(createManager, {
    _tailLevels: await levels({ speaking: true }),
  });
  const startedAt = performance.now();
  assert.equal(manager.stopRecording({ allowTail: true }), true);
  assert.equal(recorder.stopCalls, 0);
  assert.equal(manager.isRecording, true);
  // A repeated stop during the tail reports the same stop and changes nothing.
  assert.equal(manager.stopRecording({ allowTail: true }), true);
  assert.equal(manager.stopRecording(), true);
  assert.equal(recorder.stopCalls, 0);

  assert.equal(await manager.waitForRecordingTail(), true);
  const tailMs = performance.now() - startedAt;
  assert.equal(recorder.stopCalls, 1);
  assert.ok(tailMs >= TAIL_INITIAL_MS - 5, `tail ${tailMs}`);
  assert.ok(tailMs < TAIL_MAX_MS + 150, `tail ${tailMs}`);
});

test("a stop that doesn't allow a tail (forced, deferred) never gets one", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-batch-forced-");
  const { manager, recorder } = batchManager(createManager, {
    _tailLevels: await levels({ speaking: true }),
  });
  assert.equal(manager.stopRecording(), true);
  assert.equal(recorder.stopCalls, 1);
  assert.equal(manager.isRecordingTailActive(), false);
});

test("a cancel during the batch tail discards at once and never stops it later", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-batch-cancel-");
  let reset = 0;
  const { manager, recorder } = batchManager(createManager, {
    _tailLevels: await levels({ speaking: true }),
    takeDiscardedBatchSnapshot: () => ({}),
    persistDiscardedBatchRecording() {},
    resetDiscardedBatchRecordingState() {
      reset += 1;
      this.isRecording = false;
      this.mediaRecorder = null;
    },
  });
  assert.equal(manager.stopRecording({ allowTail: true }), true);
  const waiting = manager.waitForRecordingTail();
  assert.equal(manager.cancelRecording(), true);
  // Aborted: the hook skips the stop cue.
  assert.equal(await waiting, false);
  assert.equal(reset, 1);
  assert.equal(recorder.stopCalls, 1);
  await tick(450);
  assert.equal(recorder.stopCalls, 1);
});

test("a recording that ended on its own during the tail isn't stopped again", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-batch-ended-");
  const { manager, recorder } = batchManager(createManager, {
    _tailLevels: await levels({ speaking: true }),
  });
  let stopNow = 0;
  manager._stopRecordingNow = () => {
    stopNow += 1;
    return true;
  };
  manager.stopRecording({ allowTail: true });
  // The mic died and finalized it; a next recording has started since.
  manager._batchRecordingGeneration += 1;
  assert.equal(await manager.waitForRecordingTail(), true);
  assert.equal(stopNow, 0);
  assert.equal(recorder.stopCalls, 0);
});

function streamingManager(createManager, provider, overrides = {}) {
  const states = [];
  const completions = [];
  const manager = createManager({
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now(),
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 3,
    _activeStreamingSessionId: 3,
    _streamingMicSwapPromise: null,
    _recordingTail: null,
    streamingFinalText: "",
    streamingPartialText: "",
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    cleanupPreview: async () => null,
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "openai-realtime",
    onStateChange: (state) => states.push(state),
    onTranscriptionComplete: (result) => completions.push(result),
    ...overrides,
  });
  return { manager, states, completions };
}

test("a cancel during the streaming tail discards the stream without finalizing it", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-streaming-cancel-");
  const provider = {
    finalizeCalls: 0,
    stopCalls: 0,
    finalize() {
      this.finalizeCalls += 1;
    },
    async stop() {
      this.stopCalls += 1;
      return { success: true };
    },
  };
  const { manager, states, completions } = streamingManager(createManager, provider, {
    _tailLevels: await levels({ speaking: true }),
  });

  const stopping = manager.stopStreamingRecording({ allowTail: true });
  // Still recording (live frames still flow) but already stopping: a second
  // stop is the same stop, and a new start is refused.
  assert.equal(manager.isRecording, true);
  assert.equal(manager.isRecordingTailActive(), true);
  const duplicate = manager.stopStreamingRecording({ allowTail: true });
  assert.equal(manager.getState().isFinalizingStreaming, true);
  const waiting = manager.waitForRecordingTail();

  const cancelled = manager.cancelStreamingRecording();
  assert.equal(await waiting, false);
  assert.equal(await cancelled, true);
  assert.equal(await stopping, true);
  assert.equal(await duplicate, true);
  assert.equal(provider.finalizeCalls, 0);
  assert.equal(provider.stopCalls, 1);
  assert.deepEqual(completions, []);
  // Never entered processing.
  assert.equal(
    states.some((state) => state.isProcessing),
    false
  );
  assert.equal(manager.isStreaming, false);
  assert.equal(manager.isRecording, false);
});

test("a streaming stop mid-word finalizes after the tail; a settled one at once", async (t) => {
  const { createManager } = await load(t, "openwhispr-tail-streaming-finalize-");
  const { TAIL_INITIAL_MS } = await policy();
  for (const speaking of [true, false]) {
    let finalizedAt = null;
    const provider = {
      finalize() {
        finalizedAt = performance.now();
      },
      async stop() {
        return { success: true };
      },
    };
    const { manager } = streamingManager(createManager, provider, {
      _tailLevels: await levels({ speaking }),
    });
    const startedAt = performance.now();
    await manager.stopStreamingRecording({ allowTail: true });
    const delay = finalizedAt - startedAt;
    if (speaking) assert.ok(delay >= TAIL_INITIAL_MS - 5, `delay ${delay}`);
    // The non-acknowledged providers wait 120 ms for the flush to travel.
    else assert.ok(delay < TAIL_INITIAL_MS - 50, `delay ${delay}`);
  }
});
