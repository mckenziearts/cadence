// Adapted from saeedvaziry/caleb-video-editor (MIT)
// Bar/phrase/section structure, accents and waveform on top of the beat grid.

import type { Features } from './features';
import { mean, median, percentile, std } from './beats';

export const BEATS_PER_BAR = 4;

function zscore(values: number[]): number[] {
  const m = mean(values);
  const s = std(values) || 1;
  return values.map((v) => (v - m) / s);
}

/** Total rise around `center`: unlike the peak, it does not depend on where the attack falls between two frames. */
function sumInWindow(a: Float64Array, center: number, before: number, after: number): number {
  let v = 0;
  for (let i = Math.max(0, center - before); i <= Math.min(a.length - 1, center + after); i++) v += a[i];
  return v;
}

/** Mean chroma over [t0, t1). */
function chromaMean(f: Features, t0: number, t1: number): Float64Array {
  const out = new Float64Array(12);
  const a = Math.max(0, Math.floor(t0 * f.chromaFps));
  const b = Math.min(f.chroma.length, Math.max(a + 1, Math.ceil(t1 * f.chromaFps)));
  for (let i = a; i < b; i++) for (let k = 0; k < 12; k++) out[k] += f.chroma[i][k];
  return out;
}

function cosineDistance(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < 1e-12 || nb < 1e-12) return 0;
  return 1 - dot / Math.sqrt(na * nb);
}

// meter & downbeats

/**
 * Per-beat evidence that a bar starts there: a kick (low attack) that is not a snare (mid attack), a harmonic
 * change and, lightly, overall onset strength. Attacks mix the dB rise (catches hits after a gap) with the
 * linear power rise (weights loud hits over quiet leaks), each z-scored across the track.
 */
function downbeatSalience(beats: number[], f: Features): number[] {
  const period = median(beats.slice(1).map((t, i) => t - beats[i]));
  const kickDb: number[] = [];
  const kickPower: number[] = [];
  const snareDb: number[] = [];
  const snarePower: number[] = [];
  const onset: number[] = [];
  const harmonic: number[] = [];
  for (const t of beats) {
    const frame = Math.min(f.frameCount - 1, Math.round(t * f.fps));
    kickDb.push(sumInWindow(f.lowFlux, frame, 3, 3));
    kickPower.push(f.lowRise[frame]);
    snareDb.push(sumInWindow(f.midFlux, frame, 3, 3));
    snarePower.push(f.midRise[frame]);
    onset.push(sumInWindow(f.flux, frame, 3, 3));
    harmonic.push(cosineDistance(chromaMean(f, t - 2 * period, t), chromaMean(f, t, t + 2 * period)));
  }
  const [zkd, zkp, zsd, zsp, zo, zh] = [kickDb, kickPower, snareDb, snarePower, onset, harmonic].map(zscore);
  return beats.map((_, i) => 0.5 * (zkd[i] + zkp[i]) - 0.4 * (zsd[i] + zsp[i]) + zh[i] + 0.2 * zo[i]);
}

/** Mean salience per bar position, the best position, and how much it stands out from the others. */
function phaseContrast(salience: number[], beatsPerBar: number): { phase: number; contrast: number } {
  const sums = new Array(beatsPerBar).fill(0);
  const counts = new Array(beatsPerBar).fill(0);
  salience.forEach((s, i) => {
    sums[i % beatsPerBar] += s;
    counts[i % beatsPerBar]++;
  });
  const means = sums.map((s, p) => s / Math.max(1, counts[p]));
  let phase = 0;
  for (let p = 1; p < beatsPerBar; p++) if (means[p] > means[phase]) phase = p;
  return { phase, contrast: means[phase] - mean(means.filter((_, p) => p !== phase)) };
}

/**
 * Bars of 3 or 4 beats, and the index of the first beat that starts a bar. The right meter makes one bar position
 * stand out; most music is in 4, so 3 has to win clearly.
 */
export function detectMeter(beats: number[], f: Features): { beatsPerBar: number; phase: number } {
  if (beats.length < 8) return { beatsPerBar: BEATS_PER_BAR, phase: 0 };
  const salience = downbeatSalience(beats, f);
  const four = phaseContrast(salience, 4);
  const three = phaseContrast(salience, 3);
  if (beats.length >= 12 && three.contrast > 2 * four.contrast) return { beatsPerBar: 3, phase: three.phase };
  return { beatsPerBar: 4, phase: four.phase };
}

// bar features & novelty

function barFeatures(f: Features, bars: number[], barEnd: (k: number) => number): number[][] {
  const bands = 12;
  const per = Math.floor(f.melBands / bands);
  const rows: number[][] = [];
  for (let k = 0; k < bars.length; k++) {
    const t0 = bars[k];
    const t1 = barEnd(k);
    const a = Math.max(0, Math.floor(t0 * f.fps));
    const b = Math.min(f.frameCount, Math.max(a + 1, Math.ceil(t1 * f.fps)));
    const mel = new Array(bands).fill(0);
    let rms = 0;
    let flux = 0;
    for (let i = a; i < b; i++) {
      const row = f.melDb[i];
      for (let j = 0; j < bands; j++) {
        let acc = 0;
        for (let q = 0; q < per; q++) acc += row[j * per + q];
        mel[j] += acc / per;
      }
      rms += f.rmsDb[i];
      flux += f.flux[i];
    }
    const count = b - a;
    const chroma = chromaMean(f, t0, t1);
    let cn = 0;
    for (let i = 0; i < 12; i++) cn += chroma[i] * chroma[i];
    cn = Math.sqrt(cn) || 1;
    rows.push([...mel.map((v) => v / count), ...Array.from(chroma, (v) => v / cn), rms / count, flux / count]);
  }
  // z-normalize each dimension across bars; weight the groups.
  const dims = rows[0]?.length ?? 0;
  const weights = [...new Array(bands).fill(0.9), ...new Array(12).fill(0.7), 2.0, 1.5];
  for (let d = 0; d < dims; d++) {
    const col = rows.map((r) => r[d]);
    const m = mean(col);
    const s = std(col) || 1;
    for (const r of rows) r[d] = ((r[d] - m) / s) * weights[d];
  }
  return rows;
}

/**
 * Novelty at each bar boundary j (between bar j-1 and bar j): feature distance
 * between the bars before and after, at 4- and 2-bar scales (full windows only,
 * each scale normalized by its median so edges are judged like the middle),
 * plus a term for big loudness changes.
 */
function barNovelty(rows: number[][], barDb: number[]): number[] {
  const n = rows.length;
  const dist = (a: number[], b: number[]) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
    return Math.sqrt(s);
  };
  const avg = (from: number, to: number) => {
    const out = new Array(rows[0].length).fill(0);
    for (let k = from; k < to; k++) for (let d = 0; d < out.length; d++) out[d] += rows[k][d];
    return out.map((v) => v / (to - from));
  };
  const scales: { w: number; vals: (number | null)[] }[] = [];
  for (const [K, w] of [
    [4, 0.6],
    [2, 0.4],
  ] as const) {
    const vals: (number | null)[] = new Array(n).fill(null);
    for (let j = 1; j < n; j++) {
      const k = Math.min(K, j, n - j);
      if (k === K) vals[j] = dist(avg(j - K, j), avg(j, j + K));
      // At the very ends only one bar of context exists on one side; damp it.
      else if (K === 2 && k === 1) vals[j] = 0.75 * dist(avg(j - 1, j), avg(j, j + 1));
    }
    const med = median(vals.filter((v): v is number => v !== null)) || 1;
    scales.push({ w, vals: vals.map((v) => (v === null ? null : v / med)) });
  }
  const nov = new Array(n).fill(0);
  for (let j = 1; j < n; j++) {
    let total = 0;
    let weight = 0;
    for (const { w, vals } of scales) {
      const v = vals[j];
      if (v !== null) {
        total += w * v;
        weight += w;
      }
    }
    nov[j] = weight > 0 ? total / weight : 0;
    // Big level changes (intro to drop, breakdowns, fade-outs) are section changes.
    const k = Math.min(2, j, n - j);
    const before = mean(barDb.slice(j - k, j));
    const after = mean(barDb.slice(j, j + k));
    nov[j] += (Math.abs(after - before) / 3) * (k >= 2 ? 1 : 0.75);
  }
  return nov;
}

export interface Structure {
  phrases: number[];
  phraseBars: number;
  sections: { start: number; end: number; label: string; energy: number }[];
}

export function analyzeStructure(f: Features, downbeats: number[], barSeconds: number, duration: number): Structure {
  if (downbeats.length < 4) {
    return {
      phrases: downbeats.slice(0, 1),
      phraseBars: 4,
      sections: [{ start: 0, end: duration, label: 'A', energy: sectionEnergy(f, 0, duration, f.rmsDb) }],
    };
  }
  const barEnd = (k: number) => (k + 1 < downbeats.length ? downbeats[k + 1] : Math.min(duration, downbeats[k] + barSeconds));
  const rows = barFeatures(f, downbeats, barEnd);
  const barDb = downbeats.map((t, k) => sectionEnergy(f, t, barEnd(k), f.rmsDb));
  const nov = barNovelty(rows, barDb);
  const B = downbeats.length;

  // --- phrase grid: 4 or 8 bars, phase-aligned to the strongest boundaries
  // Squared novelty so one big boundary (e.g. intro to drop) outweighs many small ones.
  const phaseScore = (L: number, psi: number) => {
    let acc = 0;
    let count = 0;
    // Endings (the last two boundaries) are often off the phrase grid; ignore them here.
    for (let j = 1; j <= B - 3; j++) {
      if ((((j - psi) % L) + L) % L === 0) {
        acc += nov[j] * nov[j];
        count++;
      }
    }
    return count ? acc / count : 0;
  };
  // 4-bar phase: default to the first downbeat unless another phase is clearly stronger.
  let psi4 = 0;
  for (let p = 1; p < 4; p++) if (phaseScore(4, p) > phaseScore(4, psi4)) psi4 = p;
  if (phaseScore(4, psi4) < 1.25 * phaseScore(4, 0)) psi4 = 0;
  // 8-bar phrases only when every other 4-bar boundary is clearly stronger.
  const a8 = phaseScore(8, psi4);
  const b8 = phaseScore(8, psi4 + 4);
  const strong8 = a8 >= b8 ? psi4 : psi4 + 4;
  const useEight = B >= 24 && Math.max(a8, b8) > 1.8 * Math.min(a8, b8) && barSeconds * 8 <= 24;
  const phraseBars = useEight ? 8 : 4;
  const psi = useEight ? strong8 : psi4;
  const phraseIdx: number[] = [];
  for (let j = 0; j < B; j++) if ((((j - psi) % phraseBars) + phraseBars) % phraseBars === 0) phraseIdx.push(j);
  // Keep the start of the music as a phrase when the first full phrase starts much later.
  if (phraseIdx.length && phraseIdx[0] >= phraseBars / 2) phraseIdx.unshift(0);
  const phrases = phraseIdx.map((j) => downbeats[j]);

  // --- sections: novelty peaks, snapped toward phrase boundaries
  const inner = nov.slice(1);
  // Peaks must stand out from typical bar-to-bar change (median ≈ 1 on this scale).
  const threshold = Math.max(1.5 * median(inner), mean(inner) + 0.25 * std(inner));
  const minGap = Math.max(4, Math.round(phraseBars / 2));
  const candidates: number[] = [];
  for (let j = 1; j < B; j++) {
    if (nov[j] < threshold) continue;
    let isMax = true;
    for (let q = Math.max(1, j - 2); q <= Math.min(B - 1, j + 2); q++) if (nov[q] > nov[j]) isMax = false;
    if (isMax) candidates.push(j);
  }
  const phraseSet = new Set(phraseIdx);
  const snapped = candidates.map((j) => {
    if (phraseSet.has(j)) return j;
    for (const d of [1, -1, 2, -2]) {
      const q = j + d;
      if (q > 0 && q < B && phraseSet.has(q) && nov[q] >= 0.6 * nov[j]) return q;
    }
    return j;
  });
  // Keep strongest first, respecting the minimum gap; cap the count by duration.
  const maxSections = Math.max(2, Math.round(duration / 12));
  const order = [...new Set(snapped)].sort((a, b) => nov[b] - nov[a]);
  const chosen: number[] = [];
  for (const j of order) {
    if (chosen.length >= maxSections - 1) break;
    if (chosen.every((c) => Math.abs(c - j) >= minGap)) chosen.push(j);
  }
  chosen.sort((a, b) => a - b);

  const bounds = [0, ...chosen.map((j) => downbeats[j]), duration];
  const raw = bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }));
  const energies = raw.map((s) => sectionEnergy(f, s.start, s.end, f.rmsDb));
  const maxE = Math.max(...energies);
  const energy = energies.map((e) => clamp01(1 + (e - maxE) / 18));
  const slopes = raw.map((s) => sectionSlope(f, s.start, s.end));
  // Mean bar-feature vector per section, for grouping similar material.
  const barBounds = [0, ...chosen, B];
  const profiles = raw.map((_, i) => {
    const from = barBounds[i];
    const to = Math.max(from + 1, barBounds[i + 1]);
    const out = new Array(rows[0].length).fill(0);
    for (let k = from; k < Math.min(to, B); k++) for (let d = 0; d < out.length; d++) out[d] += rows[k][d];
    return out.map((v) => v / Math.max(1, Math.min(to, B) - from));
  });
  const labels = labelSections(energy, slopes, profiles);
  const sections = raw.map((s, i) => ({
    start: round3(s.start),
    end: round3(s.end),
    label: labels[i],
    energy: Math.round(energy[i] * 100) / 100,
  }));
  return { phrases, phraseBars, sections };
}

/** Mean RMS level (dB) over [t0, t1). */
function sectionEnergy(f: Features, t0: number, t1: number, rmsDb: Float64Array): number {
  const a = Math.max(0, Math.floor(t0 * f.fps));
  const b = Math.min(rmsDb.length, Math.max(a + 1, Math.ceil(t1 * f.fps)));
  // Average in the power domain, report in dB.
  let p = 0;
  for (let i = a; i < b; i++) p += 10 ** (rmsDb[i] / 10);
  return 10 * Math.log10(Math.max(p / (b - a), 1e-14));
}

/** Loudness change (dB) across a section, from a least-squares line. */
function sectionSlope(f: Features, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * f.fps));
  const b = Math.min(f.rmsDb.length, Math.ceil(t1 * f.fps));
  if (b - a < 4) return 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.floor((b - a) / 200));
  for (let i = a; i < b; i += step) {
    xs.push(i / f.fps);
    ys.push(Math.max(f.rmsDb[i], -80));
  }
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? (sxy / sxx) * (t1 - t0) : 0;
}

/**
 * Coarse labels: intro/outro at the ends when quieter, "drop" for a high-energy
 * section entered with a jump, "build" for a rising section that leads up,
 * "break" for a quiet middle section, otherwise a letter shared by sections
 * with similar material (A, B, C...).
 */
function labelSections(energy: number[], slopes: number[], profiles: number[][]): string[] {
  const count = energy.length;
  const labels: string[] = new Array(count).fill('');
  if (count === 1) return ['A'];
  for (let i = 0; i < count; i++) {
    const e = energy[i];
    const prev = i > 0 ? energy[i - 1] : null;
    const next = i + 1 < count ? energy[i + 1] : null;
    if (i === 0 && (e < 0.8 || (next !== null && next - e >= 0.15))) labels[i] = 'intro';
    else if (i === count - 1 && (e < 0.8 || slopes[i] < -6 || (prev !== null && prev - e >= 0.15))) labels[i] = 'outro';
    else if (e >= 0.85 && prev !== null && (prev <= e - 0.15 || labels[i - 1] === 'drop' || labels[i - 1] === 'build'))
      labels[i] = 'drop';
    else if (slopes[i] > 4 && next !== null && next >= e + 0.08) labels[i] = 'build';
    else if (e < 0.62 && i > 0 && i < count - 1) labels[i] = 'break';
  }
  // Letters for the rest, reusing a letter for similar material.
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, d) => s + (v - b[d]) ** 2, 0));
  const pair: number[] = [];
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) pair.push(dist(profiles[i], profiles[j]));
  const same = count >= 3 ? 0.6 * median(pair) : 0;
  const letters: { profile: number[]; letter: string }[] = [];
  for (let i = 0; i < count; i++) {
    if (labels[i]) continue;
    const match = letters.find((l) => dist(l.profile, profiles[i]) < same);
    if (match) labels[i] = match.letter;
    else {
      const letter = String.fromCharCode(65 + Math.min(25, letters.length));
      letters.push({ profile: profiles[i], letter });
      labels[i] = letter;
    }
  }
  return labels;
}

// accents & waveform

export function detectAccents(
  f: Features,
  env: Float64Array,
  refine: (t: number) => number,
  max = 64,
): { t: number; strength: number }[] {
  const n = env.length;
  const radius = Math.max(1, Math.round(0.15 * f.fps));
  const peaks: { i: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (v <= 0) continue;
    let isMax = true;
    for (let q = Math.max(0, i - radius); q <= Math.min(n - 1, i + radius); q++) {
      if (env[q] > v || (env[q] === v && q < i)) {
        isMax = false;
        break;
      }
    }
    if (isMax) peaks.push({ i, v });
  }
  if (peaks.length === 0) return [];
  const level = (t0: number, t1: number) => {
    const a = Math.max(0, Math.floor(t0 * f.fps));
    const b = Math.min(f.frameCount, Math.max(a + 1, Math.ceil(t1 * f.fps)));
    let p = 0;
    for (let i = a; i < b; i++) p += 10 ** (f.rmsDb[i] / 10);
    return 10 * Math.log10(Math.max(p / (b - a), 1e-14));
  };
  const scored = peaks.map(({ i, v }) => {
    const t = i / f.fps;
    const jump = level(t, t + 0.2) - level(t - 0.4, t - 0.05);
    return { i, s: v * (1 + Math.min(2, Math.max(0, jump / 6))) };
  });
  const cut = percentile(
    scored.map((p) => p.s),
    80,
  );
  const top = scored
    .filter((p) => p.s >= cut)
    .sort((a, b) => b.s - a.s)
    .slice(0, max);
  const strongest = top[0]?.s || 1;
  return top
    .map((p) => ({ t: round3(refine(p.i / f.fps)), strength: Math.round((p.s / strongest) * 100) / 100 }))
    .sort((a, b) => a.t - b.t);
}

export function waveformPeaks(signal: Float32Array, bins = 1000): number[] {
  const out = new Array(bins).fill(0);
  if (signal.length === 0) return out;
  let peak = 0;
  for (let b = 0; b < bins; b++) {
    const a = Math.floor((b * signal.length) / bins);
    const e = Math.max(a + 1, Math.floor(((b + 1) * signal.length) / bins));
    let m = 0;
    for (let i = a; i < e && i < signal.length; i++) {
      const v = Math.abs(signal[i]);
      if (v > m) m = v;
    }
    out[b] = m;
    if (m > peak) peak = m;
  }
  return out.map((v) => (peak > 0 ? Math.round((v / peak) * 1000) / 1000 : 0));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round3(t: number): number {
  return Math.round(t * 1000) / 1000;
}
