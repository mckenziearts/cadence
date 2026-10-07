// The burned-in caption layer: which cue it shows at a video time, cut to the width of the format.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Captions } from '../../src/frame/captions';
import { FORMATS, type FormatId, type VoiceOverLine } from '../../src/shared/types';

const lines = [
  { sceneId: 'a', text: 'Un.', start: 1, end: 2 },
  { sceneId: 'b', text: 'Deux.', start: 3, end: 4 },
];

/** The caption text drawn at `t`, or null when the layer draws nothing. */
function shown(t: number, voice: VoiceOverLine[] = lines, format: FormatId = '16:9'): string | null {
  const html = renderToStaticMarkup(<Captions lines={voice} spec={FORMATS[format]} t={t} />);
  return html ? /<span[^>]*>([^<]*)<\/span>/.exec(html)![1] : null;
}

test('Captions: a cue shows from its start, inclusive, until its end, exclusive', () => {
  assert.deepEqual(
    [0.999, 1, 1.999, 2].map((t) => shown(t)),
    [null, 'Un.', 'Un.', null],
  );
});

test('Captions: nothing before the first cue, between two cues, after the last or without sentences', () => {
  assert.deepEqual(
    [0, 2.5, 3.5, 4, 10].map((t) => shown(t)),
    [null, null, 'Deux.', null, null],
  );
  assert.equal(shown(1, []), null);
});

test('Captions: portrait and square cut a sentence into shorter cues than landscape', () => {
  // 73 characters: one cue in landscape (84), several in portrait (42) and square (48).
  const text = 'Cadence anime chaque scène au rythme de la musique, puis la voix raconte.';
  const voice = [{ sceneId: 'a', text, start: 0, end: 4 }];
  assert.equal(shown(0, voice, '16:9'), text);
  for (const [format, maxChars] of [
    ['9:16', 42],
    ['4:5', 42],
    ['1:1', 48],
  ] as const) {
    const first = shown(0, voice, format)!;
    assert.ok(first.length <= maxChars && text.startsWith(first), `${format}: ${first}`);
  }
});
