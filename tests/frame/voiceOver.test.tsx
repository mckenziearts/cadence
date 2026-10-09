// The voice-over a scene component gets: the project's sentences of that scene, in scene seconds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sceneVoiceOver } from '../../src/frame/voiceOver';
import type { VoiceOverLine } from '../../src/shared/types';

const lines: VoiceOverLine[] = [
  { sceneId: 'intro', text: 'Bonjour.', start: 0.2, end: 1, speaker: null, words: [], level: [1] },
  {
    sceneId: 'demo',
    text: 'Le chat dort.',
    start: 2.3,
    end: 3.4,
    speaker: 'ana',
    words: [
      { text: 'Le', start: 2.3, end: 2.5 },
      { text: 'chat', start: 2.6, end: 2.9 },
      { text: 'dort.', start: 3, end: 3.4 },
    ],
    level: [10, 200],
    gesture: 'nod',
  },
  { sceneId: 'demo', text: 'Oui.', start: 3.5, end: 4, speaker: 'ben', words: [{ text: 'Oui.', start: 3.5, end: 4 }], level: [] },
];

test("sceneVoiceOver: the scene's sentences and their words in scene seconds, with speaker, level and gesture", () => {
  assert.deepEqual(sceneVoiceOver(lines, { id: 'demo', start: 2, voiceOver: { text: 'Le chat dort. Oui.', at: 0.3 } }), {
    text: 'Le chat dort. Oui.',
    lines: [
      {
        text: 'Le chat dort.',
        start: 0.3,
        end: 1.4,
        speaker: 'ana',
        words: [
          { text: 'Le', start: 0.3, end: 0.5 },
          { text: 'chat', start: 0.6, end: 0.9 },
          { text: 'dort.', start: 1, end: 1.4 },
        ],
        level: [10, 200],
        gesture: 'nod',
      },
      { text: 'Oui.', start: 1.5, end: 2, speaker: 'ben', words: [{ text: 'Oui.', start: 1.5, end: 2 }], level: [] },
    ],
  });
});

test('sceneVoiceOver: no text and no sentences for a scene without voice-over', () => {
  assert.deepEqual(sceneVoiceOver(lines, { id: 'outro', start: 5 }), { text: '', lines: [] });
});
