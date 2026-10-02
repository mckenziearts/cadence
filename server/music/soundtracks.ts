// The preset soundtracks of the Music panel, composed in code with ./synth and written to src/editor/soundtracks
// (`npm run cadence -- soundtracks`). Each comes in versions of about 15, 30 and 60 s: a whole number of bars, the last
// one a final hit that rings out, so the beat grid is exact and a video of that length ends with the music.
import fs from 'node:fs/promises';
import path from 'node:path';
import { m } from '../i18n';
import {
  SR,
  autopan,
  chorus,
  clap,
  crash,
  duck,
  encode,
  eq,
  fade,
  fm,
  gate,
  hat,
  kick,
  logDrum,
  master,
  mixdown,
  perc,
  reverb,
  riser,
  rng,
  shaker,
  snare,
  stereo,
  sweep,
  synth,
  vinyl,
  wow,
  type FmOpts,
  type Rand,
  type Stereo,
  type SynthOpts,
} from './synth';

export interface Soundtrack {
  id: string;
  name: string;
  style: string;
  use: string;
  bpm: number;
  versions: { file: string; bars: number; duration: number }[];
}

type Section = 'intro' | 'a' | 'b' | 'break' | 'end';

/** One version's bars and sections: intro, A and B parts, a break in the long ones, the final bar. */
class Song {
  readonly beat: number;
  readonly bar: number;
  readonly samples: number;
  readonly rand: Rand;
  readonly intro: number;
  private readonly pause: [number, number] | null = null;

  constructor(
    readonly bpm: number,
    readonly bars: number,
    readonly swing: number,
    seed: number,
  ) {
    this.beat = 60 / bpm;
    this.bar = 4 * this.beat;
    this.samples = Math.round(bars * this.bar * SR);
    this.rand = rng(seed);
    this.intro = bars >= 20 ? 4 : 2;
    if (bars >= 20) {
      const size = bars >= 28 ? 4 : 2;
      const start = this.intro + 4 * Math.round((bars - 1 - this.intro - size) / 8);
      this.pause = [start, start + size];
    }
  }

  bus(): Stereo {
    return stereo(this.samples);
  }

  /** Seconds at sixteenth `step` of `bar`; the swing delays every second sixteenth. */
  at(bar: number, step = 0): number {
    return bar * this.bar + ((step + (step % 2 === 1 ? this.swing : 0)) * this.beat) / 4;
  }

  steps(sixteenths: number): number {
    return (sixteenths * this.beat) / 4;
  }

  section(bar: number): Section {
    if (bar >= this.bars - 1) return 'end';
    if (bar < this.intro) return 'intro';
    if (this.pause && bar >= this.pause[0]) return bar < this.pause[1] ? 'break' : 'b';
    // A then B in blocks of 4 bars; a short version is all B, the part with the hook.
    const blocks = Math.floor(((this.pause?.[0] ?? this.bars - 1) - this.intro) / 4);
    if (blocks < 2) return 'b';
    return Math.min(blocks - 1, Math.floor((bar - this.intro) / 4)) < Math.floor(blocks / 2) ? 'a' : 'b';
  }

  /** The last bar before another section: room for a fill. */
  turn(bar: number): boolean {
    return bar < this.bars - 1 && this.section(bar + 1) !== this.section(bar);
  }

  /** The first bar of a part after the intro or the break. */
  drop(bar: number): boolean {
    const section = this.section(bar);
    const before = bar > 0 ? this.section(bar - 1) : 'intro';
    return (section === 'a' || section === 'b') && (before === 'intro' || before === 'break');
  }

  /** Low-pass that opens over the intro: the track fades in from a muffled loop. */
  openIntro(bus: Stereo, from: number): void {
    const end = this.intro * this.bar;
    sweep(bus, (t) => (t < end ? from * (18000 / from) ** (t / end) : 20000));
  }
}

const VELOCITY: Record<string, number> = { X: 1, x: 0.75, o: 0.5 };

/** The hits of a 16-step pattern ("X" loud, "x" medium, "o" soft, "." rest). */
function hits(pattern: string): [step: number, vel: number][] {
  return [...pattern].flatMap((c, step) => (VELOCITY[c] ? [[step, VELOCITY[c]] as [number, number]] : []));
}

/** A chord on the electric piano, strummed upwards. */
function strum(bus: Stereo, t: number, length: number, notes: number[], o: FmOpts, spread = 0.012): void {
  notes.forEach((midi, i) => fm(bus, t + i * spread, length - i * spread, midi, o));
}

interface Preset {
  id: string;
  name: string;
  style: string;
  use: string;
  bpm: number;
  swing?: number;
  compose(song: Song): Stereo;
}

// Pulse: tech house, A minor (Am9, Fmaj9, Dm9, Em7). Four on the floor, rolling bass, off-beat stabs through a dotted echo.
const pulse: Preset = {
  id: 'pulse',
  name: 'Pulse',
  style: 'Tech house minimale',
  use: 'Teaser produit',
  bpm: 120,
  compose(s) {
    const CHORDS = [
      [57, 60, 64, 67, 71], // Am9
      [53, 57, 60, 64, 67], // Fmaj9
      [50, 53, 57, 60, 64], // Dm9
      [52, 55, 59, 62, 67], // Em7
    ];
    const ROOTS = [33, 29, 38, 40];
    // Rolling bass: the three sixteenths after each kick.
    const ROLL = [1, 2, 3].map((step, i) => [step, [0.85, 0.7, 0.75][i]]);
    const STAB: SynthOpts = { detune: [-7, 7], cutoff: 900, env: 2600, envDecay: 0.09, q: 1.1, a: 0.003, d: 0.12, s: 0, r: 0.06 };
    const BASS: SynthOpts = {
      cutoff: 220,
      env: 500,
      envDecay: 0.05,
      q: 1.2,
      sub: 0.8,
      a: 0.012,
      d: 0.2,
      s: 0.7,
      r: 0.03,
      drive: 1.5,
    };
    const PAD: SynthOpts = {
      detune: [-12, -4, 5, 13],
      cutoff: 1400,
      q: 0.7,
      lfoRate: 0.1,
      lfoDepth: 500,
      a: 0.15,
      d: 1,
      s: 0.85,
      r: 0.4,
    };
    const { rand } = s;
    const [kicks, claps, hats, percs, bass, stabs, pads, fx] = Array.from({ length: 8 }, () => s.bus());
    const beats: number[] = [];
    for (let bar = 0; bar < s.bars; bar++) {
      const section = s.section(bar);
      const chord = CHORDS[bar % 4];
      if (section === 'end') {
        const t = s.at(bar);
        kick(kicks, t, rand);
        beats.push(t);
        crash(fx, t, rand, { vel: 0.7 });
        // The hats tick the last beats out, so the grid holds to the end.
        [0.5, 0.35, 0.25].forEach((vel, i) => hat(hats, s.at(bar, 4 * (i + 1)), rand, { vel, pan: 0.15 }));
        for (const midi of CHORDS[0]) synth(stabs, t, s.bar * 0.3, midi, rand, { ...STAB, d: 0.5, r: 0.4 });
        synth(bass, t, s.bar * 0.25, ROOTS[0], rand, { ...BASS, r: 0.25 });
        continue;
      }
      if (s.drop(bar)) crash(fx, s.at(bar), rand, { vel: 0.5 });
      if (s.drop(bar + 1)) riser(fx, s.at(bar), s.bar, rand, { vel: 0.7 });
      if (section === 'break') {
        // The beat stays under the break: hats on the beat, a soft kick on the one.
        kick(kicks, s.at(bar), rand, { vel: 0.6 });
        for (const [step, vel] of hits('x...o...x...o...')) hat(hats, s.at(bar, step), rand, { vel, pan: 0.15 });
      } else {
        for (let beat = 0; beat < 4; beat++) {
          kick(kicks, s.at(bar, 4 * beat), rand, { vel: beat ? 0.85 : 1 });
          beats.push(s.at(bar, 4 * beat));
        }
        for (const [step, vel] of hits('x.x.x.x.x.x.x.x.')) hat(hats, s.at(bar, step), rand, { vel, pan: 0.15 });
      }
      if (section === 'a' || section === 'b') {
        for (const [step, vel] of hits(s.turn(bar) ? '....X.......X.xX' : '....X.......X...')) {
          clap(claps, s.at(bar, step), rand, { vel, pan: -0.2 });
          clap(claps, s.at(bar, step), rand, { vel, pan: 0.2 });
        }
        // The root lands with the kick on the one, then rolls.
        synth(bass, s.at(bar), s.steps(0.8), ROOTS[bar % 4], rand, BASS);
        for (let beat = 0; beat < 4; beat++) {
          for (const [step, vel] of ROLL)
            synth(bass, s.at(bar, 4 * beat + step), s.steps(0.8), ROOTS[bar % 4], rand, { ...BASS, vel });
        }
      }
      if (section === 'b') {
        for (const [step, vel] of hits('..x...x...x...x.'))
          hat(hats, s.at(bar, step), rand, { vel: vel * 0.6, decay: 0.2, pan: -0.15 });
        for (const [step, vel] of hits(bar % 2 ? '......x.......x.' : '...x.......x....')) {
          perc(percs, s.at(bar, step), rand, { freq: 1700, decay: 0.012, bend: 1.1, vel, pan: 0.3 });
        }
      }
      if (section === 'b' || section === 'break') for (const midi of chord) synth(pads, s.at(bar), s.bar, midi, rand, PAD);
      for (const step of bar % 2 ? [2, 10, 13] : [2, 7, 10]) {
        for (const midi of chord) synth(stabs, s.at(bar, step), s.steps(1.5), midi, rand, STAB);
      }
    }
    s.openIntro(stabs, 300);
    duck(bass, beats, 0.5);
    duck(pads, beats, 0.6, 0.15);
    duck(stabs, beats, 0.3);
    return mixdown(
      [
        { bus: kicks, lufs: -16 },
        { bus: claps, lufs: -19, reverb: 0.2 },
        { bus: hats, lufs: -27 },
        { bus: percs, lufs: -29, reverb: 0.3 },
        { bus: bass, lufs: -21 },
        { bus: stabs, lufs: -24, reverb: 0.3, delay: 0.4 },
        { bus: pads, lufs: -27, reverb: 0.5 },
        { bus: fx, lufs: -29 },
      ],
      { reverb: { room: 0.75, lufs: -26 }, delay: { time: s.steps(3), feedback: 0.38, lufs: -29 } },
    );
  },
};

// Néon: synthwave, A minor (Am, F, C, G). Octave bass in eighths, square arpeggio, gated snare, a saw lead in B.
const neon: Preset = {
  id: 'neon',
  name: 'Néon',
  style: 'Synthwave rétro',
  use: 'Lancement, look rétro',
  bpm: 100,
  compose(s) {
    const CHORDS = [
      [57, 60, 64, 69],
      [53, 57, 60, 65],
      [55, 60, 64, 67],
      [55, 59, 62, 67],
    ];
    const ROOTS = [33, 29, 36, 31];
    const MELODY: [step: number, midi: number, sixteenths: number][][] = [
      [
        [0, 76, 6],
        [6, 74, 2],
        [8, 72, 8],
      ],
      [
        [0, 69, 4],
        [4, 72, 4],
        [8, 77, 8],
      ],
      [
        [0, 79, 6],
        [6, 76, 2],
        [8, 72, 8],
      ],
      [
        [0, 74, 12],
        [12, 71, 4],
      ],
    ];
    const ARP = [0, 1, 2, 3, 1, 2, 3, 2, 0, 1, 2, 3, 1, 2, 3, 2];
    const PAD: SynthOpts = {
      detune: [-10, -3, 4, 11],
      cutoff: 2200,
      q: 0.6,
      a: 0.25,
      d: 1.2,
      s: 0.8,
      r: 0.6,
      lfoRate: 0.15,
      lfoDepth: 400,
    };
    const BASS: SynthOpts = {
      cutoff: 350,
      env: 1100,
      envDecay: 0.07,
      q: 1,
      sub: 0.6,
      a: 0.003,
      d: 0.15,
      s: 0.6,
      r: 0.04,
      drive: 1.3,
    };
    const PLUCK: SynthOpts = { wave: 'square', cutoff: 700, env: 2400, envDecay: 0.08, q: 1.2, a: 0.002, d: 0.14, s: 0, r: 0.05 };
    const LEAD: SynthOpts = { detune: [-6, 6], cutoff: 2600, q: 0.9, a: 0.01, d: 0.5, s: 0.8, r: 0.18, vibrato: 18 };
    const SNARE = { tone: 180, decay: 0.2, snap: 0.6 };
    const { rand } = s;
    const [kicks, snares, hats, toms, bass, pads, arps, leads, fx] = Array.from({ length: 9 }, () => s.bus());
    const beats: number[] = [];
    const backbeats: number[] = [];
    for (let bar = 0; bar < s.bars; bar++) {
      const section = s.section(bar);
      const chord = CHORDS[bar % 4];
      if (section === 'end') {
        const t = s.at(bar);
        kick(kicks, t, rand);
        snare(snares, t, rand, SNARE);
        crash(fx, t, rand, { vel: 0.8 });
        beats.push(t);
        backbeats.push(t);
        for (const midi of CHORDS[0]) synth(pads, t, s.bar * 0.5, midi, rand, { ...PAD, r: 0.4 });
        synth(bass, t, s.bar * 0.3, ROOTS[0], rand, { ...BASS, r: 0.2 });
        continue;
      }
      if (s.drop(bar)) crash(fx, s.at(bar), rand, { vel: 0.6 });
      if (s.drop(bar + 1)) riser(fx, s.at(bar), s.bar, rand, { vel: 0.6, to: 6000 });
      for (const midi of chord) synth(pads, s.at(bar), s.bar, midi, rand, PAD);
      if (section === 'intro') {
        kick(kicks, s.at(bar), rand, { vel: 0.6 });
        beats.push(s.at(bar));
        for (const [step, vel] of hits('x...o...x...o...')) hat(hats, s.at(bar, step), rand, { vel, pan: 0.2 });
      }
      if (section !== 'break') {
        ARP.forEach((index, step) => {
          synth(arps, s.at(bar, step), s.steps(0.9), chord[index] + 12, rand, {
            ...PLUCK,
            vel: step % 4 ? (step % 2 ? 0.4 : 0.55) : 1,
          });
        });
      }
      if (section === 'a' || section === 'b') {
        for (const [step, vel] of hits(section === 'b' ? 'X...x...X...x...' : 'X.......X.......')) {
          kick(kicks, s.at(bar, step), rand, { vel });
          beats.push(s.at(bar, step));
        }
        for (const [step] of hits('....X.......X...')) {
          snare(snares, s.at(bar, step), rand, SNARE);
          backbeats.push(s.at(bar, step));
        }
        for (const [step, vel] of hits(section === 'b' ? 'XoxoXoxoXoxoXoxo' : 'x.o.x.o.x.o.x.o.')) {
          hat(hats, s.at(bar, step), rand, { vel, pan: 0.2 });
        }
        if (s.turn(bar)) {
          [196, 165, 131, 110].forEach((freq, i) => {
            perc(toms, s.at(bar, 12 + i), rand, { freq, decay: 0.2, bend: 1.6, click: 0.1, pan: 0.4 - i * 0.25 });
          });
        }
        for (let step = 0; step < 16; step += 2) {
          synth(bass, s.at(bar, step), s.steps(1.7), ROOTS[bar % 4] + (step % 4 ? 12 : 0), rand, {
            ...BASS,
            vel: step % 4 ? 0.5 : 1,
          });
        }
      }
      if (section === 'b' || section === 'break') {
        for (const [step, midi, length] of MELODY[bar % 4]) synth(leads, s.at(bar, step), s.steps(length), midi, rand, LEAD);
      }
    }
    // Gated reverb: the snare's room is cut short after each hit, the 80s way.
    const room = reverb(snares, { room: 0.9, damp: 0.3, predelay: 0.005 });
    gate(room, backbeats, 0.22, 0.02);
    s.openIntro(arps, 500);
    chorus(pads);
    duck(pads, beats, 0.35, 0.18);
    duck(bass, beats, 0.3);
    duck(arps, beats, 0.2);
    return mixdown(
      [
        { bus: kicks, lufs: -17 },
        { bus: snares, lufs: -20 },
        { bus: room, lufs: -24 },
        { bus: hats, lufs: -27 },
        { bus: toms, lufs: -25, reverb: 0.2 },
        { bus: bass, lufs: -20 },
        { bus: pads, lufs: -23, reverb: 0.3 },
        { bus: arps, lufs: -26, reverb: 0.3, delay: 0.25 },
        { bus: leads, lufs: -22, reverb: 0.35, delay: 0.3 },
        { bus: fx, lufs: -28 },
      ],
      { reverb: { room: 0.85, lufs: -25 }, delay: { time: s.steps(3), feedback: 0.4, lufs: -27 } },
    );
  },
};

// Afro: amapiano, descending Fmaj9, Em7, Dm9, Cmaj9. Log drum bassline, shakers, claps on 2 and 4, Rhodes stabs.
const afro: Preset = {
  id: 'afro',
  name: 'Afro',
  style: 'Amapiano',
  use: 'Annonce, événement',
  bpm: 112,
  swing: 0.1,
  compose(s) {
    const CHORDS = [
      [57, 60, 64, 67],
      [55, 59, 62, 64],
      [53, 57, 60, 64],
      [52, 55, 59, 62],
    ];
    const ROOTS = [41, 40, 38, 36];
    const LOGS: [step: number, interval: number, sixteenths: number, vel: number][][] = [
      [
        [0, 0, 3, 1],
        [3, 12, 2, 0.7],
        [6, 0, 2, 0.85],
        [10, 0, 3, 0.9],
        [12, 12, 2, 0.6],
        [14, 7, 2, 0.75],
      ],
      [
        [0, 0, 3, 1],
        [4, 12, 2, 0.7],
        [7, 0, 2, 0.8],
        [10, 0, 2, 0.9],
        [13, 7, 2, 0.7],
      ],
    ];
    const RHODES: FmOpts = { ratio: 1, index: 1.6, indexDecay: 0.6, tine: 0.9, decay: 1.8, r: 0.25 };
    const PAD: SynthOpts = { detune: [-9, 0, 9], cutoff: 1200, q: 0.6, a: 0.8, s: 0.8, r: 1.2 };
    const KICK = { from: 120, to: 50, decay: 0.32, drive: 1.6, click: 0.1 };
    const { rand } = s;
    const human = () => (rand() * 2 - 1) * 0.003;
    const [kicks, claps, shakers, hats, claves, logs, keys, pads, fx] = Array.from({ length: 9 }, () => s.bus());
    const beats: number[] = [];
    for (let bar = 0; bar < s.bars; bar++) {
      const section = s.section(bar);
      const chord = CHORDS[bar % 4];
      const root = ROOTS[bar % 4];
      if (section === 'end') {
        const t = s.at(bar);
        kick(kicks, t, rand, KICK);
        beats.push(t);
        logDrum(logs, t, s.steps(6), ROOTS[0], rand, { decay: 0.45 });
        strum(keys, t, s.steps(8), CHORDS[0], { ...RHODES, decay: 2 });
        crash(fx, t, rand, { vel: 0.5 });
        continue;
      }
      if (s.drop(bar)) crash(fx, s.at(bar), rand, { vel: 0.4 });
      if (s.drop(bar + 1)) riser(fx, s.at(bar), s.bar, rand, { vel: 0.5 });
      for (const [step, length, vel] of [
        [0, 5, 0.8],
        [6, 2, 0.55],
        [10, 5, 0.7],
      ]) {
        strum(keys, s.at(bar, step), s.steps(length), chord, { ...RHODES, vel });
      }
      for (const [step, vel] of hits('XoxoXoxoXoxoXoxo')) shaker(shakers, s.at(bar, step) + human(), rand, { vel, pan: -0.35 });
      if (section === 'intro') {
        kick(kicks, s.at(bar), rand, { ...KICK, vel: 0.6 });
        beats.push(s.at(bar));
      }
      if (section === 'a' || section === 'b') {
        for (const [step, vel] of hits('X.......X.......')) {
          kick(kicks, s.at(bar, step), rand, { ...KICK, vel });
          beats.push(s.at(bar, step));
        }
        for (const [step, vel] of hits(s.turn(bar) ? '....X.......X.xx' : '....X.......X...')) {
          clap(claps, s.at(bar, step), rand, { vel: vel * 0.9, pan: -0.25 });
          clap(claps, s.at(bar, step), rand, { vel: vel * 0.9, pan: 0.25 });
        }
        for (const [step, interval, length, vel] of LOGS[bar % 2]) {
          logDrum(logs, s.at(bar, step), s.steps(length), root + interval, rand, { vel });
        }
        // A pickup into the next chord.
        if (bar % 2) logDrum(logs, s.at(bar, 15), s.steps(1), ROOTS[(bar + 1) % 4], rand, { vel: 0.6 });
      }
      if (section === 'b') {
        for (const [step, vel] of hits('..x...x...x...x.'))
          hat(hats, s.at(bar, step), rand, { vel: vel * 0.7, decay: 0.16, pan: 0.25 });
        // Son clave over two bars: 3 then 2.
        for (const step of bar % 2 ? [4, 8] : [0, 6, 12]) {
          perc(claves, s.at(bar, step), rand, { freq: 2400, decay: 0.03, bend: 1.15, click: 0.1, vel: 0.8, pan: 0.35 });
        }
      }
      if (section === 'b' || section === 'break') for (const midi of chord) synth(pads, s.at(bar), s.bar, midi, rand, PAD);
      if (section === 'break') logDrum(logs, s.at(bar), s.steps(4), root, rand, { decay: 0.4 });
    }
    s.openIntro(keys, 600);
    autopan(keys, 4.5, 0.2);
    duck(pads, beats, 0.4, 0.15);
    duck(keys, beats, 0.15);
    return mixdown(
      [
        { bus: kicks, lufs: -19 },
        { bus: logs, lufs: -20 },
        { bus: claps, lufs: -23, reverb: 0.25 },
        { bus: shakers, lufs: -25 },
        { bus: hats, lufs: -28 },
        { bus: claves, lufs: -28, reverb: 0.3, delay: 0.3 },
        { bus: keys, lufs: -21, reverb: 0.25, delay: 0.12 },
        { bus: pads, lufs: -27, reverb: 0.4 },
        { bus: fx, lufs: -30 },
      ],
      { reverb: { room: 0.7, lufs: -26 }, delay: { time: s.steps(3), feedback: 0.3, lufs: -30 } },
    );
  },
};

// Lo-fi: hip-hop, F major (Gm9, C9, Fmaj9, Dm9). Swung boom bap, walking sine bass, wobbly electric piano, vinyl.
const lofi: Preset = {
  id: 'lofi',
  name: 'Lo-fi',
  style: 'Lo-fi hip-hop',
  use: 'Tuto, démo calme',
  bpm: 85,
  swing: 0.22,
  compose(s) {
    const CHORDS = [
      [58, 62, 65, 69],
      [58, 62, 64, 67],
      [57, 60, 64, 67],
      [53, 57, 60, 64],
    ];
    const ROOTS = [43, 36, 41, 38];
    const MELODY: [step: number, midi: number, sixteenths: number][][] = [
      [
        [2, 74, 3],
        [6, 72, 2],
        [8, 69, 6],
      ],
      [
        [4, 67, 4],
        [10, 69, 4],
      ],
      [
        [0, 72, 6],
        [8, 69, 2],
        [10, 67, 4],
      ],
      [
        [8, 74, 2],
        [12, 72, 4],
      ],
    ];
    const KEYS: FmOpts = { ratio: 1, index: 1.3, indexDecay: 0.8, tine: 0.6, decay: 2.2, r: 0.35 };
    const BELL: FmOpts = { ratio: 2, index: 0.9, indexDecay: 0.3, decay: 1, r: 0.3 };
    const BASS: SynthOpts = { wave: 'triangle', cutoff: 500, q: 0.7, sub: 0.7, a: 0.008, d: 0.4, s: 0.7, r: 0.08, drive: 1.2 };
    const KICK = { from: 110, to: 50, decay: 0.22, drive: 1.3, click: 0.05 };
    const SNARE = { tone: 200, decay: 0.12, snap: 0.55, color: 2500 };
    const { rand } = s;
    const [kicks, snares, hats, bass, keys, bells, dust] = Array.from({ length: 7 }, () => s.bus());
    const beats: number[] = [];
    vinyl(dust, rand);
    for (let bar = 0; bar < s.bars; bar++) {
      const section = s.section(bar);
      const root = ROOTS[bar % 4];
      if (section === 'end') {
        const t = s.at(bar);
        kick(kicks, t, rand, { ...KICK, vel: 0.8 });
        strum(keys, t, s.bar * 0.6, CHORDS[2], { ...KEYS, decay: 2.5 }, 0.02);
        synth(bass, t, s.steps(4), ROOTS[2], rand, BASS);
        continue;
      }
      strum(keys, s.at(bar), s.steps(10), CHORDS[bar % 4], { ...KEYS, vel: 0.7 }, 0.015);
      if (section === 'intro') {
        kick(kicks, s.at(bar), rand, { ...KICK, vel: 0.6 });
        for (const [step, vel] of hits('x.o.x.o.x.o.x.o.'))
          hat(hats, s.at(bar, step), rand, { vel: vel * 0.7, decay: 0.03, tone: 6500, pan: 0.25 });
      }
      strum(keys, s.at(bar, 10), s.steps(6), CHORDS[bar % 4], { ...KEYS, vel: 0.5 }, 0.015);
      if (section === 'a' || section === 'b') {
        for (const [step, vel] of hits('X.......X.x.....')) {
          kick(kicks, s.at(bar, step), rand, { ...KICK, vel });
          beats.push(s.at(bar, step));
        }
        for (const [step, vel] of hits(bar % 2 ? '....X.......X..o' : '....X.......X...')) {
          snare(snares, s.at(bar, step), rand, { ...SNARE, vel: vel * 0.9 });
        }
        for (const [step, vel] of hits('x.o.x.o.x.o.x.o.')) {
          const t = s.at(bar, step) + (rand() * 2 - 1) * 0.002;
          hat(hats, t, rand, { vel: vel * (0.8 + 0.3 * rand()), decay: 0.03, tone: 6500, pan: 0.25 });
        }
        // Root, fifth, and a chromatic step up into the next root.
        const next = ROOTS[(bar + 1) % 4];
        for (const [step, midi, length, vel] of [
          [0, root, 5, 1],
          [6, root, 2, 0.7],
          [10, root + 7, 3, 0.85],
          [14, next - 1, 2, 0.7],
        ]) {
          synth(bass, s.at(bar, step), s.steps(length), midi, rand, { ...BASS, vel });
        }
      }
      if (section === 'b' || section === 'break') {
        for (const [step, midi, length] of MELODY[bar % 4]) fm(bells, s.at(bar, step), s.steps(length), midi, BELL);
      }
    }
    s.openIntro(keys, 700);
    wow(keys);
    wow(bells);
    for (const bus of [kicks, snares, hats]) eq(bus, 'lowpass', 6000);
    duck(keys, beats, 0.25, 0.15);
    const mix = mixdown(
      [
        { bus: kicks, lufs: -19 },
        { bus: snares, lufs: -22, reverb: 0.15 },
        { bus: hats, lufs: -28 },
        { bus: bass, lufs: -21 },
        { bus: keys, lufs: -20, reverb: 0.2 },
        { bus: bells, lufs: -24, reverb: 0.35, delay: 0.35 },
        { bus: dust, lufs: -36 },
      ],
      { reverb: { room: 0.6, damp: 0.6, lufs: -26 }, delay: { time: s.steps(3), feedback: 0.35, tone: 2500, lufs: -30 } },
    );
    eq(mix, 'lowpass', 7500);
    return mix;
  },
};

// Nappe: ambient, D major (Dmaj9, Bm11, Gmaj9, Asus4). Slow pads, a soft pulse, plucks and bells in long echoes.
const nappe: Preset = {
  id: 'nappe',
  name: 'Nappe',
  style: 'Ambiant',
  use: 'Intro, explication',
  bpm: 90,
  compose(s) {
    const CHORDS = [
      [50, 57, 61, 64, 66],
      [47, 54, 57, 62, 64],
      [43, 50, 59, 66, 69],
      [45, 52, 57, 62, 64],
    ];
    const ROOTS = [38, 35, 31, 33];
    const BELLS: [step: number, midi: number, sixteenths: number][][] = [
      [[0, 78, 8]],
      [[8, 76, 8]],
      [
        [0, 81, 6],
        [8, 78, 8],
      ],
      [[4, 76, 12]],
    ];
    const ORDER = [0, 2, 4, 1, 3, 2, 4, 3];
    const PAD: SynthOpts = {
      detune: [-14, -5, 4, 13],
      cutoff: 1300,
      q: 0.6,
      a: 1,
      d: 2,
      s: 0.9,
      r: 2,
      lfoRate: 0.07,
      lfoDepth: 450,
    };
    const PLUCK: FmOpts = { ratio: 1, index: 1.1, indexDecay: 0.15, decay: 0.5, r: 0.2 };
    const BELL: FmOpts = { ratio: 3.5, index: 1.8, indexDecay: 0.6, decay: 1.6, r: 0.6 };
    const SUB: SynthOpts = { wave: 'sine', a: 0.3, s: 1, r: 0.6 };
    const KICK = { from: 90, to: 46, drop: 0.05, decay: 0.25, drive: 1.1, click: 0.02 };
    const { rand } = s;
    const [kicks, ticks, subs, pads, plucks, bells] = Array.from({ length: 6 }, () => s.bus());
    const beats: number[] = [];
    for (let bar = 0; bar < s.bars; bar++) {
      const section = s.section(bar);
      const chord = CHORDS[bar % 4];
      if (section === 'end') {
        const t = s.at(bar);
        kick(kicks, t, rand, { ...KICK, vel: 0.8 });
        for (const midi of CHORDS[0]) synth(pads, t, s.bar * 0.4, midi, rand, { ...PAD, a: 0.05, r: 0.8 });
        fm(bells, t, s.steps(8), 78, BELL);
        continue;
      }
      for (const midi of chord) synth(pads, s.at(bar), s.bar, midi, rand, PAD);
      if (section !== 'break') {
        ORDER.slice(0, 4).forEach((index, i) =>
          fm(plucks, s.at(bar, 4 * i), s.steps(4), chord[index] + 12, { ...PLUCK, vel: i ? 0.75 : 0.9 }),
        );
      }
      if (section !== 'break')
        for (const [step] of hits('x...x...x...x...')) shaker(ticks, s.at(bar, step), rand, { decay: 0.025, pan: 0.3 });
      if (section === 'a' || section === 'b') {
        for (const [step, vel] of hits('X.......X.......')) {
          kick(kicks, s.at(bar, step), rand, { ...KICK, vel: vel * 0.9 });
          beats.push(s.at(bar, step));
        }
        synth(subs, s.at(bar), s.bar * 0.95, ROOTS[bar % 4], rand, SUB);
      }
      if (section === 'b' || section === 'break') {
        for (const [step, midi, length] of BELLS[bar % 4]) fm(bells, s.at(bar, step), s.steps(length), midi, BELL);
      }
    }
    s.openIntro(plucks, 400);
    chorus(pads, { rate: 0.25, depth: 0.004, mix: 0.5 });
    eq(pads, 'highpass', 120);
    duck(pads, beats, 0.2, 0.25);
    return mixdown(
      [
        { bus: pads, lufs: -20, reverb: 0.5 },
        { bus: plucks, lufs: -25, reverb: 0.5, delay: 0.5 },
        { bus: bells, lufs: -25, reverb: 0.6, delay: 0.4 },
        { bus: kicks, lufs: -21 },
        { bus: ticks, lufs: -28 },
        { bus: subs, lufs: -24 },
      ],
      {
        reverb: { room: 0.92, damp: 0.35, predelay: 0.04, lufs: -21 },
        delay: { time: s.steps(4), feedback: 0.5, tone: 3000, lufs: -24 },
      },
    );
  },
};

// Sprint: drum & bass, F minor (Fm9, Dbmaj7, Ab, Eb, two bars each). Two-step break, reese and sub, a pluck hook in B.
const sprint: Preset = {
  id: 'sprint',
  name: 'Sprint',
  style: 'Drum & bass',
  use: 'Promo rapide',
  bpm: 170,
  compose(s) {
    const CHORDS = [
      [56, 60, 63, 67],
      [56, 61, 65, 72],
      [51, 56, 60, 63],
      [55, 58, 63, 67],
    ];
    const ROOTS = [29, 37, 32, 39];
    const HOOK = [3, 2, 1, 2, 0, 1, 2, 1];
    const REESE: SynthOpts = {
      detune: [-14, 14],
      cutoff: 380,
      q: 1.1,
      lfoRate: 0.5,
      lfoDepth: 160,
      a: 0.01,
      s: 1,
      r: 0.08,
      drive: 1.6,
    };
    const SUB: SynthOpts = { wave: 'sine', a: 0.005, s: 1, r: 0.05 };
    const PAD: SynthOpts = { detune: [-10, -3, 4, 11], cutoff: 2600, q: 0.6, a: 0.4, s: 0.8, r: 0.8 };
    const PLUCK: SynthOpts = {
      wave: 'square',
      detune: [-5, 5],
      cutoff: 900,
      env: 3000,
      envDecay: 0.06,
      q: 1.2,
      a: 0.002,
      d: 0.12,
      s: 0,
      r: 0.05,
    };
    const SNARE = { tone: 185, decay: 0.16, snap: 0.6, color: 3800 };
    const { rand } = s;
    const [kicks, snares, hats, reese, subs, pads, plucks, fx] = Array.from({ length: 8 }, () => s.bus());
    const beats: number[] = [];
    for (let bar = 0; bar < s.bars; bar++) {
      const section = s.section(bar);
      const chord = CHORDS[Math.floor(bar / 2) % 4];
      const root = ROOTS[Math.floor(bar / 2) % 4];
      if (section === 'end') {
        const t = s.at(bar);
        kick(kicks, t, rand);
        beats.push(t);
        crash(fx, t, rand, { vel: 0.8 });
        kick(subs, t, rand, { from: 70, to: 40, drop: 0.3, decay: 0.8, drive: 1.2, click: 0 });
        for (const midi of CHORDS[0]) synth(pads, t, s.bar * 0.6, midi, rand, { ...PAD, r: 0.5 });
        continue;
      }
      if (s.drop(bar)) crash(fx, s.at(bar), rand, { vel: 0.7 });
      if (s.drop(bar + 1)) riser(fx, s.at(bar), s.bar, rand, { vel: 0.8 });
      if (bar % 2 === 0) for (const midi of chord) synth(pads, s.at(bar), 2 * s.bar, midi, rand, PAD);
      if (section !== 'break') {
        for (const [step, vel] of hits(section === 'b' ? 'xoXoxoXoxoXoxoXo' : 'x.x.x.x.x.x.x.x.')) {
          hat(hats, s.at(bar, step), rand, { vel: vel * 0.9, pan: 0.2 });
        }
      }
      if (section === 'a' || section === 'b') {
        for (const [step, vel] of hits(section === 'b' ? 'X..o......X.....' : 'X.........X.....')) {
          kick(kicks, s.at(bar, step), rand, { vel });
          beats.push(s.at(bar, step));
        }
        for (const [step, vel] of hits(s.turn(bar) ? '....X..o....X.XX' : '....X..o....X.o.')) {
          snare(snares, s.at(bar, step), rand, { ...SNARE, vel });
        }
        synth(reese, s.at(bar), s.bar * 0.98, root + 12, rand, REESE);
        synth(subs, s.at(bar), s.bar * 0.98, root, rand, SUB);
      }
      if (section === 'b' || section === 'break') {
        HOOK.forEach((index, i) => {
          synth(plucks, s.at(bar, 2 * i), s.steps(1.5), chord[index] + 12, rand, { ...PLUCK, vel: i % 2 ? 0.6 : 0.9 });
        });
      }
    }
    eq(pads, 'highpass', 300);
    duck(reese, beats, 0.45);
    duck(subs, beats, 0.6);
    duck(pads, beats, 0.4, 0.12);
    duck(plucks, beats, 0.2);
    return mixdown(
      [
        { bus: kicks, lufs: -18 },
        { bus: snares, lufs: -19, reverb: 0.15 },
        { bus: hats, lufs: -26 },
        { bus: reese, lufs: -22 },
        { bus: subs, lufs: -21 },
        { bus: pads, lufs: -25, reverb: 0.4 },
        { bus: plucks, lufs: -24, reverb: 0.3, delay: 0.4 },
        { bus: fx, lufs: -28 },
      ],
      { reverb: { room: 0.8, lufs: -25 }, delay: { time: s.steps(3), feedback: 0.4, lufs: -28 } },
    );
  },
};

const PRESETS = [pulse, neon, afro, lofi, nappe, sprint];

/** About 15, 30 and 60 s: an even number of bars, at least 6. */
const versionBars = (bpm: number) => [15, 30, 60].map((seconds) => Math.max(6, 2 * Math.round((seconds * bpm) / 480)));

/** The presets and their versions, as the editor lists them (src/editor/soundtracks/presets.json). */
export function soundtracks(): Soundtrack[] {
  return PRESETS.map(({ id, name, style, use, bpm }) => ({
    id,
    name,
    style,
    use,
    bpm,
    versions: versionBars(bpm).map((bars) => {
      const duration = Math.round((bars * 240000) / bpm) / 1000;
      return { file: `${id}-${Math.round(duration)}s.m4a`, bars, duration };
    }),
  }));
}

/** Renders the versions of every preset (or of those in `only`) into `dir` as AAC, and writes presets.json. */
export async function writeSoundtracks(dir: string, ffmpeg: string, only: string[] = []): Promise<void> {
  const unknown = only.filter((id) => !PRESETS.some((p) => p.id === id));
  if (unknown.length) {
    throw new Error(m().media.soundtracks.unknown(unknown.join(', '), PRESETS.map((p) => p.id).join(', ')));
  }
  await fs.mkdir(dir, { recursive: true });
  const list = soundtracks();
  for (const [i, preset] of PRESETS.entries()) {
    if (only.length && !only.includes(preset.id)) continue;
    for (const version of list[i].versions) {
      const seed = [...preset.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, version.bars);
      const song = new Song(preset.bpm, version.bars, preset.swing ?? 0, seed);
      const mix = preset.compose(song);
      fade(mix, song.bar / 2);
      const { lufs, peak } = master(mix);
      encode(mix, path.join(dir, version.file), ffmpeg);
      console.log(
        m().media.soundtracks.written(version.file.padEnd(16), version.bars, version.duration, lufs.toFixed(1), peak.toFixed(1)),
      );
    }
  }
  await fs.writeFile(path.join(dir, 'presets.json'), `${JSON.stringify(list, null, 2)}\n`);
}
