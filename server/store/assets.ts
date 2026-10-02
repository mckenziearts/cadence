import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetInfo, AssetKind, CaptureRefInput } from '../../src/shared/types';
import type { AssetStore, CaptureService, ProjectStore } from '../contracts';
import { m } from '../i18n';
import { HttpError, KeyedMutex, pathExists, resolveInside, slugify, uniqueId, writeFileAtomic } from '../util';

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const KINDS: Record<string, AssetKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  avif: 'image',
  svg: 'svg',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
};
const UPLOADABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'woff', 'woff2', 'ttf', 'otf']);

/** Files under projects/<id>/assets/ (assets/refs/ = reference screenshots for the agent). */
export class FileAssetStore implements AssetStore {
  private mutex = new KeyedMutex();

  constructor(
    private store: ProjectStore,
    private capture: CaptureService,
  ) {}

  resolve(projectId: string, assetPath: string): string {
    return resolveInside(this.base(projectId), assetPath);
  }

  async list(projectId: string): Promise<AssetInfo[]> {
    await this.requireProject(projectId);
    const base = this.base(projectId);
    const entries = await fs.readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
    const out: AssetInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
      const file = path.join(entry.parentPath, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) out.push(this.info(projectId, path.relative(base, file).split(path.sep).join('/'), stat.size));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async upload(projectId: string, file: { name: string; data: Buffer }): Promise<AssetInfo> {
    await this.requireProject(projectId);
    const original = path.basename(file.name.replaceAll('\\', '/'));
    const ext = path.extname(original).slice(1).toLowerCase();
    if (!UPLOADABLE.has(ext)) {
      throw new HttpError(415, m().api.assets.unsupported(original));
    }
    if (file.data.length === 0) throw new HttpError(400, m().api.assets.empty(original));
    if (file.data.length > MAX_ASSET_BYTES) throw new HttpError(413, m().api.assets.tooLarge(original));
    const stem = slugify(path.basename(original, path.extname(original)), 'fichier');
    return this.mutex.run(projectId, async () => {
      const base = this.base(projectId);
      const names = await fs.readdir(base).catch(() => [] as string[]);
      // Lowercased: macOS volumes are case-insensitive, so "Logo.png" and "logo.png" are the same file.
      const taken = names
        .filter((n) => n.toLowerCase().endsWith(`.${ext}`))
        .map((n) => n.slice(0, -ext.length - 1).toLowerCase());
      const name = `${uniqueId(stem, taken)}.${ext}`;
      await writeFileAtomic(path.join(base, name), file.data);
      return this.info(projectId, name, file.data.length);
    });
  }

  async remove(projectId: string, assetPath: string): Promise<void> {
    await this.requireProject(projectId);
    const file = this.resolve(projectId, assetPath);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, m().api.fileNotFound(assetPath));
    await this.trash(projectId, file);
  }

  async captureReference(projectId: string, input: CaptureRefInput): Promise<AssetInfo> {
    await this.requireProject(projectId);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new HttpError(400, m().api.assets.invalidUrl(input.url));
    }
    // Local dev servers (localhost) are fine; other schemes (file:, data:, javascript:...) are not.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HttpError(400, m().api.assets.httpOnly(input.url));
    }
    if (input.device !== 'desktop' && input.device !== 'mobile')
      throw new HttpError(400, m().api.assets.unknownDevice(input.device));
    // The query picks the page too (.../dashboard?period=week vs ?period=month).
    const name = slugify(input.name?.trim() || `${url.host}${url.pathname}${url.search}`, 'reference');
    const rel = `refs/${name}-${input.device}.png`;
    let image: Buffer;
    try {
      image = await this.capture.screenshotUrl(url.href, { device: input.device, fullPage: input.fullPage });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, m().api.assets.captureFailed(url.href, (e as Error).message));
    }
    return this.mutex.run(projectId, async () => {
      const file = path.join(this.base(projectId), rel);
      // Capturing again refreshes the file; the previous capture is kept in the trash.
      if (await pathExists(file)) await this.trash(projectId, file);
      await writeFileAtomic(file, image);
      return this.info(projectId, rel, image.length);
    });
  }

  /** Kept in .cadence/trash rather than deleted: assets are not versioned. */
  private async trash(projectId: string, file: string): Promise<void> {
    const trash = path.join(this.store.dir(projectId), '.cadence', 'trash');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(file, path.join(trash, `${Date.now()}-${path.basename(file)}`));
  }

  private info(projectId: string, rel: string, size: number): AssetInfo {
    return {
      path: rel,
      url: `/api/projects/${projectId}/assets/file?path=${encodeURIComponent(rel)}`,
      size,
      kind: KINDS[path.extname(rel).slice(1).toLowerCase()] ?? 'other',
      isReference: rel.startsWith('refs/'),
    };
  }

  private base(projectId: string): string {
    return path.join(this.store.dir(projectId), 'assets');
  }

  private async requireProject(projectId: string): Promise<void> {
    if (!(await this.store.exists(projectId))) throw new HttpError(404, m().api.projectNotFound(projectId));
  }
}
