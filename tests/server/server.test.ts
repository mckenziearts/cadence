// startServer() wiring: real Vite, stores and handlers on free ports; data dirs in a temp root, fake agent, no Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startServer, type RunningServer } from '../../server/index';
import { makeRoot, type TestRoot } from './helpers';

let t: TestRoot;
let server: RunningServer;

before(async () => {
  // Own dependency cache: test files run in parallel and must not disturb a running Cadence.
  process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/wiring');
  t = await makeRoot();
  const provider = {
    id: 'fake',
    label: 'Agent de test',
    status: async () => ({ ok: true, label: 'Agent de test' }),
    async *run() {
      yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
    },
  };
  // The repository stays the Vite root; everything the server writes goes to the temp root.
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  server = await startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    provider,
  });
});

after(async () => {
  await server?.close();
  await t.cleanup();
});

test('both origins listen on 127.0.0.1 with the real ports', () => {
  const { editorPort, framePort, editorOrigin, frameOrigin, mcpUrl } = server.config;
  assert.ok(editorPort > 0 && framePort > 0 && editorPort !== framePort);
  assert.equal(editorOrigin, `http://127.0.0.1:${editorPort}`);
  assert.equal(frameOrigin, `http://localhost:${framePort}`);
  assert.equal(mcpUrl, `${editorOrigin}/mcp`);
});

test('editor HTML, API, SSE and frame data are wired together', async () => {
  const { editorOrigin, frameOrigin } = server.config;
  const html = await (await fetch(`${editorOrigin}/`)).text();
  assert.ok(html.includes(`<meta name="cadence-token" content="${server.editorToken}" />`));
  assert.ok(html.includes(`<meta name="cadence-frame-origin" content="${frameOrigin}" />`));
  assert.equal((await fetch(`${editorOrigin}/frame.html`)).status, 404);

  const state = await (await fetch(`${editorOrigin}/api/state`)).json();
  assert.deepEqual(state.agent, { ok: true, label: 'Agent de test' });
  assert.equal(state.frameOrigin, frameOrigin);

  const events: string[] = [];
  const controller = new AbortController();
  const sse = fetch(`${editorOrigin}/api/events`, { signal: controller.signal })
    .then(async (res) => {
      for await (const chunk of res.body!) events.push(Buffer.from(chunk).toString());
    })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const body = JSON.stringify({ name: 'Intégration', brand: 'orbit', formats: ['16:9'], fps: 30 });
  assert.equal((await fetch(`${editorOrigin}/api/projects`, { method: 'POST', body })).status, 403);
  const res = await fetch(`${editorOrigin}/api/projects`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'x-cadence-token': server.editorToken },
  });
  const project = await res.json();
  assert.equal(project.id, 'integration');

  const frame = await (await fetch(`${frameOrigin}/frame-api/projects/integration`)).json();
  assert.equal(frame.brandId, 'orbit');
  assert.equal(frame.project.scenes[0].url, `/@fs${path.join(t.config.projectsDir, 'integration', 'scenes', 'titre.tsx')}`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  await sse;
  assert.match(events.join(''), /data: \{"type":"projects-changed"\}/);
  assert.match(await fs.readFile(path.join(t.config.projectsDir, 'CLAUDE.md'), 'utf8'), /\S/, 'terminal guide written');
});

test('serves the editor from a production build: no Vite module, React production, cached assets, byte ranges', async () => {
  const { editorOrigin } = server.config;
  const html = await (await fetch(`${editorOrigin}/`)).text();
  assert.doesNotMatch(html, /@vite\/client|\/src\/editor/);
  const script = /<script type="module" crossorigin src="(\/assets\/index-[\w-]+\.js)">/.exec(html)?.[1];
  assert.ok(script, html);
  const res = await fetch(`${editorOrigin}${script}`);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const js = await res.text();
  assert.match(js, /Minified React error/, "React's production build");
  const wav = /\/assets\/pop-[\w-]+\.wav/.exec(js)?.[0];
  assert.ok(wav, 'the sound effects are bundled assets');
  assert.equal((await fetch(`${editorOrigin}${wav}`)).headers.get('content-type'), 'audio/wav');
  for (const url of ['/src/editor/main.tsx', '/@vite/client', '/assets/missing.js', `/@fs${path.resolve('package.json')}`]) {
    assert.equal((await fetch(`${editorOrigin}${url}`)).status, 404, url);
  }
  const size = Buffer.byteLength(js);
  const head = await fetch(`${editorOrigin}${script}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-9/${size}`);
  assert.equal(await head.text(), js.slice(0, 10));
  const tail = await fetch(`${editorOrigin}${script}`, { headers: { range: 'bytes=-5' } });
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 5}-${size - 1}/${size}`);
  assert.equal((await fetch(`${editorOrigin}${script}`, { headers: { range: `bytes=${size}-` } })).status, 416);
});

test('close() stops both servers', async () => {
  const { editorOrigin } = server.config;
  await server.close();
  await assert.rejects(fetch(`${editorOrigin}/api/state`));
});

test('refuses to start on Windows, where no scene could load, and names WSL 2', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
    await assert.rejects(
      startServer({ projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0, quiet: true }),
      /WSL 2/,
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('npm run dev serves the editor through Vite, with React in development', async () => {
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  const dev = await startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    dev: true,
  });
  try {
    const { editorOrigin } = dev.config;
    assert.match(await (await fetch(`${editorOrigin}/`)).text(), /\/@vite\/client[\s\S]*\/src\/editor\/main\.tsx/);
    assert.equal((await fetch(`${editorOrigin}/src/editor/main.tsx`)).status, 200);
    assert.equal(process.env.NODE_ENV, 'development');
  } finally {
    await dev.close();
  }
});
