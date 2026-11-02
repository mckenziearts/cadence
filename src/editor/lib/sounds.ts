// The scenes' sounds in the preview and in Present: the frame's cues, played from the library or the project's clips with
// Web Audio, scheduled a little ahead of the playhead so each one starts on time.
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
import type { ClipState } from '../../shared/types';

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
  both: () => '',
  clipUnknown: () => '',
  clipPreparing: () => '',
  clipFailed: () => '',
  clipSilent: () => '',
  clipFrom: () => '',
  clipDuration: () => '',
  clipTotal: () => '',
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

interface PlannedClip {
  at: number;
  /** The project and the clip's key: a file replaced under the same name is decoded again. */
  id: string;
  file: string;
  from: number;
  duration: number;
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

type ClipAudio = Map<string, AudioBuffer | 'loading' | 'failed'>;
/** Shared by the players of the page, the stage's and the presentation's: a clip is fetched and decoded once. */
const sharedClipAudio: ClipAudio = new Map();

// ponytail: the clip's whole sound (its first 10 minutes) as the mono WAV the server extracts, about 10.6 MB decoded per
// minute; requests per cue range if long clips weigh on the editor.
async function loadClipAudio(url: string): Promise<AudioBuffer> {
  // Not from the HTTP cache: a file replaced under the same name has a new key and must not decode the old bytes.
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return new OfflineAudioContext(1, 1, 44100).decodeAudioData(await response.arrayBuffer());
}

export class SoundPlayer {
  /** The players that told which clips they cue: a clip sound stays while one of those sharing its map cues it. */
  private static readonly cueing = new Set<SoundPlayer>();
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
  private projectId = '';
  private clips: Record<string, ClipState> = {};
  /** Sorted by at. */
  private clipCues: PlannedClip[] = [];
  /** The next clip cue to schedule. */
  private clipNext = 0;
  /** The clips the cues of the shown scene last played; kept while a frame reloads or a new scene has not posted. */
  private cued = new Set<string>();
  private readonly open: () => AudioOut;
  private readonly load: () => Promise<SoundLibrary>;
  private readonly loadClip: (url: string) => Promise<AudioBuffer>;
  private readonly clipAudio: ClipAudio;

  constructor(
    open: () => AudioOut = () => new AudioContext(),
    load = loadLibrary,
    loadClip = loadClipAudio,
    clipAudio = sharedClipAudio,
  ) {
    this.open = open;
    this.load = load;
    this.loadClip = loadClip;
    this.clipAudio = clipAudio;
  }

  /** Call it on the play gesture (autoplay policy), with the playhead playback starts from: opens or resumes the context. */
  play(from: number): void {
    this.reset(from);
    this.failed = false;
    this.loadIfCued();
    for (const [id, audio] of this.clipAudio) if (audio === 'failed') this.clipAudio.delete(id);
    this.plan();
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

  /** The clips of the shown project: the cues are checked against them, and a clip cue plays its file's sound. */
  setClips(projectId: string, clips: Record<string, ClipState>): void {
    this.projectId = projectId;
    this.clips = clips;
    const kept = new Set(Object.values(clips).flatMap((clip) => (clip.status === 'ready' ? [`${projectId}/${clip.key}`] : [])));
    for (const id of this.clipAudio.keys()) if (!kept.has(id)) this.clipAudio.delete(id);
    this.dirty = true;
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
    if (!ctx || !limiter || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    this.tickClips(ctx, limiter, now, playhead);
    // Not ready yet: `from` stays where playback started, so the cues since then are still owed.
    if (!buffers) return;
    if (this.next < 0) this.next = firstFrom(this.cues, this.from - LONGEST_PEAK);
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

  /** A clip cue plays from where the playhead is in it: a seek, a late tick or a slow decode joins it in time. */
  private tickClips(ctx: AudioOut, limiter: DynamicsCompressorNode, now: number, playhead: number): void {
    for (; this.clipNext < this.clipCues.length && this.clipCues[this.clipNext].at < playhead + LOOKAHEAD_S; this.clipNext++) {
      const cue = this.clipCues[this.clipNext];
      const into = Math.max(0, playhead - cue.at);
      if (into >= cue.duration) continue;
      const audio = this.clipAudio.get(cue.id);
      // Still decoding: this cue and the ones after it wait for a later tick, then join in time.
      if (audio === 'loading') return;
      if (typeof audio !== 'object' || this.sounding.size >= MAX_SOUNDING) continue;
      const source = ctx.createBufferSource();
      source.buffer = audio;
      const gain = ctx.createGain();
      gain.gain.value = cue.gain;
      source.connect(gain).connect(limiter);
      source.onended = () => this.sounding.delete(source);
      source.start(now + Math.max(0, cue.at - playhead), cue.from + into, cue.duration - into);
      this.sounding.add(source);
    }
  }

  /** Seek, pause, loop, scene change: stops what is pending; the next tick schedules again, owing the cues from `from` on. */
  reset(from: number): void {
    for (const source of this.sounding) source.stop();
    this.sounding.clear();
    this.next = -1;
    this.clipNext = 0;
    this.from = from;
  }

  close(): void {
    this.keep(new Set());
    SoundPlayer.cueing.delete(this);
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
      this.message?.sceneId === sceneId
        ? parseSoundCues(this.message.cues, duration + 0.001, UNSHOWN, this.clips, max)
        : { cues: [] };
    const all = 'cues' in parsed ? parsed.cues : [];
    const cues = all
      .flatMap((cue) => ('sound' in cue ? [{ ...cue, start: cue.at - SOUND_PEAKS[cue.sound] }] : []))
      .sort((a, b) => a.start - b.start);
    const clipCues = all
      .flatMap((cue) => {
        if (!('clip' in cue)) return [];
        const { at, clip, from, duration, gain } = cue;
        const state = this.clips[clip];
        return state.status === 'ready' ? [{ at, id: `${this.projectId}/${state.key}`, file: clip, from, duration, gain }] : [];
      })
      .sort((a, b) => a.at - b.at);
    clipCues.forEach((cue) => this.loadClipCue(cue));
    if (this.message?.sceneId === sceneId && 'cues' in parsed) this.keep(new Set(clipCues.map(({ id }) => id)));
    // The frame posts again after each reload: unchanged cues must not cut and restart what is playing.
    if (sameCues(cues, this.cues) && JSON.stringify(clipCues) === JSON.stringify(this.clipCues)) return;
    this.cues = cues;
    this.clipCues = clipCues;
    this.reset(this.from);
  }

  /** Up to 10 minutes of a clip decoded weigh about 100 MB: a sound no player cues any more is dropped. */
  private keep(cued: Set<string>): void {
    this.cued = cued;
    SoundPlayer.cueing.add(this);
    const sharing = [...SoundPlayer.cueing].filter((player) => player.clipAudio === this.clipAudio);
    for (const id of this.clipAudio.keys()) if (!sharing.some((player) => player.cued.has(id))) this.clipAudio.delete(id);
  }

  private loadClipCue({ id, file }: PlannedClip): void {
    if (this.clipAudio.has(id)) return;
    this.clipAudio.set(id, 'loading');
    // A clip dropped by setClips while it decodes stays dropped.
    const settle = (audio: AudioBuffer | 'failed') =>
      void (this.clipAudio.get(id) === 'loading' && this.clipAudio.set(id, audio));
    this.loadClip(`/api/projects/${this.projectId}/clips/audio?path=${encodeURIComponent(file)}`).then(settle, () =>
      settle('failed'),
    );
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
