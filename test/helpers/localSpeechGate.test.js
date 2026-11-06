const test = require("node:test");
const assert = require("node:assert/strict");
const { makeSine, makeSeededNoise, mix, delayBy, dbToGain } = require("./harness/pcmFixtures");

const RATE = 16000;
const gate = () => import("../../src/helpers/localSpeechGate.js");

// Uniform noise of amplitude a has RMS a/√3; a sine of amplitude a has a/√2.
const noiseAt = (dbfs, durationMs, seed = 7) =>
  makeSeededNoise({ durationMs, amplitude: dbToGain(dbfs) * Math.sqrt(3), seed, sampleRate: RATE });
const toneAt = (dbfs, durationMs) =>
  makeSine({
    durationMs,
    frequencyHz: 220,
    amplitude: dbToGain(dbfs) * Math.SQRT2,
    sampleRate: RATE,
  });

const toPcm16 = (track) => {
  const out = new Int16Array(track.length);
  for (let i = 0; i < track.length; i++) {
    const v = Math.max(-1, Math.min(1, track[i]));
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
  }
  return out;
};

// Feeds a track through the streaming path, in worklet-sized chunks.
const decide = async (track, chunkSamples = 1600) => {
  const { createLocalSpeechGateState, recordPcm16SpeechWindow, getLocalSpeechGateDecision } =
    await gate();
  const state = createLocalSpeechGateState({ sampleRate: RATE });
  const pcm = toPcm16(track);
  for (let i = 0; i < pcm.length; i += chunkSamples) {
    recordPcm16SpeechWindow(state, pcm.slice(i, i + chunkSamples).buffer);
  }
  return getLocalSpeechGateDecision(state);
};

// A spoken word: a tone placed `atMs` into a recording over a noise floor.
const wordOverFloor = ({ wordDbfs, floorDbfs, wordMs, totalMs, atMs = 600 }) =>
  mix(noiseAt(floorDbfs, totalMs), delayBy(toneAt(wordDbfs, wordMs), atMs, RATE));

test("fails open when no readings were recorded", async () => {
  const { createLocalSpeechGateState, getLocalSpeechGateDecision } = await gate();
  assert.deepEqual(getLocalSpeechGateDecision(createLocalSpeechGateState()), {
    skip: false,
    reason: "unavailable",
  });
  assert.deepEqual(getLocalSpeechGateDecision(null), { skip: false, reason: "unavailable" });
});

test("a whisper-level word over a quiet floor is not skipped", async () => {
  const decision = await decide(
    wordOverFloor({ wordDbfs: -50, floorDbfs: -70, wordMs: 800, totalMs: 2500 })
  );
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, "speech_detected");
  assert.ok(Math.abs(decision.floorDbfs - -70) <= 2, `floor ${decision.floorDbfs}`);
  assert.ok(decision.speechMs >= 700, `speechMs ${decision.speechMs}`);
});

test("a single 300 ms quiet word is not skipped", async () => {
  const decision = await decide(
    wordOverFloor({ wordDbfs: -52, floorDbfs: -72, wordMs: 300, totalMs: 2000 })
  );
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, "speech_detected");
  // Even an 80 ms blip clears the 75 ms minimum.
  const blip = await decide(
    wordOverFloor({ wordDbfs: -52, floorDbfs: -72, wordMs: 80, totalMs: 2000 })
  );
  assert.equal(blip.skip, false);
});

test("digital silence is skipped as silence", async () => {
  const decision = await decide(new Float32Array(RATE * 2));
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "silence");
  assert.equal(decision.readings, 80);
});

test("a dead input's faint hiss is silence, a whisper never is", async () => {
  assert.equal((await decide(noiseAt(-80, 2000))).reason, "silence");
  // A −62 dBFS tone, quieter than a whisper, still sits 8 dB above the bound.
  const whisper = await decide(toneAt(-62, 2000));
  assert.notEqual(whisper.reason, "silence");
});

test("steady noise with no speech is insufficient_speech", async () => {
  const decision = await decide(noiseAt(-55, 3000));
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "insufficient_speech");
  assert.equal(decision.speechReadings, 0);
});

test("a click shorter than 75 ms is not speech", async () => {
  const decision = await decide(
    wordOverFloor({ wordDbfs: -50, floorDbfs: -70, wordMs: 25, totalMs: 2000, atMs: 1000 })
  );
  assert.equal(decision.reason, "insufficient_speech");
});

test("normal speech passes", async () => {
  const decision = await decide(
    wordOverFloor({ wordDbfs: -20, floorDbfs: -60, wordMs: 1200, totalMs: 2500 })
  );
  assert.deepEqual(
    { skip: decision.skip, reason: decision.reason },
    { skip: false, reason: "speech_detected" }
  );
});

test("fails open on a recording too short to estimate its floor", async () => {
  const decision = await decide(toneAt(-55, 300));
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, "floor_unreliable");
});

test("loud input throughout fails open, as the 8-bit gate passed it", async () => {
  // A recording that is speech from start to finish has no floor to beat.
  const decision = await decide(noiseAt(-40, 2000));
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, "speech_detected");
});

test("readings span chunk boundaries and leave a partial reading unrecorded", async () => {
  const { createLocalSpeechGateState, recordPcm16SpeechWindow } = await gate();
  const state = createLocalSpeechGateState({ sampleRate: RATE });
  // 25 ms = 400 samples at 16 kHz; 3 chunks of 300 samples = 2 readings + 100.
  for (let i = 0; i < 3; i++) recordPcm16SpeechWindow(state, new Int16Array(300).fill(1000).buffer);
  assert.equal(state.levels.count, 2);
  assert.equal(state.chunkCount, 3);
  assert.equal(state.pendingSamples, 100);
});

test("the streaming context's rate sets the reading length", async () => {
  const { createLocalSpeechGateState, setSpeechGateSampleRate, recordPcm16SpeechWindow } =
    await gate();
  const state = setSpeechGateSampleRate(createLocalSpeechGateState(), 48000);
  recordPcm16SpeechWindow(state, new Int16Array(2400).buffer);
  assert.equal(state.levels.count, 2);
});

test("batch and streaming read the same history the same way", async () => {
  const { getLocalSpeechGateDecision } = await gate();
  const { createLevelHistory, recordLevel } =
    await import("../../src/helpers/recordingTailPolicy.js");
  // The batch tracker records 25 ms float RMS readings into a bare history.
  const history = createLevelHistory();
  for (let i = 0; i < 40; i++) recordLevel(history, dbToGain(-70), i * 25);
  for (let i = 0; i < 6; i++) recordLevel(history, dbToGain(-50), 1000 + i * 25);
  const batch = getLocalSpeechGateDecision(history);
  const wrapped = getLocalSpeechGateDecision({ levels: history });
  assert.deepEqual(batch, wrapped);
  assert.equal(batch.reason, "speech_detected");
  assert.equal(batch.speechReadings, 6);
});
