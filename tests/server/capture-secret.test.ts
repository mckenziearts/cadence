// Capture and render pages on a frame origin that requires X-Cadence-Secret: startServer() with a request secret, real
// Vite and Chromium (installed in CI), fake agent. Data dirs in a temp root holding a copy of the repo's cadence brand.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { launchChromium } from '../../server/capture/capture';
import { startServer, type RunningServer } from '../../server/index';
import { makeRoot, type TestRoot } from './helpers';

const repo = path.resolve(import.meta.dirname, '../..');
let t: TestRoot;
let server: RunningServer;
let projectId: string;
let chromiumInstalled = true;

const provider = {
  id: 'fake',
  label: 'Agent de test',
  status: async () => ({ ok: true, label: 'Agent de test' }),
  async *run() {
    yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
  },
};

before(async () => {
  try {
    await (await launchChromium()).close();
  } catch (e) {
    if (!/Executable doesn't exist/i.test((e as Error).message)) throw e;
    chromiumInstalled = false;
  }
  // Own dependency cache: test files run in parallel and must not disturb a running Cadence.
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(repo, 'node_modules/.vite-e2e/capture-secret');
  t = await makeRoot();
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  // The kit sheet and the scenes need a whole brand kit (index.tsx, theme.css), not only the brand.json fixture.
  await fs.cp(path.join(repo, 'brands/cadence'), path.join(brandsDir, 'cadence'), { recursive: true, force: true });
  server = await startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    provider,
    requestSecret: 's'.repeat(32),
  });
  projectId = (await server.services.store.create({ name: 'Secret', brand: 'cadence', formats: ['16:9'], fps: 30 })).id;
});

after(async () => {
  await server?.close();
  await t?.cleanup();
});

/** Skips a test that needs Chromium, except in CI, where the workflow installs it and a skip would hide the check. */
function needsChromium(t: TestContext): boolean {
  if (chromiumInstalled) return true;
  assert.ok(!process.env.CI, 'Chromium missing in CI: the workflow must run npm run setup');
  t.skip('Chromium missing (npm run setup)');
  return false;
}

test('the frame origin refuses a request without the secret', async () => {
  assert.equal((await fetch(`${server.config.frameOrigin}/frame.html?project=${projectId}`)).status, 403);
});

test('captures a scene frame through a frame origin that requires the request secret', async (t) => {
  if (!needsChromium(t)) return;
  const [shot] = await server.services.capture.frames(projectId, { sceneId: null, times: [0.25], format: '16:9' });
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.image.length > 0);
});

test('renders the kit sheet of a brand behind the request secret', async (t) => {
  if (!needsChromium(t)) return;
  const kit = await server.services.capture.kitSheet('cadence');
  assert.deepEqual([kit.loaded, kit.problems], [true, []]);
  assert.ok(kit.image.length > 0);
});

test('renders a draft video behind the request secret', async (t) => {
  if (!needsChromium(t)) return;
  const { renders } = server.services;
  const [queued] = await renders.start(projectId, { formats: ['16:9'], quality: 'draft', range: { from: 0, to: 0.5 } });
  const job = await renders.wait(queued.id);
  assert.equal(job.status, 'done', job.error ?? job.status);
  assert.ok(job.framesTotal > 0);
  assert.equal(job.framesDone, job.framesTotal);
});

test('never sends the request secret to a reference site', async (t) => {
  if (!needsChromium(t)) return;
  const seen: http.IncomingHttpHeaders[] = [];
  const site = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('Content-Type', 'text/html');
    res.end('<body><h1>Référence</h1><img src="/logo.png"></body>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  try {
    await server.services.capture.screenshotUrl(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`, {
      device: 'desktop',
    });
    assert.ok(seen.length >= 2, 'the page and its image');
    for (const headers of seen) assert.equal(headers['x-cadence-secret'], undefined);
  } finally {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
  }
});
