import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import type { CadenceConfig } from '../../server/contracts';
import { createEditorHandler } from '../../server/http';
import { startServer } from '../../server/index';
import { makeRoot, type TestRoot } from './helpers';

const TOKEN = 'editor-token-123';
const MCP_TOKEN = 'mcp-token-456';

let t: TestRoot;
let server: http.Server;
let port: number;

before(async () => {
  t = await makeRoot();
  await fs.writeFile(
    `${t.root}/index.html`,
    '<!doctype html>\n<html>\n  <head>\n    <title>Cadence</title>\n  </head>\n  <body></body>\n</html>\n',
  );
  ({ server, port } = await listenEditor());
});

async function listenEditor(config: Partial<CadenceConfig> = {}): Promise<{ server: http.Server; port: number }> {
  const api = new Hono();
  api.all('*', (c) => c.json({ ok: true, method: c.req.method, path: c.req.path }));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const handler = createEditorHandler({
    config: { ...t.config, editorPort: port, frameOrigin: 'http://127.0.0.1:5300', ...config },
    editorToken: TOKEN,
    tokens: { resolve: (token) => (token === MCP_TOKEN ? { kind: 'open' } : null) },
    accounts: {
      callback: async (network, params) =>
        params.get('state') === 'good'
          ? { ok: true, title: `${network} connecté`, detail: 'Tu peux fermer cet onglet.' }
          : { ok: false, title: 'Lien de connexion expiré', detail: `<script>${params.get('error')}</script>` },
    },
    api,
    mcp: async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"mcp":true}');
    },
    // What Vite's dev server would answer (`npm run dev`); the production build is covered in server.test.ts.
    editor: {
      html: async () =>
        (await fs.readFile(`${t.root}/index.html`, 'utf8')).replace(
          '</head>',
          '<script type="module" src="/@vite/client"></script></head>',
        ),
      serve: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`vite:${req.url}`);
      },
    },
  });
  server.on('request', handler);
  return { server, port };
}

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await t.cleanup();
});

function request(
  path: string,
  { method = 'GET', headers = {}, to = port }: { method?: string; headers?: Record<string, string>; to?: number } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: to, path, method, headers: { host: `127.0.0.1:${to}`, ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('Host guard against DNS rebinding', async () => {
  assert.equal((await request('/api/state', { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request('/api/state', { headers: { host: '127.0.0.1:1' } })).status, 403);
  assert.equal((await request('/', { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request('//', { headers: { host: `evil.example:${port}` } })).status, 403, 'before the URL is parsed');
  assert.equal((await request('//')).status, 400);
  assert.equal((await request('/api/state', { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request('/api/state')).status, 200);
});

test('mutating API requests need the editor token', async () => {
  let res = await request('/api/projects', { method: 'POST' });
  assert.equal(res.status, 403);
  // The editor reloads on `code`, never on the wording, which follows the language.
  assert.deepEqual(JSON.parse(res.body), { error: 'Jeton Cadence manquant ou invalide', code: 'token' });
  assert.equal((await request('/api/projects', { method: 'POST', headers: { 'x-cadence-token': 'wrong' } })).status, 403);
  assert.equal((await request('/api/import', { method: 'POST' })).status, 403, 'an archive upload too');
  assert.equal((await request('/api/projects/x', { method: 'DELETE', headers: { 'x-cadence-token': `${TOKEN}x` } })).status, 403);
  assert.equal((await request('/api/projects', { method: 'OPTIONS' })).status, 403, 'preflights are never approved');
  res = await request('/api/projects', {
    method: 'POST',
    headers: { 'x-cadence-token': TOKEN, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, method: 'POST', path: '/api/projects' });
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await request('/api/settings', { method, headers: { 'x-cadence-token': TOKEN } })).status, 200, method);
  }
  // Even with the token, a request from the frame origin (same-site) is refused.
  assert.equal(
    (await request('/api/projects', { method: 'POST', headers: { 'x-cadence-token': TOKEN, 'sec-fetch-site': 'same-site' } }))
      .status,
    403,
  );
});

test('API reads: Sec-Fetch-Site same-origin, none or absent only', async () => {
  for (const site of ['same-origin', 'none'])
    assert.equal((await request('/api/state', { headers: { 'sec-fetch-site': site } })).status, 200, site);
  // The downloads too: scene code in the frame must not read the voice-over text or a project archive.
  for (const route of ['/api/state', '/api/projects/demo/subtitles?format=srt', '/api/projects/demo/export', '/api/export'])
    for (const site of ['same-site', 'cross-site']) {
      const res = await request(route, { headers: { 'sec-fetch-site': site } });
      assert.equal(res.status, 403, `${route} ${site}`);
      assert.deepEqual(JSON.parse(res.body), { error: 'Requête inter-sites refusée' });
    }
});

test('/api/events also accepts ?token=', async () => {
  assert.equal((await request('/api/events', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await request('/api/events?token=wrong', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await request(`/api/events?token=${TOKEN}`, { headers: { 'sec-fetch-site': 'same-site' } })).status, 200);
  assert.equal(
    (await request(`/api/state?token=${TOKEN}`, { headers: { 'sec-fetch-site': 'same-site' } })).status,
    403,
    'only for events',
  );
});

test('/mcp: bearer token required, browsers (Origin) refused', async () => {
  let res = await request('/mcp', { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer');
  assert.equal((await request('/mcp', { method: 'POST', headers: { authorization: 'Bearer nope' } })).status, 401);
  res = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${MCP_TOKEN}` } });
  assert.deepEqual([res.status, res.body], [200, '{"mcp":true}']);
  res = await request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${MCP_TOKEN}`, origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(res.status, 403);
});

test('editor HTML carries the token and the frame origin; frame.html and kit.html are not served here', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  // The previews may only show the frame origin: scene code cannot send its own frame to another site.
  assert.equal(
    res.headers['content-security-policy'],
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
      "font-src 'self' data: http://127.0.0.1:5300; media-src 'self' blob:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'none'; form-action 'self'; frame-src http://127.0.0.1:5300; frame-ancestors 'none'",
  );
  assert.match(res.body, new RegExp(`<head>\\s*<meta name="cadence-token" content="${TOKEN}" />`));
  assert.match(res.body, /<meta name="cadence-frame-origin" content="http:\/\/127\.0\.0\.1:5300" \/>/);
  assert.match(res.body, /@vite\/client/, 'transformed by Vite');
  assert.equal((await request('/index.html')).status, 200);
  assert.equal((await request('/frame.html')).status, 404);
  assert.equal((await request('/frame.html?project=x')).status, 404);
  // A kit is brand code: on this origin it would run next to the token.
  assert.equal((await request('/kit.html?brand=cadence')).status, 404);
  // Vite's open-in-editor would let any website launch the user's code editor with a plain GET.
  assert.equal((await request('/__open-in-editor?file=package.json')).status, 404);
  assert.deepEqual((await request('/src/editor/main.tsx')).body, 'vite:/src/editor/main.tsx');
});

test('what Vite serves besides the page is sandboxed: an SVG an agent wrote runs no script next to the token', async () => {
  for (const path of ['/src/editor/main.tsx', '/@fs/projects/demo/logo.svg']) {
    const res = await request(path);
    assert.equal(res.body, `vite:${path}`);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox", path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
  }
});

test('/oauth/<network>/callback: the cross-site way back from a network, as a page; the state decides', async () => {
  const back = { 'sec-fetch-site': 'cross-site' };
  let res = await request('/oauth/youtube/callback?state=good&code=c', { headers: back });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /^text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'.*frame-ancestors 'none'/);
  assert.match(res.body, /<h1>youtube connecté<\/h1>/);
  assert.match(res.body, /window\.close\(\)/);

  res = await request(`/oauth/youtube/callback?state=bad&error=${encodeURIComponent('"><img src=x>')}`, { headers: back });
  assert.equal(res.status, 400);
  assert.match(res.body, /&#60;script&#62;&#34;&#62;&#60;img src=x&#62;&#60;\/script&#62;/, 'escaped');
  assert.doesNotMatch(res.body, /window\.close/);
  assert.match(res.body, /<a href="\/#\/@profil">Revenir au Profil de Cadence<\/a>/, 'the way back to the editor');
  assert.equal((await request('/oauth/youtube/callback?state=good', { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal(
    (await request('/oauth/youtube/callback', { method: 'POST', headers: back })).body,
    'vite:/oauth/youtube/callback',
  );
});

const SECRET = 's'.repeat(31) + '-request-secret';

test('startServer refuses a request secret shorter than 32 characters', async () => {
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  const started = startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    requestSecret: 'x'.repeat(31),
  });
  // Closed if it ever starts, so a regression fails here instead of leaving servers behind.
  await assert.rejects(
    started.then((server) => server.close()),
    { message: 'Le secret de requête doit compter au moins 32 caractères.' },
  );
});

test('with a request secret, every request needs X-Cadence-Secret but the OAuth callback and /mcp', async (c) => {
  const editor = await listenEditor({ requestSecret: SECRET });
  c.after(async () => {
    editor.server.closeAllConnections();
    await new Promise((resolve) => editor.server.close(resolve));
  });
  const to = editor.port;
  const send = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => request(path, { ...init, to });
  const secret = { 'x-cadence-secret': SECRET };

  for (const path of ['/', '/api/projects', '/src/editor/main.tsx']) {
    assert.equal((await send(path)).status, 403, path);
    assert.equal((await send(path, { headers: { 'x-cadence-secret': `${SECRET}x` } })).status, 403, `${path} wrong secret`);
    assert.equal((await send(path, { headers: secret })).status, 200, `${path} with the secret`);
  }
  let res = await send('/api/projects');
  assert.equal(res.body, 'Secret de requête manquant ou invalide');
  // Before the Host check too: a page that cannot send the header learns nothing.
  assert.equal((await send('/', { headers: { host: `evil.example:${to}` } })).body, res.body);
  const evil = { host: `evil.example:${to}` };
  res = await send('/', { headers: { ...secret, ...evil } });
  assert.deepEqual([res.status, res.body], [403, 'Hôte non autorisé'], 'the Host check still runs with the secret');
  res = await send('/oauth/youtube/callback?state=good', { headers: evil });
  assert.deepEqual([res.status, res.body], [403, 'Hôte non autorisé'], 'and on the exempt callback');
  res = await send('/mcp', { method: 'POST', headers: { ...evil, authorization: `Bearer ${MCP_TOKEN}` } });
  assert.deepEqual([res.status, res.body], [403, 'Hôte non autorisé'], 'and on /mcp');
  res = await send('/api/projects');
  assert.equal((await send('//')).body, res.body, 'a path the URL parser rejects too');
  assert.equal((await send('//', { headers: secret })).status, 400);
  assert.equal(
    (await send('/api/projects', { method: 'POST', headers: { ...secret, 'x-cadence-token': TOKEN } })).status,
    200,
    'the token check still applies after it',
  );
  assert.equal((await send('/api/projects', { method: 'POST', headers: secret })).status, 403);

  const upgrade = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13' };
  assert.equal((await send('/', { headers: upgrade })).status, 403, 'a WebSocket upgrade');
  assert.equal((await send('/', { headers: { ...upgrade, ...secret } })).status, 200);

  res = await send('/oauth/youtube/callback?state=good&code=c', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 200, 'the network sends the person back without the secret');
  res = await send('/oauth/youtube/callback?state=bad', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 400);
  assert.doesNotMatch(res.body, /<a /, 'no way back: the editor in this tab would need the secret');
  assert.equal((await send('/oauth/youtube/callback', { method: 'POST' })).status, 403, 'only the callback itself');
  res = await send('/mcp', { method: 'POST', headers: { authorization: `Bearer ${MCP_TOKEN}` } });
  assert.deepEqual([res.status, res.body], [200, '{"mcp":true}']);
  assert.equal((await send('/mcp', { method: 'POST' })).status, 401, 'the bearer token still guards /mcp');
});
