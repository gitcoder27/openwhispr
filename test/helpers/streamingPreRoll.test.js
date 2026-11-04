const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/streamingPreRoll.js");

// A worklet frame: 800 PCM16 samples (50 ms at 16 kHz), tagged so order is visible.
const frame = (tag, samples = 800) => {
  const data = new Int16Array(samples);
  data[0] = tag;
  return data.buffer;
};
const tags = (frames) => frames.map((f) => new Int16Array(f)[0]);

test("keeps every frame while the buffer is under its bound, oldest first", async () => {
  const { createStreamingPreRollBuffer, appendPreRollFrame, takePreRollFrames } = await load();
  const buffer = createStreamingPreRollBuffer({ sampleRate: 16000 });
  for (let i = 1; i <= 10; i++) appendPreRollFrame(buffer, frame(i));
  const now = 1000;
  const taken = takePreRollFrames(buffer, { startedAt: now - 500, now });
  assert.deepEqual(tags(taken.frames), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(taken.samples, 8000);
  assert.equal(taken.ms, 500);
  assert.equal(taken.stale, false);
});

test("trims whole frames from the front to the most recent 1.5 s", async () => {
  const { createStreamingPreRollBuffer, appendPreRollFrame, takePreRollFrames } = await load();
  const buffer = createStreamingPreRollBuffer({ sampleRate: 16000 });
  // 3 s of frames.
  for (let i = 1; i <= 60; i++) appendPreRollFrame(buffer, frame(i));
  assert.equal(buffer.samples, 24000);
  assert.equal(buffer.droppedSamples, 30 * 800);
  const taken = takePreRollFrames(buffer, { startedAt: 0, now: 100 });
  // The newest 30 frames, contiguous and in order.
  assert.deepEqual(
    tags(taken.frames),
    Array.from({ length: 30 }, (_, i) => 31 + i)
  );
  assert.equal(taken.ms, 1500);
});

test("uneven frame sizes still keep at least the bound and never split a frame", async () => {
  const { createStreamingPreRollBuffer, appendPreRollFrame } = await load();
  const buffer = createStreamingPreRollBuffer({ sampleRate: 16000, maxMs: 100 });
  appendPreRollFrame(buffer, frame(1, 1000));
  appendPreRollFrame(buffer, frame(2, 300));
  appendPreRollFrame(buffer, frame(3, 300));
  // 1600 max samples: 1000+300+300 = 1600 → dropping frame 1 would leave 600 < 1600.
  assert.deepEqual(tags(buffer.frames), [1, 2, 3]);
  appendPreRollFrame(buffer, frame(4, 1200));
  // 600+1200 = 1800 ≥ 1600 without frame 1; 1500 without frame 2 → keep 2.
  assert.deepEqual(tags(buffer.frames), [2, 3, 4]);
  for (const f of buffer.frames) assert.equal(f.byteLength % 2, 0);
});

test("a stale prepare's frames are dropped but the buffer is emptied either way", async () => {
  const { createStreamingPreRollBuffer, appendPreRollFrame, takePreRollFrames } = await load();
  const { PRE_ROLL_MAX_AGE_MS } = await import("../../src/helpers/preparedMicCapture.js");
  const buffer = createStreamingPreRollBuffer({ sampleRate: 16000 });
  for (let i = 1; i <= 5; i++) appendPreRollFrame(buffer, frame(i));
  const now = 10000;
  const taken = takePreRollFrames(buffer, { startedAt: now - PRE_ROLL_MAX_AGE_MS - 1, now });
  assert.equal(taken.stale, true);
  assert.deepEqual(taken.frames, []);
  assert.equal(taken.ms, 0);
  assert.equal(buffer.frames.length, 0);
  assert.equal(buffer.samples, 0);

  // Exactly at the limit is still fresh, as for the batch pre-roll.
  appendPreRollFrame(buffer, frame(9));
  const fresh = takePreRollFrames(buffer, { startedAt: now - PRE_ROLL_MAX_AGE_MS, now });
  assert.equal(fresh.stale, false);
  assert.deepEqual(tags(fresh.frames), [9]);
});

test("ignores empty frames and a missing buffer", async () => {
  const { createStreamingPreRollBuffer, appendPreRollFrame, takePreRollFrames } = await load();
  const buffer = createStreamingPreRollBuffer({ sampleRate: 16000 });
  appendPreRollFrame(buffer, new ArrayBuffer(0));
  assert.equal(buffer.frames.length, 0);
  assert.equal(appendPreRollFrame(null, frame(1)), null);
  assert.deepEqual(takePreRollFrames(null), { frames: [], samples: 0, stale: false, ms: 0 });
});

test("discardStreamingPreRoll stops and detaches the prepared worklet", async () => {
  const { discardStreamingPreRoll, disposePreparedCapture } =
    await import("../../src/helpers/preparedMicCapture.js");
  const calls = [];
  const preRoll = () => ({
    source: { disconnect: () => calls.push("source.disconnect") },
    processor: {
      port: {
        onmessage: () => {},
        postMessage: (message) => calls.push(`post:${message}`),
      },
      disconnect: () => calls.push("processor.disconnect"),
    },
    buffer: { frames: [frame(1)], samples: 800 },
  });
  const prepared = { streamingPreRoll: preRoll() };
  const { processor, buffer } = prepared.streamingPreRoll;
  discardStreamingPreRoll(prepared);
  assert.equal(prepared.streamingPreRoll, null);
  assert.equal(processor.port.onmessage, null);
  assert.deepEqual(calls, ["post:stop", "processor.disconnect", "source.disconnect"]);
  assert.equal(buffer.frames.length, 0);

  // The prepared-capture disposer (expiry, cancel) releases it with the stream.
  calls.length = 0;
  let tracksStopped = 0;
  disposePreparedCapture({
    stream: { getTracks: () => [{ stop: () => (tracksStopped += 1) }] },
    streamingPreRoll: preRoll(),
  });
  assert.deepEqual(calls, ["post:stop", "processor.disconnect", "source.disconnect"]);
  assert.equal(tracksStopped, 1);
});
