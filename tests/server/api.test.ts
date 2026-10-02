import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { getRequestListener } from '@hono/node-server';
import { FileAccountService } from '../../server/accounts/accounts';
import { Publisher } from '../../server/accounts/publish';
import { createApi } from '../../server/api';
import type {
  BrandBuildService,
  BrandSource,
  CaptureService,
  ChatService,
  MusicService,
  Network,
  RenderService,
  SeamService,
  Upload,
  VoiceOverService,
} from '../../server/contracts';
import { SseHub } from '../../server/hub';
import { FileSettingsStore } from '../../server/settings';
import { FileAssetStore } from '../../server/store/assets';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import { FileVersionStore } from '../../server/store/versions';
import { FileUsageLog } from '../../server/usage';
import { HttpError, pathExists, resolveInside } from '../../server/util';
import {
  NETWORK_IDS,
  type BrandBuild,
  type ChatKey,
  type ChatState,
  type NetworkAccount,
  type NetworkId,
  type RenderJob,
  type RepoListing,
  type SeamResult,
  type ServerEvent,
  type VoiceInfo,
} from '../../src/shared/types';
import { fakeNetwork, makeRoot, type TestRoot } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const SIWIS: VoiceInfo = {
  id: 'fr_FR-siwis-medium',
  language: 'fr',
  locale: 'fr_FR',
  name: 'Siwis',
  quality: 'medium',
  license: 'CC-BY 4.0',
  commercial: true,
  credit: true,
  size: 63206169,
  installed: false,
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]);

let t: TestRoot;
let usage: FileUsageLog;
let app: ReturnType<typeof createApi>;
let store: FileProjectStore;
let calls: Record<string, unknown[]>;
let audioFile: string | null;
let voiceTrack: string | null;
let hub: SseHub;
let busy: boolean;
let renderJobs: RenderJob[];
let accounts: FileAccountService;
let networks: Record<NetworkId, Network>;
let networkCalls: [string, unknown][];
let events: ServerEvent[];

const seam: SeamResult = { from: 'a', to: 'b', format: '16:9', diffPercent: 0.12, checkedAt: '2026-09-30T00:00:00.000Z' };
const job: RenderJob = {
  id: 'job-1',
  projectId: 'demo',
  format: '16:9',
  status: 'queued',
  progress: 0,
  framesDone: 0,
  framesTotal: 240,
  width: 1920,
  height: 1080,
  fps: 60,
  request: { formats: ['16:9'], quality: 'draft' },
  createdAt: '2026-09-30T00:00:00.000Z',
};

const listing: RepoListing = {
  available: true,
  account: 'ada',
  repos: [
    {
      fullName: 'acme/site',
      description: null,
      private: true,
      pushedAt: '2026-09-30T00:00:00Z',
      url: 'https://github.com/acme/site',
      homepage: null,
    },
  ],
};
const build: BrandBuild = {
  id: 'build-1',
  brandId: 'acme',
  name: 'Acme',
  repo: 'acme/site',
  status: 'queued',
  activity: null,
  files: [],
  costUsd: null,
  createdAt: '2026-09-30T00:00:00.000Z',
};

beforeEach(async () => {
  t = await makeRoot();
  calls = {};
  audioFile = null;
  voiceTrack = null;
  busy = false;
  renderJobs = [job];
  const record = (name: string, value: unknown) => (calls[name] ??= []).push(value);
  hub = new SseHub();
  events = [];
  const send = hub.send.bind(hub);
  hub.send = (event) => {
    events.push(event);
    send(event);
  };
  const brands = new FileBrandStore(t.config);
  const templates = new FileTemplateStore(t.config);
  store = new FileProjectStore(t.config, { templates, brands });
  const capture = {
    frames: async () => [],
    thumbnail: async (id: string, sceneId: string, opts: unknown) => (record('thumbnail', { id, sceneId, opts }), JPEG),
    screenshotUrl: async () => PNG,
    kitSheet: async () => ({ image: JPEG, problems: [], loaded: true }),
    close: async () => undefined,
  } satisfies CaptureService;
  const seams = {
    check: async (id: string, opts?: unknown) => (record('seams', { id, opts }), [seam]),
    recheck: (id: string) => record('recheck', id),
    detail: async () => ({ result: seam, fromImage: PNG, toImage: JPEG, diffImage: PNG }),
    cached: () => [seam],
  } satisfies SeamService;
  const renders = {
    start: async (id: string, req: unknown) => (record('render', { id, req }), [job]),
    cancel: (jobId: string) => {
      record('cancel', jobId);
      renderJobs = renderJobs.map((j) => (j.id === jobId ? { ...j, status: 'cancelled' as const } : j));
    },
    jobs: (projectId?: string) => renderJobs.filter((j) => projectId === undefined || j.projectId === projectId),
    files: async () => [],
    resolveFile: (id: string, name: string) => resolveInside(path.join(store.dir(id), 'renders'), name),
    remove: async (id: string, name: string) => {
      record('removeRender', { id, name });
    },
    wait: async () => job,
  } satisfies RenderService;
  const music = {
    upload: async (id: string, file: Upload) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.body) chunks.push(chunk);
      record('upload', { name: file.name, data: Buffer.concat(chunks) });
      return store.get(id);
    },
    tracks: async () => [{ file: 'music/a.mp3', size: 3, analysed: true }],
    select: async (id: string, file: string) => (record('select', file), store.get(id)),
    update: async (id: string, patch: unknown) => (record('musicPatch', patch), store.get(id)),
    remove: async (id: string) => store.get(id),
    analysis: async () => null,
    grid: async () => null,
    snapCuts: async (id: string, grid: unknown, opts?: unknown) => (record('snap', { grid, opts }), store.get(id)),
    context: async () => '',
    audioPath: async () => audioFile,
  } satisfies MusicService;
  const voiceOver = {
    voices: async () => ({ piper: { ok: true }, voices: [] }),
    download: async (voice: string) => {
      record('downloadVoice', voice);
      return { ...SIWIS, installed: true };
    },
    sync: async (id: string) => {
      record('syncVoiceOver', id);
    },
    track: async () => (voiceTrack ? { file: voiceTrack, lines: [], musicLevel: 0.3 } : null),
  } satisfies VoiceOverService;
  const chat = (key: ChatKey): ChatState => ({ key, messages: [], running: false, queued: false, totalCostUsd: 0 });
  const chats = {
    get: async (_id: string, key: ChatKey) => chat(key),
    send: async (id: string, key: ChatKey, input: unknown) => (
      record('send', { id, key, input }),
      { ...chat(key), running: true }
    ),
    stop: (_id: string, key: ChatKey) => void record('stop', key),
    clear: async (_id: string, key: ChatKey) => chat(key),
    totalCost: async () => 1.25,
    stopAll: async () => undefined,
    busy: () => busy,
  } satisfies ChatService;
  const brandSource = {
    account: async () => ({ available: true, account: 'ada' }),
    repos: async () => listing,
    fetch: async () => undefined,
  } satisfies BrandSource;
  const glab = {
    account: async () => ({ available: false, reason: 'missing' }),
    repos: async () => ({ available: false, reason: 'missing' }),
    fetch: async () => undefined,
  } satisfies BrandSource;
  networkCalls = [];
  networks = Object.fromEntries(NETWORK_IDS.map((id) => [id, fakeNetwork(networkCalls, undefined, id)])) as Record<
    NetworkId,
    Network
  >;
  networks.linkedin = { ...networks.linkedin, redirectHost: 'localhost' };
  accounts = new FileAccountService({
    config: t.config,
    hub,
    networks,
    git: { github: brandSource, gitlab: glab },
  });
  usage = new FileUsageLog(t.config);
  app = createApi({
    config: t.config,
    store,
    brands,
    templates,
    versions: new FileVersionStore(store),
    assets: new FileAssetStore(store, capture),
    capture,
    seams,
    renders,
    music,
    voiceOver,
    chats,
    settings: new FileSettingsStore(t.config),
    usage,
    hub,
    brandSources: { github: brandSource, gitlab: glab },
    brandBuilds: {
      start: async (input) => (record('brandBuild', input), build),
      cancel: (id) => void record('cancelBuild', id),
      list: () => [build],
      wait: async () => build,
      sweep: async () => undefined,
      close: async () => undefined,
    } satisfies BrandBuildService,
    accounts,
    publisher: new Publisher({ store, renders, accounts, networks, hub }),
    agentStatus: async () => ({ ok: true, label: 'Claude Code', version: '2.1.285' }),
    diagnose: async (file) => `Erreur : ${file}:3:5`,
  });
  await store.create({ name: 'Démo', brand: null, formats: ['16:9'], fps: 60 });
});

afterEach(() => t.cleanup());

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData || body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...headers };
  }
  return app.fetch(new Request(`http://127.0.0.1:5299${url}`, init));
}

async function json(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await call(method, url, body);
  return { status: res.status, body: await res.json() };
}

test('GET /api/state', async () => {
  const { status, body } = await json('GET', '/api/state');
  assert.equal(status, 200);
  assert.deepEqual(
    body.projects.map((p: { id: string }) => p.id),
    ['demo'],
  );
  assert.deepEqual(
    body.brands.map((b: { id: string }) => b.id),
    ['cadence', 'orbit'],
  );
  assert.equal(body.templates.scenes.length, 2);
  assert.equal(body.templates.projects[0].id, 'launch');
  assert.equal(body.settings.projectEffort, 'high');
  assert.deepEqual(body.agent, { ok: true, label: 'Claude Code', version: '2.1.285' });
  assert.equal(body.frameOrigin, 'http://localhost:5300');
  assert.ok(body.models.some((m: { id: string }) => m.id === 'claude-opus-5-5'));
});

test('projects: create, read, update, art direction, delete; French validation errors', async () => {
  let res = await json('POST', '/api/projects', {
    name: 'Promo Orbit',
    brand: 'orbit',
    formats: ['9:16'],
    fps: 30,
    template: 'launch',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'promo-orbit');
  assert.equal(res.body.scenes.length, 3);
  assert.deepEqual(
    (await json('GET', '/api/projects/promo-orbit/versions')).body.map((v: { source: string; label: string }) => [
      v.source,
      v.label,
    ]),
    [['baseline', 'État initial']],
    'the untouched project is a version',
  );

  res = await json('POST', '/api/projects', { name: 'X', brand: null, formats: ['16:9'], fps: 25 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^Requête invalide — fps : /);
  res = await json('POST', '/api/projects', { name: '', brand: null, formats: [], fps: 60 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /name : Trop petit/);
  res = await json('POST', '/api/projects', '{ pas du json');
  assert.deepEqual(res, { status: 400, body: { error: 'Corps de requête JSON invalide' } });

  res = await json('GET', '/api/projects/promo-orbit');
  assert.equal(res.body.brand, 'orbit');
  res = await json('PATCH', '/api/projects/promo-orbit', { name: 'Promo', tempo: 128 });
  assert.equal(res.body.name, 'Promo');
  assert.equal(res.body.tempo, 128);
  res = await json('POST', '/api/projects', { name: 'In English', brand: null, formats: ['16:9'], fps: 60, language: 'en' });
  assert.equal(res.body.language, 'en');
  res = await json('PATCH', '/api/projects/in-english', { language: null });
  assert.equal(res.body.language, null, "null is the brand's language");
  assert.equal((await json('PATCH', '/api/projects/in-english', { language: 'de' })).status, 400);
  res = await json('PUT', '/api/projects/promo-orbit/art-direction', { text: '# Neuf\n' });
  assert.deepEqual(res.body, { text: '# Neuf\n' });
  assert.deepEqual((await json('GET', '/api/projects/promo-orbit/art-direction')).body, { text: '# Neuf\n' });
  assert.deepEqual((await json('DELETE', '/api/projects/promo-orbit')).body, { ok: true });
  res = await json('GET', '/api/projects/promo-orbit');
  assert.deepEqual(res, { status: 404, body: { error: 'Projet introuvable : promo-orbit' } });
  assert.equal((await json('GET', '/api/projects/..%2F..%2Fetc')).status, 400);
});

test('scenes: create (template insert is versioned), update, duplicate, order, delete', async () => {
  let res = await json('POST', '/api/projects/demo/scenes', { name: 'Logo', template: 'logo-reveal' });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'logo');
  assert.equal(res.body.duration, 8);
  const versions = (await json('GET', '/api/projects/demo/versions')).body;
  assert.deepEqual(
    versions.map((v: { source: string; label: string }) => [v.source, v.label]),
    [['template', 'Modèle inséré : Logo']],
  );
  res = await json('PATCH', '/api/projects/demo/scenes/logo', { duration: 2.5 });
  assert.equal(res.body.scenes[1].duration, 2.5);
  res = await json('PATCH', '/api/projects/demo/scenes/logo', { duration: 'long' });
  assert.equal(res.status, 400);
  res = await json('POST', '/api/projects/demo/scenes/logo/duplicate');
  assert.equal(res.body.id, 'logo-copie');
  res = await json('PUT', '/api/projects/demo/order', { ids: ['logo-copie', 'logo', 'titre'] });
  assert.deepEqual(
    res.body.scenes.map((s: { id: string }) => s.id),
    ['logo-copie', 'logo', 'titre'],
  );
  res = await json('DELETE', '/api/projects/demo/scenes/logo-copie');
  assert.equal(res.body.scenes.length, 2);
  res = await json('DELETE', '/api/projects/demo/scenes/absente');
  assert.equal(res.status, 404);
});

test('thumbnails are JPEGs with an ETag; diagnostics are relative to the project', async () => {
  let res = await call('GET', '/api/projects/demo/scenes/titre/thumbnail?t=1.5&format=16:9');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  assert.deepEqual(calls.thumbnail, [{ id: 'demo', sceneId: 'titre', opts: { t: 1.5, format: '16:9' } }]);
  const etag = res.headers.get('etag')!;
  res = await call('GET', '/api/projects/demo/scenes/titre/thumbnail', undefined, { 'if-none-match': etag });
  assert.equal(res.status, 304);
  assert.equal((await call('GET', '/api/projects/demo/scenes/nope/thumbnail')).status, 404);
  assert.equal((await call('GET', '/api/projects/demo/scenes/titre/thumbnail?t=-1')).status, 400);
  assert.equal((await call('GET', '/api/projects/demo/scenes/titre/thumbnail?format=2:1')).status, 400);
  assert.deepEqual((await json('GET', '/api/projects/demo/scenes/titre/diagnostics')).body, {
    error: 'Erreur : scenes/titre.tsx:3:5',
  });
});

test('seams: cached, check, detail with data URLs', async () => {
  assert.deepEqual((await json('GET', '/api/projects/demo/seams')).body, [seam]);
  assert.deepEqual((await json('POST', '/api/projects/demo/seams', { sceneId: 'titre' })).body, [seam]);
  assert.deepEqual((await json('POST', '/api/projects/demo/seams')).body, [seam], 'the body is optional');
  assert.deepEqual(calls.seams, [
    { id: 'demo', opts: { sceneId: 'titre' } },
    { id: 'demo', opts: {} },
  ]);
  const { body } = await json('GET', '/api/projects/demo/seams/detail?from=a&to=b');
  assert.equal(body.fromUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(body.toUrl, `data:image/jpeg;base64,${JPEG.toString('base64')}`);
  assert.equal((await json('GET', '/api/projects/demo/seams/detail?from=a')).status, 400);
});

test('music: upload (the file as the body), select, settings, snap, audio streaming with Range', async () => {
  const upload = await call('POST', '/api/projects/demo/music?name=Mon%20titre.mp3', new Blob(['ID3 fake']));
  assert.equal(upload.status, 200);
  const [uploaded] = calls.upload as { name: string; data: Buffer }[];
  assert.equal(uploaded.name, 'Mon titre.mp3');
  assert.equal(uploaded.data.toString(), 'ID3 fake');
  assert.equal((await call('POST', '/api/projects/demo/music', new Blob(['ID3 fake']))).status, 400, 'no name');

  assert.deepEqual((await json('GET', '/api/projects/demo/music/tracks')).body, [
    { file: 'music/a.mp3', size: 3, analysed: true },
  ]);
  assert.equal((await json('PUT', '/api/projects/demo/music/select', { file: 'music/a.mp3' })).status, 200);
  assert.equal((await json('PATCH', '/api/projects/demo/music', { volume: 0.5, barOffset: 1 })).status, 200);
  assert.equal((await json('PATCH', '/api/projects/demo/music', { volume: 2 })).status, 400);
  assert.equal((await json('PATCH', '/api/projects/demo/music', { beatsPerBar: 5 })).status, 400);
  assert.deepEqual(calls.musicPatch, [{ volume: 0.5, barOffset: 1 }]);
  assert.equal((await json('POST', '/api/projects/demo/music/snap', { grid: 'bar' })).status, 200);
  assert.equal((await json('POST', '/api/projects/demo/music/snap', { grid: 'bar', keepBars: true })).status, 200);
  assert.equal((await json('POST', '/api/projects/demo/music/snap', { grid: 'mesure' })).status, 400);
  assert.deepEqual(calls.snap, [
    { grid: 'bar', opts: { keepBars: undefined } },
    { grid: 'bar', opts: { keepBars: true } },
  ]);
  assert.deepEqual(
    (await json('GET', '/api/projects/demo/versions')).body.map((v: { source: string; label: string }) => [v.source, v.label]),
    [['external', 'Avant le calage des coupes']],
    'a version before snapping (then nothing changed in between)',
  );
  assert.equal((await json('DELETE', '/api/projects/demo/music')).status, 200);
  assert.equal((await json('GET', '/api/projects/demo/music/analysis')).body, null);

  assert.equal((await call('GET', '/api/projects/demo/music/audio')).status, 404);
  audioFile = path.join(t.root, 'track.mp3');
  await fs.writeFile(audioFile, Buffer.from('0123456789'));
  let res = await call('GET', '/api/projects/demo/music/audio', undefined, { range: 'bytes=2-5' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await res.text(), '2345');
  res = await call('GET', '/api/projects/demo/music/audio', undefined, { range: 'bytes=-3' });
  assert.equal(await res.text(), '789');
  res = await call('GET', '/api/projects/demo/music/audio', undefined, { range: 'bytes=20-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */10');
  res = await call('GET', '/api/projects/demo/music/audio');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(await res.text(), '0123456789');
});

test('voice-overs: voices, download, scene text, settings, speaking on request, the track as WAV', async () => {
  assert.deepEqual((await json('GET', '/api/voices')).body, { piper: { ok: true }, voices: [] });
  const downloaded = await json('POST', '/api/voices/fr_FR-siwis-medium/download');
  assert.deepEqual(downloaded.body, { ...SIWIS, installed: true });
  assert.deepEqual(calls.downloadVoice, ['fr_FR-siwis-medium']);

  const sceneId = (await store.get('demo')).scenes[0].id;
  const scene = (text: string, at = 0) => json('PATCH', `/api/projects/demo/scenes/${sceneId}`, { voiceOver: { text, at } });
  assert.deepEqual((await scene('Bonjour.', 0.5)).body.scenes[0].voiceOver, { text: 'Bonjour.', at: 0.5 });
  assert.equal((await scene('x'.repeat(2001))).status, 400);
  assert.equal((await scene('Bonjour.', -1)).status, 400);
  const removed = await json('PATCH', `/api/projects/demo/scenes/${sceneId}`, { voiceOver: null });
  assert.equal(removed.body.scenes[0].voiceOver, undefined);

  const settings = { voice: 'en_GB-cori-medium', speed: 1.1, musicLevel: 0.4 };
  assert.deepEqual((await json('PATCH', '/api/projects/demo', { voiceOver: settings })).body.voiceOver, settings);
  const unknown = await json('PATCH', '/api/projects/demo', { voiceOver: { ...settings, voice: 'xx_XX-nobody-low' } });
  assert.equal(unknown.status, 400);

  const synced = await json('POST', '/api/projects/demo/voice-over/sync');
  assert.equal(synced.body.id, 'demo');
  assert.deepEqual(calls.syncVoiceOver, ['demo']);
  assert.equal((await json('POST', '/api/projects/nope/voice-over/sync')).status, 404);

  assert.equal((await call('GET', '/api/projects/demo/voice-over/audio')).status, 404);
  voiceTrack = path.join(t.root, 'track.wav');
  await fs.writeFile(voiceTrack, Buffer.from('RIFF0000WAVE'));
  const audio = await call('GET', '/api/projects/demo/voice-over/audio?v=abc');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal(await audio.text(), 'RIFF0000WAVE');
});

test('versions: manual save, list, restore', async () => {
  let res = await json('POST', '/api/projects/demo/versions', {});
  assert.equal(res.body.id, 'v0001');
  assert.equal(res.body.label, 'Sauvegarde manuelle');
  assert.equal((await json('POST', '/api/projects/demo/versions', { label: 'Encore' })).body, null, 'nothing changed');
  await fs.writeFile(store.sceneFile('demo', 'titre'), 'export default () => null;\n');
  await json('POST', '/api/projects/demo/versions', { label: 'Modifié' });
  res = await json('POST', '/api/projects/demo/versions/v0001/restore', { sceneId: 'titre' });
  assert.equal(res.body.source, 'restore');
  assert.deepEqual(
    (await json('GET', '/api/projects/demo/versions?scene=titre')).body.map((v: { id: string }) => v.id),
    ['v0003', 'v0002', 'v0001'],
  );
  assert.equal((await json('POST', '/api/projects/demo/versions/v0404/restore')).status, 404);
});

test('chats: keys, messages, stop, clear, cost, agent frames', async () => {
  assert.equal((await json('GET', '/api/projects/demo/chats/project')).body.key, 'project');
  assert.equal((await json('GET', '/api/projects/demo/chats/scene:titre')).body.key, 'scene:titre');
  assert.equal((await json('GET', '/api/projects/demo/chats/scene%3Atitre')).body.key, 'scene:titre');
  assert.equal((await json('GET', '/api/projects/demo/chats/scene:Bad!')).status, 400);
  assert.equal((await json('GET', '/api/projects/demo/chats/autre')).status, 400);
  const playhead = { sceneId: 'titre', t: 1.2, format: '16:9' };
  const res = await json('POST', '/api/projects/demo/chats/scene:titre/messages', {
    text: 'Plus grand',
    effort: 'high',
    playhead,
  });
  assert.equal(res.body.running, true);
  assert.deepEqual(calls.send, [{ id: 'demo', key: 'scene:titre', input: { text: 'Plus grand', effort: 'high', playhead } }]);
  assert.equal((await json('POST', '/api/projects/demo/chats/project/messages', { text: '   ' })).status, 400);
  assert.equal((await json('POST', '/api/projects/demo/chats/project/messages', { text: 'x', effort: 'turbo' })).status, 400);
  assert.deepEqual((await json('POST', '/api/projects/demo/chats/project/stop')).body, { ok: true });
  assert.deepEqual(calls.stop, ['project']);
  assert.equal((await json('DELETE', '/api/projects/demo/chats/project')).body.key, 'project');
  assert.deepEqual((await json('GET', '/api/projects/demo/cost')).body, { totalUsd: 1.25 });

  const frames = path.join(store.dir('demo'), '.cadence', 'frames');
  await fs.mkdir(frames, { recursive: true });
  await fs.writeFile(path.join(frames, 'titre-0.500.jpg'), JPEG);
  const frame = await call('GET', '/api/projects/demo/agent-frames/titre-0.500.jpg');
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('GET', '/api/projects/demo/agent-frames/..%2Fproject.json')).status, 400);
  assert.equal((await call('GET', '/api/projects/demo/agent-frames/absent.jpg')).status, 404);
});

test('renders: validated requests, jobs and files, cancel, MP4 streaming, deletion', async () => {
  assert.equal((await json('POST', '/api/projects/demo/renders', { formats: ['16:9'], quality: 'draft', scale: 3 })).status, 400);
  assert.equal((await json('POST', '/api/projects/demo/renders', { formats: [], quality: 'draft' })).status, 400);
  assert.equal(
    (await json('POST', '/api/projects/demo/renders', { formats: ['16:9'], quality: 'draft', range: { from: 2, to: 1 } })).status,
    400,
  );
  const req = { formats: ['16:9', '9:16'], quality: 'master', scale: 2, supersample: true, range: { from: 0, to: 4 } };
  assert.deepEqual((await json('POST', '/api/projects/demo/renders', req)).body, [job]);
  assert.deepEqual(calls.render, [{ id: 'demo', req }]);
  assert.deepEqual((await json('GET', '/api/projects/demo/renders')).body, { jobs: [job], files: [] });
  assert.deepEqual((await json('DELETE', '/api/renders/job-1')).body, { ok: true });
  assert.deepEqual(calls.cancel, ['job-1']);
  const renders = path.join(store.dir('demo'), 'renders');
  await fs.mkdir(renders);
  await fs.writeFile(path.join(renders, 'demo.mp4'), Buffer.alloc(1000, 1));
  const res = await call('GET', '/api/projects/demo/renders/demo.mp4', undefined, { range: 'bytes=0-99' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal((await res.arrayBuffer()).byteLength, 100);
  assert.equal((await call('GET', '/api/projects/demo/renders/..%2Fproject.json')).status, 400);
  assert.deepEqual((await json('DELETE', '/api/projects/demo/renders/demo.mp4')).body, { ok: true });
  assert.deepEqual(calls.removeRender, [{ id: 'demo', name: 'demo.mp4' }]);
});

test('brand builds: repositories through gh, validated starts, cancel, running builds in the state', async () => {
  assert.deepEqual((await json('GET', '/api/brand-sources/github')).body, listing);
  assert.deepEqual((await json('GET', '/api/brand-sources/gitlab')).body, { available: false, reason: 'missing' });
  assert.deepEqual(await json('GET', '/api/brand-sources/bitbucket'), {
    status: 404,
    body: { error: 'Hébergeur Git inconnu : bitbucket' },
  });
  assert.equal((await json('POST', '/api/brand-builds', { repo: 'acme/site', name: '  ' })).status, 400);
  assert.equal((await json('POST', '/api/brand-builds', { name: 'Acme' })).status, 400);
  assert.deepEqual((await json('POST', '/api/brand-builds', { repo: 'acme/site', name: ' Acme ' })).body, build);
  assert.deepEqual(calls.brandBuild, [{ repo: 'acme/site', name: 'Acme' }]);
  assert.deepEqual((await json('DELETE', '/api/brand-builds/build-1')).body, { ok: true });
  assert.deepEqual(calls.cancelBuild, ['build-1']);
  assert.deepEqual(((await json('GET', '/api/state')).body as { brandBuilds: BrandBuild[] }).brandBuilds, [build]);
});

test('assets and references', async () => {
  const form = new FormData();
  form.append('file', new File([PNG], 'Capture écran.png', { type: 'image/png' }));
  let res = await json('POST', '/api/projects/demo/assets', form);
  assert.equal(res.body.path, 'capture-ecran.png');
  const file = await call('GET', `/api/projects/demo/assets/file?path=${encodeURIComponent('capture-ecran.png')}`);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.match(file.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.equal((await call('GET', '/api/projects/demo/assets/file?path=../project.json')).status, 400);
  assert.equal((await call('GET', '/api/projects/demo/assets/file')).status, 400);

  res = await json('POST', '/api/projects/demo/refs', { url: 'http://localhost:5173/', device: 'mobile' });
  assert.equal(res.body.path, 'refs/localhost-5173-mobile.png');
  assert.equal((await json('POST', '/api/projects/demo/refs', { url: 'file:///etc/hosts', device: 'desktop' })).status, 400);
  assert.deepEqual(
    (await json('GET', '/api/projects/demo/assets')).body.map((a: { path: string }) => a.path),
    ['capture-ecran.png', 'refs/localhost-5173-mobile.png'],
  );
  assert.deepEqual((await json('DELETE', '/api/projects/demo/assets?path=capture-ecran.png')).body, { ok: true });
  assert.equal((await json('GET', '/api/projects/demo/assets')).body.length, 1);
});

test('brands, logos, settings', async () => {
  assert.equal((await json('GET', '/api/brands/orbit')).body.name, 'Orbit');
  assert.equal((await json('GET', '/api/brands/absente')).status, 404);
  let res = await call('GET', '/api/brands/cadence/logo?variant=full');
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /id="full"/);
  res = await call('GET', '/api/brands/cadence/logo');
  assert.doesNotMatch(await res.text(), /id="full"/);
  assert.equal((await call('GET', '/api/brands/cadence/logo?variant=giant')).status, 400);

  assert.equal((await json('GET', '/api/settings')).body.sceneEffort, 'medium');
  res = await call('PUT', '/api/settings', { sceneModel: 'claude-sonnet-5-5', sceneEffort: 'low' });
  assert.deepEqual(await res.json(), {
    sceneModel: 'claude-sonnet-5-5',
    sceneEffort: 'low',
    projectModel: 'claude-opus-5-5',
    projectEffort: 'high',
    language: null,
  });
  assert.equal((await json('PUT', '/api/settings', { projectEffort: 'turbo' })).status, 400);
  assert.equal((await json('PUT', '/api/settings', { language: 'de' })).status, 400);
});

test('usage: every recorded Claude Code run, summed per kind', async () => {
  const none = { runs: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.deepEqual((await json('GET', '/api/usage')).body, { since: null, chats: none, brands: none });

  const tokens = { input: 10, output: 200, cacheRead: 3000, cacheWrite: 400 };
  await usage.record({ at: '2026-10-01T10:00:00.000Z', kind: 'chat', projectId: 'demo', chat: 'project', costUsd: 0.1, tokens });
  await usage.record({
    at: '2026-10-01T11:00:00.000Z',
    kind: 'chat',
    projectId: 'demo',
    chat: 'scene:intro',
    costUsd: 0.2,
    tokens,
  });
  await usage.record({ at: '2026-10-01T12:00:00.000Z', kind: 'brand', brandId: 'acme', costUsd: 4.28, tokens });
  assert.deepEqual((await json('GET', '/api/usage')).body, {
    since: '2026-10-01T10:00:00.000Z',
    chats: { runs: 2, costUsd: 0.3, tokens: { input: 20, output: 400, cacheRead: 6000, cacheWrite: 800 } },
    brands: { runs: 1, costUsd: 4.28, tokens },
  });
});

test('brands: deleted into .cadence/trash, never the neutral kit, one in use or one being built', async () => {
  const dir = (id: string) => path.join(t.config.brandsDir, id);
  assert.deepEqual(await json('DELETE', '/api/brands/cadence'), {
    status: 400,
    body: { error: "La marque neutre Cadence ne se supprime pas : les nouvelles marques partent d'elle." },
  });
  await json('POST', '/api/projects', { name: 'Promo Orbit', brand: 'orbit', formats: ['9:16'], fps: 30 });
  assert.deepEqual(await json('DELETE', '/api/brands/orbit'), {
    status: 409,
    body: { error: "Le projet « Promo Orbit » utilise cette marque : supprimez-le ou changez sa marque d'abord." },
  });
  await json('POST', '/api/projects', { name: 'Rentrée Orbit', brand: 'orbit', formats: ['9:16'], fps: 30 });
  assert.match((await json('DELETE', '/api/brands/orbit')).body.error, /^Les projets « .+ », « .+ » utilisent cette marque/);
  await json('DELETE', '/api/projects/promo-orbit');
  await json('DELETE', '/api/projects/rentree-orbit');

  assert.deepEqual((await json('DELETE', '/api/brands/orbit')).body, { ok: true });
  assert.equal(await pathExists(dir('orbit')), false);
  assert.match((await fs.readdir(path.join(t.config.stateDir, 'trash', 'brands'))).join(), /^orbit-\d+$/);
  assert.deepEqual(
    (await json('GET', '/api/state')).body.brands.map((b: { id: string }) => b.id),
    ['cadence'],
  );
  assert.equal((await json('DELETE', '/api/brands/orbit')).status, 404);
  assert.equal((await json('DELETE', '/api/brands/..%2Fprojects')).status, 400);

  await fs.mkdir(dir('acme'));
  await fs.writeFile(path.join(dir('acme'), '.building'), `${process.pid} build-1`);
  assert.deepEqual(await json('DELETE', '/api/brands/acme'), {
    status: 409,
    body: { error: "Cette marque est en construction : annulez d'abord la construction." },
  });
});

test('unknown routes, oversized bodies and the SSE route outside Node', async () => {
  assert.deepEqual(await json('GET', '/api/nope'), { status: 404, body: { error: 'Route inconnue : GET /api/nope' } });
  const res = await json('PUT', '/api/projects/demo/art-direction', { text: 'x'.repeat(3 * 1024 * 1024) });
  assert.deepEqual(res, { status: 413, body: { error: 'Requête trop volumineuse' } });
  assert.equal((await json('GET', '/api/events')).status, 500);
});

test('GET /api/events streams hub events when served by Node', async () => {
  const server = http.createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const data = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
          assert.equal(res.statusCode, 200);
          assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
            if (text.includes('code-changed')) {
              res.destroy();
              resolve(text);
            } else hub.send({ type: 'code-changed', projectId: 'demo', generation: 3 });
          });
        })
        .on('error', reject);
    });
    assert.match(data, /data: \{"type":"code-changed","projectId":"demo","generation":3\}/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('while Claude works on the project: no restore or deletion, no template-insert version; no deletion mid-render', async () => {
  await json('POST', '/api/projects/demo/scenes', { name: 'Fin' });
  await json('POST', '/api/projects/demo/versions', { label: 'Départ' });
  busy = true;
  const refused = { status: 409, body: { error: "Claude travaille sur ce projet : arrêtez d'abord la réponse en cours." } };
  assert.deepEqual(await json('POST', '/api/projects/demo/versions/v0001/restore'), refused);
  assert.deepEqual(await json('DELETE', '/api/projects/demo/scenes/fin'), refused);
  assert.deepEqual(await json('DELETE', '/api/projects/demo'), refused);
  assert.equal((await json('POST', '/api/projects/demo/scenes', { name: 'Logo', template: 'logo-reveal' })).status, 200);
  assert.equal((await json('POST', '/api/projects/demo/music/snap', { grid: 'bar' })).status, 200);
  assert.equal((await json('GET', '/api/projects/demo/versions')).body.length, 1, "the turn's own version takes them");
  busy = false;
  assert.equal((await json('DELETE', '/api/projects/demo/scenes/fin')).status, 200);
  assert.equal((await json('POST', '/api/projects/demo/versions/v0001/restore')).status, 200);
  assert.deepEqual(await json('DELETE', '/api/projects/demo'), {
    status: 409,
    body: { error: "Un rendu de ce projet est en cours : annulez-le d'abord." },
  });
  await json('DELETE', '/api/renders/job-1');
  assert.deepEqual((await json('DELETE', '/api/projects/demo')).body, { ok: true });
});

test('seams are checked again after edits that move or change cuts', async () => {
  const checks = () => (calls.recheck ?? []).length;
  await json('POST', '/api/projects/demo/scenes', { name: 'Fin' });
  const edits: [string, string, unknown, number][] = [
    ['PATCH', '/api/projects/demo/scenes/fin', { name: 'Clôture' }, 0],
    ['PATCH', '/api/projects/demo/scenes/fin', { duration: 2.5 }, 1],
    ['PUT', '/api/projects/demo/order', { ids: ['fin', 'titre'] }, 1],
    ['PATCH', '/api/projects/demo', { name: 'Démo 2', fps: 30 }, 0],
    ['PATCH', '/api/projects/demo', { formats: ['16:9', '9:16'] }, 1],
    ['PATCH', '/api/projects/demo', { language: 'en' }, 1],
    ['PATCH', '/api/projects/demo', { tempo: 128 }, 1],
    ['PATCH', '/api/projects/demo', { brand: 'orbit' }, 1],
    ['POST', '/api/projects/demo/music/snap', { grid: 'beat' }, 1],
    ['DELETE', '/api/projects/demo/scenes/fin', undefined, 1],
  ];
  for (const [method, url, payload, expected] of edits) {
    const before = checks();
    assert.equal((await json(method, url, payload)).status, 200, `${method} ${url}`);
    assert.equal(checks() - before, expected, `${method} ${url} ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(new Set(calls.recheck), new Set(['demo']));
});

test('bodies get the JSON size limit, except on the two upload routes', async () => {
  const big = () => {
    const form = new FormData();
    form.append('file', new File([Buffer.alloc(3 * 1024 * 1024, 1)], 'grand.png', { type: 'image/png' }));
    return form;
  };
  assert.deepEqual(await json('POST', '/api/projects', big()), { status: 413, body: { error: 'Requête trop volumineuse' } });
  assert.equal((await json('PUT', '/api/projects/demo/art-direction', big())).status, 413);
  assert.equal((await json('POST', '/api/projects/demo/assets', big())).body.path, 'grand.png');
  assert.equal(
    (await call('POST', '/api/projects/demo/music?name=grand.wav', new Blob([Buffer.alloc(3 * 1024 * 1024, 1)]))).status,
    200,
  );
});

/** Keys saved, then the round trip of the consent page: the fake network sends the code straight back. */
async function connectYouTube(): Promise<void> {
  await json('PUT', '/api/networks/youtube/app', { clientId: 'id-1', clientSecret: 'secret-1' });
  const { body } = await json('POST', '/api/networks/youtube/connect');
  const result = await accounts.callback('youtube', new URL(body.url).searchParams);
  assert.equal(result.ok, true, result.detail);
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
};

test('accounts: the state names the networks, never a secret; the keys go to a file only its owner reads', async () => {
  const redirectUri = `${t.config.editorOrigin}/oauth/youtube/callback`;
  const listed = (await json('GET', '/api/state')).body.networks as NetworkAccount[];
  assert.deepEqual(
    listed.map((n) => n.id),
    ['youtube', 'linkedin', 'instagram', 'tiktok'],
  );
  assert.deepEqual(listed[0], {
    id: 'youtube',
    label: 'YouTube',
    clientId: null,
    redirectUri,
    account: null,
    fields: { title: 100, text: 5000, visibilities: ['private', 'unlisted', 'public'] },
  });
  // A network that only accepts localhost gets it in its return address.
  assert.equal(listed[1].redirectUri, `http://localhost:${t.config.editorPort}/oauth/linkedin/callback`);
  assert.deepEqual((await json('PUT', '/api/networks/youtube/app', { clientId: ' id-1 ', clientSecret: 'secret-1' })).body, {
    ok: true,
  });
  const state = await call('GET', '/api/state').then((res) => res.text());
  assert.equal(JSON.parse(state).networks[0].clientId, 'id-1');
  assert.ok(!state.includes('secret-1'));
  const file = path.join(t.config.stateDir, 'accounts.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(events.at(-1), { type: 'accounts-changed' });

  assert.deepEqual((await json('GET', '/api/git-accounts')).body, {
    github: { available: true, account: 'ada' },
    gitlab: { available: false, reason: 'missing' },
  });
  assert.deepEqual(await json('PUT', '/api/networks/myspace/app', { clientId: 'a', clientSecret: 'b' }), {
    status: 404,
    body: { error: 'Réseau inconnu : myspace' },
  });
  assert.equal((await json('PUT', '/api/networks/youtube/app', { clientId: 'a', clientSecret: ' ' })).status, 400);
});

test('accounts: connecting hands a single-use state to the callback; a wrong, reused or foreign state stores nothing', async () => {
  assert.deepEqual(await json('POST', '/api/networks/youtube/connect'), {
    status: 409,
    body: { error: 'Enregistrez d’abord les clés de votre app YouTube dans le Profil.' },
  });
  await json('PUT', '/api/networks/youtube/app', { clientId: 'id-1', clientSecret: 'secret-1' });
  const { body } = await json('POST', '/api/networks/youtube/connect');
  const params = new URL(body.url).searchParams;
  const expired = { ok: false, title: 'Lien de connexion expiré', detail: 'Relancez la connexion depuis le Profil de Cadence.' };
  assert.deepEqual(await accounts.callback('youtube', new URLSearchParams({ state: 'forged', code: 'x' })), expired);
  assert.deepEqual(await accounts.callback('linkedin', params), expired, 'a state belongs to its network');

  const fresh = new URL((await json('POST', '/api/networks/youtube/connect')).body.url).searchParams;
  assert.deepEqual(await accounts.callback('youtube', fresh), {
    ok: true,
    title: 'YouTube connecté',
    detail: 'Chaîne E2E est relié à Cadence. Vous pouvez fermer cet onglet.',
  });
  assert.deepEqual(await accounts.callback('youtube', fresh), expired, 'single use');
  const connect = networkCalls.find(([name]) => name === 'connect')![1] as { code: string; verifier: string };
  assert.equal(connect.code, 'code-id-1');
  // PKCE: the challenge sent with the consent is the SHA-256 of the verifier given with the code.
  assert.equal(createHash('sha256').update(connect.verifier).digest('base64url'), fresh.get('challenge'));

  const state = await call('GET', '/api/state').then((res) => res.text());
  assert.deepEqual(JSON.parse(state).networks[0].account.name, 'Chaîne E2E');
  assert.ok(!state.includes('access-1') && !state.includes('refresh-1'));

  const denied = new URL((await json('POST', '/api/networks/youtube/connect')).body.url).searchParams;
  denied.delete('code');
  denied.set('error', 'access_denied');
  assert.deepEqual(await accounts.callback('youtube', denied), {
    ok: false,
    title: 'YouTube n’est pas connecté',
    detail: 'L’accès a été refusé.',
  });
});

test('accounts: a damaged accounts.json is reported, never replaced by the next save', async () => {
  const file = path.join(t.config.stateDir, 'accounts.json');
  const before = await fs.readFile(file, 'utf8').catch(() => null);
  // One trailing comma: read as empty, the next save would keep LinkedIn alone and lose the YouTube keys.
  const damaged = '{ "youtube": { "app": { "clientId": "id-1", "clientSecret": "secret-1" }, }, }';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, damaged);
  try {
    const res = await json('PUT', '/api/networks/linkedin/app', { clientId: 'id-2', clientSecret: 'secret-2' });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /accounts\.json illisible/);
    assert.equal(await fs.readFile(file, 'utf8'), damaged);
  } finally {
    if (before === null) await fs.rm(file);
    else await fs.writeFile(file, before);
  }
});

test('accounts: tokens refreshed before they expire; a revoked connection disconnects; « Déconnecter » revokes', async () => {
  await connectYouTube();
  const file = path.join(t.config.stateDir, 'accounts.json');
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.youtube.account.tokens.expiresAt = Date.now() + 60_000;
  await fs.writeFile(file, JSON.stringify(stored));
  assert.equal((await accounts.tokens('youtube')).access, 'access-2');
  assert.equal((await accounts.tokens('youtube')).access, 'access-2', 'refreshed once');
  assert.equal(networkCalls.filter(([name]) => name === 'refresh').length, 1);

  await json('DELETE', '/api/networks/youtube');
  assert.deepEqual(networkCalls.at(-1), ['revoke', 'refresh-1']);
  const youtube = (await json('GET', '/api/state')).body.networks[0];
  assert.equal(youtube.account, null);
  assert.equal(youtube.clientId, 'id-1', 'the keys stay');

  await connectYouTube();
  const again = JSON.parse(await fs.readFile(file, 'utf8'));
  again.youtube.account.tokens.expiresAt = 0;
  await fs.writeFile(file, JSON.stringify(again));
  networks.youtube.refresh = async () => {
    throw new HttpError(401, 'La connexion YouTube a expiré');
  };
  await assert.rejects(accounts.tokens('youtube'), /expiré/);
  assert.equal((await json('GET', '/api/state')).body.networks[0].account, null);
  await fs.mkdir(path.join(store.dir('demo'), 'renders'), { recursive: true });
  await fs.writeFile(path.join(store.dir('demo'), 'renders', 'demo.mp4'), Buffer.alloc(10, 1));
  assert.deepEqual(await json('POST', '/api/projects/demo/publications', publishBody('demo.mp4')), {
    status: 409,
    body: { error: 'Connectez d’abord YouTube dans le Profil.' },
  });

  await connectYouTube();
  await json('PUT', '/api/networks/youtube/app', { clientId: 'id-2', clientSecret: 'secret-2' });
  assert.equal((await json('GET', '/api/state')).body.networks[0].account, null, 'new keys, new connection');
});

function publishBody(file: string) {
  return { file, network: 'youtube', title: 'Démo', description: 'Le teaser.', visibility: 'public' };
}

test('publishing: the video goes out in the background, the project keeps the link; deletion waits for it', async () => {
  await connectYouTube();
  const renders = path.join(store.dir('demo'), 'renders');
  await fs.mkdir(renders, { recursive: true });
  await fs.writeFile(path.join(renders, 'demo-16x9.mp4'), Buffer.alloc(1000, 1));
  let release!: () => void;
  networks.youtube = fakeNetwork(networkCalls, new Promise<void>((resolve) => (release = resolve)));

  const { status, body: job } = await json('POST', '/api/projects/demo/publications', publishBody('demo-16x9.mp4'));
  assert.equal(status, 200);
  assert.equal(job.status, 'uploading');
  assert.deepEqual(networkCalls.at(-1), [
    'publish',
    { title: 'Démo', description: 'Le teaser.', visibility: 'public', size: 1000, access: 'access-1' },
  ]);
  assert.deepEqual(await json('POST', '/api/projects/demo/publications', publishBody('demo-16x9.mp4')), {
    status: 409,
    body: { error: 'Cette vidéo part déjà sur YouTube.' },
  });
  await json('DELETE', '/api/renders/job-1');
  assert.deepEqual(await json('DELETE', '/api/projects/demo'), {
    status: 409,
    body: { error: "Une vidéo de ce projet part sur un réseau : attendez la fin de l'envoi." },
  });
  assert.deepEqual(await json('DELETE', '/api/projects/demo/renders/demo-16x9.mp4'), {
    status: 409,
    body: { error: "Cette vidéo part sur un réseau : attendez la fin de l'envoi pour la supprimer." },
  });
  assert.deepEqual((await json('DELETE', '/api/projects/demo/renders/demo-9x16.mp4')).body, { ok: true }, 'another one goes');

  release();
  await until(async () => (await json('GET', '/api/projects/demo/publications')).body.jobs[0].status === 'done');
  const { body } = await json('GET', '/api/projects/demo/publications');
  const publication = {
    file: 'demo-16x9.mp4',
    network: 'youtube',
    title: 'Démo',
    url: 'https://youtu.be/e2e',
    visibility: 'private',
    requested: 'public',
    publishedAt: body.publications[0].publishedAt,
  };
  assert.deepEqual(body.publications, [publication]);
  assert.deepEqual(body.jobs[0].publication, publication);
  const progress = events.flatMap((e) => (e.type === 'publish' ? [`${e.job.status} ${e.job.progress}`] : []));
  assert.deepEqual(progress, ['uploading 0', 'uploading 0.5', 'uploading 1', 'done 1']);
  const saved = JSON.parse(await fs.readFile(path.join(store.dir('demo'), '.cadence', 'publications.json'), 'utf8'));
  assert.deepEqual(saved, [publication]);

  assert.deepEqual(await json('POST', '/api/projects/demo/publications', publishBody('absent.mp4')), {
    status: 404,
    body: { error: 'Vidéo introuvable : absent.mp4' },
  });
  assert.equal((await json('POST', '/api/projects/demo/publications', publishBody('../project.json'))).status, 400);
  assert.equal(
    (await json('POST', '/api/projects/demo/publications', { ...publishBody('demo-16x9.mp4'), title: '' })).status,
    400,
  );
  assert.equal((await json('POST', '/api/projects/inconnu/publications', publishBody('demo-16x9.mp4'))).status, 404);
  assert.deepEqual((await json('DELETE', '/api/projects/demo')).body, { ok: true });
});

test('publishing: a failure lands in the job, not in the project', async () => {
  await connectYouTube();
  const renders = path.join(store.dir('demo'), 'renders');
  await fs.mkdir(renders, { recursive: true });
  await fs.writeFile(path.join(renders, 'demo-9x16.mp4'), Buffer.alloc(10, 1));
  networks.youtube.publish = async () => {
    throw new HttpError(429, 'Quota d’envoi YouTube du jour atteint : réessayez demain.');
  };
  await json('POST', '/api/projects/demo/publications', publishBody('demo-9x16.mp4'));
  await until(async () => (await json('GET', '/api/projects/demo/publications')).body.jobs[0].status === 'error');
  const { body } = await json('GET', '/api/projects/demo/publications');
  assert.equal(body.jobs[0].error, 'Quota d’envoi YouTube du jour atteint : réessayez demain.');
  assert.deepEqual(body.publications, []);
});
