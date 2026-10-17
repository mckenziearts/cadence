// The frame origin with a request secret: real Vite and frame handler on a free port, no Chromium.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Plugin, ViteDevServer } from 'vite';
import { loadConfig } from '../../server/config';
import { createFrameHandler } from '../../server/frames/frameServer';
import { createVite, diagnoseFile, frameReach } from '../../server/frames/vite';
import { m } from '../../server/i18n';
import { type FrameKind, frameOriginOf } from '../../src/shared/frameOrigin';
import { BRAND_JSON, makeRoot } from './helpers';

const SECRET = 'frame-request-secret-0123456789abcdef';

function request(
  port: number,
  pathname: string,
  init: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: init.method ?? 'GET',
        headers: { host: init.host ?? projectHost, ...init.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const frame = '/frame.html?project=p';
const secret = { 'x-cadence-secret': SECRET };
let server: http.Server;
let port: number;
let config: ReturnType<typeof loadConfig>;
/** The frame origin of project `p`. */
let projectHost: string;
let vite: ViteDevServer | undefined;
let cleanup: () => Promise<void>;
/** A stylesheet the next transform of it swaps for a link to `target`. */
let swapNext: { sheet: string; target: string } | undefined;
// Between the read that compiled a stylesheet and Vite's CSS plugin, where a swap made from a shell can land.
const swap: Plugin = {
  name: 'swap',
  enforce: 'pre',
  async transform(_code, id) {
    if (!swapNext || !id.startsWith(swapNext.sheet)) return;
    const { sheet, target } = swapNext;
    swapNext = undefined;
    await fs.rm(sheet);
    await fs.symlink(target, sheet);
  },
};

before(async () => {
  const root = await makeRoot();
  // Reached through a link, as `/var` is on macOS: a module is named by its configured path or its real path.
  const link = `${root.root}-link`;
  await fs.symlink(root.root, link);
  cleanup = async () => {
    await fs.rm(link);
    await root.cleanup();
  };
  const repo = path.resolve(import.meta.dirname, '../..');
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(repo, 'node_modules/.vite-e2e/frame-secret');
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const [projectsDir, brandsDir, templatesDir, stateDir] = [
    root.config.projectsDir,
    root.config.brandsDir,
    root.config.templatesDir,
    root.config.stateDir,
  ].map((dir) => path.join(link, path.relative(root.root, dir)));
  config = {
    ...loadConfig({ root: repo, projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: port }),
    requestSecret: SECRET,
  };
  vite = await createVite({ config, overrides: { plugins: [swap] } });
  await fs.mkdir(path.join(projectsDir, 'p'));
  projectHost = await hostOf('project', 'p');
  const inDir = (dir: string) => (id: string) =>
    fs.stat(path.join(dir, id)).then(
      () => true,
      () => false,
    );
  const store = { get: async (id: string) => ({ id, brand: 'cadence' }), exists: inDir(projectsDir) } as never;
  const brands = {
    get: async () => BRAND_JSON,
    dir: (id: string) => path.join(brandsDir, id),
    exists: inDir(brandsDir),
  } as never;
  server.on('request', createFrameHandler({ config, vite, store, brands }));
});

const hostOf = async (kind: FrameKind, id: string) => new URL(await frameOriginOf(config.frameOrigin, kind, id)).host;

after(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await vite?.close();
  await cleanup?.();
});

test('the frame origin refuses every request without X-Cadence-Secret, WebSocket upgrades and the Host check included', async () => {
  const upgrade = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13' };
  for (const url of [frame, '/frame-api/projects/p', '/src/frame/main.tsx']) {
    assert.equal((await request(port, url)).status, 403, url);
    assert.equal((await request(port, url, { headers: { 'x-cadence-secret': 'nope' } })).status, 403, `${url} wrong secret`);
    assert.equal((await request(port, url, { headers: secret })).status, 200, `${url} with the secret`);
  }
  const refused = await request(port, frame, { host: `evil.test:${port}` });
  assert.deepEqual([refused.status, refused.body], [403, 'Secret de requête manquant ou invalide']);
  assert.ok(refused.headers['content-security-policy'], 'still under the frame CSP');
  const rebound = await request(port, frame, { host: `evil.test:${port}`, headers: secret });
  assert.deepEqual([rebound.status, rebound.body], [403, 'Hôte non autorisé'], 'the Host check still runs with the secret');
  assert.equal((await request(port, frame, { method: 'POST' })).status, 403);
  assert.equal((await request(port, frame, { headers: upgrade })).status, 403, 'a WebSocket upgrade');
  assert.equal((await request(port, frame, { headers: { ...upgrade, ...secret } })).status, 200);
});

test('the frame origins answer only hosts that name an existing project or brand', async () => {
  const status = async (host: string, url = frame) => (await request(port, url, { host, headers: secret })).status;
  for (const host of [
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    await hostOf('project', 'missing'),
    await hostOf('brand', 'p'),
    await hostOf('project', 'cadence'),
  ]) {
    const refused = await request(port, frame, { host, headers: secret });
    assert.deepEqual([refused.status, refused.body], [403, 'Hôte non autorisé'], host);
  }
  assert.equal(await status(await hostOf('brand', 'cadence'), '/kit.html?brand=cadence'), 200);
  // Created after the folders were first read: a label nobody knows rescans them.
  await fs.mkdir(path.join(config.projectsDir, 'later'));
  await fs.mkdir(path.join(config.brandsDir, 'later'));
  assert.equal(await status(await hostOf('project', 'later'), '/frame.html?project=later'), 200, 'a new project');
  assert.equal(await status(await hostOf('brand', 'later'), '/kit.html?brand=later'), 200, 'a new brand');
  await fs.rm(path.join(config.projectsDir, 'later'), { recursive: true });
  assert.equal(
    await status(await hostOf('project', 'later'), '/frame.html?project=later'),
    403,
    'a deleted project keeps no origin',
  );
});

test('the frame CSP limits connect-src to the frame origin itself and lets only the editor embed a frame', async () => {
  // Capture pages send the secret on every request: WebSockets skip the capture routes and localhost skips its proxy,
  // so this directive is what keeps the header off other localhost ports (any ws: or localhost:* source would leak it).
  for (const [label, response] of [
    ['200', await request(port, frame, { headers: secret })],
    ['403', await request(port, frame)],
  ] as const) {
    const csp = String(response.headers['content-security-policy'] ?? '');
    const directives = csp
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => /^(connect-src|frame-ancestors) /.test(directive));
    const editor = config.editorPort;
    assert.deepEqual(
      directives,
      ["connect-src 'self'", `frame-ancestors http://127.0.0.1:${editor} http://localhost:${editor}`],
      `${label}: ${csp}`,
    );
  }
});

test('font files answer CORS to the editor on a brand origin, never on a project origin', async () => {
  const font = '/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';
  const editor = `http://127.0.0.1:${config.editorPort}`;
  const brand = await hostOf('brand', 'cadence');
  const allowed = await request(port, font, { host: brand, headers: { ...secret, origin: editor } });
  assert.deepEqual([allowed.status, allowed.headers['access-control-allow-origin']], [200, editor]);
  for (const [host, origin] of [
    [brand, 'http://evil.test'],
    [projectHost, editor],
  ]) {
    const refused = await request(port, font, { host, headers: { ...secret, origin } });
    assert.deepEqual([refused.status, refused.headers['access-control-allow-origin']], [200, undefined], `${host} ${origin}`);
  }
});

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** The body, with the data: URLs Vite inlines (source maps, `?inline` assets) decoded. */
const withMaps = (body: string) =>
  [
    body,
    ...[...body.matchAll(/data:[\w/+.-]*(?:;[\w-]+=[\w-]+)*;base64,([\w+/=]+)/g)].map(([, data]) =>
      Buffer.from(data!, 'base64').toString(),
    ),
  ].join('\n');

test('an origin serves no file of another project or brand, also one with the same id, nor a folder', async () => {
  const { projectsDir, brandsDir } = config;
  await write(path.join(projectsDir, 'p', 'scenes', 'blue.tsx'), 'export default () => null;\n');
  await write(path.join(projectsDir, 'q', 'scenes', 'theme.tsx'), 'export const q = 1;\n');
  await write(path.join(projectsDir, 'q', 'scenes', 'notes.txt'), 'Q-ONLY-MARKER\n');
  await write(path.join(brandsDir, 'p', 'theme.css'), '.p {}\n');
  try {
    const brandHost = await hostOf('brand', 'p');
    const cases: [string, string, number][] = [
      [projectHost, `/@fs${projectsDir}/p/scenes/blue.tsx`, 200],
      [projectHost, `/@fs${projectsDir}/q/scenes/theme.tsx`, 403],
      [projectHost, `/@fs${projectsDir}/q/scenes/notes.txt?raw`, 403],
      [projectHost, `/@fs${projectsDir}/q/scenes/notes.txt?import&raw`, 403],
      [projectHost, `/@fs${projectsDir}/q/scenes/theme.tsx?worker_file&type=module`, 403],
      [projectHost, `/@fs${projectsDir}/p/scenes`, 403],
      [projectHost, `/@fs${brandsDir}/p/theme.css`, 403],
      [projectHost, `/@fs${projectsDir}/p/%2e%2e/q/scenes/theme.tsx`, 403],
      [projectHost, `/@fs${projectsDir}/p/scenes/..%5c..%5cq/scenes/theme.tsx`, 403],
      // Decoded once by the check and once more by Vite: the folder `%2e%2e` of p, which does not exist.
      [projectHost, `/@fs${projectsDir}/p/%252e%252e/q/scenes/theme.tsx`, 404],
      [projectHost, `/@fs${projectsDir}/p/%252e%252e/q/scenes/notes.txt`, 404],
      [projectHost, '/frame-api/brands/p', 403],
      [projectHost, '/frame.html?project=q', 403],
      [projectHost, '/frame-api/projects/q/scenes/x/diagnostics', 403],
      [brandHost, `/@fs${projectsDir}/p/scenes/blue.tsx`, 403],
      [brandHost, '/frame-api/projects/p', 403],
      [brandHost, '/kit.html', 403],
      [brandHost, `/@fs${brandsDir}/p/theme.css`, 200],
    ];
    for (const [host, url, status] of cases) {
      const response = await request(port, url, { host, headers: secret });
      assert.equal(response.status, status, `${host} ${url}`);
      assert.doesNotMatch(response.body, /Q-ONLY-MARKER/, `${host} ${url}`);
      assert.equal(response.headers['x-dns-prefetch-control'], 'off', `${host} ${url}`);
      if (status === 403) assert.match(response.body, new RegExp(m().api.frames.forbidden), `${host} ${url}`);
    }
  } finally {
    await fs.rm(path.join(brandsDir, 'p'), { recursive: true });
  }
});

test("a module carries nothing of another project: no source map's sources, no CSS Modules composition", async () => {
  const { projectsDir } = config;
  const other = path.join(projectsDir, 'q', 'scenes', 'secret.css');
  await write(other, '.x { content: "Q-ONLY-MARKER"; }\n@value secret: "Q-ONLY-MARKER";\n');
  const map = JSON.stringify({ version: 3, sources: [other], mappings: 'AAAA', names: [] });
  const scenes = path.join(projectsDir, 'p', 'scenes');
  await write(
    path.join(scenes, 'inline.tsx'),
    `export const a = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n`,
  );
  await write(path.join(scenes, 'mapped.js'), 'export const b = 1;\n//# sourceMappingURL=mapped.js.map\n');
  await write(path.join(scenes, 'mapped.js.map'), map);
  await write(path.join(scenes, 'm.module.css'), '.a { composes: x from "../../q/scenes/secret.css"; }\n');
  await write(path.join(scenes, 'v.module.css'), '@value secret from "../../q/scenes/secret.css";\n.a { content: secret; }\n');
  for (const name of ['inline.tsx', 'mapped.js', 'm.module.css', 'v.module.css', 'm.module.css?inline']) {
    const { status, body } = await request(port, `/@fs${scenes}/${name}`, { headers: secret });
    assert.equal(status, 200, name);
    assert.doesNotMatch(withMaps(body), /Q-ONLY-MARKER/, name);
  }
  // Vite names a module an import resolved by its real path, here not the configured one, and serves it from then on.
  await write(path.join(scenes, 'hop.css'), '@import "../../q/scenes/secret.css";\n');
  await write(path.join(scenes, 'hops.tsx'), "import './hop.css';\n");
  const real = await fs.realpath(scenes);
  assert.notEqual(real, scenes);
  assert.equal((await request(port, `/@fs${scenes}/hops.tsx`, { headers: secret })).status, 200);
  const { status, body } = await request(port, `/@fs${real}/hop.css`, { headers: secret });
  // In middleware mode Vite hands a module that fails to compile on, and nothing after it answers.
  assert.equal(status, 404);
  assert.doesNotMatch(withMaps(body), /Q-ONLY-MARKER/);
  const error = await diagnoseFile(vite!, path.join(real, 'hop.css'), async () => true);
  assert.match(error ?? '', /is outside this stylesheet's project, brand and the templates/);
});

test("a scene's own files still load as Vite's asset modules: ?import, ?raw, ?url, ?inline", async () => {
  const scenes = path.join(config.projectsDir, 'p', 'scenes');
  await write(path.join(scenes, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // The URLs a scene's imports are rewritten to, asked before any import of them: Vite's own pre-transform, which skips
  // its access check, would otherwise have answered them already.
  // A managed file is never inlined unasked: Vite would read it through a link.
  const modules: [string, RegExp][] = [
    ['?import', /export default "\/@fs\/[^"]*\/mark\.svg"/],
    ['?import&raw', /export default "<svg /],
    ['?import&url', /export default "\/@fs\/[^"]*\/mark\.svg"/],
    ['?import&inline', /export default "data:image\/svg\+xml;base64,/],
  ];
  for (const [query, module] of modules) {
    const url = `/@fs${await fs.realpath(scenes)}/mark.svg${query}`;
    const { status, body } = await request(port, url, { headers: secret });
    assert.equal(status, 200, url);
    assert.match(body, module, url);
  }
});

test("a scene's packages are the app's, never one its project brings in a node_modules", async () => {
  const { projectsDir } = config;
  const project = path.join(projectsDir, 'p');
  await write(path.join(projectsDir, 'q', 'scenes', 'deps.ts'), 'export default "Q-ONLY-MARKER";\n');
  await write(path.join(project, 'node_modules', 'evil', 'package.json'), JSON.stringify({ name: 'evil', main: 'index.js' }));
  await write(path.join(project, 'node_modules', 'evil', 'index.js'), "export { default } from '../../../q/scenes/deps.ts';\n");
  await write(path.join(project, 'package.json'), JSON.stringify({ imports: { '#evil': 'evil' } }));
  const imports = {
    bare: 'evil',
    subpath: '#evil',
    alias: '@brands/../projects/p/node_modules/evil/index.js',
    app: 'clsx',
  };
  try {
    for (const [name, source] of Object.entries(imports)) {
      const scene = path.join(project, 'scenes', `${name}.tsx`);
      await write(scene, `import x from '${source}';\nexport default () => x;\n`);
      const { status, body } = await request(port, `/@fs${scene}`, { headers: secret });
      if (name === 'app') assert.equal(status, 200);
      // The dependency optimizer bundles what a package imports with none of the frame's checks.
      for (const url of [`/@fs${scene}`, ...[...body.matchAll(/from "(\/[^"]+)"/g)].map((match) => match[1]!)]) {
        const module = await request(port, url, { headers: secret });
        assert.doesNotMatch(withMaps(module.body), /Q-ONLY-MARKER/, `${name}: ${url}`);
      }
    }
  } finally {
    await fs.rm(path.join(project, 'node_modules'), { recursive: true });
    await fs.rm(path.join(project, 'package.json'));
  }
});

test("a scene compiles with the app's TypeScript settings, never those a tsconfig.json of its project points to", async () => {
  const { projectsDir } = config;
  await write(
    path.join(projectsDir, 'q', 'settings.json'),
    JSON.stringify({ compilerOptions: { jsxImportSource: 'Q-ONLY-MARKER' } }),
  );
  const settings = path.join(projectsDir, 'p', 'tsconfig.json');
  await write(settings, JSON.stringify({ extends: '../q/settings.json' }));
  const scene = path.join(projectsDir, 'p', 'scenes', 'jsx.tsx');
  await write(scene, 'export default () => <div />;\n');
  try {
    // The diagnostics would name the settings in their error, as Vite's overlay would in the frame.
    assert.equal(await diagnoseFile(vite!, scene, async () => true), null);
    const { status, body } = await request(port, `/@fs${scene}`, { headers: secret });
    assert.equal(status, 200);
    assert.doesNotMatch(withMaps(body), /Q-ONLY-MARKER/);
  } finally {
    await fs.rm(settings);
  }
});

test('a brand theme is compiled only for the project of the origin that asks, never on a brand origin', async () => {
  const theme = path.join(config.brandsDir, 'cadence', 'theme.css');
  const project = path.join(config.projectsDir, 'p', 'project.json');
  // A project of the same brand, whose classes the theme would hold.
  const other = path.join(config.projectsDir, 'q', 'project.json');
  await write(theme, "@import 'tailwindcss' source(none);\n");
  await write(project, JSON.stringify({ brand: 'cadence' }));
  await write(other, JSON.stringify({ brand: 'cadence' }));
  try {
    const brandHost = await hostOf('brand', 'cadence');
    const cases: [string, string, number][] = [
      [projectHost, '?inline&project=p', 200],
      [projectHost, '?inline&project=q', 403],
      [projectHost, '?inline&project=p&project=q', 403],
      [projectHost, '?inline&project=%71', 403],
      [projectHost, '?inline&project=%2571', 403],
      // The handler and Vite would read this query differently: Vite refuses a URL with a fragment, which no browser sends.
      [projectHost, '?inline#&project=q', 400],
      [projectHost, '?inline&project=p#&project=q', 400],
      [brandHost, '?inline', 200],
      [brandHost, '?inline&project=p', 403],
      [brandHost, '?inline&project=cadence', 403],
    ];
    for (const [host, query, status] of cases) {
      const response = await request(port, `/@fs${theme}${query}`, { host, headers: secret });
      assert.equal(response.status, status, `${host} ${query}`);
    }
  } finally {
    await fs.rm(theme);
    await fs.rm(project);
    await fs.rm(other);
  }
});

test('a managed file is served with single ranges', async () => {
  const video = path.join(config.projectsDir, 'p', 'assets', 'clip.mp4');
  await write(video, '0123456789'.repeat(100));
  const url = `/@fs${video}`;
  const whole = await request(port, url, { headers: secret });
  assert.deepEqual([whole.status, whole.headers['content-type'], whole.body.length], [200, 'video/mp4', 1000]);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  const part = await request(port, url, { headers: { ...secret, range: 'bytes=10-24' } });
  assert.deepEqual([part.status, part.headers['content-range'], part.body], [206, 'bytes 10-24/1000', '012345678901234']);
  const past = await request(port, url, { headers: { ...secret, range: 'bytes=2000-' } });
  assert.deepEqual([past.status, past.headers['content-range']], [416, 'bytes */1000']);
  const head = await request(port, url, { method: 'HEAD', headers: secret });
  assert.deepEqual([head.status, head.headers['content-length'], head.body], [200, '1000', '']);
  const suffix = await request(port, url, { headers: { ...secret, range: 'bytes=-5' } });
  assert.deepEqual([suffix.status, suffix.headers['content-range'], suffix.body], [206, 'bytes 995-999/1000', '56789']);
  const empty = path.join(config.projectsDir, 'p', 'assets', 'empty.mp4');
  await write(empty, '');
  const none = await request(port, `/@fs${empty}`, { headers: secret });
  assert.deepEqual([none.status, none.headers['content-length'], none.body], [200, '0', '']);
  const noPart = await request(port, `/@fs${empty}`, { headers: { ...secret, range: 'bytes=0-' } });
  assert.deepEqual([noPart.status, noPart.headers['content-range']], [416, 'bytes */0']);
});

test("a project's .env, key files and .cadence folder are never served, also past the origin's check", async () => {
  const behind = http.createServer(vite!.middlewares);
  await new Promise<void>((resolve) => behind.listen(0, '127.0.0.1', resolve));
  const dir = path.join(config.projectsDir, 'p');
  const names = ['.env', '.env.local', 'assets/key.pem', 'assets/id.key', '.cadence/chats/c.json', 'scenes/.npmrc'];
  for (const name of names) await write(path.join(dir, name), 'DENIED-MARKER\n');
  try {
    for (const name of names) {
      for (const query of ['', '?raw', '?import&raw', '?url']) {
        const url = `/@fs${dir}/${name}${query}`;
        for (const [to, host] of [
          [port, projectHost],
          [(behind.address() as AddressInfo).port, projectHost],
        ] as const) {
          const { status, body } = await request(to, url, { host, headers: secret });
          assert.doesNotMatch(withMaps(body), /DENIED-MARKER/, `${to} ${url}`);
          if (!query) assert.equal(status, 403, `${to} ${url}`);
        }
      }
    }
  } finally {
    behind.close();
    for (const name of names) await fs.rm(path.join(dir, name));
  }
});

test('a managed file swapped for a link after the origin checked it gives nothing of what the link names', async () => {
  // Vite's own middlewares, past the frame handler's check: what they read when the swap lands in between.
  const behind = http.createServer(vite!.middlewares);
  await new Promise<void>((resolve) => behind.listen(0, '127.0.0.1', resolve));
  const scenes = path.join(config.projectsDir, 'p', 'scenes');
  // Outside the managed folders, and in another project: a link there would pass for a file of the managed folders.
  const targets = [
    path.join(path.dirname(config.projectsDir), 'outside'),
    path.join(config.projectsDir, 'q', 'scenes', 'secret'),
  ];
  const names = ['notes.txt', 'notes.mp4', 'notes.svg', 'notes.css', 'notes.tsx', 'notes.json'];
  // A string: valid JSON and JavaScript, kept whole in what Vite compiles.
  for (const target of targets) for (const name of names) await write(target + path.extname(name), '"OUTSIDE-MARKER"\n');
  await write(path.join(scenes, 'kept.txt'), 'kept\n');
  await write(path.join(scenes, 'kept.json'), '"kept"\n');
  try {
    for (const target of targets) {
      for (const name of names) {
        await fs.rm(path.join(scenes, name), { force: true });
        await fs.symlink(target + path.extname(name), path.join(scenes, name));
        for (const query of [
          '',
          '?raw',
          '?import&raw',
          '?import&inline',
          '?import&url',
          '?inline',
          '?import',
          '?url&inline',
          '?import&url&inline',
          '?inline&url',
          // A query ending in `.css`, with `raw=`, `url=` or `worker=` keeping it from compiling as CSS.
          '?raw=1&inline&x=.css',
          '?url=1&inline&x=.css',
          '?inline&worker=1&x=.css',
        ]) {
          for (const dir of [scenes, await fs.realpath(scenes)]) {
            const url = `/@fs${dir}/${name}${query}`;
            const { body } = await request((behind.address() as AddressInfo).port, url, { headers: secret });
            assert.doesNotMatch(withMaps(body), /OUTSIDE-MARKER/, `${path.relative(config.projectsDir, target)}: ${url}`);
          }
        }
      }
    }
    const kept = await request((behind.address() as AddressInfo).port, `/@fs${scenes}/kept.txt?raw`, { headers: secret });
    assert.match(kept.body, /kept/);
    const inlined = await request((behind.address() as AddressInfo).port, `/@fs${scenes}/kept.json?url&inline`, {
      headers: secret,
    });
    assert.match(withMaps(inlined.body), /"kept"/);
  } finally {
    behind.close();
    for (const name of names) await fs.rm(path.join(scenes, name), { force: true });
    for (const target of targets) for (const name of names) await fs.rm(target + path.extname(name), { force: true });
  }
});

test('a pipe named like an asset is refused by the origin, and Vite behind it never waits on one', async () => {
  const behind = http.createServer(vite!.middlewares);
  await new Promise<void>((resolve) => behind.listen(0, '127.0.0.1', resolve));
  const scenes = path.join(config.projectsDir, 'p', 'scenes');
  await fs.mkdir(scenes, { recursive: true });
  const pipe = path.join(scenes, 'pipe.svg');
  execFileSync('mkfifo', [pipe]);
  let waited = false;
  // A writer opens without waiting only while a read waits on the pipe, and that read then ends: the test fails instead
  // of hanging.
  const writer = setInterval(() => {
    fs.open(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK).then(
      (file) => {
        waited = true;
        return file.close();
      },
      () => {},
    );
  }, 250);
  try {
    for (const query of ['?import', '?import&url', '']) {
      assert.equal((await request(port, `/@fs${scenes}/pipe.svg${query}`, { headers: secret })).status, 403, query);
      const { status, body } = await request((behind.address() as AddressInfo).port, `/@fs${scenes}/pipe.svg${query}`, {
        headers: secret,
      });
      if (query) assert.match(body, /export default "\/@fs\/[^"]*\/pipe\.svg"/, `${query} ${status}`);
      else assert.equal(status, 404);
    }
    assert.equal(waited, false);
  } finally {
    clearInterval(writer);
    behind.close();
    await fs.rm(pipe, { force: true });
  }
});

test("a stylesheet's error shows what the frame compiled, never the file a link swapped in names", async () => {
  const scenes = path.join(config.projectsDir, 'p', 'scenes');
  const outside = path.join(path.dirname(config.projectsDir), 'outside.txt');
  const sheet = path.join(scenes, 'broken.css');
  await write(outside, 'line 1\nline 2\nOUTSIDE-MARKER\nline 4\n');
  // Tailwind keeps the open bracket, then postcss refuses it: Vite runs postcss on a stylesheet with a url().
  await write(sheet, '.a { background: url(data:image/png;base64,AA==) }\n.b { --x: [ }\n');
  try {
    const reach = await frameReach(vite!, config, sheet);
    swapNext = { sheet, target: outside };
    const text = (await diagnoseFile(vite!, sheet, reach)) ?? '';
    assert.equal(swapNext, undefined);
    assert.match(text, /Unclosed bracket/);
    assert.match(text, /--x: \[/);
    assert.doesNotMatch(text, /OUTSIDE-MARKER/);
  } finally {
    swapNext = undefined;
    for (const file of [sheet, outside]) await fs.rm(file, { force: true });
  }
});

test('a stylesheet never has the source map it names read: the map could name any file, or be a pipe', async () => {
  const scenes = path.join(config.projectsDir, 'p', 'scenes');
  const outside = path.join(path.dirname(config.projectsDir), 'OUTSIDE-SOURCE.css');
  const sheet = path.join(scenes, 'mapped.css');
  await write(outside, '.b { --x: [ }\n');
  // postcss finds the map's name in a string too, and names the source it maps an error to.
  await write(
    sheet,
    '.a { background: url(data:image/png;base64,AA==); content: "/*# sourceMappingURL=mapped.css.map */" }\n.b { --x: [ }\n',
  );
  const lines = Array.from({ length: 20 }, () => 'AACA').join(';');
  await write(`${sheet}.map`, JSON.stringify({ version: 3, sources: [outside], names: [], mappings: `AAAA;${lines}` }));
  try {
    const text = (await diagnoseFile(vite!, sheet, await frameReach(vite!, config, sheet))) ?? '';
    assert.match(text, /Unclosed bracket/);
    assert.doesNotMatch(text, /OUTSIDE-SOURCE/);
  } finally {
    for (const file of [sheet, `${sheet}.map`, outside]) await fs.rm(file, { force: true });
  }
});

test('a WebAssembly module of a project loads by its URL only: no read through a link for its export names', async () => {
  const behind = http.createServer(vite!.middlewares);
  await new Promise<void>((resolve) => behind.listen(0, '127.0.0.1', resolve));
  const get = async (url: string) => (await request((behind.address() as AddressInfo).port, url, { headers: secret })).body;
  const scenes = path.join(config.projectsDir, 'p', 'scenes');
  const outside = path.join(path.dirname(config.projectsDir), 'outside.wasm');
  // A module whose one export, its memory, is named OUTSIDE_MARKER.
  const name = Buffer.from('OUTSIDE_MARKER');
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 0, 7, name.length + 4, 1, name.length, ...name, 2, 0]);
  await fs.mkdir(scenes, { recursive: true });
  await fs.writeFile(outside, wasm);
  await fs.writeFile(path.join(scenes, 'own.wasm'), wasm);
  await fs.symlink(outside, path.join(scenes, 'linked.wasm'));
  await fs.symlink(outside, path.join(scenes, 'linked.txt'));
  try {
    for (const url of ['linked.wasm?import', 'linked.txt?vite-wasm-instance&import', 'own.wasm?import']) {
      assert.doesNotMatch(await get(`/@fs${scenes}/${url}`), /OUTSIDE_MARKER/, url);
    }
    assert.match(await get(`/@fs${scenes}/own.wasm?import&url`), /export default "\/@fs\/[^"]*\/own\.wasm"/);
    assert.match(await get(`/@fs${scenes}/own.wasm?import&init`), /\/@fs\/[^"]*\/own\.wasm/);
  } finally {
    behind.close();
    for (const file of ['own.wasm', 'linked.wasm', 'linked.txt']) await fs.rm(path.join(scenes, file), { force: true });
    await fs.rm(outside, { force: true });
  }
});
