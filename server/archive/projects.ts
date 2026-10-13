// Project archives: one .tar.gz holding projects and the brands they use, to move them to another installation
// (see ARCHITECTURE.md "Project archives").
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline, type Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { z } from 'zod';
import { ID_PATTERN, type ArchiveManifest, type ImportReport } from '../../src/shared/types';
import { brandProblems } from '../brands/check';
import type { BrandStore, CadenceConfig, ProjectArchives, ProjectStore } from '../contracts';
import { m } from '../i18n';
import { BUILDING_MARKER, DEFAULT_BRAND } from '../store/brands';
import { formatIssues, projectFileSchema } from '../store/projects';
import { cssCodeOffenders } from '../frames/vite';
import { CssCodeScan, HttpError, KeyedMutex, isInside, isResolverInput, pathExists } from '../util';
import { readTar, writeTar, type TarEntry, type TarFile } from './tar';

/** The .cadence/ folders that are the project's history; the rest of .cadence/ is cache or tied to this machine. */
const TRAVELLING_STATE = new Set(['chats', 'versions', 'voice-over']);
/** Never travels: the frame build refuses node_modules and package.json under a project or a brand (see frames/vite.ts). */
const local = (segment: string) => segment.startsWith('.') || isResolverInput(segment);

/**
 * A project file that goes into an archive. renders/ stays (videos are made again from the code), and so does
 * tsconfig.json: its `extends` points into this installation and would break Vite on another one.
 */
export function exportableProjectPath(rel: string): boolean {
  const segments = rel.split('/');
  if (segments[0] === '.cadence') {
    return segments.length > 2 && TRAVELLING_STATE.has(segments[1]) && !segments.slice(1).some(local);
  }
  return segments[0] !== 'renders' && rel !== 'tsconfig.json' && !segments.some(local);
}

/** A brand file that goes into an archive (the `.building` marker is a dotfile). */
export function exportableBrandPath(rel: string): boolean {
  return !rel.split('/').some(local);
}

const GiB = 1024 ** 3;
/** Unpacked bytes and entries of one import, and the size of any file read whole (see READ_WHOLE). */
const IMPORT_LIMITS = { maxBytes: 4 * GiB, maxEntries: 100_000, maxBuffered: 10 * 1024 ** 2 };
/** A staging folder left this long by a crashed import is removed by the next one. */
const STALE_STAGING_MS = 3_600_000;
const STAGING = '.import';
/** Files the server reads whole (project.json, stylesheets, scenes): only media may exceed `maxBuffered`. */
const READ_WHOLE = /\.(css|json|md|[cm]?[jt]sx?)$/i;
/** T1 caps, which answer 413 instead of 400. */
const OVER_CAP = /is over \d+ bytes|more than \d+ entries/;

const idSchema = z.string().regex(ID_PATTERN);
const manifestSchema = z.object({
  format: z.literal(1),
  createdWith: z.string(),
  projects: z.array(idSchema),
  brands: z.array(idSchema),
});

/** A folder is entered when a file inside it could travel. */
const enterProjectFolder = (rel: string) => rel === '.cadence' || exportableProjectPath(`${rel}/-`);

export class ProjectArchiver implements ProjectArchives {
  /** Imports check and move one at a time, so a brand folder another import has just claimed is already a brand. */
  private moves = new KeyedMutex();
  /** The staging folders of this process's imports, never stale however long their upload or their turn takes. */
  private live = new Set<string>();

  constructor(private readonly deps: { config: CadenceConfig; store: ProjectStore; brands: BrandStore }) {}

  private get stagingRoots(): string[] {
    return [path.join(this.deps.config.projectsDir, STAGING), path.join(this.deps.config.brandsDir, STAGING)];
  }

  /**
   * Removes the staging folders older than an hour, left by a crash: the frame build scans them with the rest of the
   * managed folders. A younger one may be an import of another Cadence process, still running.
   */
  async sweep(): Promise<void> {
    await Promise.all(this.stagingRoots.map((root) => removeStale(root, this.live)));
  }

  async export(ids?: string[]): Promise<Readable> {
    const { config, store, brands } = this.deps;
    const listed = new Map((await store.list()).map((project) => [project.id, project.brand]));
    // list() leaves out, with a warning, a project whose project.json cannot be read: an export without it would lose
    // it in silence. A linked folder is not a Dirent directory, so it stays unknown (404) and is never walked.
    const folders = await fs.readdir(config.projectsDir, { withFileTypes: true }).catch(() => []);
    const unreadable: string[] = [];
    for (const folder of folders) {
      if (!folder.isDirectory() || listed.has(folder.name) || (ids && !ids.includes(folder.name))) continue;
      if (await store.exists(folder.name)) unreadable.push(folder.name);
    }
    if (unreadable.length) throw new HttpError(409, m().api.archives.projectUnreadable(unreadable.sort().join(', ')));
    for (const id of ids ?? []) if (!listed.has(id)) throw new HttpError(404, m().api.projectNotFound(id));
    const projects = [...new Set(ids ?? listed.keys())].sort();
    const used = projects.map((id) => listed.get(id) ?? null);
    const brandIds = [...new Set(used)].filter((brand): brand is string => brand !== null && brand !== DEFAULT_BRAND).sort();
    for (const brand of brandIds) {
      if (!(await brands.exists(brand))) throw new HttpError(409, m().api.archives.brandMissing(brand));
      if (!(await fs.lstat(brands.dir(brand))).isDirectory()) throw new HttpError(409, m().api.archives.brandLinked(brand));
    }
    const { version } = JSON.parse(await fs.readFile(path.join(config.root, 'package.json'), 'utf8')) as { version: string };
    const manifest: ArchiveManifest = { format: 1, createdWith: version, projects, brands: brandIds };

    async function* entries(): AsyncGenerator<TarEntry> {
      yield { path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
      for (const id of projects) yield* files(store.dir(id), `projects/${id}`, exportableProjectPath, enterProjectFolder);
      for (const id of brandIds) yield* files(brands.dir(id), `brands/${id}`, exportableBrandPath, exportableBrandPath);
    }
    // Unlike `pipe`, an error in the tar stream also ends the gzip stream, so the download stops instead of hanging.
    // Level 1: media files, most of the bytes, barely compress, so higher levels cost CPU for almost no size.
    return pipeline(writeTar(entries()), createGzip({ level: 1 }), () => undefined);
  }

  async import(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<ImportReport> {
    const t = m().api.archives;
    await this.sweep();
    // Next to the targets, on the same volume: moving a checked folder in is one rename.
    const uuid = randomUUID();
    const [projectStage, brandStage] = this.stagingRoots.map((root) => path.join(root, uuid));
    this.live.add(uuid);
    try {
      await Promise.all([projectStage, brandStage].map((dir) => fs.mkdir(dir, { recursive: true })));
      let manifest: z.infer<typeof manifestSchema> | undefined;
      // Looked up for each of up to 100 000 entries.
      let listed = { projects: new Set<string>(), brands: new Set<string>() };
      const folders = new Set<string>();
      let archiveHasCadence = false;
      try {
        await readTar(
          pipeline(body, createGunzip(), () => undefined),
          {
            ...IMPORT_LIMITS,
            onFile: async (file) => {
              if (!manifest) {
                manifest = await readManifest(file);
                listed = { projects: new Set(manifest.projects), brands: new Set(manifest.brands) };
                return;
              }
              const [top, id, ...rest] = file.path.split('/');
              const rel = rest.join('/');
              if (top === 'brands' && id === DEFAULT_BRAND && rel) {
                // Every installation has its own cadence brand: the archive's copy is never read.
                archiveHasCadence = true;
              } else if (top === 'projects' && rel && listed.projects.has(id)) {
                if (exportableProjectPath(rel)) await stage(file, path.join(projectStage, id, rel), folders);
              } else if (top === 'brands' && rel && listed.brands.has(id)) {
                if (exportableBrandPath(rel)) await stage(file, path.join(brandStage, id, rel), folders);
              } else {
                throw new HttpError(400, t.unexpectedEntry(file.path));
              }
            },
          },
        );
      } catch (e) {
        throw archiveError(e);
      }
      if (!manifest) throw new HttpError(400, t.manifestFirst);
      const checked = manifest;
      return await this.moves.run('import', () => this.checkAndMove(checked, archiveHasCadence, projectStage, brandStage));
    } finally {
      await Promise.all([projectStage, brandStage].map((dir) => fs.rm(dir, { recursive: true, force: true })));
      this.live.delete(uuid);
    }
  }

  private async checkAndMove(
    manifest: z.infer<typeof manifestSchema>,
    archiveHasCadence: boolean,
    projectStage: string,
    brandStage: string,
  ): Promise<ImportReport> {
    const { config, store, brands } = this.deps;
    const t = m().api.archives;
    // What the frame build would refuse once moved in, such as an @import of a file that is not a stylesheet, read from
    // where each folder lands.
    const [offender] = await cssCodeOffenders([projectStage, brandStage], config.brandsDir, [
      [projectStage, config.projectsDir],
      [brandStage, config.brandsDir],
    ]);
    if (offender) {
      const [stage, top] = isInside(projectStage, offender) ? [projectStage, 'projects'] : [brandStage, 'brands'];
      throw new HttpError(400, t.cssImport(`${top}/${path.relative(stage, offender).split(path.sep).join('/')}`));
    }
    const archiveBrands = manifest.brands.filter((id) => id !== DEFAULT_BRAND);
    const building = (id: string) => pathExists(path.join(brands.dir(id), BUILDING_MARKER));
    for (const id of archiveBrands) {
      if (await building(id)) throw new HttpError(409, t.brandBuilding(id));
      if (await brands.exists(id)) continue;
      // BrandStore.adopt only moves into a folder it creates: refused here, before any brand moves.
      if (await fs.lstat(brands.dir(id)).catch(() => null)) throw new HttpError(409, t.brandFolderTaken(id));
      const problems = await brandProblems(path.join(brandStage, id), config.root);
      if (problems.length) throw new HttpError(400, t.brandIncomplete(id, problems.join(' ; ')));
    }
    const names = new Map<string, string>();
    for (const id of manifest.projects) {
      const raw = await fs.readFile(path.join(projectStage, id, 'project.json'), 'utf8').catch(() => null);
      if (raw === null) throw new HttpError(400, t.projectMissing(id));
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        throw new HttpError(400, t.projectInvalid(id, (e as Error).message));
      }
      const parsed = projectFileSchema.safeParse(json);
      if (!parsed.success) throw new HttpError(400, t.projectInvalid(id, formatIssues(parsed.error)));
      const brand = parsed.data.brand ?? DEFAULT_BRAND;
      if (brand !== DEFAULT_BRAND && !archiveBrands.includes(brand)) {
        if (await building(brand)) throw new HttpError(409, t.brandBuilding(brand));
        if (!(await brands.exists(brand))) throw new HttpError(400, t.brandUnavailable(brand, id));
      }
      names.set(id, parsed.data.name);
      // An archive holds no folders: these are the empty ones a new project starts with.
      for (const folder of ['components', 'assets/refs']) {
        await fs.mkdir(path.join(projectStage, id, folder), { recursive: true }).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'EEXIST' || e.code === 'ENOTDIR') throw new HttpError(400, t.collision(`projects/${id}/${folder}`));
          throw e;
        });
      }
    }

    // Brands first: a project never lands before the brand its scenes import.
    const report: ImportReport = { projects: [], brands: { installed: [], reused: [] } };
    if (archiveHasCadence || manifest.brands.includes(DEFAULT_BRAND)) report.brands.reused.push(DEFAULT_BRAND);
    for (const id of archiveBrands) report.brands[await brands.adopt(path.join(brandStage, id), id)].push(id);
    report.brands.installed.sort();
    report.brands.reused.sort();
    for (const id of manifest.projects) {
      report.projects.push({ from: id, id: await store.adopt(path.join(projectStage, id), id), name: names.get(id)! });
    }
    return report;
  }
}

async function readManifest(file: TarFile): Promise<z.infer<typeof manifestSchema>> {
  const t = m().api.archives;
  if (file.path !== 'manifest.json') throw new HttpError(400, t.manifestFirst);
  let json: { format?: unknown; createdWith?: unknown };
  try {
    json = JSON.parse((await file.buffer()).toString('utf8')) as typeof json;
  } catch (e) {
    if (e instanceof SyntaxError) throw new HttpError(400, t.manifestInvalid(e.message));
    throw e;
  }
  if (typeof json?.format === 'number' && json.format > 1) throw new HttpError(400, t.newerFormat(String(json.createdWith)));
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, t.manifestInvalid(formatIssues(parsed.error)));
  const { projects, brands } = parsed.data;
  return { ...parsed.data, projects: [...new Set(projects)], brands: [...new Set(brands)] };
}

/**
 * Writes one archive file under the staging folder, never over another one (`wx`), creating its folder unless `folders`
 * says this import already did. A stylesheet is scanned as it streams to the disk. Any other file only reaches Tailwind
 * through a stylesheet that imports it by path, which `cssCodeOffenders` refuses: chats, history and notes may quote
 * `@plugin` freely.
 */
async function stage(file: TarFile, target: string, folders: Set<string>): Promise<void> {
  if (READ_WHOLE.test(file.path) && file.size > IMPORT_LIMITS.maxBuffered) {
    throw new HttpError(413, m().api.archives.tooLarge(`${file.path} is over ${IMPORT_LIMITS.maxBuffered} bytes`));
  }
  const scan = file.path.endsWith('.css') ? new CssCodeScan() : null;
  try {
    const folder = path.dirname(target);
    if (!folders.has(folder)) {
      await fs.mkdir(folder, { recursive: true });
      folders.add(folder);
    }
    await pipe(
      file.stream,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          scan?.push(chunk.toString('latin1'));
          yield chunk;
        }
        if (scan?.end()) throw new HttpError(400, m().api.archives.cssCodeExec(file.path));
      },
      createWriteStream(target, { flags: 'wx' }),
    );
  } catch (e) {
    // A file where the archive already put a folder, or the reverse.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new HttpError(400, m().api.archives.collision(file.path));
    }
    throw e;
  }
}

/** The reader's errors carry no code; zlib's carry a Z_ one. Anything else (a disk error) stays a 500. */
function archiveError(e: unknown): unknown {
  if (e instanceof HttpError || !(e instanceof Error)) return e;
  const t = m().api.archives;
  const { code } = e as NodeJS.ErrnoException;
  if (code?.startsWith('Z_')) return new HttpError(400, t.unreadable(e.message));
  if (code !== undefined) return e;
  return OVER_CAP.test(e.message) ? new HttpError(413, t.tooLarge(e.message)) : new HttpError(400, t.refused(e.message));
}

async function removeStale(root: string, live: Set<string>): Promise<void> {
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (live.has(name)) continue;
    const dir = path.join(root, name);
    const stat = await fs.lstat(dir).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > STALE_STAGING_MS) await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Regular files only: Dirent types come from lstat, so a link is neither a file nor a folder and is never followed. */
async function* files(
  root: string,
  prefix: string,
  keep: (rel: string) => boolean,
  enter: (rel: string) => boolean,
  rel = '',
): AsyncGenerator<TarEntry> {
  const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory() && enter(child)) yield* files(root, prefix, keep, enter, child);
    else if (dirent.isFile() && keep(child)) yield { path: `${prefix}/${child}`, file: path.join(root, child) };
  }
}
