import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AssetStore,
  BrandStore,
  CadenceConfig,
  CaptureService,
  McpActivity,
  MusicService,
  ProjectStore,
  SeamService,
  TemplateStore,
  VersionStore,
  VoiceOverService,
} from '../../server/contracts';
import { BRAND_TOOLS } from '../../server/mcp/brandTools';
import { createMcpHandler } from '../../server/mcp/server';
import { McpTokens } from '../../server/mcp/tokens';
import { PROJECT_TOOLS, SCENE_TOOLS } from '../../server/mcp/tools';
import { HttpError } from '../../server/util';
import type { CreateSceneInput, ProjectState, SceneState } from '../../src/shared/types';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Content[]; isError?: boolean };

function makeProject(dir: string): ProjectState {
  const scenes: SceneState[] = ['intro', 'outro', 'logo'].map((id, index) => ({
    id,
    name: id,
    duration: 2,
    template: null,
    index,
    start: index * 2,
    file: path.join(dir, 'scenes', `${id}.tsx`),
    url: '',
    codeVersion: '',
  }));
  return {
    id: 'demo',
    dir,
    name: 'Démo',
    brand: 'orbit',
    fps: 60,
    formats: ['9:16', '16:9'],
    tempo: 120,
    language: null,
    scenes,
    duration: 6,
    music: null,
    musicUrl: null,
    musicGrid: null,
    voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 },
    voiceOverUrl: null,
    voiceOverLines: [],
    voiceOverPending: [],
    codeGeneration: 1,
    createdAt: '',
    updatedAt: '',
  };
}

describe('MCP endpoint', () => {
  let root: string;
  let url: string;
  let server: http.Server;
  let tokens: McpTokens;
  let project: ProjectState;
  const calls: Record<string, unknown[]> = {};
  const activity: McpActivity[] = [];
  const record = (name: string, value: unknown) => (calls[name] ??= []).push(value);
  let piperFails = false;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-mcp-'));
    project = makeProject(path.join(root, 'projects', 'demo'));
    const config = { root, projectsDir: path.join(root, 'projects') } as CadenceConfig;
    tokens = new McpTokens(config, path.join(root, 'mcp-token'));
    const store = {
      events: new EventEmitter(),
      list: async () => [{ id: 'demo' }, { id: 'autre' }],
      get: async (id: string) => {
        if (id !== 'demo') throw new HttpError(404, `Projet introuvable : ${id}`);
        return project;
      },
      updateScene: async (id: string, sceneId: string, patch: { duration?: number; name?: string }) => {
        record('updateScene', [id, sceneId, patch]);
        return {
          ...project,
          scenes: project.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
        };
      },
      createScene: async (id: string, input: CreateSceneInput) => {
        record('createScene', [id, input]);
        return { ...project.scenes[0], id: 'stats', name: input.name, index: 3, duration: 4, file: '/x/scenes/stats.tsx' };
      },
      reorderScenes: async (id: string, ids: string[]) => {
        record('reorderScenes', [id, ids]);
        return { ...project, scenes: ids.map((sid) => project.scenes.find((s) => s.id === sid)!) };
      },
    } as unknown as ProjectStore;
    const capture = {
      frames: async (id: string, req: { sceneId: string | null; times: number[] }) => {
        record('frames', [id, req]);
        return req.times.map((t) => ({
          t,
          sceneId: req.sceneId ?? 'outro',
          localTime: req.sceneId ? t : t - 2,
          image: JPEG,
          mime: 'image/jpeg',
          errors: t === 1.5 ? ['ReferenceError: x is not defined'] : [],
        }));
      },
      kitSheet: async (brandId: string) => (
        record('kitSheet', brandId),
        { image: JPEG, problems: ['Button : boom'], loaded: true }
      ),
    } as unknown as CaptureService;
    const seams = {
      check: async (id: string, opts: unknown) => {
        record('seams', [id, opts]);
        return [
          { from: 'intro', to: 'outro', format: '9:16', diffPercent: 0.06, checkedAt: '' },
          { from: 'outro', to: 'logo', format: '9:16', diffPercent: 0.04, checkedAt: '' },
        ];
      },
      detail: async () => ({ result: {}, fromImage: PNG, toImage: PNG, diffImage: PNG }),
    } as unknown as SeamService;
    const deps = {
      config,
      store,
      capture,
      seams,
      tokens,
      brands: {
        describe: async () => 'Notes de marque',
        dir: (id: string) => path.join(root, 'brands', id),
      } as unknown as BrandStore,
      templates: { describe: async () => 'Catalogue des modèles' } as unknown as TemplateStore,
      versions: {
        snapshot: async (_id: string, meta: { label: string }) => ({
          id: 'v0003',
          label: meta.label,
          files: ['scenes/intro.tsx'],
        }),
      } as unknown as VersionStore,
      music: {
        context: async (_id: string, sceneId?: string | null) =>
          sceneId ? `Grille de ${sceneId}` : 'Tempo 120\nCuts: intro → outro at 3.334 s: 0.334 s (0.67 beat) after bar 2',
        snapCuts: async (id: string, grid: string, opts: unknown) => (record('snapCuts', [id, grid, opts]), project),
      } as unknown as MusicService,
      assets: {} as AssetStore,
      voiceOver: {
        sync: async (id: string) => {
          record('syncVoiceOver', id);
          if (piperFails) throw new HttpError(500, 'Piper introuvable');
          // What Piper gives for "Un. Deux." from 0.5 s into outro (2 s to 4 s of the video).
          project = {
            ...project,
            scenes: project.scenes.map((s) => (s.id === 'outro' ? { ...s, voiceOver: { text: 'Un. Deux.', at: 0.5 } } : s)),
            voiceOverLines: [
              { sceneId: 'outro', text: 'Un.', start: 2.5, end: 3.4 },
              { sceneId: 'outro', text: 'Deux.', start: 3.4, end: 4.3 },
            ],
          };
        },
      } as unknown as VoiceOverService,
      diagnose: async () => null,
    };
    const handler = createMcpHandler(deps);
    server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
    return (await client.callTool({ name, arguments: args })) as Result;
  }

  const texts = (result: Result) => result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

  test('set_voice_over: a scene chat sets its own scene, gets when each sentence is spoken, and hears why Piper failed', async () => {
    const client = await connect(tokens.issue({ kind: 'scene', projectId: 'demo', sceneId: 'outro' }));
    try {
      const set = await call(client, 'set_voice_over', { text: 'Un. Deux.', at: 0.5 });
      assert.deepEqual(calls.updateScene.at(-1), ['demo', 'outro', { voiceOver: { text: 'Un. Deux.', at: 0.5 } }]);
      assert.deepEqual(calls.syncVoiceOver.at(-1), 'demo');
      assert.match(texts(set)[0], /^Voice-over \(voice fr_FR-siwis-medium, speed 1, music at 30 % while it speaks\)/);
      assert.match(
        texts(set)[0],
        /\n- outro: 0\.500-1\.400 "Un\." \/ 1\.400-2\.300 "Deux\."; it runs 0\.300 s past the end of the scene$/,
      );

      const other = await call(client, 'set_voice_over', { sceneId: 'logo', text: 'Non.' });
      assert.equal(other.isError, true);

      piperFails = true;
      const failed = await call(client, 'set_voice_over', { text: 'Trois.' });
      assert.deepEqual(
        calls.updateScene.at(-1),
        ['demo', 'outro', { voiceOver: { text: 'Trois.', at: 0.5 } }],
        'no at: the start stays',
      );
      assert.equal(failed.isError, true);
      assert.match(texts(failed)[0], /^The text is saved, but the voice could not be generated: Piper introuvable\./);
      piperFails = false;

      const removed = await call(client, 'set_voice_over', { text: '' });
      assert.equal(texts(removed)[0], 'outro has no voice-over any more.');
    } finally {
      await client.close();
    }
  });

  test('rejects requests without a valid token, from browsers, and other methods', async () => {
    const post = (headers: Record<string, string>, body = '{}') =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const missing = await post({});
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
    assert.match((await missing.json()).error.message, /Jeton MCP/);
    assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401);
    const revoked = tokens.issue({ kind: 'project', projectId: 'demo' });
    tokens.revoke(revoked);
    assert.equal((await post({ Authorization: `Bearer ${revoked}` })).status, 401);
    const valid = tokens.issue({ kind: 'project', projectId: 'demo' });
    assert.equal((await post({ Authorization: `Bearer ${valid}`, Origin: 'http://evil.test' })).status, 403);
    assert.equal((await post({ Authorization: `Bearer ${valid}` }, '{oops')).status, 400);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${valid}` } })).status, 405);
  });

  test('scene scope: its own scene only, no project tools', async () => {
    const token = tokens.issue({ kind: 'scene', projectId: 'demo', sceneId: 'intro' });
    const off = tokens.onActivity(token, (a) => activity.push(a));
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...SCENE_TOOLS].sort());
      const formatHelp = (name: string) =>
        (tools.find((t) => t.name === name)?.inputSchema.properties?.format as { description?: string }).description;
      assert.equal(formatHelp('check_seams'), 'Format to check; default: every project format.');
      assert.match(formatHelp('render_frames') ?? '', /primary format/);

      const rendered = await call(client, 'render_frames', { times: [0, 1.5, 99] });
      assert.equal(rendered.isError, false);
      assert.match(texts(rendered)[0], /^Rendered 3 frames of scene intro "intro" \(2\.000 s\) in 9:16 at 540×960\./);
      assert.match(texts(rendered)[0], /Render errors:\nReferenceError: x is not defined/);
      assert.deepEqual(texts(rendered).slice(1), ['t = 0.000 s', 't = 1.500 s', 't = 2.000 s']);
      const images = rendered.content.filter((c) => c.type === 'image');
      assert.equal(images.length, 3);
      assert.deepEqual(Buffer.from(images[0].data!, 'base64'), JPEG);
      assert.equal(images[0].mimeType, 'image/jpeg');
      const [, req] = calls.frames.at(-1) as [string, Record<string, unknown>];
      assert.deepEqual(req, {
        sceneId: 'intro',
        times: [0, 1.5, 2],
        format: '9:16',
        scale: 0.5,
        imageFormat: 'jpeg',
        quality: 82,
      });
      const frames = activity.at(-1);
      assert.ok(frames?.type === 'frames');
      assert.equal(frames.urls.length, 3);
      for (const frameUrl of frames.urls) {
        assert.match(frameUrl, /^\/api\/projects\/demo\/agent-frames\/\d+-\d+\.jpg$/);
        const saved = path.join(project.dir, '.cadence', 'frames', path.basename(frameUrl));
        assert.deepEqual(await fs.readFile(saved), JPEG);
      }

      const whole = await call(client, 'render_frames', { wholeVideo: true, times: [3], quality: 'high', format: '16:9' });
      assert.deepEqual(texts(whole).slice(1), ['video t = 3.000 s → scene outro at 1.000 s']);
      assert.deepEqual((calls.frames.at(-1) as [string, Record<string, unknown>])[1].sceneId, null);
      assert.equal((calls.frames.at(-1) as [string, Record<string, unknown>])[1].scale, 1);

      const other = await call(client, 'render_frames', { sceneId: 'outro', times: [0] });
      assert.equal(other.isError, true);
      assert.match(texts(other)[0], /limité à la scène « intro »/);

      const duration = await call(client, 'set_scene_duration', { seconds: 3.3336 });
      assert.match(texts(duration)[0], /^intro now lasts 3\.334 s \(1\.67 bars; was 2\.000 s\)/);
      assert.match(texts(duration)[0], /\nCuts: intro → outro at 3\.334 s: 0\.334 s \(0\.67 beat\) after bar 2$/);
      assert.deepEqual(calls.updateScene.at(-1), ['demo', 'intro', { duration: 3.334 }]);
      const otherDuration = await call(client, 'set_scene_duration', { sceneId: 'logo', seconds: 1 });
      assert.equal(otherDuration.isError, true);

      const seams = await call(client, 'check_seams', {});
      assert.deepEqual(calls.seams.at(-1), ['demo', { sceneId: 'intro', format: undefined }]);
      // Under 0.05 % of pixels a cut is invisible and sends no images.
      assert.match(
        texts(seams)[0],
        /intro → outro \(9:16\): 0\.06 % of pixels differ, a small visible jump\noutro → logo \(9:16\): 0\.04 % of pixels differ, invisible/,
      );
      assert.deepEqual(
        seams.content.filter((c) => c.type === 'image').map((c) => c.mimeType),
        ['image/png', 'image/png', 'image/png'],
      );
      assert.equal(activity.at(-1)?.type, 'seams');

      assert.match(texts(await call(client, 'get_music_context'))[0], /Grille de intro/);
      const wrongProject = await call(client, 'get_project', { projectId: 'autre' });
      assert.equal(wrongProject.isError, true);
      assert.match(texts(wrongProject)[0], /projet « demo »/);
      const structural = await call(client, 'create_scene', { name: 'Stats' });
      assert.equal(structural.isError, true);
      assert.equal(calls.createScene, undefined);
    } finally {
      off();
      await client.close();
    }
  });

  test('project scope: structure tools, explicit scene or whole video', async () => {
    const client = await connect(tokens.issue({ kind: 'project', projectId: 'demo' }));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...PROJECT_TOOLS].sort());

      const created = await call(client, 'create_scene', { name: 'Stats', template: 'stat-grid', after: 'intro' });
      assert.ok(!created.isError);
      assert.deepEqual(calls.createScene.at(-1), [
        'demo',
        { name: 'Stats', after: 'intro', template: 'stat-grid', code: undefined, duration: undefined },
      ]);
      assert.match(texts(created)[0], /Created scene stats "Stats"/);

      const snapped = await call(client, 'snap_cuts_to_music', { keepBars: true });
      assert.deepEqual(calls.snapCuts.at(-1), ['demo', 'bar', { keepBars: true }]);
      assert.match(texts(snapped)[0], /^Cuts moved to the bar lines, every scene keeping its bar count\./);
      assert.match(tools.find((t) => t.name === 'snap_cuts_to_music')?.description ?? '', /keepBars.*campaign/);
      await call(client, 'snap_cuts_to_music', { grid: 'phrase' });
      assert.deepEqual(calls.snapCuts.at(-1), ['demo', 'phrase', { keepBars: undefined }]);

      await call(client, 'move_scene', { sceneId: 'logo', position: 1 });
      assert.deepEqual(calls.reorderScenes.at(-1), ['demo', ['logo', 'intro', 'outro']]);

      const vague = await call(client, 'render_frames', { times: [0] });
      assert.equal(vague.isError, true);
      assert.match(texts(vague)[0], /Précise sceneId/);
      const missingScene = await call(client, 'render_frames', { sceneId: 'ghost', times: [0] });
      assert.match(texts(missingScene)[0], /Aucune scène « ghost »/);

      const badUrl = await call(client, 'capture_reference', { url: 'file:///etc/passwd' });
      assert.equal(badUrl.isError, true);
      assert.match(texts(badUrl)[0], /seules les adresses http\(s\)/);

      assert.match(
        texts(await call(client, 'save_version', { label: 'Avant refonte' }))[0],
        /Saved version v0003 "Avant refonte"/,
      );
    } finally {
      await client.close();
    }
  });

  test('brand scope: the brand tools only, copies confined to the clone and the brand folder', async () => {
    const repoDir = path.join(root, 'clone');
    await fs.mkdir(path.join(repoDir, 'public'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'public', 'logo.svg'), '<svg viewBox="0 0 1 1"/>');
    await fs.writeFile(path.join(repoDir, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(root, 'outside.svg'), '<svg/>');
    const client = await connect(tokens.issue({ kind: 'brand', brandId: 'acme', repoDir }));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...BRAND_TOOLS].sort());
      const copied = await call(client, 'copy_from_repo', { from: 'public/logo.svg', to: 'assets/logo-mark.svg' });
      assert.match(texts(copied)[0], /^Copied public\/logo\.svg to assets\/logo-mark\.svg/);
      const logo = path.join(root, 'brands', 'acme', 'assets', 'logo-mark.svg');
      assert.equal(await fs.readFile(logo, 'utf8'), '<svg viewBox="0 0 1 1"/>');
      for (const args of [
        { from: '.env', to: 'assets/env.svg' },
        { from: '../outside.svg', to: 'assets/outside.svg' },
        { from: 'public/logo.svg', to: '../../escape.svg' },
        { from: 'public/missing.svg', to: 'assets/missing.svg' },
      ]) {
        assert.equal((await call(client, 'copy_from_repo', args)).isError, true, JSON.stringify(args));
      }
      const preview = await call(client, 'preview_brand');
      assert.deepEqual(
        preview.content.map((c) => c.type),
        ['image', 'text'],
      );
      assert.match(texts(preview)[0], /Button : boom/);
      assert.deepEqual(calls.kitSheet, ['acme']);
      assert.match(texts(await call(client, 'check_brand'))[0], /problem\(s\):\n- brand\.json manquant[\s\S]*Button : boom/);
    } finally {
      await client.close();
    }
  });

  test('terminal scope: every tool, projectId required', async () => {
    const client = await connect(await tokens.terminalToken());
    try {
      const vague = await call(client, 'get_project');
      assert.equal(vague.isError, true);
      assert.match(texts(vague)[0], /Précise projectId .* Projets : demo, autre\./);
      const overview = texts(await call(client, 'get_project', { projectId: 'demo' }))[0];
      assert.match(overview, /^Project "Démo" \(id demo\)/);
      assert.match(overview, /\| 3 \| logo \| logo \| 4\.000 \| 2\.000 \| 1 \|/);
      const traversal = await call(client, 'get_project', { projectId: '../secret' });
      assert.equal(traversal.isError, true);
      assert.equal(texts(await call(client, 'list_templates'))[0], 'Catalogue des modèles');
    } finally {
      await client.close();
    }
  });
});
