// Pure helpers of the editor: French formatting, music grid marks, seam tones, light markdown.
// node --import tsx --test tests/editor/helpers.test.tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MusicGridData, ProjectState, SceneState, ScriptLine, Speaker } from '../../src/shared/types';
import { frameErrors } from '../../src/editor/components/FrameView';
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
import { projectsPage } from '../../src/editor/lib/pages';
import { barDrift, frameStart, playbackTime, rulerStep, sceneBars, timelineMarks } from '../../src/editor/lib/timeline';
import {
  editLine,
  lineTimes,
  moveLine,
  nextLineSpeaker,
  nextSpeaker,
  onVoice,
  voiceOverUpdate,
} from '../../src/editor/lib/voiceOver';

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
    captions: false,
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

test('frame errors: a list of texts passes, anything else scene code posts is refused', () => {
  assert.deepEqual(frameErrors(['a', 'b']), ['a', 'b']);
  assert.deepEqual(frameErrors([]), []);
  for (const value of [undefined, null, 1, 'a', {}, [{}], [null, 'x'], [1]]) assert.equal(frameErrors(value), null);
});

test('voice-over edits in Voix: a text draft never replaces saved lines, a new start keeps them', () => {
  const lines = [{ id: 'l1', speaker: 'ana', text: 'Salut.' }];
  const dialogue = { text: 'Salut.', at: 1, lines };
  assert.equal(voiceOverUpdate(dialogue, { text: 'Autre chose' }), undefined);
  assert.equal(voiceOverUpdate(dialogue, { text: '' }), undefined);
  assert.deepEqual(voiceOverUpdate(dialogue, { at: 2.5 }), { lines, at: 2.5 });
  assert.equal(voiceOverUpdate(dialogue, { at: 1 }), undefined);

  const sentence = { text: 'Bonjour.', at: 0.5 };
  assert.deepEqual(voiceOverUpdate(sentence, { text: '  Bonsoir.  ' }), { text: 'Bonsoir.', at: 0.5 });
  assert.equal(voiceOverUpdate(sentence, { text: 'Bonjour. ' }), undefined);
  assert.equal(voiceOverUpdate(sentence, { text: '   ' }), null);
  assert.deepEqual(voiceOverUpdate(sentence, { at: 3 }), { text: 'Bonjour.', at: 3 });
  assert.equal(voiceOverUpdate(sentence, { at: 0.5 }), undefined);

  assert.deepEqual(voiceOverUpdate(undefined, { text: 'Premier jet' }), { text: 'Premier jet', at: 0 });
  assert.equal(voiceOverUpdate(undefined, { text: ' ' }), undefined);
  assert.equal(voiceOverUpdate(undefined, { at: 2 }), undefined);
});

test('voice-over lines in Voix: sent whole with the start, unchanged sends nothing, none left removes the voice-over', () => {
  const lines = [{ id: 'l1', speaker: 'ana', text: 'Salut.', gesture: 'wave' }];
  const dialogue = { text: 'Salut.', at: 1, lines };
  const more = [...lines, { speaker: 'bob', text: 'Bonjour.' }];
  assert.deepEqual(voiceOverUpdate(dialogue, { lines: more }), { lines: more, at: 1 });
  assert.equal(voiceOverUpdate(dialogue, { lines: [{ ...lines[0] }] }), undefined);
  assert.equal(voiceOverUpdate(dialogue, { lines: [] }), null);
  assert.deepEqual(voiceOverUpdate(undefined, { lines }), { lines, at: 0 });
  assert.equal(voiceOverUpdate(undefined, { lines: [] }), undefined);
  assert.deepEqual(voiceOverUpdate({ text: 'Bonjour.', at: 2 }, { lines }), { lines, at: 2 });
});

test('script lines in Voix: a new line goes to the next speaker, times come from its sentences', () => {
  const speakers = [{ id: 'ana' }, { id: 'bob' }, { id: 'cy' }];
  assert.equal(nextLineSpeaker(speakers, []), 'ana');
  assert.equal(nextLineSpeaker(speakers, [{ speaker: 'ana' }]), 'bob');
  assert.equal(nextLineSpeaker(speakers, [{ speaker: 'bob' }, { speaker: 'cy' }]), 'ana');
  assert.equal(nextLineSpeaker(speakers, [{ speaker: 'gone' }]), 'ana');

  const sentence = (line: number | undefined, start: number, end: number) => ({
    start,
    end,
    ...(line !== undefined && { line }),
  });
  // Line 1 is two sentences; line 2 is a tag alone, which Piper does not speak.
  const said = [sentence(0, 2, 3), sentence(1, 3.2, 4), sentence(1, 4, 5.5), sentence(3, 6, 7)];
  assert.deepEqual(lineTimes(said, 4), [{ start: 2, end: 3 }, { start: 3.2, end: 5.5 }, null, { start: 6, end: 7 }]);
  assert.deepEqual(lineTimes([], 2), [null, null]);
});

test('script lines in Voix: a change finds its line by id, so a second click before the save acts on the same line', () => {
  const lines = [
    { id: 'un', speaker: 'ana', text: 'Un.' },
    { id: 'deux', speaker: 'bob', text: 'Deux.' },
    { id: 'trois', speaker: 'ana', text: 'Trois.' },
  ];
  const remove = (list: ScriptLine[], i: number) => list.filter((_, j) => j !== i);
  const once = editLine(lines, 'un', remove);
  assert.deepEqual(once, lines.slice(1));
  assert.equal(editLine(once, 'un', remove), once, 'a line already gone takes no other one with it');
  const toAna = (list: ScriptLine[], i: number) => list.map((line, j) => (j === i ? { ...line, speaker: 'ana' } : line));
  assert.deepEqual(editLine(once, 'deux', toAna), [{ id: 'deux', speaker: 'ana', text: 'Deux.' }, lines[2]]);
  const edited = lines.map((line, i) => (i === 1 ? { ...line, text: 'Deux, plutôt.' } : line));
  assert.deepEqual(editLine(edited, 'deux', remove), [lines[0], lines[2]], 'a line whose text changed is still found');

  const texts = (list: ScriptLine[]) => list.map((line) => line.text);
  const down = moveLine(lines, 'un', 1);
  assert.deepEqual(texts(down), ['Deux.', 'Un.', 'Trois.']);
  assert.deepEqual(texts(moveLine(down, 'un', 1)), ['Deux.', 'Trois.', 'Un.'], 'a second click moves the same line again');
  const up = moveLine(lines, 'deux', -1);
  assert.deepEqual(texts(up), ['Deux.', 'Un.', 'Trois.']);
  assert.equal(moveLine(up, 'deux', -1), up, 'the first line goes no higher');
  assert.equal(moveLine(lines, 'trois', 1), lines, 'the last line goes no lower');
  assert.equal(moveLine(lines, 'quatre', 1), lines);
});

test('speakers in Voix: a new one takes the lowest free id and the first free color, an engine switch moves all onto one voice', () => {
  const name = (n: number) => `Locuteur ${n}`;
  const first = nextSpeaker([], 'fr_FR-siwis-medium', name);
  assert.deepEqual(first, { id: 'speaker-1', name: 'Locuteur 1', voice: 'fr_FR-siwis-medium', color: '#e4572e' });

  const list = [
    { id: 'speaker-2', name: 'Ana', voice: 'a', color: '#e4572e' },
    { id: 'speaker-3', name: 'Ben', voice: 'b', color: '#f2a541' },
  ];
  assert.deepEqual(nextSpeaker(list, 'c', name), { id: 'speaker-1', name: 'Locuteur 1', voice: 'c', color: '#2e86ab' });
  assert.equal(nextSpeaker([...list, { id: 'speaker-1', name: 'Cy', voice: 'c' }], 'c', name).id, 'speaker-4');

  const full: Speaker[] = [];
  for (let i = 0; i < 10; i++) full.push(nextSpeaker(full, 'v', name));
  assert.equal(new Set(full.map((s) => s.color)).size, 10);
  assert.equal(nextSpeaker(full, 'v', name).color, undefined);

  const moved = onVoice([{ id: 'ana', name: 'Ana', voice: 'el-1', model: 'eleven_v3', color: '#e4572e' }], 'fr_FR-siwis-medium');
  assert.deepEqual(moved, [{ id: 'ana', name: 'Ana', voice: 'fr_FR-siwis-medium', color: '#e4572e' }]);
});

test('projects home pages: 11 projects next to the new-project card, then 12 a page, never past the last', () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.deepEqual(projectsPage(ids, 1), { projects: ids.slice(0, 11), page: 1, pages: 3 });
  assert.deepEqual(projectsPage(ids, 2), { projects: ids.slice(11, 23), page: 2, pages: 3 });
  assert.deepEqual(projectsPage(ids, 3), { projects: ids.slice(23), page: 3, pages: 3 });
  // A deletion that empties the page shown goes to the one before.
  assert.deepEqual(projectsPage(ids.slice(0, 23), 3), { projects: ids.slice(11, 23), page: 2, pages: 2 });
  assert.deepEqual(projectsPage(ids.slice(0, 12), 2), { projects: [12], page: 2, pages: 2 });
  assert.deepEqual(projectsPage(ids.slice(0, 11), 1), { projects: ids.slice(0, 11), page: 1, pages: 1 });
  assert.deepEqual(projectsPage([], 1), { projects: [], page: 1, pages: 1 });
});
