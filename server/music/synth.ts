// Offline synthesizer for the preset soundtracks (./soundtracks): oscillators, filters, drum and synth voices, reverb,
// delay, sidechain, BS.1770 loudness and a look-ahead limiter. Deterministic: the same seed gives the same samples.
import { spawnSync } from 'node:child_process';
import { m } from '../i18n';

export const SR = 44100;
const TAU = 2 * Math.PI;

export interface Stereo {
  l: Float32Array;
  r: Float32Array;
}

export type Rand = () => number;

export const stereo = (samples: number): Stereo => ({ l: new Float32Array(samples), r: new Float32Array(samples) });
export const mtof = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const db = (value: number) => 10 ** (value / 20);

/** mulberry32: a seeded generator in [0, 1). */
export function rng(seed: number): Rand {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds a mono voice of `seconds` at `t` into the bus, panned from -1 (left) to 1 (right) at constant power. */
function voice(bus: Stereo, t: number, seconds: number, pan: number, sample: (i: number, dt: number) => number): void {
  const from = Math.max(0, Math.round(t * SR));
  const count = Math.min(Math.round(seconds * SR), bus.l.length - from);
  const angle = ((pan + 1) * Math.PI) / 4;
  const left = Math.cos(angle) * Math.SQRT2;
  const right = Math.sin(angle) * Math.SQRT2;
  for (let i = 0; i < count; i++) {
    const s = sample(i, i / SR);
    bus.l[from + i] += s * left;
    bus.r[from + i] += s * right;
  }
}

// Oscillators (PolyBLEP: band-limited edges) and envelope

function blep(p: number, dt: number): number {
  if (p < dt) {
    const x = p / dt;
    return x + x - x * x - 1;
  }
  if (p > 1 - dt) {
    const x = (p - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

const saw = (p: number, dt: number) => 2 * p - 1 - blep(p, dt);
const square = (p: number, dt: number) => (p < 0.5 ? 1 : -1) + blep(p, dt) - blep((p + 0.5) % 1, dt);
const triangle = (p: number) => 1 - 4 * Math.abs(p - 0.5);

/** Linear attack, exponential decay (time constant `d`) towards `s`, exponential release `gate` seconds in. */
function adsr(dt: number, gate: number, a: number, d: number, s: number, r: number): number {
  const level = (x: number) => (x < a ? x / a : s + (1 - s) * Math.exp(-(x - a) / d));
  return dt < gate ? level(dt) : level(gate) * Math.exp(-(dt - gate) / r);
}

// Filters

/** State variable filter (Zavalishin's topology-preserving form): low, band and high outputs, cutoff movable per sample. */
export class Svf {
  low = 0;
  band = 0;
  high = 0;
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;

  constructor(cutoff: number, q = 0.707) {
    this.set(cutoff, q);
  }

  set(cutoff: number, q: number): void {
    const g = Math.tan((Math.PI * Math.min(Math.max(cutoff, 20), SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  run(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - this.k * v1 - v2;
  }
}

type BiquadType = 'lowpass' | 'highpass' | 'peak' | 'lowshelf' | 'highshelf';

/** RBJ cookbook biquad. */
export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b: [number, number, number];
  private readonly a: [number, number];

  constructor(type: BiquadType, f: number, q = 0.707, gain = 0) {
    const w = (TAU * f) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const A = 10 ** (gain / 40);
    const s = 2 * Math.sqrt(A) * alpha;
    const [b0, b1, b2, a0, a1, a2] =
      type === 'lowpass'
        ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
        : type === 'highpass'
          ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
          : type === 'peak'
            ? [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A]
            : type === 'lowshelf'
              ? [
                  A * (A + 1 - (A - 1) * cos + s),
                  2 * A * (A - 1 - (A + 1) * cos),
                  A * (A + 1 - (A - 1) * cos - s),
                  A + 1 + (A - 1) * cos + s,
                  -2 * (A - 1 + (A + 1) * cos),
                  A + 1 + (A - 1) * cos - s,
                ]
              : [
                  A * (A + 1 + (A - 1) * cos + s),
                  -2 * A * (A - 1 + (A + 1) * cos),
                  A * (A + 1 + (A - 1) * cos - s),
                  A + 1 - (A - 1) * cos + s,
                  2 * (A - 1 - (A + 1) * cos),
                  A + 1 - (A - 1) * cos - s,
                ];
    this.b = [b0 / a0, b1 / a0, b2 / a0];
    this.a = [a1 / a0, a2 / a0];
  }

  run(x: number): number {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// Drums

export interface HitOpts {
  vel?: number;
  pan?: number;
}

/**
 * Kick (or a sub boom): a sine falling from `from` to `to` Hz, a noise click, soft saturation. With `to` on a note and
 * `choke` seconds before the next one, an 808: the next note cuts it.
 */
export function kick(
  bus: Stereo,
  t: number,
  rand: Rand,
  o: HitOpts & { from?: number; to?: number; drop?: number; decay?: number; drive?: number; click?: number; choke?: number } = {},
): void {
  const { vel = 1, from = 150, to = 48, drop = 0.035, decay = 0.28, drive = 2, click = 0.4, choke = Infinity } = o;
  const norm = Math.tanh(drive);
  let phase = 0;
  voice(bus, t, Math.min(decay * 6, choke + 0.1) + 0.01, o.pan ?? 0, (_, dt) => {
    phase = (phase + (to + (from - to) * Math.exp(-dt / drop)) / SR) % 1;
    const cut = dt < choke ? 1 : Math.exp(-(dt - choke) / 0.015);
    const body = Math.sin(TAU * phase) * Math.min(1, dt / 0.0015) * Math.exp(-dt / decay) * cut;
    const tick = dt < 0.01 ? click * (rand() * 2 - 1) * Math.exp(-dt / 0.002) : 0;
    return (vel * Math.tanh(drive * (body + tick))) / norm;
  });
}

/** Snare: two damped tones bending down and band-passed noise. */
export function snare(
  bus: Stereo,
  t: number,
  rand: Rand,
  o: HitOpts & { tone?: number; decay?: number; snap?: number; color?: number } = {},
): void {
  const { vel = 1, tone = 190, decay = 0.15, snap = 0.65, color = 4000 } = o;
  const noise = new Svf(color, 0.55);
  let p1 = 0;
  let p2 = 0;
  voice(bus, t, decay * 6 + 0.01, o.pan ?? 0, (_, dt) => {
    const bend = 1 + 0.35 * Math.exp(-dt / 0.012);
    p1 = (p1 + (tone * bend) / SR) % 1;
    p2 = (p2 + (tone * 1.78 * bend) / SR) % 1;
    const body = (0.65 * Math.sin(TAU * p1) + 0.35 * Math.sin(TAU * p2)) * Math.exp(-dt / 0.055);
    noise.run(rand() * 2 - 1);
    const hiss = (noise.band + 0.5 * noise.high) * Math.exp(-dt / decay) * Math.min(1, dt / 0.0005);
    return vel * Math.tanh(1.6 * ((1 - snap) * body + snap * 1.6 * hiss));
  });
}

/** Clap: band-passed noise in three quick bursts, then a tail. */
export function clap(bus: Stereo, t: number, rand: Rand, o: HitOpts & { decay?: number; color?: number } = {}): void {
  const { vel = 1, decay = 0.14, color = 1300 } = o;
  const noise = new Svf(color, 1.1);
  voice(bus, t, 0.02 + decay * 6, o.pan ?? 0, (_, dt) => {
    const bursts = dt < 0.03 ? Math.exp(-(dt % 0.01) / 0.003) : 0;
    const tail = dt > 0.02 ? Math.exp(-(dt - 0.02) / decay) : 0;
    noise.run(rand() * 2 - 1);
    return vel * 3 * noise.band * Math.max(bursts, tail);
  });
}

/** The six square oscillators of a TR-808 cymbal. */
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

/** Hi-hat: high-passed noise and metal; a longer decay opens it. */
export function hat(bus: Stereo, t: number, rand: Rand, o: HitOpts & { decay?: number; tone?: number } = {}): void {
  const { vel = 1, decay = 0.045, tone = 7500 } = o;
  const filter = new Svf(tone, 0.8);
  const phases = METAL.map(() => rand());
  voice(bus, t, decay * 7, o.pan ?? 0, (_, dt) => {
    let metal = 0;
    for (let k = 0; k < METAL.length; k++) {
      phases[k] = (phases[k] + METAL[k] / SR) % 1;
      metal += phases[k] < 0.5 ? 1 : -1;
    }
    filter.run(0.6 * (rand() * 2 - 1) + 0.12 * metal);
    return vel * 1.5 * filter.high * Math.exp(-dt / decay);
  });
}

/** Crash: wide metal and noise with a long decay. */
export function crash(bus: Stereo, t: number, rand: Rand, o: HitOpts & { decay?: number } = {}): void {
  const { vel = 1, decay = 1.1 } = o;
  for (const pan of [-0.5, 0.5]) {
    const filter = new Svf(4500, 0.7);
    const phases = METAL.map(() => rand());
    voice(bus, t, decay * 6, pan, (_, dt) => {
      let metal = 0;
      for (let k = 0; k < METAL.length; k++) {
        phases[k] = (phases[k] + (METAL[k] * 1.47) / SR) % 1;
        metal += phases[k] < 0.5 ? 1 : -1;
      }
      filter.run(0.7 * (rand() * 2 - 1) + 0.1 * metal);
      const env = 0.35 * Math.exp(-dt / 0.08) + 0.65 * Math.exp(-dt / decay);
      return vel * filter.high * env * Math.min(1, dt / 0.002);
    });
  }
}

/** Shaker: band-passed noise with a soft attack. */
export function shaker(bus: Stereo, t: number, rand: Rand, o: HitOpts & { decay?: number } = {}): void {
  const { vel = 1, decay = 0.04 } = o;
  const filter = new Svf(5500, 1.2);
  voice(bus, t, 0.012 + decay * 6, o.pan ?? 0, (_, dt) => {
    filter.run(rand() * 2 - 1);
    return vel * 2 * filter.band * (dt < 0.012 ? dt / 0.012 : Math.exp(-(dt - 0.012) / decay));
  });
}

/** Tuned percussion: a sine bending down from `bend` × `freq`, with a click (toms, rim, clave). */
export function perc(
  bus: Stereo,
  t: number,
  rand: Rand,
  o: HitOpts & { freq: number; decay?: number; bend?: number; click?: number },
): void {
  const { vel = 1, freq, decay = 0.15, bend = 1.5, click = 0.2 } = o;
  let phase = 0;
  voice(bus, t, decay * 6 + 0.01, o.pan ?? 0, (_, dt) => {
    phase = (phase + (freq * (1 + (bend - 1) * Math.exp(-dt / 0.02))) / SR) % 1;
    const tick = dt < 0.006 ? click * (rand() * 2 - 1) * Math.exp(-dt / 0.0015) : 0;
    return vel * (Math.sin(TAU * phase) * Math.exp(-dt / decay) * Math.min(1, dt / 0.0008) + tick);
  });
}

/** Noise riser: a band sweeping up from `from` to `to` Hz while it swells, wide. */
export function riser(
  bus: Stereo,
  t: number,
  seconds: number,
  rand: Rand,
  o: { vel?: number; from?: number; to?: number } = {},
): void {
  const { vel = 1, from = 300, to = 9000 } = o;
  for (const pan of [-0.6, 0.6]) {
    const filter = new Svf(from, 1.6);
    voice(bus, t, seconds, pan, (i, dt) => {
      const x = dt / seconds;
      if ((i & 15) === 0) filter.set(from * (to / from) ** x, 1.6);
      filter.run(rand() * 2 - 1);
      return vel * 2.5 * filter.band * x * x;
    });
  }
}

/** Amapiano log drum: a saturated tone with a fast pitch fall and a knock, filtered. */
export function logDrum(
  bus: Stereo,
  t: number,
  length: number,
  midi: number,
  rand: Rand,
  o: HitOpts & { decay?: number } = {},
): void {
  const { vel = 1, decay = 0.3 } = o;
  const f = mtof(midi);
  const tone = new Svf(1800, 0.7);
  let phase = 0;
  voice(bus, t, length + 0.25, o.pan ?? 0, (_, dt) => {
    phase = (phase + (f * (1 + 1.1 * Math.exp(-dt / 0.012))) / SR) % 1;
    const x = Math.sin(TAU * phase) + 0.45 * Math.sin(2 * TAU * phase) + 0.2 * Math.sin(3 * TAU * phase);
    const knock = dt < 0.01 ? 0.5 * (rand() * 2 - 1) * Math.exp(-dt / 0.002) : 0;
    tone.run(Math.tanh(2.2 * x) + knock);
    const env = Math.min(1, dt / 0.001) * Math.exp(-dt / decay) * (dt < length ? 1 : Math.exp(-(dt - length) / 0.04));
    return vel * tone.low * env;
  });
}

// Tonal voices

export interface SynthOpts {
  vel?: number;
  pan?: number;
  wave?: 'saw' | 'square' | 'triangle' | 'sine';
  /** One oscillator per value, detuned by that many cents. */
  detune?: number[];
  /** A sine at the fundamental, added after the filter. */
  sub?: number;
  cutoff?: number;
  q?: number;
  /** Filter envelope: the cutoff opens by `env` Hz, closing with time constant `envDecay`. */
  env?: number;
  envDecay?: number;
  /** Slow filter sweep: ± `lfoDepth` Hz at `lfoRate` Hz, on the song's clock. */
  lfoRate?: number;
  lfoDepth?: number;
  a?: number;
  d?: number;
  s?: number;
  r?: number;
  drive?: number;
  /** Vibrato depth in cents, fading in. */
  vibrato?: number;
}

/** Subtractive voice: bass, stabs, pads, plucks, leads. `length` is the gate in seconds. */
export function synth(bus: Stereo, t: number, length: number, midi: number, rand: Rand, o: SynthOpts = {}): void {
  const { vel = 1, wave = 'saw', detune = [0], sub = 0, cutoff = 2000, q = 0.8, env = 0, envDecay = 0.2 } = o;
  const { lfoRate = 0, lfoDepth = 0, a = 0.005, d = 0.3, s = 1, r = 0.08, drive = 0, vibrato = 0 } = o;
  const f = mtof(midi);
  const steps = detune.map((cents) => (f * 2 ** (cents / 1200)) / SR);
  const phases = detune.map(() => rand());
  const filter = new Svf(cutoff, q);
  const norm = 1 / Math.sqrt(detune.length);
  const sat = drive ? Math.tanh(drive) : 1;
  let subPhase = 0;
  voice(bus, t, length + r * 6, o.pan ?? 0, (i, dt) => {
    const vib = vibrato ? 2 ** ((vibrato * Math.min(1, dt / 0.4) * Math.sin(TAU * 5.5 * dt)) / 1200) : 1;
    let x = 0;
    for (let k = 0; k < steps.length; k++) {
      const step = steps[k] * vib;
      const p = (phases[k] + step) % 1;
      phases[k] = p;
      x +=
        wave === 'saw'
          ? saw(p, step)
          : wave === 'square'
            ? square(p, step)
            : wave === 'triangle'
              ? triangle(p)
              : Math.sin(TAU * p);
    }
    if ((i & 15) === 0) {
      filter.set(cutoff + env * Math.exp(-dt / envDecay) + lfoDepth * Math.sin(TAU * lfoRate * (t + dt)), q);
    }
    filter.run(x * norm);
    let y = filter.low;
    if (sub) {
      subPhase = (subPhase + f / SR) % 1;
      y += sub * Math.sin(TAU * subPhase);
    }
    if (drive) y = Math.tanh(drive * y) / sat;
    return vel * y * adsr(dt, length, a, d, s, r);
  });
}

export interface FmOpts {
  vel?: number;
  pan?: number;
  /** Modulator frequency over the note's. */
  ratio?: number;
  index?: number;
  indexDecay?: number;
  /** Electric piano tine: a short modulator at 14 × the note. */
  tine?: number;
  decay?: number;
  r?: number;
  a?: number;
}

/** Two-operator FM: electric piano (ratio 1 with a tine), bells (inharmonic ratio), soft plucks. */
export function fm(bus: Stereo, t: number, length: number, midi: number, o: FmOpts = {}): void {
  const { vel = 1, ratio = 1, index = 1.5, indexDecay = 0.5, tine = 0, decay = 1.5, r = 0.25, a = 0.002 } = o;
  const f = mtof(midi);
  let carrier = 0;
  let modulator = 0;
  let bell = 0;
  voice(bus, t, length + r * 6, o.pan ?? 0, (_, dt) => {
    carrier = (carrier + f / SR) % 1;
    modulator = (modulator + (f * ratio) / SR) % 1;
    bell = (bell + (f * 14) / SR) % 1;
    const depth = index * (0.2 + 0.8 * Math.exp(-dt / indexDecay)) * (0.5 + 0.5 * vel);
    const mod = depth * Math.sin(TAU * modulator) + (tine ? tine * vel * Math.exp(-dt / 0.025) * Math.sin(TAU * bell) : 0);
    const env = Math.min(1, dt / a) * Math.exp(-dt / decay) * (dt < length ? 1 : Math.exp(-(dt - length) / r));
    return vel * Math.sin(TAU * carrier + mod) * env;
  });
}

// Bus effects

/** Static filter on both sides of a bus. */
export function eq(bus: Stereo, type: BiquadType, f: number, q = 0.707, gain = 0): void {
  for (const ch of [bus.l, bus.r]) {
    const filter = new Biquad(type, f, q, gain);
    for (let k = 0; k < ch.length; k++) ch[k] = filter.run(ch[k]);
  }
}

/** Low-pass (or high-pass) whose cutoff follows `cutoff(t)`: intros that open up, breaks that close. */
export function sweep(bus: Stereo, cutoff: (t: number) => number, o: { q?: number; high?: boolean } = {}): void {
  const q = o.q ?? 0.707;
  for (const ch of [bus.l, bus.r]) {
    const filter = new Svf(cutoff(0), q);
    for (let k = 0; k < ch.length; k++) {
      if ((k & 31) === 0) filter.set(cutoff(k / SR), q);
      filter.run(ch[k]);
      ch[k] = o.high ? filter.high : filter.low;
    }
  }
}

/** Sidechain: after each hit the bus drops by `depth` (0 to 1) and recovers with time constant `release`. */
export function duck(bus: Stereo, hits: number[], depth: number, release = 0.1): void {
  const n = bus.l.length;
  const gain = new Float32Array(n).fill(1);
  const span = Math.round(release * 7 * SR);
  for (const t of hits) {
    const from = Math.round(t * SR);
    for (let i = 0; i < span && from + i < n; i++) {
      const x = i / SR;
      const g = 1 - depth * Math.min(1, x / 0.004) * Math.exp(-Math.max(0, x - 0.004) / release);
      if (g < gain[from + i]) gain[from + i] = g;
    }
  }
  for (let k = 0; k < n; k++) {
    bus.l[k] *= gain[k];
    bus.r[k] *= gain[k];
  }
}

/** Gate: the bus is open for `hold` seconds after each hit and closes in `close` seconds (gated reverb). */
export function gate(bus: Stereo, hits: number[], hold: number, close = 0.03): void {
  const n = bus.l.length;
  const gain = new Float32Array(n);
  const span = Math.round((hold + close * 5) * SR);
  for (const t of hits) {
    const from = Math.round(t * SR);
    for (let i = 0; i < span && from + i < n; i++) {
      const x = i / SR;
      gain[from + i] = Math.max(gain[from + i], x < hold ? 1 : Math.exp(-(x - hold) / close));
    }
  }
  for (let k = 0; k < n; k++) {
    bus.l[k] *= gain[k];
    bus.r[k] *= gain[k];
  }
}

/** Chorus: each side read through its own slowly modulated delay, mixed with the dry signal. */
export function chorus(bus: Stereo, o: { rate?: number; depth?: number; mix?: number } = {}): void {
  const { rate = 0.35, depth = 0.003, mix = 0.45 } = o;
  const base = 0.012 * SR;
  const swing = depth * SR;
  for (const [ch, offset] of [
    [bus.l, 0],
    [bus.r, Math.PI / 2],
  ] as const) {
    const dry = Float32Array.from(ch);
    for (let k = 0; k < ch.length; k++) {
      const pos = k - base - swing * 0.5 * (1 + Math.sin((TAU * rate * k) / SR + offset));
      const j = Math.floor(pos);
      if (j < 0) continue;
      const wet = dry[j] + (dry[j + 1] - dry[j]) * (pos - j);
      ch[k] = dry[k] * (1 - mix * 0.5) + wet * mix;
    }
  }
}

/** Tape wow and flutter: the pitch wavers a few cents. */
export function wow(bus: Stereo, o: { depth?: number; rate?: number } = {}): void {
  const { depth = 0.003, rate = 0.5 } = o;
  for (const ch of [bus.l, bus.r]) {
    const dry = Float32Array.from(ch);
    for (let k = 0; k < ch.length; k++) {
      const t = k / SR;
      const pos = k - SR * (0.004 + depth * 0.5 * (1 + Math.sin(TAU * rate * t)) + 0.0001 * Math.sin(TAU * 6.5 * t));
      const j = Math.floor(pos);
      ch[k] = j < 0 ? 0 : dry[j] + (dry[j + 1] - dry[j]) * (pos - j);
    }
  }
}

/** Auto-pan: the bus swings between the sides (suitcase electric piano). */
export function autopan(bus: Stereo, rate: number, depth: number): void {
  for (let k = 0; k < bus.l.length; k++) {
    const m = depth * Math.sin((TAU * rate * k) / SR);
    bus.l[k] *= 1 - m;
    bus.r[k] *= 1 + m;
  }
}

/** Vinyl surface: a soft hiss and random crackles, different on each side. */
export function vinyl(bus: Stereo, rand: Rand, crackles = 9): void {
  for (const ch of [bus.l, bus.r]) {
    const pop = new Svf(2500, 0.9);
    let hiss = 0;
    for (let k = 0; k < ch.length; k++) {
      hiss += 0.25 * (rand() * 2 - 1 - hiss);
      pop.run(rand() < crackles / SR ? (rand() < 0.5 ? -8 : 8) * (0.3 + 0.7 * rand()) : 0);
      ch[k] += 0.04 * hiss + pop.band;
    }
  }
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

/** Freeverb (Jezar at Dreampoint): 8 damped combs and 4 allpasses per side, the right side spread by 23 samples. */
export function reverb(input: Stereo, o: { room?: number; damp?: number; predelay?: number } = {}): Stereo {
  const { room = 0.8, damp = 0.4, predelay = 0.02 } = o;
  const n = input.l.length;
  const out = stereo(n);
  const pre = Math.round(predelay * SR);
  const feedback = room * 0.28 + 0.7;
  const d = damp * 0.4;
  const lowcut = new Biquad('highpass', 220);
  const mono = new Float32Array(n);
  for (let k = pre; k < n; k++) mono[k] = lowcut.run((input.l[k - pre] + input.r[k - pre]) * 0.015);
  for (const [side, spread] of [
    [out.l, 0],
    [out.r, 23],
  ] as const) {
    const combs = COMBS.map((size) => ({ buf: new Float32Array(size + spread), i: 0, store: 0 }));
    const passes = ALLPASSES.map((size) => ({ buf: new Float32Array(size + spread), i: 0 }));
    for (let k = 0; k < n; k++) {
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.store = y * (1 - d) + c.store * d;
        c.buf[c.i] = mono[k] + c.store * feedback;
        if (++c.i === c.buf.length) c.i = 0;
        acc += y;
      }
      for (const p of passes) {
        const b = p.buf[p.i];
        p.buf[p.i] = acc + b * 0.5;
        acc = b - acc;
        if (++p.i === p.buf.length) p.i = 0;
      }
      side[k] = acc;
    }
  }
  return out;
}

/** Ping-pong delay: echoes alternate left and right, each darker than the last. */
export function delay(input: Stereo, o: { time: number; feedback?: number; tone?: number }): Stereo {
  const { time, feedback = 0.35, tone = 3500 } = o;
  const n = input.l.length;
  const size = Math.max(1, Math.round(time * SR));
  const left = new Float32Array(size);
  const right = new Float32Array(size);
  const c = 1 - Math.exp((-TAU * tone) / SR);
  const lowcut = new Biquad('highpass', 250);
  const out = stereo(n);
  let i = 0;
  let fromLeft = 0;
  let fromRight = 0;
  for (let k = 0; k < n; k++) {
    const yl = left[i];
    const yr = right[i];
    fromLeft += c * (yl - fromLeft);
    fromRight += c * (yr - fromRight);
    left[i] = lowcut.run((input.l[k] + input.r[k]) * 0.5) + feedback * fromRight;
    right[i] = feedback * fromLeft;
    out.l[k] = yl;
    out.r[k] = yr;
    if (++i === size) i = 0;
  }
  return out;
}

// Mix and master

/** Integrated loudness (ITU-R BS.1770-4): K-weighting, 400 ms blocks every 100 ms, absolute and relative gates. */
export function loudness(bus: Stereo): number {
  const n = bus.l.length;
  const weighting = () => {
    const shelf = new Biquad('highshelf', 1681.974450955533, 0.7071752369554196, 3.999843853973347);
    const lowcut = new Biquad('highpass', 38.13547087602444, 0.5003270373238773);
    return (x: number) => lowcut.run(shelf.run(x));
  };
  const left = weighting();
  const right = weighting();
  // Running sum of the K-weighted power of both sides.
  const sum = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const l = left(bus.l[k]);
    const r = right(bus.r[k]);
    sum[k + 1] = sum[k] + l * l + r * r;
  }
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const powers: number[] = [];
  for (let s = 0; s + block <= n; s += hop) powers.push((sum[s + block] - sum[s]) / block);
  const lufs = (power: number) => -0.691 + 10 * Math.log10(power);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const loud = powers.filter((p) => p > 0 && lufs(p) > -70);
  if (!loud.length) return -Infinity;
  const relative = lufs(mean(loud)) - 10;
  return lufs(mean(loud.filter((p) => lufs(p) > relative)));
}

/** Gain that brings a bus to `lufs` (0 for a silent bus). */
function gainTo(bus: Stereo, lufs: number): number {
  const measured = loudness(bus);
  return Number.isFinite(measured) ? db(lufs - measured) : 0;
}

function add(into: Stereo, bus: Stereo, gain: number): void {
  for (let k = 0; k < into.l.length; k++) {
    into.l[k] += bus.l[k] * gain;
    into.r[k] += bus.r[k] * gain;
  }
}

export interface Track {
  bus: Stereo;
  /** Loudness of the bus on its own: the balance of the mix. */
  lufs: number;
  /** Sends, as a share of the bus. */
  reverb?: number;
  delay?: number;
}

/** Sums the tracks at their loudness, then the delay and reverb returns (the delay also feeds the reverb). */
export function mixdown(
  tracks: Track[],
  fx: {
    reverb?: { room?: number; damp?: number; predelay?: number; lufs: number };
    delay?: { time: number; feedback?: number; tone?: number; lufs: number };
  },
): Stereo {
  const n = tracks[0].bus.l.length;
  const out = stereo(n);
  const toReverb = stereo(n);
  const toDelay = stereo(n);
  for (const track of tracks) {
    const gain = gainTo(track.bus, track.lufs);
    add(out, track.bus, gain);
    if (track.reverb) add(toReverb, track.bus, gain * track.reverb);
    if (track.delay) add(toDelay, track.bus, gain * track.delay);
  }
  if (fx.delay) {
    const echoes = delay(toDelay, fx.delay);
    const gain = gainTo(echoes, fx.delay.lufs);
    add(out, echoes, gain);
    add(toReverb, echoes, gain * 0.5);
  }
  if (fx.reverb) {
    const tail = reverb(toReverb, fx.reverb);
    add(out, tail, gainTo(tail, fx.reverb.lufs));
  }
  return out;
}

/** Look-ahead peak limiter: the gain glides down before each peak, never lets a sample past `ceiling`. */
function limit(bus: Stereo, ceiling: number, lookahead = 0.005, release = 0.06): void {
  const n = bus.l.length;
  const w = Math.max(1, Math.round(lookahead * SR));
  const need = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const peak = Math.max(Math.abs(bus.l[k]), Math.abs(bus.r[k]));
    need[k] = peak > ceiling ? ceiling / peak : 1;
  }
  // Smallest gain needed over the next w samples: a monotonic queue, scanning backwards.
  const ahead = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = n - 1; k >= 0; k--) {
    while (tail > head && need[queue[tail - 1]] >= need[k]) tail--;
    queue[tail++] = k;
    while (queue[head] > k + w) head++;
    ahead[k] = need[queue[head]];
  }
  // Averaged over the last w samples, the gain is down before the peak arrives and at most what the peak needs.
  const c = 1 - Math.exp(-1 / (release * SR));
  let sum = w;
  let gain = 1;
  for (let k = 0; k < n; k++) {
    sum += ahead[k] - (k >= w ? ahead[k - w] : 1);
    const target = sum / w;
    gain = target < gain ? target : gain + (target - gain) * c;
    bus.l[k] *= gain;
    bus.r[k] *= gain;
  }
}

/** Fades in over 3 ms and out over the last `seconds`, so the file starts and ends on silence. */
export function fade(bus: Stereo, seconds: number): void {
  const n = bus.l.length;
  const tail = Math.round(seconds * SR);
  for (let k = 0; k < n; k++) {
    const g = Math.min(1, k / (0.003 * SR), 0.5 + 0.5 * Math.cos((Math.PI * Math.max(0, k - (n - tail))) / tail));
    bus.l[k] *= g;
    bus.r[k] *= g;
  }
}

/** Masters in place: rumble cut, gain to `lufs`, peaks held under `ceiling` dBFS. Returns the measured result. */
export function master(mix: Stereo, o: { lufs?: number; ceiling?: number } = {}): { lufs: number; peak: number } {
  const { lufs = -16, ceiling = -1.5 } = o;
  eq(mix, 'highpass', 30);
  const dry = { l: Float32Array.from(mix.l), r: Float32Array.from(mix.r) };
  let gain = gainTo(dry, lufs);
  let measured = -Infinity;
  // Limiting lowers the loudness a little: correct the gain and limit again.
  for (let pass = 0; pass < 4 && Math.abs(measured - lufs) > 0.1; pass++) {
    for (let k = 0; k < dry.l.length; k++) {
      mix.l[k] = dry.l[k] * gain;
      mix.r[k] = dry.r[k] * gain;
    }
    limit(mix, db(ceiling));
    measured = loudness(mix);
    gain *= db(lufs - measured);
  }
  let peak = 0;
  for (let k = 0; k < mix.l.length; k++) peak = Math.max(peak, Math.abs(mix.l[k]), Math.abs(mix.r[k]));
  return { lufs: measured, peak: 20 * Math.log10(peak) };
}

/** Encodes to AAC in an .m4a with ffmpeg, bit-exact so that regenerating an unchanged preset changes no byte. */
export function encode(bus: Stereo, file: string, ffmpeg: string): void {
  const pcm = new Float32Array(bus.l.length * 2);
  for (let k = 0; k < bus.l.length; k++) {
    pcm[2 * k] = bus.l[k];
    pcm[2 * k + 1] = bus.r[k];
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', 'pipe:0'];
  args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-fflags', '+bitexact', '-flags:a', '+bitexact', file);
  const res = spawnSync(ffmpeg, args, { input: Buffer.from(pcm.buffer), maxBuffer: 1 << 24 });
  if (res.status !== 0) throw new Error(m().media.music.encodeFailed(file, res.stderr?.toString() || res.error?.message));
}
