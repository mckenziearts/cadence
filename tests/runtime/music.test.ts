import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMusic } from '../../src/runtime/index';
import type { MusicGridData } from '../../src/shared/types';
import { createMusic as createFixtureMusic } from '../fixtures/runtime/index';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// 120 BPM track: 64 beats from 1.0 s (track time), 4/4, phrases every 4 bars.
const beats = Array.from({ length: 64 }, (_, i) => 1 + i * 0.5);
const grid: MusicGridData = {
  bpm: 120,
  beatsPerBar: 4,
  beats,
  downbeats: beats.filter((_, i) => i % 4 === 0),
  phrases: beats.filter((_, i) => i % 16 === 0),
  sections: [
    { start: 0, end: 9, label: 'intro', energy: 0.3 },
    { start: 9, end: 25, label: 'drop', energy: 0.9 },
    { start: 25, end: 33, label: 'outro', energy: 0.4 },
  ],
  accents: [
    { t: 3.5, strength: 0.8 },
    { t: 4.1, strength: 0.4 },
    { t: 20, strength: 1 },
  ],
  waveform: [],
  duration: 33,
  confidence: 0.9,
};

describe('music without a track', () => {
  const m = createMusic({ grid: null, tempo: 120, musicStart: 0, sceneStart: 10, sceneDuration: 3 });

  test('steady grid at the project tempo from the scene start', () => {
    assert.equal(m.hasTrack, false);
    assert.equal(m.bpm, 120);
    assert.equal(m.beatsPerBar, 4);
    close(m.beatLength, 0.5);
    close(m.barLength, 2);
    assert.deepEqual(m.beats, [0, 0.5, 1, 1.5, 2, 2.5, 3]);
    assert.deepEqual(m.downbeats, [0, 2]);
    assert.deepEqual(m.phrases, [0]);
    assert.deepEqual(m.sections, []);
    assert.deepEqual(m.accents, []);
  });

  test('beat, bar, phrase, bars', () => {
    close(m.beat(0), 0);
    close(m.beat(3), 1.5);
    close(m.beat(2.5), 1.25);
    close(m.beat(-1), -0.5);
    close(m.bar(1), 2);
    close(m.phrase(1), 8);
    close(m.bars(2), 4);
    close(m.bars(0.5), 1);
  });

  test('the frame e2e fixture beat() follows this rule', () => {
    for (const tempo of [120, 90]) {
      for (const sceneStart of [0, 10.25]) {
        const input = { grid: null, tempo, musicStart: 0, sceneStart, sceneDuration: 3 };
        const real = createMusic(input);
        const fixture = createFixtureMusic(input);
        assert.equal(fixture.beatLength, real.beatLength);
        for (const n of [-1, 0, 1, 2.5, 7]) close(fixture.beat(n), real.beat(n));
      }
    }
  });

  test('snap to every grid', () => {
    close(m.snap(0.9), 1);
    close(m.snap(0.9, 'bar'), 0);
    close(m.snap(1.2, 'bar'), 2);
    close(m.snap(3, 'phrase'), 0);
    close(m.snap(0.3, 'half'), 0.25);
    close(m.snap(0.2, 'quarter'), 0.25);
    close(m.snap(0.05, 'quarter'), 0);
    close(m.snap(-0.3), -0.5);
  });

  test('pulse and beatPhase', () => {
    close(m.pulse(0.5), 1);
    close(m.pulse(0.6), Math.exp(-0.6));
    close(m.pulse(0.6, { decay: 10 }), Math.exp(-1));
    close(m.pulse(2.25, { grid: 'bar' }), Math.exp(-6 * 0.25));
    close(m.pulse(0.25, { grid: 'half' }), 1);
    close(m.beatPhase(0.75), 0.5);
    close(m.beatPhase(1), 0);
  });

  test('other tempos, and invalid ones fall back to 120', () => {
    const slow = createMusic({ grid: null, tempo: 90, musicStart: 0, sceneStart: 0, sceneDuration: 4 });
    close(slow.beatLength, 2 / 3);
    close(slow.beat(3), 2);
    close(slow.bars(1), 8 / 3);
    const broken = createMusic({ grid: null, tempo: 0, musicStart: 0, sceneStart: 0, sceneDuration: 4 });
    close(broken.beatLength, 0.5);
  });
});

describe('music with a track', () => {
  test('grid is scene-local', () => {
    // Scene starts 3.25 s into the video; the video starts 0 s into the track.
    const m = createMusic({ grid, tempo: 100, musicStart: 0, sceneStart: 3.25, sceneDuration: 2 });
    assert.equal(m.hasTrack, true);
    assert.equal(m.bpm, 120);
    close(m.beatLength, 0.5);
    close(m.barLength, 2);
    close(m.beat(0), 0.25); // track beat at 3.5 s
    close(m.beat(0.5), 0.5);
    close(m.beat(-1), -0.25);
    close(m.bar(0), 1.75); // next downbeat at 5.0 s
    close(m.bar(-1), -0.25);
    close(m.phrase(0), 5.75); // next phrase at 9.0 s
    close(m.snap(0.9), 0.75);
    close(m.snap(0.9, 'bar'), 1.75);
    close(m.snap(0.4, 'half'), 0.5);
    assert.deepEqual(m.beats, [0.25, 0.75, 1.25, 1.75]);
    assert.deepEqual(m.downbeats, [1.75]);
    assert.deepEqual(m.phrases, []);
  });

  test('music start offset shifts the grid', () => {
    const m = createMusic({ grid, tempo: 120, musicStart: 1, sceneStart: 0, sceneDuration: 4 });
    close(m.beat(0), 0);
    close(m.bar(1), 2);
    close(m.phrase(1), 8);
  });

  test('a beat a few ms before the scene start counts as its first beat', () => {
    const m = createMusic({ grid, tempo: 120, musicStart: 0, sceneStart: 3.003, sceneDuration: 2 });
    close(m.beat(0), -0.003);
    close(m.bar(0), -0.003);
  });

  test('sections overlap the scene and accents fall inside it, in scene time', () => {
    const m = createMusic({ grid, tempo: 120, musicStart: 0, sceneStart: 3, sceneDuration: 7 });
    assert.deepEqual(
      m.sections.map((s) => [s.label, s.start, s.end]),
      [
        ['intro', -3, 6],
        ['drop', 6, 22],
      ],
    );
    assert.deepEqual(m.accents, [
      { t: 0.5, strength: 0.8 },
      { t: 1.1, strength: 0.4 },
    ]);
  });

  test('pulse fires on the track grid only', () => {
    const m = createMusic({ grid, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: 4 });
    assert.equal(m.pulse(0.5), 0); // before the first beat (1.0 s)
    close(m.pulse(1), 1);
    assert.ok(m.pulse(1.2) < 1 && m.pulse(1.2) > 0);
  });

  test('extrapolates past the end of the track, but lists and pulses nothing there', () => {
    const m = createMusic({ grid, tempo: 120, musicStart: 0, sceneStart: 100, sceneDuration: 3 });
    const b0 = m.beat(0);
    assert.ok(b0 >= -0.005 && b0 < 0.5 + 1e-9, `beat(0) = ${b0}`);
    close(m.beat(1) - m.beat(0), 0.5);
    close(m.bar(1) - m.bar(0), 2);
    assert.deepEqual(m.beats, []);
    assert.equal(m.pulse(1), 0);
  });

  test('missing downbeats and phrases fall back to bars of beats', () => {
    const m = createMusic({
      grid: { ...grid, downbeats: [], phrases: [] },
      tempo: 120,
      musicStart: 1,
      sceneStart: 0,
      sceneDuration: 4,
    });
    close(m.bar(1), 2);
    close(m.phrase(1), 8);
    assert.deepEqual(m.downbeats, [0, 2, 4]);
  });

  test('a grid with fewer than two beats is not a track', () => {
    const m = createMusic({ grid: { ...grid, beats: [1] }, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: 2 });
    assert.equal(m.hasTrack, false);
    close(m.beat(1), 0.5);
  });
});
