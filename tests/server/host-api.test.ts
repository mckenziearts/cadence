// StartOptions.api: a host app's Hono routes mounted under /api/<name>, behind the same guards as the built-in routes.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { m } from '../../server/i18n';
import { startServer, type RunningServer, type StartOptions } from '../../server/index';
import { HttpError } from '../../server/util';
import { makeRoot, type TestRoot } from './helpers';

let t: TestRoot;
let server: RunningServer;
let options: StartOptions;

function hostApp() {
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.get('/ping', (c) => c.json({ pong: 'get' }));
  app.post('/ping', (c) => c.json({ pong: 'post' }));
  app.post('/conflict', () => {
    throw new HttpError(409, 'Host conflict');
  });
  app.post('/boom', () => {
    throw new Error('Host failure');
  });
  return app;
}

before(async () => {
  process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/host-api');
  t = await makeRoot();
  const provider = {
    id: 'fake',
    label: 'Agent de test',
    status: async () => ({ ok: true, label: 'Agent de test' }),
    async *run() {
      yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
    },
  };
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  options = { projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0, quiet: true, provider };
  server = await startServer({ ...options, api: { compte: hostApp() } });
});

after(async () => {
  await server?.close();
  await t?.cleanup();
});

function post(route: string, headers: Record<string, string> = {}) {
  return fetch(`${server.config.editorOrigin}/api/compte${route}`, { method: 'POST', headers });
}

/** Closes a server that should have been refused, so a failing case does not leave it listening. */
async function start(api: StartOptions['api']) {
  const started = await startServer({ ...options, api });
  await started.close();
  return started;
}

test('a host route needs the editor token to mutate', async () => {
  assert.equal((await post('/ping')).status, 403);
  const res = await post('/ping', { 'x-cadence-token': server.editorToken });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pong: 'post' });
});

test('a host GET route answers without the token', async () => {
  const res = await fetch(`${server.config.editorOrigin}/api/compte/ping`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pong: 'get' });
});

test('a cross-site request never reaches a host route', async () => {
  const res = await fetch(`${server.config.editorOrigin}/api/compte/ping`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('host route errors go through the API error handler', async () => {
  const token = { 'x-cadence-token': server.editorToken };
  const conflict = await post('/conflict', token);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'Host conflict' });
  const failure = await post('/boom', token);
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: m().api.internalError('Host failure') });
});

test('startServer refuses a host route name that is not a lowercase slug', async () => {
  await assert.rejects(start({ Compte: hostApp() }), { message: m().core.hostApi.name('Compte') });
});

test('startServer refuses a host route name taken by a built-in route', async () => {
  await assert.rejects(start({ projects: hostApp() }), { message: m().core.hostApi.taken('projects') });
});
