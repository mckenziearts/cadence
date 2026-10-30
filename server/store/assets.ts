import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetInfo, AssetKind, CaptureRefInput } from '../../src/shared/types';
import type { Policy } from '../capture/policy';
import { probeVideo } from '../clips/probe';
import type { AssetStore, CaptureService, ProjectStore, Upload } from '../contracts';
import { m } from '../i18n';
import {
  HttpError,
  KeyedMutex,
  pathExists,
  randomToken,
  readFileNoFollow,
  removeFileInside,
  renameInside,
  resolveInside,
  slugify,
  uniqueId,
  writeFileAtomic,
  writeFileInside,
} from '../util';

const MiB = 1024 * 1024;
const VIDEOS = new Set(['mp4', 'mov', 'm4v', 'webm']);
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
const UPLOADABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'woff', 'woff2', 'ttf', 'otf', 'json', ...VIDEOS]);
const limitMiB = (ext: string) => (VIDEOS.has(ext) ? 500 : ext === 'json' ? 10 : 50);
/** All of assets/ travels in an export, and an import takes 2048 MB at most: the rest is room for music and scenes. */
const PROJECT_ASSETS_MiB = 1536;

/** Files under projects/<id>/assets/ (assets/refs/ = reference screenshots for the agent). */
export class FileAssetStore implements AssetStore {
  private mutex = new KeyedMutex();

  constructor(
    private store: ProjectStore,
    private capture: CaptureService,
    private ffmpegPath: string,
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

  async upload(projectId: string, file: Upload): Promise<AssetInfo> {
    await this.requireProject(projectId);
    const original = path.basename(file.name.replaceAll('\\', '/'));
    const ext = path.extname(original).slice(1).toLowerCase();
    if (!UPLOADABLE.has(ext)) {
      throw new HttpError(415, m().api.assets.unsupported(original));
    }
    const stem = slugify(path.basename(original, path.extname(original)), 'fichier');
    const root = this.store.dir(projectId);
    const base = this.base(projectId);
    // Hidden from list() until checked: a clip is probed, a Lottie file parsed, before it takes its name.
    const upload = path.join(base, `.upload-${randomToken(9)}.${ext}`);
    try {
      const size = await this.receive(root, upload, file.body, original, limitMiB(ext), await this.bytes(projectId));
      if (size === 0) throw new HttpError(400, m().api.assets.empty(original));
      if (VIDEOS.has(ext) || ext === 'gif') await probeVideo(upload, this.ffmpegPath, { name: original });
      if (ext === 'json') checkLottie(await readFileNoFollow(root, upload, 'utf8'), original);
      return await this.mutex.run(projectId, async () => {
        // Again here: another upload may have taken its name since this one started.
        if ((await this.bytes(projectId)) + size > PROJECT_ASSETS_MiB * MiB) throw projectFull(original);
        const names = await fs.readdir(base).catch(() => [] as string[]);
        // Lowercased: macOS volumes are case-insensitive, so "Logo.png" and "logo.png" are the same file.
        const taken = names
          .filter((n) => n.toLowerCase().endsWith(`.${ext}`))
          .map((n) => n.slice(0, -ext.length - 1).toLowerCase());
        const name = `${uniqueId(stem, taken)}.${ext}`;
        await renameInside(root, upload, path.join(base, name));
        return this.info(projectId, name, size);
      });
    } catch (e) {
      await removeFileInside(root, upload).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Streams the body to `file` and returns its size; 413 as soon as it passes the file limit or the room `used` bytes
   * leave in the project, never read further.
   */
  private async receive(
    root: string,
    file: string,
    body: Upload['body'],
    name: string,
    mib: number,
    used: number,
  ): Promise<number> {
    let size = 0;
    async function* counted() {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > mib * MiB) throw new HttpError(413, m().api.assets.tooLarge(name, mib));
        if (used + size > PROJECT_ASSETS_MiB * MiB) throw projectFull(name);
        yield chunk;
      }
    }
    await writeFileInside(root, file, counted());
    return size;
  }

  async remove(projectId: string, assetPath: string): Promise<void> {
    await this.requireProject(projectId);
    const file = this.resolve(projectId, assetPath);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, m().api.fileNotFound(assetPath));
    await this.trash(projectId, file);
  }

  async captureReference(projectId: string, input: CaptureRefInput, policy: Policy): Promise<AssetInfo> {
    await this.requireProject(projectId);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new HttpError(400, m().api.assets.invalidUrl(input.url));
    }
    // Other schemes (file:, data:, javascript:...) never; which addresses the capture reaches is the policy's call.
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
      image = await this.capture.screenshotUrl(url.href, { device: input.device, fullPage: input.fullPage, policy });
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

  private async bytes(projectId: string): Promise<number> {
    return (await this.list(projectId)).reduce((sum, asset) => sum + asset.size, 0);
  }

  private base(projectId: string): string {
    return path.join(this.store.dir(projectId), 'assets');
  }

  private async requireProject(projectId: string): Promise<void> {
    if (!(await this.store.exists(projectId))) throw new HttpError(404, m().api.projectNotFound(projectId));
  }
}

const projectFull = (name: string) => new HttpError(413, m().api.assets.projectFull(name, PROJECT_ASSETS_MiB));

const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/**
 * The Lottie header the player needs, and no image it would fetch: a scene loads nothing from the network, and a path
 * would reach files the project does not hold.
 */
function checkLottie(text: string, name: string): void {
  const doc = (() => {
    try {
      return JSON.parse(text) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  })();
  const assets = doc?.assets ?? [];
  const fonts = (doc?.fonts as { list?: unknown } | null | undefined)?.list ?? [];
  const objects = (list: unknown) => Array.isArray(list) && list.every((entry) => typeof entry === 'object' && entry !== null);
  const header =
    doc !== null &&
    typeof doc.v === 'string' &&
    ['fr', 'ip', 'op', 'w', 'h'].every((key) => isNumber(doc[key])) &&
    Array.isArray(doc.layers) &&
    objects(assets) &&
    objects(fonts);
  if (!header) throw new HttpError(422, m().media.clips.notLottie(name));
  // lottie-web keeps p as it is only with e set or no u; otherwise it loads u + p, a data: p included.
  for (const { p, u, e } of assets as { p?: unknown; u?: unknown; e?: unknown }[]) {
    if (p === undefined) continue;
    const embedded = typeof p === 'string' && p.startsWith('data:');
    if (!embedded || (e !== 1 && u)) throw new HttpError(422, m().media.clips.externalImage(name, String(embedded ? u : p)));
  }
  // A font path is a stylesheet, a script or a font file lottie-web adds to the page.
  for (const { fPath } of fonts as { fPath?: unknown }[]) {
    if (fPath) throw new HttpError(422, m().media.clips.externalFont(name, String(fPath)));
  }
}
