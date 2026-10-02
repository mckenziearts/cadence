// Adapted from saeedvaziry/caleb-video-editor (MIT)
// Music analysis: tempo, beats, downbeats, phrases, sections, accents and a drawable waveform,
// computed from any audio (or video) file ffmpeg can read.
import type { MusicAnalysis } from '../../src/shared/types';
import { ANALYSIS_SAMPLE_RATE, decodeAudio } from './decode';
import { computeFeatures } from './features';
import { onsetEnvelope, refineToAttack, trackBeats } from './beats';
import { analyzeStructure, BEATS_PER_BAR, detectAccents, detectMeter, waveformPeaks } from './structure';

export async function analyzeMusic(file: string, ffmpegPath: string): Promise<MusicAnalysis> {
  return analyzeSignal(await decodeAudio(file, ffmpegPath), ANALYSIS_SAMPLE_RATE);
}

/** Analyze mono PCM samples (any sample rate; 22.05 kHz is what the tuning assumes). */
export function analyzeSignal(signal: Float32Array, sampleRate: number): MusicAnalysis {
  const duration = round3(signal.length / sampleRate);
  const waveform = waveformPeaks(signal);

  let peak = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = Math.abs(signal[i]);
    if (v > peak) peak = v;
  }
  if (duration < 1 || peak < 1e-4) {
    return {
      version: 2,
      duration,
      sampleRate,
      bpm: 120,
      beatsPerBar: BEATS_PER_BAR,
      beats: [],
      downbeats: [],
      phrases: [],
      sections: [{ start: 0, end: duration, label: 'silence', energy: 0 }],
      accents: [],
      waveform,
      confidence: 0,
    };
  }

  const features = computeFeatures(signal, sampleRate);
  const env = onsetEnvelope(features);
  const track = trackBeats(features, env);
  const beats = track.beats;

  const { beatsPerBar, phase } = detectMeter(beats, features);
  const downbeats = beats.filter((_, i) => i >= phase && (i - phase) % beatsPerBar === 0);
  const bar = track.period * beatsPerBar;
  // Bars that start as the music ends carry no content; keep them out of the structure analysis.
  const structuralBars = downbeats.filter((t) => t < track.activeEnd - 0.5 * bar);
  const structure = analyzeStructure(features, structuralBars, bar, duration);
  const accents = detectAccents(features, env, (t) => refineToAttack(features, t));

  return {
    version: 2,
    duration,
    sampleRate,
    bpm: track.bpm,
    beatsPerBar,
    beats,
    downbeats,
    phrases: structure.phrases,
    sections: structure.sections,
    accents,
    waveform,
    confidence: track.confidence,
  };
}

function round3(t: number): number {
  return Math.round(t * 1000) / 1000;
}
