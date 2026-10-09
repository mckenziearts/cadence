// The burned-in caption layer: which cue it shows at a video time, cut to the width of the format.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Captions } from '../../src/frame/captions';
import { FORMATS, type FormatId, type Speaker, type VoiceOverLine } from '../../src/shared/types';

const lines = [
  { sceneId: 'a', text: 'Un.', start: 1, end: 2, speaker: null, words: [], level: [] },
  { sceneId: 'b', text: 'Deux.', start: 3, end: 4, speaker: null, words: [], level: [] },
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
  const voice = [{ sceneId: 'a', text, start: 0, end: 4, speaker: null, words: [], level: [] }];
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

const ana = { id: 'ana', name: 'Ana', voice: 'v', color: '#ff8800' };
const dialogue: VoiceOverLine[] = [
  {
    sceneId: 'a',
    text: 'Le chat dort, le chien veille.',
    start: 1,
    end: 3,
    speaker: 'ana',
    words: ['Le', 'chat', 'dort,', 'le', 'chien', 'veille.'].map((text, i) => ({
      text,
      start: 1 + i * 0.3,
      end: 1.25 + i * 0.3,
    })),
    level: [],
  },
];

/** The caption markup drawn at `t` with the project's speakers. */
function drawn(t: number, voice: VoiceOverLine[], speakers: Speaker[], format: FormatId = '16:9'): string {
  return renderToStaticMarkup(<Captions lines={voice} speakers={speakers} spec={FORMATS[format]} t={t} />);
}

test("Captions: the word said at t takes its speaker's color, and only that occurrence of it", () => {
  const html = drawn(1.95, dialogue, [ana]);
  assert.match(html, /<span[^>]*>Le chat dort, <span style="color:#ff8800">le<\/span> chien veille\.<\/span>/);
  assert.match(drawn(1.05, dialogue, [ana]), /<span style="color:#ff8800">Le<\/span> chat/);
});

test('Captions: the colored word is found in the cue a long sentence is cut into', () => {
  // 61 characters in 9:16 (42 a cue): 'Le chat dort sur le canapé,' then 'le chien veille près de la porte.'
  const text = 'Le chat dort sur le canapé, le chien veille près de la porte.';
  const tokens = text.split(' ');
  const long = [
    { ...dialogue[0], text, end: 2.2, words: tokens.map((word, i) => ({ text: word, start: 1 + i * 0.1, end: 1.08 + i * 0.1 })) },
  ];
  const sixth = drawn(1 + 6 * 0.1 + 0.01, long, [ana], '9:16');
  assert.match(sixth, /<span style="color:#ff8800">le<\/span> chien/);
  assert.doesNotMatch(sixth, /canapé/);
});

test('Captions: the cues of a long sentence follow its words when the voice speeds up', () => {
  // 'Le chat dort sur le canapé,' is said at 0.25 s a word, 'le chien veille près de la porte.' at 0.1 s: cut in
  // proportion to the characters, the second cue would show from 1.945, while 'le' and 'canapé,' are still said.
  const text = 'Le chat dort sur le canapé, le chien veille près de la porte.';
  const words = text.split(' ').map((word, i) => {
    const start = i < 6 ? 1 + i * 0.25 : 2.5 + (i - 6) * 0.1;
    return { text: word, start, end: start + (i < 6 ? 0.2 : 0.08) };
  });
  const uneven = [{ ...dialogue[0], text, end: 3.1, words }];
  assert.match(drawn(2.005, uneven, [ana], '9:16'), /sur <span style="color:#ff8800">le<\/span> canapé,<\/span>/);
  assert.match(drawn(2.255, uneven, [ana], '9:16'), /le <span style="color:#ff8800">canapé,<\/span><\/span>/);
  assert.match(drawn(2.505, uneven, [ana], '9:16'), /<span style="color:#ff8800">le<\/span> chien/);
});

test('Captions: a word cut across two cues is not colored in either', () => {
  // The address is longer than a 9:16 cue (42): its first 42 characters show in one cue, the rest in the next.
  const url = 'https://cadence.example/projets/un-chemin-vraiment-long';
  const cut = [
    {
      ...dialogue[0],
      text: `Voir ${url} ici.`,
      end: 2.6,
      words: [
        { text: 'Voir', start: 1, end: 1.2 },
        { text: url, start: 1.3, end: 2.3 },
        { text: 'ici.', start: 2.4, end: 2.6 },
      ],
    },
  ];
  const plain = (t: number) => renderToStaticMarkup(<Captions lines={cut} spec={FORMATS['9:16']} t={t} />);
  assert.equal(shown(1.35, cut, '9:16'), url.slice(0, 42));
  assert.equal(drawn(1.35, cut, [ana], '9:16'), plain(1.35));
  assert.ok(shown(2.25, cut, '9:16')!.startsWith(url.slice(42)));
  assert.equal(drawn(2.25, cut, [ana], '9:16'), plain(2.25));
  assert.match(drawn(2.45, cut, [ana], '9:16'), /<span style="color:#ff8800">ici\.<\/span>/);
});

test('Captions: a word keeps its color until the next one starts, none before the first', () => {
  // Spoken words leave a few hundredths of a second between them: the color would blink off at every one.
  assert.match(drawn(1.27, dialogue, [ana]), /<span style="color:#ff8800">Le<\/span> chat/);
  const late = [{ ...dialogue[0], start: 0.8 }];
  const plain = (t: number) => renderToStaticMarkup(<Captions lines={late} spec={FORMATS['16:9']} t={t} />);
  assert.equal(drawn(0.9, late, [ana]), plain(0.9));
});

test('Captions: French punctuation spaced off its word never takes the color, the word before it keeps it', () => {
  const text = 'Il dit «\u00a0oui\u00a0»\u00a0: on part\u00a0!';
  const words = text.split(/\s/).map((word, i) => ({ text: word, start: 1 + i * 0.2, end: 1.15 + i * 0.2 }));
  const french = [{ ...dialogue[0], text, words }];
  const colored = (t: number) => /<span style="color:#ff8800">([^<]*)<\/span>/.exec(drawn(t, french, [ana]))?.[1];
  assert.deepEqual([1.45, 1.65, 1.85, 2.05, 2.25, 2.65, 2.95].map(colored), ['dit', 'oui', 'oui', 'oui', 'on', 'part', 'part']);
});

test('Captions: the word said is colored in a cue that repeats an earlier cue of its sentence', () => {
  // 63 characters in 9:16 (42 a cue): two identical cues, 'On y va tous ensemble, on y va.'
  const text = 'On y va tous ensemble, on y va. On y va tous ensemble, on y va.';
  const words = text.split(' ').map((word, i) => ({ text: word, start: 1 + i * 0.1, end: 1.08 + i * 0.1 }));
  const twice = [{ ...dialogue[0], text, end: 2.6, words }];
  assert.match(drawn(1.05, twice, [ana], '9:16'), /<span[^>]*><span style="color:#ff8800">On<\/span> y va tous/);
  assert.match(drawn(1.95, twice, [ana], '9:16'), /<span[^>]*>On <span style="color:#ff8800">y<\/span> va tous/);
});

test('Captions: no colored word for a speaker without color, or without speakers', () => {
  const plain = (t: number) => renderToStaticMarkup(<Captions lines={dialogue} spec={FORMATS['16:9']} t={t} />);
  assert.equal(drawn(1.95, dialogue, [{ ...ana, color: undefined }]), plain(1.95));
  assert.equal(drawn(1.95, dialogue, []), plain(1.95));
  assert.equal(drawn(1.95, [{ ...dialogue[0], speaker: null }], [ana]), plain(1.95));
  assert.equal(shown(1.95, dialogue), 'Le chat dort, le chien veille.');
});

test('Captions: when two sentences overlap, the word of the one started last takes its own speaker color', () => {
  // A voice can run past its scene's end into the next scene's first sentence: the cue on screen is the later one.
  const ben = { id: 'ben', name: 'Ben', voice: 'w', color: '#00ff00' };
  const timed = (texts: string[], from: number, step: number) =>
    texts.map((text, i) => ({ text, start: from + i * step, end: from + i * step + step * 0.8 }));
  const overlap: VoiceOverLine[] = [
    { ...dialogue[0], end: 4, words: timed(['Le', 'chat', 'dort,', 'le', 'chien', 'veille.'], 1, 0.5) },
    { sceneId: 'b', text: 'Oui bien.', start: 2, end: 3, speaker: 'ben', words: timed(['Oui', 'bien.'], 2.2, 0.3), level: [] },
  ];
  assert.match(drawn(2.3, overlap, [ana, ben]), /<span[^>]*><span style="color:#00ff00">Oui<\/span> bien\.<\/span>/);
  const after = drawn(3.2, overlap, [ana, ben]);
  assert.match(after, /le <span style="color:#ff8800">chien<\/span> veille\.<\/span>/);
  assert.doesNotMatch(after, /#00ff00/);
});
