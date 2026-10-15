// The whole server on free ports, over the repository's projects/ (Vite serves scenes from there): create a project
// through the API, render it, fetch the MP4. Its state (settings, accounts, usage) goes to a temp folder.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import { promisify } from 'node:util';
import type { AgentProvider } from '../../server/contracts';
import { startServer, type RunningServer } from '../../server/index';
import type { ProjectState, RenderFile, RenderJob } from '../../src/shared/types';
import { ROOT } from './helpers/harness';

const provider: AgentProvider = {
  id: 'fake',
  label: 'Agent factice',
  status: async () => ({ ok: true, label: 'Agent factice' }),
  async *run() {
    yield { type: 'done', text: '', isError: false, durationMs: 0 };
  },
};

let server: RunningServer;
const id = `e2e-server-${process.pid}`;
const stateDir = path.join(os.tmpdir(), `cadence-e2e-server-${process.pid}`);

before(async () => {
  // Own dependency cache: test files run in parallel and must not disturb a running Cadence.
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(ROOT, 'node_modules/.vite-e2e/server');
  server = await startServer({ editorPort: 0, framePort: 0, quiet: true, provider, root: ROOT, stateDir });
});

after(async () => {
  const { projectsDir } = server.config;
  await server.close();
  await rm(path.join(projectsDir, id), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  const trash = path.join(projectsDir, '.trash');
  for (const name of await readdir(trash).catch(() => [] as string[])) {
    if (name.startsWith(id)) await rm(path.join(trash, name), { recursive: true, force: true });
  }
});

async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${server.config.editorOrigin}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': server.editorToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${pathname}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

it('creates a project, renders it and serves the MP4', { timeout: 180_000 }, async () => {
  const project = await api<ProjectState>('POST', '/api/projects', {
    name: 'E2E serveur',
    id,
    brand: null,
    formats: ['16:9'],
    fps: 30,
  });
  assert.equal(project.id, id);
  assert.ok(project.scenes.length >= 1);

  const thumb = await fetch(`${server.config.editorOrigin}/api/projects/${id}/scenes/${project.scenes[0].id}/thumbnail?t=0.5`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');

  const [queued] = await api<RenderJob[]>('POST', `/api/projects/${id}/renders`, {
    formats: ['16:9'],
    quality: 'draft',
    range: { from: 0, to: Math.min(1, project.duration) },
  });
  const job = await server.services.renders.wait(queued.id);
  assert.equal(job.status, 'done', job.error ?? job.status);
  const file = server.services.renders.resolveFile(id, job.file!);
  assert.ok((await stat(file)).size > 1000);

  const { files } = await api<{ jobs: RenderJob[]; files: RenderFile[] }>('GET', `/api/projects/${id}/renders`);
  assert.equal(files[0].name, job.file);
  const mp4 = await fetch(`${server.config.editorOrigin}${job.url}`);
  assert.equal(mp4.status, 200);
  assert.equal(mp4.headers.get('content-type'), 'video/mp4');

  const args = [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'json',
    file,
  ];
  const { stdout } = await promisify(execFile)('ffprobe', args);
  const frames = (JSON.parse(stdout) as { streams: { nb_read_frames: string }[] }).streams[0].nb_read_frames;
  assert.equal(frames, String(Math.round(Math.min(1, project.duration) * 30)));
});

it(
  "reloads a scene edited on disk through Vite's watcher, which leaves renders and .cadence/ out",
  { timeout: 20_000 },
  async () => {
    const { store, vite } = server.services;
    const project = await store.get(id);
    await store.syncCode(id);
    const reloaded = new Promise<void>((resolve) => {
      const listener = (projectId: string) => {
        if (projectId !== id) return;
        store.events.off('code-changed', listener);
        resolve();
      };
      store.events.on('code-changed', listener);
    });
    const scene = store.sceneFile(id, project.scenes[0].id);
    await writeFile(scene, `${await readFile(scene, 'utf8')}\n// Edited on disk.\n`);
    await reloaded;

    const dir = store.dir(id);
    const watched = Object.keys(vite.watcher.getWatched());
    assert.ok(watched.includes(path.join(dir, 'scenes')));
    for (const left of ['renders', '.cadence']) {
      await stat(path.join(dir, left));
      assert.ok(!watched.some((d) => d === path.join(dir, left) || d.startsWith(path.join(dir, left, path.sep))), left);
    }
  },
);

it(
  'with a request secret, both servers answer on 127.0.0.1 and ::1 only to requests that carry it',
  { timeout: 60_000 },
  async () => {
    const requestSecret = 'x'.repeat(32);
    const guarded = await startServer({
      editorPort: 0,
      framePort: 0,
      quiet: true,
      provider,
      root: ROOT,
      stateDir: `${stateDir}-secret`,
      requestSecret,
    });
    try {
      assert.equal(guarded.config.requestSecret, requestSecret);
      const status = (address: string, port: number, pathname: string, headers: Record<string, string> = {}) =>
        new Promise<number>((resolve, reject) => {
          const req = http.get(
            { host: address, port, path: pathname, headers: { host: `localhost:${port}`, ...headers } },
            (res) => {
              res.resume();
              resolve(res.statusCode!);
            },
          );
          req.on('error', reject);
        });
      const { editorPort, framePort } = guarded.config;
      for (const address of ['127.0.0.1', '::1']) {
        for (const [port, pathname] of [
          [editorPort, '/'],
          [framePort, '/frame.html'],
        ] as const) {
          const where = `[${address}]:${port}${pathname}`;
          assert.equal(await status(address, port, pathname), 403, where);
          assert.equal(
            await status(address, port, pathname, { 'x-cadence-secret': requestSecret }),
            200,
            `${where} with the secret`,
          );
        }
      }
    } finally {
      await guarded.close();
      await rm(`${stateDir}-secret`, { recursive: true, force: true });
    }
  },
);
