import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ClipInfo, ClipState } from '../../src/shared/types';
import type { CadenceConfig, ClipService, Hub, ProjectStore } from '../contracts';
import { m } from '../i18n';
import {
  createFileInside,
  KeyedMutex,
  openFileNoFollow,
  readFileNoFollow,
  removeTreeInside,
  renameInside,
  roundMs,
  shortHash,
  slugify,
} from '../util';
import { DEMUXERS, parseProbe } from './probe';

const MAX_FPS = 60;
const MAX_SIDE = 3840;
const STALL_MS = 60_000;
const STDERR_LIMIT = 1024 * 1024;
const MAX_FRAMES = 36_000;
const MAX_BYTES = 2 * 1024 ** 3;
const DISK_RESERVE = 2 * 1024 ** 3;
const FILES_RESERVE = 100_000;
const DISK_CHECK_EVERY = 250;
const KEY = /^[a-z0-9-]+-[0-9a-f]{12}$/;
const PART = /^[a-z0-9-]+-[0-9a-f]{12}\.[0-9a-f]{8}\.part$/;

export interface FfmpegRun {
  stdout: Readable;
  stderr: Readable;
  exit: Promise<number | null>;
  kill(): void;
}

export type FfmpegRunner = (args: string[], input: FileHandle) => FfmpegRun;

interface Clip {
  rel: string;
  key: string;
}

export class LocalClipService implements ClipService {
  private chain: Promise<void> = Promise.resolve();
  private jobs = new Map<string, Promise<void>>();
  private failed = new Map<string, string>();
  private mutex = new KeyedMutex();
  private ffmpeg: FfmpegRunner;
  private budget: { frames: number; bytes: number };
  private statfs: (dir: string) => Promise<{ bavail: number; bsize: number; files: number; ffree: number }>;

  constructor(
    private deps: {
      config: CadenceConfig;
      store: ProjectStore;
      hub: Hub;
      ffmpeg?: FfmpegRunner;
      budget?: { frames: number; bytes: number };
      statfs?: (dir: string) => Promise<{ bavail: number; bsize: number; files: number; ffree: number }>;
    },
  ) {
    this.ffmpeg = deps.ffmpeg ?? spawnFfmpeg(deps.config.ffmpegPath);
    this.budget = deps.budget ?? { frames: MAX_FRAMES, bytes: MAX_BYTES };
    this.statfs = deps.statfs ?? ((dir) => fs.statfs(dir));
  }

  start(): void {
    const sync = (id: string) => void this.sync(id).catch((e: Error) => console.warn(m().api.projects.clips(id, e.message)));
    this.deps.store.events.on('assets-changed', sync);
    void this.deps.store.list().then(
      (projects) => projects.forEach((project) => sync(project.id)),
      (e: Error) => console.warn(m().api.projects.clips('*', e.message)),
    );
  }

  sync(projectId: string): Promise<Record<string, ClipState>> {
    return this.mutex.run(projectId, async () => {
      const dir = this.deps.store.dir(projectId);
      const clips = await videoAssets(dir);
      await this.sweep(projectId, dir, new Set(clips.map((clip) => clip.key)));
      const states: Record<string, ClipState> = {};
      for (const clip of clips) {
        const id = `${projectId}/${clip.key}`;
        // Frames another server sharing projects/ prepared beat a failure here. The key changes with the file, so a
        // failed file is tried again once it is replaced.
        const info = this.jobs.has(id) ? null : await readInfo(dir, clip.key);
        const error = this.failed.get(id);
        if (info) states[clip.rel] = { status: 'ready', key: clip.key, ...info };
        else if (error !== undefined) states[clip.rel] = { status: 'error', error };
        else {
          states[clip.rel] = { status: 'preparing' };
          this.queue(projectId, dir, clip);
        }
      }
      return states;
    });
  }

  async whenIdle(projectId: string): Promise<void> {
    await this.sync(projectId);
    for (;;) {
      const pending = [...this.jobs].filter(([id]) => id.startsWith(`${projectId}/`)).map(([, job]) => job);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  /**
   * Removes the folders of keys no asset has any more, and `.part` folders no extraction wrote to for twice STALL_MS: a
   * running one, here or in another server sharing projects/, adds a frame at least every STALL_MS.
   */
  private async sweep(projectId: string, dir: string, keep: Set<string>): Promise<void> {
    for (const name of await clipFolders(dir)) {
      if (PART.test(name)) {
        const stat = await fs.lstat(path.join(dir, 'clips', name)).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs < 2 * STALL_MS) continue;
      } else if (!KEY.test(name) || keep.has(name) || this.jobs.has(`${projectId}/${name}`)) continue;
      await removeClipFolder(dir, name);
    }
  }

  private queue(projectId: string, dir: string, clip: Clip): void {
    const { hub } = this.deps;
    const id = `${projectId}/${clip.key}`;
    if (this.jobs.has(id)) return;
    // One ffmpeg at a time for the whole server: each extraction already takes every core it is given.
    const run = this.chain.then(() =>
      this.prepare(dir, clip).catch((e: Error) => {
        this.failed.set(id, e.message);
        console.warn(m().media.clips.notPrepared(clip.rel, e.message));
      }),
    );
    this.chain = run;
    const job = run.then(async () => {
      this.jobs.delete(id);
      hub.send({ type: 'project-changed', projectId });
      // Drops its folder if the asset changed meanwhile.
      await this.sync(projectId).catch(() => undefined);
    });
    this.jobs.set(id, job);
    hub.send({ type: 'project-changed', projectId });
  }

  /**
   * Frames into clips/<key>.<id>.part/, clip.json last, then the folder takes its name, unless another server sharing
   * projects/ prepared the same key first.
   */
  private async prepare(dir: string, { rel, key }: Clip): Promise<void> {
    const name = path.basename(rel);
    const file = path.join(dir, 'assets', rel);
    // A file copied in several steps queues one key per size seen: the sync that saw the last one queued its own key.
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || keyOf(rel, stat) !== key) return;
    const demuxer = DEMUXERS[extension(rel)];
    // The probe's forced demuxer and protocol whitelist (see DEMUXERS), on the file opened here.
    const input = ['-hide_banner', '-protocol_whitelist', 'file', '-f', demuxer, '-i', '/dev/fd/3'];
    const probe = parseProbe((await this.run(dir, file, name, input)).stderr, { still: demuxer === 'gif' });
    if (!probe) throw new Error(m().media.clips.unreadable(name));
    // The fps filter also turns a GIF's per-frame delays into a steady rate.
    const fps = Math.min(probe.fps, MAX_FPS);
    const tooLong = () => new Error(m().media.clips.tooLong(name, Math.floor(this.budget.frames / fps / 60)));
    if (probe.duration * fps > this.budget.frames) throw tooLong();
    // Both sides bounded: JpegSplitter holds a whole frame in memory, however tall the source.
    const scale = `scale=w='min(iw,${MAX_SIDE})':h='min(ih,${MAX_SIDE})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    const output = ['-an', '-vf', `fps=${fps},${scale}`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3'];
    const partName = `${key}.${randomBytes(4).toString('hex')}.part`;
    const part = path.join(dir, 'clips', partName);
    try {
      let frames = 0;
      let bytes = 0;
      let first: Buffer | undefined;
      const { code, stderr } = await this.run(dir, file, name, [...input, ...output, 'pipe:1'], async (frame) => {
        first ??= frame;
        frames++;
        bytes += frame.length;
        // The probe reads the duration from the file, which can state any: the frames printed are what the budget counts.
        if (frames > this.budget.frames || bytes > this.budget.bytes) throw tooLong();
        // The budget is per clip: many clips at once (an imported archive full of GIFs) must not fill the disk.
        if (frames % DISK_CHECK_EVERY === 1) await this.checkDisk(dir, name);
        await createFileInside(dir, path.join(part, `${String(frames).padStart(6, '0')}.jpg`), frame);
      });
      const size = first && jpegSize(first);
      if (code !== 0 || !frames || !size) throw new Error((code !== 0 && lastLine(stderr)) || m().media.clips.unreadable(name));
      const info: ClipInfo = { fps, frames, ...size, duration: roundMs(frames / fps), audio: probe.audio };
      await createFileInside(dir, path.join(part, 'clip.json'), JSON.stringify(info));
      if (await readInfo(dir, key)) {
        await removeClipFolder(dir, partName);
        return;
      }
      await removeClipFolder(dir, key);
      await renameInside(dir, part, path.join(dir, 'clips', key));
    } catch (e) {
      await removeClipFolder(dir, partName).catch(() => undefined);
      throw e;
    }
  }

  private async checkDisk(dir: string, name: string): Promise<void> {
    const { bavail, bsize, files, ffree } = await this.statfs(dir);
    // A filesystem with dynamic inodes (btrfs, some network ones) reports files = 0: nothing to check there.
    if (bavail * bsize < DISK_RESERVE || (files > 0 && ffree < FILES_RESERVE)) throw new Error(m().media.clips.diskFull(name));
  }

  /** ffmpeg on `file`, each frame it prints given to `onFrame`; killed after STALL_MS without one. */
  private async run(
    dir: string,
    file: string,
    name: string,
    args: string[],
    onFrame?: (frame: Buffer) => Promise<void>,
  ): Promise<{ code: number | null; stderr: string }> {
    const input = await openFileNoFollow(dir, file);
    let code: number | null;
    let stderr = '';
    let stalled = false;
    try {
      const proc = this.ffmpeg(args, input);
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        // ffmpeg prints a progress line twice a second: the tail is enough for the probe and the last error line.
        if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT / 2);
      });
      // ponytail: a fixed 60 s without a frame, however slow the source decodes; a per-clip budget if that ever bites.
      const watch = () =>
        setTimeout(() => {
          stalled = true;
          proc.kill();
        }, STALL_MS);
      let timer = watch();
      try {
        if (!onFrame) proc.stdout.resume();
        else {
          const splitter = new JpegSplitter();
          for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
            for (const frame of splitter.push(chunk)) {
              clearTimeout(timer);
              await onFrame(frame);
              timer = watch();
            }
          }
        }
        code = await proc.exit;
      } catch (e) {
        proc.kill();
        await proc.exit.catch(() => undefined);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await input.close();
    }
    if (stalled) throw new Error(m().media.clips.stalled(name, STALL_MS / 1000));
    return { code, stderr };
  }
}

export class JpegSplitter {
  private held: Buffer[] = [];
  private state: 'marker' | 'code' | 'length' | 'length2' | 'segment' | 'scan' | 'scanMarker' = 'marker';
  private code = 0;
  private left = 0;

  /** The frames of the `-f image2pipe -c:v mjpeg` stream that `chunk` completes, whatever the chunks it arrives in. */
  push(chunk: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let from = 0;
    for (let i = 0; i < chunk.length;) {
      const byte = chunk[i];
      switch (this.state) {
        case 'marker':
          if (byte !== 0xff) throw new Error(m().media.clips.notJpeg);
          this.state = 'code';
          i++;
          break;
        case 'code':
        case 'scanMarker':
          i++;
          // In entropy-coded data, 0xFF00 is a stuffed 0xFF and RST0-7 carry no length: the scan goes on.
          if (this.state === 'scanMarker' && (byte === 0x00 || isRst(byte))) this.state = 'scan';
          else if (byte === 0xff) break;
          else if (byte === 0xd9) {
            frames.push(Buffer.concat([...this.held, chunk.subarray(from, i)]));
            this.held = [];
            from = i;
            this.state = 'marker';
          } else if (byte === 0xd8 || byte === 0x01 || isRst(byte)) this.state = 'marker';
          else {
            this.code = byte;
            this.state = 'length';
          }
          break;
        case 'length':
          this.left = byte << 8;
          this.state = 'length2';
          i++;
          break;
        case 'length2':
          this.left = (this.left | byte) - 2;
          this.state = 'segment';
          i++;
          break;
        case 'segment': {
          const skipped = Math.min(Math.max(this.left, 0), chunk.length - i);
          i += skipped;
          this.left -= skipped;
          if (this.left <= 0) this.state = this.code === 0xda ? 'scan' : 'marker';
          break;
        }
        case 'scan': {
          const at = chunk.indexOf(0xff, i);
          i = at < 0 ? chunk.length : at + 1;
          if (at >= 0) this.state = 'scanMarker';
          break;
        }
      }
    }
    if (from < chunk.length) this.held.push(chunk.subarray(from));
    return frames;
  }
}

function isRst(byte: number): boolean {
  return byte >= 0xd0 && byte <= 0xd7;
}

/** Width and height from the frame's start-of-frame marker. */
function jpegSize(frame: Buffer): { width: number; height: number } | null {
  for (let at = 2; at + 9 <= frame.length && frame[at] === 0xff; at += 2 + frame.readUInt16BE(at + 2)) {
    const code = frame[at + 1];
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      return { height: frame.readUInt16BE(at + 5), width: frame.readUInt16BE(at + 7) };
    }
  }
  return null;
}

function extension(file: string): string {
  return path.extname(file).slice(1).toLowerCase();
}

/** Video and GIF files under assets/, subfolders included; a link is not one, nor is anything under an assets/ link. */
async function videoAssets(dir: string): Promise<Clip[]> {
  const base = path.join(dir, 'assets');
  if (!(await fs.lstat(base).catch(() => null))?.isDirectory()) return [];
  const entries = await fs.readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
  const clips: Clip[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !Object.hasOwn(DEMUXERS, extension(entry.name))) continue;
    const file = path.join(entry.parentPath, entry.name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    const rel = path.relative(base, file).split(path.sep).join('/');
    clips.push({ rel, key: keyOf(rel, stat) });
  }
  return clips.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** A new key whenever the file is replaced, so a frame cached for the old file is never shown for the new one. */
function keyOf(rel: string, stat: Stats): string {
  const stem = slugify(path.basename(rel, path.extname(rel)), 'clip');
  return `${stem}-${shortHash(`${rel}\0${stat.size}\0${stat.mtimeMs}`)}`;
}

async function readInfo(dir: string, key: string): Promise<ClipInfo | null> {
  try {
    const text = await readFileNoFollow(dir, path.join(dir, 'clips', key, 'clip.json'), 'utf8');
    const { fps, frames, width, height, duration, audio } = JSON.parse(text) as ClipInfo;
    const numbers = [fps, frames, width, height, duration].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
    return numbers && typeof audio === 'boolean' ? { fps, frames, width, height, duration, audio } : null;
  } catch {
    return null;
  }
}

/** The names in clips/, none when it is missing or a link: nothing is ever listed or removed through one. */
async function clipFolders(dir: string): Promise<string[]> {
  const clips = path.join(dir, 'clips');
  if (!(await fs.lstat(clips).catch(() => null))?.isDirectory()) return [];
  return fs.readdir(clips).catch(() => []);
}

async function removeClipFolder(dir: string, name: string): Promise<void> {
  // ponytail: checked by lstat, then removed by path: a link swapped in between gets rm through it, on a key-named
  // folder only. A removal relative to an open folder closes that window.
  if ((await clipFolders(dir)).includes(name)) await removeTreeInside(path.join(dir, 'clips', name));
}

function lastLine(text: string): string | undefined {
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function spawnFfmpeg(bin: string): FfmpegRunner {
  return (args, input) => {
    // The input is fd 3, opened without following links: ffmpeg never gets a path.
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe', input.fd] });
    const exit = new Promise<number | null>((resolve, reject) => {
      proc.once('error', (e) => reject(new Error(m().media.ffmpegStart(bin, e.message))));
      proc.once('close', resolve);
    });
    // Awaited later, once the frames are read: a spawn error before then is not an unhandled rejection.
    exit.catch(() => undefined);
    return { stdout: proc.stdout as Readable, stderr: proc.stderr as Readable, exit, kill: () => void proc.kill('SIGKILL') };
  };
}
