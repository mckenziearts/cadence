// The frame origin with a request secret: real Vite and frame handler on a free port, no Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ViteDevServer } from 'vite';
import { loadConfig } from '../../server/config';
import { createFrameHandler } from '../../server/frames/frameServer';
import { createVite, diagnoseFile } from '../../server/frames/vite';
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

before(async () => {
  const root = await makeRoot();
  // Reached through a link, as `/var` is on macOS: Vite names a module an import resolved by its real path.
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
  vite = await createVite({ config });
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

/** The body, with the source maps Vite inlines decoded. */
const withMaps = (body: string) =>
  [
    body,
    ...[...body.matchAll(/sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([\w+/=]+)/g)].map(([, map]) =>
      Buffer.from(map!, 'base64').toString(),
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
  // A file this small is inlined as a URL, in dev too.
  const modules: [string, RegExp][] = [
    ['?import', /export default "data:image\/svg\+xml,/],
    ['?import&raw', /export default "<svg /],
    ['?import&url', /export default "data:image\/svg\+xml,/],
    ['?import&inline', /export default "data:image\/svg\+xml,/],
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
