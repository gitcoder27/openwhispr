const test = require("node:test");
const assert = require("node:assert/strict");
const { makeSine, makeSeededNoise, mix, rmsOf, dbToGain } = require("./harness/pcmFixtures");

const load = () => import("../../src/helpers/recordingTailPolicy.js");

const SAMPLE_RATE = 16000;

// Feeds a signal through the history the way the analyser sampler does: one
// RMS reading per LEVEL_READING_MS of samples, timestamped from startMs.
async function feed(history, signal, { startMs = 0 } = {}) {
  const { recordLevel, LEVEL_READING_MS } = await load();
  const step = Math.round((SAMPLE_RATE * LEVEL_READING_MS) / 1000);
  let t = startMs;
  for (let i = 0; i + step <= signal.length; i += step) {
    t += LEVEL_READING_MS;
    recordLevel(history, rmsOf(signal.subarray(i, i + step)), t);
  }
  return t;
}

const noise = (durationMs, db, seed = 1) =>
  makeSeededNoise({
    durationMs,
    amplitude: dbToGain(db) * Math.sqrt(3),
    seed,
    sampleRate: SAMPLE_RATE,
  });
const voice = (durationMs, db) =>
  makeSine({
    frequencyHz: 220,
    durationMs,
    amplitude: dbToGain(db) * Math.SQRT2,
    sampleRate: SAMPLE_RATE,
  });
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

test("a settled tail (pause before release) stops immediately", async () => {
  const { createLevelHistory, decideRecordingTail } = await load();
  const history = createLevelHistory();
  const signal = concat(
    noise(500, -65),
    mix(voice(1500, -20), noise(1500, -65, 2)),
    noise(400, -65, 3)
  );
  const now = await feed(history, signal);
  const decision = decideRecordingTail(history, now);
  assert.equal(decision.extendMs, 0);
  assert.equal(decision.reason, "settled");
  assert.ok(decision.floorDb <= -60, `floor ${decision.floorDb}`);
});

test("speech still sounding at release extends the recording", async () => {
  const { createLevelHistory, decideRecordingTail, TAIL_INITIAL_MS } = await load();
  const history = createLevelHistory();
  const signal = concat(noise(600, -65), mix(voice(800, -22), noise(800, -65, 2)));
  const now = await feed(history, signal);
  const decision = decideRecordingTail(history, now);
  assert.equal(decision.extendMs, TAIL_INITIAL_MS);
  assert.equal(decision.reason, "trailing_speech");
  assert.ok(decision.trailingDb >= decision.thresholdDb);
});

test("a word that ended just inside the trailing window doesn't count as still spoken", async () => {
  const { createLevelHistory, decideRecordingTail } = await load();
  const history = createLevelHistory();
  // Speech stops 75 ms before the stop request: the trailing mean is still
  // high, but the latest reading is back at the floor.
  const signal = concat(noise(600, -65), voice(800, -20), noise(75, -65, 4));
  const now = await feed(history, signal);
  assert.equal(decideRecordingTail(history, now).extendMs, 0);
});

test("a noisy room's steady noise raises the floor, so it never triggers a tail", async () => {
  const { createLevelHistory, decideRecordingTail } = await load();
  const history = createLevelHistory();
  const signal = concat(
    noise(800, -30),
    mix(voice(1200, -12), noise(1200, -30, 5)),
    noise(300, -30, 6)
  );
  const now = await feed(history, signal);
  const decision = decideRecordingTail(history, now);
  assert.equal(decision.extendMs, 0);
  assert.ok(decision.floorDb > -40, `floor ${decision.floorDb}`);

  // The same room with the speaker mid-word at release does get one.
  const speaking = createLevelHistory();
  const mid = concat(noise(800, -30), mix(voice(1200, -12), noise(1200, -30, 5)));
  const midNow = await feed(speaking, mid);
  assert.ok(decideRecordingTail(speaking, midNow).extendMs > 0);
});

test("a near-silent mic's hiss never triggers, even well above its own floor", async () => {
  const { createLevelHistory, decideRecordingTail, TAIL_MIN_ACTIVE_DBFS } = await load();
  const history = createLevelHistory();
  // Floor at -90, "activity" at -60: 30 dB of SNR but below the absolute minimum.
  const signal = concat(noise(800, -90), noise(800, -60, 7));
  const now = await feed(history, signal);
  const decision = decideRecordingTail(history, now);
  assert.equal(decision.extendMs, 0);
  assert.equal(decision.thresholdDb, TAIL_MIN_ACTIVE_DBFS);
});

test("a one-word recording that is speech throughout still gets a tail", async () => {
  const { createLevelHistory, decideRecordingTail, SHORT_RECORDING_FLOOR_CEILING_DBFS } =
    await load();
  const history = createLevelHistory();
  // 350 ms, all speech: too few readings to estimate a floor from.
  const now = await feed(history, voice(350, -24));
  const decision = decideRecordingTail(history, now);
  assert.ok(decision.extendMs > 0);
  assert.equal(decision.floorDb, SHORT_RECORDING_FLOOR_CEILING_DBFS);
});

test("no readings (analyser never ran) means no tail", async () => {
  const { createLevelHistory, decideRecordingTail } = await load();
  assert.equal(decideRecordingTail(createLevelHistory(), 1000).extendMs, 0);
  assert.equal(decideRecordingTail(null, 1000).extendMs, 0);
  // Readings older than the trailing window don't count either.
  const history = createLevelHistory();
  const end = await feed(history, voice(500, -20));
  assert.equal(decideRecordingTail(history, end + 500).reason, "no_levels");
});

test("the tail extends while speech continues and never passes the cap", async () => {
  const {
    createLevelHistory,
    decideRecordingTail,
    continueRecordingTail,
    TAIL_INITIAL_MS,
    TAIL_MAX_MS,
    TAIL_STEP_MS,
  } = await load();
  const history = createLevelHistory();
  let now = await feed(history, concat(noise(600, -65), voice(600, -20)));
  const decision = decideRecordingTail(history, now);
  assert.equal(decision.extendMs, TAIL_INITIAL_MS);

  // Speech keeps going through the whole tail.
  let elapsed = TAIL_INITIAL_MS;
  now = await feed(history, voice(TAIL_INITIAL_MS, -20), { startMs: now });
  let total = elapsed;
  for (;;) {
    const more = continueRecordingTail(history, now, {
      elapsedMs: elapsed,
      thresholdDb: decision.thresholdDb,
    });
    if (more === 0) break;
    assert.ok(more <= TAIL_STEP_MS);
    now = await feed(history, voice(more, -20), { startMs: now });
    elapsed += more;
    total += more;
  }
  assert.equal(total, TAIL_MAX_MS);
  assert.equal(
    continueRecordingTail(history, now, { elapsedMs: TAIL_MAX_MS + 30, thresholdDb: -40 }),
    0
  );
});

test("the tail stops at its first stretch once the word has decayed", async () => {
  const { createLevelHistory, decideRecordingTail, continueRecordingTail, TAIL_INITIAL_MS } =
    await load();
  const history = createLevelHistory();
  let now = await feed(history, concat(noise(600, -65), voice(600, -20)));
  const decision = decideRecordingTail(history, now);
  now = await feed(history, concat(voice(100, -26), noise(150, -65, 8)), { startMs: now });
  assert.equal(
    continueRecordingTail(history, now, {
      elapsedMs: TAIL_INITIAL_MS,
      thresholdDb: decision.thresholdDb,
    }),
    0
  );
});

test("the floor ignores the trailing readings it is compared with", async () => {
  const { createLevelHistory, estimateNoiseFloorDb, recordLevel } = await load();
  const history = createLevelHistory();
  for (let i = 0; i < 30; i++) recordLevel(history, dbToGain(-70), i * 25);
  const loud = [];
  for (let i = 30; i < 36; i++) {
    recordLevel(history, dbToGain(-20), i * 25);
    loud.push(history.recent[history.recent.length - 1]);
  }
  assert.equal(estimateNoiseFloorDb(history, loud).floorDb, -70);
  assert.equal(estimateNoiseFloorDb(history, loud).readings, 30);
});
