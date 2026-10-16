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
import { createVite } from '../../server/frames/vite';
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
  cleanup = root.cleanup;
  const repo = path.resolve(import.meta.dirname, '../..');
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(repo, 'node_modules/.vite-e2e/frame-secret');
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const { projectsDir, brandsDir, templatesDir, stateDir } = root.config;
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
  assert.equal(await status(await hostOf('project', 'later')), 200, 'a new project');
  assert.equal(await status(await hostOf('brand', 'later'), '/kit.html?brand=later'), 200, 'a new brand');
  await fs.rm(path.join(config.projectsDir, 'later'), { recursive: true });
  assert.equal(await status(await hostOf('project', 'later')), 403, 'a deleted project keeps no origin');
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
