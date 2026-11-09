/**
 * Pause-aware chunking for batch meeting transcription (self-hosted servers).
 *
 * Parakeet drops or garbles a word cut in half, so a source's audio is cut in
 * a pause rather than on a fixed clock: the first pause of at least `pauseMs`
 * whose middle lies `minChunkMs` or more into the buffer ends the chunk there.
 * Speech with no pause is cut at its quietest frame in the last third once
 * `maxChunkMs` is buffered. Whatever follows the cut stays for the next chunk.
 *
 * A pause is judged against the source's own level, like the voice-stt
 * server's stream splitter: 20 ms frame RMS, smoothed over 100 ms, below
 * max(0.002, min(max(2.5 × floor, 0.1 × speech), 0.35 × speech)), where floor
 * and speech are the 10th and 90th percentiles of the last 30 s of frames, so
 * a laptop mic's hiss still reads as a pause.
 *
 * Timestamps come from the audio timeline: every appended piece names the
 * wall time its last sample was captured, and a chunk's times are read back
 * from those anchors, so a piece the caller dropped (a muted mic chunk) leaves
 * a gap rather than shifting everything after it.
 *
 * Pure: no timers, no I/O. Rate-agnostic (meeting audio arrives at 24 kHz).
 */

const DEFAULTS = Object.freeze({
  sampleRate: 24000,
  frameMs: 20,
  minChunkMs: 3000,
  maxChunkMs: 15000,
  pauseMs: 360,
  historyMs: 30000,
  // A chunk with less than this much frame time above the pause level holds no speech.
  minVoicedMs: 200,
  // Never call a frame voiced below this absolute RMS, whatever the history says.
  minVoicedRms: 0.004,
});

const SMOOTH_FRAMES = 5;
const MIN_QUIET_LEVEL = 0.002;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  );
  return sorted[index];
}

/** The level below which a frame counts as a pause, from recent frame RMS values. */
function quietLevel(history) {
  if (!history.length) return MIN_QUIET_LEVEL;
  const sorted = Float64Array.from(history).sort();
  const floor = percentile(sorted, 10);
  const speech = percentile(sorted, 90);
  return Math.max(MIN_QUIET_LEVEL, Math.min(Math.max(2.5 * floor, 0.1 * speech), 0.35 * speech));
}

function frameRms(samples, start, length) {
  let sumSq = 0;
  for (let i = start; i < start + length; i += 1) {
    const n = samples[i] / 32768;
    sumSq += n * n;
  }
  return length > 0 ? Math.sqrt(sumSq / length) : 0;
}

/** Centered moving average, as the server smooths, so noise spikes don't break up a pause. */
function smooth(values) {
  if (values.length < SMOOTH_FRAMES) return values.slice();
  const half = Math.floor(SMOOTH_FRAMES / 2);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += values[j];
    out[i] = sum / (to - from);
  }
  return out;
}

/**
 * The frame index to cut at, or -1. Cuts in the middle of the first long
 * enough pause that leaves at least `minFrames` before it; failing that, at
 * the quietest frame once `maxFrames` are buffered.
 */
function findCutFrame(smoothed, threshold, { minFrames, maxFrames, pauseFrames }) {
  // A pause that straddles maxFrames still wins: a chunk a few frames long beats a cut word.
  let runStart = -1;
  for (let i = 0; i <= smoothed.length; i += 1) {
    const quiet = i < smoothed.length && smoothed[i] < threshold;
    if (quiet) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const runLength = i - runStart;
      const cut = runStart + Math.floor(runLength / 2);
      if (runLength >= pauseFrames && cut >= minFrames) return cut;
      runStart = -1;
    }
  }
  if (smoothed.length < maxFrames) return -1;

  // Searched only in the last third, so a forced chunk is long and the remainder
  // short: an early dip would leave most of the buffer, and the lag, behind.
  const from = Math.max(minFrames, Math.floor((maxFrames * 2) / 3));
  let quietest = from;
  for (let i = from; i < maxFrames; i += 1) {
    if (smoothed[i] <= smoothed[quietest]) quietest = i;
  }
  // Cut after the quietest frame so it closes this chunk rather than opening the next.
  return Math.min(maxFrames, quietest + 1);
}

function createMeetingChunkSegmenter(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const { sampleRate } = config;
  const frameSamples = Math.round((sampleRate * config.frameMs) / 1000);
  const toFrames = (ms) => Math.max(1, Math.round(ms / config.frameMs));
  const minFrames = toFrames(config.minChunkMs);
  const maxFrames = Math.max(minFrames, toFrames(config.maxChunkMs));
  const pauseFrames = toFrames(config.pauseMs);
  const historyFrames = toFrames(config.historyMs);
  const minVoicedFrames = Math.ceil(config.minVoicedMs / config.frameMs);

  let samples = new Int16Array(frameSamples * (maxFrames + 64));
  let length = 0;
  // Raw RMS of each complete frame in the buffer, frame i = samples [i·F, (i+1)·F).
  let frames = [];
  // Raw RMS of recent frames, including ones already cut away; sets the pause level.
  let history = [];
  // { end, at }: the sample index (exclusive) a piece ended at and its capture time.
  let anchors = [];

  const ensureCapacity = (needed) => {
    if (needed <= samples.length) return;
    let size = samples.length;
    while (size < needed) size *= 2;
    const grown = new Int16Array(size);
    grown.set(samples.subarray(0, length));
    samples = grown;
  };

  const msFor = (sampleCount) => (sampleCount / sampleRate) * 1000;

  // Time of the first sample at `index`: the piece that holds it places it.
  const timeAtSample = (index) => {
    const anchor =
      anchors.find((candidate) => candidate.end > index) ?? anchors[anchors.length - 1];
    return anchor ? anchor.at - msFor(anchor.end - index) : 0;
  };
  // Time just after the sample before `index`: the piece that ends there places it.
  const timeAtBoundary = (index) => {
    const anchor =
      anchors.find((candidate) => candidate.end >= index) ?? anchors[anchors.length - 1];
    return anchor ? anchor.at - msFor(anchor.end - index) : 0;
  };

  const measureNewFrames = () => {
    const complete = Math.floor(length / frameSamples);
    for (let i = frames.length; i < complete; i += 1) {
      const rms = frameRms(samples, i * frameSamples, frameSamples);
      frames.push(rms);
      history.push(rms);
    }
    if (history.length > historyFrames) history = history.slice(history.length - historyFrames);
  };

  const takeChunk = (sampleCount, threshold) => {
    const voicedLevel = Math.max(threshold, config.minVoicedRms);
    const frameCount = Math.ceil(sampleCount / frameSamples);
    let voicedFrames = 0;
    let firstVoiced = -1;
    let peakRms = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const rms =
        i < frames.length
          ? frames[i]
          : frameRms(
              samples,
              i * frameSamples,
              Math.min(frameSamples, sampleCount - i * frameSamples)
            );
      if (rms > peakRms) peakRms = rms;
      if (rms >= voicedLevel) {
        voicedFrames += 1;
        if (firstVoiced < 0) firstVoiced = i;
      }
    }

    const chunk = {
      samples: samples.slice(0, sampleCount),
      sampleRate,
      startAt: timeAtSample(0),
      endAt: timeAtBoundary(sampleCount),
      durationMs: msFor(sampleCount),
      voicedMs: voicedFrames * config.frameMs,
      speechStartAt: firstVoiced >= 0 ? timeAtSample(firstVoiced * frameSamples) : null,
      peakFrameRms: peakRms,
      silent: voicedFrames < minVoicedFrames,
    };
    if (chunk.speechStartAt == null) chunk.speechStartAt = chunk.startAt;

    samples.copyWithin(0, sampleCount, length);
    length -= sampleCount;
    frames = frames.slice(Math.floor(sampleCount / frameSamples));
    anchors = anchors
      .map((anchor) => ({ end: anchor.end - sampleCount, at: anchor.at }))
      .filter((anchor) => anchor.end > 0);
    return chunk;
  };

  /**
   * Adds a piece of 16-bit mono PCM captured ending at `at` (ms). Returns the
   * chunks it completed, oldest first (usually none or one).
   */
  const append = (pcm, at) => {
    if (!pcm || pcm.length < 2) return [];
    const count = pcm.length >> 1;
    ensureCapacity(length + count);
    for (let i = 0; i < count; i += 1) samples[length + i] = pcm.readInt16LE(i * 2);
    length += count;
    anchors.push({ end: length, at: Number.isFinite(at) ? at : Date.now() });
    measureNewFrames();

    const out = [];
    for (;;) {
      if (frames.length < minFrames) break;
      const threshold = quietLevel(history);
      const cut = findCutFrame(smooth(frames), threshold, { minFrames, maxFrames, pauseFrames });
      if (cut < 0) break;
      out.push(takeChunk(cut * frameSamples, threshold));
    }
    return out;
  };

  /** Cuts whatever is buffered (the end of a meeting). Null when nothing is. */
  const flush = () => {
    if (length === 0) return null;
    return takeChunk(length, quietLevel(history));
  };

  const reset = () => {
    length = 0;
    frames = [];
    history = [];
    anchors = [];
  };

  return {
    append,
    flush,
    reset,
    get bufferedMs() {
      return msFor(length);
    },
  };
}

module.exports = {
  MEETING_CHUNK_DEFAULTS: DEFAULTS,
  createMeetingChunkSegmenter,
  findCutFrame,
  quietLevel,
};
