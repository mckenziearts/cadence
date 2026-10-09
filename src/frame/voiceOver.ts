// The voice-over a scene component gets: the project's sentences of that scene, in scene seconds.
import type { VoiceOverInfo } from '../runtime/types';
import type { SceneState, VoiceOverLine } from '../shared/types';

/** Float noise (video time 2.3 − scene start 2 = 0.2999...) must not flip a `t >= 0.3` against the scene-mode preview. */
export const tidy = (t: number) => Math.round(t * 1e9) / 1e9;

export function sceneVoiceOver(lines: VoiceOverLine[], scene: Pick<SceneState, 'id' | 'start' | 'voiceOver'>): VoiceOverInfo {
  return {
    text: scene.voiceOver?.text ?? '',
    lines: lines
      .filter((l) => l.sceneId === scene.id)
      .map((l) => ({
        text: l.text,
        start: tidy(l.start - scene.start),
        end: tidy(l.end - scene.start),
        speaker: l.speaker,
        words: l.words.map((w) => ({ text: w.text, start: tidy(w.start - scene.start), end: tidy(w.end - scene.start) })),
        level: l.level,
        ...(l.gesture !== undefined && { gesture: l.gesture }),
      })),
  };
}
