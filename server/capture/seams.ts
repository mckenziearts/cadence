// Seam checks: the last frame of a scene against the first frame of the next one, pixel by pixel at full size. An
// invisible cut is 0 % of pixels differing (by more than about 2 levels on a channel). Results are cached per (run,
// code generation, both scenes' code and timing, format) in projects/<id>/.cadence/seams.json.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { FormatId, ProjectState, SceneState, SeamResult } from '../../src/shared/types';
import type { CaptureService, Hub, ProjectStore, SeamDetail, SeamService } from '../contracts';
import { m } from '../i18n';
import { HttpError, nowIso, writeJsonAtomic } from '../util';
import { sceneSignature } from './capture';

interface Entry {
  signature: string;
  result: SeamResult;
}

interface SeamsFile {
  /** 2: full-size strict comparison. Files of another version are ignored. */
  version: 2;
  entries: Record<string, Entry>;
}

/** Full size: at half size, 1 px moves and small glyph changes vanish. */
const SEAM_SCALE = 1;
/** Calm after the last edit of a project before its cuts are checked again. */
const RECHECK_MS = 1500;

export class PixelSeamService implements SeamService {
  /** Per project and `<from>|<to>|<format>`: the last result and what it was computed from. */
  private caches = new Map<string, Map<string, Entry>>();
  /** Code generations restart at 0 in every process: results cached by an earlier run must never match. */
  private readonly run = randomBytes(4).toString('hex');
  /** The re-check of each project, waiting for its edits to settle. */
  private rechecks = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: { store: ProjectStore; capture: CaptureService; hub: Hub }) {}

  async check(projectId: string, opts: { sceneId?: string; format?: FormatId } = {}): Promise<SeamResult[]> {
    const { store } = this.deps;
    await store.syncCode(projectId);
    const project = await store.get(projectId);
    if (opts.sceneId && !project.scenes.some((s) => s.id === opts.sceneId)) {
      throw new HttpError(404, m().media.sceneNotFound(opts.sceneId));
    }
    const cache = this.cache(projectId);
    const results: SeamResult[] = [];
    // Every format unless one is asked for: templates lay each format out on its own, so a cut can break in one only.
    for (const format of opts.format ? [opts.format] : project.formats) {
      for (let i = 0; i + 1 < project.scenes.length; i++) {
        const from = project.scenes[i];
        const to = project.scenes[i + 1];
        if (opts.sceneId && from.id !== opts.sceneId && to.id !== opts.sceneId) continue;
        const key = `${from.id}|${to.id}|${format}`;
        const signature = this.signature(project, from, to);
        const hit = cache.get(key);
        if (hit?.signature === signature) {
          results.push(hit.result);
          continue;
        }
        let entry: Entry;
        try {
          entry = { signature, result: (await this.compare(project, from, to, format)).result };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          // Shown, but checked again next time: a timeout or a crashed page may not happen again.
          const result = { from: from.id, to: to.id, format, diffPercent: 100, checkedAt: nowIso(), error: firstLine(e) };
          entry = { signature: '', result };
        }
        cache.set(key, entry);
        results.push(entry.result);
      }
    }
    await this.save(project, cache);
    return results;
  }

  /** A check per edit would capture the same cuts again for every edit of a burst. */
  recheck(projectId: string): void {
    clearTimeout(this.rechecks.get(projectId));
    const timer = setTimeout(() => {
      this.rechecks.delete(projectId);
      void this.check(projectId).catch(() => undefined);
    }, RECHECK_MS);
    // unref: a pending check never holds the process open once the server closes.
    this.rechecks.set(projectId, timer.unref());
  }

  async detail(projectId: string, from: string, to: string, format?: FormatId): Promise<SeamDetail> {
    const { store } = this.deps;
    await store.syncCode(projectId);
    const project = await store.get(projectId);
    const a = project.scenes.find((s) => s.id === from);
    const b = project.scenes.find((s) => s.id === to);
    if (!a || !b) throw new HttpError(404, m().media.sceneNotFound(a ? to : from));
    const { result, fromImage, toImage, diffImage } = await this.compare(project, a, b, format ?? project.formats[0], true);
    const cache = this.cache(projectId);
    cache.set(`${a.id}|${b.id}|${result.format}`, { signature: this.signature(project, a, b), result });
    await this.save(project, cache);
    return { result, fromImage, toImage, diffImage: diffImage! };
  }

  cached(projectId: string): SeamResult[] {
    return [...this.cache(projectId).values()].map((entry) => entry.result);
  }

  /** A cut looks the same as long as this run's code generation and both scenes' code and timing are unchanged. */
  private signature(project: ProjectState, from: SceneState, to: SceneState): string {
    return `g${this.run}.${project.codeGeneration}-${sceneSignature(project, from)}-${sceneSignature(project, to)}`;
  }

  /**
   * Last frame of `from` (t = duration) against the first frame of `to` (t = 0). The diff image costs more than both
   * decodes and the comparison together (about 70 ms per 1080p cut): only the seam dialog (`detail`) draws it.
   */
  private async compare(project: ProjectState, from: SceneState, to: SceneState, format: FormatId, drawDiff = false) {
    const shot = { format, scale: SEAM_SCALE, imageFormat: 'png' as const, captions: false };
    const [a] = await this.deps.capture.frames(project.id, { ...shot, sceneId: from.id, times: [from.duration] });
    const [b] = await this.deps.capture.frames(project.id, { ...shot, sceneId: to.id, times: [0] });
    const pa = PNG.sync.read(a.image);
    const pb = PNG.sync.read(b.image);
    const diff = drawDiff ? new PNG({ width: pa.width, height: pa.height }) : null;
    // Strict: about 2 levels on a channel, anti-aliased pixels included (a moved or re-weighted glyph is a real jump).
    const differing = pixelmatch(pa.data, pb.data, diff?.data, pa.width, pa.height, { threshold: 0.01, includeAA: true });
    const error = [...a.errors, ...b.errors][0];
    const result: SeamResult = {
      from: from.id,
      to: to.id,
      format,
      diffPercent: Math.round((differing / (pa.width * pa.height)) * 100_000) / 1000,
      checkedAt: nowIso(),
      ...(error ? { error: firstLine(error) } : {}),
    };
    return { result, fromImage: a.image, toImage: b.image, diffImage: diff && PNG.sync.write(diff) };
  }

  private cache(projectId: string): Map<string, Entry> {
    let cache = this.caches.get(projectId);
    if (!cache) {
      cache = new Map();
      try {
        const file = JSON.parse(readFileSync(seamsFile(this.deps.store.dir(projectId)), 'utf8')) as SeamsFile;
        // Results of another version were measured differently.
        if (file.version === 2) for (const [key, entry] of Object.entries(file.entries ?? {})) cache.set(key, entry);
      } catch {
        // no seams checked yet
      }
      this.caches.set(projectId, cache);
    }
    return cache;
  }

  /** Forget cuts and formats that no longer exist, persist, and tell the editor. */
  private async save(project: ProjectState, cache: Map<string, Entry>): Promise<void> {
    const cuts = new Set(project.scenes.slice(1).map((scene, i) => `${project.scenes[i].id}|${scene.id}`));
    for (const [key, { result }] of cache) {
      if (!cuts.has(`${result.from}|${result.to}`) || !project.formats.includes(result.format)) cache.delete(key);
    }
    const file: SeamsFile = { version: 2, entries: Object.fromEntries(cache) };
    await writeJsonAtomic(seamsFile(project.dir), file);
    this.deps.hub.send({ type: 'seams', projectId: project.id, results: this.cached(project.id) });
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0];
}

function seamsFile(projectDir: string): string {
  return path.join(projectDir, '.cadence', 'seams.json');
}
