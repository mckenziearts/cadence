// The sounds track of an MP4: the library one-shots and the clip sounds the scenes' cues play, mixed into one mono WAV
// the length of the render range, which ffmpeg mixes with the music and the voice-over.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SOUND_PEAKS, type ClipSoundCue, type SoundCue, type SoundEffectCue, type SoundName } from '../../src/shared/sounds';
import { m } from '../i18n';
import { SR } from '../music/synth';
import { writeFileAtomic } from '../util';
import { readWav, silentWav } from '../voiceover/wav';

/** Seconds: a spawn of ffmpeg costs about what decoding this much sound does, so a gap this short is read through. */
const READ_GAP = 30;
/** Seconds: parts of a clip near each other share a read only within this span, which bounds the samples one read holds. */
const MAX_READ = 600;

/**
 * Writes the sounds of `cues` (checked, video seconds) heard from `from` for `duration` seconds to `file`, and returns
 * it; null when none is heard. Each file starts `peak` before its cue, so a sound may begin before its scene and
 * run past its end: only the range trims it. A clip cue starts on its `at`; only the part of it the range hears is read.
 * Parts of one clip less than READ_GAP apart share one read while it spans at most MAX_READ seconds (a longer part
 * starts its own read): at most one read per cue, each decoding what its parts hear and the gaps between them, and
 * the mix and one read's samples are all that is held.
 */
export async function soundTrack(o: {
  cues: Required<SoundCue>[];
  from: number;
  duration: number;
  /** Folder of the library WAVs (src/editor/sounds). */
  library: string;
  file: string;
  /** The clip's sound from `from` (seconds into it) for `duration` seconds, mono at SR. */
  readClip: (clip: string, from: number, duration: number) => Promise<Int16Array>;
}): Promise<string | null> {
  const effects = o.cues.filter((cue): cue is Required<SoundEffectCue> => 'sound' in cue);
  const files = new Map<SoundName, Int16Array>();
  for (const sound of new Set(effects.map((cue) => cue.sound))) {
    const name = `${sound}.wav`;
    const data = await fs.readFile(path.join(o.library, name)).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' ? new Error(m().media.render.soundMissing(name)) : e;
    });
    const { sampleRate, samples } = readWav(data);
    if (sampleRate !== SR) throw new Error(m().media.render.soundFormat(name, SR));
    files.set(sound, samples);
  }
  const length = Math.round(o.duration * SR);
  const placed = effects
    .map(({ at, sound, gain }) => {
      const source = files.get(sound)!;
      const start = Math.round((at - SOUND_PEAKS[sound] - o.from) * SR);
      return { source, gain, start, first: Math.max(0, -start), end: Math.min(source.length, length - start) };
    })
    .filter(({ first, end }) => first < end);
  const clips = o.cues
    .filter((cue): cue is Required<ClipSoundCue> => 'clip' in cue)
    .map((cue) => {
      const start = Math.round((cue.at - o.from) * SR);
      const first = Math.max(0, -start);
      const end = Math.min(Math.round(cue.duration * SR), length - start);
      // Seconds into the clip of what the range hears.
      return { ...cue, start, first, end, clipFrom: cue.from + first / SR, clipTo: cue.from + end / SR };
    })
    .filter(({ first, end }) => first < end)
    .sort((a, b) => (a.clip < b.clip ? -1 : a.clip > b.clip ? 1 : a.clipFrom - b.clipFrom));
  if (!placed.length && !clips.length) return null;
  const mix = new Int32Array(length);
  for (const { source, gain, start, first, end } of placed) {
    for (let j = first; j < end; j++) mix[start + j] += Math.round(source[j] * gain);
  }
  for (let i = 0; i < clips.length;) {
    const { clip, clipFrom: from } = clips[i];
    let to = clips[i].clipTo;
    let j = i + 1;
    const joins = (next: (typeof clips)[number]) =>
      next.clip === clip && next.clipFrom <= to + READ_GAP && next.clipTo - from <= MAX_READ;
    for (; j < clips.length && joins(clips[j]); j++) to = Math.max(to, clips[j].clipTo);
    const samples = await o.readClip(clip, from, to - from);
    for (const { gain, start, first, end, clipFrom } of clips.slice(i, j)) {
      const offset = Math.round((clipFrom - from) * SR);
      const heard = Math.min(samples.length - offset, end - first);
      for (let k = 0; k < heard; k++) mix[start + first + k] += Math.round(samples[offset + k] * gain);
    }
    i = j;
  }
  const wav = silentWav(SR, length);
  for (let i = 0; i < length; i++) wav.samples[i] = Math.max(-32768, Math.min(32767, mix[i]));
  await writeFileAtomic(o.file, wav.data);
  return o.file;
}
