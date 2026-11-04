// Decides whether a dictation keeps capturing for a moment after the user asks
// it to stop. People release push-to-talk (or tap stop) while the last
// syllable is still sounding, which clips a large share of a one-word
// dictation. When the input is still clearly above the recording's own noise
// floor at the stop request, capture runs on briefly; when it has already
// settled there (a natural pause before release) the stop is immediate, so
// ordinary dictation latency is unchanged.
//
// Pure: callers feed RMS readings (linear, full-precision float samples) with
// a millisecond timestamp, and apply the returned durations themselves.

// Spacing of the level readings, and the stretch of samples each one covers.
export const LEVEL_READING_MS = 25;
// The stretch before the stop request that decides whether speech is still
// going on.
export const TRAILING_WINDOW_MS = 150;
// The stretch re-checked while the tail runs, to decide whether to extend it.
export const CONTINUE_WINDOW_MS = 100;
export const TAIL_INITIAL_MS = 250;
export const TAIL_STEP_MS = 50;
// Hard cap on the whole tail, extensions included.
export const TAIL_MAX_MS = 400;
// Trailing speech must clear the noise floor by this margin...
export const TAIL_SNR_MARGIN_DB = 10;
// ...and the most recent reading must still clear it by this much, so a word
// that ended inside the trailing window doesn't count as still being spoken.
export const TAIL_LATEST_MARGIN_DB = 6;
// Absolute floor for "active": a near-silent mic's hiss never triggers a tail.
export const TAIL_MIN_ACTIVE_DBFS = -50;
// The noise floor is a low percentile of the recording's readings.
export const NOISE_FLOOR_PERCENTILE = 0.1;
// Fewer readings than this (about half a second) can't separate noise from a
// short utterance that is speech throughout, so the floor estimate is capped.
export const MIN_FLOOR_READINGS = 20;
export const SHORT_RECORDING_FLOOR_CEILING_DBFS = -45;

const MIN_DB = -120;
const BIN_COUNT = -MIN_DB + 1; // 1 dB bins, -120..0 dBFS
const RECENT_KEEP_MS = 1000;

export const rmsToDbfs = (rms) => {
  if (!Number.isFinite(rms) || rms <= 0) return MIN_DB;
  return Math.max(MIN_DB, Math.min(0, 20 * Math.log10(rms)));
};

const binFor = (db) => Math.round(db) - MIN_DB;

// A histogram of the whole recording (for the floor, constant memory however
// long it runs) plus the last second of readings (for the trailing window).
export const createLevelHistory = () => ({
  bins: new Uint32Array(BIN_COUNT),
  count: 0,
  recent: [],
});

export const recordLevel = (history, rms, atMs) => {
  if (!history || !Number.isFinite(rms) || !Number.isFinite(atMs)) return history;
  const db = rmsToDbfs(rms);
  history.bins[binFor(db)] += 1;
  history.count += 1;
  history.recent.push({ atMs, rms, db });
  const cutoff = atMs - RECENT_KEEP_MS;
  while (history.recent.length > 0 && history.recent[0].atMs < cutoff) history.recent.shift();
  return history;
};

const readingsSince = (history, sinceMs) => history.recent.filter((r) => r.atMs > sinceMs);

const powerMeanDb = (readings) => {
  if (readings.length === 0) return MIN_DB;
  let power = 0;
  for (const r of readings) power += r.rms * r.rms;
  return rmsToDbfs(Math.sqrt(power / readings.length));
};

// The floor over everything but the excluded (trailing) readings.
export const estimateNoiseFloorDb = (history, exclude = []) => {
  if (!history) return { floorDb: SHORT_RECORDING_FLOOR_CEILING_DBFS, readings: 0 };
  const bins = Uint32Array.from(history.bins);
  for (const r of exclude) {
    const bin = binFor(r.db);
    if (bins[bin] > 0) bins[bin] -= 1;
  }
  const readings = history.count - exclude.length;
  if (readings <= 0) return { floorDb: SHORT_RECORDING_FLOOR_CEILING_DBFS, readings: 0 };
  const target = Math.max(1, Math.ceil(readings * NOISE_FLOOR_PERCENTILE));
  let seen = 0;
  let floorDb = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i];
    if (seen >= target) {
      floorDb = i + MIN_DB;
      break;
    }
  }
  if (readings < MIN_FLOOR_READINGS) {
    floorDb = Math.min(floorDb, SHORT_RECORDING_FLOOR_CEILING_DBFS);
  }
  return { floorDb, readings };
};

const round1 = (value) => Math.round(value * 10) / 10;

// At the stop request: { extendMs } is 0 for a settled input (stop now), or
// the first stretch of tail to capture. The returned thresholdDb is carried
// into continueRecordingTail, so readings taken during the tail can't move the
// floor they are judged against.
export const decideRecordingTail = (history, nowMs) => {
  const trailing = history ? readingsSince(history, nowMs - TRAILING_WINDOW_MS) : [];
  if (trailing.length === 0) {
    return { extendMs: 0, reason: "no_levels" };
  }
  const { floorDb, readings } = estimateNoiseFloorDb(history, trailing);
  const thresholdDb = Math.max(floorDb + TAIL_SNR_MARGIN_DB, TAIL_MIN_ACTIVE_DBFS);
  const latestThresholdDb = Math.max(floorDb + TAIL_LATEST_MARGIN_DB, TAIL_MIN_ACTIVE_DBFS);
  const trailingDb = powerMeanDb(trailing);
  const latestDb = trailing[trailing.length - 1].db;
  const active = trailingDb >= thresholdDb && latestDb >= latestThresholdDb;
  return {
    extendMs: active ? TAIL_INITIAL_MS : 0,
    reason: active ? "trailing_speech" : "settled",
    trailingDb: round1(trailingDb),
    latestDb: round1(latestDb),
    floorDb: round1(floorDb),
    thresholdDb: round1(thresholdDb),
    floorReadings: readings,
  };
};

// While the tail runs: how much longer to capture (0 = stop now). Extends in
// short steps while the recent input is still above the threshold, never past
// TAIL_MAX_MS in total.
export const continueRecordingTail = (history, nowMs, { elapsedMs, thresholdDb }) => {
  if (!history || !Number.isFinite(elapsedMs) || !Number.isFinite(thresholdDb)) return 0;
  const remaining = TAIL_MAX_MS - elapsedMs;
  if (remaining <= 0) return 0;
  const recent = readingsSince(history, nowMs - CONTINUE_WINDOW_MS);
  if (recent.length === 0 || powerMeanDb(recent) < thresholdDb) return 0;
  return Math.min(TAIL_STEP_MS, remaining);
};
