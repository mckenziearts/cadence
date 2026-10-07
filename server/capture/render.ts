// MP4 export: headless frame pages capture frames in parallel, ffmpeg encodes them in order (H.264 + soundtrack).
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { MAX_SOUND_CUES, MAX_VIDEO_SOUND_CUES, parseSoundCues } from '../../src/shared/sounds';
import {
  FORMATS,
  isFormatId,
  type FormatId,
  type ProjectState,
  type RenderFile,
  type RenderJob,
  type RenderQuality,
  type RenderRequest,
} from '../../src/shared/types';
import { DUCK_RAMP_S, voiceSpans } from '../../src/shared/voiceOver';
import type { CadenceConfig, Hub, MusicService, ProjectStore, RenderService, VoiceOverService } from '../contracts';
import { m } from '../i18n';
import { soundTrack } from '../sounds/track';
import { assertId, formatSeconds, HttpError, nowIso, pathExists, resolveInside } from '../util';
import { launchChromium, openFramePage, RENDER_TIMEOUT_MS, seekFrame, withTimeout, type FramePage } from './capture';

const PRESETS: Record<RenderQuality, { crf: number; preset: string; jpeg: number }> = {
  draft: { crf: 23, preset: 'veryfast', jpeg: 80 },
  standard: { crf: 16, preset: 'medium', jpeg: 95 },
  master: { crf: 10, preset: 'slow', jpeg: 100 },
};

/** Frames a page captures in a row (consecutive frames re-render cheaply); pages never run far ahead of ffmpeg. */
const BLOCK = 8;
const FADE_OUT_S = 0.6;
const PROGRESS_INTERVAL_MS = 100;
/** Characters of a thrown `sounds()` message a failed render shows. */
const ERROR_CHARS = 200;
/**
 * What a render writes in .cadence/sounds: `<job id>.wav` (randomUUID) and the temporary file of writeFileAtomic. The
 * sweep leaves anything else alone: the folder may hold what a copied project brought, or link elsewhere.
 */
const TRACK_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav(\.\d+\.[0-9a-f]{8}\.tmp)?$/;

class RenderCancelled extends Error {}

interface JobState {
  job: RenderJob;
  abort: AbortController;
  done: Promise<RenderJob>;
  settle: (job: RenderJob) => void;
  lastEmit: number;
}

export class FfmpegRenderService implements RenderService {
  private states = new Map<string, JobState>();
  private queue: JobState[] = [];
  private running = false;

  constructor(
    private readonly deps: {
      config: CadenceConfig;
      store: ProjectStore;
      music: MusicService;
      voiceOver: VoiceOverService;
      hub: Hub;
    },
  ) {}

  async start(projectId: string, req: RenderRequest): Promise<RenderJob[]> {
    const project = await this.deps.store.get(projectId);
    const request = normalizeRequest(project, req);
    const jobs = request.formats.map((format) => this.enqueue(project, format, request));
    void this.pump();
    return jobs;
  }

  cancel(jobId: string): void {
    const state = this.states.get(jobId);
    if (!state) throw new HttpError(404, m().media.render.notFound);
    const { status } = state.job;
    if (status === 'done' || status === 'error' || status === 'cancelled') return;
    state.abort.abort(new RenderCancelled(m().media.render.cancelled));
    // A running job ends once its pages and ffmpeg are gone (see run); a queued one never starts.
    if (status === 'queued') this.end(state, { status: 'cancelled' });
  }

  jobs(projectId?: string): RenderJob[] {
    return [...this.states.values()]
      .map((state) => ({ ...state.job }))
      .filter((job) => !projectId || job.projectId === projectId)
      .reverse();
  }

  async files(projectId: string): Promise<RenderFile[]> {
    const dir = this.rendersDir(projectId);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const sounds = this.soundsDir(projectId);
    const tracks = await fs.readdir(sounds).catch(() => [] as string[]);
    await Promise.all([
      ...entries.filter((name) => name.endsWith('.part')).map((name) => dropStale(path.join(dir, name))),
      ...tracks.filter((name) => TRACK_FILE.test(name)).map((name) => dropStale(path.join(sounds, name))),
    ]);
    const names = entries.filter((name) => name.endsWith('.mp4'));
    const files = await Promise.all(
      names.map(async (name) => {
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (!stat) return null;
        const file: RenderFile = {
          name,
          url: renderUrl(projectId, name),
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          format: formatFromName(name),
        };
        return file;
      }),
    );
    return files.filter((file) => file !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolveFile(projectId: string, name: string): string {
    if (!/^[\w][\w.-]*\.mp4$/.test(name)) throw new HttpError(400, m().media.render.invalidFileName(name));
    return resolveInside(this.rendersDir(projectId), name);
  }

  /** Kept in .cadence/trash rather than deleted, like a project or an asset: getting it back beats rendering it again. */
  async remove(projectId: string, name: string): Promise<void> {
    const file = this.resolveFile(projectId, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, m().api.fileNotFound(name));
    const trash = path.join(this.deps.store.dir(projectId), '.cadence', 'trash');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(file, path.join(trash, `${Date.now()}-${name}`));
  }

  wait(jobId: string): Promise<RenderJob> {
    const state = this.states.get(jobId);
    return state ? state.done : Promise.reject(new HttpError(404, m().media.render.notFound));
  }

  private rendersDir(projectId: string): string {
    return path.join(this.deps.store.dir(assertId(projectId, m().api.ids.project)), 'renders');
  }

  /** The sounds track of each running render, removed once it ends. */
  private soundsDir(projectId: string): string {
    return path.join(this.deps.store.dir(assertId(projectId, m().api.ids.project)), '.cadence', 'sounds');
  }

  private enqueue(project: ProjectState, format: FormatId, request: RenderRequest): RenderJob {
    const { width, height } = FORMATS[format];
    const scale = request.scale ?? 1;
    const fps = request.fps ?? project.fps;
    const span = (request.range ? Math.min(request.range.to, project.duration) - request.range.from : project.duration) || 0;
    let settle!: (job: RenderJob) => void;
    const done = new Promise<RenderJob>((resolve) => (settle = resolve));
    const job: RenderJob = {
      id: randomUUID(),
      projectId: project.id,
      format,
      status: 'queued',
      progress: 0,
      framesDone: 0,
      framesTotal: Math.max(0, Math.round(span * fps)),
      width: even(width * scale),
      height: even(height * scale),
      fps,
      request,
      createdAt: nowIso(),
    };
    const state: JobState = { job, abort: new AbortController(), done, settle, lastEmit: 0 };
    this.states.set(job.id, state);
    this.queue.push(state);
    this.emit(state, true);
    return { ...job };
  }

  /** Jobs run one at a time, in order. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (let state = this.queue.shift(); state; state = this.queue.shift()) {
      if (state.abort.signal.aborted) continue;
      try {
        await this.run(state);
      } catch (e) {
        if (e instanceof RenderCancelled) this.end(state, { status: 'cancelled' });
        else this.end(state, { status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.running = false;
  }

  private emit(state: JobState, force = false): void {
    const now = Date.now();
    if (!force && now - state.lastEmit < PROGRESS_INTERVAL_MS) return;
    state.lastEmit = now;
    this.deps.hub.send({ type: 'render', job: { ...state.job } });
  }

  private end(state: JobState, patch: Partial<RenderJob>): void {
    Object.assign(state.job, patch, { finishedAt: nowIso() });
    this.emit(state, true);
    state.settle({ ...state.job });
  }

  private async run(state: JobState): Promise<void> {
    const { job, abort } = state;
    const { config, store, music, voiceOver } = this.deps;
    const request = job.request;
    job.status = 'rendering';
    this.emit(state, true);
    await store.syncCode(job.projectId);
    // Sentences Piper has not spoken yet are spoken now, before the pages load the project: their times are props of
    // the scenes. If Piper cannot, the editor already says why and the MP4 goes out with what is generated.
    await voiceOver.sync(job.projectId).catch(() => undefined);
    let project = await store.get(job.projectId);
    let { from, total } = frameRange(project, request, job.fps);
    const preset = PRESETS[request.quality];

    const dir = this.rendersDir(job.projectId);
    await fs.mkdir(dir, { recursive: true });
    const name = await freeName(dir, `${project.id}-${job.format.replace(':', 'x')}-${stamp(new Date())}`);
    const partial = path.join(dir, `${name}.part`);
    abort.signal.throwIfAborted();

    const browser = await launchChromium();
    let kill = () => {};
    let sounds: string | null = null;
    try {
      const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2), Math.ceil(total / BLOCK)));
      const pixelRatio = (request.scale ?? 1) * (request.supersample ? 2 : 1);
      const pages = await Promise.all(
        Array.from({ length: workers }, () =>
          openFramePage(browser, config.frameOrigin, {
            projectId: job.projectId,
            sceneId: null,
            format: job.format,
            scale: pixelRatio,
          }),
        ),
      );
      abort.signal.throwIfAborted();
      project = await shownState(pages, project, store);
      ({ from, total } = frameRange(project, request, job.fps));
      const duration = total / job.fps;
      const audioFile = project.music ? await music.audioPath(job.projectId) : null;
      const audio =
        audioFile && project.music ? { file: audioFile, start: project.music.start + from, volume: project.music.volume } : null;
      const track = await voiceOver.track(job.projectId);
      // A range without any sentence gets no voice input: seeking past the track's end gives no audio stream at all in
      // ffmpeg 8.1, which other versions may not do.
      const voice =
        track && track.lines.some((l) => l.end > from && l.start < from + duration)
          ? { file: track.file, start: from, intervals: voiceSpans(track.lines, from), musicLevel: track.musicLevel }
          : null;
      sounds = await soundTrack({
        cues: await soundCues(pages[0].page, project),
        from,
        duration,
        library: path.join(config.root, 'src', 'editor', 'sounds'),
        // The job id: never the same file as another render's, even one of another Cadence on the same folder.
        file: path.join(this.soundsDir(job.projectId), `${job.id}.wav`),
      });
      job.framesTotal = total;
      this.emit(state, true);
      abort.signal.throwIfAborted();

      const ffmpeg = spawn(
        config.ffmpegPath,
        ffmpegArgs({
          fps: job.fps,
          width: job.width,
          height: job.height,
          supersample: Boolean(request.supersample),
          crf: preset.crf,
          preset: preset.preset,
          audio,
          voice,
          sounds,
          duration,
          output: partial,
        }),
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      kill = () => ffmpeg.kill('SIGKILL');
      abort.signal.addEventListener('abort', kill, { once: true });
      let stderr = '';
      ffmpeg.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
      ffmpeg.stdin.on('error', () => undefined); // EPIPE when ffmpeg dies: its exit code tells what happened
      let written = 0;
      const exited = new Promise<number>((resolve, reject) => {
        ffmpeg.on('error', (e) => reject(new Error(m().media.ffmpegStart(config.ffmpegPath, e.message))));
        ffmpeg.on('close', (code) => resolve(code ?? 1));
      });
      exited.then(
        (code) => {
          if (written < total) abort.abort(new Error(m().media.render.ffmpegStopped(code, lastLine(stderr))));
        },
        (e: unknown) => abort.abort(e),
      );

      // Pages take blocks of consecutive frames; the writer feeds ffmpeg strictly in order.
      const images: (Deferred<Buffer> | null)[] = Array.from({ length: total }, () => deferred<Buffer>());
      let cursor = 0;
      const aheadLimit = workers * BLOCK * 2;
      let wakeCapture = deferred<void>();
      abort.signal.addEventListener('abort', () => wakeCapture.resolve(), { once: true });

      const capture = async (page: Page) => {
        for (;;) {
          while (cursor >= written + aheadLimit && !abort.signal.aborted) await wakeCapture.promise;
          abort.signal.throwIfAborted();
          if (cursor >= total) return;
          const start = cursor;
          const end = Math.min(total, start + BLOCK);
          cursor = end;
          for (let i = start; i < end; i++) {
            abort.signal.throwIfAborted();
            const t = from + i / job.fps;
            const result = await seekFrame(page, t);
            if (result.errors.length > 0) throw new Error(m().media.render.videoError(formatSeconds(t), result.errors[0]));
            images[i]!.resolve(await page.screenshot({ type: 'jpeg', quality: preset.jpeg, timeout: RENDER_TIMEOUT_MS }));
          }
        }
      };

      const aborted = rejectOnAbort(abort.signal);
      const write = async () => {
        for (let i = 0; i < total; i++) {
          const image = await Promise.race([images[i]!.promise, aborted]);
          images[i] = null;
          if (!ffmpeg.stdin.write(image)) await once(ffmpeg.stdin, 'drain', { signal: abort.signal });
          written = i + 1;
          wakeCapture.resolve();
          wakeCapture = deferred<void>();
          Object.assign(job, { framesDone: written, progress: written / total });
          this.emit(state);
        }
        ffmpeg.stdin.end();
      };

      await Promise.all([write(), ...pages.map(({ page }) => capture(page).catch((e: unknown) => abort.abort(e)))]);
      Object.assign(job, { status: 'encoding' });
      this.emit(state, true);
      const code = await exited;
      abort.signal.throwIfAborted();
      if (code !== 0) throw new Error(m().media.render.ffmpegFailed(code, lastLine(stderr)));
      const output = path.join(dir, name);
      await fs.rename(partial, output);
      this.end(state, { status: 'done', progress: 1, framesDone: total, file: name, url: renderUrl(job.projectId, name) });
    } catch (e) {
      // A capture error aborts the others with the same reason: report the first one.
      throw abort.signal.aborted ? abort.signal.reason : e;
    } finally {
      kill();
      await browser.close().catch(() => undefined);
      await fs.rm(partial, { force: true });
      if (sounds) await fs.rm(sounds, { force: true });
    }
  }
}

/**
 * The `sounds()` cues of the whole video (render pages show it all: video seconds), checked again here since scene code
 * can replace `window.__cadence`: the frame caps each scene, this caps their sum, and the video whatever its number of
 * scenes (the mix is synchronous). Scene starts are rounded to the
 * millisecond, so a cue at the very end of the last scene may pass the video's duration by half of one. A `sounds()`
 * that throws is reported by the first line of its message, without the stack and its local URLs.
 */
export async function soundCues(page: Page, project: ProjectState) {
  const value = await withTimeout(
    page
      .evaluate(() => window.__cadence!.sounds())
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        const line = Array.from(message.slice(0, 2 * ERROR_CHARS).split('\n')[0])
          .slice(0, ERROR_CHARS)
          .join('');
        throw new Error(m().media.render.invalidSounds(line));
      }),
    RENDER_TIMEOUT_MS,
    m().media.render.soundsTimeout(RENDER_TIMEOUT_MS / 1000),
  );
  const max = Math.min(MAX_SOUND_CUES * project.scenes.length, MAX_VIDEO_SOUND_CUES);
  const parsed = parseSoundCues(value, project.duration + 0.001, m().media.sounds.cues, max);
  if ('error' in parsed) throw new Error(m().media.render.invalidSounds(parsed.error));
  return parsed.cues;
}

/**
 * A render killed with its process (crash, SIGKILL) leaves its .part file, its sounds track and maybe the temporary file
 * of that track. A live render, even from another Cadence on the same folder, writes its .part every few seconds: a
 * file untouched for an hour is left over. A track that old may still feed a long render, but ffmpeg opened it when it
 * started, and removing an open file does not cut it off (Cadence refuses to run on Windows). Only plain files go: a
 * link or a folder under one of these names stays.
 */
async function dropStale(file: string): Promise<void> {
  const stat = await fs.lstat(file).catch(() => null);
  if (stat?.isFile() && Date.now() - stat.mtimeMs > 60 * 60_000) await fs.rm(file, { force: true });
}

/** Frames of the request in this state of the project (the range is clamped to the video). */
function frameRange(project: ProjectState, request: RenderRequest, fps: number): { from: number; total: number } {
  const from = Math.min(request.range?.from ?? 0, project.duration);
  const to = Math.min(request.range?.to ?? project.duration, project.duration);
  const total = Math.round((to - from) * fps);
  if (total < 1) throw new Error(m().media.render.nothing);
  return { from, total };
}

/**
 * The project state every page shows. Pages fetch it on their own, a moment after the job read it: an edit in between
 * (a duration, an agent's edit) would put frames of one state in a video sized for another. They are brought to the
 * store's state when they differ from the job's.
 * Only the length and the code generation are compared: a reorder that keeps the length goes unnoticed.
 */
async function shownState(pages: FramePage[], project: ProjectState, store: ProjectStore): Promise<ProjectState> {
  const shows = async (expected: ProjectState) => {
    const seen = await Promise.all(
      pages.map(({ page }) => page.evaluate(() => [window.__cadence!.duration(), window.__cadence!.generation()])),
    );
    return seen.every(([duration, generation]) => duration === expected.duration && generation === expected.codeGeneration);
  };
  if (await shows(project)) return project;
  const generation = store.generation(project.id);
  await Promise.all(
    pages.map(({ page }) =>
      withTimeout(
        page.evaluate((g) => window.__cadence!.reload(g), generation),
        RENDER_TIMEOUT_MS,
        m().media.reloadTimeout,
      ),
    ),
  );
  const current = await store.get(project.id);
  if (await shows(current)) return current;
  throw new Error(m().media.render.projectChanged);
}

function normalizeRequest(project: ProjectState, req: RenderRequest): RenderRequest {
  const formats = [...new Set(req.formats ?? [])];
  const t = m().media;
  if (formats.length === 0 || !formats.every(isFormatId)) throw new HttpError(400, t.render.invalidFormats);
  const fps = req.fps ?? project.fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new HttpError(400, t.invalidFps(fps));
  const scale = req.scale ?? 1;
  if (![0.5, 1, 2].includes(scale)) throw new HttpError(400, t.render.invalidScale(scale));
  if (!Object.hasOwn(PRESETS, req.quality)) throw new HttpError(400, t.render.invalidQuality(req.quality));
  const range = req.range;
  if (range && !(Number.isFinite(range.from) && Number.isFinite(range.to) && range.from >= 0 && range.to > range.from)) {
    throw new HttpError(400, t.render.invalidRange);
  }
  if (project.scenes.length === 0) throw new HttpError(400, t.render.noScene);
  return {
    formats,
    fps,
    scale,
    quality: req.quality,
    supersample: Boolean(req.supersample),
    ...(range ? { range: { from: range.from, to: range.to } } : {}),
  };
}

export function ffmpegArgs(o: {
  fps: number;
  width: number;
  height: number;
  /** Frames are captured at twice the output size. */
  supersample: boolean;
  crf: number;
  preset: string;
  audio: { file: string; start: number; volume: number } | null;
  /** The voice-over track from `start` (video seconds), and when it speaks in output seconds. */
  voice: { file: string; start: number; intervals: [number, number][]; musicLevel: number } | null;
  /** The sounds track, which starts at the range start. */
  sounds: string | null;
  /** Seconds: frames / fps. */
  duration: number;
  output: string;
}): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(o.fps),
    '-c:v',
    'mjpeg',
    '-i',
    'pipe:0',
  ];
  let inputs = 1;
  const input = (file: string, seek?: number) => {
    if (seek !== undefined) args.push('-ss', seek.toFixed(3));
    args.push('-i', file);
    return inputs++;
  };
  const musicInput = o.audio ? input(o.audio.file, o.audio.start) : null;
  const voiceInput = o.voice ? input(o.voice.file, o.voice.start) : null;
  const soundsInput = o.sounds ? input(o.sounds) : null;
  const mixed = Boolean(o.voice || o.sounds);
  args.push('-map', '0:v:0');
  if (o.audio && !mixed) args.push('-map', `${musicInput}:a:0?`);
  const k = o.supersample ? 2 : 1;
  args.push(
    // Screenshots are full-range BT.601 JPEGs; the video is limited-range BT.709 (lanczos also handles supersampling).
    // The crop drops the odd last row of an odd canvas (4:5 at 0.5×) instead of resampling every frame by 1/675.
    // setparams tags the frames themselves: the encoder takes primaries and transfer from them, not from -color_*.
    '-vf',
    `crop=${o.width * k}:${o.height * k}:0:0,scale=${o.width}:${o.height}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
    '-c:v',
    'libx264',
    '-preset',
    o.preset,
    '-crf',
    String(o.crf),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-r',
    String(o.fps),
  );
  const fade = Math.min(FADE_OUT_S, o.duration);
  const fadeOut = `afade=t=out:st=${(o.duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`;
  // loudnorm first so `volume` stays relative to a normalized track; the fade comes last so nothing undoes it.
  // loudnorm runs at 192 kHz: newer ffmpeg resamples to it on its own, 5.1 (Debian 12) fails unless asked to.
  const normalize = (lufs: number) => ['aresample=192000', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, 'aresample=48000'];
  if (o.audio && !mixed) {
    args.push('-af', [...normalize(-14), `volume=${o.audio.volume}`, fadeOut].join(','), '-c:a', 'aac', '-b:a', '192k');
  } else if (mixed) {
    const chains: string[] = [];
    const labels: string[] = [];
    if (o.audio) {
      const duck = o.voice?.intervals.length
        ? [`volume='${duckExpression(o.voice.intervals, o.voice.musicLevel)}':eval=frame`]
        : [];
      chains.push(`[${musicInput}:a]${[...normalize(-14), `volume=${o.audio.volume}`, ...duck].join(',')}[music]`);
      labels.push('[music]');
    }
    // Piper already evens out each sentence, and the sounds are levelled in their library; loudnorm would not do: on the
    // digital silence between sentences, it outputs garbage that the limiter turns into noise. The limiter, on the voice
    // alone too, only catches peaks: its default auto-level would lift everything back to 0 dB, ducking included.
    const limiter = 'alimiter=limit=0.95:level=disabled';
    if (o.voice) {
      chains.push(`[${voiceInput}:a]aresample=48000[voice]`);
      labels.push('[voice]');
    }
    if (o.sounds) {
      chains.push(`[${soundsInput}:a]aresample=48000[sounds]`);
      labels.push('[sounds]');
    }
    const mix = labels.length > 1 ? `amix=inputs=${labels.length}:duration=longest:normalize=0,` : '';
    chains.push(`${labels.join('')}${mix}${limiter},${fadeOut}[audio]`);
    args.push('-filter_complex', chains.join(';'), '-map', '[audio]', '-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-t', o.duration.toFixed(6), '-movflags', '+faststart', '-f', 'mp4', o.output);
  return args;
}

/** duckGain (src/shared/voiceOver.ts) as an ffmpeg `volume` expression of `t`. */
export function duckExpression(spans: [number, number][], level: number): string {
  const r = DUCK_RAMP_S;
  const depth = spans
    .map(([start, end]) => `clip(min((t-${(start - r).toFixed(3)})/${r},(${(end + r).toFixed(3)}-t)/${r}),0,1)`)
    .reduce((all, one) => `max(${all},${one})`);
  return `1-${(1 - level).toFixed(3)}*${depth}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  promise.catch(() => undefined);
  return promise;
}

/** Rounded down: the frame is cropped to it, never stretched. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function lastLine(text: string): string {
  return text.trim().split('\n').slice(-2).join(' ') || m().media.render.noDetail;
}

/** Local time, e.g. 20260930-181502. */
function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function freeName(dir: string, base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.mp4` : `${base}-${i}.mp4`;
    if (!(await pathExists(path.join(dir, name))) && !(await pathExists(path.join(dir, `${name}.part`)))) return name;
  }
}

function renderUrl(projectId: string, name: string): string {
  return `/api/projects/${projectId}/renders/${encodeURIComponent(name)}`;
}

function formatFromName(name: string): FormatId | null {
  const match = /-(\d+)x(\d+)-\d{8}-\d{6}(?:-\d+)?\.mp4$/.exec(name);
  const format = match ? `${match[1]}:${match[2]}` : null;
  return isFormatId(format) ? format : null;
}
