// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  FORMAT_IDS,
  ID_PATTERN,
  isFormatId,
  type CreateProjectInput,
  type CreateSceneInput,
  type FormatId,
  type MusicGridData,
  type MusicSettings,
  type ProjectFile,
  type ProjectState,
  type ProjectSummary,
  type SceneFile,
  type SceneState,
  type SceneVoiceOver,
  type UpdateProjectInput,
  type VoiceOverSettings,
} from '../../src/shared/types';
import type { BrandStore, CadenceConfig, FileEvents, ProjectStore, TemplateStore, VoiceOverProvider } from '../contracts';
import { m } from '../i18n';
import {
  HttpError,
  KeyedMutex,
  assertId,
  isInside,
  nowIso,
  pathExists,
  roundMs,
  sha256,
  shortHash,
  slugify,
  uniqueId,
  writeFileAtomic,
  writeJsonAtomic,
} from '../util';
import { defaultVoiceOver } from '../voiceover/voices';
import { DEFAULT_BRAND, FileBrandStore } from './brands';
import { FileTemplateStore } from './templates';

const DEFAULT_TEMPO = 120;
const MIN_DURATION = 0.1;
const MAX_DURATION = 600;
const DEFAULT_SCENE_DURATION = 3;
const MAX_CODE_BYTES = 1024 * 1024;
const FPS_VALUES = [24, 30, 60];
const WATCH_DEBOUNCE_MS = 60;
const MAX_VOICE_OVER_CHARS = 2000;

const musicSchema = z.object({
  file: z
    .string()
    .min(1)
    .refine((f) => !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..'), { error: () => m().api.projects.relativePath }),
  start: z.number().min(0).default(0),
  volume: z.number().min(0).max(1).default(1),
  bpm: z.number().min(20).max(400).nullish(),
  beatsPerBar: z.literal([3, 4, 6]).optional(),
  barOffset: z.number().int().min(0).max(5).optional(),
  gridOffset: z.number().min(-0.25).max(0.25).optional(),
});

/** Ranges only: a voice this Cadence does not offer (a newer project) fails when spoken, not when read. */
const voiceOverSchema = z.object({
  voice: z.string().regex(/^[a-z]{2,3}_[A-Z]{2}-\w+-\w+$/),
  speed: z.number().min(0.5).max(2).default(1),
  musicLevel: z.number().min(0).max(1).default(0.3),
});

const sceneVoiceOverSchema = z.object({
  text: z.string().max(MAX_VOICE_OVER_CHARS),
  at: z.number().min(0).max(MAX_DURATION).default(0),
});

const projectFileSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().trim().min(1),
  brand: z.string().regex(ID_PATTERN).nullable().default(null),
  fps: z.literal([24, 30, 60]),
  formats: z.array(z.enum(FORMAT_IDS)).default([]),
  tempo: z.number().min(30).max(300).default(DEFAULT_TEMPO),
  language: z.enum(['fr', 'en']).nullable().default(null),
  scenes: z
    .array(
      z.object({
        id: z.string().regex(ID_PATTERN),
        name: z.string().optional(),
        duration: z.number().refine(Number.isFinite),
        template: z.string().nullish(),
        voiceOver: sceneVoiceOverSchema.optional(),
      }),
    )
    .default([]),
  music: musicSchema.nullable().default(null),
  voiceOver: voiceOverSchema.nullable().default(null),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

type CodeKind = 'code' | 'changed' | 'assets';

/**
 * Projects are plain folders under projects/ (see ARCHITECTURE.md "Project folder").
 * Extra events on `events` besides the contract's: 'versions-changed' (projectId, emitted by FileVersionStore) and
 * 'assets-changed' (projectId, files under assets/ changed on disk).
 */
export class FileProjectStore implements ProjectStore {
  readonly root: string;
  readonly events = new EventEmitter();
  private templates: TemplateStore;
  private brands: BrandStore;
  private mutex = new KeyedMutex();
  private codeMutex = new KeyedMutex();
  /** Project ids whose lock the current async context holds, so nested withLock calls don't deadlock. */
  private held = new AsyncLocalStorage<ReadonlySet<string>>();
  /** Project ids whose music grid is being resolved in the current async context (the provider may call get()). */
  private resolvingGrid = new AsyncLocalStorage<ReadonlySet<string>>();
  private generations = new Map<string, number>();
  private codeHashes = new Map<string, string>();
  private invalidate: (dirs: string[]) => void = () => undefined;
  private musicGrid: ((id: string) => Promise<MusicGridData | null>) | null = null;
  private voiceOver: VoiceOverProvider | null = null;
  private unwatch: (() => void) | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, Set<CodeKind>>();

  constructor(
    private config: CadenceConfig,
    deps: { templates: TemplateStore; brands: BrandStore } = {
      templates: new FileTemplateStore(config),
      brands: new FileBrandStore(config),
    },
  ) {
    this.root = config.projectsDir;
    this.templates = deps.templates;
    this.brands = deps.brands;
  }

  dir(id: string): string {
    return path.join(this.root, assertId(id, m().api.ids.project));
  }

  sceneFile(id: string, sceneId: string): string {
    return path.join(this.dir(id), 'scenes', `${assertId(sceneId, m().api.ids.scene)}.tsx`);
  }

  async exists(id: string): Promise<boolean> {
    return ID_PATTERN.test(id) && pathExists(path.join(this.root, id, 'project.json'));
  }

  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    assertId(id, m().api.ids.project);
    const held = this.held.getStore();
    if (held?.has(id)) return fn();
    // Re-entrancy follows the async context: work that `fn` starts without awaiting also skips the lock.
    return this.mutex.run(id, () => this.held.run(new Set([...(held ?? []), id]), fn));
  }

  setModuleInvalidator(fn: (dirs: string[]) => void): void {
    this.invalidate = fn;
  }

  setMusicGridProvider(fn: (id: string) => Promise<MusicGridData | null>): void {
    this.musicGrid = fn;
  }

  setVoiceOverProvider(fn: VoiceOverProvider): void {
    this.voiceOver = fn;
  }

  generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  // Reading

  async list(): Promise<ProjectSummary[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const out: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        const data = await this.read(entry.name);
        out.push({
          id: entry.name,
          name: data.name,
          brand: data.brand,
          formats: data.formats,
          sceneCount: data.scenes.length,
          duration: roundMs(data.scenes.reduce((sum, s) => sum + s.duration, 0)),
          updatedAt: data.updatedAt,
          cover: data.scenes[0]?.id ?? null,
        });
      } catch (e) {
        // A folder without project.json is not a project (yet); anything else deserves a warning.
        if (!(e instanceof HttpError && e.status === 404)) console.warn(m().api.projects.skipped((e as Error).message));
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ProjectState> {
    const data = await this.read(id);
    const dir = this.dir(id);
    await this.ensureCodeBaseline(id, data.brand);
    let start = 0;
    const scenes: SceneState[] = [];
    for (const [index, scene] of data.scenes.entries()) {
      const file = this.sceneFile(id, scene.id);
      const code = await fs.readFile(file).catch(() => null);
      scenes.push({
        ...scene,
        index,
        start: roundMs(start),
        file,
        url: `/@fs${file}`,
        codeVersion: code ? shortHash(code) : 'missing',
      });
      start += scene.duration;
    }
    return {
      id,
      dir,
      name: data.name,
      brand: data.brand,
      fps: data.fps,
      formats: data.formats,
      tempo: data.tempo,
      language: data.language ?? null,
      scenes,
      duration: roundMs(start),
      music: data.music,
      musicUrl: data.music ? `/api/projects/${id}/music/audio?file=${encodeURIComponent(data.music.file)}` : null,
      musicGrid: data.music ? await this.resolveMusicGrid(id) : null,
      ...(await this.resolveVoiceOver(id, data, scenes)),
      codeGeneration: this.generation(id),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }

  async readArtDirection(id: string): Promise<string> {
    await this.read(id);
    return fs.readFile(path.join(this.dir(id), 'art-direction.md'), 'utf8').catch(() => '');
  }

  // Projects

  async create(input: CreateProjectInput): Promise<ProjectState> {
    const name = requireName(input.name, 'project');
    const brand = input.brand ?? null;
    if (brand !== null && !(await this.brands.exists(brand))) throw new HttpError(400, m().api.projects.unknownBrand(brand));
    const formats = parseFormats(input.formats);
    const fps = parseFps(input.fps);
    const template = input.template ? await this.templates.projectTemplate(input.template) : null;
    const tempo = template?.bpm ?? DEFAULT_TEMPO;
    // Resolve every scene template before touching the disk, so a broken campaign template leaves nothing behind.
    const sceneSources = template
      ? await Promise.all(
          template.scenes.map(async (s) => ({ ...s, code: (await this.templates.sceneTemplate(s.template)).code })),
        )
      : null;

    await fs.mkdir(this.root, { recursive: true });
    const id =
      input.id !== undefined
        ? assertId(input.id, m().api.ids.project)
        : uniqueId(slugify(name, 'projet'), await fs.readdir(this.root));
    const dir = this.dir(id);
    try {
      await fs.mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, m().api.projects.exists(id));
      throw e;
    }

    const scenes: SceneFile[] = [];
    if (sceneSources) {
      for (const source of sceneSources) {
        const sceneId = uniqueId(
          slugify(source.name, 'scene'),
          scenes.map((s) => s.id),
        );
        scenes.push({
          id: sceneId,
          name: source.name,
          duration: clampDuration((source.bars * 240) / tempo),
          template: source.template,
        });
        await writeFileAtomic(this.sceneFile(id, sceneId), source.code);
      }
    } else {
      scenes.push({ id: 'titre', name: m().api.projects.starterScene, duration: clampDuration((2 * 240) / tempo) });
      await writeFileAtomic(this.sceneFile(id, 'titre'), starterScene(name));
    }
    await fs.mkdir(path.join(dir, 'components'), { recursive: true });
    await fs.mkdir(path.join(dir, 'assets', 'refs'), { recursive: true });
    const brandArt = await fs
      .readFile(path.join(this.brands.dir(brand ?? DEFAULT_BRAND), 'art-direction.md'), 'utf8')
      .catch(() => '');
    const artDirection = [brandArt.trim() || m().api.projects.artDirection.trim(), template?.artDirection?.trim()]
      .filter(Boolean)
      .join('\n\n');
    await writeFileAtomic(path.join(dir, 'art-direction.md'), `${artDirection}\n`);
    const now = nowIso();
    const project: ProjectFile = {
      version: 1,
      name,
      brand,
      fps,
      formats,
      tempo,
      ...(input.language ? { language: parseLanguage(input.language) } : {}),
      scenes,
      music: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.withLock(id, () => this.write(id, project));
    this.events.emit('list-changed');
    return this.get(id);
  }

  async update(id: string, patch: UpdateProjectInput): Promise<ProjectState> {
    const brand = patch.brand;
    if (brand !== undefined && brand !== null && !(await this.brands.exists(brand))) {
      throw new HttpError(400, m().api.projects.unknownBrand(brand));
    }
    const before = await this.mutate(id, (data) => {
      const previous = data.brand;
      if (patch.name !== undefined) data.name = requireName(patch.name, 'project');
      if (brand !== undefined) data.brand = brand;
      if (patch.formats !== undefined) data.formats = parseFormats(patch.formats);
      if (patch.fps !== undefined) data.fps = parseFps(patch.fps);
      if (patch.tempo !== undefined) data.tempo = parseTempo(patch.tempo);
      if (patch.language !== undefined) data.language = parseLanguage(patch.language);
      if (patch.voiceOver !== undefined) data.voiceOver = patch.voiceOver && parseVoiceOver(patch.voiceOver);
      return previous;
    });
    if (patch.name !== undefined || brand !== undefined || patch.formats !== undefined) this.events.emit('list-changed');
    // The brand's files are part of the project's code (frames import the kit), so a new brand is a code change.
    if (brand !== undefined && brand !== before) await this.syncCode(id);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.withLock(id, async () => {
      await this.read(id);
      const trash = path.join(this.root, '.trash');
      await fs.mkdir(trash, { recursive: true });
      await fs.rename(this.dir(id), path.join(trash, `${id}-${Date.now()}`));
    });
    this.events.emit('list-changed');
  }

  // Scenes

  async createScene(id: string, input: CreateSceneInput): Promise<SceneState> {
    const name = requireName(input.name, 'scene');
    let code = input.code;
    let template: { id: string; bars: number } | null = null;
    if (code === undefined && input.template) {
      const found = await this.templates.sceneTemplate(input.template);
      code = found.code;
      template = { id: found.meta.id, bars: found.meta.bars };
    }
    if (code !== undefined && Buffer.byteLength(code) > MAX_CODE_BYTES) {
      throw new HttpError(413, m().api.projects.codeTooLarge);
    }
    const duration = input.duration !== undefined ? parseDuration(input.duration) : null;

    let sceneId = '';
    await this.mutate(id, async (data) => {
      const after = input.after ?? null;
      const at = after === null ? data.scenes.length : data.scenes.findIndex((s) => s.id === after) + 1;
      if (at === 0) throw new HttpError(404, m().api.sceneNotFound(String(after)));
      // Never overwrite a file already in scenes/, even one project.json does not list. Nor reuse a deleted scene's id:
      // its chat (and Claude session) and its version history would come back with it.
      const list = (sub: string) => fs.readdir(path.join(this.dir(id), sub)).catch(() => [] as string[]);
      const [files, chats, trashed] = await Promise.all([list('scenes'), list('.cadence/chats'), list('.cadence/trash')]);
      const taken = [
        ...data.scenes.map((s) => s.id),
        ...files.filter((f) => f.endsWith('.tsx')).map((f) => f.slice(0, -4)),
        ...chats.flatMap((f) => /^scene-(.+)\.json$/.exec(f)?.[1] ?? []),
        ...trashed.flatMap((f) => /^(.+)-\d+\.tsx$/.exec(f)?.[1] ?? []),
      ];
      sceneId = uniqueId(slugify(name, 'scene'), taken);
      const seconds = duration ?? clampDuration(template ? (template.bars * 240) / data.tempo : DEFAULT_SCENE_DURATION);
      await writeFileAtomic(this.sceneFile(id, sceneId), code ?? blankScene(name));
      data.scenes.splice(at, 0, { id: sceneId, name, duration: seconds, ...(template ? { template: template.id } : {}) });
    });
    await this.syncCode(id);
    return this.sceneState(id, sceneId);
  }

  async updateScene(
    id: string,
    sceneId: string,
    patch: { name?: string; duration?: number; voiceOver?: SceneVoiceOver | null },
  ): Promise<ProjectState> {
    await this.mutate(id, (data) => {
      const scene = requireScene(data, sceneId);
      if (patch.name !== undefined) scene.name = requireName(patch.name, 'scene');
      if (patch.duration !== undefined) scene.duration = parseDuration(patch.duration);
      if (patch.voiceOver !== undefined) {
        const voiceOver = patch.voiceOver && parseSceneVoiceOver(patch.voiceOver);
        if (voiceOver) scene.voiceOver = voiceOver;
        else delete scene.voiceOver;
      }
    });
    return this.get(id);
  }

  async duplicateScene(id: string, sceneId: string): Promise<SceneState> {
    const scene = requireScene(await this.read(id), sceneId);
    const code = await fs.readFile(this.sceneFile(id, sceneId), 'utf8').catch(() => {
      throw new HttpError(404, m().api.projects.sceneFileNotFound(`scenes/${sceneId}.tsx`));
    });
    return this.createScene(id, {
      name: m().api.projects.copy(scene.name.slice(0, 110)),
      after: sceneId,
      duration: scene.duration,
      code,
    });
  }

  async deleteScene(id: string, sceneId: string): Promise<ProjectState> {
    await this.mutate(id, async (data) => {
      requireScene(data, sceneId);
      if (data.scenes.length === 1) throw new HttpError(400, m().api.projects.lastScene);
      data.scenes = data.scenes.filter((s) => s.id !== sceneId);
    });
    // After project.json no longer lists it: a failed move leaves an unused file, never a missing one.
    const file = this.sceneFile(id, sceneId);
    if (await pathExists(file)) {
      const trash = path.join(this.dir(id), '.cadence', 'trash');
      await fs.mkdir(trash, { recursive: true });
      await fs.rename(file, path.join(trash, `${sceneId}-${Date.now()}.tsx`));
    }
    await this.syncCode(id);
    return this.get(id);
  }

  async reorderScenes(id: string, sceneIds: string[]): Promise<ProjectState> {
    await this.mutate(id, (data) => {
      const byId = new Map(data.scenes.map((s) => [s.id, s]));
      const next = sceneIds.map((sid) => byId.get(sid));
      if (next.length !== data.scenes.length || new Set(sceneIds).size !== sceneIds.length || next.some((s) => !s)) {
        throw new HttpError(400, m().api.projects.order);
      }
      data.scenes = next as SceneFile[];
    });
    return this.get(id);
  }

  async setDurations(id: string, durations: Record<string, number>): Promise<ProjectState> {
    await this.mutate(id, (data) => {
      for (const [sceneId, seconds] of Object.entries(durations)) requireScene(data, sceneId).duration = parseDuration(seconds);
    });
    return this.get(id);
  }

  async setMusic(id: string, music: MusicSettings | null): Promise<ProjectState> {
    let value: MusicSettings | null = null;
    if (music !== null) {
      const parsed = musicSchema.safeParse(music);
      if (!parsed.success) throw new HttpError(400, m().api.projects.music(formatIssues(parsed.error)));
      value = { ...parsed.data, start: roundMs(parsed.data.start) };
    }
    await this.mutate(id, (data) => {
      data.music = value;
    });
    return this.get(id);
  }

  async writeArtDirection(id: string, text: string): Promise<void> {
    await this.withLock(id, async () => {
      await this.read(id);
      await writeFileAtomic(path.join(this.dir(id), 'art-direction.md'), text);
    });
    this.events.emit('changed', id);
  }

  // Code changes

  async syncCode(id: string): Promise<boolean> {
    return this.codeMutex.run(id, async () => {
      const data = await this.read(id);
      const hash = await this.codeHash(id, data.brand);
      const previous = this.codeHashes.get(id);
      this.codeHashes.set(id, hash);
      // Nothing was handed out before the first hash, so there is nothing to reload.
      if (previous === undefined || previous === hash) return false;
      this.invalidate([this.dir(id), this.brands.dir(data.brand ?? DEFAULT_BRAND)]);
      const generation = this.generation(id) + 1;
      this.generations.set(id, generation);
      this.events.emit('code-changed', id, generation);
      this.events.emit('changed', id);
      return true;
    });
  }

  watch(files: FileEvents): void {
    if (this.unwatch) return;
    const onFile = (_event: string, file: string) => {
      if (isInside(this.root, file)) this.onProjectFile(path.relative(this.root, file));
      else if (isInside(this.config.brandsDir, file)) this.onBrandFile(path.relative(this.config.brandsDir, file));
    };
    files.on('all', onFile);
    this.unwatch = () => files.off('all', onFile);
  }

  close(): void {
    this.unwatch?.();
    this.unwatch = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  // Internals

  /** Read and validate project.json. */
  private async read(id: string): Promise<ProjectFile> {
    const file = path.join(this.dir(id), 'project.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, m().api.projectNotFound(id));
      throw new HttpError(500, m().api.unreadableFile(`projects/${id}/project.json`, (e as Error).message));
    }
    const parsed = projectFileSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(500, m().api.invalidFile(`projects/${id}/project.json`, formatIssues(parsed.error)));
    const data = parsed.data;
    const ids = new Set<string>();
    for (const scene of data.scenes) {
      if (ids.has(scene.id)) {
        throw new HttpError(500, m().api.invalidFile(`projects/${id}/project.json`, m().api.projects.duplicateScene(scene.id)));
      }
      ids.add(scene.id);
    }
    const stamp = data.createdAt && data.updatedAt ? null : (await fs.stat(file)).mtime.toISOString();
    return {
      version: 1,
      name: data.name,
      brand: data.brand,
      fps: data.fps,
      formats: data.formats.length ? [...new Set(data.formats)] : ['16:9'],
      tempo: data.tempo,
      ...(data.language ? { language: data.language } : {}),
      scenes: data.scenes.map((s) => ({
        id: s.id,
        name: s.name?.trim() || s.id,
        duration: clampDuration(s.duration),
        ...(s.template ? { template: s.template } : {}),
        ...(s.voiceOver?.text.trim() ? { voiceOver: { text: s.voiceOver.text, at: s.voiceOver.at } } : {}),
      })),
      music: data.music ? { ...data.music, start: roundMs(data.music.start) } : null,
      ...(data.voiceOver ? { voiceOver: data.voiceOver } : {}),
      createdAt: data.createdAt ?? stamp!,
      updatedAt: data.updatedAt ?? stamp!,
    };
  }

  private async write(id: string, data: ProjectFile): Promise<void> {
    await writeJsonAtomic(path.join(this.dir(id), 'project.json'), data);
  }

  /** Read-modify-write project.json under the project lock, then emit 'changed'. Returns what `fn` returns. */
  private async mutate<T>(id: string, fn: (data: ProjectFile) => T | Promise<T>): Promise<T> {
    const result = await this.withLock(id, async () => {
      const data = await this.read(id);
      const value = await fn(data);
      data.updatedAt = nowIso();
      await this.write(id, data);
      return value;
    });
    this.events.emit('changed', id);
    return result;
  }

  private async sceneState(id: string, sceneId: string): Promise<SceneState> {
    const scene = (await this.get(id)).scenes.find((s) => s.id === sceneId);
    if (!scene) throw new HttpError(404, m().api.sceneNotFound(sceneId));
    return scene;
  }

  private async resolveMusicGrid(id: string): Promise<MusicGridData | null> {
    const resolving = this.resolvingGrid.getStore();
    // The provider (music service) may itself call get(id): answer that nested call without a grid.
    if (!this.musicGrid || resolving?.has(id)) return null;
    const provider = this.musicGrid;
    try {
      return await this.resolvingGrid.run(new Set([...(resolving ?? []), id]), () => provider(id));
    } catch (e) {
      console.warn(m().api.projects.musicGrid(id, (e as Error).message));
      return null;
    }
  }

  private async resolveVoiceOver(id: string, data: ProjectFile, scenes: SceneState[]) {
    const none = {
      voiceOver: data.voiceOver ?? defaultVoiceOver(data.language ?? 'fr'),
      voiceOverUrl: null,
      voiceOverLines: [],
      voiceOverPending: [],
      voiceOverError: null,
    };
    if (!this.voiceOver) return none;
    try {
      return await this.voiceOver(id, data, scenes);
    } catch (e) {
      console.warn(m().api.projects.voiceOver(id, (e as Error).message));
      return none;
    }
  }

  private async ensureCodeBaseline(id: string, brand: string | null): Promise<void> {
    if (this.codeHashes.has(id)) return;
    const hash = await this.codeHash(id, brand);
    if (!this.codeHashes.has(id)) this.codeHashes.set(id, hash);
  }

  /** Content hash of scenes/**, components/** and the brand folder (what frames import). */
  private async codeHash(id: string, brand: string | null): Promise<string> {
    const brandId = brand ?? DEFAULT_BRAND;
    const dir = this.dir(id);
    const roots: [string, string][] = [
      ['scenes', path.join(dir, 'scenes')],
      ['components', path.join(dir, 'components')],
      [`brand:${brandId}`, this.brands.dir(brandId)],
    ];
    const lines: string[] = [];
    for (const [label, base] of roots) {
      const entries = await fs.readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || isScratchFile(entry.name)) continue;
        const file = path.join(entry.parentPath, entry.name);
        const content = await fs.readFile(file).catch(() => null);
        if (content) lines.push(`${label}/${path.relative(base, file)}\0${sha256(content)}`);
      }
    }
    return sha256(`${brandId}\n${lines.sort().join('\n')}`);
  }

  private onProjectFile(name: string): void {
    const parts = name.split(path.sep);
    const id = parts[0];
    if (!ID_PATTERN.test(id)) return;
    if (parts.length === 1) return this.debounce('list', () => void this.events.emit('list-changed'));
    const top = parts[1];
    if (isScratchFile(parts[parts.length - 1])) return;
    const kind: CodeKind | null =
      top === 'scenes' || top === 'components'
        ? 'code'
        : top === 'assets'
          ? 'assets'
          : top === 'project.json' || top === 'art-direction.md'
            ? 'changed'
            : null;
    if (!kind) return;
    const kinds = this.pending.get(id) ?? new Set<CodeKind>();
    kinds.add(kind);
    this.pending.set(id, kinds);
    this.debounce(`project:${id}`, () => {
      const due = this.pending.get(id) ?? new Set<CodeKind>();
      this.pending.delete(id);
      if (due.has('code')) this.syncCode(id).catch(warnSync(id));
      if (due.has('changed')) this.events.emit('changed', id);
      if (due.has('assets')) this.events.emit('assets-changed', id);
    });
  }

  private onBrandFile(name: string): void {
    const parts = name.split(path.sep);
    const brand = parts[0];
    if (!ID_PATTERN.test(brand) || isScratchFile(parts[parts.length - 1])) return;
    if (parts.length === 1) this.debounce('list', () => void this.events.emit('list-changed'));
    this.debounce(`brand:${brand}`, async () => {
      for (const project of await this.list()) {
        if ((project.brand ?? DEFAULT_BRAND) === brand) await this.syncCode(project.id).catch(warnSync(project.id));
      }
    });
  }

  private debounce(key: string, fn: () => void | Promise<void>): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void Promise.resolve()
          .then(fn)
          .catch((e: Error) => console.warn(`[cadence] ${e.message}`));
      }, WATCH_DEBOUNCE_MS),
    );
  }
}

function warnSync(id: string) {
  return (e: Error) => {
    if (e instanceof HttpError && e.status === 404) return;
    console.warn(m().api.projects.reload(id, e.message));
  };
}

/** Temp files of atomic writes, editor backups and OS metadata never count as code. */
function isScratchFile(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('~');
}

function requireName(value: unknown, kind: 'project' | 'scene'): string {
  const name = typeof value === 'string' ? value.trim() : '';
  const what = m().api.projects.names[kind];
  if (!name) throw new HttpError(400, m().api.projects.nameRequired(what));
  if (name.length > 120) throw new HttpError(400, m().api.projects.nameTooLong(what));
  return name;
}

function requireScene(data: ProjectFile, sceneId: string): SceneFile {
  const scene = data.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new HttpError(404, m().api.sceneNotFound(sceneId));
  return scene;
}

function parseFormats(value: unknown): FormatId[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, m().api.projects.pickFormat);
  for (const format of value) if (!isFormatId(format)) throw new HttpError(400, m().api.unknownFormat(format));
  return [...new Set(value as FormatId[])];
}

function parseFps(value: unknown): number {
  if (!FPS_VALUES.includes(value as number)) throw new HttpError(400, m().api.projects.fps(value));
  return value as number;
}

function parseLanguage(value: unknown): 'fr' | 'en' | null {
  if (value === null || value === 'fr' || value === 'en') return value;
  throw new HttpError(400, m().api.projects.language(value));
}

function parseTempo(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 30 || value > 300) {
    throw new HttpError(400, m().api.projects.tempo(value));
  }
  return Math.round(value * 100) / 100;
}

function parseVoiceOver(value: unknown): VoiceOverSettings {
  const parsed = voiceOverSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, m().api.projects.voiceOverSettings(formatIssues(parsed.error)));
  return parsed.data;
}

/** null for a blank text: the scene has no voice-over. */
export function parseSceneVoiceOver(value: unknown): SceneVoiceOver | null {
  const parsed = sceneVoiceOverSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, m().api.projects.sceneVoiceOver(formatIssues(parsed.error)));
  const text = parsed.data.text.trim();
  return text ? { text, at: roundMs(parsed.data.at) } : null;
}

/** Durations from users and the agent: positive seconds, clamped to 0.1-600 and rounded to the millisecond. */
function parseDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new HttpError(400, m().api.projects.duration(value));
  return clampDuration(value);
}

function clampDuration(seconds: number): number {
  return roundMs(Math.min(MAX_DURATION, Math.max(MIN_DURATION, seconds)));
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || m().api.projects.root} (${i.message})`).join(', ');
}

/** The one scene of a new project without a campaign template: a branded title card, a pure function of t. */
function starterScene(title: string): string {
  return `import { Fill, ease, progress, useBrand, useFormat, type SceneProps } from 'cadence';

// On-screen copy: edit it here.
const COPY = {
  title: ${JSON.stringify(title)},
};

export default function Title({ t, duration }: SceneProps) {
  const { colors, fonts, tagline, Logo } = useBrand();
  const { pick } = useFormat();
  const logo = progress(t, 0.1, 0.9, ease.outExpo);
  const title = progress(t, 0.3, 1.2, ease.outExpo);
  const line = progress(t, 0.55, 1.45, ease.outExpo);
  // Ends on the plain background, so the next scene can start from it with an invisible cut.
  const exit = progress(t, duration - 0.35, duration, ease.inCubic);
  return (
    <Fill
      style={{
        background: colors.background,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: pick({ landscape: 40, portrait: 48, square: 40 }),
      }}
    >
      <div style={{ opacity: logo * (1 - exit), transform: \`translateY(\${(1 - logo) * 24}px) scale(\${0.92 + 0.08 * logo})\` }}>
        <Logo variant="mark" height={pick({ landscape: 96, portrait: 120, square: 104 })} />
      </div>
      <div style={{ overflow: 'hidden', maxWidth: '84%', paddingBottom: '0.08em' }}>
        <div
          style={{
            fontFamily: fonts.display,
            fontSize: pick({ landscape: 132, portrait: 112, square: 116 }),
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1.02,
            textAlign: 'center',
            color: colors.ink,
            opacity: 1 - exit,
            transform: \`translateY(\${(1 - title) * 110}%)\`,
          }}
        >
          {COPY.title}
        </div>
      </div>
      <div
        style={{
          fontFamily: fonts.body,
          fontSize: pick({ landscape: 34, portrait: 40, square: 36 }),
          color: colors.muted,
          opacity: line * (1 - exit),
          transform: \`translateY(\${(1 - line) * 16}px)\`,
        }}
      >
        {tagline}
      </div>
    </Fill>
  );
}
`;
}

/** Placeholder for a scene created without template or code: the chat fills it in. */
function blankScene(name: string): string {
  return `import { Fill, useBrand } from 'cadence';

// New scene: describe what it should show in its chat.
export default function Scene() {
  const { colors, fonts } = useBrand();
  return (
    <Fill style={{ background: colors.background, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: fonts.display, fontSize: 64, fontWeight: 600, letterSpacing: '-0.03em', color: colors.muted }}>
        {${JSON.stringify(name)}}
      </div>
    </Fill>
  );
}
`;
}
