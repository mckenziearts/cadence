// Temp Cadence roots for server tests: brands/ and templates/ fixtures, projects/ empty.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EventEmitter } from 'node:events';
import net from 'node:net';
import type { TestContext } from 'node:test';
import { loadConfig } from '../../server/config';
import type { CadenceConfig, Network } from '../../server/contracts';
import type { NetworkId } from '../../src/shared/types';

export const BRAND_JSON = {
  id: 'cadence',
  name: 'Cadence',
  tagline: 'Chaque scène est du code.',
  url: 'https://cadence.test',
  language: 'fr',
  colors: {
    background: '#fafafa',
    surface: '#ffffff',
    ink: '#0a0a0a',
    muted: '#8a8a8f',
    line: '#e6e6e9',
    primary: '#18181b',
    primaryInk: '#ffffff',
    accent: '#ff2e88',
    success: '#00bc7d',
    warning: '#fe9a00',
    danger: '#fb2c36',
  },
  fonts: { display: "'Inter Variable', sans-serif", body: "'Geist Variable', sans-serif", mono: 'monospace', preload: [] },
  radius: { sm: 8, md: 12, lg: 16, xl: 22 },
  logo: { mark: 'assets/logo-mark.svg', full: 'assets/logo-full.svg' },
  voice: 'Précis et calme.',
};

export const SCENE_TEMPLATE_CODE = "import { Fill } from 'cadence';\nexport default function Scene() {\n  return <Fill />;\n}\n";

export interface TestRoot {
  root: string;
  config: CadenceConfig;
  cleanup(): Promise<void>;
}

export async function makeRoot(): Promise<TestRoot> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-test-'));
  const write = async (rel: string, content: string | object) => {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  };
  await write('brands/cadence/brand.json', BRAND_JSON);
  await write('brands/cadence/art-direction.md', '# Direction Cadence\n\nFond clair, typographie serrée.\n');
  await write('brands/cadence/KIT.md', 'Use ui.Card for panels.\n');
  await write('brands/cadence/assets/logo-mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await write('brands/cadence/assets/logo-full.svg', '<svg xmlns="http://www.w3.org/2000/svg" id="full"/>');
  await write('brands/orbit/brand.json', { ...BRAND_JSON, id: 'orbit', name: 'Orbit', tagline: 'Payez simplement.' });
  await write('templates/scenes/logo-reveal/template.json', {
    id: 'logo-reveal',
    name: 'Révélation du logo',
    description: 'Le logo apparaît.',
    category: 'intro',
    bars: 4,
    formats: ['16:9', '9:16'],
    tags: ['logo'],
    customize: ['COPY.title'],
  });
  await write('templates/scenes/logo-reveal/scene.tsx', SCENE_TEMPLATE_CODE);
  await write('templates/scenes/feature-card/template.json', {
    name: 'Carte de fonctionnalité',
    description: 'Une carte.',
    category: 'feature',
    bars: 2,
    formats: ['16:9'],
  });
  await write('templates/scenes/feature-card/scene.tsx', SCENE_TEMPLATE_CODE.replace('Scene', 'Feature'));
  await write('templates/projects/launch/template.json', {
    name: 'Lancement',
    description: 'Teaser de lancement.',
    fps: 30,
    formats: ['16:9', '9:16'],
    bpm: 100,
    scenes: [
      { template: 'logo-reveal', name: 'Logo', bars: 4 },
      { template: 'feature-card', name: 'Fonctionnalité', bars: 2 },
      { template: 'feature-card', name: 'Fonctionnalité', bars: 2 },
    ],
  });
  await write('templates/projects/launch/art-direction.md', '## Campagne\n\nRythme soutenu.\n');
  await fs.mkdir(path.join(root, 'projects'));
  const config = loadConfig({ root, editorPort: 5299, framePort: 5300 });
  return { root, config, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Resolves with the event's arguments, rejects after `ms`. */
export function nextEvent(
  emitter: EventEmitter,
  event: string,
  ms = 4000,
  filter: (...args: any[]) => boolean = () => true,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`no "${event}" event within ${ms} ms`));
    }, ms);
    const listener = (...args: unknown[]) => {
      if (!filter(...args)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(args);
    };
    emitter.on(event, listener);
  });
}

/** Asserts that `promise` rejects with an HttpError-like status. */
export async function rejectsWithStatus(promise: Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  try {
    await promise;
  } catch (e) {
    const err = e as { status?: number; message: string };
    if (err.status !== status) throw new Error(`expected status ${status}, got ${err.status}: ${err.message}`);
    if (message && !message.test(err.message)) throw new Error(`unexpected message: ${err.message}`);
    return;
  }
  throw new Error(`expected a rejection with status ${status}`);
}

/**
 * A YouTube that never leaves the machine: its consent page is the callback itself (with a code), uploads report half
 * then all of the file. `gate` holds an upload until it resolves; `calls` records what reached the network.
 */
const FAKE_LABELS: Record<NetworkId, string> = {
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

export function fakeNetwork(
  calls: [string, unknown][] = [],
  gate: Promise<void> = Promise.resolve(),
  id: NetworkId = 'youtube',
): Network {
  const tokens = (n: number) => ({ access: `access-${n}`, refresh: 'refresh-1', expiresAt: Date.now() + 3_600_000 });
  return {
    id,
    label: FAKE_LABELS[id],
    fields: { title: 100, text: 5000, visibilities: ['private', 'unlisted', 'public'] },
    authorizeUrl: (app, { redirectUri, state, challenge }) =>
      `${redirectUri}?${new URLSearchParams({ state, code: `code-${app.clientId}`, challenge })}`,
    async connect(app, input) {
      calls.push(['connect', { clientId: app.clientId, code: input.code, verifier: input.verifier }]);
      return { identity: { name: 'Chaîne E2E', url: 'https://www.youtube.com/@e2e', avatar: null }, tokens: tokens(1) };
    },
    async refresh(_app, current) {
      calls.push(['refresh', current.refresh]);
      return tokens(2);
    },
    async revoke(_app, current) {
      calls.push(['revoke', current.refresh]);
    },
    async publish(input) {
      const { title, description, visibility, size } = input;
      calls.push(['publish', { title, description, visibility, size, access: input.tokens.access }]);
      input.onProgress(size / 2);
      await gate;
      input.onProgress(size);
      return { url: 'https://youtu.be/e2e', visibility: 'private' };
    },
  };
}

/**
 * A brand folder that passes brandProblems with no font package installed: its one face is a file of the folder.
 * Overwrites what makeRoot wrote for `id`.
 */
export async function writeCompleteBrand(root: string, id: string): Promise<void> {
  const dir = path.join(root, 'brands', id);
  const family = "'Orbit Sans', sans-serif";
  const brand = {
    ...BRAND_JSON,
    id,
    name: 'Orbit',
    fonts: { display: family, body: family, mono: 'monospace', preload: ["400 16px 'Orbit Sans'"] },
  };
  const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const theme = [
    "@import 'tailwindcss' source(none);",
    "@source '../../projects';",
    "@source '../../templates';",
    "@source '.';",
    "@font-face { font-family: 'Orbit Sans'; src: url('./fonts/orbit.woff2'); }",
    '@theme {',
    ...Object.entries(brand.colors).map(([key, value]) => `  --color-${kebab(key)}: ${value};`),
    ...Object.entries(brand.fonts)
      .filter(([key]) => key !== 'preload')
      .map(([key, value]) => `  --font-${key}: ${value};`),
    ...Object.entries(brand.radius).map(([key, value]) => `  --radius-${key}: ${value}px;`),
    '}',
  ];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const files: Record<string, string | Buffer> = {
    'brand.json': JSON.stringify(brand, null, 2),
    'theme.css': `${theme.join('\n')}\n`,
    'fonts/orbit.woff2': Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7919) % 256)),
    'assets/logo-mark.svg': svg,
    'assets/logo-full.svg': svg.replace('<rect', '<rect id="full"'),
    'art-direction.md': `# Orbit\n\n${'Fond sombre, accents vifs, texte court. '.repeat(15)}\n`,
    'KIT.md': `# Kit Orbit\n\n${'Utilisez ui.Card pour les panneaux et ui.Stat pour les chiffres. '.repeat(10)}\n`,
  };
  await fs.rm(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}

/** Raw ustar headers, to build archives writeTar would never write. */
export interface RawHeader {
  name?: string;
  type?: string;
  size?: number;
  prefix?: string;
  sizeField?: Buffer;
}

export function rawHeader({ name = '', type = '0', size = 0, prefix = '', sizeField }: RawHeader): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  if (sizeField) sizeField.copy(block, 124);
  else block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write(type, 156);
  block.write('ustar\x0000', 257);
  block.write(prefix, 345, 155);
  block.fill(' ', 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0`, 148);
  return block;
}

export const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

export function fileEntry(name: string, content = '', type = '0'): Buffer {
  const data = Buffer.from(content);
  return Buffer.concat([rawHeader({ name, type, size: data.length }), padded(data)]);
}

/** A socket bound to `port` on `host`, the way another local process would hold it. */
export function occupy(port: number, host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject).listen(port, host, () => resolve(blocker));
  });
}

/** Fails the next `times` listens on `host` with `code`, as the OS would; every other listen goes through. */
export function failListen(ctx: TestContext, host: string, code: string, times = Infinity) {
  const listen = net.Server.prototype.listen;
  let left = times;
  return ctx.mock.method(net.Server.prototype, 'listen', function (this: net.Server, ...args: unknown[]) {
    if (args[1] !== host || left-- <= 0) return listen.apply(this, args as Parameters<typeof listen>);
    process.nextTick(() => this.emit('error', Object.assign(new Error(`listen ${code} ${host}:${String(args[0])}`), { code })));
    return this;
  });
}
