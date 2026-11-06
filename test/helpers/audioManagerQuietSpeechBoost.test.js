const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { makeSine, makeSeededNoise, mix, delayBy, dbToGain } = require("./harness/pcmFixtures");

// The rebuilt speech gate and the quiet-input boost, through AudioManager:
// quiet speech is transcribed and boosted, normal speech reaches the engine
// byte for byte as before, and history keeps the original WebM.

const RATE = 16000;

const noiseAt = (dbfs, durationMs) =>
  makeSeededNoise({
    durationMs,
    amplitude: dbToGain(dbfs) * Math.sqrt(3),
    seed: 5,
    sampleRate: RATE,
  });
const toneAt = (dbfs, durationMs) =>
  makeSine({
    durationMs,
    frequencyHz: 250,
    amplitude: dbToGain(dbfs) * Math.SQRT2,
    sampleRate: RATE,
  });
const speech = (speechDbfs, floorDbfs = -70) =>
  mix(noiseAt(floorDbfs, 3000), delayBy(toneAt(speechDbfs, 1200), 800, RATE));

const toPcm16 = (track) => {
  const out = new Int16Array(track.length);
  for (let i = 0; i < track.length; i++) {
    const v = Math.max(-1, Math.min(1, track[i]));
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
  }
  return out;
};

const rmsDbOfWav = (bytes) => {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) / 2);
  let max = -Infinity;
  for (let i = 0; i + 320 <= samples.length; i += 320) {
    let sum = 0;
    for (let j = i; j < i + 320; j++) sum += (samples[j] / 0x8000) ** 2;
    max = Math.max(max, 10 * Math.log10(sum / 320));
  }
  return max;
};

async function setup(t, settings) {
  const harness = await loadAudioManager(t, {
    cachePrefix: "openwhispr-quiet-boost-test-",
    settingsKey: "__quietBoostSettings",
    settings,
  });
  const { buildWav } = await import("../../src/utils/wavBuilder.ts");
  const gate = await import("../../src/helpers/localSpeechGate.js");
  // The level history the batch tracker would have filled for this audio.
  const levelsFor = (track) => {
    const state = gate.createLocalSpeechGateState({ sampleRate: RATE });
    gate.recordPcm16SpeechWindow(state, toPcm16(track).buffer);
    return state;
  };
  const wavOf = (track) => buildWav(toPcm16(track), RATE);
  return { ...harness, buildWav, levelsFor, wavOf };
}

const LOCAL_WHISPER = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  cloudTranscriptionMode: "byok",
  isSignedIn: false,
  customDictionary: [],
};

const webm = () => new Blob([new Uint8Array([26, 69, 223, 163, 9, 9])], { type: "audio/webm" });

function pipelineManager(createManager, overrides) {
  return createManager({
    isProcessing: true,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    onStateChange() {},
    ...overrides,
  });
}

test("a quiet local-whisper recording is transcribed, not skipped", async (t) => {
  const { createManager, levelsFor } = await setup(t, LOCAL_WHISPER);
  const whisper = speech(-50);
  const state = levelsFor(whisper);
  let routed = null;
  const completed = [];
  const manager = pipelineManager(createManager, {
    _localSpeechGateState: state,
    _recordingLevels: state.levels,
    processWithLocalWhisper: async (_blob, _model, metadata) => {
      routed = metadata;
      return { success: true, text: "whispered" };
    },
    onTranscriptionComplete: (result) => completed.push(result.text),
  });

  await manager.processAudio(webm(), { durationSeconds: 3 });

  assert.ok(routed, "whisper.cpp ran");
  assert.equal(routed.quietSpeechHint.quiet, true);
  assert.deepEqual(completed, ["whispered"]);
});

test("steady noise and a dead input are still skipped for local whisper", async (t) => {
  const { createManager, levelsFor } = await setup(t, LOCAL_WHISPER);
  for (const track of [noiseAt(-55, 3000), new Float32Array(RATE * 2)]) {
    let ran = false;
    const completed = [];
    const manager = pipelineManager(createManager, {
      _localSpeechGateState: levelsFor(track),
      processWithLocalWhisper: async () => {
        ran = true;
        return { success: true, text: "hallucination" };
      },
      onTranscriptionComplete: (result) => completed.push(result.text),
    });
    await manager.processAudio(webm(), { durationSeconds: 3 });
    assert.equal(ran, false);
    assert.deepEqual(completed, [""]);
  }
});

test("steady noise is not skipped for other providers, digital silence is", async (t) => {
  const { createManager, levelsFor } = await setup(t, {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    isSignedIn: false,
  });
  for (const [track, expectRun] of [
    [noiseAt(-55, 3000), true],
    [new Float32Array(RATE * 2), false],
  ]) {
    let ran = false;
    const manager = pipelineManager(createManager, {
      _localSpeechGateState: levelsFor(track),
      getTranscriptionModel: () => "whisper-1",
      processWithOpenAIAPI: async () => {
        ran = true;
        return { success: true, text: "x" };
      },
      onTranscriptionComplete() {},
    });
    await manager.processAudio(webm(), { durationSeconds: 3 });
    assert.equal(ran, expectRun);
  }
});

async function localWhisperRun(t, settings, track) {
  const { window, createManager, wavOf } = await setup(t, settings);
  const sent = [];
  window.electronAPI.transcribeLocalWhisper = async (buffer) => {
    sent.push(new Uint8Array(buffer));
    return { success: true, text: "hi" };
  };
  const manager = createManager({ processTranscription: async (text) => text });
  const rawWav = wavOf(track);
  const original = new Uint8Array(await rawWav.arrayBuffer());
  await manager.processWithLocalWhisper(webm(), "base", { rawWav, durationSeconds: 3 });
  assert.equal(sent.length, 1);
  return { sent: sent[0], original };
}

test("a quiet recording's rawWav reaches whisper.cpp boosted", async (t) => {
  const { sent, original } = await localWhisperRun(t, LOCAL_WHISPER, speech(-48));
  assert.equal(Buffer.from(sent.subarray(0, 4)).toString(), "RIFF");
  assert.equal(sent.length, original.length);
  const before = rmsDbOfWav(original);
  const after = rmsDbOfWav(sent);
  assert.ok(after - before >= 15, `boosted by ${after - before} dB`);
});

test("a normal recording's rawWav reaches whisper.cpp byte for byte", async (t) => {
  const { sent, original } = await localWhisperRun(t, LOCAL_WHISPER, speech(-18, -60));
  assert.deepEqual(Buffer.from(sent), Buffer.from(original));
});

test("with the setting off a quiet rawWav is sent unchanged", async (t) => {
  const { sent, original } = await localWhisperRun(
    t,
    { ...LOCAL_WHISPER, quietSpeechBoost: false },
    speech(-48)
  );
  assert.deepEqual(Buffer.from(sent), Buffer.from(original));
});

test("Parakeet gets the boosted rawWav too", async (t) => {
  const { window, createManager, wavOf } = await setup(t, {
    ...LOCAL_WHISPER,
    localTranscriptionProvider: "nvidia",
  });
  const sent = [];
  window.electronAPI.transcribeLocalParakeet = async (buffer) => {
    sent.push(new Uint8Array(buffer));
    return { success: true, text: "hi" };
  };
  const manager = createManager({ processTranscription: async (text) => text });
  const rawWav = wavOf(speech(-48));
  const original = new Uint8Array(await rawWav.arrayBuffer());
  await manager.processWithLocalParakeet(webm(), "parakeet-tdt-0.6b-v3", { rawWav });
  assert.ok(rmsDbOfWav(sent[0]) - rmsDbOfWav(original) >= 15);
});

// BYOK and self-hosted: the WebM is decoded only when the levels say quiet.
async function byokManager(t, settings, decodedTrack, { decodeFails = false } = {}) {
  const decodes = [];
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    async decodeAudioData() {
      decodes.push(1);
      if (decodeFails) throw new Error("Cannot decode");
      return {
        sampleRate: RATE,
        numberOfChannels: 1,
        getChannelData: () => Float32Array.from(decodedTrack),
      };
    }
  };
  t.after(() => {
    if (originalContext === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = originalContext;
  });
  const harness = await setup(t, {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    allowLocalFallback: false,
    ...settings,
  });
  const uploads = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    uploads.push(init.body.get("file"));
    return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
  });
  const manager = pipelineManager(harness.createManager, {
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    getEffectiveSttLanguage: () => "auto",
    getTranscriptionModel: () => "whisper-1",
    getAPIKey: async () => "test-key",
    getTranscriptionEndpoint: () => "https://stt.example.com/v1/audio/transcriptions",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
  return { ...harness, manager, uploads, decodes };
}

const SELF_HOSTED = {
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "http://192.168.1.5:8080",
  remoteTranscriptionModel: "whisper",
};

for (const [label, settings] of [
  ["BYOK", {}],
  ["self-hosted", SELF_HOSTED],
]) {
  test(`${label}: a quiet recording uploads a boosted WAV, history keeps the WebM`, async (t) => {
    const whisper = speech(-50);
    const { manager, uploads, decodes, levelsFor } = await byokManager(t, settings, whisper);
    const recording = webm();
    const state = levelsFor(whisper);
    Object.assign(manager, {
      lastAudioBlob: recording,
      _localSpeechGateState: state,
      _recordingLevels: state.levels,
    });
    const completed = [];
    manager.onTranscriptionComplete = (result) => completed.push(result.text);

    await manager.processAudio(recording, { durationSeconds: 3 });

    assert.deepEqual(completed, ["transcribed"]);
    assert.equal(decodes.length, 1);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].type, "audio/wav");
    assert.equal(uploads[0].name, "audio.wav");
    const bytes = new Uint8Array(await uploads[0].arrayBuffer());
    assert.ok(rmsDbOfWav(bytes) > -35, `uploaded level ${rmsDbOfWav(bytes)}`);
    assert.equal(manager.lastAudioBlob, recording);
    assert.equal(recording.type, "audio/webm");
  });

  test(`${label}: a normal recording uploads the original WebM without decoding`, async (t) => {
    const normal = speech(-18, -60);
    const { manager, uploads, decodes, levelsFor } = await byokManager(t, settings, normal);
    const recording = webm();
    const state = levelsFor(normal);
    Object.assign(manager, { _localSpeechGateState: state, _recordingLevels: state.levels });
    manager.onTranscriptionComplete = () => {};

    await manager.processAudio(recording, { durationSeconds: 3 });

    assert.equal(decodes.length, 0);
    assert.equal(uploads[0].type, "audio/webm");
    assert.deepEqual(
      Buffer.from(await uploads[0].arrayBuffer()),
      Buffer.from(await recording.arrayBuffer())
    );
  });
}

test("BYOK: a failed decode uploads the original WebM", async (t) => {
  const whisper = speech(-50);
  const { manager, uploads, levelsFor } = await byokManager(t, {}, whisper, { decodeFails: true });
  const recording = webm();
  const state = levelsFor(whisper);
  Object.assign(manager, { _localSpeechGateState: state, _recordingLevels: state.levels });
  manager.onTranscriptionComplete = () => {};
  await manager.processAudio(recording, { durationSeconds: 3 });
  assert.equal(uploads[0].type, "audio/webm");
});

test("BYOK: a quiet hint the decoded audio doesn't confirm uploads the WebM", async (t) => {
  // The levels said quiet, the decoded audio is normal: nothing to boost.
  const { manager, uploads, decodes, levelsFor } = await byokManager(t, {}, speech(-18, -60));
  const state = levelsFor(speech(-50));
  Object.assign(manager, { _localSpeechGateState: state, _recordingLevels: state.levels });
  manager.onTranscriptionComplete = () => {};
  await manager.processAudio(webm(), { durationSeconds: 3 });
  assert.equal(decodes.length, 1);
  assert.equal(uploads[0].type, "audio/webm");
});

test("BYOK: the setting off never decodes", async (t) => {
  const whisper = speech(-50);
  const { manager, uploads, decodes, levelsFor } = await byokManager(
    t,
    { quietSpeechBoost: false },
    whisper
  );
  const state = levelsFor(whisper);
  Object.assign(manager, { _localSpeechGateState: state, _recordingLevels: state.levels });
  manager.onTranscriptionComplete = () => {};
  await manager.processAudio(webm(), { durationSeconds: 3 });
  assert.equal(decodes.length, 0);
  assert.equal(uploads[0].type, "audio/webm");
});

test("BYOK: a recording whose WAV would be too large keeps the WebM", async (t) => {
  const whisper = speech(-50);
  const { manager, uploads, decodes, levelsFor } = await byokManager(t, {}, whisper);
  const state = levelsFor(whisper);
  Object.assign(manager, { _localSpeechGateState: state, _recordingLevels: state.levels });
  manager.onTranscriptionComplete = () => {};
  await manager.processAudio(webm(), { durationSeconds: 600 });
  assert.equal(decodes.length, 0);
  assert.equal(uploads[0].type, "audio/webm");
});
