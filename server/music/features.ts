// Adapted from saeedvaziry/caleb-video-editor (MIT)
// Low-level signal features used by the tempo, beat and structure stages.

import { FFT, hann, powerSpectrogram } from './fft';

export interface Features {
  sampleRate: number;
  /** Onset grid: hop in samples and frames per second. Frame i is centered on i*hop. */
  hop: number;
  fps: number;
  frameCount: number;
  /** Full-band spectral flux (SuperFlux-style, mean dB increase per mel band). */
  flux: Float64Array;
  /** Flux of the 30-150 Hz band (kick/bass attacks). */
  lowFlux: Float64Array;
  /** SuperFlux restricted to mel bands centered 150-2000 Hz (snare bodies, keys) and above 2 kHz (hats). */
  midFlux: Float64Array;
  highFlux: Float64Array;
  /** Loudness-weighted attacks: rise of the linear power of the mel bands centered 30-150 Hz / 150-2000 Hz. */
  lowRise: Float64Array;
  midRise: Float64Array;
  /** Per-frame RMS level in dBFS. */
  rmsDb: Float64Array;
  /** Log-mel spectrum per frame (dB, floored), `melBands` values each. */
  melDb: Float64Array[];
  melBands: number;
  /** Chroma (12 pitch classes, L2-normalized) on a coarser grid. */
  chroma: Float64Array[];
  chromaFps: number;
  /** Time-domain attack function sampled every millisecond. */
  transient: Float64Array;
}

const ONSET_FFT = 1024;
const ONSET_HOP = 256;
const MEL_BANDS = 48;
const CHROMA_FFT = 4096;
const CHROMA_HOP = 2048;

const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);

interface Filter {
  lo: number;
  weights: Float64Array;
  center: number;
}

function melFilterbank(bands: number, fftSize: number, sr: number, fMin: number, fMax: number): Filter[] {
  const mMin = hzToMel(fMin);
  const mMax = hzToMel(fMax);
  const edges: number[] = [];
  for (let i = 0; i < bands + 2; i++) edges.push(melToHz(mMin + ((mMax - mMin) * i) / (bands + 1)));
  return triangleFilters(edges, fftSize, sr);
}

/** Triangle filters over FFT bins: filter m rises from edges[m] to edges[m + 1] and falls to edges[m + 2]. */
function triangleFilters(edges: number[], fftSize: number, sr: number): Filter[] {
  const binHz = sr / fftSize;
  const bins = fftSize / 2 + 1;
  const filters: Filter[] = [];
  for (let m = 0; m < edges.length - 2; m++) {
    const left = edges[m];
    const center = edges[m + 1];
    const right = edges[m + 2];
    const lo = Math.max(0, Math.floor(left / binHz));
    const hi = Math.min(bins - 1, Math.ceil(right / binHz));
    const weights = new Float64Array(hi - lo + 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      const f = k * binHz;
      const w = f <= center ? (f - left) / (center - left) : (right - f) / (right - center);
      if (w > 0) {
        weights[k - lo] = w;
        sum += w;
      }
    }
    if (sum === 0) {
      // Narrow low-frequency band: fall back to the nearest bin.
      const k = Math.min(bins - 1, Math.max(0, Math.round(center / binHz)));
      filters.push({ lo: k, weights: Float64Array.of(1), center });
    } else {
      filters.push({ lo, weights, center });
    }
  }
  return filters;
}

export const SPECTRUM_BANDS = 24;
export const SPECTRUM_RATE = 25;
const SPECTRUM_FFT = 2048;
const SPECTRUM_MIN_HZ = 40;
const SPECTRUM_MAX_HZ = 11000;
const SPECTRUM_FLOOR_DB = -80;

/** Frames of `bandSpectrum` for a signal of `length` samples: frame i is centered on i / SPECTRUM_RATE seconds. */
export function spectrumFrames(length: number, sr: number): number {
  return 1 + Math.floor((length * SPECTRUM_RATE) / sr);
}

/**
 * Level of SPECTRUM_BANDS log-spaced bands (SPECTRUM_MIN_HZ to SPECTRUM_MAX_HZ) at SPECTRUM_RATE frames per second,
 * frame-major (`out[frame * SPECTRUM_BANDS + band]`). A byte maps -80 dB to 0 dB, where 0 dB is a full-scale sine.
 * Frames are computed two at a time and reduced at once: a 600 s track never holds its full-rate spectrogram.
 */
export function bandSpectrum(signal: Float32Array, sr: number): Uint8Array {
  const ratio = (SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ) ** (1 / SPECTRUM_BANDS);
  // Band b covers SPECTRUM_MIN_HZ * ratio^b to ratio^(b + 1); its triangle peaks at the geometric middle.
  const edges = Array.from({ length: SPECTRUM_BANDS + 2 }, (_, i) => SPECTRUM_MIN_HZ * ratio ** (i - 0.5));
  const filters = triangleFilters(edges, SPECTRUM_FFT, sr);
  const fft = new FFT(SPECTRUM_FFT);
  const window = hann(SPECTRUM_FFT);
  const half = SPECTRUM_FFT >> 1;
  // A full-scale sine through a Hann window peaks at (size / 4)^2.
  const fullScale = (SPECTRUM_FFT / 4) ** 2;
  const count = spectrumFrames(signal.length, sr);
  const out = new Uint8Array(count * SPECTRUM_BANDS);
  const frames = [new Float64Array(SPECTRUM_FFT), new Float64Array(SPECTRUM_FFT)];
  const powers = [new Float64Array(half + 1), new Float64Array(half + 1)];

  for (let f = 0; f < count; f += 2) {
    for (let k = 0; k < 2; k++) {
      const start = Math.round(((f + k) * sr) / SPECTRUM_RATE) - half;
      for (let j = 0; j < SPECTRUM_FFT; j++) {
        const s = start + j;
        frames[k][j] = s >= 0 && s < signal.length ? signal[s] * window[j] : 0;
      }
    }
    fft.powerPair(frames[0], frames[1], powers[0], powers[1]);
    for (let k = 0; k < 2 && f + k < count; k++) {
      const p = powers[k];
      for (let b = 0; b < SPECTRUM_BANDS; b++) {
        const { lo, weights } = filters[b];
        let acc = 0;
        for (let j = 0; j < weights.length; j++) acc += weights[j] * p[lo + j];
        const db = 10 * Math.log10(Math.max(acc / fullScale, 1e-10));
        const level = Math.min(1, Math.max(0, (db - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB));
        out[(f + k) * SPECTRUM_BANDS + b] = Math.round(level * 255);
      }
    }
  }
  return out;
}

export function computeFeatures(signal: Float32Array, sr: number): Features {
  const hop = ONSET_HOP;
  const fps = sr / hop;
  const spec = powerSpectrogram(signal, ONSET_FFT, hop);
  const frameCount = spec.length;
  const binHz = sr / ONSET_FFT;

  // Log-mel spectrum
  const filters = melFilterbank(MEL_BANDS, ONSET_FFT, sr, 30, Math.min(11000, sr / 2));
  const group = filters.map((fl) => (fl.center < 150 ? 0 : fl.center < 2000 ? 1 : 2));
  const melDb: Float64Array[] = new Array(frameCount);
  const lowPower = new Float64Array(frameCount);
  const midPower = new Float64Array(frameCount);
  let maxDb = -Infinity;
  for (let t = 0; t < frameCount; t++) {
    const p = spec[t];
    const row = new Float64Array(MEL_BANDS);
    for (let m = 0; m < MEL_BANDS; m++) {
      const { lo, weights } = filters[m];
      let acc = 0;
      for (let j = 0; j < weights.length; j++) acc += weights[j] * p[lo + j];
      if (group[m] === 0) lowPower[t] += acc;
      else if (group[m] === 1) midPower[t] += acc;
      const db = 10 * Math.log10(Math.max(acc, 1e-10));
      row[m] = db;
      if (db > maxDb) maxDb = db;
    }
    melDb[t] = row;
  }
  const floor = maxDb - 80;
  for (const row of melDb) for (let m = 0; m < MEL_BANDS; m++) if (row[m] < floor) row[m] = floor;

  // --- SuperFlux: positive increase vs. a frequency-max-filtered previous frame
  const flux = new Float64Array(frameCount);
  const midFlux = new Float64Array(frameCount);
  const highFlux = new Float64Array(frameCount);
  const groupSize = [0, 1, 2].map((g) => Math.max(1, group.filter((x) => x === g).length));
  const prevMax = new Float64Array(MEL_BANDS);
  for (let t = 1; t < frameCount; t++) {
    const prev = melDb[t - 1];
    for (let m = 0; m < MEL_BANDS; m++) {
      let v = prev[m];
      if (m > 0 && prev[m - 1] > v) v = prev[m - 1];
      if (m < MEL_BANDS - 1 && prev[m + 1] > v) v = prev[m + 1];
      prevMax[m] = v;
    }
    const cur = melDb[t];
    let acc = 0;
    let mid = 0;
    let high = 0;
    for (let m = 0; m < MEL_BANDS; m++) {
      const d = cur[m] - prevMax[m];
      if (d > 0) {
        acc += d;
        if (group[m] === 1) mid += d;
        else if (group[m] === 2) high += d;
      }
    }
    flux[t] = acc / MEL_BANDS;
    midFlux[t] = mid / groupSize[1];
    highFlux[t] = high / groupSize[2];
  }

  // Low band (30-150 Hz) flux
  const lowLo = Math.max(1, Math.floor(30 / binHz));
  const lowHi = Math.max(lowLo, Math.ceil(150 / binHz));
  const lowDb = new Float64Array(frameCount);
  let lowMax = -Infinity;
  for (let t = 0; t < frameCount; t++) {
    let acc = 0;
    for (let k = lowLo; k <= lowHi; k++) acc += spec[t][k];
    const db = 10 * Math.log10(Math.max(acc, 1e-10));
    lowDb[t] = db;
    if (db > lowMax) lowMax = db;
  }
  const lowFloor = lowMax - 70;
  const lowFlux = new Float64Array(frameCount);
  for (let t = 1; t < frameCount; t++) {
    const a = Math.max(lowDb[t], lowFloor);
    const b = Math.max(lowDb[t - 1], lowFloor);
    lowFlux[t] = a > b ? a - b : 0;
  }

  // RMS per frame
  const sq = new Float64Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) sq[i + 1] = sq[i] + signal[i] * signal[i];
  const energy = (from: number, to: number) => {
    const a = Math.max(0, Math.min(signal.length, from));
    const b = Math.max(0, Math.min(signal.length, to));
    return b > a ? (sq[b] - sq[a]) / (b - a) : 0;
  };
  const rmsDb = new Float64Array(frameCount);
  for (let t = 0; t < frameCount; t++) {
    const c = t * hop;
    rmsDb[t] = 10 * Math.log10(Math.max(energy(c - hop / 2, c + hop / 2), 1e-14));
  }

  // Chroma
  const cspec = powerSpectrogram(signal, CHROMA_FFT, CHROMA_HOP);
  const cBinHz = sr / CHROMA_FFT;
  const pcOfBin = new Int8Array(CHROMA_FFT / 2 + 1).fill(-1);
  for (let k = 1; k <= CHROMA_FFT / 2; k++) {
    const f = k * cBinHz;
    if (f < 65 || f > 2100) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chroma: Float64Array[] = new Array(cspec.length);
  let chromaMax = 0;
  for (let t = 0; t < cspec.length; t++) {
    const row = new Float64Array(12);
    const p = cspec[t];
    for (let k = 1; k < p.length; k++) {
      const pc = pcOfBin[k];
      if (pc >= 0) row[pc] += Math.sqrt(p[k]);
    }
    for (let i = 0; i < 12; i++) if (row[i] > chromaMax) chromaMax = row[i];
    chroma[t] = row;
  }
  for (const row of chroma) {
    let norm = 0;
    for (let i = 0; i < 12; i++) {
      row[i] = Math.log1p((100 * row[i]) / (chromaMax || 1));
      norm += row[i] * row[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let i = 0; i < 12; i++) row[i] /= norm;
  }

  // 1 kHz time-domain attack function
  const perMs = sr / 1000;
  const msCount = Math.floor(signal.length / perMs);
  const halfWin = Math.round(2 * perMs); // 4 ms window
  const logE = new Float64Array(msCount);
  let logMax = -Infinity;
  for (let m = 0; m < msCount; m++) {
    const c = Math.round(m * perMs);
    const v = 10 * Math.log10(Math.max(energy(c - halfWin, c + halfWin), 1e-14));
    logE[m] = v;
    if (v > logMax) logMax = v;
  }
  const eFloor = logMax - 60;
  const transient = new Float64Array(msCount);
  for (let m = 4; m < msCount; m++) {
    const d = Math.max(logE[m], eFloor) - Math.max(logE[m - 4], eFloor);
    transient[m] = d > 0 ? d : 0;
  }

  return {
    sampleRate: sr,
    hop,
    fps,
    frameCount,
    flux,
    lowFlux,
    midFlux,
    highFlux,
    lowRise: powerRise(lowPower),
    midRise: powerRise(midPower),
    rmsDb,
    melDb,
    melBands: MEL_BANDS,
    chroma,
    chromaFps: sr / CHROMA_HOP,
    transient,
  };
}

/**
 * How much `power` rises across each frame: mean over the next `post` frames minus the mean over the `pre` frames
 * before (skipping the frame just before, which already holds the attack's leading edge). Unlike dB flux, a quiet
 * hit after silence scores low and a loud one high.
 */
function powerRise(power: Float64Array, pre = 3, post = 4): Float64Array {
  const n = power.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + power[i];
  const avg = (a: number, b: number) => {
    const lo = Math.max(0, a);
    const hi = Math.min(n, b);
    return hi > lo ? (prefix[hi] - prefix[lo]) / (hi - lo) : 0;
  };
  const out = new Float64Array(n);
  for (let t = 0; t < n; t++) out[t] = Math.max(0, avg(t, t + post) - avg(t - 1 - pre, t - 1));
  return out;
}
