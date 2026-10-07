// Subtitle cues from the voice-over sentences, and the SRT / WebVTT files written from them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subtitleCues, toSrt, toVtt } from '../../src/shared/subtitles';

const line = (text: string, start: number, end: number, sceneId = 'a') => ({ sceneId, text, start, end });

test('subtitleCues: a sentence that fits is one cue over the sentence; no lines, no cues', () => {
  assert.deepEqual(subtitleCues([line('Bonjour  tout le monde.', 1.25, 3)], { maxChars: 84 }), [
    { start: 1.25, end: 3, text: 'Bonjour tout le monde.' },
  ]);
  assert.deepEqual(subtitleCues([], { maxChars: 84 }), []);
});

test('subtitleCues: a long sentence splits into balanced chunks, timed in proportion to their characters', () => {
  // Filling the first cue would give "aa bb cc dd" then "ee".
  assert.deepEqual(subtitleCues([line('aa bb cc dd ee', 0, 2.6)], { maxChars: 12 }), [
    { start: 0, end: 1.6, text: 'aa bb cc' },
    { start: 1.6, end: 2.6, text: 'dd ee' },
  ]);
});

test('subtitleCues: a chunk ends after punctuation when one is close enough to the middle', () => {
  assert.deepEqual(subtitleCues([line('Voici Cadence, un studio de motion design.', 0, 4.1)], { maxChars: 30 }), [
    { start: 0, end: 1.4, text: 'Voici Cadence,' },
    { start: 1.4, end: 4.1, text: 'un studio de motion design.' },
  ]);
  // Never a cue that starts with the punctuation French spaces off.
  const cues = subtitleCues([line('Regardez bien ce qui arrive maintenant !', 0, 2)], { maxChars: 30 });
  assert.ok(cues.every((c) => !c.text.startsWith('!')));
  assert.equal(cues.at(-1)!.text.endsWith(' !'), true);
});

test('subtitleCues: opening punctuation stays with the word after it, closing punctuation with the word before', () => {
  assert.deepEqual(
    subtitleCues([line('Il répond « oui » et repart.', 0, 2.8)], { maxChars: 14 }).map((c) => c.text),
    ['Il répond', '« oui » et', 'repart.'],
  );
  const marksHold = (cues: { text: string }[], label: string) => {
    assert.ok(
      cues.slice(0, -1).every((c) => !/[\p{Ps}\p{Pi}\u00bf\u00a1]$/u.test(c.text)),
      label,
    );
    assert.ok(
      cues.slice(1).every((c) => !/^[\p{Pe}\p{Pf}]/u.test(c.text)),
      label,
    );
  };
  for (const text of ['Elle dit « Cadence » puis « encore ».', 'On ouvre ( puis on ferme ) ici.', 'Fin «']) {
    const cues = subtitleCues([line(text, 0, 3)], { maxChars: 12 });
    assert.equal(cues.map((c) => c.text).join(' '), text);
    marksHold(cues, text);
  }
  for (const text of ['Dijo ¿ por qué no vienes ?', '¡ Vamos ya !', 'Voir [ note ] ici.', 'Il dit \u201c oui \u201d ici.'])
    for (let maxChars = 8; maxChars <= 14; maxChars++) {
      const cues = subtitleCues([line(text, 0, 3)], { maxChars });
      assert.equal(cues.map((c) => c.text).join(' '), text);
      marksHold(cues, `${text} (${maxChars})`);
    }
  // A quoted word longer than a cue is cut inside its letters: the marks stay on its first and last pieces.
  const quoted = 'Il dit « anticonstitutionnellement » ici.';
  assert.deepEqual(
    subtitleCues([line(quoted, 0, 3)], { maxChars: 9 }).map((c) => c.text),
    ['Il dit', '« anticon', 'stitution', 'nellemen', 't » ici.'],
  );
  for (let maxChars = 7; maxChars <= 14; maxChars++) {
    const cues = subtitleCues([line(quoted, 0, 3)], { maxChars });
    assert.ok(cues.every((c) => c.text.length <= maxChars && c.text === c.text.trim() && !c.text.includes('  ')));
    assert.equal(cues.map((c) => c.text.replace(/ /g, '')).join(''), quoted.replace(/ /g, ''));
    marksHold(cues, `long quoted word (${maxChars})`);
  }
});

test('subtitleCues: a non-breaking space never splits a cue and stays in its text', () => {
  assert.deepEqual(
    subtitleCues([line('Il répond «\u00a0oui\u00a0» et repart.', 0, 2.8)], { maxChars: 14 }).map((c) => c.text),
    ['Il répond', '«\u00a0oui\u00a0» et', 'repart.'],
  );
  assert.deepEqual(
    subtitleCues([line('Vraiment\u202f!', 0, 1)], { maxChars: 84 }).map((c) => c.text),
    ['Vraiment\u202f!'],
  );
});

test('subtitleCues: punctuation written against a word cut for length stays on its first or last piece', () => {
  const texts = (text: string, maxChars: number) => subtitleCues([line(text, 0, 3)], { maxChars }).map((c) => c.text);
  assert.deepEqual(texts('Anticonstitutionnellement. Puis', 25), ['Anticonstitutionnellemen', 't. Puis']);
  assert.deepEqual(texts('(anticonstitutionnellement) ici', 13), ['(anticonstitu', 'tionnellemen', 't) ici']);
  assert.deepEqual(texts('\u00bfAnticonstitucionalmente?', 12), ['\u00bfAnticonstit', 'ucionalment', 'e?']);
});

test('subtitleCues: a silence between two sentences shows no cue', () => {
  assert.deepEqual(subtitleCues([line('Un.', 0, 1), line('Deux.', 2, 3, 'b')], { maxChars: 84 }), [
    { start: 0, end: 1, text: 'Un.' },
    { start: 2, end: 3, text: 'Deux.' },
  ]);
});

test('subtitleCues: a word longer than maxChars is cut; every cue fits', () => {
  assert.deepEqual(
    subtitleCues([line('Anticonstitutionnellement oui', 0, 3.1)], { maxChars: 10 }).map((c) => c.text),
    ['Anticonsti', 'tutionnell', 'ement oui'],
  );
  const words = Array.from({ length: 300 }, (_, i) => ['le', 'studio', 'anime,', 'chaque', 'phrase.'][i % 5]).join(' ');
  const cues = subtitleCues([line(words, 0, 120)], { maxChars: 84 });
  assert.ok(cues.every((c) => c.text.length <= 84));
  assert.equal(cues.map((c) => c.text).join(' '), words);
  assert.ok(cues.every((c, i) => i === 0 || c.start === cues[i - 1].end));
  assert.equal(cues.at(-1)!.end, 120);
});

test('subtitleCues: sentences of two scenes that overlap show one cue at a time, in time order', () => {
  assert.deepEqual(subtitleCues([line('Deux.', 1.5, 3, 'b'), line('Un.', 0, 2, 'a')], { maxChars: 84 }), [
    { start: 0, end: 1.5, text: 'Un.' },
    { start: 1.5, end: 3, text: 'Deux.' },
  ]);
});

test('subtitleCues: a sentence interrupted by a shorter one comes back once it ends', () => {
  assert.deepEqual(subtitleCues([line('Longue phrase.', 0, 4, 'a'), line('Courte.', 1, 2, 'b')], { maxChars: 84 }), [
    { start: 0, end: 1, text: 'Longue phrase.' },
    { start: 1, end: 2, text: 'Courte.' },
    { start: 2, end: 4, text: 'Longue phrase.' },
  ]);
});

test('subtitleCues: of two sentences that start together, the shorter shows first and the other follows', () => {
  assert.deepEqual(subtitleCues([line('Deux.', 1, 3, 'b'), line('Un.', 1, 2, 'a')], { maxChars: 84 }), [
    { start: 1, end: 2, text: 'Un.' },
    { start: 2, end: 3, text: 'Deux.' },
  ]);
});

test('toSrt: numbered blocks with comma milliseconds; hours and rounding', () => {
  const cues = [
    { start: 1.25, end: 3, text: 'Bonjour.' },
    { start: 59.9996, end: 3661.5004, text: 'Une heure plus tard.' },
  ];
  assert.equal(
    toSrt(cues),
    '1\n00:00:01,250 --> 00:00:03,000\nBonjour.\n\n2\n00:01:00,000 --> 01:01:01,500\nUne heure plus tard.\n',
  );
  assert.match(toSrt([{ start: 1.2506, end: 2, text: 'x' }]), /00:00:01,251 -->/);
});

test('toVtt: WEBVTT header, dot milliseconds, text escaped', () => {
  assert.equal(
    toVtt([
      { start: 1.25, end: 3, text: 'Bonjour.' },
      { start: 3600, end: 3601.0005, text: 'A <b> & C' },
    ]),
    'WEBVTT\n\n00:00:01.250 --> 00:00:03.000\nBonjour.\n\n01:00:00.000 --> 01:00:01.001\nA &lt;b&gt; &amp; C\n',
  );
});

test('toVtt: an arrow in a sentence never reads as a timing line', () => {
  assert.equal(
    toVtt([{ start: 0, end: 1, text: 'Avant --> après' }]),
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAvant --&gt; après\n',
  );
});
