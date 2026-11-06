// Decides, before transcription, whether a recording holds anything worth
// sending to the engine. Pure: callers feed full-precision levels and apply the
// verdict themselves.
//
// The levels are 25 ms RMS readings covering the whole recording without gaps,
// kept as the 1 dB histogram of recordingTailPolicy.js (createLevelHistory).
// Batch recordings share the post-release tail's own tracker (the analyser's
// float samples); a streaming session's failover gate reads the worklet's
// PCM16 frames into the same kind of history (recordPcm16SpeechWindow), so
// a failed-over upload is gated exactly as the batch recording would be.
//
// The rules, all in dBFS:
// - `silence` (every provider): the loudest reading is below SILENCE_MAX_DBFS.
//   Only a dead or muted input reads that low; a whisper sits 20+ dB above it.
// - `insufficient_speech` (local whisper.cpp only, applied by the caller):
//   fewer than MIN_SPEECH_READINGS readings clear both the recording's noise
//   floor by SPEECH_SNR_MARGIN_DB and SPEECH_MIN_DBFS. A single short word is
//   enough.
// - Otherwise transcribe. The gate fails open whenever it can't judge: no
//   readings, a recording too short to estimate its floor, or one whose
//   loudest reading reaches STRONG_SPEECH_DBFS (every such recording passed
//   the previous 8-bit gate too). whisper.cpp's decoder thresholds and the
//   blank-audio filter already handle hallucinations on noise.

import {
  LEVEL_MIN_DBFS,
  LEVEL_READING_MS,
  MIN_FLOOR_READINGS,
  createLevelHistory,
  estimateNoiseFloorDb,
  recordLevel,
} from "./recordingTailPolicy";

export const SILENCE_MAX_DBFS = -70;
export const SPEECH_SNR_MARGIN_DB = 10;
export const SPEECH_MIN_DBFS = -60;
// 3 readings × 25 ms = 75 ms above the floor.
export const MIN_SPEECH_READINGS = 3;
export const STRONG_SPEECH_DBFS = -45;

const DEFAULT_PCM_SAMPLE_RATE = 16000;

const windowSamplesFor = (sampleRate) =>
  Math.max(1, Math.round(((sampleRate || DEFAULT_PCM_SAMPLE_RATE) * LEVEL_READING_MS) / 1000));

// `levels` is the history the decision reads. The PCM16 accumulator fields are
// only used by recordPcm16SpeechWindow.
export const createLocalSpeechGateState = ({ sampleRate = DEFAULT_PCM_SAMPLE_RATE } = {}) => ({
  levels: createLevelHistory(),
  sampleRate,
  windowSamples: windowSamplesFor(sampleRate),
  pendingSumSq: 0,
  pendingSamples: 0,
  samplesSeen: 0,
  chunkCount: 0,
});

// The streaming context's rate is only known once it exists; call before the
// first frame is recorded.
export const setSpeechGateSampleRate = (state, sampleRate) => {
  if (!state || !Number.isFinite(sampleRate) || sampleRate <= 0) return state;
  state.sampleRate = sampleRate;
  state.windowSamples = windowSamplesFor(sampleRate);
  return state;
};

// The streaming worklet's PCM16 chunks, read at full resolution into
// contiguous 25 ms readings (chunk boundaries don't matter: a reading spans
// chunks). A trailing partial reading is never recorded.
export const recordPcm16SpeechWindow = (state, buffer) => {
  if (!state || !buffer) return state;
  const samples = new Int16Array(buffer);
  if (!samples.length) return state;
  state.chunkCount += 1;
  const { windowSamples } = state;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 0x8000;
    state.pendingSumSq += value * value;
    state.pendingSamples += 1;
    state.samplesSeen += 1;
    if (state.pendingSamples >= windowSamples) {
      const rms = Math.sqrt(state.pendingSumSq / state.pendingSamples);
      recordLevel(state.levels, rms, (state.samplesSeen / state.sampleRate) * 1000);
      state.pendingSumSq = 0;
      state.pendingSamples = 0;
    }
  }
  return state;
};

const loudestDb = (bins) => {
  for (let i = bins.length - 1; i >= 0; i--) {
    if (bins[i] > 0) return i + LEVEL_MIN_DBFS;
  }
  return LEVEL_MIN_DBFS;
};

const readingsAtOrAbove = (bins, db) => {
  let count = 0;
  for (let i = Math.max(0, Math.ceil(db - LEVEL_MIN_DBFS)); i < bins.length; i++) count += bins[i];
  return count;
};

// `state` is a gate state or a bare level history.
export const getLocalSpeechGateDecision = (state) => {
  const history = state?.levels ?? (state?.bins ? state : null);
  if (!history?.count) {
    return { skip: false, reason: "unavailable" };
  }

  const maxDbfs = loudestDb(history.bins);
  const metrics = { readings: history.count, maxDbfs };

  if (maxDbfs < SILENCE_MAX_DBFS) {
    return { skip: true, reason: "silence", ...metrics };
  }
  if (maxDbfs >= STRONG_SPEECH_DBFS) {
    return { skip: false, reason: "speech_detected", ...metrics };
  }
  if (history.count < MIN_FLOOR_READINGS) {
    return { skip: false, reason: "floor_unreliable", ...metrics };
  }

  const { floorDb } = estimateNoiseFloorDb(history);
  const thresholdDbfs = Math.max(floorDb + SPEECH_SNR_MARGIN_DB, SPEECH_MIN_DBFS);
  const speechReadings = readingsAtOrAbove(history.bins, thresholdDbfs);
  const detail = {
    ...metrics,
    floorDbfs: floorDb,
    thresholdDbfs,
    speechReadings,
    speechMs: speechReadings * LEVEL_READING_MS,
  };
  if (speechReadings >= MIN_SPEECH_READINGS) {
    return { skip: false, reason: "speech_detected", ...detail };
  }
  return { skip: true, reason: "insufficient_speech", ...detail };
};
