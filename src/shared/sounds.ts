// Sound effects scenes declare with `export function sounds(props)`: the library (src/editor/sounds, written by
// server/sounds/library.ts) and the cue contract the frame, the editor and the render all check.
import type { SceneProps } from '../runtime/types';
import type { ClipState } from './types';

export const SOUND_NAMES = ['click', 'key', 'pop', 'whoosh', 'impact'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

/** Seconds from the start of each file to its loudest sample: a cue's `at` lands there, not on the file start. */
export const SOUND_PEAKS: Record<SoundName, number> = {
  click: 0.006054,
  key: 0.006054,
  pop: 0.006122,
  whoosh: 0.342562,
  impact: 0.009864,
};

export const MAX_SOUND_CUES = 1000;
/** The cues of a whole video, whatever its number of scenes: their 16-bit samples sum in 32 bits without wrapping. */
export const MAX_VIDEO_SOUND_CUES = 10_000;
/** The clip cues of a `sounds()` are heard at most this many times its length in all: the mix adds each sample in turn. */
export const MAX_CLIP_LAYERS = 8;
/**
 * Characters of an unknown sound name an error shows, like the text checks of a frame. Twice as many UTF-16 units always
 * hold that many characters: only those are split into characters, never a whole huge name.
 */
const RECEIVED_CHARS = 40;

export interface SoundEffectCue {
  /** Seconds, scene-local in `sounds()`: the contact, where the sound is loudest. */
  at: number;
  sound: SoundName;
  /** 0 to 1, 1 by default. */
  gain?: number;
}

/** The sound of a video clip of the project, from its second `from`, starting on `at`. */
export interface ClipSoundCue {
  /** Seconds, scene-local in `sounds()`: where the clip's sound starts. */
  at: number;
  /** Its path under assets/, like `<Clip src>`. */
  clip: string;
  /** Seconds into the clip, 0 by default. */
  from?: number;
  /** Seconds; to the clip's end by default, and always cut at the scene's end. */
  duration?: number;
  /** 0 to 1, 1 by default. */
  gain?: number;
}

/** Checked, a cue has every field: a clip cue's `duration` is what is heard of it. */
export type SoundCue = SoundEffectCue | ClipSoundCue;

/** What a scene's `sounds()` gave once checked: its cues, scene-local, or why it has none. */
export type SceneSounds = { cues: Required<SoundCue>[] } | { error: string };

/** What `sounds()` receives: the scene component's props without `t`. */
export type SoundProps = Omit<SceneProps, 't'>;

/** The messages of parseSoundCues, in the caller's dictionary. */
export interface SoundCueTexts {
  notArray: string;
  tooMany: (max: number) => string;
  notObject: (index: number) => string;
  at: (index: number, duration: number) => string;
  sound: (index: number, received: string, known: string) => string;
  gain: (index: number) => string;
  both: (index: number) => string;
  clipUnknown: (index: number, received: string) => string;
  clipPreparing: (index: number, file: string) => string;
  clipFailed: (index: number, file: string, error: string) => string;
  clipSilent: (index: number, file: string) => string;
  clipFrom: (index: number, file: string, duration: number) => string;
  clipDuration: (index: number) => string;
  clipTotal: (seconds: number) => string;
}

const isSoundName = (value: unknown): value is SoundName => SOUND_NAMES.includes(value as SoundName);

/** A received string as an error shows it: quoted, its first RECEIVED_CHARS characters; or its type. */
function shown(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(
        Array.from(value.slice(0, 2 * RECEIVED_CHARS))
          .slice(0, RECEIVED_CHARS)
          .join(''),
      )
    : typeof value;
}

/**
 * Checks what a `sounds()` returned against a scene of `duration` seconds and the project's `clips`, or `max` cues;
 * `gain` defaults to 1, a clip cue's `from` to 0 and its `duration` to what is left of the clip and of the scene. A clip
 * cue on the scene's very end is dropped: nothing of it is heard.
 */
export function parseSoundCues(
  value: unknown,
  duration: number,
  texts: SoundCueTexts,
  clips: Record<string, ClipState>,
  max = MAX_SOUND_CUES,
): SceneSounds {
  if (!Array.isArray(value)) return { error: texts.notArray };
  if (value.length > max) return { error: texts.tooMany(max) };
  const cues: Required<SoundCue>[] = [];
  let clipSeconds = 0;
  for (const [index, cue] of value.entries()) {
    if (typeof cue !== 'object' || cue === null) return { error: texts.notObject(index) };
    const { at, sound, clip, gain = 1 } = cue as Record<string, unknown>;
    if (typeof at !== 'number' || !(at >= 0 && at <= duration)) return { error: texts.at(index, duration) };
    if (clip !== undefined) {
      if (sound !== undefined) return { error: texts.both(index) };
      const file = typeof clip === 'string' ? clip.replace(/^\/+/, '') : '';
      const state = Object.hasOwn(clips, file) ? clips[file] : undefined;
      if (!state) return { error: texts.clipUnknown(index, shown(clip)) };
      if (state.status === 'preparing') return { error: texts.clipPreparing(index, file) };
      if (state.status === 'error') return { error: texts.clipFailed(index, file, state.error) };
      if (!state.audio) return { error: texts.clipSilent(index, file) };
      const { from = 0, duration: length } = cue as Record<string, unknown>;
      if (typeof from !== 'number' || !(from >= 0 && from < state.duration)) {
        return { error: texts.clipFrom(index, file, state.duration) };
      }
      if (length !== undefined && (typeof length !== 'number' || !(length > 0))) return { error: texts.clipDuration(index) };
      if (typeof gain !== 'number' || !(gain >= 0 && gain <= 1)) return { error: texts.gain(index) };
      const heard = Math.min(length ?? Infinity, state.duration - from, duration - at);
      if (heard <= 0) continue;
      clipSeconds += heard;
      if (clipSeconds > MAX_CLIP_LAYERS * duration) return { error: texts.clipTotal(Math.round(MAX_CLIP_LAYERS * duration)) };
      cues.push({ at, clip: file, from, duration: heard, gain });
      continue;
    }
    if (!isSoundName(sound)) return { error: texts.sound(index, shown(sound), SOUND_NAMES.join(', ')) };
    if (typeof gain !== 'number' || !(gain >= 0 && gain <= 1)) return { error: texts.gain(index) };
    cues.push({ at, sound, gain });
  }
  return { cues };
}

/** The cues of scenes starting at `start` (video seconds), on the video timeline and sorted; scenes in error add none. */
export function videoSoundCues(scenes: { start: number; sounds: SceneSounds }[]): Required<SoundCue>[] {
  return scenes
    .flatMap(({ start, sounds }) =>
      'cues' in sounds ? sounds.cues.map((cue) => ({ ...cue, at: Math.round((start + cue.at) * 1e9) / 1e9 })) : [],
    )
    .sort((a, b) => a.at - b.at);
}
