// Frame e2e harness: the real Vite server and frame handler on free ports, with small file-backed stores. Each harness
// works in its own projects/e2e-<name>-<random>/ folder (gitignored) holding projects/ and brands/ like the repo root:
// the fixture brand's theme.css sources ../../projects, and Tailwind only scans a gitignored folder named explicitly.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { ViteDevServer } from 'vite';
import type {
  BrandStore,
  CadenceConfig,
  Hub,
  MusicService,
  ProjectStore,
  VoiceOverService,
  VoiceOverTrack,
} from '../../../server/contracts';
import { createFrameHandler } from '../../../server/frames/frameServer';
import { createVite, invalidateDirs } from '../../../server/frames/vite';
import { HttpError, KeyedMutex, pathExists, readJson, roundMs, sha256, shortHash } from '../../../server/util';
import type { BrandFile, ProjectFile, ProjectState, SceneState, ServerEvent, VoiceOverLine } from '../../../src/shared/types';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.join(ROOT, 'tests/fixtures');

const unused = (): never => {
  throw new Error('non utilisé par le harnais e2e');
};

/** Reads projects/<id>/project.json on every call; code generations work like the real store's syncCode. */
export class FixtureProjectStore implements ProjectStore {
  readonly events = new EventEmitter();
  /** ProjectState.voiceOverLines, per project: the sentences generated so far. */
  readonly voiceOverLines = new Map<string, VoiceOverLine[]>();
  private hashes = new Map<string, string>();
  private generations = new Map<string, number>();
  private invalidate: (dirs: string[]) => void = () => undefined;
  private locks = new KeyedMutex();

  constructor(
    readonly root: string,
    private readonly brandsDir: string,
  ) {}

  dir(id: string): string {
    return path.join(this.root, id);
  }

  sceneFile(id: string, sceneId: string): string {
    return path.join(this.dir(id), 'scenes', `${sceneId}.tsx`);
  }

  generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  exists(id: string): Promise<boolean> {
    return pathExists(path.join(this.dir(id), 'project.json'));
  }

  async get(id: string): Promise<ProjectState> {
    const dir = this.dir(id);
    const file = await readJson<ProjectFile>(path.join(dir, 'project.json')).catch(() => {
      throw new HttpError(404, `Projet introuvable : ${id}`);
    });
    let start = 0;
    const scenes: SceneState[] = [];
    for (const [index, scene] of file.scenes.entries()) {
      const sceneFile = this.sceneFile(id, scene.id);
      const code = await readFile(sceneFile, 'utf8').catch(() => '');
      scenes.push({
        ...scene,
        index,
        start: roundMs(start),
        file: sceneFile,
        url: `/@fs${sceneFile}`,
        codeVersion: shortHash(code),
      });
      start += scene.duration;
    }
    return {
      id,
      dir,
      name: file.name,
      brand: file.brand,
      fps: file.fps,
      formats: file.formats,
      tempo: file.tempo,
      language: null,
      scenes,
      duration: roundMs(start),
      music: file.music,
      musicUrl: null,
      musicGrid: null,
      voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 },
      voiceOverUrl: null,
      voiceOverLines: this.voiceOverLines.get(id) ?? [],
      voiceOverPending: [],
      voiceOverError: null,
      codeGeneration: this.generation(id),
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }

  async syncCode(id: string): Promise<boolean> {
    const file = await readJson<ProjectFile>(path.join(this.dir(id), 'project.json'));
    const dirs = [this.dir(id), path.join(this.brandsDir, file.brand ?? 'cadence')];
    const parts: string[] = [];
    for (const dir of [path.join(dirs[0], 'scenes'), path.join(dirs[0], 'components'), dirs[1]]) {
      for (const name of (await readdir(dir, { recursive: true }).catch(() => [] as string[])).sort()) {
        parts.push(name, await readFile(path.join(dir, name), 'utf8').catch(() => ''));
      }
    }
    const hash = sha256(parts.join('\0'));
    if (this.hashes.get(id) === hash) return false;
    this.hashes.set(id, hash);
    this.invalidate(dirs);
    this.generations.set(id, this.generation(id) + 1);
    this.events.emit('code-changed', id, this.generation(id));
    return true;
  }

  setModuleInvalidator(fn: (dirs: string[]) => void): void {
    this.invalidate = fn;
  }

  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(id, fn);
  }

  watch(): void {}
  close(): void {}
  list = unused;
  create = unused;
  update = unused;
  remove = unused;
  createScene = unused;
  updateScene = unused;
  duplicateScene = unused;
  deleteScene = unused;
  reorderScenes = unused;
  setDurations = unused;
  setMusic = unused;
  readArtDirection = unused;
  writeArtDirection = unused;
  setMusicGridProvider = unused;
  setVoiceOverProvider = unused;
}

export class FixtureBrandStore implements BrandStore {
  constructor(private readonly brandsDir: string) {}

  dir(id: string): string {
    return path.join(this.brandsDir, id);
  }

  exists(id: string): Promise<boolean> {
    return pathExists(path.join(this.dir(id), 'brand.json'));
  }

  get(id: string): Promise<BrandFile> {
    return readJson<BrandFile>(path.join(this.dir(id), 'brand.json')).catch(() => {
      throw new HttpError(404, `Marque introuvable : ${id}`);
    });
  }

  list = unused;
  describe = unused;
  remove = unused;
}

export class RecordingHub implements Hub {
  events: ServerEvent[] = [];
  send(event: ServerEvent): void {
    this.events.push(event);
  }
  handleSse = unused;
}

export class FixtureMusicService implements MusicService {
  /** Absolute path returned by audioPath(), per project. */
  audio = new Map<string, string>();
  async audioPath(projectId: string): Promise<string | null> {
    return this.audio.get(projectId) ?? null;
  }
  upload = unused;
  tracks = unused;
  select = unused;
  update = unused;
  remove = unused;
  analysis = unused;
  grid = unused;
  snapCuts = unused;
  context = unused;
}

export class FixtureVoiceOverService implements VoiceOverService {
  /** What track() returns, per project. */
  tracks = new Map<string, VoiceOverTrack>();
  async track(projectId: string): Promise<VoiceOverTrack | null> {
    return this.tracks.get(projectId) ?? null;
  }
  async sync(): Promise<void> {}
  voices = unused;
  download = unused;
  elevenLabs = unused;
  setElevenLabsKey = unused;
}

export interface Harness {
  config: CadenceConfig;
  vite: ViteDevServer;
  store: FixtureProjectStore;
  brands: FixtureBrandStore;
  /** Copy tests/fixtures/projects/<fixture> into the harness folder; returns the new project id. */
  project(fixture: string): Promise<string>;
  /** URL of a page on the editor origin that embeds `frameUrl` in an iframe and records the messages it gets. */
  editorPage(frameUrl: string): string;
  close(): Promise<void>;
}

/** Test pages served on the editor origin: an iframe host that records postMessage traffic. */
function editorHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const frame = new URL(req.url ?? '/', 'http://editor').searchParams.get('frame') ?? '';
  const src = frame.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><body style="margin:0">
<iframe id="frame" src="${src}" style="width:960px;height:540px;border:0"></iframe>
<script>
  window.received = [];
  window.addEventListener('message', (event) => window.received.push({ origin: event.origin, data: event.data }));
</script>
</body></html>`);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

export async function startHarness(name: string): Promise<Harness> {
  const frameServer = http.createServer();
  const editorServer = http.createServer(editorHandler);
  const [framePort, editorPort] = await Promise.all([listen(frameServer), listen(editorServer)]);
  const workspace = path.join(ROOT, 'projects', `e2e-${name}-${randomBytes(3).toString('hex')}`);
  await cp(path.join(FIXTURES, 'brands'), path.join(workspace, 'brands'), { recursive: true });
  const config: CadenceConfig = {
    root: ROOT,
    projectsDir: path.join(workspace, 'projects'),
    brandsDir: path.join(workspace, 'brands'),
    templatesDir: path.join(ROOT, 'templates'),
    stateDir: path.join(workspace, 'state'),
    host: '127.0.0.1',
    editorPort,
    framePort,
    editorOrigin: `http://127.0.0.1:${editorPort}`,
    frameOrigin: `http://localhost:${framePort}`,
    mcpUrl: `http://127.0.0.1:${editorPort}/mcp`,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    claudePath: 'claude',
    codexPath: 'codex',
    grokPath: 'grok',
    geminiPath: 'gemini',
    piperPath: 'piper',
    defaultModel: 'claude-opus-5-5',
    defaultEffort: 'medium',
    useApiKey: false,
    agentLog: null,
  };
  const vite = await createVite({
    config,
    overrides: {
      // Own dependency cache per suite: test files run in parallel and must not disturb a running Cadence.
      cacheDir: path.join(ROOT, 'node_modules/.vite-e2e', name),
      resolve: { alias: { cadence: path.join(FIXTURES, 'runtime/index.ts') } },
      // Added to the app's list: the stub runtime lives under tests/.
      server: { fs: { allow: [path.join(FIXTURES, 'runtime')] } },
    },
  });
  const store = new FixtureProjectStore(config.projectsDir, config.brandsDir);
  store.setModuleInvalidator((dirs) => invalidateDirs(vite, dirs));
  const brands = new FixtureBrandStore(config.brandsDir);
  frameServer.on('request', createFrameHandler({ config, vite, store, brands }));
  let count = 0;

  return {
    config,
    vite,
    store,
    brands,
    async project(fixture) {
      const id = `${fixture}-${++count}`;
      await cp(path.join(FIXTURES, 'projects', fixture), store.dir(id), { recursive: true });
      await store.syncCode(id);
      return id;
    },
    editorPage(frameUrl) {
      return `${config.editorOrigin}/?frame=${encodeURIComponent(frameUrl)}`;
    },
    async close() {
      frameServer.closeAllConnections();
      editorServer.closeAllConnections();
      await Promise.all([new Promise((r) => frameServer.close(r)), new Promise((r) => editorServer.close(r))]);
      await vite.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

/** [r, g, b] of a pixel of a PNG screenshot (device pixels). */
export function pixel(png: Buffer, x: number, y: number): [number, number, number] {
  const image = PNG.sync.read(png);
  const i = (image.width * Math.round(y) + Math.round(x)) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

/** True when every channel is within `tolerance`. */
export function near(actual: number[], expected: number[], tolerance = 2): boolean {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);
}
