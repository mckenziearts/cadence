// Project archives: one .tar.gz holding projects and the brands they use, to move them to another installation
// (see ARCHITECTURE.md "Project archives").
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline, type Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { ArchiveManifest } from '../../src/shared/types';
import type { BrandStore, CadenceConfig, ProjectArchives, ProjectStore } from '../contracts';
import { m } from '../i18n';
import { DEFAULT_BRAND } from '../store/brands';
import { HttpError } from '../util';
import { writeTar, type TarEntry } from './tar';

/** The .cadence/ folders that are the project's history; the rest of .cadence/ is cache or tied to this machine. */
const TRAVELLING_STATE = new Set(['chats', 'versions', 'voice-over']);
const local = (segment: string) => segment.startsWith('.') || segment === 'node_modules';

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

/** A folder is entered when a file inside it could travel. */
const enterProjectFolder = (rel: string) => rel === '.cadence' || exportableProjectPath(`${rel}/-`);

export class ProjectArchiver implements ProjectArchives {
  constructor(private readonly deps: { config: CadenceConfig; store: ProjectStore; brands: BrandStore }) {}

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
