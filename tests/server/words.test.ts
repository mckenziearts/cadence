// Word timings of a spoken sentence: from the engine's character alignment, or in proportion to the characters.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { stripAudioTags, wordsByProrata, wordsFromAlignment, type Alignment } from '../../server/voiceover/words';

interface Recorded {
  responses: { text: string; body: { alignment: Alignment; normalized_alignment: Alignment } }[];
}

async function recorded(text: string) {
  const file = path.join(import.meta.dirname, '../fixtures/elevenlabs/with-timestamps.json');
  const { responses } = JSON.parse(await fs.readFile(file, 'utf8')) as Recorded;
  return responses.find((r) => r.text === text)!.body;
}

/** One entry per character of `text`, each `step` seconds long. */
function evenAlignment(text: string, step = 1): Alignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * step),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
  };
}

const texts = (words: { text: string }[]) => words.map((w) => w.text);

test('stripAudioTags removes the tags and the spaces they leave', () => {
  assert.equal(stripAudioTags('[surprised] Tu as vu le prix ?'), 'Tu as vu le prix ?');
  assert.equal(stripAudioTags("Bon [laughs] d'accord [sighs]"), "Bon d'accord");
  assert.equal(stripAudioTags('Bon [laughs], on y va.'), 'Bon, on y va.');
  assert.equal(stripAudioTags('[whispers]'), '');
  assert.equal(stripAudioTags('Un café à 4,99 €.'), 'Un café à 4,99 €.');
});

test('a tag stuck to the next word still separates the words around it', () => {
  assert.equal(stripAudioTags('Oui [laughs]bien'), 'Oui bien');
  assert.equal(stripAudioTags('Oui[laughs]bien'), 'Oui bien');
  assert.equal(stripAudioTags('Oui[laughs] bien'), 'Oui bien');
  assert.equal(stripAudioTags('[sighs]Bien.'), 'Bien.');
  const text = 'Oui [laughs]bien';
  assert.deepEqual(wordsFromAlignment(text, evenAlignment(text)), [
    { text: 'Oui', start: 0, end: 3 },
    { text: 'bien', start: 12, end: 16 },
  ]);
  assert.deepEqual(texts(wordsByProrata(text, 8)), ['Oui', 'bien']);
});

test('opening punctuation right after a tag starts the next word', () => {
  assert.equal(stripAudioTags('Il dit [whispers]«non»'), 'Il dit «non»');
  assert.equal(stripAudioTags('Bon [sighs](rire) ok'), 'Bon (rire) ok');
  assert.equal(stripAudioTags('Il dit [whispers]"non"'), 'Il dit "non"');
  assert.equal(stripAudioTags("Il dit [whispers]'non'"), "Il dit 'non'");
  assert.equal(stripAudioTags('Bon [laughs]¡vale!'), 'Bon ¡vale!');
  assert.equal(stripAudioTags('Y [sighs]¿por qué?'), 'Y ¿por qué?');
  const text = 'Il dit [whispers]«non»';
  assert.deepEqual(texts(wordsFromAlignment(text, evenAlignment(text))), ['Il', 'dit', '«non»']);
  assert.deepEqual(texts(wordsByProrata('Il dit [whispers]"non"', 8)), ['Il', 'dit', '"non"']);
});

test('closing punctuation right after a tag stays on the word before it', () => {
  assert.equal(stripAudioTags('Bon [laughs]. Ok [sighs]! Quoi [whispers]? Hmm [sighs]\u2026'), 'Bon. Ok! Quoi? Hmm\u2026');
  assert.equal(stripAudioTags('«Non [laughs]» (rire [sighs]) ah [sighs];'), '«Non» (rire) ah;');
});

test('wordsFromAlignment: the real answer keeps "4,99" as said, timed by `alignment`', async () => {
  const { alignment } = await recorded('Un café à 4,99 €.');
  assert.deepEqual(wordsFromAlignment('Un café à 4,99 €.', alignment), [
    { text: 'Un', start: 0, end: 0.08 },
    { text: 'café', start: 0.16, end: 0.48 },
    { text: 'à', start: 0.56, end: 0.64 },
    { text: '4,99', start: 0.72, end: 2 },
    { text: '€.', start: 2.04, end: 2.16 },
  ]);
});

test('wordsFromAlignment: the real answer gives no word for the tag, and "Tu" starts at its own time', async () => {
  const { alignment } = await recorded('[surprised] Tu as vu le prix ?');
  const words = wordsFromAlignment('[surprised] Tu as vu le prix ?', alignment);
  assert.deepEqual(texts(words), ['Tu', 'as', 'vu', 'le', 'prix', '?']);
  assert.deepEqual(words[0], { text: 'Tu', start: 0.149, end: 0.16 });
  assert.deepEqual(words.at(-1), { text: '?', start: 1.48, end: 1.84 });
});

test('wordsFromAlignment: a tag at the start, double spaces and punctuation alone', () => {
  const text = '[excited]  Oui  !  Bien sûr.';
  assert.deepEqual(wordsFromAlignment(text, evenAlignment(text)), [
    { text: 'Oui', start: 11, end: 14 },
    { text: '!', start: 16, end: 17 },
    { text: 'Bien', start: 19, end: 23 },
    { text: 'sûr.', start: 24, end: 28 },
  ]);
});

test('wordsFromAlignment: a tag inside a sentence splits nothing and times nothing', () => {
  const text = 'Bon [laughs], ok';
  assert.deepEqual(wordsFromAlignment(text, evenAlignment(text)), [
    { text: 'Bon,', start: 0, end: 13 },
    { text: 'ok', start: 14, end: 16 },
  ]);
});

test('wordsFromAlignment: characters outside the basic plane count once each', () => {
  const text = 'Top \u{1f389} ok';
  assert.deepEqual(texts(wordsFromAlignment(text, evenAlignment(text))), ['Top', '\u{1f389}', 'ok']);
  assert.deepEqual(wordsFromAlignment(text, evenAlignment(text))[1], { text: '\u{1f389}', start: 4, end: 5 });
});

test('wordsFromAlignment: an alignment of other characters falls back to prorata over its length', () => {
  const alignment = evenAlignment('Something else entirely');
  assert.deepEqual(wordsFromAlignment('ab cd', alignment), wordsByProrata('ab cd', 23));
  const short = { ...evenAlignment('ab cd'), character_end_times_seconds: [1] };
  assert.deepEqual(wordsFromAlignment('ab cd', short), wordsByProrata('ab cd', 1));
  const fewStarts = { ...evenAlignment('ab cd'), character_start_times_seconds: [0] };
  assert.deepEqual(wordsFromAlignment('ab cd', fewStarts), wordsByProrata('ab cd', 5));
  const empty = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
  assert.deepEqual(wordsFromAlignment('ab cd', empty), wordsByProrata('ab cd', 0));
});

test('wordsByProrata: times in proportion to the characters, tags removed', () => {
  assert.deepEqual(wordsByProrata('[sighs] ab cd', 2.5), [
    { text: 'ab', start: 0, end: 1 },
    { text: 'cd', start: 1.5, end: 2.5 },
  ]);
  assert.deepEqual(wordsByProrata('', 3), []);
  assert.deepEqual(wordsByProrata('[laughs]', 3), []);
  assert.deepEqual(wordsByProrata('   ', 3), []);
});
