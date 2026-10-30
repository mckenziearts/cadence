import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  circle,
  ellipse,
  evolvePath,
  getLength,
  getPointAtLength,
  getTangentAtLength,
  parsePath,
  pie,
  polygon,
  roundedRect,
  star,
  triangle,
  type Point,
  type Subpath,
} from '../../src/runtime/index';

const near = (actual: number, expected: number, eps = 0.1, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected}`);
const nearPoint = (actual: Point, expected: Point, eps = 0.1) => {
  near(actual.x, expected.x, eps, 'x');
  near(actual.y, expected.y, eps, 'y');
};
const nearPaths = (actual: Subpath[], expected: Subpath[]) => {
  assert.equal(actual.length, expected.length, 'subpaths');
  actual.forEach((sub, i) => {
    assert.equal(sub.closed, expected[i].closed, 'closed');
    assert.equal(sub.segments.length, expected[i].segments.length, 'segments');
    sub.segments.forEach((seg, j) => {
      for (const key of ['from', 'c1', 'c2', 'to'] as const) nearPoint(seg[key], expected[i].segments[j][key], 1e-9);
    });
  });
};
const ends = (d: string) => parsePath(d).flatMap((sub) => sub.segments.map((seg) => [seg.from, seg.to]));

/** Closed-form length of a quadratic Bézier. */
function quadraticLength(p0: Point, p1: Point, p2: Point): number {
  const a = { x: p0.x - 2 * p1.x + p2.x, y: p0.y - 2 * p1.y + p2.y };
  const b = { x: 2 * (p1.x - p0.x), y: 2 * (p1.y - p0.y) };
  const A = 4 * (a.x * a.x + a.y * a.y);
  const B = 4 * (a.x * b.x + a.y * b.y);
  const C = b.x * b.x + b.y * b.y;
  const sabc = 2 * Math.sqrt(A + B + C);
  const a2 = Math.sqrt(A);
  const a32 = 2 * A * a2;
  const c2 = 2 * Math.sqrt(C);
  const ba = B / a2;
  return (a32 * sabc + a2 * B * (sabc - c2) + (4 * C * A - B * B) * Math.log((2 * a2 + ba + sabc) / (ba + c2))) / (4 * a32);
}

/** Bounding box of the drawn outline, sampled along its length. */
function bounds(d: string) {
  const total = getLength(d);
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i <= 2000; i++) {
    const p = getPointAtLength(d, (total * i) / 2000);
    box.minX = Math.min(box.minX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

function assertClosed(d: string) {
  const subs = parsePath(d);
  assert.ok(subs.length > 0, d);
  for (const sub of subs) {
    assert.equal(sub.closed, true, d);
    nearPoint(sub.segments.at(-1)!.to, sub.segments[0].from, 1e-6);
  }
}

describe('parsePath', () => {
  test('a line becomes one cubic with its controls at thirds', () => {
    nearPaths(parsePath('M0 0L30 60'), [
      { closed: false, segments: [{ from: { x: 0, y: 0 }, c1: { x: 10, y: 20 }, c2: { x: 20, y: 40 }, to: { x: 30, y: 60 } }] },
    ]);
  });

  test('relative commands match their absolute form', () => {
    nearPaths(
      parsePath('m10 10 l20 0 h10 v10 c0 10 10 10 10 0 s10 -10 10 0 q5 10 10 0 t10 0 a5 5 0 0 1 10 0 z'),
      parsePath('M10 10 L30 10 H40 V20 C40 30 50 30 50 20 S60 10 60 20 Q65 30 70 20 T80 20 A5 5 0 0 1 90 20 Z'),
    );
  });

  test('implicit repeats: extra pairs after M are lines, after m relative lines', () => {
    nearPaths(parsePath('M0 0 10 0 10 10'), parsePath('M0 0 L10 0 L10 10'));
    nearPaths(parsePath('m5 5 10 0 0 10'), parsePath('M5 5 L15 5 L15 15'));
    nearPaths(parsePath('M0 0 L1 1 2 2 h1 1'), parsePath('M0 0 L1 1 L2 2 H3 H4'));
    nearPaths(parsePath('M0 0 c0 1 1 1 1 0 0 1 1 1 1 0'), parsePath('M0 0 C0 1 1 1 1 0 C1 1 2 1 2 0'));
  });

  test('exponents, signs as separators, compact decimals and arc flags', () => {
    assert.deepEqual(ends('M1e1-2E0L.5.5'), [
      [
        { x: 10, y: -2 },
        { x: 0.5, y: 0.5 },
      ],
    ]);
    assert.deepEqual(ends('M0,0L1.5e+1,2e-1'), [
      [
        { x: 0, y: 0 },
        { x: 15, y: 0.2 },
      ],
    ]);
    nearPaths(parsePath('M0 0a50 50 0 01100 0'), parsePath('M0 0 A50 50 0 0 1 100 0'));
  });

  test('S and T reflect the previous control point, or start from the current point', () => {
    const [, second] = parsePath('M0 0 C0 10 10 10 10 0 S20 -10 20 0')[0].segments;
    nearPoint(second.c1, { x: 10, y: -10 }, 1e-9);
    const [, smooth] = parsePath('M0 0 Q5 10 10 0 T20 0')[0].segments;
    nearPoint(smooth.c1, { x: 10 + (2 / 3) * 5, y: (2 / 3) * -10 }, 1e-9);
    nearPoint(smooth.c2, { x: 20 + (2 / 3) * -5, y: (2 / 3) * -10 }, 1e-9);
    const [, afterLine] = parsePath('M0 0 L10 0 S20 10 30 0')[0].segments;
    nearPoint(afterLine.c1, { x: 10, y: 0 }, 1e-9);
    const [, tAfterLine] = parsePath('M0 0 L10 0 T20 0')[0].segments;
    nearPoint(tAfterLine.c1, { x: 10, y: 0 }, 1e-9);
  });

  test('a chain of S, or of T (glyph outlines), reflects the control point of the S or T before it', () => {
    const [, , third] = parsePath('M0 0 C0 10 10 10 10 0 S20 -10 20 0 S30 10 30 0')[0].segments;
    nearPoint(third.c1, { x: 20, y: 10 }, 1e-9);
    // T20 0 infers (15, -10), so T30 0 infers (25, 10).
    const [, , last] = parsePath('M0 0 Q5 10 10 0 T20 0 T30 0')[0].segments;
    nearPoint(last.c1, { x: 20 + (2 / 3) * 5, y: (2 / 3) * 10 }, 1e-9);
    nearPoint(last.c2, { x: 30 + (2 / 3) * -5, y: (2 / 3) * 10 }, 1e-9);
  });

  test('S after Q and T after C start from the current point: only the same family reflects', () => {
    const [, sAfterQ] = parsePath('M0 0 Q5 10 10 0 S20 10 30 0')[0].segments;
    nearPoint(sAfterQ.c1, { x: 10, y: 0 }, 1e-9);
    const [, tAfterC] = parsePath('M0 0 C0 10 10 10 10 0 T20 0')[0].segments;
    nearPoint(tAfterC.c1, { x: 10, y: 0 }, 1e-9);
  });

  test('Z closes with a line back to the start; a command after it starts a new subpath there', () => {
    const subs = parsePath('M0 0 L10 0 L10 10 Z L0 10');
    assert.equal(subs.length, 2);
    assert.equal(subs[0].closed, true);
    assert.equal(subs[0].segments.length, 3);
    nearPoint(subs[0].segments[2].to, { x: 0, y: 0 }, 0);
    assert.equal(subs[1].closed, false);
    nearPoint(subs[1].segments[0].from, { x: 0, y: 0 }, 0);
    nearPoint(subs[1].segments[0].to, { x: 0, y: 10 }, 0);
    // Already back at the start: no zero-length closing segment.
    assert.equal(parsePath('M0 0 L10 0 L0 0 Z')[0].segments.length, 2);
    // m after z is relative to the subpath start.
    nearPoint(parsePath('M10 10 L20 10 z m5 5 l1 0')[1].segments[0].from, { x: 15, y: 15 }, 0);
  });

  test('arcs: zero radius is a line, same endpoints draw nothing, a too small radius is scaled up (F.6.6)', () => {
    nearPaths(parsePath('M0 0 A0 10 0 0 1 30 60'), parsePath('M0 0 L30 60'));
    assert.deepEqual(parsePath('M5 5 A10 10 0 0 1 5 5'), []);
    assert.deepEqual(parsePath('M5 5 A0 10 0 0 1 5 5'), []);
    // Scaled-up radii can leave the center term a hair below zero in floating point.
    assert.ok(getLength('M0 0 A1 2 30 0 1 1 8') > Math.hypot(1, 8));
    nearPaths(parsePath('M0 0 A1 1 0 0 1 100 0'), parsePath('M0 0 A50 50 0 0 1 100 0'));
    nearPaths(parsePath('M0 0 A-50 -50 0 0 1 100 0'), parsePath('M0 0 A50 50 0 0 1 100 0'));
    // The last cubic ends exactly where the command says, not at a trigonometric approximation of it.
    assert.deepEqual(parsePath('M0 0 A50 50 0 0 1 100 0')[0].segments.at(-1)!.to, { x: 100, y: 0 });
  });

  test('arc flags pick the right center and direction', () => {
    // Small clockwise arc from (0,0) to (100,0) of radius 100: its middle is above the chord.
    nearPoint(getPointAtLength('M0 0 A100 100 0 0 1 100 0', getLength('M0 0 A100 100 0 0 1 100 0') / 2), {
      x: 50,
      y: -(100 - Math.sqrt(100 ** 2 - 50 ** 2)),
    });
    nearPoint(getPointAtLength('M0 0 A100 100 0 0 0 100 0', getLength('M0 0 A100 100 0 0 0 100 0') / 2), {
      x: 50,
      y: 100 - Math.sqrt(100 ** 2 - 50 ** 2),
    });
    // Large arc: 2 pi r minus the small arc.
    const small = 2 * 100 * Math.asin(0.5);
    near(getLength('M0 0 A100 100 0 1 1 100 0'), 2 * Math.PI * 100 - small);
    near(getLength('M0 0 A100 100 0 1 0 100 0'), 2 * Math.PI * 100 - small);
    const far = 100 + Math.sqrt(100 ** 2 - 50 ** 2);
    nearPoint(getPointAtLength('M0 0 A100 100 0 1 1 100 0', Math.PI * 100 - small / 2), { x: 50, y: -far });
    nearPoint(getPointAtLength('M0 0 A100 100 0 1 0 100 0', Math.PI * 100 - small / 2), { x: 50, y: far });
    // A rotated ellipse: half of an ellipse with rx along y.
    const rotated = 'M0 0 A100 50 90 0 1 0 200';
    nearPoint(getPointAtLength(rotated, getLength(rotated) / 2), { x: 50, y: 100 });
  });

  test('an arc rotated by 45 degrees follows its ellipse turned clockwise on screen', () => {
    // Ellipse rx 100, ry 50 around (200, 100), its x axis turned 45 degrees: from parameter angle 0.3 to 2.
    const [cx, cy, rx, ry, phi] = [200, 100, 100, 50, Math.PI / 4];
    const at = (t: number): Point => ({
      x: cx + rx * Math.cos(phi) * Math.cos(t) - ry * Math.sin(phi) * Math.sin(t),
      y: cy + rx * Math.sin(phi) * Math.cos(t) + ry * Math.cos(phi) * Math.sin(t),
    });
    const [from, to] = [at(0.3), at(2)];
    const d = `M${from.x} ${from.y} A${rx} ${ry} 45 0 1 ${to.x} ${to.y}`;
    const steps = 100_000;
    const cumulative = [0];
    for (let i = 1; i <= steps; i++) {
      const [a, b] = [at(0.3 + (1.7 * (i - 1)) / steps), at(0.3 + (1.7 * i) / steps)];
      cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const total = cumulative[steps];
    near(getLength(d), total);
    const half = cumulative.findIndex((length) => length >= total / 2);
    nearPoint(getPointAtLength(d, total / 2), at(0.3 + (1.7 * half) / steps));
  });

  test('an invalid d throws with the position', () => {
    assert.throws(() => parsePath('M0 0 L10'), /position 8/);
    assert.throws(() => parsePath('L0 0'), /position 0/);
    assert.throws(() => parsePath('10 10'), /position 0/);
    assert.throws(() => parsePath('M0 0 L1e999 0'), /position 6: number out of range/);
    assert.throws(() => parsePath('M0 0 X1 1'), /position 5/);
    assert.throws(() => parsePath('M0 NaN'), /position 3/);
    assert.throws(() => parsePath('M0 0 A10 10 0 2 1 5 5'), /position 14/);
    assert.throws(() => parsePath('M0 0 Z 1'), /position 7/);
    assert.throws(() => parsePath('   '), /empty/);
  });

  test('a comma sits only between two numbers, once', () => {
    assert.throws(() => parsePath('M0,,0 L10 10'), /position 3/);
    assert.throws(() => parsePath('M,0 0'), /position 1/);
    assert.throws(() => parsePath('M0 0 L10 10,'), /position 11/);
    assert.throws(() => parsePath('M0 0 L10 10, L20 20'), /position 11/);
    assert.throws(() => parsePath(',M0 0'), /position 0/);
    assert.equal(parsePath('M0,0 L 10 , 10 ,20 20').at(0)?.segments.length, 2);
  });
});

describe('measuring', () => {
  test('a line', () => {
    const d = 'M10 20 L40 60';
    near(getLength(d), 50);
    nearPoint(getPointAtLength(d, 25), { x: 25, y: 40 });
    nearPoint(getTangentAtLength(d, 25), { x: 0.6, y: 0.8 }, 1e-6);
  });

  test('a circle is 2 pi r long, and points sit at their angle', () => {
    for (const d of ['M100 0 A100 100 0 1 1 -100 0 A100 100 0 1 1 100 0 Z', circle({ radius: 100 })]) {
      const length = getLength(d);
      near(length, 2 * Math.PI * 100);
      for (let k = 0; k < 16; k++) {
        const angle = (k / 16) * 2 * Math.PI;
        nearPoint(getPointAtLength(d, (k / 16) * length), { x: 100 * Math.cos(angle), y: 100 * Math.sin(angle) });
        nearPoint(getTangentAtLength(d, (k / 16) * length), { x: -Math.sin(angle), y: Math.cos(angle) }, 1e-3);
      }
    }
  });

  test('a canvas-sized circle (r = 540) is 2 pi r long within 0.1 px and its points sit at their angle', () => {
    const d = circle({ radius: 540 });
    const length = getLength(d);
    near(length, 2 * Math.PI * 540);
    for (let k = 0; k < 64; k++) {
      const angle = (k / 64) * 2 * Math.PI;
      nearPoint(getPointAtLength(d, (k / 64) * length), { x: 540 * Math.cos(angle), y: 540 * Math.sin(angle) });
    }
  });

  test('a quadratic', () => {
    const d = 'M0 0 Q50 100 100 0';
    const length = quadraticLength({ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 });
    near(getLength(d), length);
    nearPoint(getPointAtLength(d, length / 2), { x: 50, y: 50 });
    nearPoint(getTangentAtLength(d, length / 2), { x: 1, y: 0 }, 1e-6);
    const skewed = 'M0 0 Q90 120 30 10';
    near(getLength(skewed), quadraticLength({ x: 0, y: 0 }, { x: 90, y: 120 }, { x: 30, y: 10 }));
  });

  test('an arc', () => {
    const d = 'M0 0 A50 50 0 0 1 100 0';
    near(getLength(d), 50 * Math.PI);
    nearPoint(getPointAtLength(d, 25 * Math.PI), { x: 50, y: -50 });
    nearPoint(getPointAtLength(d, (50 * Math.PI) / 4), { x: 50 - 50 * Math.SQRT1_2, y: -50 * Math.SQRT1_2 });
    nearPoint(getTangentAtLength(d, 25 * Math.PI), { x: 1, y: 0 }, 1e-3);
  });

  test('a closed path, and lengths past either end clamp', () => {
    const d = 'M0 0 h100 v50 h-100 z';
    near(getLength(d), 300);
    nearPoint(getPointAtLength(d, 290), { x: 0, y: 10 });
    nearPoint(getTangentAtLength(d, 290), { x: 0, y: -1 }, 1e-9);
    nearPoint(getPointAtLength(d, 120), { x: 100, y: 20 });
    nearPoint(getPointAtLength(d, -5), { x: 0, y: 0 });
    nearPoint(getPointAtLength(d, 500), { x: 0, y: 0 });
  });

  test('a jump between subpaths adds no length', () => {
    const d = 'M0 0 L10 0 M100 100 L100 120';
    assert.equal(parsePath(d).length, 2);
    near(getLength(d), 30);
    nearPoint(getPointAtLength(d, 15), { x: 100, y: 105 });
  });

  test('the tangent of a segment whose control sits on its end points along it near the ends', () => {
    nearPoint(getTangentAtLength('M0 0 C0 0 100 0 100 0', 0), { x: 1, y: 0 }, 1e-6);
    nearPoint(getTangentAtLength('M0 0 C0 0 100 0 100 0', 100), { x: 1, y: 0 }, 1e-6);
  });

  test('the tangent where both handles sit on an end point follows the segment at canvas coordinates', () => {
    nearPoint(getTangentAtLength('M1000 0 C1000 0 1000 0 1000.01 0', 0), { x: 1, y: 0 }, 1e-6);
    const end = 'M1000 0 C1000.01 0 1000.01 0 1000.01 0';
    nearPoint(getTangentAtLength(end, getLength(end)), { x: 1, y: 0 }, 1e-6);
    nearPoint(getTangentAtLength('M960 540 C960 540 960 540 960.5 540.5', 0), { x: Math.SQRT1_2, y: Math.SQRT1_2 }, 1e-6);
  });

  test('the tangent where one handle sits on its end point follows the other handle, off the chord', () => {
    nearPoint(getTangentAtLength('M960 540 C960 540 1060 640 1060 540', 0), { x: Math.SQRT1_2, y: Math.SQRT1_2 }, 1e-6);
    const end = 'M960 540 C960 640 1060 540 1060 540';
    nearPoint(getTangentAtLength(end, getLength(end)), { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, 1e-6);
    nearPoint(getTangentAtLength(`${end} L1100 540`, getLength(end)), { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, 1e-6);
  });

  test('the tangent where a segment pauses without turning back keeps its direction', () => {
    for (const at of [499.9999999, 500, 500.000000001, 500.000001]) {
      nearPoint(getTangentAtLength('M0 0 C1000 0 0 0 1000 0', at), { x: 1, y: 0 }, 1e-9);
    }
  });

  test('a rounding residue (a trig polygon closed by Z) is no drawn segment: the tangent and the ends come from its neighbour', () => {
    const tail = 'M960 540 L1000 540 L1000.0000000001 540';
    nearPoint(getTangentAtLength(tail, getLength(tail)), { x: 1, y: 0 }, 1e-9);
    nearPoint(getTangentAtLength('M960 540 L960.0000000001 540 L1000 540', 0), { x: 1, y: 0 }, 1e-9);
    const vertices = Array.from({ length: 7 }, (_, i) => {
      const a = (Math.PI * i) / 3;
      return `${960 + 300 * Math.cos(a)} ${540 + 300 * Math.sin(a)}`;
    });
    const hexagon = `M${vertices[0]} ${vertices
      .slice(1)
      .map((vertex) => `L${vertex}`)
      .join(' ')} Z`;
    nearPoint(getTangentAtLength(hexagon, getLength(hexagon)), { x: 0.5, y: Math.sqrt(3) / 2 }, 1e-9);
    nearPoint(getPointAtLength(hexagon, getLength(hexagon)), { x: 1260, y: 540 }, 1e-6);
    assert.throws(() => getTangentAtLength('M0 0 L1e-10 0', 0), /draws nothing/);
    assert.throws(() => getPointAtLength('M0 0 L1e-10 0', 0), /draws nothing/);
  });

  test('next to a residue, the tangent at a handle that sits on its end point keeps the drawing direction', () => {
    const closed =
      'M1260 540 C1260 705.69 1125.69 840 960 840 C794.31 840 660 705.69 660 540 C660 374.31 794.31 240 960 240 C1260 240 1260 540.00000001 1260 540.00000001 Z';
    nearPoint(getTangentAtLength(closed, getLength(closed)), { x: 0, y: 1 }, 1e-6);
    const start = 'M960 540 L960.00000001 540 C960.00000001 540 1160 340 1160 540';
    for (const d of [start, `${start} L1200 540`])
      nearPoint(getTangentAtLength(d, 0), { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, 1e-6);
  });

  test('the tangent at the very end, where rounding leaves a residue past the last segment, still points along it', () => {
    // The segment lengths sum a hair short of the total here, so the end resolves to t = 1 exactly, where the last
    // cubic's derivative is 0.
    const d = 'M0 0 L0.548 0 L3.6879999999999997 0 C3.6879999999999997 0 10.988 0 10.988 0';
    nearPoint(getTangentAtLength(d, getLength(d)), { x: 1, y: 0 }, 1e-6);
  });

  test('the tangent at the end of a path ending in a zero-length segment (an exported SVG) points along the last drawn one', () => {
    for (const d of [
      'M0 0 L0.1 0 L0.3 0 L10 0 h0',
      'M0 0 L0.548 0 L3.6879999999999997 0 C3.6879999999999997 0 10.988 0 10.988 0 L10.988 0',
    ]) {
      nearPoint(getTangentAtLength(d, getLength(d)), { x: 1, y: 0 }, 1e-6);
      nearPoint(getPointAtLength(d, getLength(d)), { x: d.startsWith('M0 0 L0.1') ? 10 : 10.988, y: 0 }, 1e-6);
    }
  });

  test('a cubic that stops dead halfway, and a zero-length segment at the start', () => {
    // x(t) = 100 t (3 - 6 t + 4 t^2): monotonic with x'(0.5) = 0, so the point at length s is (s, 0).
    const d = 'M0 0 C100 0 0 0 100 0';
    near(getLength(d), 100);
    for (const s of [10, 30, 49, 51, 70, 95]) nearPoint(getPointAtLength(d, s), { x: s, y: 0 });
    nearPoint(getTangentAtLength('M0 0 L0 0 L10 0', 0), { x: 1, y: 0 }, 1e-9);
  });

  test('huge coordinates still measure (the integration stops splitting at float precision)', () => {
    near(getLength('M0 0 C1e12 0 0 0 1e12 0'), 1e12, 1);
  });

  test('a path that draws nothing cannot be measured at a length', () => {
    assert.equal(getLength('M5 5'), 0);
    assert.throws(() => getPointAtLength('M5 5', 0), /draws nothing/);
    assert.throws(() => getTangentAtLength('M5 5', 0), /draws nothing/);
  });

  test('a path of zero-length segments only (roundedRect, polygon, star at size 0) behaves like a path that draws nothing', () => {
    for (const d of [
      roundedRect({ width: 0, height: 0 }),
      polygon({ sides: 5, radius: 0 }),
      star({ outerRadius: 0, innerRadius: 0 }),
    ]) {
      assert.equal(getLength(d), 0, d);
      assert.throws(() => getPointAtLength(d, 0), /draws nothing/, d);
      assert.throws(() => getTangentAtLength(d, 0), /draws nothing/, d);
    }
  });

  test("measures stay right for each d when many paths are measured, and parsePath results are the caller's own", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `M0 0 h${i + 1}`);
    for (const d of lines) near(getLength(d), Number(d.slice(6)), 1e-9);
    for (const d of lines) near(getPointAtLength(d, 1e9).x, Number(d.slice(6)), 1e-9);
    const d = 'M0 0 L100 0';
    getLength(d);
    parsePath(d)[0].segments[0].to.x = 500;
    near(getLength(d), 100, 1e-9);
  });

  test('evicting past the cache caps (1024 paths, 100k segments) keeps every measure right', () => {
    const lines = Array.from({ length: 1100 }, (_, i) => `M0 0 h${i + 1}`);
    for (const d of [...lines, ...lines.slice(0, 50)]) near(getLength(d), Number(d.slice(6)), 1e-9);
    const big = 'M0 0' + ' h1'.repeat(100_001);
    near(getLength(big), 100_001, 1e-6);
    for (const d of lines.slice(0, 50)) near(getPointAtLength(d, 1e9).x, Number(d.slice(6)), 1e-9);
    near(getLength(big), 100_001, 1e-6);
  });

  test('a scene cycling through 40 paths reads them from the cache on the second pass', () => {
    // One glyph-like d per subpath of a vectorised word, each 21 cubics long.
    const paths = Array.from({ length: 40 }, (_, k) => {
      const curves = Array.from({ length: 21 }, (_, i) => `c${k + 3} ${i + 1} ${2 * i + 5} -${k + 2} ${i + 7} ${k + 1}`);
      return `M${1000 + k} ${2000 + k}${curves.join('')}`;
    });
    const pass = () => {
      const start = performance.now();
      for (const d of paths) evolvePath(0.5, d);
      return performance.now() - start;
    };
    const first = pass();
    const second = Math.min(pass(), pass(), pass());
    assert.ok(second < first / 10, `first pass ${first} ms, second ${second} ms`);
  });

  test('getPointAtLength and getTangentAtLength throw on a NaN length', () => {
    assert.throws(() => getPointAtLength('M0 0 L100 0', NaN), /getPointAtLength: length is NaN/);
    assert.throws(() => getTangentAtLength('M0 0 L100 0', NaN), /getTangentAtLength: length is NaN/);
  });
});

describe('evolvePath', () => {
  test('dashes the length and offsets what is not drawn yet', () => {
    const d = 'M0 0 h100 v50 h-100 z';
    const expect = (progress: number, offset: number) => {
      const { strokeDasharray, strokeDashoffset } = evolvePath(progress, d);
      const [dash, gap] = strokeDasharray.split(' ').map(Number);
      near(dash, 300, 1e-6);
      near(gap, 300, 1e-6);
      near(strokeDashoffset, offset, 1e-6, `progress ${progress}`);
    };
    expect(0.25, 225);
    expect(0.999, 0.3);
  });

  test('at the ends: no dash once drawn (no notch at the closing corner), nothing at all before (no round-cap dot)', () => {
    const d = 'M0 0 h100 v50 h-100 z';
    for (const progress of [1, 1.5]) assert.deepEqual(evolvePath(progress, d), { strokeDasharray: 'none', strokeDashoffset: 0 });
    // One zero-length dash per 602 px, shifted 1 px back: none lands on the 300 px of the path.
    for (const progress of [0, -1]) {
      const { strokeDasharray, strokeDashoffset } = evolvePath(progress, d);
      const [dash, gap] = strokeDasharray.split(' ').map(Number);
      assert.equal(dash, 0);
      near(gap, 602, 1e-6);
      assert.equal(strokeDashoffset, 1);
    }
  });

  test('evolvePath throws on a NaN progress', () => {
    assert.throws(() => evolvePath(NaN, 'M0 0 L100 0'), /evolvePath: progress is NaN/);
  });

  test('evolvePath throws on several subpaths: browsers restart the dash on each one', () => {
    for (const progress of [0, 0.5, 1]) assert.throws(() => evolvePath(progress, 'M0 0 h10 M0 5 h10'), /one subpath per d/);
    assert.throws(() => evolvePath(0.5, 'M0 0 h10 z h5'), /one subpath per d/);
    // A move that draws nothing before the drawn part is still one subpath.
    assert.equal(evolvePath(0.5, 'M50 50 M0 0 h10').strokeDashoffset, 5);
  });
});

describe('shapes', () => {
  const boxNear = (d: string, expected: { minX: number; minY: number; maxX: number; maxY: number }) => {
    const box = bounds(d);
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) near(box[key], expected[key], 0.1, key);
  };

  test('circle and ellipse, centred on (x, y), start on the right and run clockwise', () => {
    const c = circle({ radius: 50, x: 100, y: 200 });
    assertClosed(c);
    boxNear(c, { minX: 50, minY: 150, maxX: 150, maxY: 250 });
    nearPoint(getPointAtLength(c, 0), { x: 150, y: 200 });
    nearPoint(getPointAtLength(c, getLength(c) / 4), { x: 100, y: 250 });
    const e = ellipse({ rx: 80, ry: 40, x: 10, y: -10 });
    assertClosed(e);
    boxNear(e, { minX: -70, minY: -50, maxX: 90, maxY: 30 });
  });

  test('polygon: first vertex straight up from the centre, rotation in degrees clockwise', () => {
    const hex = polygon({ sides: 6, radius: 100 });
    assertClosed(hex);
    assert.equal(parsePath(hex)[0].segments.length, 6);
    nearPoint(getPointAtLength(hex, 0), { x: 0, y: -100 });
    boxNear(hex, { minX: -86.6, minY: -100, maxX: 86.6, maxY: 100 });
    nearPoint(getPointAtLength(polygon({ sides: 4, radius: 10, rotation: 90, x: 5, y: 5 }), 0), { x: 15, y: 5 });
    assert.throws(() => polygon({ sides: 2, radius: 10 }), /at least 3/);
    assert.throws(() => polygon({ sides: 4.5, radius: 10 }), /whole number/);
  });

  test('star: alternating outer and inner points, first point up', () => {
    const s = star({ points: 5, outerRadius: 100, innerRadius: 40, x: 20, y: 30 });
    assertClosed(s);
    assert.equal(parsePath(s)[0].segments.length, 10);
    nearPoint(getPointAtLength(s, 0), { x: 20, y: -70 });
    const side = 100 * Math.sin((2 * Math.PI) / 5);
    boxNear(s, { minX: 20 - side, minY: -70, maxX: 20 + side, maxY: 30 + 100 * Math.cos(Math.PI / 5) });
    const firstInner = parsePath(s)[0].segments[0].to;
    nearPoint(firstInner, { x: 20 + 40 * Math.sin(Math.PI / 5), y: 30 - 40 * Math.cos(Math.PI / 5) });
    assert.throws(() => star({ points: 1, outerRadius: 10, innerRadius: 5 }), /at least 2/);
    assert.throws(() => star({ points: 5.5, outerRadius: 10, innerRadius: 5 }), /whole number/);
    // Coordinates are rounded: no 6.123233995736766e-17 in the data.
    assert.equal(
      star({ outerRadius: 100, innerRadius: 50, rotation: 90 }),
      'M100,0L40.451,29.389L30.902,95.106L-15.451,47.553L-80.902,58.779L-50,0L-80.902,-58.779L-15.451,-47.553L30.902,-95.106L40.451,-29.389Z',
    );
  });

  test('triangle: equilateral, its bounding box centred on (x, y), tip towards direction', () => {
    const h = (100 * Math.sqrt(3)) / 2;
    const up = triangle({ side: 100 });
    assertClosed(up);
    boxNear(up, { minX: -50, minY: -h / 2, maxX: 50, maxY: h / 2 });
    nearPoint(getPointAtLength(up, 0), { x: 0, y: -h / 2 });
    nearPoint(getPointAtLength(triangle({ side: 100, direction: 'down' }), 0), { x: 0, y: h / 2 });
    nearPoint(getPointAtLength(triangle({ side: 100, direction: 'left', x: 10 }), 0), { x: 10 - h / 2, y: 0 });
    const right = triangle({ side: 100, direction: 'right', y: 10 });
    nearPoint(getPointAtLength(right, 0), { x: h / 2, y: 10 });
    boxNear(right, { minX: -h / 2, minY: -40, maxX: h / 2, maxY: 60 });
  });

  test('every shape draws clockwise on screen (positive signed area with y down)', () => {
    const signedArea = (d: string) => {
      const total = getLength(d);
      const points = Array.from({ length: 400 }, (_, i) => getPointAtLength(d, (total * i) / 400));
      return points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + (p.x * q.y - q.x * p.y) / 2;
      }, 0);
    };
    const shapes = {
      circle: circle({ radius: 50 }),
      ellipse: ellipse({ rx: 80, ry: 40 }),
      roundedRect: roundedRect({ width: 200, height: 100, cornerRadius: 20 }),
      polygon: polygon({ sides: 6, radius: 100 }),
      star: star({ outerRadius: 100, innerRadius: 40 }),
      pie: pie({ radius: 100, progress: 0.3 }),
      ...Object.fromEntries(
        (['up', 'down', 'left', 'right'] as const).map((direction) => [
          `triangle ${direction}`,
          triangle({ side: 100, direction }),
        ]),
      ),
    };
    for (const [name, d] of Object.entries(shapes)) assert.ok(signedArea(d) > 0, `${name}: ${signedArea(d)}`);
  });

  test('pie: a slice from the top, clockwise by progress, centred on (x, y)', () => {
    const quarter = pie({ radius: 100, progress: 0.25 });
    assertClosed(quarter);
    boxNear(quarter, { minX: 0, minY: -100, maxX: 100, maxY: 0 });
    near(getLength(quarter), 200 + (2 * Math.PI * 100) / 4);
    const threeQuarters = pie({ radius: 100, progress: 0.75, x: 10, y: 10 });
    boxNear(threeQuarters, { minX: -90, minY: -90, maxX: 110, maxY: 110 });
    near(getLength(threeQuarters), 200 + (2 * Math.PI * 100 * 3) / 4);
    const rotated = pie({ radius: 100, progress: 0.25, rotation: 90 });
    boxNear(rotated, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const full = pie({ radius: 100, progress: 1 });
    assertClosed(full);
    near(getLength(full), 2 * Math.PI * 100);
    assert.equal(getLength(pie({ radius: 100, progress: 0 })), 0);
    near(getLength(pie({ radius: 100, progress: 1.4 })), 2 * Math.PI * 100);
  });

  test('pie just under 1 (a spring or an ease settling) is the whole circle, just over 0 nothing', () => {
    for (const radius of [60, 120, 300]) {
      const d = pie({ radius, progress: 1 - 1e-8 });
      near(getLength(d), 2 * Math.PI * radius, 0.1, `radius ${radius}`);
      assert.equal(getLength(pie({ radius, progress: 1e-9 })), 0, `radius ${radius} just over 0`);
    }
  });

  test('pie just under 1 and turned stays centred on (x, y)', () => {
    for (const rotation of [37, 61, 133]) {
      for (const progress of [0.99999, 0.999998]) {
        const box = bounds(pie({ radius: 300, progress, rotation, x: 960, y: 540 }));
        nearPoint({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }, { x: 960, y: 540 });
      }
    }
  });

  test('a turned pie near half a turn is as long as its slice', () => {
    for (const rotation of [13, 37]) {
      near(getLength(pie({ radius: 300, progress: 0.4999, rotation })), 600 + 2 * Math.PI * 300 * 0.4999);
    }
  });

  test('pie throws on a NaN progress', () => {
    assert.throws(() => pie({ radius: 10, progress: NaN }), /pie: progress is NaN/);
  });

  test('roundedRect: centred on (x, y), corners clamped to half the short side', () => {
    const r = roundedRect({ width: 200, height: 100, cornerRadius: 20, x: 10, y: 10 });
    assertClosed(r);
    boxNear(r, { minX: -90, minY: -40, maxX: 110, maxY: 60 });
    near(getLength(r), 2 * (160 + 60) + 2 * Math.PI * 20);
    const square = roundedRect({ width: 100, height: 100 });
    near(getLength(square), 400);
    near(getLength(roundedRect({ width: 100, height: 40, cornerRadius: 500 })), 2 * 60 + 2 * Math.PI * 20);
  });
});
