import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOverrides } from '../../server/music/grid';
import type { MusicAnalysis } from '../../src/shared/types';
import { steadyAnalysis } from './synth';

test('no override returns the analysis grid as it is', () => {
  const a = steadyAnalysis();
  const g = applyOverrides(a, {});
  assert.deepEqual(g, {
    bpm: 120,
    beatsPerBar: 4,
    beats: a.beats,
    downbeats: a.downbeats,
    phrases: a.phrases,
    sections: a.sections,
    accents: a.accents,
    waveform: a.waveform,
    duration: 34,
    confidence: 0.9,
  });
});

test('bpm re-grids the beats at the forced tempo from the first downbeat and keeps the rest', () => {
  const a = steadyAnalysis();
  const g = applyOverrides(a, { bpm: 100 });
  assert.equal(g.bpm, 100);
  assert.equal(g.beats[0], 1);
  for (let i = 1; i < g.beats.length; i++) assert.ok(Math.abs(g.beats[i] - g.beats[i - 1] - 0.6) < 1e-3);
  // Covers the span where the analysis found beats (1 to 33 s, half a beat of slack).
  assert.ok(g.beats.at(-1)! <= 33.3 && g.beats.at(-1)! > 32.6);
  assert.deepEqual(g.downbeats.slice(0, 3), [1, 3.4, 5.8]);
  // Phrases stay 4 bars long, in phase with the nearest new bar to the old phrase (9 s becomes 8.2 s).
  assert.deepEqual(g.phrases.slice(0, 3), [1, 8.2, 17.8]);
  assert.deepEqual(g.sections, a.sections);
  assert.deepEqual(g.accents, a.accents);
  assert.deepEqual(g.waveform, a.waveform);
});

test('beatsPerBar re-derives bar ones and phrases', () => {
  const g = applyOverrides(steadyAnalysis(), { beatsPerBar: 3 });
  assert.equal(g.beatsPerBar, 3);
  assert.deepEqual(g.downbeats.slice(0, 4), [1, 2.5, 4, 5.5]);
  assert.ok(g.downbeats.every((t) => g.beats.includes(t)));
  // 4-bar phrases (12 beats) in phase with the bar nearest the old phrase at 9 s; the music's start is only added
  // when the first phrase comes half a phrase or more after it.
  assert.deepEqual(g.phrases.slice(0, 3), [2.5, 8.5, 14.5]);
});

test('barOffset moves the bar ones later by whole beats', () => {
  const a = steadyAnalysis();
  const one = applyOverrides(a, { barOffset: 1 });
  assert.deepEqual(one.downbeats.slice(0, 3), [1.5, 3.5, 5.5]);
  assert.deepEqual(one.beats, a.beats);
  assert.equal(one.phrases[1], 9.5);
  const two = applyOverrides(a, { barOffset: 2 });
  assert.deepEqual(two.downbeats.slice(0, 2), [2, 4]);
  assert.equal(two.phrases[1], 10, 'half a bar away either way: the later bar wins');
});

test('gridOffset nudges beats, bar ones, phrases and inner section boundaries', () => {
  const a = steadyAnalysis();
  const g = applyOverrides(a, { gridOffset: 0.02 });
  assert.deepEqual(
    g.beats,
    a.beats.map((t) => Math.round((t + 0.02) * 10000) / 10000),
  );
  assert.equal(g.downbeats[0], 1.02);
  assert.equal(g.phrases[1], 9.02);
  assert.deepEqual(
    g.sections.map((s) => [s.start, s.end]),
    [
      [0, 9.02],
      [9.02, 34],
    ],
  );
  assert.deepEqual(g.accents, a.accents);
  // Times pushed before the track's start disappear.
  const early = applyOverrides({ ...a, beats: [0.1, ...a.beats] }, { gridOffset: -0.25 });
  assert.ok(early.beats.every((t) => t >= 0));
});

test('overrides combine', () => {
  const g = applyOverrides(steadyAnalysis(), { bpm: 90, beatsPerBar: 3, barOffset: 2, gridOffset: -0.01 });
  const beat = 60 / 90;
  assert.ok(Math.abs(g.beats[1] - g.beats[0] - beat) < 1e-3);
  assert.ok(Math.abs(g.downbeats[1] - g.downbeats[0] - 3 * beat) < 1e-3);
  // The anchor (first detected bar one, 1 s) moved two beats later, then everything 10 ms earlier.
  assert.ok(Math.abs(g.downbeats[0] - (1 + 2 * beat - 0.01)) < 1e-3);
});

test('out-of-range values from a hand-edited project.json are ignored', () => {
  const a = steadyAnalysis();
  const g = applyOverrides(a, { bpm: -5, beatsPerBar: 5, barOffset: 1.5, gridOffset: 3 });
  assert.deepEqual(g, applyOverrides(a, {}));
});

test('an analysis without beats keeps an empty grid but reports a forced tempo', () => {
  const silent: MusicAnalysis = { ...steadyAnalysis(), beats: [], downbeats: [], phrases: [] };
  const g = applyOverrides(silent, { bpm: 128, barOffset: 1 });
  assert.equal(g.bpm, 128);
  assert.deepEqual([g.beats, g.downbeats, g.phrases], [[], [], []]);
});
