import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMusic, analyzeSignal } from '../../server/music/analyze';
import { median } from '../../server/music/beats';
import { distance, hasFfmpeg, synthTrack, writeTrack, type SynthTrack, type TrackSpec } from './synth';

const skip = hasFfmpeg ? false : 'ffmpeg introuvable';

async function analyse(spec: TrackSpec) {
  const track = synthTrack(spec);
  return { track, a: await analyzeMusic(writeTrack(track), 'ffmpeg') };
}

/** Detected times up to the last real beat (the grid may run on into the decay of the last hits). */
function inMusic(times: number[], track: SynthTrack): number[] {
  return times.filter((t) => t < track.beats[track.beats.length - 1] + 0.1);
}

function assertBarOnes(a: { downbeats: number[] }, track: SynthTrack) {
  const found = inMusic(a.downbeats, track);
  assert.ok(found.length >= track.downbeats.length - 1, `${found.length} of ${track.downbeats.length} bar ones found`);
  for (const t of found) assert.ok(distance(track.downbeats, t) < 0.025, `downbeat at ${t} s is not a bar one`);
}

test('128 BPM in 4/4 with a 4-bar intro without kick: tempo, beats to the millisecond, bar ones', { skip }, async () => {
  const { track, a } = await analyse({ bpm: 128, beatsPerBar: 4, bars: 16, kick: [0], snare: [2], hat: 0.5, introBars: 4 });
  assert.equal(a.version, 2);
  assert.ok(Math.abs(a.bpm - 128) <= 1, `read ${a.bpm} BPM`);
  assert.equal(a.beatsPerBar, 4);
  const beats = inMusic(a.beats, track);
  assert.ok(beats.length >= track.beats.length * 0.95, `${beats.length} of ${track.beats.length} beats found`);
  const error = median(beats.map((t) => distance(track.beats, t)));
  assert.ok(error < 0.025, `median beat error ${error * 1000} ms`);
  assertBarOnes(a, track);
  assert.ok(a.phrases.length > 0 && a.phrases.every((t) => a.downbeats.includes(t)));
  assert.ok(a.confidence >= 0.8, `confidence ${a.confidence}`);
  assert.equal(a.sections[0].start, 0);
  assert.equal(a.sections[a.sections.length - 1].end, a.duration);
  for (let i = 1; i < a.sections.length; i++) assert.equal(a.sections[i].start, a.sections[i - 1].end);
  assert.ok(a.waveform.length === 1000 && a.waveform.every((v) => v >= 0 && v <= 1));
});

test('3/4: three beats per bar, bar ones on the kick', { skip }, async () => {
  const { track, a } = await analyse({ bpm: 120, beatsPerBar: 3, bars: 20, kick: [0], snare: [1, 2], hat: 0.5 });
  assert.ok(Math.abs(a.bpm - 120) <= 1, `read ${a.bpm} BPM`);
  assert.equal(a.beatsPerBar, 3);
  assertBarOnes(a, track);
});

test('tempo octave guard: the same groove at 90 and 172 BPM, and 72 BPM with eighth hats', { skip }, async () => {
  const groove = { beatsPerBar: 4, kick: [0, 2.5], snare: [1, 3], hat: 0.5 };
  for (const spec of [
    // Read as 180 by the reference analyzer (the kick between beats 3 and 4 looked like a half-time reading).
    { ...groove, bpm: 90, bars: 12 },
    // Tempo estimation says 86; the snare between those beats is the backbeat of 172.
    { ...groove, bpm: 172, bars: 20 },
    // Tempo estimation says 144; nothing happens between those beats.
    { ...groove, bpm: 72, bars: 10, chords: true },
  ]) {
    const { track, a } = await analyse(spec);
    assert.ok(Math.abs(a.bpm - spec.bpm) <= 1, `${spec.bpm} BPM read as ${a.bpm}`);
    assertBarOnes(a, track);
  }
});

test('steady pulses are not halved: metronome and kick at 120, 128, 145 BPM; kick and backbeat at 128', { skip }, async () => {
  const pulse = { beatsPerBar: 4, bars: 16 };
  for (const bpm of [120, 128, 145]) {
    // A click on every beat and nothing else (no bass to find the bar ones by).
    const { a: metronome } = await analyse({ ...pulse, bpm, kick: [], hat: 1 });
    assert.ok(Math.abs(metronome.bpm - bpm) <= 1, `metronome at ${bpm} BPM read as ${metronome.bpm}`);
    // Four-on-the-floor kick, nothing between the beats.
    const { track, a } = await analyse({ ...pulse, bpm, kick: [0, 1, 2, 3], hat: 0 });
    assert.ok(Math.abs(a.bpm - bpm) <= 1, `kick-only at ${bpm} BPM read as ${a.bpm}`);
    assertBarOnes(a, track);
  }
  // Read as 64 with the beats on the snares before: nothing between the beats, but they do not alternate.
  const { track, a } = await analyse({ ...pulse, bpm: 128, kick: [0, 1, 2, 3], snare: [1, 3], hat: 0 });
  assert.ok(Math.abs(a.bpm - 128) <= 1, `kick and snare on 2 and 4 at 128 BPM read as ${a.bpm}`);
  assertBarOnes(a, track);
});

test('silence gives an empty grid', () => {
  const a = analyzeSignal(new Float32Array(22050 * 3), 22050);
  assert.deepEqual([a.beats, a.downbeats, a.phrases, a.accents], [[], [], [], []]);
  assert.equal(a.confidence, 0);
  assert.equal(a.sections[0].label, 'silence');
});

test('hits at irregular times give a low confidence', () => {
  const sr = 22050;
  const signal = new Float32Array(sr * 30);
  // Plucks 0.35-0.85 s apart (a fixed pseudo-random walk): no steady pulse.
  let t = 0.5;
  for (let k = 0; t < 29; k++) {
    const f = 220 * 2 ** (((k * 7) % 12) / 12);
    for (let i = 0; i < sr && t * sr + i < signal.length; i++) {
      signal[Math.floor(t * sr) + i] += 0.3 * Math.exp(-i / sr / 0.3) * Math.sin((2 * Math.PI * f * i) / sr);
    }
    t += 0.35 + 0.5 * (((k * 37) % 17) / 17);
  }
  assert.ok(analyzeSignal(signal, sr).confidence < 0.4);
});
