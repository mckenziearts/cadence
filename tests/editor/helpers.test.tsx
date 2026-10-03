// Pure helpers of the editor: French formatting, music grid marks, seam tones, light markdown.
// node --import tsx --test tests/editor/helpers.test.tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MusicGridData, ProjectState, SceneState } from '../../src/shared/types';
import {
  bars,
  bytes,
  day,
  elapsed,
  parseDecimal,
  parseDuration,
  percent,
  percentShort,
  relative,
  seamShare,
  seamTone,
  secs,
  secsLabel,
  setFormatLanguage,
  tokenCount,
  usd,
} from '../../src/editor/lib/format';
import { Markdown } from '../../src/editor/lib/markdown';
import { barDrift, frameStart, playbackTime, rulerStep, sceneBars, timelineMarks } from '../../src/editor/lib/timeline';

const S = ' ';

test('French number formats', () => {
  assert.equal(secs(2.2222), '2,22');
  assert.equal(secsLabel(3.32), `3,32${S}s`);
  assert.equal(usd(0.48), `0,48${S}$`);
  assert.equal(usd(0), `0,00${S}$`);
  assert.equal(usd(0.004), `<${S}0,01${S}$`);
  assert.equal(percent(0.001), `0${S}%`);
  assert.equal(percent(0.12), `0,12${S}%`);
  assert.equal(percent(12.5), `12,5${S}%`);
  assert.equal(percentShort(2.79), `2,8${S}%`);
  assert.equal(percentShort(34.2), `34${S}%`);
  // The seam badge draws its own % sign and stays within one decimal.
  assert.equal(seamShare(0.03), '0');
  assert.equal(seamShare(0.12), '0,1');
  assert.equal(seamShare(34.2), '34');
  assert.equal(bars(2), `2${S}mes.`);
  assert.equal(bars(1.66), `1,7${S}mes.`);
  assert.equal(bytes(820), `820${S}o`);
  assert.equal(bytes(350 * 1024), `350${S}ko`);
  assert.equal(bytes(1.2 * 1024 * 1024), `1,2${S}Mo`);
  assert.equal(elapsed(14_000), `14${S}s`);
  assert.equal(elapsed(65_000), `1${S}min 05${S}s`);
});

test('token counts and days, in French then in English', () => {
  assert.equal(tokenCount(820), '820');
  assert.equal(tokenCount(87_021), `87${S}k`);
  assert.equal(tokenCount(999_600), `1${S}M`);
  assert.equal(tokenCount(4_564_662), `4,6${S}M`);
  assert.equal(day(new Date(2026, 9, 1, 12).toISOString()), '1 oct.');
  setFormatLanguage('en');
  try {
    assert.equal(tokenCount(87_021), '87K');
    assert.equal(tokenCount(4_564_662), '4.6M');
    assert.equal(day(new Date(2026, 9, 1, 12).toISOString()), 'Oct 1');
  } finally {
    setFormatLanguage('fr');
  }
});

test('relative times and typed decimals', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(relative(ago(10), now), 'à l’instant');
  assert.equal(relative(ago(300), now), `il y a 5${S}min`);
  assert.equal(relative(ago(3 * 3600), now), `il y a 3${S}h`);
  assert.equal(parseDecimal('2,5'), 2.5);
  assert.equal(parseDecimal(' 2.5 s'), 2.5);
  assert.ok(Number.isNaN(parseDecimal('')));
  assert.ok(Number.isNaN(parseDecimal('abc')));
});

test("scene durations can be typed in bars of the scene's grid", () => {
  assert.equal(parseDuration('2 mes.', 1.875), 3.75);
  assert.equal(parseDuration('1,5 mesure', 2), 3);
  assert.equal(parseDuration('3 mesures', 2), 6);
  assert.equal(parseDuration('2mes', 2), 4);
  assert.equal(parseDuration('2,5', 2), 2.5);
  assert.equal(parseDuration('2.5 s', 2), 2.5);
  assert.ok(Number.isNaN(parseDuration('deux mesures', 2)));
});

test('a cut is invisible below 0,05 % of changed pixels, then amber, then red from 5 %', () => {
  const seam = (diffPercent: number, error?: string) => ({
    from: 'a',
    to: 'b',
    format: '16:9' as const,
    diffPercent,
    checkedAt: '',
    error,
  });
  assert.equal(seamTone(undefined), 'unknown');
  assert.equal(seamTone(seam(0, 'capture impossible')), 'error');
  assert.equal(seamTone(seam(0)), 'clean');
  assert.equal(seamTone(seam(0.049)), 'clean');
  assert.equal(seamTone(seam(0.05)), 'jump');
  // The old « faint » tier (0,005-0,3 %) read visible font or colour jumps as anti-aliasing noise.
  assert.equal(seamTone(seam(0.21)), 'jump');
  assert.equal(seamTone(seam(4.9)), 'jump');
  assert.equal(seamTone(seam(5)), 'cut');
});

function project(durations: number[], musicGrid: MusicGridData | null = null, start = 0): ProjectState {
  let t = 0;
  const scenes: SceneState[] = durations.map((duration, index) => {
    const scene = {
      id: `s${index}`,
      name: `Scène ${index}`,
      duration,
      index,
      start: t,
      file: '',
      url: '',
      codeVersion: 'x',
    };
    t += duration;
    return scene;
  });
  return {
    id: 'demo',
    dir: '/tmp/demo',
    name: 'Démo',
    brand: null,
    fps: 30,
    formats: ['16:9'],
    tempo: 120,
    language: null,
    scenes,
    duration: t,
    music: musicGrid ? { file: 'music/a.mp3', start, volume: 1 } : null,
    musicUrl: null,
    musicGrid,
    voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 },
    voiceOverUrl: null,
    voiceOverLines: [],
    voiceOverPending: [],
    voiceOverError: null,
    codeGeneration: 0,
    createdAt: '',
    updatedAt: '',
  };
}

test('grid marks without music: steady tempo restarting at every scene', () => {
  const p = project([2, 2]);
  const one = timelineMarks(p, p.scenes[0]);
  assert.deepEqual(one.phrases, [0]);
  assert.deepEqual(one.bars, [2]);
  assert.deepEqual(one.beats, [0.5, 1, 1.5]);
  assert.deepEqual(one.cuts, []);
  const whole = timelineMarks(p, null);
  assert.deepEqual(whole.phrases, [0, 2]);
  assert.deepEqual(
    whole.cuts.map((c) => c.t),
    [2],
  );
  assert.equal(sceneBars(p, p.scenes[0]), 1);
});

test('grid marks with a track follow the track grid, offset by music start and scene start', () => {
  const grid: MusicGridData = {
    bpm: 120,
    beatsPerBar: 4,
    beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
    downbeats: [0, 2, 4],
    phrases: [0, 4],
    sections: [],
    accents: [],
    waveform: [],
    duration: 5,
    confidence: 1,
  };
  // Video t=0 is track t=1; the second scene starts at video 1.5 = track 2.5.
  const p = project([1.5, 2], grid, 1);
  const second = timelineMarks(p, p.scenes[1]);
  assert.deepEqual(second.phrases, [1.5]);
  assert.deepEqual(second.beats, [0, 0.5, 1, 2]);
  assert.deepEqual(second.bars, []);
  assert.equal(rulerStep(4, 400), 1);
  assert.equal(rulerStep(60, 400), 10);
});

test('a scene is flagged when its cut is off a bar line of its grid', () => {
  // No track: 120 BPM, 1 bar = 2 s from each scene start.
  const steady = project([3.5, 4, 4.03]);
  assert.equal(barDrift(steady, steady.scenes[0]), -0.5);
  assert.equal(barDrift(steady, steady.scenes[1]), null);
  assert.equal(barDrift(steady, steady.scenes[2]), null, 'within 2 % of a bar');
  // Track bars at 0.5, 2.5, 4.5... (2 s each): the first scene holds the 0.5 s lead-in and still cuts on a bar line.
  const grid: MusicGridData = {
    bpm: 120,
    beatsPerBar: 4,
    beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5],
    downbeats: [0.5, 2.5, 4.5, 6.5],
    phrases: [0.5],
    sections: [],
    accents: [],
    waveform: [],
    duration: 7,
    confidence: 1,
  };
  const track = project([2.5, 2, 1.9], grid);
  assert.equal(sceneBars(track, track.scenes[0]), 1.25);
  assert.equal(barDrift(track, track.scenes[0]), null);
  assert.equal(barDrift(track, track.scenes[1]), null);
  assert.ok(Math.abs(barDrift(track, track.scenes[2])! + 0.1) < 1e-9, 'the last cut lands 0.1 s before bar 4');
});

test('the playhead moves by whole frames, at the times the export renders', () => {
  assert.equal(frameStart(0, 30), 0);
  assert.equal(frameStart(0.05, 30), 1 / 30);
  assert.equal(frameStart(1.16, 25), 1.16, '1.16 * 25 is 28.999999999999996: still frame 29');
  assert.equal(frameStart(Math.round(1e6 / 30) / 1e6, 30), 1 / 30, 'a frame step, rounded to the µs, stays on its frame');
  assert.equal(frameStart(1.999, 60), 119 / 60);
});

test('playback follows the display, and the track once they part by more than a frame', () => {
  assert.equal(playbackTime(1, 0.016, null, 60), 1.016);
  assert.equal(playbackTime(1, 0.016, 1.02, 60), 1.016, 'a few ms of audio jitter: the display keeps the pace');
  assert.equal(playbackTime(1, 0.016, 1.04, 60), 1.04, 'more than a frame apart: back to the sound');
  assert.equal(playbackTime(1, 0.016, 0.98, 60), 0.98);
});

test('markdown renders structure and never raw HTML', () => {
  const html = renderToStaticMarkup(
    <Markdown text={'J’ai **décalé** le `titre`.\n\n- un\n- deux\n\n```\nconst a = 1;\n```\n\n<script>alert(1)</script>'} />,
  );
  assert.match(html, /<strong>décalé<\/strong>/);
  assert.match(html, /<code>titre<\/code>/);
  assert.match(html, /<ul><li>un<\/li><li>deux<\/li><\/ul>/);
  assert.match(html, /<pre><code>const a = 1;<\/code><\/pre>/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
