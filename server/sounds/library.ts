// The sound effects scenes can play, synthesized with the soundtracks' one-shots and written to src/editor/sounds as
// 16-bit mono WAV (`npm run cadence -- sounds`). Seeded: an unchanged recipe rewrites the same bytes. After changing a
// recipe, set SOUND_PEAKS in src/shared/sounds.ts to the "loudest at" the command prints.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SOUND_NAMES, type SoundName } from '../../src/shared/sounds';
import { m } from '../i18n';
import { SR, crash, fade, hat, kick, perc, riser, rng, snare, stereo, type Rand, type Stereo } from '../music/synth';
import { writeWav } from '../voiceover/wav';

interface Recipe {
  seconds: number;
  /** Peak level in dBFS, -1 at most: the levels balance the sounds against each other. */
  level: number;
  compose: (bus: Stereo, rand: Rand) => void;
}

/** Silence before the hits: the 3 ms fade-in of `fade` keeps their attack. */
const LEAD = 0.005;

const RECIPES: Record<SoundName, Recipe> = {
  click: {
    seconds: 0.12,
    level: -6,
    compose: (bus, rand) => {
      perc(bus, LEAD, rand, { freq: 2400, decay: 0.006, bend: 1.3, click: 0.5 });
      hat(bus, LEAD, rand, { decay: 0.008, tone: 6000, vel: 0.6 });
    },
  },
  key: {
    seconds: 0.15,
    level: -8,
    compose: (bus, rand) => {
      perc(bus, LEAD, rand, { freq: 900, decay: 0.012, bend: 1.2, click: 0.4 });
      hat(bus, LEAD, rand, { decay: 0.015, tone: 3500, vel: 0.5 });
      perc(bus, LEAD + 0.035, rand, { freq: 600, decay: 0.01, click: 0.2, vel: 0.35 });
    },
  },
  pop: {
    seconds: 0.25,
    level: -4,
    compose: (bus, rand) => {
      perc(bus, LEAD, rand, { freq: 420, decay: 0.045, bend: 2.6, click: 0.15 });
    },
  },
  whoosh: {
    seconds: 0.7,
    level: -3,
    compose: (bus, rand) => {
      // A riser into its own reverse: the band sweeps up while it swells, then back down while it fades.
      const rise = stereo(Math.round(0.35 * SR));
      riser(rise, 0, 0.35, rand, { from: 250, to: 5000 });
      for (const [from, to] of [
        [rise.l, bus.l],
        [rise.r, bus.r],
      ]) {
        to.set(from, 0);
        to.set(Float32Array.from(from).reverse(), from.length);
      }
    },
  },
  impact: {
    seconds: 1.2,
    level: -1,
    compose: (bus, rand) => {
      kick(bus, LEAD, rand, { from: 130, to: 38, drop: 0.05, decay: 0.3, drive: 3, click: 0.6 });
      snare(bus, LEAD, rand, { tone: 120, decay: 0.12, snap: 0.5, vel: 0.5 });
      crash(bus, LEAD, rand, { decay: 0.4, vel: 0.35 });
    },
  },
};

export interface Sound {
  samples: Int16Array;
  /** Seconds from the start to the loudest sample. */
  peakAt: number;
  /** Peak level in dBFS. */
  peak: number;
}

/** Composes a sound, downmixes it to mono, fades its tail and scales its loudest sample to the recipe's level. */
export function synthesizeSound(name: SoundName): Sound {
  const { seconds, level, compose } = RECIPES[name];
  const bus = stereo(Math.round(seconds * SR));
  compose(bus, rng([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)));
  fade(bus, Math.min(0.1, seconds / 3));
  const mono = bus.l.map((l, i) => (l + bus.r[i]) / 2);
  let loudest = 0;
  for (let i = 1; i < mono.length; i++) if (Math.abs(mono[i]) > Math.abs(mono[loudest])) loudest = i;
  const gain = (10 ** (level / 20) * 32767) / Math.abs(mono[loudest]);
  const samples = Int16Array.from(mono, (s) => Math.round(s * gain));
  return { samples, peakAt: loudest / SR, peak: 20 * Math.log10(Math.abs(samples[loudest]) / 32768) };
}

export async function writeSounds(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const name of SOUND_NAMES) {
    const sound = synthesizeSound(name);
    const file = `${name}.wav`;
    await fs.writeFile(path.join(dir, file), writeWav({ sampleRate: SR, samples: sound.samples }));
    console.log(
      m().media.sounds.written(
        file.padEnd(11),
        (sound.samples.length / SR).toFixed(2),
        sound.peakAt.toFixed(4),
        sound.peak.toFixed(1),
      ),
    );
  }
}
