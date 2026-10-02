// Adapted from saeedvaziry/caleb-video-editor (MIT)

/** FNV-1a of the seed's string form, so 1, '1', 0.25 and 'card-3' are all valid, stable seeds. */
function hashSeed(seed: number | string): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic pseudo-random number in [0, 1) for a seed. Same seed, same value, every frame. */
export function random(seed: number | string): number {
  // mulberry32 finalizer: good avalanche even for seeds that differ by one character.
  let t = (hashSeed(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic random number in [min, max). */
export function randomRange(seed: number | string, min: number, max: number): number {
  return min + random(seed) * (max - min);
}

/**
 * Smooth 1D noise in [-1, 1] (Catmull-Rom through random values at integers: no flat spots, no forced zeros).
 * Use for gentle drift: noise(t * 0.8, 'card') * 6
 */
export function noise(x: number, seed: number | string = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const v = (k: number) => random(`${seed}:${k}`) * 2 - 1;
  const p0 = v(i - 1);
  const p1 = v(i);
  const p2 = v(i + 1);
  const p3 = v(i + 2);
  const r = 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
  // Catmull-Rom can overshoot its control values by up to 25 %.
  return r * 0.8;
}

/** Smooth 2D gradient (Perlin) noise in [-1, 1]; 0 on integer lattice points, so sample between them. */
export function noise2(x: number, y: number, seed: number | string = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const dot = (cx: number, cy: number, dx: number, dy: number) => {
    const a = random(`${seed}:${cx}:${cy}`) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(fx);
  const n00 = dot(ix, iy, fx, fy);
  const n10 = dot(ix + 1, iy, fx - 1, fy);
  const n01 = dot(ix, iy + 1, fx, fy - 1);
  const n11 = dot(ix + 1, iy + 1, fx - 1, fy - 1);
  const top = n00 + (n10 - n00) * u;
  const bottom = n01 + (n11 - n01) * u;
  const r = (top + (bottom - top) * fade(fy)) * Math.SQRT2;
  return r < -1 ? -1 : r > 1 ? 1 : r;
}
