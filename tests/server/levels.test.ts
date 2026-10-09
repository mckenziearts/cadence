// Mouth levels of a spoken sentence: its loudness 25 times a second.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levels } from '../../server/voiceover/levels';

/** A square wave of `amplitude` for `seconds`, then `silence` seconds of zeros. */
function square(sampleRate: number, seconds: number, amplitude: number, silence = 0): Int16Array {
  const samples = new Int16Array(Math.round((seconds + silence) * sampleRate));
  const loud = Math.round(seconds * sampleRate);
  for (let i = 0; i < loud; i++) samples[i] = Math.floor(i / 20) % 2 ? -amplitude : amplitude;
  return samples;
}

test('levels: a square wave gives 255 on its windows, then silence gives 0', () => {
  assert.deepEqual(levels(square(24000, 0.2, 8000, 0.12), 24000), [255, 255, 255, 255, 255, 0, 0, 0]);
});

test('levels: normalized to the sentence peak, as integers', () => {
  const samples = new Int16Array(1920);
  samples.fill(1000, 0, 960);
  samples.fill(-500, 960);
  assert.deepEqual(levels(samples, 24000), [255, 128]);
});

test('levels: each window is its root mean square, not its mean or peak', () => {
  const samples = new Int16Array(1920);
  for (let i = 0; i < 960; i++) samples[i] = i % 2 ? 1000 : 0;
  samples.fill(500, 960);
  assert.deepEqual(levels(samples, 24000), [255, 180]);
});

test('levels: silence gives zeros, no samples give nothing', () => {
  assert.deepEqual(levels(new Int16Array(16000), 16000), Array(25).fill(0));
  assert.deepEqual(levels(new Int16Array(0), 16000), []);
});

for (const rate of [16000, 22050, 24000]) {
  test(`levels: 25 values per second at ${rate} Hz, the last partial window included`, () => {
    assert.equal(levels(square(rate, 2, 3000), rate).length, 50);
    const partial = levels(square(rate, 2 + 1 / rate, 3000), rate);
    assert.equal(partial.length, 51);
    assert.equal(partial.at(-1), 255);
  });
}
