// MP4 export: headless frame pages capture frames in parallel, ffmpeg encodes them in order (H.264 + soundtrack).
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
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
import type { CadenceConfig, Hub, MusicService, ProjectStore, RenderService } from '../contracts';
import { m } from '../i18n';
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

  constructor(private readonly deps: { config: CadenceConfig; store: ProjectStore; music: MusicService; hub: Hub }) {}

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
    await Promise.all(entries.filter((name) => name.endsWith('.part')).map((name) => dropStalePart(path.join(dir, name))));
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
    const { config, store, music } = this.deps;
    const request = job.request;
    job.status = 'rendering';
    this.emit(state, true);
    await store.syncCode(job.projectId);
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
    }
  }
}

/**
 * A render killed with its process (crash, SIGKILL) leaves its .part file. A live one, even from another Cadence on the
 * same folder, is written to every few seconds: one untouched for an hour is left over.
 */
async function dropStalePart(file: string): Promise<void> {
  const stat = await fs.stat(file).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > 60 * 60_000) await fs.rm(file, { force: true });
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

function ffmpegArgs(o: {
  fps: number;
  width: number;
  height: number;
  /** Frames are captured at twice the output size. */
  supersample: boolean;
  crf: number;
  preset: string;
  audio: { file: string; start: number; volume: number } | null;
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
  if (o.audio) args.push('-ss', o.audio.start.toFixed(3), '-i', o.audio.file);
  args.push('-map', '0:v:0');
  if (o.audio) args.push('-map', '1:a:0?');
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
  if (o.audio) {
    const fade = Math.min(FADE_OUT_S, o.duration);
    // loudnorm first so `volume` stays relative to a normalized track; the fade comes last so nothing undoes it.
    // loudnorm runs at 192 kHz: newer ffmpeg resamples to it on its own, 5.1 (Debian 12) fails unless asked to.
    const filters = [
      'aresample=192000',
      'loudnorm=I=-14:TP=-1.5:LRA=11',
      'aresample=48000',
      `volume=${o.audio.volume}`,
      `afade=t=out:st=${(o.duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`,
    ];
    args.push('-af', filters.join(','), '-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-t', o.duration.toFixed(6), '-movflags', '+faststart', '-f', 'mp4', o.output);
  return args;
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
