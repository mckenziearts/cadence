// StartOptions.api: a host app's Hono routes mounted under /api/<name>, behind the same guards as the built-in routes.
// StartOptions.hostBrandSources: a host app's brand sources next to GitHub and GitLab.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { BrandSource, HostBrandSource } from '../../server/contracts';
import { m } from '../../server/i18n';
import { startServer, type RunningServer, type StartOptions } from '../../server/index';
import { HttpError } from '../../server/util';
import type { AppState } from '../../src/shared/types';
import { makeRoot, type TestRoot } from './helpers';

let t: TestRoot;
let server: RunningServer;
let options: StartOptions;
const described: string[] = [];

/** Refuses the ref `bad`; never filled in these tests. */
function hostSource(): HostBrandSource {
  return {
    async describe(ref) {
      described.push(ref);
      if (ref === 'bad') throw new HttpError(400, 'Not a page of this site.');
      return { label: 'Acme pages' };
    },
    fill: () => Promise.reject(new Error('not filled here')),
  };
}

/** Git hosts that never call gh or glab. */
const gitSource: BrandSource = {
  account: async () => ({ available: false, reason: 'missing' }),
  repos: async () => ({ available: false, reason: 'missing' }),
  fetch: () => Promise.reject(new Error('no clone here')),
};

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
  const brandSources = { github: gitSource, gitlab: gitSource };
  options = { projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0, quiet: true, provider, brandSources };
  server = await startServer({ ...options, api: { compte: hostApp() }, hostBrandSources: { site: hostSource() } });
});

after(async () => {
  await server?.close();
  await t?.cleanup();
});

function post(route: string, headers: Record<string, string> = {}) {
  return fetch(`${server.config.editorOrigin}/api/compte${route}`, { method: 'POST', headers });
}

/** Closes a server that should have been refused, so a failing case does not leave it listening. */
async function start(extra: StartOptions) {
  const started = await startServer({ ...options, ...extra });
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
  await assert.rejects(start({ api: { Compte: hostApp() } }), { message: m().core.hostApi.name('Compte') });
});

test('startServer refuses a host route name taken by a built-in route', async () => {
  await assert.rejects(start({ api: { projects: hostApp() } }), { message: m().core.hostApi.taken('projects') });
});

test('startServer refuses a host brand source key that is not a lowercase slug or that names a Git host', async () => {
  await assert.rejects(start({ hostBrandSources: { Site: hostSource() } }), {
    message: m().core.hostBrandSources.name('Site'),
  });
  for (const key of ['github', 'gitlab']) {
    await assert.rejects(start({ hostBrandSources: { [key]: hostSource() } }), {
      message: m().core.hostBrandSources.taken(key),
    });
  }
});

test('a brand build from a host source: bounded ref, unknown source, refused ref, nothing left behind', async () => {
  const build = (body: object) =>
    fetch(`${server.config.editorOrigin}/api/brand-builds`, {
      method: 'POST',
      headers: { 'x-cadence-token': server.editorToken, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await build({ source: 'site', ref: 'x'.repeat(2049), name: 'Acme' })).status, 400);
  assert.deepEqual(described, [], 'the schema refuses it before the source sees it');
  for (const source of ['blog', 'constructor']) {
    const unknown = await build({ source, ref: 'home', name: 'Acme' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: m().media.brands.build.unknownSource(source) });
  }
  const refused = await build({ source: 'site', ref: 'bad', name: 'Acme' });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'Not a page of this site.' });
  assert.deepEqual(described, ['bad']);

  const state = (await (await fetch(`${server.config.editorOrigin}/api/state`)).json()) as AppState;
  assert.deepEqual(state.brandBuilds, []);
  await assert.rejects(fs.access(path.join(t.config.brandsDir, 'acme')));
  assert.deepEqual(await fs.readdir(path.join(t.config.stateDir, 'brand-sources')).catch(() => []), []);
});

test('host brand sources stay out of the Git listings and the Git accounts', async () => {
  const listing = await fetch(`${server.config.editorOrigin}/api/brand-sources/site`);
  assert.equal(listing.status, 404);
  const accounts = await (await fetch(`${server.config.editorOrigin}/api/git-accounts`)).json();
  assert.deepEqual(Object.keys(accounts as object), ['github', 'gitlab']);
});
