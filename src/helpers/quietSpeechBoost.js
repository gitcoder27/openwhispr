// Quiet-input boost for batch transcription. getUserMedia runs with AGC off
// (#476), so nothing levels a whisper before the engine: it arrives around
// -45 to -55 dBFS, where Whisper's log-mel features read as near-silence. This
// measures the speech level of a finished recording and, only when it is
// quiet, high-passes it and applies bounded gain with a soft limiter.
//
// Non-regression guarantee: whenever the boost doesn't apply, the INPUT ARRAY
// ITSELF is returned (`samples === input`), so normal-level audio reaches the
// engine byte for byte as before.
//
// Pure: PCM in (Int16Array, or Float32Array in [-1, 1]), PCM out of the same
// type. No Web Audio, no I/O.

import { LEVEL_MIN_DBFS, MIN_FLOOR_READINGS, estimateNoiseFloorDb } from "./recordingTailPolicy";

export const FRAME_MS = 20;
// Frames that clear the noise floor by this margin, and this absolute level,
// count as speech (the speech gate's rule, localSpeechGate.js).
export const SPEECH_SNR_MARGIN_DB = 10;
export const SPEECH_MIN_DBFS = -60;
export const NOISE_FLOOR_PERCENTILE = 0.1;
// The speech level is a high percentile of the speech frames: the loud
// syllables, not the average, since that's what sets the engine's view.
export const SPEECH_LEVEL_PERCENTILE = 0.95;
export const TARGET_SPEECH_DBFS = -28;
// Below this much gain, leave the audio alone (hysteresis around the target).
export const MIN_GAIN_DB = 3;
export const MAX_GAIN_DB = 20;
// Fewer frames than this (half a second) can't separate a floor from a short
// utterance that is speech throughout, so nothing is boosted.
export const MIN_ANALYSIS_FRAMES = 25;
// 60 ms of speech frames at least: below that there is nothing to level.
export const MIN_SPEECH_FRAMES = 3;
export const HIGH_PASS_HZ = 80;
// The limiter is transparent below the knee and never exceeds the ceiling.
export const LIMITER_CEILING_DBFS = -1;
export const LIMITER_KNEE_DBFS = -6;
// The cloud lane decides whether to decode its WebM from the recording's 25 ms
// level history. Different framing and the analyser's downmix put that
// estimate a dB or two off the decoded one, so the hint is generous by this
// margin: a false "quiet" only costs a decode, after which the real analysis
// decides (and returns the original WebM when it finds nothing to do).
export const HINT_SLACK_DB = 3;

const MIN_DB = -120;
const dbToGain = (db) => 10 ** (db / 20);
const LIMITER_CEILING = dbToGain(LIMITER_CEILING_DBFS);
const LIMITER_KNEE = dbToGain(LIMITER_KNEE_DBFS);

const rmsToDb = (rms) => (rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB);
const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);

const percentileOfSorted = (sorted, p) => {
  if (sorted.length === 0) return MIN_DB;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
};

const sampleScale = (samples) => (samples instanceof Int16Array ? 1 / 0x8000 : 1);

// One pass over the samples: per-frame RMS in dBFS.
export const frameLevelsDb = (samples, sampleRate) => {
  const frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.floor(samples.length / frameSamples);
  const levels = new Float64Array(frameCount);
  const scale = sampleScale(samples);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * frameSamples;
    for (let i = start; i < start + frameSamples; i++) {
      const v = samples[i] * scale;
      sum += v * v;
    }
    levels[f] = rmsToDb(Math.sqrt(sum / frameSamples));
  }
  return levels;
};

// Turns a speech level and floor into a verdict. Shared by the PCM analysis
// and the level-history hint so both apply the same target and hysteresis.
const verdictFor = ({ speechLevelDbfs, noiseFloorDbfs, speechFrames, slackDb = 0 }) => {
  const base = {
    speechLevelDbfs: round1(speechLevelDbfs),
    noiseFloorDbfs: round1(noiseFloorDbfs),
    speechFrames,
  };
  if (speechFrames < MIN_SPEECH_FRAMES) {
    return { apply: false, reason: "no_speech", gainDb: 0, ...base };
  }
  const neededDb = TARGET_SPEECH_DBFS - speechLevelDbfs;
  if (neededDb + slackDb < MIN_GAIN_DB) {
    return { apply: false, reason: "not_quiet", gainDb: 0, ...base };
  }
  const gainDb = Math.min(Math.max(neededDb, MIN_GAIN_DB), MAX_GAIN_DB);
  return { apply: true, reason: "quiet", gainDb: round1(gainDb), ...base };
};

export const analyzeSpeechLevel = (samples, sampleRate) => {
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { apply: false, reason: "no_audio", gainDb: 0, speechFrames: 0 };
  }
  const levels = frameLevelsDb(samples, sampleRate);
  if (levels.length < MIN_ANALYSIS_FRAMES) {
    return { apply: false, reason: "too_short", gainDb: 0, speechFrames: 0 };
  }
  const sorted = Float64Array.from(levels).sort();
  const noiseFloorDbfs = percentileOfSorted(sorted, NOISE_FLOOR_PERCENTILE);
  const thresholdDb = Math.max(noiseFloorDbfs + SPEECH_SNR_MARGIN_DB, SPEECH_MIN_DBFS);
  // `sorted` is ascending, so the speech frames are its tail.
  let firstSpeech = sorted.length;
  while (firstSpeech > 0 && sorted[firstSpeech - 1] >= thresholdDb) firstSpeech--;
  const speech = sorted.subarray(firstSpeech);
  return verdictFor({
    speechLevelDbfs: percentileOfSorted(speech, SPEECH_LEVEL_PERCENTILE),
    noiseFloorDbfs,
    speechFrames: speech.length,
  });
};

// Second-order Butterworth high-pass (RBJ cookbook), in float, in place.
export const highPassInPlace = (data, sampleRate, cutoffHz = HIGH_PASS_HZ) => {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    data[i] = y0;
  }
  return data;
};

// Transparent below the knee; above it a tanh curve that meets the line with
// the same slope and approaches, but never reaches, the ceiling. No hard clip.
export const softLimit = (value) => {
  const magnitude = Math.abs(value);
  if (magnitude <= LIMITER_KNEE) return value;
  const room = LIMITER_CEILING - LIMITER_KNEE;
  const limited = LIMITER_KNEE + room * Math.tanh((magnitude - LIMITER_KNEE) / room);
  return value < 0 ? -limited : limited;
};

const toFloat = (samples) => {
  const scale = sampleScale(samples);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * scale;
  return out;
};

const toSameType = (input, data) => {
  if (!(input instanceof Int16Array)) return data;
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(data[i] * 0x8000);
    out[i] = v > 0x7fff ? 0x7fff : v < -0x8000 ? -0x8000 : v;
  }
  return out;
};

// { applied, samples, reason, gainDb, speechLevelDbfs, noiseFloorDbfs,
// speechFrames }. `samples` is the input itself unless applied.
export const boostQuietSpeech = (samples, sampleRate) => {
  const verdict = analyzeSpeechLevel(samples, sampleRate);
  const { apply, ...report } = verdict;
  if (!apply) return { applied: false, samples, ...report };
  const data = highPassInPlace(toFloat(samples), sampleRate);
  const gain = dbToGain(verdict.gainDb);
  for (let i = 0; i < data.length; i++) data[i] = softLimit(data[i] * gain);
  return { applied: true, samples: toSameType(samples, data), ...report };
};

// From a recording's 25 ms level history (recordingTailPolicy.js): is it worth
// decoding the WebM to look closer? { quiet, reason, speechLevelDbfs, ... }.
export const quietSpeechHint = (history) => {
  if (!history?.count) return { quiet: false, reason: "no_levels" };
  if (history.count < MIN_FLOOR_READINGS) return { quiet: false, reason: "too_short" };
  const { floorDb } = estimateNoiseFloorDb(history);
  const thresholdDb = Math.max(floorDb + SPEECH_SNR_MARGIN_DB, SPEECH_MIN_DBFS);
  const { bins } = history;
  const firstBin = Math.max(0, Math.ceil(thresholdDb - LEVEL_MIN_DBFS));
  let speechFrames = 0;
  for (let i = firstBin; i < bins.length; i++) speechFrames += bins[i];
  let speechLevelDbfs = MIN_DB;
  if (speechFrames > 0) {
    // The bin holding the SPEECH_LEVEL_PERCENTILE of the speech readings.
    const target = Math.max(1, Math.ceil(speechFrames * SPEECH_LEVEL_PERCENTILE));
    let seen = 0;
    for (let i = firstBin; i < bins.length; i++) {
      seen += bins[i];
      if (seen >= target) {
        speechLevelDbfs = i + LEVEL_MIN_DBFS;
        break;
      }
    }
  }
  const verdict = verdictFor({
    speechLevelDbfs,
    noiseFloorDbfs: floorDb,
    speechFrames,
    slackDb: HINT_SLACK_DB,
  });
  const { apply, gainDb: _gainDb, ...rest } = verdict;
  return { quiet: apply, ...rest };
};

// The renderer's own 16 kHz mono PCM16 WAV (wavBuilder.buildWav): a 44-byte
// header, then samples. Anything else reads as null.
export const parsePcm16Wav = (arrayBuffer) => {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  const tag = (offset) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") {
    return null;
  }
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (format !== 1 || channels !== 1 || bits !== 16 || !sampleRate) return null;
  const dataBytes = Math.min(view.getUint32(40, true), arrayBuffer.byteLength - 44);
  return { samples: new Int16Array(arrayBuffer, 44, Math.floor(dataBytes / 2)), sampleRate };
};
