const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMeetingChunkSegmenter,
  findCutFrame,
  quietLevel,
} = require("../../src/helpers/meetingChunkSegmenter");

const RATE = 24000;

// Deterministic "speech": a 220 Hz tone with a slow amplitude wobble.
const tone = (ms, amplitude = 0.3) => {
  const n = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const wobble = 0.75 + 0.25 * Math.sin((2 * Math.PI * 3 * i) / RATE);
    buf.writeInt16LE(
      Math.round(amplitude * wobble * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE)),
      i * 2
    );
  }
  return buf;
};

// Low hiss, like a laptop mic's noise floor.
const hiss = (ms, amplitude = 0.002, seed = 1) => {
  const n = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  let state = seed;
  for (let i = 0; i < n; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buf.writeInt16LE(Math.round(((state / 0x7fffffff) * 2 - 1) * amplitude * 32767), i * 2);
  }
  return buf;
};

const msOf = (buffer) => (buffer.length / 2 / RATE) * 1000;

// Feeds pieces of `pieceMs`, each stamped with its capture end on a clock that
// starts at `t0`, and collects every chunk.
const feed = (segmenter, buffer, { t0 = 1_000_000, pieceMs = 100, clock = { t: t0 } } = {}) => {
  const chunks = [];
  const pieceBytes = Math.round((RATE * pieceMs) / 1000) * 2;
  for (let offset = 0; offset < buffer.length; offset += pieceBytes) {
    const piece = buffer.subarray(offset, Math.min(buffer.length, offset + pieceBytes));
    clock.t += msOf(piece);
    chunks.push(...segmenter.append(piece, clock.t));
  }
  return chunks;
};

test("quietLevel tracks the noise floor but never rises above a share of speech", () => {
  assert.equal(quietLevel([]), 0.002);
  const level = quietLevel([...Array(50).fill(0.001), ...Array(50).fill(0.2)]);
  assert.ok(level >= 0.002 && level <= 0.35 * 0.2, String(level));
  // All speech: the pause level stays under the speech itself.
  assert.ok(quietLevel(Array(100).fill(0.2)) < 0.2);
});

test("findCutFrame cuts in the middle of the first pause past the minimum", () => {
  const frames = [
    ...Array(100).fill(0.2), // speech
    ...Array(10).fill(0.001), // a short gap: too short to cut
    ...Array(100).fill(0.2),
    ...Array(30).fill(0.001), // a real pause
    ...Array(20).fill(0.2),
  ];
  const cut = findCutFrame(frames, 0.01, { minFrames: 150, maxFrames: 750, pauseFrames: 18 });
  assert.equal(cut, 210 + 15);
});

test("findCutFrame ignores a pause that would leave less than the minimum", () => {
  const frames = [...Array(50).fill(0.2), ...Array(30).fill(0.001), ...Array(60).fill(0.2)];
  assert.equal(findCutFrame(frames, 0.01, { minFrames: 150, maxFrames: 750, pauseFrames: 18 }), -1);
});

test("findCutFrame forces a cut at the quietest frame when no pause comes", () => {
  const frames = Array.from({ length: 750 }, (_, i) => (i === 300 ? 0.01 : i === 600 ? 0.05 : 0.2));
  // An early dip is passed over: the cut keeps the lag (the remainder) short.
  assert.equal(
    findCutFrame(frames, 0.001, { minFrames: 150, maxFrames: 750, pauseFrames: 18 }),
    601
  );
  assert.equal(
    findCutFrame(frames.slice(0, 749), 0.001, { minFrames: 150, maxFrames: 750, pauseFrames: 18 }),
    -1
  );
});

test("speech, pause, speech is cut inside the pause, not mid-word", () => {
  const segmenter = createMeetingChunkSegmenter();
  const audio = Buffer.concat([hiss(500), tone(4000), hiss(600), tone(3000), hiss(200)]);
  const chunks = feed(segmenter, audio);
  assert.equal(chunks.length, 1);
  const [first] = chunks;
  // The cut sits in the 600 ms pause that starts at 4.5 s.
  assert.ok(first.durationMs > 4500 && first.durationMs < 5100, String(first.durationMs));
  assert.equal(first.silent, false);

  const tail = segmenter.flush();
  assert.ok(tail.durationMs > 3000, String(tail.durationMs));
  assert.equal(Math.round(first.durationMs + tail.durationMs), Math.round(msOf(audio)));
  assert.equal(segmenter.flush(), null);
});

test("continuous speech is force-cut at the maximum and the remainder carries over", () => {
  const segmenter = createMeetingChunkSegmenter();
  const audio = tone(32000);
  const chunks = feed(segmenter, audio);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.ok(chunk.durationMs >= 10000 && chunk.durationMs <= 15040, String(chunk.durationMs));
  }
  const tail = segmenter.flush();
  const total = chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0) + tail.durationMs;
  assert.equal(Math.round(total), 32000);
});

test("a silent stretch is cut into chunks flagged silent", () => {
  const segmenter = createMeetingChunkSegmenter();
  const chunks = feed(segmenter, hiss(20000));
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) assert.equal(chunk.silent, true);
});

test("chunk times come from capture times, not from when the cut happened", () => {
  const segmenter = createMeetingChunkSegmenter();
  const clock = { t: 5_000_000 };
  const chunks = feed(segmenter, Buffer.concat([hiss(1000), tone(3000), hiss(800), tone(1000)]), {
    clock,
  });
  assert.equal(chunks.length, 1);
  const [chunk] = chunks;
  assert.ok(Math.abs(chunk.startAt - 5_000_000) < 1, String(chunk.startAt - 5_000_000));
  assert.ok(Math.abs(chunk.endAt - chunk.startAt - chunk.durationMs) < 1);
  // Speech starts ~1 s in; the smoothed level may call it a frame or two early.
  const speechOffset = chunk.speechStartAt - chunk.startAt;
  assert.ok(speechOffset > 900 && speechOffset < 1100, String(speechOffset));
});

test("a gap in capture (a dropped piece) shifts only the audio after it", () => {
  const segmenter = createMeetingChunkSegmenter();
  segmenter.append(tone(2000), 10_000);
  // 5 s of capture went missing before this piece.
  segmenter.append(tone(2000), 17_000);
  const chunk = segmenter.flush();
  assert.equal(Math.round(chunk.startAt), 8_000);
  assert.equal(Math.round(chunk.endAt), 17_000);
  assert.equal(Math.round(chunk.durationMs), 4000);
});

test("odd-aligned input buffers are read correctly", () => {
  const segmenter = createMeetingChunkSegmenter();
  const backing = Buffer.alloc(tone(500).length + 1);
  tone(500).copy(backing, 1);
  segmenter.append(backing.subarray(1), 1000);
  const chunk = segmenter.flush();
  assert.deepEqual(Buffer.from(chunk.samples.buffer), tone(500));
});

test("reset forgets buffered audio", () => {
  const segmenter = createMeetingChunkSegmenter();
  segmenter.append(tone(2000), 1000);
  assert.ok(segmenter.bufferedMs > 1900);
  segmenter.reset();
  assert.equal(segmenter.bufferedMs, 0);
  assert.equal(segmenter.flush(), null);
});
