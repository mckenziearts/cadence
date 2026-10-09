// voiceLevel: how open a mouth is at a scene time, from the levels Cadence keeps with each spoken sentence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceLevel, type VoiceOverInfo } from '../../src/runtime/index';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// Ana from 1 s to 1.12 s (3 levels at 25 Hz), Ben from 1.5 s to 1.58 s.
const voiceOver: VoiceOverInfo = {
  text: 'Oui. Non.',
  lines: [
    { text: 'Oui.', start: 1, end: 1.12, speaker: 'ana', words: [{ text: 'Oui.', start: 1, end: 1.12 }], level: [0, 255, 51] },
    { text: 'Non.', start: 1.5, end: 1.58, speaker: 'ben', words: [{ text: 'Non.', start: 1.5, end: 1.58 }], level: [102, 204] },
  ],
};

test('voiceLevel: the level of the sentence spoken at t, from 0 to 1, read at 25 Hz', () => {
  close(voiceLevel(voiceOver, 1), 0);
  close(voiceLevel(voiceOver, 1.04), 1);
  close(voiceLevel(voiceOver, 1.08), 0.2);
  close(voiceLevel(voiceOver, 1.5), 0.4);
});

test('voiceLevel: interpolates linearly between two readings', () => {
  close(voiceLevel(voiceOver, 1.02), 0.5);
  close(voiceLevel(voiceOver, 1.06), 0.6);
  close(voiceLevel(voiceOver, 1.52), 0.6);
});

test('voiceLevel: 0 before the first sentence, between two, after the last, and without sentences', () => {
  for (const t of [0, 0.999, 1.12, 1.3, 1.58, 9]) assert.equal(voiceLevel(voiceOver, t), 0, String(t));
  assert.equal(voiceLevel({ text: '', lines: [] }, 1), 0);
});

test('voiceLevel: with a speaker, 0 unless that speaker is the one speaking at t', () => {
  close(voiceLevel(voiceOver, 1.04, 'ana'), 1);
  assert.equal(voiceLevel(voiceOver, 1.04, 'ben'), 0);
  close(voiceLevel(voiceOver, 1.5, 'ben'), 0.4);
  assert.equal(voiceLevel(voiceOver, 1.5, 'ana'), 0);
  assert.equal(voiceLevel(voiceOver, 1.3, 'ana'), 0);
});

test('voiceLevel: holds the last reading until the sentence ends', () => {
  close(voiceLevel(voiceOver, 1.11), 0.2);
});

test('voiceLevel: a sentence ending inside its last reading holds it to its end, where the next sentence takes over', () => {
  // 0.1 s of voice: ceil(2.5) = 3 readings, the last over 20 ms. The same speaker goes on with no pause.
  const said = (text: string, start: number, end: number, level: number[]) => ({
    text,
    start,
    end,
    speaker: 'ana',
    words: [{ text, start, end }],
    level,
  });
  const backToBack: VoiceOverInfo = {
    text: 'Oui. Non.',
    lines: [said('Oui.', 2, 2.1, [51, 255, 102]), said('Non.', 2.1, 2.2, [204, 153, 0])],
  };
  close(voiceLevel(backToBack, 2.09), 0.4);
  close(voiceLevel(backToBack, 2.0999), 0.4);
  close(voiceLevel(backToBack, 2.1), 0.8);
  assert.equal(voiceLevel(backToBack, 2.2), 0);
});
