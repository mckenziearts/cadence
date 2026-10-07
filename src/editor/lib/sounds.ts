// The scenes' sound effects in the preview and in Present: the frame's cues, played from the library with Web Audio,
// scheduled a little ahead of the playhead so each one starts on time.
import { useEffect, useState } from 'react';
import {
  MAX_SOUND_CUES,
  MAX_VIDEO_SOUND_CUES,
  parseSoundCues,
  SOUND_NAMES,
  SOUND_PEAKS,
  type SoundCueTexts,
  type SoundName,
} from '../../shared/sounds';

/** Seconds scheduled ahead at each tick: more than a dropped frame or two, short enough that a pause cuts nothing heard. */
const LOOKAHEAD_S = 0.15;
// ponytail: a cue at most 0.1 s late (the first tick after play or a seek comes a frame late, the context resumes) is
// played now; later than that it is skipped. Raise it if opening cues go missing on slow machines.
const LATE_S = 0.1;
// ponytail: past 64 sounds at once a cue is left out of the preview (the MP4 mixes them all); thousands of cues on one
// instant would otherwise start thousands of nodes. Raise it if dense scenes sound thin.
const MAX_SOUNDING = 64;
const LONGEST_PEAK = Math.max(...Object.values(SOUND_PEAKS));

const URLS: Record<SoundName, string> = {
  click: new URL('../sounds/click.wav', import.meta.url).href,
  key: new URL('../sounds/key.wav', import.meta.url).href,
  pop: new URL('../sounds/pop.wav', import.meta.url).href,
  whoosh: new URL('../sounds/whoosh.wav', import.meta.url).href,
  impact: new URL('../sounds/impact.wav', import.meta.url).href,
};

/** The editor drops an invalid message without a word: the frame already reports a failing `sounds()`. */
const UNSHOWN: SoundCueTexts = {
  notArray: '',
  tooMany: () => '',
  notObject: () => '',
  at: () => '',
  sound: () => '',
  gain: () => '',
};

/** The part of an AudioContext the player uses. */
export type AudioOut = Pick<
  AudioContext,
  'currentTime' | 'state' | 'destination' | 'resume' | 'close' | 'createBufferSource' | 'createGain' | 'createDynamicsCompressor'
>;

export type SoundLibrary = Map<SoundName, AudioBuffer>;

/** What the frame shows: its scene (null: the whole video), its length and how many scenes it holds. */
export interface ShownSounds {
  sceneId: string | null;
  duration: number;
  scenes: number;
}

interface Planned {
  /** Where the file starts on the playhead's timeline: before the cue, by its peak. */
  start: number;
  at: number;
  sound: SoundName;
  gain: number;
}

let library: Promise<SoundLibrary> | null = null;

/** Decoded once per page for the preview and Present: an AudioBuffer plays in any AudioContext, and decoding needs no gesture. */
function loadLibrary(): Promise<SoundLibrary> {
  library ??= (async () => {
    const decoder = new OfflineAudioContext(1, 1, 44100);
    const decoded = await Promise.all(
      SOUND_NAMES.map(
        async (sound) => [sound, await decoder.decodeAudioData(await (await fetch(URLS[sound])).arrayBuffer())] as const,
      ),
    );
    return new Map(decoded);
  })().catch((error: unknown) => {
    library = null;
    throw error;
  });
  return library;
}

export class SoundPlayer {
  private ctx: AudioOut | null = null;
  /** Sums the sources into the output without clipping, like the MP4's limiter after its mix. */
  private limiter: DynamicsCompressorNode | null = null;
  private buffers: SoundLibrary | null = null;
  private loading = false;
  /** The last load failed: the next play gesture tries again, a message does not (scene code can post in a loop). */
  private failed = false;
  private shown: ShownSounds = { sceneId: null, duration: 0, scenes: 0 };
  private message: { sceneId: string | null; cues: unknown[] } | null = null;
  /** A message arrived since the last plan: scene code can post in a loop, so it is parsed at most once per tick. */
  private dirty = false;
  /** Sorted by start. */
  private cues: Planned[] = [];
  /** The next cue to schedule; -1 until a tick places it. */
  private next = -1;
  /** Where the playhead was at the last scheduling tick, or where playback starts: cues peaking before it are not owed. */
  private from = 0;
  private readonly sounding = new Set<AudioBufferSourceNode>();
  private readonly open: () => AudioOut;
  private readonly load: () => Promise<SoundLibrary>;

  constructor(open: () => AudioOut = () => new AudioContext(), load = loadLibrary) {
    this.open = open;
    this.load = load;
  }

  /** Call it on the play gesture (autoplay policy), with the playhead playback starts from: opens or resumes the context. */
  play(from: number): void {
    this.reset(from);
    this.failed = false;
    this.loadIfCued();
    if (!this.ctx) {
      const ctx = (this.ctx = this.open());
      const limiter = (this.limiter = ctx.createDynamicsCompressor());
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      limiter.connect(ctx.destination);
    }
    this.ctx.resume().catch(() => undefined);
  }

  show(shown: ShownSounds): void {
    const { sceneId, duration, scenes } = this.shown;
    if (shown.sceneId === sceneId && shown.duration === duration && shown.scenes === scenes) return;
    this.shown = shown;
    this.plan();
  }

  /** A `sounds` message from the frame; scene code can post its own, so the cues are checked again at the next tick. */
  receive(sceneId: unknown, cues: unknown): void {
    this.message =
      Array.isArray(cues) && cues.length <= MAX_VIDEO_SOUND_CUES && (sceneId === null || typeof sceneId === 'string')
        ? { sceneId, cues }
        : null;
    this.dirty = true;
    this.loadIfCued();
  }

  /** The frame changed: what the previous one posted no longer holds. */
  forget(): void {
    this.message = null;
    this.dirty = true;
  }

  /** At each frame of playback; `playing` false stops what is pending. `playhead` is on the cues' timeline. */
  tick(playhead: number, playing: boolean): void {
    if (!playing) return this.reset(playhead);
    if (this.dirty) this.plan();
    const { ctx, buffers, limiter } = this;
    // Not ready yet: `from` stays where playback started, so the cues since then are still owed.
    if (!ctx || !buffers || !limiter || ctx.state !== 'running') return;
    if (this.next < 0) this.next = firstFrom(this.cues, this.from - LONGEST_PEAK);
    const now = ctx.currentTime;
    for (; this.next < this.cues.length && this.cues[this.next].start < playhead + LOOKAHEAD_S; this.next++) {
      const cue = this.cues[this.next];
      if (cue.at < this.from || cue.at < playhead - LATE_S || this.sounding.size >= MAX_SOUNDING) continue;
      // A peak already passed plays now with its attack, from where it was owed, but lands at most LATE_S after its cue
      // (a long dropped frame); one ahead lands on its cue.
      const late = cue.at < playhead;
      const source = ctx.createBufferSource();
      source.buffer = buffers.get(cue.sound)!;
      const gain = ctx.createGain();
      gain.gain.value = cue.gain;
      source.connect(gain).connect(limiter);
      source.onended = () => this.sounding.delete(source);
      source.start(
        now + Math.max(0, cue.start - playhead),
        Math.max(0, (late ? Math.max(this.from, playhead - LATE_S) : playhead) - cue.start),
      );
      this.sounding.add(source);
    }
    this.from = playhead;
  }

  /** Seek, pause, loop, scene change: stops what is pending; the next tick schedules again, owing the cues from `from` on. */
  reset(from: number): void {
    for (const source of this.sounding) source.stop();
    this.sounding.clear();
    this.next = -1;
    this.from = from;
  }

  close(): void {
    this.reset(this.from);
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.limiter = null;
  }

  private loadIfCued(): void {
    if (this.buffers || this.loading || this.failed || !this.message?.cues.length) return;
    this.loading = true;
    this.load()
      .then(
        (buffers) => (this.buffers = buffers),
        () => (this.failed = true),
      )
      .finally(() => (this.loading = false));
  }

  private plan(): void {
    this.dirty = false;
    const { sceneId, duration, scenes } = this.shown;
    const max = Math.min(MAX_SOUND_CUES * scenes, MAX_VIDEO_SOUND_CUES);
    const parsed =
      this.message?.sceneId === sceneId ? parseSoundCues(this.message.cues, duration + 0.001, UNSHOWN, max) : { cues: [] };
    const cues =
      'cues' in parsed
        ? parsed.cues.map((cue) => ({ ...cue, start: cue.at - SOUND_PEAKS[cue.sound] })).sort((a, b) => a.start - b.start)
        : [];
    // The frame posts again after each reload: unchanged cues must not cut and restart what is playing.
    if (sameCues(cues, this.cues)) return;
    this.cues = cues;
    this.reset(this.from);
  }
}

function sameCues(a: Planned[], b: Planned[]): boolean {
  return (
    a.length === b.length &&
    a.every((cue, i) => cue.at === b[i].at && cue.start === b[i].start && cue.sound === b[i].sound && cue.gain === b[i].gain)
  );
}

/** Index of the first cue starting at or after `t`. */
function firstFrom(cues: Planned[], t: number): number {
  let [low, high] = [0, cues.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cues[middle].start < t) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** A player for the component's lifetime: its AudioContext opens on the first play and closes on unmount. */
export function useSoundPlayer(): SoundPlayer {
  const [player] = useState(() => new SoundPlayer());
  useEffect(() => () => player.close(), [player]);
  return player;
}
