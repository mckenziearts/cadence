// Synthetic drum tracks with a known tempo, beat grid and bar ones (every hit exactly on time), written as 16-bit WAV
// for the analyzer tests, and a hand-made analysis for the grid and service tests.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MusicAnalysis } from '../../src/shared/types';

const SAMPLE_RATE = 44100;

export interface TrackSpec {
  bpm: number;
  beatsPerBar: number;
  bars: number;
  /** Silence before the first beat, seconds. */
  lead?: number;
  /** Beat positions inside the bar (0 = the one; fractions allowed) that get a kick. */
  kick?: number[];
  snare?: number[];
  /** Hi-hat every `hat` beats (0.5 = eighths); 0 = none. */
  hat?: number;
  /** Leading bars without kick. */
  introBars?: number;
  /** Gain on the bar's one (kick and hat). */
  accent?: number;
  /** Sustained triads changing every bar. */
  chords?: boolean;
}

export interface SynthTrack {
  samples: Float32Array;
  sampleRate: number;
  beats: number[];
  downbeats: number[];
}

const CHORDS = [
  [220, 261.63, 329.63],
  [174.61, 220, 261.63],
  [261.63, 329.63, 392],
  [196, 246.94, 293.66],
];

export function synthTrack(spec: TrackSpec): SynthTrack {
  const { bpm, beatsPerBar, bars } = spec;
  const lead = spec.lead ?? 0.5;
  const kick = spec.kick ?? [0];
  const snare = spec.snare ?? [];
  const hat = spec.hat ?? 0.5;
  const introBars = spec.introBars ?? 0;
  const accent = spec.accent ?? 1.5;
  const beat = 60 / bpm;
  const length = lead + bars * beatsPerBar * beat + 1;
  const out = new Float32Array(Math.ceil(length * SAMPLE_RATE));
  let seed = 1;
  const noise = () => {
    // mulberry32: deterministic noise for snares and hats.
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return (((x ^ (x >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  const add = (t: number, seconds: number, sample: (dt: number) => number) => {
    const from = Math.round(t * SAMPLE_RATE);
    const count = Math.round(seconds * SAMPLE_RATE);
    for (let i = 0; i < count && from + i < out.length; i++) out[from + i] += sample(i / SAMPLE_RATE);
  };
  const kickAt = (t: number, gain: number) => {
    let phase = 0;
    add(t, 0.35, (dt) => {
      phase += (2 * Math.PI * (45 + 75 * Math.exp(-dt / 0.04))) / SAMPLE_RATE;
      return 0.8 * gain * Math.exp(-dt / 0.18) * Math.sin(phase);
    });
  };
  const snareAt = (t: number) =>
    add(t, 0.25, (dt) => 0.35 * noise() * Math.exp(-dt / 0.07) + 0.3 * Math.sin(2 * Math.PI * 190 * dt) * Math.exp(-dt / 0.05));
  const hatAt = (t: number, gain: number) => {
    let prev = 0;
    add(t, 0.06, (dt) => {
      const n = noise();
      const v = n - prev;
      prev = n;
      return 0.12 * gain * v * Math.exp(-dt / 0.018);
    });
  };

  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let b = 0; b < bars; b++) {
    const barStart = lead + b * beatsPerBar * beat;
    downbeats.push(barStart);
    for (let k = 0; k < beatsPerBar; k++) beats.push(barStart + k * beat);
    if (b >= introBars) for (const k of kick) kickAt(barStart + k * beat, k === 0 ? accent : 1);
    for (const k of snare) snareAt(barStart + k * beat);
    if (hat > 0) for (let k = 0; k < beatsPerBar; k += hat) hatAt(barStart + k * beat, k === 0 ? accent : 1);
    if (spec.chords) {
      const freqs = CHORDS[b % CHORDS.length];
      const barLength = beatsPerBar * beat;
      add(barStart, barLength, (dt) => {
        const env = Math.min(1, dt / 0.02) * Math.min(1, (barLength - dt) / 0.02);
        return 0.05 * env * freqs.reduce((s, f) => s + Math.sin(2 * Math.PI * f * dt), 0);
      });
    }
  }

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = (0.9 * out[i]) / peak;
  return { samples: out, sampleRate: SAMPLE_RATE, beats, downbeats };
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const created: string[] = [];
process.on('exit', () => created.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A fresh temp folder, removed when the test process exits. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-music-'));
  created.push(dir);
  return dir;
}

/** Write the track to a fresh temp folder; returns the WAV path. */
export function writeTrack(track: SynthTrack, name = 'track.wav'): string {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, encodeWav(track.samples, track.sampleRate));
  return file;
}

export const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** Distance from t to the nearest of `points`. */
export function distance(points: number[], t: number): number {
  let best = Infinity;
  for (const p of points) best = Math.min(best, Math.abs(p - t));
  return best;
}

/** 120 BPM, 4/4: beats every 0.5 s from 1 s to 33 s, bars every 2 s, phrases every 4 bars. */
export function steadyAnalysis(): MusicAnalysis {
  const beats = Array.from({ length: 65 }, (_, i) => 1 + i * 0.5);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return {
    version: 2,
    duration: 34,
    sampleRate: 22050,
    bpm: 120,
    beatsPerBar: 4,
    beats,
    downbeats,
    phrases: downbeats.filter((_, i) => i % 4 === 0),
    sections: [
      { start: 0, end: 9, label: 'intro', energy: 0.4 },
      { start: 9, end: 34, label: 'drop', energy: 1 },
    ],
    accents: [{ t: 9, strength: 1 }],
    waveform: [0, 0.5, 1],
    confidence: 0.9,
  };
}
