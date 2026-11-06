const test = require("node:test");
const assert = require("node:assert/strict");
const { makeSine, makeSeededNoise, mix, delayBy, dbToGain } = require("./harness/pcmFixtures");

const RATE = 16000;
const boost = () => import("../../src/helpers/quietSpeechBoost.js");

const noiseAt = (dbfs, durationMs, seed = 3) =>
  makeSeededNoise({ durationMs, amplitude: dbToGain(dbfs) * Math.sqrt(3), seed, sampleRate: RATE });
const toneAt = (dbfs, durationMs, frequencyHz = 300) =>
  makeSine({ durationMs, frequencyHz, amplitude: dbToGain(dbfs) * Math.SQRT2, sampleRate: RATE });

const toPcm16 = (track) => {
  const out = new Int16Array(track.length);
  for (let i = 0; i < track.length; i++) {
    const v = Math.max(-1, Math.min(1, track[i]));
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
  }
  return out;
};

const speechOverFloor = ({ speechDbfs, floorDbfs, speechMs = 1200, totalMs = 3000 }) =>
  mix(noiseAt(floorDbfs, totalMs), delayBy(toneAt(speechDbfs, speechMs), 800, RATE));

const rmsDb = (samples, start = 0, end = samples.length) => {
  const scale = samples instanceof Int16Array ? 1 / 0x8000 : 1;
  let sum = 0;
  for (let i = start; i < end; i++) sum += (samples[i] * scale) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / (end - start)));
};

const peakOf = (samples) => {
  const scale = samples instanceof Int16Array ? 1 / 0x8000 : 1;
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s * scale));
  return peak;
};

test("normal-level speech is returned untouched: the same array, every byte equal", async () => {
  const { boostQuietSpeech } = await boost();
  for (const speechDbfs of [-12, -20, -26, -30]) {
    const pcm = toPcm16(speechOverFloor({ speechDbfs, floorDbfs: -60 }));
    const copy = Int16Array.from(pcm);
    const result = boostQuietSpeech(pcm, RATE);
    assert.equal(result.applied, false, `speech at ${speechDbfs} dBFS`);
    assert.equal(result.reason, "not_quiet");
    assert.equal(result.samples, pcm);
    assert.deepEqual(Buffer.from(result.samples.buffer), Buffer.from(copy.buffer));
  }
});

test("float input is returned untouched too", async () => {
  const { boostQuietSpeech } = await boost();
  const track = speechOverFloor({ speechDbfs: -18, floorDbfs: -65 });
  const copy = Float32Array.from(track);
  const result = boostQuietSpeech(track, RATE);
  assert.equal(result.applied, false);
  assert.equal(result.samples, track);
  assert.deepEqual(result.samples, copy);
});

test("speech within the hysteresis band of the target is left alone", async () => {
  const { boostQuietSpeech, TARGET_SPEECH_DBFS, MIN_GAIN_DB } = await boost();
  // A 95th-percentile frame 2 dB under the target needs less than MIN_GAIN_DB.
  const pcm = toPcm16(speechOverFloor({ speechDbfs: TARGET_SPEECH_DBFS - 2, floorDbfs: -65 }));
  const result = boostQuietSpeech(pcm, RATE);
  assert.ok(MIN_GAIN_DB > 2);
  assert.equal(result.applied, false);
  assert.equal(result.samples, pcm);
});

test("a whisper is raised toward the target", async () => {
  const { boostQuietSpeech, TARGET_SPEECH_DBFS } = await boost();
  const pcm = toPcm16(speechOverFloor({ speechDbfs: -40, floorDbfs: -70 }));
  const result = boostQuietSpeech(pcm, RATE);
  assert.equal(result.applied, true);
  assert.equal(result.reason, "quiet");
  assert.ok(result.samples instanceof Int16Array);
  assert.notEqual(result.samples, pcm);
  assert.equal(result.samples.length, pcm.length);
  assert.ok(Math.abs(result.speechLevelDbfs - -40) <= 1, `level ${result.speechLevelDbfs}`);
  assert.ok(Math.abs(result.noiseFloorDbfs - -70) <= 1.5, `floor ${result.noiseFloorDbfs}`);
  assert.ok(Math.abs(result.gainDb - 12) <= 1, `gain ${result.gainDb}`);
  // The speech stretch (800..2000 ms) now sits near the target.
  const level = rmsDb(result.samples, 0.9 * RATE, 1.9 * RATE);
  assert.ok(Math.abs(level - TARGET_SPEECH_DBFS) <= 1.5, `boosted level ${level}`);
});

test("gain is capped at MAX_GAIN_DB", async () => {
  const { boostQuietSpeech, MAX_GAIN_DB } = await boost();
  const pcm = toPcm16(speechOverFloor({ speechDbfs: -55, floorDbfs: -80 }));
  const result = boostQuietSpeech(pcm, RATE);
  assert.equal(result.applied, true);
  assert.equal(result.gainDb, MAX_GAIN_DB);
  const level = rmsDb(result.samples, 0.9 * RATE, 1.9 * RATE);
  assert.ok(Math.abs(level - (-55 + MAX_GAIN_DB)) <= 1.5, `boosted level ${level}`);
});

test("the limiter keeps peaks under -1 dBFS without hard clipping", async () => {
  const { boostQuietSpeech, softLimit, LIMITER_CEILING_DBFS } = await boost();
  const ceiling = dbToGain(LIMITER_CEILING_DBFS);
  // Quiet speech with a loud click: +20 dB would put the click over full scale.
  const track = speechOverFloor({ speechDbfs: -50, floorDbfs: -75 });
  for (let i = 0; i < 40; i++) track[RATE + i] = i % 2 ? 0.3 : -0.3;
  const result = boostQuietSpeech(toPcm16(track), RATE);
  assert.equal(result.applied, true);
  const peak = peakOf(result.samples);
  assert.ok(peak <= ceiling + 1 / 0x8000, `peak ${peak}`);
  // No flat top: across twice full scale the curve keeps rising, so louder
  // input always comes out louder (a hard clip would flatten it).
  for (let x = 0.5; x < 2; x += 0.01) assert.ok(softLimit(x + 0.01) > softLimit(x), `at ${x}`);
  // The curve itself: transparent below the knee, monotonic, bounded.
  assert.equal(softLimit(0.25), 0.25);
  assert.equal(softLimit(-0.25), -0.25);
  assert.ok(softLimit(0.7) < softLimit(0.8));
  assert.ok(softLimit(10) <= ceiling);
  assert.ok(softLimit(-10) >= -ceiling);
});

test("no speech above the floor means no boost, whatever the level", async () => {
  const { boostQuietSpeech } = await boost();
  const pcm = toPcm16(noiseAt(-55, 3000));
  const result = boostQuietSpeech(pcm, RATE);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "no_speech");
  assert.equal(result.samples, pcm);
  // Very faint "speech" under the absolute minimum is not speech either.
  const faint = toPcm16(speechOverFloor({ speechDbfs: -64, floorDbfs: -85 }));
  assert.equal(boostQuietSpeech(faint, RATE).reason, "no_speech");
});

test("recordings too short to estimate a floor are not boosted", async () => {
  const { boostQuietSpeech } = await boost();
  const pcm = toPcm16(toneAt(-45, 400));
  const result = boostQuietSpeech(pcm, RATE);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "too_short");
  assert.equal(result.samples, pcm);
  assert.equal(boostQuietSpeech(new Int16Array(0), RATE).reason, "no_audio");
});

test("a 300 ms whispered word in a short recording is boosted", async () => {
  const { boostQuietSpeech } = await boost();
  const pcm = toPcm16(
    speechOverFloor({ speechDbfs: -48, floorDbfs: -72, speechMs: 300, totalMs: 1200 })
  );
  const result = boostQuietSpeech(pcm, RATE);
  assert.equal(result.applied, true);
  assert.ok(result.gainDb >= 18, `gain ${result.gainDb}`);
});

test("the high-pass removes rumble before the gain", async () => {
  const { boostQuietSpeech } = await boost();
  // Whisper plus steady 30 Hz handling rumble.
  const track = mix(speechOverFloor({ speechDbfs: -45, floorDbfs: -72 }), toneAt(-62, 3000, 30));
  const result = boostQuietSpeech(toPcm16(track), RATE);
  assert.equal(result.applied, true);
  // Measure 30 Hz energy before and after by correlating with the rumble.
  const corr = (samples, gain) => {
    const scale = samples instanceof Int16Array ? 1 / 0x8000 : 1;
    let re = 0;
    let im = 0;
    for (let i = 0; i < samples.length; i++) {
      const w = (2 * Math.PI * 30 * i) / RATE;
      re += samples[i] * scale * Math.cos(w);
      im += samples[i] * scale * Math.sin(w);
    }
    return Math.hypot(re, im) / gain;
  };
  const before = corr(track, 1);
  const after = corr(result.samples, dbToGain(result.gainDb));
  // A 2nd-order 80 Hz high-pass takes 30 Hz down by about 17 dB.
  assert.ok(20 * Math.log10(after / before) < -12, `rumble ${20 * Math.log10(after / before)} dB`);
});

test("quietSpeechHint reads the 25 ms level history with slack", async () => {
  const { quietSpeechHint, HINT_SLACK_DB, TARGET_SPEECH_DBFS, MIN_GAIN_DB } = await boost();
  const { createLevelHistory, recordLevel } =
    await import("../../src/helpers/recordingTailPolicy.js");
  const history = (speechDb) => {
    const h = createLevelHistory();
    for (let i = 0; i < 60; i++) recordLevel(h, dbToGain(-70), i * 25);
    for (let i = 0; i < 40; i++) recordLevel(h, dbToGain(speechDb), 1500 + i * 25);
    return h;
  };
  assert.equal(quietSpeechHint(history(-48)).quiet, true);
  assert.equal(quietSpeechHint(history(-20)).quiet, false);
  // Slack: a level the PCM analysis would leave alone still asks for a look.
  const edge = TARGET_SPEECH_DBFS - MIN_GAIN_DB + HINT_SLACK_DB - 1;
  assert.equal(quietSpeechHint(history(edge)).quiet, true);
  assert.deepEqual(quietSpeechHint(null), { quiet: false, reason: "no_levels" });
  const short = createLevelHistory();
  recordLevel(short, dbToGain(-50), 0);
  assert.equal(quietSpeechHint(short).reason, "too_short");
  const noise = createLevelHistory();
  for (let i = 0; i < 80; i++) recordLevel(noise, dbToGain(-55), i * 25);
  assert.equal(quietSpeechHint(noise).quiet, false);
});

test("parsePcm16Wav reads the renderer's own WAV and nothing else", async () => {
  const { parsePcm16Wav } = await boost();
  const { buildWav } = await import("../../src/utils/wavBuilder.ts");
  const samples = Int16Array.from([1, -2, 3, -4]);
  const parsed = parsePcm16Wav(await buildWav(samples, RATE).arrayBuffer());
  assert.equal(parsed.sampleRate, RATE);
  assert.deepEqual(Array.from(parsed.samples), [1, -2, 3, -4]);
  assert.equal(parsePcm16Wav(new ArrayBuffer(10)), null);
  assert.equal(parsePcm16Wav(new TextEncoder().encode("x".repeat(64)).buffer), null);
});
