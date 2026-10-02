// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { ease, type Easing } from './easing';

export function clamp(value: number, min = 0, max = 1): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear blend from a to b (p is not clamped). */
export function mix(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/**
 * Map v from [inMin, inMax] to [outMin, outMax], clamped, optionally eased. Reversed ranges work.
 *   remap(scrollY, 0, 400, 1, 0.6)
 */
export function remap(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  easing: Easing = ease.linear,
): number {
  const span = inMax - inMin;
  if (span === 0) return v >= inMin ? outMax : outMin;
  return mix(outMin, outMax, easing(clamp((v - inMin) / span)));
}

export interface InterpolateOptions {
  /** One easing for every segment, or one per segment. Default linear. */
  easing?: Easing | readonly (Easing | undefined)[];
  /** Hold the end values outside the input range (default true). Set false to extrapolate linearly. */
  clamp?: boolean;
}

/**
 * Map time (or any number) through keyframes.
 *   interpolate(t, [0.2, 0.8], [0, 1], { easing: ease.outCubic })
 *   interpolate(t, [0, 0.4, 1.6, 2], [0, 1, 1, 0])   // fade in, hold, fade out
 */
export function interpolate(
  t: number,
  input: readonly number[],
  output: readonly number[],
  options: InterpolateOptions = {},
): number {
  const n = input.length;
  if (n === 0 || n !== output.length) {
    throw new Error(`interpolate: input (${n}) and output (${output.length}) must have the same non-zero length`);
  }
  if (n === 1) return output[0];
  const shouldClamp = options.clamp !== false;
  if (t <= input[0]) {
    if (shouldClamp || t === input[0]) return output[0];
    const span = input[1] - input[0];
    return span === 0 ? output[0] : output[0] + ((output[1] - output[0]) * (t - input[0])) / span;
  }
  if (t >= input[n - 1]) {
    if (shouldClamp || t === input[n - 1]) return output[n - 1];
    const span = input[n - 1] - input[n - 2];
    return span === 0 ? output[n - 1] : output[n - 1] + ((output[n - 1] - output[n - 2]) * (t - input[n - 1])) / span;
  }
  let i = 0;
  while (i < n - 2 && t > input[i + 1]) i++;
  const a = input[i];
  const b = input[i + 1];
  if (b <= a) return output[i + 1];
  const e = options.easing;
  const fn: Easing = (Array.isArray(e) ? e[i] : (e as Easing | undefined)) ?? ease.linear;
  return output[i] + (output[i + 1] - output[i]) * fn((t - a) / (b - a));
}

/**
 * 0 to 1 progress of `t` through [start, end], clamped and eased.
 *   const p = progress(t, 0.3, 0.9, ease.outExpo)
 */
export function progress(t: number, start: number, end: number, easing: Easing = ease.linear): number {
  if (end <= start) return t >= start ? 1 : 0;
  return easing(clamp((t - start) / (end - start)));
}

/**
 * Keyframes as [time, value, easingIntoThisKey?] tuples.
 *   keyframes(t, [[0, 0], [0.5, 1, ease.outBack], [2, 1], [2.4, 0, ease.inCubic]])
 */
export function keyframes(t: number, keys: readonly (readonly [number, number, Easing?])[]): number {
  return interpolate(
    t,
    keys.map((k) => k[0]),
    keys.map((k) => k[1]),
    { easing: keys.slice(1).map((k) => k[2]) },
  );
}

/** Delay for item i of a staggered group. */
export function stagger(i: number, each: number, start = 0): number {
  return start + i * each;
}

/** Stagger outward from an origin (the center by default, or an item index) instead of from the first item. */
export function staggerFrom(
  i: number,
  count: number,
  each: number,
  from: 'start' | 'center' | 'end' | number = 'center',
  start = 0,
): number {
  const origin = typeof from === 'number' ? from : from === 'start' ? 0 : from === 'end' ? count - 1 : (count - 1) / 2;
  return start + Math.abs(i - origin) * each;
}

/** Wrap t into [0, period). */
export function loop(t: number, period: number): number {
  return ((t % period) + period) % period;
}

/** Triangle wave from 0 to 1 and back to 0 over `period`. */
export function pingpong(t: number, period: number): number {
  const x = loop(t, period * 2) / period;
  return x <= 1 ? x : 2 - x;
}

export interface SpringOptions {
  from?: number;
  to?: number;
  /** Spring constant (default 170). */
  stiffness?: number;
  /** Damping coefficient (default 26 ≈ critically damped at the default stiffness). */
  damping?: number;
  mass?: number;
  /** Initial velocity in units per second. */
  velocity?: number;
}

/** Ready-made spring configs. */
export const springs = {
  /** Settles without overshoot. */
  smooth: { stiffness: 170, damping: 26 },
  /** Quick, with a hint of overshoot. */
  snappy: { stiffness: 300, damping: 28 },
  /** Soft and slow. */
  gentle: { stiffness: 90, damping: 18 },
  /** Visible bounce. */
  bouncy: { stiffness: 220, damping: 12 },
} satisfies Record<string, SpringOptions>;

/**
 * Exact damped-spring value `t` seconds after the spring starts (t <= 0 returns `from`).
 *   const y = spring(t - 0.4, { from: 80, to: 0, ...springs.snappy })
 */
export function spring(t: number, options: SpringOptions = {}): number {
  const { from = 0, to = 1, stiffness = 170, damping = 26, mass = 1, velocity = 0 } = options;
  if (t <= 0) return from;
  const x0 = from - to;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let x: number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    x = Math.exp(-zeta * w0 * t) * (x0 * Math.cos(wd * t) + ((velocity + zeta * w0 * x0) / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    x = Math.exp(-w0 * t) * (x0 + (velocity + w0 * x0) * t);
  } else {
    const s = Math.sqrt(zeta * zeta - 1);
    const r1 = -w0 * (zeta - s);
    const r2 = -w0 * (zeta + s);
    const cB = (velocity - r1 * x0) / (r2 - r1);
    const cA = x0 - cB;
    x = cA * Math.exp(r1 * t) + cB * Math.exp(r2 * t);
  }
  return to + x;
}

/** Seconds until a spring from 0 to 1 stays within `threshold` of its target. */
export function springDuration(options: Omit<SpringOptions, 'from' | 'to'> = {}, threshold = 0.001): number {
  const step = 1 / 240;
  let settledAt = 0;
  for (let i = 0; i < 2400; i++) {
    const t = i * step;
    if (Math.abs(spring(t, { ...options, from: 0, to: 1 }) - 1) > threshold) settledAt = t + step;
  }
  return settledAt;
}
