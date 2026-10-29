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

describe('music.spectrum', () => {
  // 5 frames at 25 per second of track time: band b of frame f is f * 50 + b.
  const bytes = Uint8Array.from({ length: 5 * 24 }, (_, i) => Math.floor(i / 24) * 50 + (i % 24));
  const spectrum = { bands: 24, rate: 25, bytes };
  // The scene starts 0.04 s into the video, the video 0.02 s into the track: scene time t is track time t + 0.06.
  const m = createMusic({ grid, tempo: 120, musicStart: 0.02, sceneStart: 0.04, sceneDuration: 1, spectrum });
  const level = (frame: number, band: number) => (frame * 50 + band) / 255;

  test('gives the 24 bands 0 to 1 at a scene time, shifted like the beat grid and interpolated between frames', () => {
    const at = m.spectrum(0.01); // track 0.07 s: frame 1.75
    assert.equal(at.length, 24);
    close(at[0], (0.25 * 50 + 0.75 * 100) / 255);
    close(at[23], (0.25 * 73 + 0.75 * 123) / 255);
    const first = m.spectrum(-0.06); // track 0 s: frame 0
    close(first[0], 0);
    close(first[5], level(0, 5));
    const last = m.spectrum(0.1); // track 0.16 s: the last frame
    close(last[23], level(4, 23));
  });

  test('is all zeros before and after the track', () => {
    assert.deepEqual(m.spectrum(-0.07), Array(24).fill(0));
    assert.deepEqual(m.spectrum(0.11), Array(24).fill(0));
  });

  test('averages the bands into 1 to 24 groups, lowest first', () => {
    const frame = 2;
    const t = frame / 25 - 0.06;
    const four = m.spectrum(t, 4);
    assert.equal(four.length, 4);
    for (const [g, value] of four.entries()) close(value, level(frame, 6 * g + 2.5));
    const five = m.spectrum(t, 5); // groups of 4, 5, 5, 5, 5 bands
    close(five[0], level(frame, 1.5));
    close(five[4], level(frame, 21));
    close(m.spectrum(t, 1)[0], level(frame, 11.5));
    assert.deepEqual(m.spectrum(t, 24), m.spectrum(t));
  });

  test('refuses a band count outside 1 to 24', () => {
    for (const bands of [0, 25, 2.5, Number.NaN]) assert.throws(() => m.spectrum(0, bands), RangeError);
  });

  test('comes from the track even when its beat grid is unusable', () => {
    const noGrid = createMusic({ grid: null, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: 1, spectrum });
    assert.equal(noGrid.hasTrack, false);
    close(noGrid.spectrum(0.08)[3], level(2, 3));
  });

  test('is all zeros without a track', () => {
    const silent = createMusic({ grid: null, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: 1 });
    assert.deepEqual(silent.spectrum(0.5), Array(24).fill(0));
    assert.deepEqual(silent.spectrum(0.5, 3), [0, 0, 0]);
  });

  test('throws the error it is given while the analysis runs', () => {
    const pending = Object.assign(new Error('analysis running'), { name: 'MusicAnalysisPending' });
    const waiting = createMusic({ grid: null, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: 1, spectrum: pending });
    assert.throws(() => waiting.spectrum(0), { name: 'MusicAnalysisPending', message: 'analysis running' });
    assert.throws(() => waiting.spectrum(0, 4), { name: 'MusicAnalysisPending' });
  });
});
