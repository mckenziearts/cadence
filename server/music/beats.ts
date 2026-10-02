// Adapted from saeedvaziry/caleb-video-editor (MIT)
// Tempo estimation (pulse-train contrast), dynamic-programming beat tracking
// (Ellis 2007), and piecewise constant-grid fitting with millisecond phase
// refinement against time-domain attacks.

import type { Features } from './features';

export interface BeatTrack {
  bpm: number;
  /** Beat times in seconds. */
  beats: number[];
  /** 0..1: share of the beats that follow a constant grid × share of grid beats that land on an onset. */
  confidence: number;
  /** Seconds per beat. */
  period: number;
  /** Music-present region in seconds. */
  activeStart: number;
  activeEnd: number;
}

/** Frame-level onsets peak a little before the attack; used when no fine refinement is possible. */
const FRAME_BIAS_S = 0.012;

// small numeric helpers

export function mean(a: ArrayLike<number>, from = 0, to = a.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return to > from ? s / (to - from) : 0;
}

export function std(a: ArrayLike<number>): number {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : 0;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, (p / 100) * (s.length - 1)));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Linear interpolation into an array sampled on integer indices. */
function sampleAt(a: Float64Array, x: number): number {
  if (x <= 0) return a[0] ?? 0;
  const i = Math.floor(x);
  if (i >= a.length - 1) return a[a.length - 1] ?? 0;
  const f = x - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

function gaussianSmooth(a: Float64Array, sigma: number): Float64Array {
  if (sigma <= 0) return Float64Array.from(a);
  const r = Math.ceil(3 * sigma);
  const k: number[] = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2);
    k.push(v);
    ks += v;
  }
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < a.length) acc += a[idx] * k[j + r];
    }
    out[i] = acc / ks;
  }
  return out;
}

// onset envelope & active region

/** Local-mean-subtracted, half-wave-rectified copy of `x`, normalized to unit standard deviation. */
function emphasize(x: Float64Array, fps: number): Float64Array {
  const n = x.length;
  const w = Math.max(1, Math.round(0.1 * fps));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const v = x[i] - (prefix[b] - prefix[a]) / (b - a);
    out[i] = v > 0 ? v : 0;
  }
  const s = std(out) || 1;
  for (let i = 0; i < n; i++) out[i] /= s;
  return out;
}

/**
 * Beat-oriented onset envelope: the full-band flux mixed with a band-weighted
 * version where kick (low), snare/keys (mid) and hats (high) are normalized
 * separately, so dense hi-hats cannot drown out the kick/snare pattern.
 */
export function onsetEnvelope(f: Features): Float64Array {
  const full = emphasize(f.flux, f.fps);
  const low = emphasize(f.lowFlux, f.fps);
  const mid = emphasize(f.midFlux, f.fps);
  const high = emphasize(f.highFlux, f.fps);
  const n = f.frameCount;
  const band = new Float64Array(n);
  for (let i = 0; i < n; i++) band[i] = low[i] + mid[i] + 0.5 * high[i];
  const bs = std(band) || 1;
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = 0.5 * (full[i] + band[i] / bs);
  const s = std(env) || 1;
  for (let i = 0; i < n; i++) env[i] /= s;
  return env;
}

/** First/last time the signal is clearly above the noise floor. */
export function activeRegion(f: Features): { start: number; end: number } {
  const db = Array.from(f.rmsDb);
  const loud = percentile(db, 95);
  const typical = percentile(db, 50);
  const threshold = Math.max(loud - 40, typical - 30, -70);
  const minRun = Math.max(1, Math.round(0.05 * f.fps));
  let start = -1;
  for (let i = 0, run = 0; i < db.length; i++) {
    run = db[i] > threshold ? run + 1 : 0;
    if (run >= minRun) {
      start = i - minRun + 1;
      break;
    }
  }
  let end = -1;
  for (let i = db.length - 1, run = 0; i >= 0; i--) {
    run = db[i] > threshold ? run + 1 : 0;
    if (run >= minRun) {
      end = i + minRun - 1;
      break;
    }
  }
  if (start < 0 || end < 0) return { start: 0, end: 0 };
  return { start: start / f.fps, end: Math.min(db.length - 1, end) / f.fps };
}

// tempo

export interface TempoEstimate {
  bpm: number;
  /** Beat period in onset frames (fractional). */
  period: number;
}

const TEMPO_PRIOR_OCTAVES = 0.7;
const tempoPrior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 120) / TEMPO_PRIOR_OCTAVES) ** 2);

/** Best pulse-train phase within [from, to) for `period` (frames), with its mean and the mean over phases. */
function pulseAlignment(env: Float64Array, period: number, from: number, to: number) {
  const steps = Math.max(8, Math.round(period));
  let best = -Infinity;
  let bestPhase = from;
  let total = 0;
  for (let s = 0; s < steps; s++) {
    const phase = from + (s * period) / steps;
    let acc = 0;
    let count = 0;
    for (let x = phase; x < to; x += period) {
      acc += sampleAt(env, x);
      count++;
    }
    const m = count ? acc / count : 0;
    total += m;
    if (m > best) {
      best = m;
      bestPhase = phase;
    }
  }
  return { best, bestPhase, average: total / steps };
}

/** Segments of ~20 s (50% overlap) covering the envelope. */
function segments(length: number, fps: number): [number, number][] {
  const seg = Math.round(20 * fps);
  if (length <= seg) return [[0, length - 1]];
  const out: [number, number][] = [];
  for (let s0 = 0; s0 < length - 1; s0 += seg / 2) {
    const s1 = Math.min(length - 1, s0 + seg);
    out.push([s0, s1]);
    if (s1 >= length - 1) break;
  }
  return out;
}

/**
 * Tempo by pulse-train contrast: for each candidate tempo, how much better the
 * best-aligned beat grid hits onsets than a randomly placed one, averaged over
 * ~20 s windows (robust to drift and to 3:2 / 4:3 confusions), times a
 * log-Gaussian preference around 120 BPM. A half-tempo reading is doubled when
 * the snare lands between the beats (it is then the backbeat of the faster tempo),
 * a double-tempo reading is halved when nothing happens between its beats and they alternate strong and weak.
 */
export function estimateTempo(env: Float64Array, fps: number, snareEnv?: Float64Array): TempoEstimate {
  const smooth = gaussianSmooth(env, 1);
  const segs = segments(smooth.length, fps);
  const contrast = (bpm: number) => {
    const period = (60 * fps) / bpm;
    let acc = 0;
    for (const [a, b] of segs) {
      const r = pulseAlignment(smooth, period, a, b);
      acc += r.best - r.average;
    }
    return acc / segs.length;
  };
  let best = { bpm: 120, score: -Infinity };
  for (let bpm = 60; bpm <= 200; bpm *= 1.004) {
    const score = contrast(bpm) * tempoPrior(bpm);
    if (score > best.score) best = { bpm, score };
  }
  // Fine refinement around the winner.
  const center = best.bpm;
  for (let i = -20; i <= 20; i++) {
    const bpm = center * (1 + i * 0.0002);
    const score = contrast(bpm) * tempoPrior(bpm);
    if (score > best.score) best = { bpm, score };
  }
  /** Mean of `signal` halfway between the beats relative to on them, at each segment's best phase for `bpm`. */
  const offbeatRatio = (bpm: number, signal: Float64Array) => {
    const period = (60 * fps) / bpm;
    let onBeat = 0;
    let between = 0;
    for (const [a, b] of segs) {
      const { bestPhase } = pulseAlignment(smooth, period, a, b);
      for (let x = bestPhase; x < b; x += period) {
        onBeat += sampleAt(signal, x);
        between += sampleAt(signal, x + period / 2);
      }
    }
    return onBeat > 0 ? between / onBeat : 0;
  };
  let bpm = best.bpm;
  // Half-tempo reading: the loud backbeat snare falls halfway between the beats (drum & bass read at 86 instead
  // of 172). Linear power, so quiet hats and ghost notes between the beats do not count.
  if (snareEnv && bpm < 100 && offbeatRatio(bpm, gaussianSmooth(snareEnv, 1)) >= 0.3) bpm *= 2;
  // Double-tempo reading: nothing at all happens between the beats and they alternate strong and weak, so the grid
  // counts eighths (a 72 BPM groove with eighth hats read at 144). A uniform pulse (metronome, four-on-the-floor kick)
  // is the tempo itself: halving it measures 0.9-1.0 between the beats, an alternating groove 0.35-0.61.
  // Readings under 140 are never halved (grooves under 70 BPM read double), and a 140+ kick with a backbeat and nothing
  // between the beats still reads half: the editor's tempo override fixes both.
  else if (bpm / 2 >= 70 && offbeatRatio(bpm, smooth) < 0.05 && offbeatRatio(bpm / 2, smooth) < 0.75) bpm /= 2;
  return { bpm, period: (60 * fps) / bpm };
}

// dynamic-programming beat tracker

/** Returns beat positions as (integer) onset-frame indices. */
export function trackBeatFrames(env: Float64Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (n === 0) return [];
  // Local score: onset envelope smoothed by a Gaussian of width period/32.
  const r = Math.round(period);
  const win: number[] = [];
  for (let k = -r; k <= r; k++) win.push(Math.exp(-0.5 * ((k * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) {
      const j = i - k;
      if (j >= 0 && j < n) acc += win[k + r] * env[j];
    }
    local[i] = acc;
  }
  let localMax = 0;
  for (let i = 0; i < n; i++) if (local[i] > localMax) localMax = local[i];

  const minBack = Math.max(1, Math.round(period / 2));
  const maxBack = Math.max(minBack, Math.round(2 * period));
  const txwt = new Float64Array(maxBack + 1);
  for (let d = minBack; d <= maxBack; d++) txwt[d] = -tightness * Math.log(d / period) ** 2;

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let firstBeat = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bestIdx = -1;
    for (let d = minBack; d <= maxBack; d++) {
      const k = i - d;
      // Reaching back before time 0 counts as a zero-score predecessor.
      const s = (k >= 0 ? cum[k] : 0) + txwt[d];
      if (s > best) {
        best = s;
        bestIdx = k;
      }
    }
    cum[i] = local[i] + best;
    if (firstBeat && local[i] < 0.01 * localMax) {
      back[i] = -1;
    } else {
      back[i] = bestIdx;
      firstBeat = false;
    }
  }

  // Last beat: the last local maximum of the cumulative score above half the median peak.
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = i > 0 ? cum[i - 1] : -Infinity;
    const rr = i < n - 1 ? cum[i + 1] : -Infinity;
    if (cum[i] > l && cum[i] >= rr) peaks.push(i);
  }
  if (peaks.length === 0) return [];
  const med = median(peaks.map((i) => cum[i]));
  let last = peaks[peaks.length - 1];
  for (let j = peaks.length - 1; j >= 0; j--) {
    if (cum[peaks[j]] * 2 > med) {
      last = peaks[j];
      break;
    }
  }

  const beats: number[] = [last];
  while (back[beats[beats.length - 1]] >= 0) beats.push(back[beats[beats.length - 1]]);
  beats.reverse();

  // Trim weak leading/trailing beats.
  const bl = beats.map((b) => local[b]);
  const hannW = [0.25, 0.75, 1, 0.75, 0.25];
  const smooth = bl.map((_, i) => {
    let acc = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < bl.length) acc += bl[j] * hannW[k + 2];
    }
    return acc;
  });
  const threshold = 0.5 * Math.sqrt(mean(smooth.map((v) => v * v)));
  let a = 0;
  while (a < beats.length && smooth[a] <= threshold) a++;
  let b = beats.length - 1;
  while (b > a && smooth[b] <= threshold) b--;
  return beats.slice(a, b + 1);
}

// fine timing refinement against the 1 kHz attack function

/** Dilated, lightly smoothed attack function used for millisecond alignment. */
function attackScore(transient: Float64Array): Float64Array {
  const smooth = gaussianSmooth(transient, 1.5);
  const out = new Float64Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) {
    let v = smooth[i];
    if (i > 0 && smooth[i - 1] > v) v = smooth[i - 1];
    if (i < smooth.length - 1 && smooth[i + 1] > v) v = smooth[i + 1];
    out[i] = v;
  }
  return out;
}

interface Offset {
  shift: number;
  confident: boolean;
}

/**
 * Best common time shift (seconds, within ±`range`) that aligns `times` with
 * attack peaks. Only trusted when the peak clearly beats the average shift.
 */
function bestShift(times: number[], attack: Float64Array, range = 0.035): Offset {
  const steps = Math.round(range * 1000);
  const scores: number[] = [];
  for (let s = -steps; s <= steps; s++) {
    let acc = 0;
    for (const t of times) {
      const idx = Math.round(t * 1000) + s;
      if (idx >= 0 && idx < attack.length) acc += attack[idx];
    }
    scores.push(acc);
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const m = mean(scores);
  const sd = std(scores);
  const confident = sd > 0 && scores[best] > m + 2 * sd && scores[best] > 1.15 * m;
  return { shift: (best - steps) / 1000, confident };
}

// grid fitting

interface GridFit {
  period: number;
  /** A grid time near the middle of the beats (anchor for t_k = anchor + k * period). */
  anchor: number;
  medianResidual: number;
  p90Residual: number;
}

function fitGrid(times: number[], approxPeriod: number): GridFit {
  const idx: number[] = [0];
  for (let j = 1; j < times.length; j++) {
    idx.push(idx[j - 1] + Math.max(1, Math.round((times[j] - times[j - 1]) / approxPeriod)));
  }
  const n = times.length;
  const mi = mean(idx);
  const mt = mean(times);
  let sxy = 0;
  let sxx = 0;
  for (let j = 0; j < n; j++) {
    sxy += (idx[j] - mi) * (times[j] - mt);
    sxx += (idx[j] - mi) ** 2;
  }
  const period = sxx > 0 ? sxy / sxx : approxPeriod;
  const t0 = mt - period * mi;
  const residuals = times.map((t, j) => Math.abs(t - (t0 + period * idx[j])));
  const midIdx = Math.round(mi);
  return {
    period,
    anchor: t0 + period * midIdx,
    medianResidual: median(residuals),
    p90Residual: percentile(residuals, 90),
  };
}

/** Refine (period, anchor) by maximizing onset strength at grid points. */
function refineGrid(
  fit: GridFit,
  env: Float64Array,
  fps: number,
  region: { start: number; end: number },
): { period: number; anchor: number } {
  const smooth = gaussianSmooth(env, 1);
  const kMin = Math.ceil((region.start - fit.anchor) / fit.period);
  const kMax = Math.floor((region.end - fit.anchor) / fit.period);
  const score = (period: number, anchor: number) => {
    let acc = 0;
    for (let k = kMin; k <= kMax; k++) acc += sampleAt(smooth, (anchor + k * period) * fps);
    return acc;
  };
  let best = { period: fit.period, anchor: fit.anchor, s: score(fit.period, fit.anchor) };
  // Coarse-to-fine search around the least-squares fit.
  for (const [pSpan, pSteps, aSpan, aSteps] of [
    [0.004, 16, 0.2, 40],
    [0.0008, 16, 0.02, 20],
  ] as const) {
    const center = { ...best };
    for (let i = -pSteps; i <= pSteps; i++) {
      const period = center.period * (1 + (pSpan * i) / pSteps);
      for (let j = -aSteps; j <= aSteps; j++) {
        const anchor = center.anchor + (aSpan * center.period * j) / aSteps;
        const s = score(period, anchor);
        if (s > best.s) best = { period, anchor, s };
      }
    }
  }
  return { period: best.period, anchor: best.anchor };
}

const attackCache = new WeakMap<Features, Float64Array>();

function attackFor(f: Features): Float64Array {
  let attack = attackCache.get(f);
  if (!attack) {
    attack = attackScore(f.transient);
    attackCache.set(f, attack);
  }
  return attack;
}

/** Move an onset time (from the frame grid) onto the nearest clear attack within ±range. */
export function refineToAttack(f: Features, t: number, range = 0.03): number {
  const r = bestShift([t], attackFor(f), range);
  return r.confident ? t + r.shift : t + FRAME_BIAS_S;
}

function isSteady(fit: GridFit, count: number): boolean {
  return (
    count >= 8 && fit.medianResidual < Math.min(0.01, 0.04 * fit.period) && fit.p90Residual < Math.min(0.025, 0.08 * fit.period)
  );
}

interface Run {
  from: number;
  to: number;
  steady: boolean;
}

/**
 * Split DP beats into runs that each follow a constant grid (tempo changes,
 * edits and phase jumps start a new run). Split points minimize the summed
 * squared error of two line fits, computed in O(1) with prefix sums.
 */
function steadyRuns(times: number[], approx: number): Run[] {
  const n = times.length;
  const idx: number[] = [0];
  for (let j = 1; j < n; j++) idx.push(idx[j - 1] + Math.max(1, Math.round((times[j] - times[j - 1]) / approx)));
  const sx = new Float64Array(n + 1);
  const sy = new Float64Array(n + 1);
  const sxx = new Float64Array(n + 1);
  const sxy = new Float64Array(n + 1);
  const syy = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) {
    const x = idx[j];
    const y = times[j];
    sx[j + 1] = sx[j] + x;
    sy[j + 1] = sy[j] + y;
    sxx[j + 1] = sxx[j] + x * x;
    sxy[j + 1] = sxy[j] + x * y;
    syy[j + 1] = syy[j] + y * y;
  }
  const sse = (a: number, b: number) => {
    const m = b - a;
    const X = sx[b] - sx[a];
    const Y = sy[b] - sy[a];
    const cxx = sxx[b] - sxx[a] - (X * X) / m;
    const cxy = sxy[b] - sxy[a] - (X * Y) / m;
    const cyy = syy[b] - syy[a] - (Y * Y) / m;
    return cxx > 0 ? Math.max(0, cyy - (cxy * cxy) / cxx) : 0;
  };
  const MIN = 16;
  const runs: Run[] = [];
  const visit = (a: number, b: number, depth: number) => {
    const fit = fitGrid(times.slice(a, b), approx);
    if (isSteady(fit, b - a)) {
      runs.push({ from: a, to: b, steady: true });
      return;
    }
    if (b - a < 2 * MIN || depth >= 6) {
      runs.push({ from: a, to: b, steady: false });
      return;
    }
    let split = -1;
    let cost = Infinity;
    for (let s = a + MIN; s <= b - MIN; s++) {
      const c = sse(a, s) + sse(s, b);
      if (c < cost) {
        cost = c;
        split = s;
      }
    }
    visit(a, split, depth + 1);
    visit(split, b, depth + 1);
  };
  visit(0, n, 0);
  return runs;
}

/**
 * Constant grid for one steady run: onset-envelope search, then millisecond
 * alignment to attacks and a robust re-fit on per-beat attacks. Returns the
 * grid beats in [start, end).
 */
function gridForRun(
  times: number[],
  approx: number,
  start: number,
  end: number,
  env: Float64Array,
  attack: Float64Array,
  fps: number,
): { beats: number[]; period: number } {
  const fit = fitGrid(times, approx);
  let { period, anchor } = refineGrid(fit, env, fps, { start, end });
  const gridTimes = (p: number, a: number) => {
    const out: number[] = [];
    const kMin = Math.ceil((start - a) / p);
    const kMax = Math.ceil((end - a) / p) - 1;
    for (let k = kMin; k <= kMax; k++) out.push(a + k * p);
    return out;
  };

  // Millisecond refinement of phase (and a hair of period) against attacks.
  let bestShiftResult = bestShift(gridTimes(period, anchor), attack);
  let bestPeriod = period;
  for (let i = -10; i <= 10; i++) {
    if (i === 0) continue;
    const p = period * (1 + i * 0.00005);
    const r = bestShift(gridTimes(p, anchor), attack);
    if (
      r.confident &&
      (!bestShiftResult.confident ||
        scoreShift(gridTimes(p, anchor + r.shift), attack) >
          scoreShift(gridTimes(bestPeriod, anchor + bestShiftResult.shift), attack))
    ) {
      bestShiftResult = r;
      bestPeriod = p;
    }
  }
  if (bestShiftResult.confident) {
    period = bestPeriod;
    anchor += bestShiftResult.shift;
  } else {
    anchor += FRAME_BIAS_S;
  }

  // Robust least-squares re-fit on each beat's own attack: removes the small
  // period error that otherwise accumulates towards the ends of long runs.
  const grid = gridTimes(period, anchor);
  const ks: number[] = [];
  const ts: number[] = [];
  grid.forEach((t, k) => {
    const r = bestShift([t], attack, 0.025);
    if (r.confident) {
      ks.push(k);
      ts.push(t + r.shift);
    }
  });
  if (ts.length >= Math.max(8, grid.length * 0.4)) {
    let line = lineFit(ks, ts);
    const res = ks.map((k, i) => Math.abs(ts[i] - (line.intercept + line.slope * k)));
    const limit = Math.max(0.006, 3 * median(res));
    const keepK = ks.filter((_, i) => res[i] <= limit);
    const keepT = ts.filter((_, i) => res[i] <= limit);
    if (keepT.length >= 8) {
      line = lineFit(keepK, keepT);
      if (Math.abs(line.slope / period - 1) < 0.002) {
        period = line.slope;
        anchor = line.intercept;
      }
    }
  }
  return { beats: gridTimes(period, anchor), period };
}

export function trackBeats(f: Features, env: Float64Array = onsetEnvelope(f)): BeatTrack {
  const region = activeRegion(f);
  const tempo = estimateTempo(env, f.fps, f.midRise);
  const frames = trackBeatFrames(env, tempo.period);
  const attack = attackFor(f);

  if (frames.length < 2 || region.end <= region.start) {
    return {
      bpm: Math.round(tempo.bpm * 100) / 100,
      beats: frames.map((i) => round4(i / f.fps + FRAME_BIAS_S)),
      confidence: 0,
      period: 60 / tempo.bpm,
      activeStart: region.start,
      activeEnd: region.end,
    };
  }

  const dpTimes = frames.map((i) => i / f.fps);
  const approx = tempo.period / f.fps;
  const runs = steadyRuns(dpTimes, approx);
  const beats: number[] = [];
  let longest: { length: number; period: number } | null = null;

  runs.forEach((run, r) => {
    const times = dpTimes.slice(run.from, run.to);
    if (run.steady) {
      // Runs meet halfway between their neighbouring DP beats; the outer runs
      // extend to where the music starts (the level threshold trails a soft
      // first attack by a frame or two, hence the margin) and ends.
      const start = r === 0 ? region.start - 0.05 : (dpTimes[run.from - 1] + dpTimes[run.from]) / 2;
      const end = r === runs.length - 1 ? region.end + 1e-3 : (dpTimes[run.to - 1] + dpTimes[run.to]) / 2;
      const grid = gridForRun(times, approx, start, end, env, attack, f.fps);
      beats.push(...grid.beats);
      if (!longest || run.to - run.from > longest.length) longest = { length: run.to - run.from, period: grid.period };
    } else {
      // Tempo varies here: keep DP beats, nudging each one onto its nearest attack.
      for (const t of times) {
        if (t < region.start - 0.05 || t > region.end + 0.05) continue;
        const res = bestShift([t], attack, 0.03);
        beats.push(res.confident ? t + res.shift : t + FRAME_BIAS_S);
      }
    }
  });

  const clean = beats.filter((t) => t >= 0).sort((a, b) => a - b);
  const ibi = median(clean.slice(1).map((t, i) => t - clean[i])) || approx;
  const period = (longest as { length: number; period: number } | null)?.period ?? ibi;
  // Confidence: share of the DP beats that follow a constant grid × share of the grid beats inside the music that
  // land on an onset (the envelope has unit standard deviation), so a grid extrapolated over pads scores low.
  const steadyBeats = runs.reduce((n, run) => n + (run.steady ? run.to - run.from : 0), 0);
  const inside = clean.filter((t) => t >= region.start && t <= region.end);
  const onOnset = inside.filter((t) => {
    const c = Math.round(t * f.fps);
    for (let i = Math.max(0, c - 2); i <= Math.min(env.length - 1, c + 2); i++) if (env[i] > 1) return true;
    return false;
  }).length;
  return {
    bpm: Math.round((60 / period) * 100) / 100,
    beats: clean.map(round4),
    confidence: inside.length ? Math.round((steadyBeats / dpTimes.length) * (onOnset / inside.length) * 100) / 100 : 0,
    period,
    activeStart: region.start,
    activeEnd: region.end,
  };
}

function lineFit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

function scoreShift(times: number[], attack: Float64Array): number {
  let acc = 0;
  for (const t of times) {
    const idx = Math.round(t * 1000);
    if (idx >= 0 && idx < attack.length) acc += attack[idx];
  }
  return acc;
}

function round4(t: number): number {
  return Math.round(t * 10000) / 10000;
}
