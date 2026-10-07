import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { createEditorHandler } from '../../server/http';
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
  const api = new Hono();
  api.all('*', (c) => c.json({ ok: true, method: c.req.method, path: c.req.path }));
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const handler = createEditorHandler({
    config: { ...t.config, editorPort: port, frameOrigin: 'http://127.0.0.1:5300' },
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
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await t.cleanup();
});

function request(
  path: string,
  { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
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
  assert.equal((await request('/api/state', { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request('/api/state')).status, 200);
});

test('mutating API requests need the editor token', async () => {
  let res = await request('/api/projects', { method: 'POST' });
  assert.equal(res.status, 403);
  // The editor reloads on `code`, never on the wording, which follows the language.
  assert.deepEqual(JSON.parse(res.body), { error: 'Jeton Cadence manquant ou invalide', code: 'token' });
  assert.equal((await request('/api/projects', { method: 'POST', headers: { 'x-cadence-token': 'wrong' } })).status, 403);
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
  // The subtitles download too: scene code in the frame must not read the voice-over text.
  for (const route of ['/api/state', '/api/projects/demo/subtitles?format=srt'])
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
  assert.equal(res.headers['content-security-policy'], "frame-src http://127.0.0.1:5300; frame-ancestors 'none'");
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
  assert.equal((await request('/oauth/youtube/callback?state=good', { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal(
    (await request('/oauth/youtube/callback', { method: 'POST', headers: back })).body,
    'vite:/oauth/youtube/callback',
  );
});
