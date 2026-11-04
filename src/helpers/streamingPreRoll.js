import { PRE_ROLL_MAX_AGE_MS } from "./preparedMicCapture.js";

// A streaming dictation's opening words are spoken between key-down (when the
// mic is prepared) and the moment the session's worklet would otherwise be
// connected. The prepared capture runs the session's own worklet node from the
// start and keeps its PCM16 frames here, bounded to the most recent stretch,
// so the session can send them ahead of live audio.
export const STREAMING_PRE_ROLL_MAX_MS = 1500;

const frameSamples = (frame) => Math.floor((frame?.byteLength ?? 0) / 2);

export const createStreamingPreRollBuffer = ({
  sampleRate,
  maxMs = STREAMING_PRE_ROLL_MAX_MS,
} = {}) => ({
  frames: [],
  samples: 0,
  sampleRate,
  maxSamples: Math.max(0, Math.round(((sampleRate || 0) * maxMs) / 1000)),
  droppedSamples: 0,
});

// Keeps whole frames only: the provider receives exactly the frames the
// worklet produced, so the hand-off to live frames has no gap or overlap and
// every frame keeps the size providers already accept. The oldest frame goes
// once the rest still cover the bound.
export const appendPreRollFrame = (buffer, frame) => {
  const samples = frameSamples(frame);
  if (!buffer || samples === 0) return buffer;
  buffer.frames.push(frame);
  buffer.samples += samples;
  while (buffer.frames.length > 1) {
    const oldest = frameSamples(buffer.frames[0]);
    if (buffer.samples - oldest < buffer.maxSamples) break;
    buffer.frames.shift();
    buffer.samples -= oldest;
    buffer.droppedSamples += oldest;
  }
  return buffer;
};

// Empties the buffer and returns its frames, oldest first. A prepare older than
// a normal key-down-to-start gap buffered audio from before the user meant to
// dictate (same rule as the batch pre-roll), so its frames are dropped; the
// worklet itself stays usable for live audio.
export const takePreRollFrames = (
  buffer,
  { startedAt, now = Date.now(), maxAgeMs = PRE_ROLL_MAX_AGE_MS } = {}
) => {
  if (!buffer) return { frames: [], samples: 0, stale: false, ms: 0 };
  const stale = !Number.isFinite(startedAt) || now - startedAt > maxAgeMs;
  const frames = stale ? [] : buffer.frames;
  const samples = stale ? 0 : buffer.samples;
  buffer.frames = [];
  buffer.samples = 0;
  const ms = buffer.sampleRate ? Math.round((samples / buffer.sampleRate) * 1000) : 0;
  return { frames, samples, stale, ms };
};
