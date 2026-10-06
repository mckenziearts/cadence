// Sound effects scenes declare with `export function sounds(props)`: the library (src/editor/sounds, written by
// server/sounds/library.ts) and the cue contract the frame, the editor and the render all check.
import type { SceneProps } from '../runtime/types';

export const SOUND_NAMES = ['click', 'key', 'pop', 'whoosh', 'impact'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

/** Seconds from the start of each file to its loudest sample: a cue's `at` lands there, not on the file start. */
export const SOUND_PEAKS: Record<SoundName, number> = {
  click: 0.0061,
  key: 0.0061,
  pop: 0.0061,
  whoosh: 0.3426,
  impact: 0.0099,
};

export const MAX_SOUND_CUES = 1000;

export interface SoundCue {
  /** Seconds, scene-local in `sounds()`: the contact, where the sound is loudest. */
  at: number;
  sound: SoundName;
  /** 0 to 1, 1 by default. */
  gain: number;
}

/** What `sounds()` receives: the scene component's props without `t`. */
export type SoundProps = Omit<SceneProps, 't'>;

/** The messages of parseSoundCues, in the caller's dictionary. */
export interface SoundCueTexts {
  notArray: string;
  tooMany: (max: number) => string;
  notObject: (index: number) => string;
  at: (index: number, duration: number) => string;
  sound: (index: number, known: string) => string;
  gain: (index: number) => string;
}

const isSoundName = (value: unknown): value is SoundName => SOUND_NAMES.includes(value as SoundName);

/** Checks what a `sounds()` returned against a scene of `duration` seconds; `gain` defaults to 1. */
export function parseSoundCues(value: unknown, duration: number, texts: SoundCueTexts): { cues: SoundCue[] } | { error: string } {
  if (!Array.isArray(value)) return { error: texts.notArray };
  if (value.length > MAX_SOUND_CUES) return { error: texts.tooMany(MAX_SOUND_CUES) };
  const cues: SoundCue[] = [];
  for (const [index, cue] of value.entries()) {
    if (typeof cue !== 'object' || cue === null) return { error: texts.notObject(index) };
    const { at, sound, gain = 1 } = cue as Record<string, unknown>;
    if (typeof at !== 'number' || !(at >= 0 && at <= duration)) return { error: texts.at(index, duration) };
    if (!isSoundName(sound)) return { error: texts.sound(index, SOUND_NAMES.join(', ')) };
    if (typeof gain !== 'number' || !(gain >= 0 && gain <= 1)) return { error: texts.gain(index) };
    cues.push({ at, sound, gain });
  }
  return { cues };
}
