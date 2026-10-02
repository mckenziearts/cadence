// Brands, templates, settings, config and the SSE hub.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { loadConfig } from '../../server/config';
import { SseHub } from '../../server/hub';
import { language } from '../../server/i18n';
import { FileSettingsStore } from '../../server/settings';
import { FileBrandStore } from '../../server/store/brands';
import { FileTemplateStore } from '../../server/store/templates';
import { makeRoot, rejectsWithStatus, SCENE_TEMPLATE_CODE, type TestRoot } from './helpers';

let t: TestRoot;
beforeEach(async () => {
  t = await makeRoot();
});
afterEach(() => t.cleanup());

test('brands: list (default brand first), get, validation', async () => {
  const brands = new FileBrandStore(t.config);
  await fs.mkdir(path.join(t.config.brandsDir, 'cassee'));
  await fs.writeFile(path.join(t.config.brandsDir, 'cassee', 'brand.json'), JSON.stringify({ name: 'Cassée', colors: {} }));
  const list = await brands.list();
  assert.deepEqual(
    list.map((b) => b.id),
    ['cadence', 'orbit'],
  );
  assert.deepEqual(list[1], {
    id: 'orbit',
    name: 'Orbit',
    tagline: 'Payez simplement.',
    colors: { primary: '#18181b', background: '#fafafa', ink: '#0a0a0a', accent: '#ff2e88' },
    logoUrl: '/api/brands/orbit/logo?variant=mark',
  });
  assert.equal((await brands.get('orbit')).id, 'orbit');
  await rejectsWithStatus(brands.get('cassee'), 500, /brand\.json invalide/);
  await rejectsWithStatus(brands.get('absente'), 404);
  await rejectsWithStatus(brands.get('../x'), 400);
  assert.equal(await brands.exists('cassee'), true);
  assert.equal(await brands.exists('Nope!'), false);
});

test('brands: describe() gives the agent tokens, the kit API, assets and KIT.md', async () => {
  const text = await new FileBrandStore(t.config).describe(null);
  for (const part of [
    '# Brand: Cadence (`cadence`)',
    'Language of all on-screen copy: French',
    '`colors.primary`: #18181b',
    '<ui.Card',
    '<ui.Tabs items active>',
    '`@brands/cadence/assets/logo-mark.svg`',
    'Use ui.Card for panels.',
  ]) {
    assert.ok(text.includes(part), part);
  }
});

test('templates: catalogue, lookups, describe(), invalid ones skipped', async () => {
  const templates = new FileTemplateStore(t.config);
  await fs.mkdir(path.join(t.config.templatesDir, 'scenes', 'broken'));
  await fs.writeFile(path.join(t.config.templatesDir, 'scenes', 'broken', 'template.json'), '{"name": "x"}');
  assert.deepEqual(
    (await templates.scenes()).map((s) => [s.id, s.category]),
    [
      ['logo-reveal', 'intro'],
      ['feature-card', 'feature'],
    ],
  );
  const { meta, code } = await templates.sceneTemplate('feature-card');
  assert.deepEqual(meta.tags, []);
  assert.equal(code, SCENE_TEMPLATE_CODE.replace('Scene', 'Feature'));
  const launch = await templates.projectTemplate('launch');
  assert.equal(launch.bpm, 100);
  assert.match(launch.artDirection!, /Campagne/);
  assert.deepEqual(
    (await templates.projects()).map((p) => p.id),
    ['launch'],
  );
  await rejectsWithStatus(templates.sceneTemplate('absent'), 404);
  await rejectsWithStatus(templates.sceneTemplate('broken'), 500);
  const text = await templates.describe();
  assert.ok(text.includes('`logo-reveal`: **Révélation du logo** · 4 bars'));
  assert.ok(text.includes('`launch`: **Lancement** · 30 fps'));
});

test('templates: an empty or missing templates/ folder is fine', async () => {
  await fs.rm(t.config.templatesDir, { recursive: true });
  const templates = new FileTemplateStore(t.config);
  assert.deepEqual(await templates.scenes(), []);
  assert.deepEqual(await templates.projects(), []);
  assert.match(await templates.describe(), /No scene templates installed yet/);
});

test('settings: defaults from the config, validated updates, bad stored values ignored', async () => {
  const settings = new FileSettingsStore({ ...t.config, defaultModel: 'claude-opus-5-5', defaultEffort: 'medium' });
  assert.deepEqual(await settings.get(), {
    sceneModel: 'claude-opus-5-5',
    sceneEffort: 'medium',
    projectModel: 'claude-opus-5-5',
    projectEffort: 'high',
    language: null,
  });
  const next = await settings.update({ sceneModel: 'claude-sonnet-5-5', projectEffort: 'max' });
  assert.equal(next.sceneModel, 'claude-sonnet-5-5');
  assert.deepEqual(await settings.get(), next);
  await rejectsWithStatus(settings.update({ sceneModel: '--dangerously-skip-permissions' }), 400);
  await rejectsWithStatus(settings.update({ sceneEffort: 'extreme' as never }), 400);
  await fs.writeFile(path.join(t.config.stateDir, 'settings.json'), JSON.stringify({ sceneModel: 42, projectEffort: 'max' }));
  assert.equal((await settings.get()).sceneModel, 'claude-opus-5-5');
  assert.equal((await settings.get()).projectEffort, 'max');
});

test('settings: the language is validated, kept, and the server speaks it at once', async () => {
  const settings = new FileSettingsStore(t.config);
  await rejectsWithStatus(settings.update({ language: 'de' as never }), 400, /Langue invalide : de/);
  try {
    assert.equal((await settings.update({ language: 'en' })).language, 'en');
    assert.equal(language(), 'en');
    await rejectsWithStatus(settings.update({ sceneModel: '--x' }), 400, /Invalid model: --x/);
    assert.equal((await settings.get()).language, 'en');
  } finally {
    await settings.update({ language: 'fr' });
  }
  assert.equal(language(), 'fr');
});

test('config: defaults, environment, overrides', () => {
  const saved = { ...process.env };
  try {
    for (const key of [
      'CADENCE_PORT',
      'CADENCE_FRAME_PORT',
      'CADENCE_MODEL',
      'CADENCE_EFFORT',
      'CADENCE_USE_API_KEY',
      'CADENCE_AGENT_LOG',
      'FFMPEG_PATH',
    ]) {
      delete process.env[key];
    }
    const config = loadConfig();
    assert.equal(config.root, path.resolve(import.meta.dirname, '../..'));
    assert.equal(config.projectsDir, path.join(config.root, 'projects'));
    assert.equal(config.stateDir, path.join(config.root, '.cadence'));
    assert.equal(config.editorOrigin, 'http://127.0.0.1:5310');
    assert.equal(config.frameOrigin, 'http://localhost:5311');
    assert.equal(config.mcpUrl, 'http://127.0.0.1:5310/mcp');
    assert.equal(config.defaultModel, 'claude-opus-5-5');
    assert.equal(config.defaultEffort, 'medium');
    assert.equal(config.useApiKey, false);
    assert.equal(config.agentLog, null);
    assert.equal(config.ffmpegPath, 'ffmpeg');

    Object.assign(process.env, {
      CADENCE_PORT: '6000',
      CADENCE_EFFORT: 'high',
      CADENCE_USE_API_KEY: '1',
      FFMPEG_PATH: '/opt/ffmpeg',
    });
    const env = loadConfig({ framePort: 0, root: os.tmpdir(), editorPort: undefined });
    assert.equal(env.editorOrigin, 'http://127.0.0.1:6000');
    assert.equal(env.frameOrigin, 'http://localhost:0');
    assert.equal(env.defaultEffort, 'high');
    assert.equal(env.useApiKey, true);
    assert.equal(env.ffmpegPath, '/opt/ffmpeg');
    assert.equal(env.projectsDir, path.join(path.resolve(os.tmpdir()), 'projects'));

    process.env.CADENCE_EFFORT = 'turbo';
    assert.throws(() => loadConfig(), /CADENCE_EFFORT invalide/);
    process.env.CADENCE_EFFORT = 'low';
    process.env.CADENCE_PORT = 'abc';
    assert.throws(() => loadConfig(), /CADENCE_PORT invalide/);
  } finally {
    process.env = saved;
  }
});

test('hub: SSE clients receive every event; closed streams are dropped', async () => {
  const hub = new SseHub();
  let streamClosed!: () => void;
  const closed = new Promise<void>((resolve) => (streamClosed = resolve));
  const server = http.createServer((req, res) => {
    hub.handleSse(req, res);
    res.on('close', () => streamClosed());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const received = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
          let text = '';
          res.setEncoding('utf8');
          // The first chunk (retry:) means the client is registered.
          res.once('data', () => {
            hub.send({ type: 'projects-changed' });
            hub.send({ type: 'project-changed', projectId: 'x' });
          });
          res.on('data', (chunk: string) => {
            text += chunk;
            if (!text.includes('"projectId":"x"')) return;
            res.destroy();
            resolve(text);
          });
        })
        .on('error', reject);
    });
    assert.match(received, /^retry: 2000\n\n/);
    assert.match(received, /data: \{"type":"projects-changed"\}\n\n/);
    assert.match(received, /data: \{"type":"project-changed","projectId":"x"\}\n\n/);
    await closed;
    hub.send({ type: 'projects-changed' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
