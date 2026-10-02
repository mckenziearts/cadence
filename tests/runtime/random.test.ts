import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { noise, noise2, random, randomRange } from '../../src/runtime/index';

describe('random', () => {
  test('deterministic per seed, in [0, 1)', () => {
    assert.equal(random('card'), random('card'));
    assert.equal(random(42), random(42));
    assert.notEqual(random(1), random(2));
    assert.notEqual(random('a'), random('b'));
    for (let i = 0; i < 2000; i++) {
      const v = random(i);
      assert.ok(v >= 0 && v < 1);
    }
  });

  test('roughly uniform across consecutive seeds', () => {
    const buckets = new Array(10).fill(0);
    const n = 20000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = random(i);
      sum += v;
      buckets[Math.floor(v * 10)]++;
    }
    assert.ok(Math.abs(sum / n - 0.5) < 0.01, `mean ${sum / n}`);
    for (const b of buckets) assert.ok(Math.abs(b - n / 10) < n / 50, `bucket ${b}`);
  });

  test('randomRange stays in [min, max)', () => {
    for (let i = 0; i < 500; i++) {
      const v = randomRange(`r${i}`, -5, 5);
      assert.ok(v >= -5 && v < 5);
    }
  });
});

describe('noise', () => {
  test('noise(x) is deterministic, smooth and within [-1, 1]', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const x = i * 0.013;
      const v = noise(x, 'drift');
      assert.equal(v, noise(x, 'drift'));
      assert.ok(v >= -1 && v <= 1, `noise(${x}) = ${v}`);
      assert.ok(Math.abs(noise(x + 1e-4, 'drift') - v) < 1e-2, `jump at ${x}`);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    assert.ok(min < -0.5 && max > 0.5, `range ${min} to ${max}`);
    assert.notEqual(noise(0.5, 'a'), noise(0.5, 'b'));
  });

  test('noise is continuous across integer boundaries', () => {
    for (const k of [1, 2, 7, -3]) assert.ok(Math.abs(noise(k - 1e-9, 's') - noise(k, 's')) < 1e-6);
  });

  test('noise2 is within [-1, 1], zero on the lattice, continuous', () => {
    let spread = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (i % 80) * 0.173;
      const y = Math.floor(i / 80) * 0.211;
      const v = noise2(x, y, 7);
      assert.ok(v >= -1 && v <= 1);
      assert.ok(Math.abs(noise2(x + 1e-4, y, 7) - v) < 1e-2);
      spread = Math.max(spread, Math.abs(v));
    }
    assert.ok(spread > 0.4, `max |noise2| ${spread}`);
    assert.ok(Math.abs(noise2(3, 4, 7)) < 1e-12);
    assert.equal(noise2(1.3, 2.7, 'x'), noise2(1.3, 2.7, 'x'));
  });
});
