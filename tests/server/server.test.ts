// startServer() wiring: real Vite, stores and handlers on free ports; data dirs in a temp root, fake agent and ElevenLabs.
// Chromium only for the CSP session, which CI does not let skip.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import type { ElevenLabsApi } from '../../server/contracts';
import { m } from '../../server/i18n';
import { startServer, type RunningServer } from '../../server/index';
import { frameGet, makeRoot, type TestRoot } from './helpers';

let t: TestRoot;
let server: RunningServer;

const provider = {
  id: 'fake',
  label: 'Agent de test',
  status: async () => ({ ok: true, label: 'Agent de test' }),
  async *run() {
    yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
  },
};

const ELEVENLABS_KEY = `sk_wiring_${process.pid}`;
const elevenLabs: ElevenLabsApi = {
  voices: async () => [
    { id: 'voiceAlice1', name: 'Alice', category: 'premade', previewUrl: 'https://example.invalid/a.mp3', languages: ['fr'] },
  ],
  models: async () => [{ id: 'eleven_multilingual_v2', name: 'Multilingual v2' }],
  speak: async () => undefined,
  preview: async () => Buffer.from('ID3'),
};

before(async () => {
  // Own dependency cache: test files run in parallel and must not disturb a running Cadence.
  process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/wiring');
  t = await makeRoot();
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
    elevenLabs,
  });
});

after(async () => {
  await server?.close();
  await t.cleanup();
});

/** The editor page's CSP, as server/http.ts writes it for the frame port: one origin per project and per brand. */
const editorCsp = (framePort: number) =>
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  `font-src 'self' data: http://*.localhost:${framePort}; media-src 'self' blob:; connect-src 'self'; ` +
  `object-src 'none'; base-uri 'none'; form-action 'self'; frame-src http://*.localhost:${framePort}; frame-ancestors 'none'`;
/** A script tag without `src`: inline code, which the editor's CSP would block. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>/;
/** What the editor origin serves besides its page: a document there runs nothing and loads nothing. */
const SANDBOX_CSP = "default-src 'none'; sandbox";

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

  const frame = JSON.parse(
    (await frameGet(frameOrigin, { kind: 'project', id: 'integration' }, '/frame-api/projects/integration')).body,
  );
  assert.equal(frame.brandId, 'orbit');
  assert.equal(frame.project.scenes[0].url, `/@fs${path.join(t.config.projectsDir, 'integration', 'scenes', 'titre.tsx')}`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  await sse;
  assert.match(events.join(''), /data: \{"type":"projects-changed"\}/);
  assert.match(await fs.readFile(path.join(t.config.projectsDir, 'CLAUDE.md'), 'utf8'), /\S/, 'terminal guide written');
});

test("a scene importing another project's file gets the diagnostic that names it, never the file", async () => {
  const { editorOrigin } = server.config;
  const headers = { 'content-type': 'application/json', 'x-cadence-token': server.editorToken };
  const body = JSON.stringify({ name: 'Diagnostics', brand: 'orbit', formats: ['16:9'], fps: 30 });
  const project = await (await fetch(`${editorOrigin}/api/projects`, { method: 'POST', body, headers })).json();
  const other = path.join(t.config.projectsDir, 'other', 'scenes', 'secret.tsx');
  await fs.mkdir(path.dirname(other), { recursive: true });
  await fs.writeFile(other, 'export const secret = 1;\n');
  const scene = project.scenes[0].id;
  await fs.writeFile(
    path.join(t.config.projectsDir, project.id, 'scenes', `${scene}.tsx`),
    "import { secret } from '../../other/scenes/secret';\nexport default () => secret;\n",
  );
  const res = await fetch(`${editorOrigin}/api/projects/${project.id}/scenes/${scene}/diagnostics`, { headers });
  assert.deepEqual(await res.json(), { error: m().api.frames.notServed(await fs.realpath(other)) });
});

test('a scene importing its own component that fails to compile gets the compile error', async () => {
  const { editorOrigin } = server.config;
  const headers = { 'content-type': 'application/json', 'x-cadence-token': server.editorToken };
  const body = JSON.stringify({ name: 'Broken component', brand: 'orbit', formats: ['16:9'], fps: 30 });
  const project = await (await fetch(`${editorOrigin}/api/projects`, { method: 'POST', body, headers })).json();
  const component = path.join(t.config.projectsDir, project.id, 'components', 'broken.tsx');
  await fs.mkdir(path.dirname(component), { recursive: true });
  await fs.writeFile(component, 'export const broken = ;\n');
  const scene = project.scenes[0].id;
  await fs.writeFile(
    path.join(t.config.projectsDir, project.id, 'scenes', `${scene}.tsx`),
    "import { broken } from '../components/broken';\nexport default () => broken;\n",
  );
  const res = await fetch(`${editorOrigin}/api/projects/${project.id}/scenes/${scene}/diagnostics`, { headers });
  const { error } = (await res.json()) as { error: string };
  assert.match(error, /PARSE_ERROR[\s\S]*broken\.tsx/);
});

test('serves the editor from a production build: no Vite module, React production, cached assets, byte ranges', async () => {
  const { editorOrigin, framePort } = server.config;
  const page = await fetch(`${editorOrigin}/`);
  assert.equal(page.headers.get('content-security-policy'), editorCsp(framePort));
  const html = await page.text();
  assert.doesNotMatch(html, INLINE_SCRIPT);
  assert.doesNotMatch(html, /@vite\/client|\/src\/editor/);
  const script = /<script type="module" crossorigin src="(\/assets\/index-[\w-]+\.js)">/.exec(html)?.[1];
  assert.ok(script, html);
  const res = await fetch(`${editorOrigin}${script}`);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('content-security-policy'), SANDBOX_CSP);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
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

test(
  'the built editor runs a session with no CSP violation and blocks an injected inline script',
  { timeout: 120_000 },
  async (c) => {
    const browser = await chromium.launch().catch(() => null);
    if (!browser) {
      assert.ok(!process.env.CI, 'Chromium missing in CI');
      return c.skip('Chromium missing (npm run setup)');
    }
    const { editorOrigin } = server.config;
    const headers = { 'content-type': 'application/json', 'x-cadence-token': server.editorToken };
    const body = JSON.stringify({ name: 'Politique', brand: 'orbit', formats: ['16:9'], fps: 30 });
    assert.equal((await fetch(`${editorOrigin}/api/projects`, { method: 'POST', body, headers })).status, 200);
    const key = JSON.stringify({ key: ELEVENLABS_KEY });
    assert.equal((await fetch(`${editorOrigin}/api/voices/elevenlabs/key`, { method: 'PUT', body: key, headers })).ok, true);
    try {
      const page = await browser.newPage({ locale: 'fr-FR' });
      await page.route('**/thumbnail?**', (route) => route.abort());
      // Kept on this side: a reload would wipe a list kept in the page. The editor's own, not the frames'.
      const violations: string[] = [];
      await page.exposeBinding('cadenceViolation', ({ frame }, violation: string) => {
        if (frame === page.mainFrame()) violations.push(violation);
      });
      await page.addInitScript(() => {
        const w = window as unknown as { cadenceViolation: (violation: string) => Promise<void> };
        document.addEventListener(
          'securitypolicyviolation',
          (e) => void w.cadenceViolation(`${e.effectiveDirective} ${e.blockedURI}`),
        );
      });
      await page.goto(`${editorOrigin}/`);
      await page.getByRole('heading', { name: 'Projets' }).waitFor({ timeout: 60_000 });
      await page.goto(`${editorOrigin}/#/politique/titre`);
      await page.getByRole('group', { name: 'Panneau' }).waitFor({ timeout: 60_000 });
      await page.frameLocator('iframe[src*="/frame.html"]').locator('#root').waitFor({ state: 'attached', timeout: 30_000 });
      // The voice sample plays from the editor origin (media-src 'self').
      await page.goto(`${editorOrigin}/#/@profil`);
      const card = page.getByRole('listitem', { name: 'ElevenLabs' });
      await card.getByRole('combobox', { name: 'Voix des nouveaux projets' }).selectOption('voiceAlice1', { timeout: 60_000 });
      const sample = page.waitForResponse((r) => r.url().endsWith('/api/voices/elevenlabs/voiceAlice1/preview'));
      await card.getByRole('button', { name: 'Écouter un extrait de la voix Alice' }).click();
      assert.equal((await sample).status(), 200);
      // A copy: asserting on the list itself would narrow its type to never[] for the check below.
      assert.deepEqual([...violations], []);

      const ran = await page.evaluate(() => {
        const script = document.createElement('script');
        script.textContent = 'window.inlineRan = true';
        document.head.append(script);
        return (window as unknown as { inlineRan?: boolean }).inlineRan ?? false;
      });
      assert.equal(ran, false);
      const deadline = Date.now() + 10_000;
      while (!violations.some((v) => v.startsWith('script-src-elem inline'))) {
        assert.ok(Date.now() < deadline, `no violation for the inline script: ${violations.join(', ')}`);
        await page.waitForTimeout(50);
      }
    } finally {
      await browser.close();
      await fetch(`${editorOrigin}/api/voices/elevenlabs/key`, { method: 'DELETE', headers });
    }
  },
);

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

test('a request secret of 32 characters reaches both servers: 403 without X-Cadence-Secret, 200 with it', async () => {
  const requestSecret = 'x'.repeat(32);
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  const guarded = await startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    provider,
    requestSecret,
  });
  try {
    assert.equal(guarded.config.requestSecret, requestSecret);
    const { editorOrigin, frameOrigin } = guarded.config;
    const secret = { 'x-cadence-secret': requestSecret };
    assert.equal((await fetch(`${editorOrigin}/`)).status, 403);
    assert.equal((await fetch(`${editorOrigin}/`, { headers: secret })).status, 200, 'the editor with the secret');
    const kit = { kind: 'brand', id: 'cadence' } as const;
    assert.equal((await frameGet(frameOrigin, kit, '/kit.html?brand=cadence')).status, 403);
    assert.equal((await frameGet(frameOrigin, kit, '/kit.html?brand=cadence', secret)).status, 200, 'a kit with the secret');
  } finally {
    await guarded.close();
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
    const { editorOrigin, framePort } = dev.config;
    const page = await fetch(`${editorOrigin}/`);
    assert.equal(page.headers.get('content-security-policy'), editorCsp(framePort));
    const html = await page.text();
    assert.match(html, /\/@vite\/client[\s\S]*\/src\/editor\/main\.tsx/);
    assert.doesNotMatch(html, INLINE_SCRIPT);
    assert.doesNotMatch(html, /\/@react-refresh/, 'no React preamble');
    assert.equal((await fetch(`${editorOrigin}/src/editor/main.tsx`)).status, 200);
    // A file an agent wrote, opened by the person: it must not run next to the editor token.
    const svg = path.join(projectsDir, 'agent-files', 'logo.svg');
    await fs.mkdir(path.dirname(svg), { recursive: true });
    await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const file = await fetch(`${editorOrigin}/@fs${svg}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type') ?? '', /svg/);
    assert.equal(file.headers.get('content-security-policy'), SANDBOX_CSP);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(process.env.NODE_ENV, 'development');
  } finally {
    await dev.close();
  }
});
