// Adapted from saeedvaziry/caleb-video-editor (MIT)
// Project soundtracks: upload and selection, settings, cached analysis, grid with overrides, cut snapping and the
// music context the agent reads.
import { createWriteStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import type {
  MusicAnalysis,
  MusicGridData,
  MusicSettings,
  ProjectFile,
  ProjectState,
  SceneState,
  SnapGrid,
} from '../../src/shared/types';
import type { CadenceConfig, Hub, MusicService, ProjectStore, Upload } from '../contracts';
import { language, m } from '../i18n';
import {
  HttpError,
  randomToken,
  readJson,
  readJsonOr,
  resolveInside,
  roundMs,
  slugify,
  uniqueId,
  writeJsonAtomic,
} from '../util';
import { applyOverrides, BEATS_PER_BAR_CHOICES, BPM_MAX, BPM_MIN, MAX_GRID_OFFSET } from './grid';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
const MAX_BYTES = 200 * 1024 * 1024;
/** Shortest scene snapCuts leaves. */
const MIN_SCENE = 0.4;

/** Content of `<track>.analysis.json`: the analysis and the size/mtime of the file it describes. */
interface CacheEntry {
  size: number;
  mtimeMs: number;
  analysis: MusicAnalysis;
}

/** A settings patch; null resets an override (JSON cannot carry undefined). */
type SettingsPatch = { [K in keyof Omit<MusicSettings, 'file'>]?: MusicSettings[K] | null };

export class LocalMusicService implements MusicService {
  /** Analyses in progress, by absolute track path: concurrent callers share one. */
  private running = new Map<string, Promise<MusicAnalysis>>();
  // Never evicted: one entry (about 50 KB) per analysed track.
  private memory = new Map<string, CacheEntry>();
  /** Failed analyses by track path, with the file stamp they failed on: grid() runs on every project read and must not retry in a loop. */
  private failed = new Map<string, { stamp: string; error: string }>();

  constructor(private deps: { config: CadenceConfig; store: ProjectStore; hub: Hub }) {}

  async upload(projectId: string, file: Upload): Promise<ProjectState> {
    const { store } = this.deps;
    const t = m().media.music;
    if (!(await store.exists(projectId))) throw new HttpError(404, t.projectNotFound(projectId));
    const ext = path.extname(file.name).slice(1).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) throw new HttpError(400, t.unsupported(ext));

    const dir = this.musicDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const base = slugify(path.basename(file.name, path.extname(file.name)), 'piste');
    // Streamed to disk outside the lock (never whole in memory), then named and moved in under it, so two uploads never
    // collide.
    const tmp = path.join(dir, `.upload-${randomToken(6)}.tmp`);
    try {
      await pipeline(file.body, createWriteStream(tmp));
      const { size } = await fs.stat(tmp);
      if (size === 0) throw new HttpError(400, t.empty);
      if (size > MAX_BYTES) throw new HttpError(413, t.tooLarge);
      const name = await store.withLock(projectId, async () => {
        const names = await fs.readdir(dir);
        const wanted = `${base}.${ext}`;
        // The same bytes under the same name are a re-upload: reuse the file. Other bytes never replace a track.
        // Lowercased: macOS volumes are case-insensitive, so a hand-copied "Theme.MP3" is the file "theme.mp3".
        const existing = names.find((n) => n.toLowerCase() === wanted);
        if (existing && (await sameBytes(path.join(dir, existing), tmp))) return existing;
        const taken = names
          .map((n) => n.toLowerCase())
          .filter((n) => n.endsWith(`.${ext}`))
          .map((n) => n.slice(0, -ext.length - 1));
        const name = `${uniqueId(base, taken)}.${ext}`;
        await fs.rename(tmp, path.join(dir, name));
        return name;
      });
      return await this.choose(projectId, path.join(dir, name));
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async tracks(projectId: string): Promise<{ file: string; size: number; analysed: boolean }[]> {
    await this.settings(projectId);
    const dir = this.musicDir(projectId);
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(isAudio).sort();
    const out: { file: string; size: number; analysed: boolean }[] = [];
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      out.push({ file: `music/${name}`, size: stat.size, analysed: Boolean(await this.cached(path.join(dir, name), stat)) });
    }
    return out;
  }

  async select(projectId: string, file: string): Promise<ProjectState> {
    const abs = this.trackPath(projectId, file);
    if (!(await fs.stat(abs).catch(() => null))?.isFile()) throw new HttpError(404, m().media.music.trackNotFound(file));
    return this.choose(projectId, abs);
  }

  async update(projectId: string, patch: SettingsPatch): Promise<ProjectState> {
    const { store } = this.deps;
    return store.withLock(projectId, async () => {
      const current = await this.settings(projectId);
      if (!current) throw new HttpError(400, m().media.music.noMusic);
      const detected = await this.peek(projectId, current.file);
      return store.setMusic(projectId, mergeSettings(current, patch, detected?.beatsPerBar ?? 4));
    });
  }

  async remove(projectId: string): Promise<ProjectState> {
    // Tracks and their analyses stay in music/: selecting one again is instant.
    return this.deps.store.setMusic(projectId, null);
  }

  async analysis(projectId: string): Promise<MusicAnalysis | null> {
    const music = await this.settings(projectId);
    if (!music) return null;
    const file = this.trackPath(projectId, music.file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new HttpError(404, m().media.music.trackNotFound(music.file));
    const failure = this.failed.get(file);
    if (failure?.stamp === stampOf(stat)) throw new HttpError(422, failure.error);
    return this.analyse(projectId, file);
  }

  async grid(projectId: string): Promise<MusicGridData | null> {
    const music = await this.settings(projectId);
    if (!music) return null;
    const file = this.trackPathOrNull(projectId, music.file);
    const stat = file ? await fs.stat(file).catch(() => null) : null;
    if (!file || !stat) return null;
    const analysis = await this.cached(file, stat);
    if (analysis) return applyOverrides(analysis, music);
    // New track, stale cache or a restart mid-analysis: analyse in the background (the editor hears about it on the
    // hub) and report no grid meanwhile. A file that already failed as it is now is not retried.
    if (this.failed.get(file)?.stamp !== stampOf(stat)) void this.analyse(projectId, file).catch(() => undefined);
    return null;
  }

  async snapCuts(projectId: string, grid: SnapGrid, opts: { keepBars?: boolean } = {}): Promise<ProjectState> {
    const { store } = this.deps;
    // Wait for the analysis outside the lock: it can take a few seconds on a long track.
    if (!(await this.analysis(projectId))) throw new HttpError(400, m().media.music.addMusicFirst);
    return store.withLock(projectId, async () => {
      const { music, musicGrid: data, scenes, tempo } = await store.get(projectId);
      if (!music || !data) throw new HttpError(409, m().media.music.changed);
      // Grid points are track seconds, cuts are video seconds.
      const video = (points: number[]) => points.map((t) => t - music.start);
      if (opts.keepBars) {
        const bar = (data.beatsPerBar * 60) / data.bpm;
        await store.setDurations(projectId, barDurations(scenes, video(data.downbeats), bar, tempo));
        // Scene lengths are now bars of the track: count them at its tempo from now on (a second snap keeps them,
        // inserted templates get its bar length). 240 / tempo is one bar, whatever the track's beats per bar.
        return store.update(projectId, { tempo: Math.min(300, Math.max(30, 240 / bar)) });
      }
      const points = grid === 'beat' ? data.beats : grid === 'bar' || data.phrases.length < 2 ? data.downbeats : data.phrases;
      return store.setDurations(projectId, snapDurations(scenes, video(points)));
    });
  }

  async context(projectId: string, sceneId?: string | null): Promise<string> {
    const project = await this.deps.store.get(projectId);
    const scene = sceneId ? project.scenes.find((s) => s.id === sceneId) : null;
    if (sceneId && !scene) throw new HttpError(404, m().media.sceneNotFound(sceneId));
    const music = project.music;
    if (!music) {
      return `No music track. The beat grid is a steady ${project.tempo} BPM in 4/4 (project tempo): 1 beat = ${sec(60 / project.tempo)} s, 1 bar = ${sec(240 / project.tempo)} s, counted from each scene's start.`;
    }
    let grid: MusicGridData;
    try {
      const analysis = await this.analysis(projectId);
      if (!analysis) throw new Error('no analysis');
      grid = applyOverrides(analysis, music);
    } catch (e) {
      return `Music track ${music.file} (starts ${sec(music.start)} s into the track at video t = 0) has no beat grid: ${(e as Error).message}. Until it does, the grid is a steady ${project.tempo} BPM in 4/4.`;
    }
    return describeMusic(project, music, grid, scene ?? null);
  }

  async audioPath(projectId: string): Promise<string | null> {
    const music = await this.settings(projectId);
    const file = music ? this.trackPathOrNull(projectId, music.file) : null;
    return file && (await fs.stat(file).catch(() => null))?.isFile() ? file : null;
  }

  private musicDir(projectId: string): string {
    return path.join(this.deps.store.dir(projectId), 'music');
  }

  /** Absolute path of a track given as `music/<name>` (or `<name>`), which must sit directly in the project's music/. */
  private trackPath(projectId: string, file: string): string {
    const dir = this.musicDir(projectId);
    const abs = resolveInside(dir, String(file).replace(/^music\//, ''));
    if (path.dirname(abs) !== dir || !isAudio(abs)) throw new HttpError(400, m().media.music.invalidTrack(file));
    return abs;
  }

  private trackPathOrNull(projectId: string, file: string): string | null {
    try {
      return this.trackPath(projectId, file);
    } catch {
      return null;
    }
  }

  /**
   * The project's music settings, read straight from project.json: grid() runs inside every store.get(), so it
   * must not call get() itself. Writes always go through the store.
   */
  private async settings(projectId: string): Promise<MusicSettings | null> {
    const file = path.join(this.deps.store.dir(projectId), 'project.json');
    const data = await readJson<Partial<ProjectFile>>(file).catch(() => {
      throw new HttpError(404, m().media.music.projectNotFound(projectId));
    });
    return data.music ?? null;
  }

  /** Select a track (start 0, volume 1, no overrides) unless it is already the selected one, then analyse it. */
  private async choose(projectId: string, abs: string): Promise<ProjectState> {
    const { store } = this.deps;
    const rel = `music/${path.basename(abs)}`;
    this.failed.delete(abs);
    const state = await store.withLock(projectId, async () =>
      (await this.settings(projectId))?.file === rel ? null : store.setMusic(projectId, { file: rel, start: 0, volume: 1 }),
    );
    void this.analyse(projectId, abs).catch(() => undefined);
    return state ?? store.get(projectId);
  }

  /** Fresh cached analysis of the selected-or-given track, without starting one. */
  private async peek(projectId: string, file: string): Promise<MusicAnalysis | null> {
    const abs = this.trackPathOrNull(projectId, file);
    const stat = abs ? await fs.stat(abs).catch(() => null) : null;
    return abs && stat ? this.cached(abs, stat) : null;
  }

  /** Memory, then `<file>.analysis.json`, when they describe the file as it is now (size + mtime). */
  private async cached(file: string, stat: Stats): Promise<MusicAnalysis | null> {
    const fresh = (entry: CacheEntry | null | undefined): entry is CacheEntry =>
      Boolean(entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.analysis?.version === 2);
    const memory = this.memory.get(file);
    if (fresh(memory)) return memory.analysis;
    // A damaged cache is a miss: the analysis runs again and rewrites it.
    const disk = await readJsonOr<CacheEntry | null>(`${file}.analysis.json`, null).catch(() => null);
    if (!fresh(disk)) return null;
    this.memory.set(file, disk);
    return disk.analysis;
  }

  /** Cached analysis, or one shared run that reports on the hub and writes the cache. */
  private async analyse(projectId: string, file: string): Promise<MusicAnalysis> {
    const stat = await fs.stat(file);
    const hit = await this.cached(file, stat);
    if (hit) return hit;
    let job = this.running.get(file);
    if (!job) {
      job = this.run(projectId, file, stat).finally(() => this.running.delete(file));
      this.running.set(file, job);
    }
    return job;
  }

  private async run(projectId: string, file: string, stat: Stats): Promise<MusicAnalysis> {
    const { hub, config } = this.deps;
    hub.send({ type: 'music', projectId, status: 'analyzing' });
    let analysis: MusicAnalysis;
    try {
      analysis = await analyzeInWorker(file, config.ffmpegPath);
    } catch (e) {
      const error = m().media.music.analysisFailed(path.basename(file), (e as Error).message);
      this.failed.set(file, { stamp: stampOf(stat), error });
      hub.send({ type: 'music', projectId, status: 'error', error });
      throw new HttpError(422, error);
    }
    const entry: CacheEntry = { size: stat.size, mtimeMs: stat.mtimeMs, analysis };
    this.memory.set(file, entry);
    await writeJsonAtomic(`${file}.analysis.json`, entry).catch((e: Error) =>
      console.warn(m().media.music.cacheNotWritten(path.basename(file), e.message)),
    );
    hub.send({ type: 'music', projectId, status: 'ready' });
    return analysis;
  }
}

/** The analysis off the server's thread (worker.mjs): the server keeps answering while it runs. */
function analyzeInWorker(file: string, ffmpegPath: string): Promise<MusicAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { file, ffmpegPath, language: language() },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

function isAudio(file: string): boolean {
  return AUDIO_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());
}

function stampOf(stat: Stats): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

/** The same bytes, compared 1 MB at a time: a soundtrack can weigh 200 MB. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [sizeA, sizeB] = await Promise.all([fs.stat(a).then((s) => s.size), fs.stat(b).then((s) => s.size)]);
  if (sizeA !== sizeB) return false;
  const [fileA, fileB] = await Promise.all([fs.open(a), fs.open(b)]);
  try {
    const [chunkA, chunkB] = [Buffer.alloc(1 << 20), Buffer.alloc(1 << 20)];
    for (let at = 0; at < sizeA; at += chunkA.length) {
      const [{ bytesRead }] = await Promise.all([
        fileA.read(chunkA, 0, chunkA.length, at),
        fileB.read(chunkB, 0, chunkB.length, at),
      ]);
      if (!chunkA.subarray(0, bytesRead).equals(chunkB.subarray(0, bytesRead))) return false;
    }
    return true;
  } finally {
    await Promise.all([fileA.close(), fileB.close()]);
  }
}

/** Validated settings after `patch` (null resets an override). The editor shows the errors as they are. */
function mergeSettings(current: MusicSettings, patch: SettingsPatch, detectedBeatsPerBar: number): MusicSettings {
  const t = m().media.music;
  const next: MusicSettings = { ...current };
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (patch.start !== undefined) {
    if (!num(patch.start) || patch.start < 0) {
      throw new HttpError(400, t.start);
    }
    next.start = roundMs(patch.start);
  }
  if (patch.volume !== undefined) {
    if (!num(patch.volume) || patch.volume < 0 || patch.volume > 1) {
      throw new HttpError(400, t.volume);
    }
    next.volume = patch.volume;
  }
  if (patch.bpm !== undefined) {
    if (patch.bpm !== null && (!num(patch.bpm) || patch.bpm < BPM_MIN || patch.bpm > BPM_MAX)) {
      throw new HttpError(400, t.tempo(BPM_MIN, BPM_MAX));
    }
    next.bpm = patch.bpm;
  }
  if (patch.beatsPerBar !== undefined) {
    if (patch.beatsPerBar === null) delete next.beatsPerBar;
    else if (!BEATS_PER_BAR_CHOICES.includes(patch.beatsPerBar)) throw new HttpError(400, t.beatsPerBar);
    else next.beatsPerBar = patch.beatsPerBar;
  }
  const beatsPerBar = next.beatsPerBar ?? detectedBeatsPerBar;
  if (patch.barOffset !== undefined) {
    if (patch.barOffset === null) delete next.barOffset;
    else if (!Number.isInteger(patch.barOffset) || patch.barOffset < 0 || patch.barOffset >= beatsPerBar) {
      throw new HttpError(400, t.barOffset(beatsPerBar - 1));
    } else next.barOffset = patch.barOffset;
  } else if (next.barOffset !== undefined && next.barOffset >= beatsPerBar) {
    // The bar got shorter: keep the offset inside it.
    next.barOffset %= beatsPerBar;
  }
  if (patch.gridOffset !== undefined) {
    if (patch.gridOffset === null) delete next.gridOffset;
    else if (!num(patch.gridOffset) || Math.abs(patch.gridOffset) > MAX_GRID_OFFSET) {
      throw new HttpError(400, t.gridOffset);
    } else next.gridOffset = roundMs(patch.gridOffset);
  }
  return next;
}

/**
 * New durations so every cut (each scene's end, the video's end included) moves to the nearest grid point (video
 * seconds) at least MIN_SCENE after the previous cut. Cuts outside the music's grid keep their place.
 */
function snapDurations(scenes: Pick<SceneState, 'id' | 'duration'>[], points: number[]): Record<string, number> {
  // Points before video t = 0 still tell where the grid covers; `min` keeps cuts after them.
  const grid = [...points].sort((a, b) => a - b);
  const gaps = grid.slice(1).map((t, i) => t - grid[i]);
  const halfStep = gaps.length ? gaps.sort((a, b) => a - b)[gaps.length >> 1] / 2 : 0;
  const durations: Record<string, number> = {};
  let prev = 0;
  let end = 0;
  for (const scene of scenes) {
    end += scene.duration;
    const min = prev + MIN_SCENE;
    const covered = grid.length > 0 && end >= grid[0] - halfStep && end <= grid[grid.length - 1] + halfStep;
    let cut = Math.max(end, min);
    if (covered) {
      let best: number | null = null;
      for (const t of grid) if (t >= min - 1e-9 && (best === null || Math.abs(t - end) < Math.abs(best - end))) best = t;
      if (best !== null) cut = best;
    }
    const at = roundMs(cut);
    durations[scene.id] = roundMs(at - prev);
    prev = at;
  }
  return durations;
}

/**
 * New durations that keep every scene's length in bars at `tempo` (at least one bar) and put each cut on a bar line of
 * the track (video seconds), counting from the first one at or after video 0: the lead-in before it joins the first
 * scene. Past the last detected bar line, bars go on every `bar` seconds.
 */
function barDurations(
  scenes: Pick<SceneState, 'id' | 'duration'>[],
  downbeats: number[],
  bar: number,
  tempo: number,
): Record<string, number> {
  const lines = downbeats.length ? downbeats : [0];
  const last = lines.length - 1;
  const line = (k: number) => (k <= last ? lines[k] : lines[last] + (k - last) * bar);
  let k = lines.findIndex((t) => t >= -0.001);
  if (k === -1) k = last + Math.ceil((-0.001 - lines[last]) / bar); // the video starts after the last detected bar line
  // Already counted in this grid's bars (tempo set by an earlier snap): a first scene that ends on a bar line also
  // holds the lead-in, which is not a bar. Its bars are the ones it spans, so snapping again changes nothing.
  const resnap = Math.abs(tempo - 240 / bar) < 0.01;
  const durations: Record<string, number> = {};
  let prev = 0;
  for (const [i, scene] of scenes.entries()) {
    let bars = Math.round((scene.duration * tempo) / 240);
    if (i === 0 && resnap) {
      const spanned = Math.round((scene.duration - line(k)) / bar);
      if (Math.abs(line(k + spanned) - scene.duration) < 0.002) bars = spanned;
    }
    k += Math.max(1, bars);
    const at = roundMs(line(k));
    durations[scene.id] = roundMs(at - prev);
    prev = at;
  }
  return durations;
}

// Agent context

const sec = (t: number) => t.toFixed(3);

function describeMusic(project: ProjectState, music: MusicSettings, grid: MusicGridData, scene: SceneState | null): string {
  const beat = 60 / grid.bpm;
  const bar = beat * grid.beatsPerBar;
  const video = (t: number) => t - music.start;
  const overrides = [
    music.bpm ? `tempo forced to ${music.bpm} BPM` : '',
    music.beatsPerBar ? `${music.beatsPerBar} beats per bar forced` : '',
    music.barOffset ? `bar ones moved ${music.barOffset} beat${music.barOffset > 1 ? 's' : ''} later` : '',
    music.gridOffset ? `grid nudged ${music.gridOffset > 0 ? '+' : ''}${sec(music.gridOffset)} s` : '',
  ].filter(Boolean);
  const trust =
    grid.confidence >= 0.75
      ? 'steady, trust it'
      : grid.confidence >= 0.4
        ? 'partly steady, check key moments by ear'
        : 'weak, ask the user to check the tempo';
  const lines = [
    `Track ${music.file}: ${sec(grid.duration)} s; video t = 0 is ${sec(music.start)} s into the track (the video ends at ${sec(music.start + project.duration)} s of it).`,
    `Tempo ${grid.bpm.toFixed(2)} BPM, ${grid.beatsPerBar} beats per bar: 1 beat = ${sec(beat)} s, 1 bar = ${sec(bar)} s. Grid confidence ${grid.confidence.toFixed(2)} (${trust}).${overrides.length ? ` Overrides: ${overrides.join(', ')}.` : ''}`,
  ];
  const barNumber = new Map(grid.downbeats.map((t, i) => [t, i + 1]));
  const sectionText = (s: MusicGridData['sections'][number], shift: number) =>
    `${s.label} ${sec(video(s.start) - shift)}–${sec(video(s.end) - shift)} (energy ${s.energy.toFixed(2)})`;

  if (!scene) {
    const shown = (t: number) => video(t) >= -0.001 && video(t) <= project.duration + 0.001;
    lines.push('Times below are video seconds; bars are numbered from the start of the track.');
    const bars = grid.downbeats.flatMap((t, i) => (shown(t) ? [`${sec(video(t))} [${i + 1}]`] : []));
    lines.push(bars.length ? `Bar lines: ${list(bars, 48)}` : 'No bar line falls inside the video.');
    const phrases = grid.phrases
      .filter(shown)
      .map((t) => `${sec(video(t))}${barNumber.has(t) ? ` [bar ${barNumber.get(t)}]` : ''}`);
    if (phrases.length) lines.push(`Phrase starts: ${phrases.join(', ')}`);
    const sections = grid.sections.filter((s) => video(s.end) > 0 && video(s.start) < project.duration);
    lines.push(`Sections: ${sections.map((s) => sectionText(s, 0)).join(' · ')}`);
    const cuts = project.scenes
      .slice(1)
      .map((s, i) => `${project.scenes[i].id} → ${s.id} at ${sec(s.start)} s: ${relative(s.start, grid, music.start)}`);
    lines.push(cuts.length ? `Cuts: ${cuts.join(' · ')}` : 'Cuts: none (one scene).');
    lines.push(`Video end ${sec(project.duration)} s: ${relative(project.duration, grid, music.start)}.`);
    return lines.join('\n');
  }

  const from = scene.start;
  const to = scene.start + scene.duration;
  const local = (t: number) => video(t) - from;
  const inside = (t: number) => video(t) >= from - 0.001 && video(t) <= to + 0.001;
  lines.push(
    `Scene ${scene.index + 1} "${scene.name}" (${scene.id}) plays video ${sec(from)}–${sec(to)} s (${(scene.duration / bar).toFixed(2)} bars). Times below are scene-local seconds (0 = its first frame).`,
    `It starts ${relative(from, grid, music.start)} and ends ${relative(to, grid, music.start)}.`,
  );
  const bars = grid.downbeats.flatMap((t, i) => (inside(t) ? [`${sec(local(t))} [bar ${i + 1}]`] : []));
  lines.push(bars.length ? `Bar lines: ${bars.join(', ')}` : 'No bar line falls inside this scene.');
  const beats = grid.beats.filter(inside).map((t) => sec(local(t)));
  if (beats.length) lines.push(`Beats: ${list(beats, 64)}`);
  const phrases = grid.phrases
    .filter(inside)
    .map((t) => `${sec(local(t))}${barNumber.has(t) ? ` [bar ${barNumber.get(t)}]` : ''}`);
  if (phrases.length) lines.push(`Phrase starts: ${phrases.join(', ')}`);
  const sections = grid.sections.filter((s) => video(s.end) > from && video(s.start) < to);
  if (sections.length) lines.push(`Sections: ${sections.map((s) => sectionText(s, from)).join(' · ')}`);
  const accents = grid.accents
    .filter((a) => inside(a.t) && a.strength >= 0.4)
    .map((a) => `${sec(local(a.t))} (${a.strength.toFixed(2)})`);
  if (accents.length) lines.push(`Strong hits: ${accents.join(', ')}`);
  const endings = grid.downbeats.map(local).filter((t) => t >= MIN_SCENE);
  if (endings.length) lines.push(`Durations that end this scene on a bar line: ${endings.slice(0, 8).map(sec).join(', ')} s`);
  return lines.join('\n');
}

/** Where video time `t` falls relative to the nearest bar line: "on bar 5", "0.120 s (0.29 beat) after bar 4". */
function relative(t: number, grid: MusicGridData, start: number): string {
  if (grid.downbeats.length === 0) return 'with no bar line nearby';
  const at = t + start;
  let k = 0;
  for (let i = 1; i < grid.downbeats.length; i++) if (Math.abs(grid.downbeats[i] - at) < Math.abs(grid.downbeats[k] - at)) k = i;
  const offset = at - grid.downbeats[k];
  if (Math.abs(offset) < 0.0105) return `on bar ${k + 1}`;
  const beats = Math.abs(offset) / (60 / grid.bpm);
  return `${sec(Math.abs(offset))} s (${beats.toFixed(2)} beat) ${offset > 0 ? 'after' : 'before'} bar ${k + 1}`;
}

function list(items: string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(', ')}, … (${items.length} in all)` : items.join(', ');
}
