// MusicSettings overrides (bpm, beatsPerBar, barOffset, gridOffset) applied to an analysis. Pure; track seconds.
import type { MusicAnalysis, MusicGridData, MusicSettings } from '../../src/shared/types';
import { median } from './beats';

export const BPM_MIN = 40;
export const BPM_MAX = 240;
export const BEATS_PER_BAR_CHOICES = [3, 4, 6];
export const MAX_GRID_OFFSET = 0.25;

type Overrides = Pick<MusicSettings, 'bpm' | 'beatsPerBar' | 'barOffset' | 'gridOffset'>;

export function applyOverrides(analysis: MusicAnalysis, settings: Overrides): MusicGridData {
  const o = validOverrides(settings, analysis.beatsPerBar);
  const base = {
    sections: analysis.sections,
    accents: analysis.accents,
    waveform: analysis.waveform,
    duration: analysis.duration,
    confidence: analysis.confidence,
  };
  const bpm = o.bpm ?? analysis.bpm;
  let beats = analysis.beats;
  let downbeats = analysis.downbeats;
  let phrases = analysis.phrases;
  const anchorTime = analysis.downbeats[0] ?? analysis.beats[0];
  if (anchorTime !== undefined && (o.bpm !== null || o.beatsPerBar !== analysis.beatsPerBar || o.barOffset !== 0)) {
    if (o.bpm !== null) beats = steadyGrid(anchorTime, 60 / o.bpm, analysis);
    const anchor = nearestIndex(beats, anchorTime) + o.barOffset;
    downbeats = beats.filter((_, i) => mod(i - anchor, o.beatsPerBar) === 0);
    phrases = rebuildPhrases(analysis, downbeats);
  }
  if (o.gridOffset === 0) return { ...base, bpm, beatsPerBar: o.beatsPerBar, beats, downbeats, phrases };

  const shift = (times: number[]) => times.map((t) => round4(t + o.gridOffset)).filter((t) => t >= 0 && t <= analysis.duration);
  const move = (t: number) => Math.min(analysis.duration, Math.max(0, round4(t + o.gridOffset)));
  const last = base.sections.length - 1;
  return {
    ...base,
    // Inner section boundaries sit on bar lines, so they move with the grid; the track's ends stay put.
    sections: base.sections.map((s, i) => ({
      ...s,
      start: i === 0 ? s.start : move(s.start),
      end: i === last ? s.end : move(s.end),
    })),
    bpm,
    beatsPerBar: o.beatsPerBar,
    beats: shift(beats),
    downbeats: shift(downbeats),
    phrases: shift(phrases),
  };
}

/** Overrides within their ranges; anything else (a hand-edited project.json...) falls back to the analysis. */
function validOverrides(s: Overrides, detectedBeatsPerBar: number) {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const beatsPerBar = BEATS_PER_BAR_CHOICES.includes(s.beatsPerBar as number) ? (s.beatsPerBar as number) : detectedBeatsPerBar;
  const barOffset = Number.isInteger(s.barOffset) && (s.barOffset as number) >= 0 ? (s.barOffset as number) % beatsPerBar : 0;
  return {
    bpm: finite(s.bpm) && s.bpm >= BPM_MIN && s.bpm <= BPM_MAX ? s.bpm : null,
    beatsPerBar,
    barOffset,
    gridOffset: finite(s.gridOffset) && Math.abs(s.gridOffset) <= MAX_GRID_OFFSET ? s.gridOffset : 0,
  };
}

/** Beats every `period` through `anchor`, over the span where the analysis found beats. */
function steadyGrid(anchor: number, period: number, analysis: MusicAnalysis): number[] {
  const from = Math.max(0, (analysis.beats[0] ?? anchor) - period / 2);
  const to = Math.min(analysis.duration, (analysis.beats.at(-1) ?? anchor) + period / 2);
  const out: number[] = [];
  for (let k = Math.ceil((from - anchor) / period); anchor + k * period <= to; k++) out.push(round4(anchor + k * period));
  return out;
}

/**
 * Phrases every 4 or 8 bars (the length the analysis found), in phase with its first regular phrase (the analysis
 * may put an extra phrase at the start of the music; so does this when the first regular phrase starts late).
 */
function rebuildPhrases(analysis: MusicAnalysis, downbeats: number[]): number[] {
  if (downbeats.length === 0) return [];
  const { phrases } = analysis;
  const oldBar = barLength(analysis.downbeats) ?? 1;
  const gaps = phrases.slice(2).map((t, i) => (t - phrases[i + 1]) / oldBar);
  const phraseBars = gaps.length && median(gaps) > 6 ? 8 : 4;
  const anchor = nearestIndex(downbeats, phrases[1] ?? phrases[0] ?? downbeats[0]);
  const out = downbeats.filter((_, j) => mod(j - anchor, phraseBars) === 0);
  const first = downbeats.indexOf(out[0]);
  if (first === -1 || first >= phraseBars / 2) out.unshift(downbeats[0]);
  return out;
}

function barLength(downbeats: number[]): number | null {
  return downbeats.length > 1 ? (downbeats[downbeats.length - 1] - downbeats[0]) / (downbeats.length - 1) : null;
}

/** Index of the time closest to `t`; the later one on a tie (a bar offset moves bar ones later). */
function nearestIndex(times: number[], t: number): number {
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) <= Math.abs(times[best] - t)) best = i;
  return best;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const round4 = (t: number) => Math.round(t * 10000) / 10000;
