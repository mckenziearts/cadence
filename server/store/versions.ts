import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ID_PATTERN,
  type ChatKey,
  type SceneVoiceOver,
  type VersionEntry,
  type VersionSource,
  type VoiceOverSettings,
} from '../../src/shared/types';
import type { BrandStore, ProjectStore, VersionStore } from '../contracts';
import { m } from '../i18n';
import { parseSceneVoiceOver, unknownSpeaker } from './projects';
import {
  HttpError,
  KeyedMutex,
  assertId,
  isResolverInput,
  nowIso,
  pathExists,
  readFileNoFollow,
  removeFileInside,
  resolveInside,
  sha256,
  writeFileAtomic,
  writeFileInside,
  writeJsonAtomic,
} from '../util';

const MAX_TRACKED_BYTES = 2 * 1024 * 1024;
const VERSION_ID = /^v\d{4,}$/;

type Manifest = Record<string, string>;
type SnapshotMeta = { label: string; source: VersionSource; chatKey?: ChatKey; costUsd?: number };

/**
 * Content-addressed project history in projects/<id>/.cadence/versions/:
 *   objects/<sha256>          file contents
 *   manifests/<version>.json  { relPath: sha256 } of the tracked files at that version
 *   index.json                VersionEntry[], oldest first
 * Tracked: project.json, art-direction.md, scenes/**, components/** (text files under 2 MB). Nothing is ever deleted.
 */
export class FileVersionStore implements VersionStore {
  private mutex = new KeyedMutex();

  constructor(
    private store: ProjectStore,
    private brands: BrandStore,
  ) {}

  /** Newest first. */
  async list(projectId: string, opts: { sceneId?: string } = {}): Promise<VersionEntry[]> {
    await this.requireProject(projectId);
    const index = await this.readIndex(projectId);
    const entries = opts.sceneId ? index.filter((e) => e.scenes.includes(opts.sceneId!)) : index;
    return entries.slice().reverse();
  }

  async snapshot(projectId: string, meta: SnapshotMeta): Promise<VersionEntry | null> {
    await this.requireProject(projectId);
    return this.mutex.run(projectId, () => this.record(projectId, meta, false));
  }

  async restore(projectId: string, versionId: string, opts: { sceneId?: string } = {}): Promise<VersionEntry> {
    await this.requireProject(projectId);
    // Project lock, then the versions mutex (the order of any caller snapshotting inside store.withLock): no edit can
    // land between the "unsaved changes" snapshot and the writes, where it would be overwritten unrecorded.
    const entry = await this.store.withLock(projectId, () =>
      this.mutex.run(projectId, async () => {
        const manifest = await this.manifestOf(projectId, versionId);
        const dir = this.store.dir(projectId);
        if (opts.sceneId) {
          const sceneId = assertId(opts.sceneId, m().api.ids.scene);
          const rel = `scenes/${sceneId}.tsx`;
          if (!manifest[rel]) throw new HttpError(404, m().api.versions.sceneMissing(sceneId, versionId));
          const current = await this.store.get(projectId);
          const scene = current.scenes.find((s) => s.id === sceneId);
          if (!scene) throw new HttpError(409, m().api.versions.sceneGone(sceneId));
          const then = manifest['project.json'] ? await this.readObject(projectId, manifest['project.json']) : null;
          // Only what the version says about the scene, and only what the store accepts today: the scene file is
          // already written back when the patch runs.
          const old = sceneFields(then).get(sceneId);
          const patch: { duration?: number; voiceOver?: SceneVoiceOver | null } = {};
          if (typeof old?.duration === 'number' && old.duration > 0 && old.duration !== scene.duration)
            patch.duration = old.duration;
          const voiceOver = old ? snapshotVoiceOver(old.voiceOver, current.voiceOver) : undefined;
          if (voiceOver !== undefined && JSON.stringify(voiceOver) !== JSON.stringify(scene.voiceOver ?? null)) {
            patch.voiceOver = voiceOver;
          }

          await refuseLinkedFolders(dir, rel);
          await this.record(projectId, { label: m().api.versions.unsaved, source: 'external' }, false);
          await writeFileInside(dir, path.join(dir, rel), await this.readObject(projectId, manifest[rel]));
          if (Object.keys(patch).length) await this.store.updateScene(projectId, sceneId, patch);
          return this.record(
            projectId,
            { label: m().api.versions.restoredScene(scene.name, versionId), source: 'restore' },
            true,
          );
        }

        // An imported version can name a brand that never travelled, or one removed here since.
        const brand = brandOf(manifest['project.json'] ? await this.readObject(projectId, manifest['project.json']) : null);
        if (brand !== null && !(await this.brands.exists(brand))) throw new HttpError(400, m().api.projects.unknownBrand(brand));

        const current = await readTracked(dir);
        const writes = Object.entries(manifest).filter(
          ([rel, hash]) => restorable(rel) && !(current.get(rel) && sha256(current.get(rel)!) === hash),
        );
        // Files created after that version; their content goes into the snapshot below.
        const removals = [...current.keys()].filter((rel) => !(rel in manifest));
        // All checked before the snapshot and the first write: a refused restore leaves the project and its history as
        // they were. The helpers below are the race-free guard; this check only makes the refusal clean.
        for (const rel of [...writes.map(([rel]) => rel), ...removals]) await refuseLinkedFolders(dir, rel);
        await this.record(projectId, { label: m().api.versions.unsaved, source: 'external' }, false);
        for (const [rel, hash] of writes)
          await writeFileInside(dir, resolveInside(dir, rel), await this.readObject(projectId, hash));
        for (const rel of removals) await removeFileInside(dir, resolveInside(dir, rel));
        return this.record(projectId, { label: m().api.versions.restored(versionId), source: 'restore' }, true);
      }),
    );
    await this.store.syncCode(projectId);
    this.store.events.emit('changed', projectId);
    return entry!;
  }

  async read(projectId: string, versionId: string, file: string): Promise<string | null> {
    await this.requireProject(projectId);
    const manifest = await this.manifestOf(projectId, versionId);
    const hash = manifest[path.posix.normalize(file.replaceAll('\\', '/'))];
    return hash ? (await this.readObject(projectId, hash)).toString('utf8') : null;
  }

  /** Snapshot under the project's mutex. Returns null when nothing changed, unless `force` (restores always record). */
  private async record(projectId: string, meta: SnapshotMeta, force: boolean): Promise<VersionEntry | null> {
    const files = await readTracked(this.store.dir(projectId));
    const manifest: Manifest = {};
    for (const rel of [...files.keys()].sort()) {
      const hash = sha256(files.get(rel)!);
      manifest[rel] = hash;
      const object = this.path(projectId, 'objects', hash);
      if (!(await pathExists(object))) await writeFileAtomic(object, files.get(rel)!);
    }
    const index = await this.readIndex(projectId);
    const last = index.at(-1);
    const previous = last ? await this.readManifest(projectId, last.id) : {};
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(manifest)])]
      .filter((rel) => previous[rel] !== manifest[rel])
      .sort();
    if (last && !changed.length && !force) return null;

    const entry: VersionEntry = {
      id: `v${String(index.length + 1).padStart(4, '0')}`,
      createdAt: nowIso(),
      label: meta.label.trim() || m().api.versions.untitled,
      source: meta.source,
      ...(meta.chatKey ? { chatKey: meta.chatKey } : {}),
      scenes: await this.changedScenes(projectId, changed, previous, files),
      files: changed,
      ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
    };
    await writeJsonAtomic(this.path(projectId, 'manifests', `${entry.id}.json`), manifest);
    await writeJsonAtomic(this.path(projectId, 'index.json'), [...index, entry]);
    this.store.events.emit('versions-changed', projectId);
    return entry;
  }

  /** Scenes whose file changed, plus scenes whose duration or voice-over changed (or that appeared or went) in project.json. */
  private async changedScenes(
    projectId: string,
    changed: string[],
    previous: Manifest,
    files: Map<string, Buffer>,
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const rel of changed) {
      const match = /^scenes\/([^/]+)\.tsx$/.exec(rel);
      if (match && ID_PATTERN.test(match[1])) ids.add(match[1]);
    }
    if (changed.includes('project.json')) {
      const a = sceneFields(previous['project.json'] ? await this.readObject(projectId, previous['project.json']) : null);
      const b = sceneFields(files.get('project.json') ?? null);
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        const [x, y] = [a.get(id), b.get(id)];
        if (!x || !y || x.duration !== y.duration || JSON.stringify(x.voiceOver ?? null) !== JSON.stringify(y.voiceOver ?? null))
          ids.add(id);
      }
    }
    return [...ids].sort();
  }

  private async manifestOf(projectId: string, versionId: string): Promise<Manifest> {
    const index = await this.readIndex(projectId);
    if (!index.some((e) => e.id === versionId)) throw new HttpError(404, m().api.versions.notFound(versionId));
    return this.readManifest(projectId, versionId);
  }

  private async readIndex(projectId: string): Promise<VersionEntry[]> {
    let text: string;
    try {
      text = await fs.readFile(this.path(projectId, 'index.json'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    // Never treat an unreadable index as empty: the next snapshot would overwrite existing manifests.
    try {
      const index = JSON.parse(text) as unknown;
      if (Array.isArray(index)) return index as VersionEntry[];
    } catch {
      // reported below
    }
    throw new HttpError(500, m().api.versions.unreadableIndex(`projects/${projectId}/.cadence/versions/index.json`));
  }

  private async readManifest(projectId: string, versionId: string): Promise<Manifest> {
    // The index of an imported project comes from an archive: its ids name files under manifests/.
    if (!VERSION_ID.test(versionId)) throw new HttpError(500, m().api.versions.unreadableManifest(versionId));
    try {
      return JSON.parse(await fs.readFile(this.path(projectId, 'manifests', `${versionId}.json`), 'utf8')) as Manifest;
    } catch {
      throw new HttpError(500, m().api.versions.unreadableManifest(versionId));
    }
  }

  private async readObject(projectId: string, hash: string): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(500, m().api.versions.invalidHash(hash));
    return fs.readFile(this.path(projectId, 'objects', hash)).catch(() => {
      throw new HttpError(500, m().api.versions.missingObject(hash));
    });
  }

  private path(projectId: string, ...parts: string[]): string {
    return path.join(this.store.dir(projectId), '.cadence', 'versions', ...parts);
  }

  private async requireProject(projectId: string): Promise<void> {
    if (!(await this.store.exists(projectId))) throw new HttpError(404, m().api.projectNotFound(projectId));
  }
}

/** Tracked files of a project folder, keyed by POSIX relative path. */
async function readTracked(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const candidates = ['project.json', 'art-direction.md'];
  for (const sub of ['scenes', 'components']) {
    // An agent turn can put a link where the folder should be: listing through it would version whatever it points to.
    if (!(await fs.lstat(path.join(dir, sub)).catch(() => null))?.isDirectory()) continue;
    const entries = await fs.readdir(path.join(dir, sub), { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.endsWith('.tmp'))
        candidates.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
    }
  }
  for (const rel of candidates) {
    const file = path.join(dir, rel);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size >= MAX_TRACKED_BYTES) continue;
    const data = await readFileNoFollow(dir, file);
    // Binary files (NUL bytes) are not versioned.
    if (!data.includes(0)) out.set(rel.split(path.sep).join('/'), data);
  }
  return out;
}

/**
 * A manifest path a restore writes: one readTracked can list, minus what the frame build refuses. The manifests of an
 * imported project come from an archive and may name any path, package.json or renders/ included.
 */
function restorable(rel: string): boolean {
  const [top, ...rest] = rel.split('/');
  if (!rest.length) return rel === 'project.json' || rel === 'art-direction.md';
  return (top === 'scenes' || top === 'components') && !rest.some((s) => s === '' || s.startsWith('.') || isResolverInput(s));
}

/**
 * A restore writes where a version says, through folders an agent turn can replace with a link to any folder the server
 * can write: a missing folder is fine (the write creates a real one), a link is refused.
 */
async function refuseLinkedFolders(dir: string, rel: string): Promise<void> {
  let folder = dir;
  for (const name of path.posix.dirname(rel).split('/')) {
    if (name === '.') return;
    folder = path.join(folder, name);
    const found = await fs.lstat(folder).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!found) return;
    if (!found.isDirectory()) throw new HttpError(409, m().api.versions.linkedFolder(rel));
  }
}

type SceneFields = { duration?: unknown; voiceOver?: unknown };

/** The brand a project.json snapshot names (null when it names none or cannot be read). */
function brandOf(data: Buffer | null): string | null {
  try {
    const brand = (JSON.parse(data?.toString('utf8') ?? 'null') as { brand?: unknown } | null)?.brand;
    return typeof brand === 'string' ? brand : null;
  } catch {
    return null;
  }
}

/** Each scene id with its duration and voice-over in a project.json snapshot (empty when absent or unreadable). */
function sceneFields(data: Buffer | null): Map<string, SceneFields> {
  try {
    const scenes = (JSON.parse(data?.toString('utf8') ?? 'null') as { scenes?: unknown } | null)?.scenes;
    return new Map(
      Array.isArray(scenes)
        ? scenes.map((s: { id?: string } & SceneFields) => [String(s?.id), { duration: s?.duration, voiceOver: s?.voiceOver }])
        : [],
    );
  } catch {
    return new Map();
  }
}

/**
 * A snapshot's voice-over as the store reads it today: null for none, undefined when it is no longer valid, lines
 * naming a speaker the project has since removed included.
 */
function snapshotVoiceOver(value: unknown, settings: VoiceOverSettings): SceneVoiceOver | null | undefined {
  if (value === undefined || value === null) return null;
  try {
    const voiceOver = parseSceneVoiceOver(value);
    return voiceOver?.lines && unknownSpeaker(settings, voiceOver.lines) ? undefined : voiceOver;
  } catch {
    return undefined;
  }
}
