import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bezier,
  clamp,
  ease,
  interpolate,
  keyframes,
  loop,
  mix,
  pingpong,
  progress,
  remap,
  spring,
  springDuration,
  springs,
  stagger,
  staggerFrom,
  type Easing,
} from '../../src/runtime/index';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe('ease', () => {
  const named = Object.entries(ease).filter(([name]) => !['bezier', 'backOut', 'steps'].includes(name)) as [string, Easing][];

  test('every named easing maps 0 to 0 and 1 to 1', () => {
    assert.ok(named.length >= 36, `only ${named.length} easings`);
    for (const [name, fn] of named) {
      close(fn(0), 0, 1e-6);
      close(fn(1), 1, 1e-6);
      assert.ok(Number.isFinite(fn(0.5)), name);
    }
  });

  test('non-overshooting families are monotonic', () => {
    const monotonic = named.filter(([name]) => !/Back|Elastic|Bounce/.test(name));
    for (const [name, fn] of monotonic) {
      let prev = fn(0);
      for (let i = 1; i <= 200; i++) {
        const v = fn(i / 200);
        assert.ok(v >= prev - 1e-9, `${name} decreases at ${i / 200}`);
        prev = v;
      }
    }
  });

  test('back and elastic overshoot, bounce stays in range', () => {
    const peak = (fn: Easing) => Math.max(...Array.from({ length: 101 }, (_, i) => fn(i / 100)));
    assert.ok(peak(ease.outBack) > 1.05);
    assert.ok(peak(ease.backOut(3)) > peak(ease.outBack));
    assert.ok(peak(ease.outElastic) > 1.01);
    assert.ok(peak(ease.outBounce) <= 1 + 1e-9);
  });

  test('bezier matches CSS ease and handles endpoints', () => {
    const css = bezier(0.25, 0.1, 0.25, 1);
    assert.equal(css(0), 0);
    assert.equal(css(1), 1);
    close(css(0.5), 0.8024, 1e-3);
    close(ease.css(0.5), css(0.5));
    close(bezier(0, 0, 1, 1)(0.3), 0.3, 1e-6);
  });

  test('steps jumps at the end of each step', () => {
    const s = ease.steps(4);
    assert.deepEqual([0, 0.24, 0.25, 0.6, 0.99, 1].map(s), [0, 0, 0.25, 0.5, 0.75, 1]);
  });
});

describe('interpolate & friends', () => {
  test('clamps outside the range by default, extrapolates on request', () => {
    assert.equal(interpolate(-1, [0, 1], [10, 20]), 10);
    assert.equal(interpolate(2, [0, 1], [10, 20]), 20);
    close(interpolate(2, [0, 1], [10, 20], { clamp: false }), 30);
    close(interpolate(-1, [0, 1], [10, 20], { clamp: false }), 0);
  });

  test('multi-stop with per-segment easing', () => {
    const v = (t: number) => interpolate(t, [0, 1, 2], [0, 1, 0], { easing: [ease.linear, ease.inQuad] });
    close(v(0.5), 0.5);
    close(v(1), 1);
    close(v(1.5), 1 - 0.25);
    close(interpolate(0.5, [0, 1], [0, 100], { easing: ease.outCubic }), 100 * ease.outCubic(0.5));
  });

  test('rejects mismatched stops', () => {
    assert.throws(() => interpolate(0, [0, 1], [0]), /same non-zero length/);
    assert.throws(() => interpolate(0, [], []), /same non-zero length/);
  });

  test('keyframes tuples match interpolate', () => {
    const keys = [
      [0, 0],
      [1, 10, ease.outCubic],
      [2, 10],
      [2.5, 0, ease.inCubic],
    ] as const;
    close(keyframes(0.5, keys), 10 * ease.outCubic(0.5));
    close(keyframes(1.5, keys), 10);
    close(keyframes(2.25, keys), 10 - 10 * ease.inCubic(0.5));
  });

  test('progress is clamped, eased, and handles zero-length ranges', () => {
    assert.equal(progress(-1, 0, 1), 0);
    assert.equal(progress(5, 0, 1), 1);
    close(progress(0.5, 0, 1, ease.inQuad), 0.25);
    assert.equal(progress(0.99, 1, 1), 0);
    assert.equal(progress(1, 1, 1), 1);
  });

  test('remap maps, clamps, eases and accepts reversed ranges', () => {
    close(remap(5, 0, 10, 100, 200), 150);
    close(remap(20, 0, 10, 100, 200), 200);
    close(remap(25, 100, 0, 0, 1), 0.75);
    close(remap(5, 0, 10, 0, 1, ease.inQuad), 0.25);
    assert.equal(remap(3, 3, 3, 0, 1), 1);
    assert.equal(remap(2, 3, 3, 0, 1), 0);
  });

  test('mix, clamp, stagger, staggerFrom, loop, pingpong', () => {
    close(mix(10, 20, 0.25), 12.5);
    close(mix(10, 20, 1.5), 25);
    assert.equal(clamp(2), 1);
    assert.equal(clamp(-3, -2, 2), -2);
    close(stagger(3, 0.05, 0.2), 0.35);
    assert.equal(staggerFrom(0, 5, 0.1), 0.2);
    assert.equal(staggerFrom(2, 5, 0.1), 0);
    close(staggerFrom(4, 5, 0.1, 'start'), 0.4);
    close(staggerFrom(1, 5, 0.1, 3), 0.2);
    close(loop(-0.5, 2), 1.5);
    close(loop(5, 2), 1);
    close(pingpong(0.5, 1), 0.5);
    close(pingpong(1.5, 1), 0.5);
    close(pingpong(2, 1), 0);
  });
});

describe('spring', () => {
  test('starts at from and settles at to', () => {
    assert.equal(spring(0, { from: 50, to: 0 }), 50);
    assert.equal(spring(-1, { from: 50, to: 0 }), 50);
    for (const cfg of Object.values(springs)) close(spring(5, { from: 50, to: 0, ...cfg }), 0, 1e-3);
  });

  test('bouncy overshoots, smooth does not, overdamped creeps', () => {
    const peak = (cfg: object) => Math.max(...Array.from({ length: 400 }, (_, i) => spring(i / 200, { ...cfg })));
    assert.ok(peak(springs.bouncy) > 1.05);
    assert.ok(peak(springs.smooth) <= 1.001);
    const over = { stiffness: 100, damping: 60 };
    assert.ok(peak(over) < 1);
    assert.ok(spring(1, over) > 0.5 && spring(1, over) < 1);
  });

  test('initial velocity pushes the start', () => {
    assert.ok(spring(0.02, { velocity: 20 }) > spring(0.02));
  });

  test('duration estimate is sane', () => {
    const snappy = springDuration(springs.snappy);
    assert.ok(snappy > 0.1 && snappy < 2, `snappy ${snappy}`);
    assert.ok(springDuration(springs.gentle) > snappy);
    const d = springDuration(springs.bouncy, 0.01);
    for (let t = d; t < d + 2; t += 0.05) assert.ok(Math.abs(spring(t, springs.bouncy) - 1) <= 0.01 + 1e-9);
  });
});
