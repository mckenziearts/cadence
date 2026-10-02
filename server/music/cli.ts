// Adapted from saeedvaziry/caleb-video-editor (MIT)
// `npm run cadence -- analyze <audio or video file> [--json]`
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config';
import { m } from '../i18n';
import { analyzeSignal } from './analyze';
import { ANALYSIS_SAMPLE_RATE, decodeAudio } from './decode';

export async function runAnalyzeCli(file: string, opts: { json?: boolean; ffmpegPath?: string } = {}): Promise<void> {
  if (!(await fs.stat(file).catch(() => null))?.isFile()) throw new Error(m().media.analyze.missingFile(file));
  const t0 = performance.now();
  const signal = await decodeAudio(file, opts.ffmpegPath ?? loadConfig().ffmpegPath);
  const t1 = performance.now();
  const a = analyzeSignal(signal, ANALYSIS_SAMPLE_RATE);
  const t2 = performance.now();
  if (opts.json) {
    console.log(JSON.stringify(a));
    return;
  }

  const report = m().media.analyze;
  const num = (x: number, digits = 3) => report.number(x, digits);
  const times = (xs: number[], n: number) =>
    report.times(
      xs.slice(0, n).map((t) => num(t)),
      xs.length > n,
    );
  const beat = 60 / a.bpm;
  const gaps = a.beats.slice(1).map((t, i) => t - a.beats[i]);
  const gapMean = gaps.reduce((s, g) => s + g, 0) / (gaps.length || 1);
  const gapSd = Math.sqrt(gaps.reduce((s, g) => s + (g - gapMean) ** 2, 0) / (gaps.length || 1));
  const strongest = [...a.accents].sort((x, y) => y.strength - x.strength).slice(0, 6);
  const lines = [
    report.file(file),
    report.duration(num(a.duration, 2)),
    report.tempo(num(a.bpm, 2), a.beatsPerBar, num(beat), num(beat * a.beatsPerBar)),
    report.confidence(num(a.confidence, 2)),
    report.beats(a.beats.length, num(gapMean * 1000, 1), num(gapSd * 1000, 1), times(a.beats, 8)),
    report.bars(a.downbeats.length, times(a.downbeats, 10)),
    report.phrases(a.phrases.length ? times(a.phrases, 16) : report.none),
    report.sections(a.sections.length),
    ...a.sections.map((s) =>
      report.section(num(s.start, 2).padStart(7), num(s.end, 2).padStart(7), s.label.padEnd(7), num(s.energy, 2)),
    ),
    report.accents(a.accents.length, strongest.map((x) => `${num(x.t, 2)} s (${num(x.strength, 2)})`).join(', ') || report.none),
    report.timings(Math.round(t1 - t0), Math.round(t2 - t1)),
  ];
  console.log(lines.join('\n'));
}
