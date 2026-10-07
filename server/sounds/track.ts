// The sounds track of an MP4: the library one-shots the scenes' cues play, mixed into one mono WAV the length of the
// render range, which ffmpeg mixes with the music and the voice-over.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SOUND_PEAKS, type SoundCue, type SoundName } from '../../src/shared/sounds';
import { m } from '../i18n';
import { SR } from '../music/synth';
import { writeFileAtomic } from '../util';
import { readWav, silentWav } from '../voiceover/wav';

/**
 * Writes the sounds of `cues` (checked, video seconds) heard from `from` for `duration` seconds to `file`, and returns
 * it; null when none is heard. Each file starts `peak` before its cue, so a sound may begin before its scene and
 * run past its end: only the range trims it.
 */
export async function soundTrack(o: {
  cues: Required<SoundCue>[];
  from: number;
  duration: number;
  /** Folder of the library WAVs (src/editor/sounds). */
  library: string;
  file: string;
}): Promise<string | null> {
  const files = new Map<SoundName, Int16Array>();
  for (const sound of new Set(o.cues.map((cue) => cue.sound))) {
    const name = `${sound}.wav`;
    const data = await fs.readFile(path.join(o.library, name)).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' ? new Error(m().media.render.soundMissing(name)) : e;
    });
    const { sampleRate, samples } = readWav(data);
    if (sampleRate !== SR) throw new Error(m().media.render.soundFormat(name, SR));
    files.set(sound, samples);
  }
  const length = Math.round(o.duration * SR);
  const placed = o.cues
    .map(({ at, sound, gain }) => {
      const source = files.get(sound)!;
      const start = Math.round((at - SOUND_PEAKS[sound] - o.from) * SR);
      return { source, gain, start, first: Math.max(0, -start), end: Math.min(source.length, length - start) };
    })
    .filter(({ first, end }) => first < end);
  if (!placed.length) return null;
  const mix = new Int32Array(length);
  for (const { source, gain, start, first, end } of placed) {
    for (let j = first; j < end; j++) mix[start + j] += Math.round(source[j] * gain);
  }
  const wav = silentWav(SR, length);
  for (let i = 0; i < length; i++) wav.samples[i] = Math.max(-32768, Math.min(32767, mix[i]));
  await writeFileAtomic(o.file, wav.data);
  return o.file;
}
