// Adapted from saeedvaziry/caleb-video-editor (MIT)
import type { MusicGridData } from '../shared/types';

export type MusicGrid = 'beat' | 'bar' | 'phrase' | 'half' | 'quarter';

export interface MusicSection {
  start: number;
  end: number;
  label: string;
  energy: number;
}

/**
 * The music as seen from inside one scene. Every time is scene-local seconds (0 = the first frame of this scene),
 * so animations keyed to beats stay in sync when scenes are moved or re-timed.
 */
export interface Music {
  /** False without a usable track: the grid is then a steady `tempo` grid starting at t = 0. */
  hasTrack: boolean;
  bpm: number;
  /** Seconds per beat. */
  beatLength: number;
  /** Seconds per bar. */
  barLength: number;
  beatsPerBar: number;
  /** Grid points inside this scene (0 to duration). */
  beats: number[];
  downbeats: number[];
  phrases: number[];
  /** Sections overlapping this scene (start may be < 0, end may be > duration). */
  sections: MusicSection[];
  /** Strong onsets inside this scene, strength 0..1. */
  accents: { t: number; strength: number }[];
  /** Time of the nth beat at/after the scene start (fractional n interpolates, n < 0 goes back). */
  beat(n: number): number;
  /** Time of the nth bar start (downbeat) at/after the scene start. */
  bar(n: number): number;
  /** Time of the nth phrase start at/after the scene start. */
  phrase(n: number): number;
  /** Length of n bars in seconds. */
  bars(n: number): number;
  /** Nearest grid time to t. */
  snap(t: number, grid?: MusicGrid): number;
  /** 1 exactly on each grid hit, decaying exponentially afterwards (0 where the track has no grid). */
  pulse(t: number, options?: { grid?: MusicGrid; decay?: number }): number;
  /** 0 to 1 progress through the current beat. */
  beatPhase(t: number): number;
  /**
   * Loudness 0 to 1 of the track at t in 24 log-spaced bands from 40 Hz to 11 kHz (lowest first), or averaged into
   * `bands` groups (1 to 24). All zeros before and after the track, and without one.
   */
  spectrum(t: number, bands?: number): number[];
}

/** Band levels of the track: `bytes` holds rows of `bands` bytes (0..255), `rate` rows per second of TRACK time. */
export interface MusicSpectrumData {
  bands: number;
  rate: number;
  bytes: Uint8Array;
}

export interface CreateMusicInput {
  /** Beat grid in TRACK seconds (overrides applied), or null without a track. */
  grid: MusicGridData | null;
  /** Project tempo (BPM) used when there is no track. */
  tempo: number;
  /** Track seconds that line up with video time 0. */
  musicStart: number;
  /** Scene start in video seconds. */
  sceneStart: number;
  sceneDuration: number;
  /** Band levels of the track; an Error while they are not available, thrown by `spectrum()`. Absent without a track. */
  spectrum?: MusicSpectrumData | Error | null;
}

/** Grid points this close before the scene start count as "at the start" (cuts snapped to beats land within ms). */
const EPS = 0.005;
/** Bars per phrase when the grid has no phrases (no track). */
const PHRASE_BARS = 4;
const SPECTRUM_BANDS = 24;

/**
 * Ascending grid times, extended in both directions at `spacing`. `bounded` lines come from the track: only their
 * real points are listed and pulse; synthetic lines (no track) repeat forever.
 */
interface Line {
  points: number[];
  spacing: number;
  bounded: boolean;
}

const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function spacingOf(points: number[], fallback: number): number {
  return median(
    points.slice(1).map((v, i) => v - points[i]),
    fallback,
  );
}

/** Sorted, strictly increasing (duplicates would divide by zero in indexAt). */
function clean(points: number[]): number[] {
  return [...points].sort((a, b) => a - b).filter((v, i, a) => i === 0 || v > a[i - 1]);
}

/** Time at (fractional) index k. */
function valueAt({ points, spacing }: Line, k: number): number {
  const last = points.length - 1;
  if (k <= 0) return points[0] + k * spacing;
  if (k >= last) return points[last] + (k - last) * spacing;
  const i = Math.floor(k);
  return points[i] + (points[i + 1] - points[i]) * (k - i);
}

/** Fractional index of time t (inverse of valueAt). */
function indexAt({ points, spacing }: Line, t: number): number {
  const last = points.length - 1;
  if (t <= points[0]) return (t - points[0]) / spacing;
  if (t >= points[last]) return last + (t - points[last]) / spacing;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - points[lo]) / (points[hi] - points[lo]);
}

/** Index of the first point at or after the scene start. */
function firstIndex(line: Line): number {
  return Math.ceil(indexAt(line, -EPS));
}

function listIn(line: Line, duration: number): number[] {
  const out: number[] = [];
  const last = line.bounded ? line.points.length - 1 : Infinity;
  for (let k = Math.max(firstIndex(line), line.bounded ? 0 : -Infinity); k <= last; k++) {
    const v = valueAt(line, k);
    if (v > duration + EPS) break;
    out.push(tidy(v));
  }
  return out;
}

/** Levels at TRACK time `at`, interpolated between rows, averaged into `groups` groups of neighbouring bands. */
function spectrumAt(source: MusicSpectrumData | null, at: number, groups: number): number[] {
  const total = source?.bands ?? SPECTRUM_BANDS;
  if (!Number.isInteger(groups) || groups < 1 || groups > total) {
    throw new RangeError(`music.spectrum(t, bands): bands must be an integer from 1 to ${total}, not ${groups}`);
  }
  const levels = new Array<number>(total).fill(0);
  const rows = source ? Math.floor(source.bytes.length / total) : 0;
  const row = source ? at * source.rate : -1;
  if (source && row >= 0 && row <= rows - 1) {
    const i = Math.floor(row);
    const w = row - i;
    const next = Math.min(i + 1, rows - 1);
    for (let b = 0; b < total; b++) {
      levels[b] = (source.bytes[i * total + b] * (1 - w) + source.bytes[next * total + b] * w) / 255;
    }
  }
  return Array.from({ length: groups }, (_, g) => {
    const from = Math.floor((g * total) / groups);
    const to = Math.floor(((g + 1) * total) / groups);
    return levels.slice(from, to).reduce((sum, v) => sum + v, 0) / (to - from);
  });
}

export function createMusic(input: CreateMusicInput): Music {
  const { grid, musicStart, sceneStart, sceneDuration } = input;
  const tempo = input.tempo > 0 ? input.tempo : 120;
  const hasTrack = grid !== null && grid.beats.length >= 2;
  let bpm = tempo;
  let beatsPerBar = 4;
  let beats: Line;
  let downbeats: Line;
  let phrases: Line;
  let sections: MusicSection[] = [];
  let accents: { t: number; strength: number }[] = [];

  if (hasTrack) {
    const offset = musicStart + sceneStart;
    const local = (x: number) => tidy(x - offset);
    bpm = grid.bpm;
    beatsPerBar = grid.beatsPerBar || 4;
    const beatPoints = clean(grid.beats.map(local));
    beats = { points: beatPoints, spacing: spacingOf(beatPoints, 60 / (bpm || tempo)), bounded: true };
    const barPoints = clean(grid.downbeats.map(local));
    downbeats =
      barPoints.length > 0
        ? { points: barPoints, spacing: spacingOf(barPoints, beats.spacing * beatsPerBar), bounded: true }
        : { points: [beatPoints[0]], spacing: beats.spacing * beatsPerBar, bounded: false };
    const phrasePoints = clean(grid.phrases.map(local));
    phrases =
      phrasePoints.length > 0
        ? { points: phrasePoints, spacing: spacingOf(phrasePoints, downbeats.spacing * PHRASE_BARS), bounded: true }
        : { points: [downbeats.points[0]], spacing: downbeats.spacing * PHRASE_BARS, bounded: false };
    sections = grid.sections
      .map((s) => ({ ...s, start: local(s.start), end: local(s.end) }))
      .filter((s) => s.end > 0 && s.start < sceneDuration);
    accents = grid.accents
      .map((a) => ({ t: local(a.t), strength: a.strength }))
      .filter((a) => a.t >= -EPS && a.t <= sceneDuration + EPS);
  } else {
    const beatLength = 60 / tempo;
    beats = { points: [0], spacing: beatLength, bounded: false };
    downbeats = { points: [0], spacing: beatLength * beatsPerBar, bounded: false };
    phrases = { points: [0], spacing: beatLength * beatsPerBar * PHRASE_BARS, bounded: false };
  }

  const lines: Record<'beat' | 'bar' | 'phrase', Line> = { beat: beats, bar: downbeats, phrase: phrases };
  /** Line + subdivision factor for a grid name. */
  const resolve = (g: MusicGrid): [Line, number] =>
    g === 'half' ? [beats, 2] : g === 'quarter' ? [beats, 4] : [lines[g] ?? beats, 1];
  const nth = (line: Line, n: number) => tidy(valueAt(line, firstIndex(line) + n));

  return {
    hasTrack,
    bpm,
    beatLength: beats.spacing,
    barLength: downbeats.spacing,
    beatsPerBar,
    beats: listIn(beats, sceneDuration),
    downbeats: listIn(downbeats, sceneDuration),
    phrases: listIn(phrases, sceneDuration),
    sections,
    accents,
    beat: (n) => nth(beats, n),
    bar: (n) => nth(downbeats, n),
    phrase: (n) => nth(phrases, n),
    bars: (n) => n * downbeats.spacing,
    snap: (t, g = 'beat') => {
      const [line, parts] = resolve(g);
      return tidy(valueAt(line, Math.round(indexAt(line, t) * parts) / parts));
    },
    pulse: (t, options = {}) => {
      const [line, parts] = resolve(options.grid ?? 'beat');
      const k = Math.floor(indexAt(line, t) * parts + 1e-6) / parts;
      if (line.bounded && (k < 0 || k > line.points.length - 1)) return 0;
      return Math.exp(-(options.decay ?? 6) * Math.max(0, t - valueAt(line, k)));
    },
    beatPhase: (t) => {
      const x = indexAt(beats, t);
      return x - Math.floor(x);
    },
    spectrum: (t, bands) => {
      const source = input.spectrum ?? null;
      if (source instanceof Error) throw source;
      // The audio itself: musicStart and the scene start, never the grid's manual gridOffset.
      return spectrumAt(source, t + musicStart + sceneStart, bands ?? source?.bands ?? SPECTRUM_BANDS);
    },
  };
}
