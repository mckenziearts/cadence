// Video export: headless frame pages capture frames in parallel, ffmpeg encodes them in order (H.264 MP4, VP9 WebM,
// ProRes MOV or GIF, with the soundtrack but on a GIF), or writes one PNG frame or a folder of numbered PNG frames.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CDPSession, Page } from 'playwright';
import { MAX_SOUND_CUES, MAX_VIDEO_SOUND_CUES, parseSoundCues } from '../../src/shared/sounds';
import {
  FORMATS,
  isFormatId,
  RENDER_OUTPUTS,
  type FormatId,
  type ProjectState,
  type RenderFile,
  type RenderJob,
  type RenderOutput,
  type RenderQuality,
  type RenderRequest,
} from '../../src/shared/types';
import { DUCK_RAMP_S, voiceSpans } from '../../src/shared/voiceOver';
import type {
  BrowserServer,
  CadenceConfig,
  ChromiumOptions,
  ClipService,
  Hub,
  MusicService,
  ProjectStore,
  RenderService,
  VoiceOverService,
} from '../contracts';
import { m } from '../i18n';
import { soundTrack } from '../sounds/track';
import { assertId, formatSeconds, HttpError, listInside, nowIso, pathExists, resolveInside } from '../util';
import { fromPage, launchChromium, openFramePage, RENDER_TIMEOUT_MS, seekFrame, withTimeout, type FramePage } from './capture';
import { ffmpegEncoders, outputSupport } from './encoders';

const execFileAsync = promisify(execFile);

/** `crf` is x264's scale; VP9's runs from 0 to 63, and 31 is libvpx's advice for 1080p. */
// vp9Speed is libvpx's -cpu-used: its default of 0 encodes a 1080p WebM at about 23 fps, slower than the capture.
const PRESETS: Record<RenderQuality, { crf: number; vp9Crf: number; preset: string; vp9Speed: number; jpeg: number }> = {
  draft: { crf: 23, vp9Crf: 38, preset: 'veryfast', vp9Speed: 4, jpeg: 80 },
  standard: { crf: 16, vp9Crf: 31, preset: 'medium', vp9Speed: 2, jpeg: 95 },
  master: { crf: 10, vp9Crf: 24, preset: 'slow', vp9Speed: 1, jpeg: 100 },
};

/** Frames a page captures in a row (consecutive frames re-render cheaply); pages never run far ahead of ffmpeg. */
const BLOCK = 8;
/** What the PNG frames captured ahead of ffmpeg may weigh. */
const AHEAD_PNG_BYTES = 256e6;
/** Bytes per pixel of a PNG with alpha in the worst case measured: 1.66 for a noisy page, 0.64 for a gradient. */
const PNG_BYTES_PER_PIXEL = 1.7;
const FADE_OUT_S = 0.6;
const PROGRESS_INTERVAL_MS = 100;
/** Characters of a thrown `sounds()` message a failed render shows. */
const ERROR_CHARS = 200;
/**
 * What a render writes in .cadence/sounds: `<job id>.wav` (randomUUID) and the temporary file of writeFileAtomic. The
 * sweep leaves anything else alone: the folder may hold what a copied project brought, or link elsewhere.
 */
const TRACK_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav(\.\d+\.[0-9a-f]{8}\.tmp)?$/;

/** The outputs a request may ask for. */
export const ACCEPTED_OUTPUTS = RENDER_OUTPUTS;
const ALPHA_OUTPUTS: readonly RenderOutput[] = ['webm', 'mov', 'png', 'png-sequence'];

export function isAcceptedOutput(value: unknown): value is RenderOutput {
  return (ACCEPTED_OUTPUTS as readonly unknown[]).includes(value);
}

/**
 * The name of each kind of render in renders/: a file by its extension, a PNG sequence a folder. A folder name has no
 * dot, so a `.part` never passes for a render.
 */
const RENDER_NAMES: Record<RenderOutput, RegExp> = {
  mp4: /^\w[\w.-]*\.mp4$/,
  webm: /^\w[\w.-]*\.webm$/,
  mov: /^\w[\w.-]*\.mov$/,
  gif: /^\w[\w.-]*\.gif$/,
  png: /^\w[\w.-]*\.png$/,
  'png-sequence': /^\w[\w-]*$/,
};

function outputOf(name: string): RenderOutput | undefined {
  return RENDER_OUTPUTS.find((output) => RENDER_NAMES[output].test(name));
}

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
      clips: ClipService;
      voiceOver: VoiceOverService;
      hub: Hub;
      browserServer?: (options: ChromiumOptions) => Promise<BrowserServer>;
    },
  ) {}

  async start(projectId: string, req: RenderRequest): Promise<RenderJob[]> {
    const project = await this.deps.store.get(projectId);
    const request = normalizeRequest(project, req);
    const support = (await outputSupport(this.deps.config.ffmpegPath))[request.output];
    if (!support.available) throw new HttpError(422, support.reason);
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

  /**
   * Plain files and folders only, never through a link: a renders folder that is one lists nothing. The project folder of
   * a copied or imported project may hold anything.
   */
  async files(projectId: string): Promise<RenderFile[]> {
    const dir = this.rendersDir(projectId);
    const project = path.dirname(dir);
    const entries = await listInside(project, dir).catch(() => [] as string[]);
    const sounds = this.soundsDir(projectId);
    const tracks = await fs.readdir(sounds).catch(() => [] as string[]);
    await Promise.all([
      ...entries.filter((name) => name.endsWith('.part')).map((name) => dropStale(path.join(dir, name))),
      ...tracks.filter((name) => TRACK_FILE.test(name)).map((name) => dropStale(path.join(sounds, name))),
    ]);
    const files = await Promise.all(
      entries.map(async (name) => {
        const output = outputOf(name);
        const stat = output ? await fs.lstat(path.join(dir, name)).catch(() => null) : null;
        if (!output || !stat || !(output === 'png-sequence' ? stat.isDirectory() : stat.isFile())) return null;
        const file: RenderFile = {
          name,
          url: renderUrl(projectId, name),
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          format: formatFromName(name),
          output,
          ...(output === 'png-sequence' ? await sequenceFiles(project, path.join(dir, name)) : {}),
        };
        return file;
      }),
    );
    return files.filter((file) => file !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolveFile(projectId: string, name: string): string {
    if (!outputOf(name)) throw new HttpError(400, m().media.render.invalidFileName(name));
    return resolveInside(this.rendersDir(projectId), name);
  }

  /**
   * Kept in .cadence/trash rather than deleted, like a project or an asset: getting it back beats rendering it again. A
   * link, or a renders folder that is one, is never moved. Checked by path: no agent turn writes renders/.
   */
  async remove(projectId: string, name: string): Promise<void> {
    const file = this.resolveFile(projectId, name);
    const [folder, stat] = await Promise.all([fs.lstat(path.dirname(file)), fs.lstat(file)].map((p) => p.catch(() => null)));
    const kind = outputOf(name) === 'png-sequence' ? stat?.isDirectory() : stat?.isFile();
    if (!folder?.isDirectory() || !kind) throw new HttpError(404, m().api.fileNotFound(name));
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
      framesTotal: request.output === 'png' ? 1 : Math.max(0, Math.round(span * fps)),
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
        // run() returns once its browser is closed and its .part and sounds track are gone: a finished job leaves nothing.
        this.end(state, await this.run(state));
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

  private async run(state: JobState): Promise<Partial<RenderJob>> {
    const { job, abort } = state;
    const { config, store, music, clips, voiceOver } = this.deps;
    const request = job.request;
    job.status = 'rendering';
    this.emit(state, true);
    await store.syncCode(job.projectId);
    // Sentences Piper has not spoken yet are spoken now, before the pages load the project: their times are props of
    // the scenes. If Piper cannot, the editor already says why and the MP4 goes out with what is generated.
    await voiceOver.sync(job.projectId).catch(() => undefined);
    // A running music analysis ends before the pages load the project, so scenes get its spectrum, not a pending error.
    // A failed one blocks only the scenes that call music.spectrum(): their pages fail the render with the frame's text.
    // The analyzer has no timeout: a cancel must not wait for it.
    await Promise.race([music.analysis(job.projectId).catch(() => undefined), rejectOnAbort(abort.signal)]);
    // Same for clip frames: a page that loads before they are extracted would draw a clip that is not there yet.
    await Promise.race([clips.whenIdle(job.projectId).catch(() => undefined), rejectOnAbort(abort.signal)]);
    let project = await store.get(job.projectId);
    let { from, total } = frameRange(project, request, job.fps);
    const preset = PRESETS[request.quality];
    // normalizeRequest lets accepted outputs only through.
    const kind = request.output ?? 'mp4';
    const transparent = Boolean(request.transparent);
    // A PNG output is captured losslessly, as ffmpegArgs expects; JPEG would blur its edges and its chroma.
    const pngFrames = transparent || kind === 'png' || kind === 'png-sequence';

    const dir = this.rendersDir(job.projectId);
    await fs.mkdir(dir, { recursive: true });
    const ext = kind === 'png-sequence' ? '' : `.${kind}`;
    const name = await freeName(dir, `${project.id}-${job.format.replace(':', 'x')}-${stamp(new Date())}`, ext);
    // A PNG sequence's partial is the folder its frames go to.
    const partial = path.join(dir, `${name}.part`);
    // A GIF's frames go to a lossless file first, then get their palette in a second pass (see gifArgs).
    const frames = kind === 'gif' ? path.join(dir, `${name}.frames.part`) : null;
    abort.signal.throwIfAborted();

    const browser = await launchChromium(this.deps.browserServer);
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
            transparent,
            requestSecret: config.requestSecret,
          }),
        ),
      );
      // A PNG frame goes through CDP: Playwright's PNG screenshot would set and reset the background on every frame,
      // without optimizeForSpeed (about 5 times slower in 1080p).
      const cdp = pngFrames ? await Promise.all(pages.map(({ page }) => page.context().newCDPSession(page))) : null;
      if (cdp) {
        const background = { color: { r: 0, g: 0, b: 0, a: 0 } };
        // A session without its own metrics override captures at a pixel ratio of 1 whatever the context's is.
        await Promise.all(
          cdp.map((session, i) => {
            const { width, height } = pages[i]!.page.viewportSize()!;
            const metrics = { width, height, deviceScaleFactor: pixelRatio, mobile: false };
            return Promise.all([
              transparent && session.send('Emulation.setDefaultBackgroundColorOverride', background),
              session.send('Emulation.setDeviceMetricsOverride', metrics),
            ]);
          }),
        );
      }
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

      if (kind === 'png-sequence') await fs.mkdir(partial);
      const ffmpeg = spawn(
        config.ffmpegPath,
        ffmpegArgs({
          fps: job.fps,
          width: job.width,
          height: job.height,
          supersample: Boolean(request.supersample),
          kind,
          transparent,
          libopus: (await ffmpegEncoders(config.ffmpegPath)).has('libopus'),
          crf: kind === 'webm' ? preset.vp9Crf : preset.crf,
          preset: kind === 'webm' ? String(preset.vp9Speed) : preset.preset,
          audio,
          voice,
          sounds,
          duration,
          output: frames ?? partial,
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
      const ahead = captureWindow(workers, pngFrames, job.width * job.height * (request.supersample ? 4 : 1));
      let wakeCapture = deferred<void>();
      abort.signal.addEventListener('abort', () => wakeCapture.resolve(), { once: true });

      const capture = async (page: Page, session: CDPSession | undefined) => {
        const screenshot = async (t: number) => {
          if (!session) return page.screenshot({ type: 'jpeg', quality: preset.jpeg, timeout: RENDER_TIMEOUT_MS });
          const shot = session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
          const timeout = m().media.capture.seekTimeout(formatSeconds(t), RENDER_TIMEOUT_MS / 1000);
          return Buffer.from((await withTimeout(shot, RENDER_TIMEOUT_MS, timeout)).data, 'base64');
        };
        for (;;) {
          while (cursor >= written + ahead.frames && !abort.signal.aborted) await wakeCapture.promise;
          abort.signal.throwIfAborted();
          if (cursor >= total) return;
          const start = cursor;
          const end = Math.min(total, start + ahead.block);
          cursor = end;
          for (let i = start; i < end; i++) {
            abort.signal.throwIfAborted();
            const t = from + i / job.fps;
            const result = await seekFrame(page, t);
            if (result.errors.length > 0) throw new Error(m().media.render.videoError(formatSeconds(t), result.errors[0]));
            images[i]!.resolve(await screenshot(t));
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

      await Promise.all([write(), ...pages.map(({ page }, i) => capture(page, cdp?.[i]).catch((e: unknown) => abort.abort(e)))]);
      Object.assign(job, { status: 'encoding' });
      this.emit(state, true);
      const code = await exited;
      abort.signal.throwIfAborted();
      if (code !== 0) throw new Error(m().media.render.ffmpegFailed(code, lastLine(stderr)));
      if (frames) {
        await execFileAsync(config.ffmpegPath, gifArgs(frames, partial), { signal: abort.signal, killSignal: 'SIGKILL' }).catch(
          (e: { code?: unknown; stderr?: string }) => {
            throw new Error(m().media.render.ffmpegFailed(typeof e.code === 'number' ? e.code : 1, lastLine(e.stderr ?? '')));
          },
        );
      }
      const output = path.join(dir, name);
      await fs.rename(partial, output);
      return { status: 'done', progress: 1, framesDone: total, file: name, url: renderUrl(job.projectId, name) };
    } catch (e) {
      // A capture error aborts the others with the same reason: report the first one.
      throw abort.signal.aborted ? abort.signal.reason : e;
    } finally {
      kill();
      await browser.close().catch(() => undefined);
      await fs.rm(partial, { force: true, recursive: true });
      if (frames) await fs.rm(frames, { force: true });
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

/** Bytes and number of the plain files in a PNG sequence folder. */
async function sequenceFiles(root: string, folder: string): Promise<{ size: number; frames: number }> {
  const names = await listInside(root, folder).catch(() => [] as string[]);
  const stats = await Promise.all(names.map((name) => fs.lstat(path.join(folder, name)).catch(() => null)));
  const files = stats.filter((stat) => stat?.isFile());
  return { size: files.reduce((sum, stat) => sum + stat!.size, 0), frames: files.length };
}

/**
 * A render killed with its process (crash, SIGKILL) leaves its .part file (a folder for a PNG sequence), its sounds track
 * and maybe the temporary file of that track. A live render, even from another Cadence on the same folder, writes its
 * .part every few seconds, and each frame added to a sequence folder touches it: one untouched for an hour is left over.
 * A track that old may still feed a long render, but ffmpeg opened it when it started, and removing an open file does
 * not cut it off (Cadence refuses to run on Windows). Only plain files and folders named like a sequence's .part go, the
 * folder with what it holds (rm does not follow the links inside); a link, or any other folder, stays.
 */
async function dropStale(file: string): Promise<void> {
  const stat = await fs.lstat(file).catch(() => null);
  const sequence = stat?.isDirectory() && RENDER_NAMES['png-sequence'].test(path.basename(file, '.part'));
  if ((stat?.isFile() || sequence) && Date.now() - stat!.mtimeMs > 60 * 60_000) {
    await fs.rm(file, { recursive: true, force: true });
  }
}

/** Frames of the request in this state of the project (the range is clamped to the video); a still PNG is one frame. */
function frameRange(project: ProjectState, request: RenderRequest, fps: number): { from: number; total: number } {
  const from = Math.min(request.range?.from ?? 0, project.duration);
  if (request.output === 'png') return { from, total: 1 };
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
      pages.map(({ page }) => fromPage(page.evaluate(() => [window.__cadence!.duration(), window.__cadence!.generation()]))),
    );
    return seen.every(([duration, generation]) => duration === expected.duration && generation === expected.codeGeneration);
  };
  if (await shows(project)) return project;
  const generation = store.generation(project.id);
  await Promise.all(
    pages.map(({ page }) =>
      withTimeout(
        fromPage(page.evaluate((g) => window.__cadence!.reload(g), generation)),
        RENDER_TIMEOUT_MS,
        m().media.reloadTimeout,
      ),
    ),
  );
  const current = await store.get(project.id);
  if (await shows(current)) return current;
  throw new Error(m().media.render.projectChanged);
}

export function normalizeRequest(
  project: ProjectState,
  req: RenderRequest,
): RenderRequest & Required<Pick<RenderRequest, 'output' | 'transparent'>> {
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
  const output = req.output ?? 'mp4';
  if (!isAcceptedOutput(output)) throw new HttpError(400, t.render.invalidOutput(output));
  if (req.transparent && !ALPHA_OUTPUTS.includes(output)) throw new HttpError(422, t.render.noTransparency(output));
  if (project.scenes.length === 0) throw new HttpError(400, t.render.noScene);
  return {
    formats,
    fps,
    scale,
    quality: req.quality,
    supersample: Boolean(req.supersample),
    ...(range ? { range: { from: range.from, to: range.to } } : {}),
    output,
    transparent: Boolean(req.transparent),
  };
}

const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

/**
 * What an output changes in the ffmpeg arguments; a GIF has no audio, and its own colors (see ffmpegArgs). The GIF
 * arguments write its frames losslessly, for gifArgs. PNG outputs have no audio and stay RGB.
 */
const OUTPUT_ARGS: Record<
  RenderOutput,
  {
    pixels: ((transparent: boolean) => string) | null;
    video: (o: { preset: string; crf: number; transparent: boolean }) => string[];
    audio: ((libopus: boolean) => string[]) | null;
    container: string[];
  }
> = {
  mp4: {
    pixels: () => 'yuv420p',
    video: (o) => ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), ...BT709],
    audio: () => ['-c:a', 'aac', '-b:a', '192k'],
    container: ['-movflags', '+faststart', '-f', 'mp4'],
  },
  webm: {
    pixels: (transparent) => (transparent ? 'yuva420p' : 'yuv420p'),
    video: (o) => [
      ...['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(o.crf)],
      ...['-deadline', 'good', '-cpu-used', o.preset, '-row-mt', '1', ...BT709],
    ],
    // ffmpeg's own opus encoder is still experimental.
    audio: (libopus) => (libopus ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'opus', '-strict', '-2', '-b:a', '192k']),
    container: ['-f', 'webm'],
  },
  mov: {
    pixels: (transparent) => (transparent ? 'yuva444p10le' : 'yuv422p10le'),
    // 4444 carries the alpha; 3 is 422 HQ.
    video: (o) => ['-c:v', 'prores_ks', '-profile:v', o.transparent ? '4444' : '3', ...BT709],
    audio: () => ['-c:a', 'pcm_s16le'],
    container: ['-f', 'mov'],
  },
  gif: {
    pixels: null,
    video: () => ['-c:v', 'ffv1'],
    audio: null,
    container: ['-f', 'matroska'],
  },
  png: {
    pixels: (transparent) => (transparent ? 'rgba' : 'rgb24'),
    video: () => ['-c:v', 'png'],
    audio: null,
    container: ['-frames:v', '1', '-update', '1', '-f', 'image2'],
  },
  'png-sequence': {
    pixels: (transparent) => (transparent ? 'rgba' : 'rgb24'),
    video: () => ['-c:v', 'png'],
    audio: null,
    container: ['-f', 'image2'],
  },
};

export function ffmpegArgs(o: {
  fps: number;
  width: number;
  height: number;
  /** Frames are captured at twice the output size. */
  supersample: boolean;
  /** An opaque MP4 by default. */
  kind?: RenderOutput;
  /** Frames carry their alpha. They come as PNG then, as for a PNG output, and as JPEG otherwise. */
  transparent?: boolean;
  /** WebM audio takes libopus, or ffmpeg's own opus without it. */
  libopus?: boolean;
  crf: number;
  /** x264's preset, or libvpx's -cpu-used for a WebM. */
  preset: string;
  audio: { file: string; start: number; volume: number } | null;
  /** The voice-over track from `start` (video seconds), and when it speaks in output seconds. */
  voice: { file: string; start: number; intervals: [number, number][]; musicLevel: number } | null;
  /** The sounds track, which starts at the range start. */
  sounds: string | null;
  /** Seconds: frames / fps. */
  duration: number;
  /** The file, or the folder of a PNG sequence. */
  output: string;
}): string[] {
  const kind = o.kind ?? 'mp4';
  const out = OUTPUT_ARGS[kind];
  const transparent = Boolean(o.transparent);
  const pixels = out.pixels?.(transparent);
  const rgb = Boolean(pixels?.startsWith('rgb'));
  const pngIn = transparent || rgb;
  const { audio, voice, sounds } = out.audio ? o : { audio: null, voice: null, sounds: null };
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
    pngIn ? 'png' : 'mjpeg',
    '-i',
    'pipe:0',
  ];
  let inputs = 1;
  const input = (file: string, seek?: number) => {
    if (seek !== undefined) args.push('-ss', seek.toFixed(3));
    args.push('-i', file);
    return inputs++;
  };
  const musicInput = audio ? input(audio.file, audio.start) : null;
  const voiceInput = voice ? input(voice.file, voice.start) : null;
  const soundsInput = sounds ? input(sounds) : null;
  const mixed = Boolean(voice || sounds);
  args.push('-map', '0:v:0');
  if (audio && !mixed) args.push('-map', `${musicInput}:a:0?`);
  const k = o.supersample ? 2 : 1;
  // The crop drops the odd last row of an odd canvas (4:5 at 0.5×) instead of resampling every frame by 1/675; lanczos
  // also handles supersampling.
  const resize = `crop=${o.width * k}:${o.height * k}:0:0,scale=${o.width}:${o.height}:flags=lanczos+accurate_rnd+full_chroma_int`;
  // JPEG screenshots are full-range BT.601, PNG ones RGB; the video is limited-range BT.709. setparams tags the frames
  // themselves: the encoder takes primaries and transfer from them, not from -color_*. A GIF's frames stay as they come:
  // gifArgs turns them into RGB.
  // PNG alpha is straight: resized as it is, the black of the transparent pixels darkens the edges of shapes, so the
  // resize runs on premultiplied pixels. ProRes 4444 and VP9 take straight alpha back.
  // A PNG output keeps the page's RGB: no BT.709 conversion and no tags.
  const colors = transparent
    ? `format=rgba,premultiply=inplace=1,${resize},unpremultiply=inplace=1${rgb ? '' : ',scale=out_color_matrix=bt709:out_range=tv'}`
    : rgb
      ? resize
      : `${resize}:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv`;
  const tags = rgb ? '' : ',setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
  args.push(
    '-vf',
    pixels ? `${colors},format=${pixels}${tags}` : resize,
    ...out.video({ preset: o.preset, crf: o.crf, transparent }),
    '-r',
    kind === 'gif' ? gifRate(o.fps) : String(o.fps),
  );
  const audioCodec = out.audio?.(o.libopus ?? true) ?? [];
  const fade = Math.min(FADE_OUT_S, o.duration);
  const fadeOut = `afade=t=out:st=${(o.duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`;
  // loudnorm first so `volume` stays relative to a normalized track; the fade comes last so nothing undoes it.
  // loudnorm runs at 192 kHz: newer ffmpeg resamples to it on its own, 5.1 (Debian 12) fails unless asked to.
  const normalize = (lufs: number) => ['aresample=192000', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, 'aresample=48000'];
  if (audio && !mixed) {
    args.push('-af', [...normalize(-14), `volume=${audio.volume}`, fadeOut].join(','), ...audioCodec);
  } else if (mixed) {
    const chains: string[] = [];
    const labels: string[] = [];
    if (audio) {
      const duck = voice?.intervals.length ? [`volume='${duckExpression(voice.intervals, voice.musicLevel)}':eval=frame`] : [];
      chains.push(`[${musicInput}:a]${[...normalize(-14), `volume=${audio.volume}`, ...duck].join(',')}[music]`);
      labels.push('[music]');
    }
    // Piper already evens out each sentence, and the sounds are levelled in their library; loudnorm would not do: on the
    // digital silence between sentences, it outputs garbage that the limiter turns into noise. The limiter, on the voice
    // alone too, only catches peaks: its default auto-level would lift everything back to 0 dB, ducking included.
    const limiter = 'alimiter=limit=0.95:level=disabled';
    if (voice) {
      chains.push(`[${voiceInput}:a]aresample=48000[voice]`);
      labels.push('[voice]');
    }
    if (sounds) {
      chains.push(`[${soundsInput}:a]aresample=48000[sounds]`);
      labels.push('[sounds]');
    }
    const mix = labels.length > 1 ? `amix=inputs=${labels.length}:duration=longest:normalize=0,` : '';
    chains.push(`${labels.join('')}${mix}${limiter},${fadeOut}[audio]`);
    args.push('-filter_complex', chains.join(';'), '-map', '[audio]', ...audioCodec);
  }
  // image2 reads the whole path as a pattern: a % in the folder must not make every frame the same file.
  const output = kind === 'png-sequence' ? path.join(o.output.replaceAll('%', '%%'), '%06d.png') : o.output;
  args.push('-t', o.duration.toFixed(6), ...out.container, output);
  return args;
}

/**
 * A GIF stores its frame delays in hundredths of a second, and browsers show a delay of 1 or less for 10: above 50 fps,
 * every second or third frame is kept, so no delay falls under 2.
 */
function gifRate(fps: number): string {
  const step = Math.ceil(fps / 50);
  return Number.isInteger(fps / step) ? String(fps / step) : `${fps}/${step}`;
}

/**
 * How many frames the pages may capture before ffmpeg takes them, and how many a page takes in a row. A JPEG frame stays
 * under about 300 KB, a PNG one (transparent, or for a PNG output) is five to fifty times larger: its window follows the
 * captured pixels, never under one frame per page, and blocks shrink so every page works inside it, passing it by
 * `block - 1` at most.
 */
export function captureWindow(workers: number, png: boolean, pixels: number): { frames: number; block: number } {
  const most = workers * BLOCK * 2;
  const frames = png ? Math.max(workers, Math.min(most, Math.floor(AHEAD_PNG_BYTES / (pixels * PNG_BYTES_PER_PIXEL)))) : most;
  return { frames, block: Math.max(1, Math.min(BLOCK, Math.floor(frames / workers))) };
}

/**
 * The GIF from the lossless frames ffmpegArgs wrote: one palette for the whole video, built from what changes between
 * frames. palettegen gives its palette at the end of its input only, so paletteuse reads the frames a second time from the
 * file instead of holding all of them in memory (about 8 MB a frame in 1080p). stats_mode=diff counts the colour a pixel
 * leaves, so the colours of the last frame (an end card after a cut) would count only once something replaced them: two
 * padded frames of different colours do, on the palette input only.
 */
export function gifArgs(frames: string, output: string): string[] {
  return [
    ...['-y', '-hide_banner', '-loglevel', 'error', '-i', frames, '-i', frames],
    '-filter_complex',
    '[0:v]tpad=stop=1:color=black,tpad=stop=1:color=white,palettegen=stats_mode=diff[p];[1:v][p]paletteuse',
    ...['-c:v', 'gif', '-f', 'gif', output],
  ];
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

/** `ext` with its dot, or '' for a folder. */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
    if (!(await pathExists(path.join(dir, name))) && !(await pathExists(path.join(dir, `${name}.part`)))) return name;
  }
}

function renderUrl(projectId: string, name: string): string {
  return `/api/projects/${projectId}/renders/${encodeURIComponent(name)}`;
}

function formatFromName(name: string): FormatId | null {
  const match = /-(\d+)x(\d+)-\d{8}-\d{6}(?:-\d+)?(?:\.[a-z0-9]+)?$/.exec(name);
  const format = match ? `${match[1]}:${match[2]}` : null;
  return isFormatId(format) ? format : null;
}
