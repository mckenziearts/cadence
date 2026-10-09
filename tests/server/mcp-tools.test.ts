import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PNG as Png } from 'pngjs';
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
import { type McpDeps, PROJECT_TOOLS, SCENE_TOOLS } from '../../server/mcp/tools';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import { HttpError } from '../../server/util';
import type { AuditFinding } from '../../src/shared/frameProtocol';
import type { CreateSceneInput, ProjectState, SceneState, ScriptLine, Speaker, VoiceOverSettings } from '../../src/shared/types';
import { makeRoot, type TestRoot } from './helpers';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHEET = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 0xff, 0xd9]);
/** What the frame checks find per time (null: they failed); clean at any other time. */
const CHECKS = new Map<number, AuditFinding[] | null>([
  [
    0.25,
    [
      { kind: 'clipped', text: 'A "long" title', box: { x: 100, y: 200, width: 640, height: 96 } },
      { kind: 'contrast', text: 'Grey label', box: { x: 100, y: 700, width: 300, height: 40 }, ratio: 2.31, required: 4.5 },
    ],
  ],
  [0.5, null],
]);
/** A PNG of its own per time, to see the sheet get the strip's frames in order. */
const tileAt = (t: number) => Buffer.concat([PNG, Buffer.from(String(t))]);
/** check_motion samples while set: lit pixels per (scene, t) of a black 200×100 frame, and a render error. */
let motion: ((sceneId: string, t: number) => { changed: number; error?: string }) | null = null;
function motionFrame(changed: number): Buffer {
  const png = new Png({ width: 200, height: 100 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.fill(i / 4 < changed ? 255 : 0, i, i + 3);
    png.data[i + 3] = 255;
  }
  return Png.sync.write(png);
}
/** 10 more lit pixels (0.05 %) per moving 0.25 s step; none during a hold. */
const litExcept = (holds: [number, number][], error?: (t: number) => string | undefined) => (_sceneId: string, t: number) => {
  let changed = 0;
  for (let at = 0.25; at <= t + 1e-9; at += 0.25) if (!holds.some(([a, b]) => at > a && at <= b + 1e-9)) changed += 10;
  return { changed, error: error?.(t) };
};

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
    voiceOverError: null,
    captions: false,
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
  let elevenLabsKey = true;
  let elevenLabsError: HttpError | null = null;

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
      update: async (id: string, patch: Partial<ProjectState>) => {
        record('update', [id, patch]);
        return { ...project, ...patch };
      },
      setSpeakers: async (id: string, speakers: Speaker[], settings: VoiceOverSettings) => {
        record('setSpeakers', [id, speakers, settings]);
        return { ...project, voiceOver: { ...settings, speakers } };
      },
      reorderScenes: async (id: string, ids: string[]) => {
        record('reorderScenes', [id, ids]);
        return { ...project, scenes: ids.map((sid) => project.scenes.find((s) => s.id === sid)!) };
      },
    } as unknown as ProjectStore;
    const capture = {
      frames: async (
        id: string,
        req: { sceneId: string | null; times: number[]; imageFormat?: string; audit?: boolean; deadline?: number },
      ) => {
        record('frames', [id, req]);
        if (motion) {
          const out = [];
          for (const t of req.times) {
            if (req.deadline !== undefined && Date.now() >= req.deadline) break;
            const { changed, error } = motion(req.sceneId!, t);
            out.push({
              t,
              sceneId: req.sceneId,
              localTime: t,
              image: motionFrame(changed),
              mime: 'image/png',
              errors: error ? [error] : [],
            });
          }
          return out;
        }
        const png = req.imageFormat === 'png';
        return req.times.map((t) => ({
          t,
          sceneId: req.sceneId ?? 'outro',
          localTime: req.sceneId ? t : t - 2,
          image: png ? tileAt(t) : JPEG,
          mime: png ? 'image/png' : 'image/jpeg',
          errors: t === 1.5 ? ['ReferenceError: x is not defined'] : [],
          ...(req.audit ? { audit: CHECKS.has(t) ? CHECKS.get(t)! : [] } : {}),
        }));
      },
      contactSheet: async (tiles: Buffer[], layout: unknown) => (record('contactSheet', [tiles, layout]), SHEET),
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
      templates: {
        describe: async () => 'Modèle dialogue : composants Mouth ; locuteurs camille, sami',
      } as unknown as TemplateStore,
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
          // What the engine gives for "Un. Deux." (or two lines saying them) from 0.5 s into outro (2 s to 4 s of the video).
          const [, , patch] = calls.updateScene.at(-1) as [string, string, { voiceOver: { lines?: ScriptLine[] } }];
          const lines = patch.voiceOver.lines;
          project = {
            ...project,
            scenes: project.scenes.map((s) =>
              s.id === 'outro'
                ? { ...s, voiceOver: lines ? { text: 'Un.\nDeux.', at: 0.5, lines } : { text: 'Un. Deux.', at: 0.5 } }
                : s,
            ),
            voiceOverLines: [
              { sceneId: 'outro', text: 'Un.', start: 2.5, end: 3.4, speaker: lines?.[0].speaker ?? null, words: [], level: [] },
              {
                sceneId: 'outro',
                text: 'Deux.',
                start: 3.4,
                end: 4.3,
                speaker: lines?.[1].speaker ?? null,
                words: [],
                level: [],
              },
            ],
          };
        },
        voices: async () => ({
          piper: { ok: true },
          voices: [
            { id: 'fr_FR-siwis-medium', language: 'fr', locale: 'fr_FR', name: 'Siwis', installed: true },
            { id: 'en_GB-alba-medium', language: 'en', locale: 'en_GB', name: 'Alba', installed: false },
          ],
          elevenLabs: { configured: elevenLabsKey },
        }),
        elevenLabs: async () => {
          if (!elevenLabsKey) throw new HttpError(409, 'Ajoute une clé ElevenLabs dans l’onglet Voix.');
          if (elevenLabsError) throw elevenLabsError;
          return {
            voices: [
              { id: 'voice-camille', name: 'Camille', category: 'premade', previewUrl: null, languages: ['fr', 'en'] },
              { id: 'voice-sami', name: 'Sami', category: 'cloned', previewUrl: null, languages: [] },
            ],
            models: [],
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

  test('set_voice_over with lines: text or lines, never both; each spoken sentence answered with its speaker; text refused over lines', async () => {
    const before = project;
    project = {
      ...project,
      voiceOver: {
        ...project.voiceOver,
        speakers: [
          { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium', color: '#ff2e88' },
          { id: 'sami', name: 'Sami', voice: 'fr_FR-tom-medium' },
        ],
      },
    };
    const client = await connect(tokens.issue({ kind: 'project', projectId: 'demo' }));
    try {
      const lines = [
        { speaker: 'camille', text: 'Un.', gesture: 'wave' },
        { speaker: 'sami', text: 'Deux.' },
      ];
      const set = await call(client, 'set_voice_over', { sceneId: 'outro', lines, at: 0.5 });
      assert.ok(!set.isError, texts(set)[0]);
      assert.deepEqual(calls.updateScene.at(-1), ['demo', 'outro', { voiceOver: { lines, at: 0.5 } }]);
      assert.match(
        texts(set)[0],
        /\nSpeakers: camille "Camille" \(voice fr_FR-siwis-medium\), sami "Sami" \(voice fr_FR-tom-medium\)\n/,
      );
      assert.match(texts(set)[0], /\n- outro: 0\.500-1\.400 camille: "Un\." \/ 1\.400-2\.300 sami: "Deux\."/);
      assert.match(texts(await call(client, 'get_project'))[0], /\n- outro: 0\.500-1\.400 camille: "Un\."/);

      const updates = calls.updateScene.length;
      const both = await call(client, 'set_voice_over', { sceneId: 'outro', text: 'Trois.', lines });
      assert.equal(both.isError, true);
      assert.match(texts(both)[0], /un texte ou des répliques, pas les deux/);
      const neither = await call(client, 'set_voice_over', { sceneId: 'outro', at: 1 });
      assert.equal(neither.isError, true);

      const overLines = await call(client, 'set_voice_over', { sceneId: 'outro', text: 'Trois.' });
      assert.equal(overLines.isError, true);
      assert.match(texts(overLines)[0], /« outro » .*lines/);
      assert.equal(calls.updateScene.length, updates, 'nothing written');

      piperFails = true;
      const failed = await call(client, 'set_voice_over', { sceneId: 'outro', lines });
      assert.equal(failed.isError, true);
      assert.match(texts(failed)[0], /could not be generated: Piper introuvable\./);
    } finally {
      piperFails = false;
      project = before;
      await client.close();
    }
  });

  test('list_voices: the installed Piper voices, the ElevenLabs voices, or why there are none', async () => {
    const before = project;
    const client = await connect(tokens.issue({ kind: 'project', projectId: 'demo' }));
    try {
      const piper = await call(client, 'list_voices');
      assert.ok(!piper.isError);
      assert.match(texts(piper)[0], /\n- fr_FR-siwis-medium: Siwis \(fr, fr_FR\)/);
      assert.doesNotMatch(texts(piper)[0], /alba/, 'a voice not downloaded is not offered');

      project = {
        ...project,
        voiceOver: { engine: 'elevenlabs', voice: 'voice-camille', model: 'eleven_v3', speed: 1, musicLevel: 0.3 },
      };
      const eleven = texts(await call(client, 'list_voices'))[0];
      assert.match(eleven, /\n- voice-camille: Camille \(fr, en\)\n- voice-sami: Sami \(language not given\)$/);

      elevenLabsKey = false;
      const noKey = await call(client, 'list_voices');
      assert.ok(!noKey.isError);
      assert.equal(texts(noKey)[0], 'Ajoute une clé ElevenLabs dans l’onglet Voix.');

      elevenLabsKey = true;
      elevenLabsError = new HttpError(402, 'Crédits épuisés');
      const noCredits = await call(client, 'list_voices');
      assert.equal(noCredits.isError, true, 'only a missing key is an answer, any other failure stays an error');
      assert.match(texts(noCredits)[0], /Crédits épuisés/);
    } finally {
      elevenLabsKey = true;
      elevenLabsError = null;
      project = before;
      await client.close();
    }
  });

  test('set_speakers: replaces the speakers in the project settings and lists them', async () => {
    const client = await connect(tokens.issue({ kind: 'project', projectId: 'demo' }));
    try {
      const speakers = [{ id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium', color: '#ff2e88' }];
      const set = await call(client, 'set_speakers', { speakers });
      assert.ok(!set.isError, texts(set)[0]);
      assert.deepEqual(calls.setSpeakers.at(-1), ['demo', speakers, { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 }]);
      assert.match(texts(set)[0], /^Speakers: camille "Camille" \(voice fr_FR-siwis-medium\)$/);
      const none = await call(client, 'set_speakers', { speakers: [] });
      assert.match(texts(none)[0], /no speakers/);
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
        audit: true,
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
      const updates = calls.setSpeakers?.length;
      for (const name of ['list_voices', 'set_speakers']) {
        assert.ok(PROJECT_TOOLS.includes(name) && !SCENE_TOOLS.includes(name), name);
        assert.equal((await call(client, name, { speakers: [] })).isError, true, name);
      }
      assert.equal(calls.setSpeakers?.length, updates);
    } finally {
      off();
      await client.close();
    }
  });

  test('render_frames checks: a block per frame with findings or failed checks, nothing for clean frames, never an error', async () => {
    const client = await connect(tokens.issue({ kind: 'scene', projectId: 'demo', sceneId: 'intro' }));
    try {
      const checked = await call(client, 'render_frames', { times: [0, 0.25, 0.5], format: '16:9' });
      assert.equal(checked.isError, false);
      assert.equal(
        texts(checked)[0],
        'Rendered 3 frames of scene intro "intro" (2.000 s) in 16:9 at 960\u00d7540.\n' +
          'Checks at 0.250 s (16:9):\n' +
          '- clipped by its container: "A \\"long\\" title" at 100,200 (640\u00d796)\n' +
          '- contrast 2.31:1 (needs 4.5): "Grey label" at 100,700 (300\u00d740)\n' +
          'Checks at 0.500 s (16:9): unavailable.',
      );
      assert.deepEqual(texts(checked).slice(1), ['t = 0.000 s', 't = 0.250 s', 't = 0.500 s']);

      const failing = await call(client, 'render_frames', { times: [0.5, 1.5] });
      assert.equal(failing.isError, false, 'checks never make a frame fail');
      assert.match(
        texts(failing)[0],
        /Render errors:\nReferenceError: x is not defined\nChecks at 0\.500 s \(9:16\): unavailable\.$/,
      );

      await call(client, 'render_frames', { strip: { at: 0.25, frames: 4 } });
      assert.equal((calls.frames.at(-1) as [string, { audit?: boolean }])[1].audit, undefined, 'strips run no checks');
    } finally {
      await client.close();
    }
  });

  test('render_frames strip: one contact sheet around a moment, times clamped and deduplicated', async () => {
    const token = tokens.issue({ kind: 'scene', projectId: 'demo', sceneId: 'intro' });
    const off = tokens.onActivity(token, (a) => activity.push(a));
    const client = await connect(token);
    try {
      const end = await call(client, 'render_frames', { strip: { at: 2, frames: 4 } });
      assert.equal(end.isError, false);
      const [, req] = calls.frames.at(-1) as [string, Record<string, unknown>];
      assert.deepEqual(req, { sceneId: 'intro', times: [1.967, 1.983, 2], format: '9:16', scale: 0.25, imageFormat: 'png' });
      assert.match(
        texts(end)[0],
        /^Rendered a strip of 3 frames of scene intro "intro" \(2\.000 s\) in 9:16: one contact sheet, 3 tiles per row at 270×480 each\.$/,
      );
      assert.equal(texts(end)[1], 'Tiles, left to right then top to bottom:\n1. t = 1.967 s\n2. t = 1.983 s\n3. t = 2.000 s');
      const images = end.content.filter((c) => c.type === 'image');
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, 'image/jpeg');
      assert.deepEqual(Buffer.from(images[0].data!, 'base64'), SHEET);
      assert.deepEqual(calls.contactSheet.at(-1), [[1.967, 1.983, 2].map(tileAt), { columns: 6, gap: 4 }]);
      const frames = activity.at(-1);
      assert.ok(frames?.type === 'frames');
      assert.deepEqual(frames.times, [1.967, 1.983, 2]);
      assert.equal(frames.urls.length, 1);
      assert.match(frames.urls[0], /\.jpg$/);
      const saved = path.join(project.dir, '.cadence', 'frames', path.basename(frames.urls[0]));
      assert.deepEqual(await fs.readFile(saved), SHEET, 'the editor chat shows the image the agent got');

      const landscape = await call(client, 'render_frames', { strip: { at: 1.5 }, format: '16:9' });
      const times = (calls.frames.at(-1) as [string, { times: number[] }])[1].times;
      assert.equal(times.length, 12, 'twelve frames by default, beyond the 8-frame limit of times');
      assert.deepEqual([times[0], times[6], times[11]], [1.4, 1.5, 1.583]);
      assert.match(texts(landscape)[0], /4 tiles per row at 480×270 each\.\nRender errors:\nReferenceError: x is not defined/);
      assert.deepEqual(calls.contactSheet.at(-1), [times.map(tileAt), { columns: 4, gap: 4 }]);

      const portrait = await call(client, 'render_frames', { strip: { at: 1 } });
      assert.match(texts(portrait)[0], /12 frames .* 6 tiles per row at 270×480 each\./);
      assert.deepEqual((calls.contactSheet.at(-1) as unknown[])[1], { columns: 6, gap: 4 });
      const square = await call(client, 'render_frames', { strip: { at: 1 }, format: '1:1' });
      assert.match(texts(square)[0], /in 1:1: one contact sheet, 4 tiles per row at 270×270 each\./);
      assert.deepEqual((calls.contactSheet.at(-1) as unknown[])[1], { columns: 4, gap: 4 });

      const start = await call(client, 'render_frames', { strip: { at: 0 } });
      assert.deepEqual((calls.frames.at(-1) as [string, { times: number[] }])[1].times, [0, 0.017, 0.033, 0.05, 0.067, 0.083]);
      assert.equal(start.isError, false);

      const odd = await call(client, 'render_frames', { strip: { at: 1, frames: 5 }, quality: 'high' });
      assert.equal(odd.isError, false);
      const [, oddReq] = calls.frames.at(-1) as [string, { times: number[]; scale: number }];
      assert.deepEqual(oddReq.times, [0.967, 0.983, 1, 1.017, 1.033], 'an odd count centres on at');
      assert.equal(oddReq.scale, 0.25, 'quality leaves strip tiles at quarter size');
      await call(client, 'render_frames', { strip: { at: 1, frames: 24 } });
      assert.equal((calls.frames.at(-1) as [string, { times: number[] }])[1].times.length, 24);
      project.fps = 24;
      try {
        await call(client, 'render_frames', { strip: { at: 1, frames: 4 } });
      } finally {
        project.fps = 60;
      }
      const at24 = (calls.frames.at(-1) as [string, { times: number[] }])[1].times;
      assert.deepEqual(at24, [0.917, 0.958, 1, 1.042], 'one tile per video frame at 24 fps');

      const before = calls.frames.length;
      for (const args of [{}, { times: [0], strip: { at: 1 } }]) {
        const rejected = await call(client, 'render_frames', args);
        assert.equal(rejected.isError, true, JSON.stringify(args));
        assert.equal(texts(rejected)[0], 'Passe soit times, soit strip, pas les deux.');
      }
      for (const strip of [{ at: 1, frames: 3 }, { at: 1, frames: 25 }, { at: 1, frames: 4.5 }, { at: -1 }]) {
        const rejected = await call(client, 'render_frames', { strip });
        assert.equal(rejected.isError, true, JSON.stringify(strip));
      }
      assert.equal(calls.frames.length, before);
    } finally {
      off();
      await client.close();
    }
  });

  test('check_motion: samples every 0.25 s at half size, refuses a scene that never moves, lists still stretches of 2 s or more', async () => {
    const saved = project;
    /** The project with scenes of these durations (intro, outro, logo, then s3, s4...). */
    const withScenes = (durations: number[]) => {
      let start = 0;
      const scenes = durations.map((duration, index) => {
        const scene = { ...saved.scenes[0], id: saved.scenes[index]?.id ?? `s${index}`, index, start, duration };
        start += duration;
        return scene;
      });
      project = { ...saved, scenes, duration: start };
    };
    let before = 0;
    const motionCalls = () =>
      (calls.frames ?? []).slice(before) as [string, { sceneId: string; times: number[]; deadline: number }][];
    const check = async (client: Client, args: Record<string, unknown>) => {
      before = calls.frames?.length ?? 0;
      const result = await call(client, 'check_motion', args);
      return { result, summary: texts(result)[0] };
    };
    /** Each scene's sampled times, its batches joined in call order. */
    const sampledTimes = () => {
      const byScene = new Map<string, number[]>();
      for (const [, req] of motionCalls()) byScene.set(req.sceneId, [...(byScene.get(req.sceneId) ?? []), ...req.times]);
      return byScene;
    };
    const increasing = (times: number[]) => times.every((t, i) => i === 0 || t > times[i - 1]);
    const scene = await connect(tokens.issue({ kind: 'scene', projectId: 'demo', sceneId: 'intro' }));
    const client = await connect(tokens.issue({ kind: 'project', projectId: 'demo' }));
    try {
      // Only Date: the deadline is read from it, the HTTP transport keeps its real timers.
      mock.timers.enable({ apis: ['Date'], now: 0 });
      motion = () => ({ changed: 0 });
      const frozen = await check(scene, {});
      assert.equal(frozen.result.isError, true);
      // Odd samples one video frame (1/60 s) late: a pulse on a 0.25 s grid is not the same value at every sample.
      assert.deepEqual(motionCalls(), [
        [
          'demo',
          {
            sceneId: 'intro',
            times: [0, 0.267, 0.5, 0.767, 1, 1.267, 1.5, 1.767, 2],
            format: '9:16',
            scale: 0.5,
            imageFormat: 'png',
            captions: false,
            deadline: 240_000,
          },
        ],
      ]);
      assert.equal(
        frozen.summary,
        'Motion of scene intro "intro" (2.000 s) in 9:16: a sample every 0.250 s at 540×960, consecutive samples compared like check_seams. Still means under 0.01 % of pixels changing; still stretches of about 2 s or more (measured between samples) are listed.\n' +
          '- intro does not move: add motion (a slow push-in, a drift) or shorten it.',
      );
      const other = await check(scene, { sceneId: 'outro' });
      assert.equal(other.result.isError, true);
      assert.match(other.summary, /limité à la scène « intro » : vérifie le mouvement de ta scène\./);
      assert.equal(motionCalls().length, 0);

      motion = litExcept([]);
      const moving = await check(client, { format: '16:9' });
      assert.equal(moving.result.isError, false);
      assert.deepEqual(
        motionCalls().map(([, req]) => req.sceneId),
        ['intro', 'outro', 'logo'],
      );
      assert.match(moving.summary, /^Motion of 3 scenes \(6\.000 s\) in 16:9: a sample every 0\.250 s at 960×540,/);
      assert.match(moving.summary, /\n- intro: moves throughout\.\n- outro: moves throughout\.\n- logo: moves throughout\.$/);

      // A hold under 2 s is never flagged, a still stretch from 2 s is listed, a still scene under 2 s is a hold.
      for (const [durations, holds, line] of [
        [
          [5],
          [
            [0, 1.75],
            [2, 4.5],
          ],
          '- intro: still from 2.000 s to 4.500 s.',
        ],
        [[5], [[0.5, 2.5]], '- intro: still from 0.500 s to 2.500 s.'],
        [[5], [[0.5, 2.25]], '- intro: moves throughout.'],
        [[1.75], [[0, 1.75]], '- intro: still for 1.750 s, under 2 s: a deliberate hold.'],
        [[1.996], [[0, 1.996]], '- intro: still for 1.996 s, under 2 s: a deliberate hold.'],
      ] as [number[], [number, number][], string][]) {
        withScenes(durations);
        motion = litExcept(holds);
        const listed = await check(client, { sceneId: 'intro' });
        assert.equal(listed.result.isError, false, line);
        assert.equal(listed.summary.split('\n').at(-1), line);
      }

      // Under 0.01 % of pixels is still: 1 of 20 000 pixels (0.005 %) is still, 2 (0.01 %) is motion.
      withScenes([2]);
      for (const [lit, still] of [
        [1, true],
        [2, false],
      ] as const) {
        motion = (_sceneId, t) => ({ changed: t === 1 ? lit : 0 });
        const flicker = await check(client, { sceneId: 'intro' });
        assert.equal(flicker.result.isError, still, `${lit} pixel(s)`);
      }

      // A render error stops that scene, reported like render_frames; the error alone never makes the result fail.
      withScenes([3, 2]);
      const stillThenBroken = litExcept([[0, 3]], (t) => (t >= 2.5 ? 'ReferenceError: boom' : undefined));
      motion = (sceneId, t) => (sceneId === 'intro' ? stillThenBroken : litExcept([]))(sceneId, t);
      const broken = await check(client, {});
      assert.equal(broken.result.isError, false);
      assert.match(
        broken.summary,
        /\n- intro: stopped at 2\.500 s by a render error; before it: still from 0\.000 s to 2\.267 s\.\n- outro: moves throughout\.\nRender errors:\nReferenceError: boom$/,
      );
      motion = () => ({ changed: 0, error: 'ReferenceError: boom' });
      const failing = await check(client, {});
      assert.equal(failing.result.isError, true, 'nothing could be checked');
      assert.match(failing.summary, /\n- intro: stopped at 0\.000 s by a render error; nothing checked\./);
      // Cut short, a still start is not called a hold: the rest of the scene was never seen.
      withScenes([3]);
      motion = litExcept([[0, 3]], (t) => (t >= 1.5 ? 'ReferenceError: boom' : undefined));
      const cutShort = await check(client, { sceneId: 'intro' });
      assert.match(
        cutShort.summary,
        /\n- intro: stopped at 1\.500 s by a render error; before it: still for 1\.267 s\.\nRender errors:/,
      );
      // One sample before the error compares nothing: the scene is not checked either.
      withScenes([2]);
      motion = litExcept([], (t) => (t >= 0.25 ? 'ReferenceError: boom' : undefined));
      const second = await check(client, {});
      assert.equal(second.result.isError, true, 'one sample checks nothing');
      assert.match(second.summary, /\n- intro: stopped at 0\.267 s by a render error; nothing checked\./);
      withScenes([2, 2]);
      assert.equal((await check(client, {})).result.isError, true, 'no scene got two samples');

      // At most 120 samples per scene and 600 per call: the step widens, no scene is dropped, and the result says so.
      withScenes([60]);
      motion = litExcept([]);
      const long = await check(client, { sceneId: 'intro' });
      const longTimes = sampledTimes().get('intro')!;
      assert.equal(longTimes.length, 120);
      assert.equal(longTimes.at(-1), 60);
      assert.match(
        long.summary,
        /\n- intro: moves throughout\. Sampled every 0\.504 s instead of 0\.250 s \(at most 120 samples per scene and 600 per call\)\.$/,
      );
      withScenes([30, 30, 30, 30, 30, 30]);
      const many = await check(client, {});
      const sampled = sampledTimes();
      assert.deepEqual([...sampled.keys()], ['intro', 'outro', 'logo', 's3', 's4', 's5']);
      assert.ok([...sampled.values()].reduce((sum, times) => sum + times.length, 0) <= 600);
      assert.ok([...sampled.values()].every((times) => times.length <= 120 && times.at(-1) === 30 && increasing(times)));
      assert.equal(many.summary.match(/Sampled every 0\.306 s instead of 0\.250 s/g)?.length, 6);
      // A widened step can land its last sample on the scene's end once rounded: no time is sampled twice.
      withScenes([2.069, 30, 30, 30, 30, 30]);
      await check(client, {});
      assert.deepEqual(sampledTimes().get('intro')!.slice(-2), [1.827, 2.069]);
      assert.ok([...sampledTimes().values()].every(increasing));

      // Out of time (240 s, under the 300 s MCP tool timeout): the scene in progress stops, the next ones never start.
      withScenes([3, 3, 3]);
      const deadline = Date.now() + 240_000;
      motion = (sceneId, t) => {
        if (sceneId === 'outro' && t === 2.5) mock.timers.tick(240_000);
        return sceneId === 'outro' ? { changed: 0 } : litExcept([])(sceneId, t);
      };
      const late = await check(client, {});
      assert.deepEqual([...sampledTimes().keys()], ['intro', 'outro']);
      assert.ok(motionCalls().every(([, req]) => req.deadline === deadline));
      assert.equal(late.result.isError, false, 'a scene cut short is not frozen');
      assert.match(
        late.summary,
        /\n- intro: moves throughout\.\n- outro: stopped at 2\.767 s, out of time; before it: still from 0\.000 s to 2\.500 s\. Run check_motion on this scene alone\.\n- logo: not checked, out of time: run check_motion on this scene alone\.$/,
      );
      withScenes([3, 3]);
      motion = (_sceneId, t) => {
        if (t === 0) mock.timers.tick(240_000);
        return { changed: 0 };
      };
      const none = await check(client, {});
      assert.equal(none.result.isError, true, 'nothing could be checked in time');
      assert.match(
        none.summary,
        /\n- intro: stopped at 0\.267 s, out of time; nothing checked\. Run check_motion on this scene alone\.\n- outro: not checked, out of time: run check_motion on this scene alone\.$/,
      );
    } finally {
      mock.timers.reset();
      motion = null;
      project = saved;
      await scene.close();
      await client.close();
    }
  });

  test('check_motion asks the capture for small batches, never a whole long scene at once', async () => {
    const saved = project;
    project = { ...saved, scenes: [{ ...saved.scenes[0], duration: 10 }], duration: 10 };
    const client = await connect(tokens.issue({ kind: 'project', projectId: 'demo' }));
    try {
      const before = calls.frames?.length ?? 0;
      // The hold starts in the first batch (samples up to 2.767 s) and ends in the second.
      motion = litExcept([[2.5, 5.5]]);
      const result = await call(client, 'check_motion', { sceneId: 'intro' });
      const batches = ((calls.frames ?? []).slice(before) as [string, { times: number[] }][]).map(([, req]) => req.times);
      assert.deepEqual(
        batches.map((times) => times.length),
        [12, 12, 12, 5],
      );
      assert.equal(batches.flat().length, new Set(batches.flat()).size);
      assert.deepEqual([batches[0][0], batches.at(-1)!.at(-1)], [0, 10]);
      assert.equal(result.isError, false);
      assert.equal(texts(result)[0].split('\n').at(-1), '- intro: still from 2.500 s to 5.500 s.');
    } finally {
      motion = null;
      project = saved;
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

      const videoEnd = await call(client, 'render_frames', { wholeVideo: true, strip: { at: 6, frames: 4 } });
      assert.equal(videoEnd.isError, false);
      const [, videoReq] = calls.frames.at(-1) as [string, { sceneId: string | null; times: number[] }];
      assert.equal(videoReq.sceneId, null);
      assert.deepEqual(videoReq.times, [5.967, 5.983, 6]);
      assert.match(texts(videoEnd)[0], /^Rendered a strip of 3 frames of the whole video \(6\.000 s\) in 9:16:/);
      assert.equal(
        texts(videoEnd)[1],
        'Tiles, left to right then top to bottom:\n' +
          '1. video t = 5.967 s \u2192 scene outro at 3.967 s\n' +
          '2. video t = 5.983 s \u2192 scene outro at 3.983 s\n' +
          '3. video t = 6.000 s \u2192 scene outro at 4.000 s',
      );

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
      assert.equal(
        texts(await call(client, 'list_templates'))[0],
        'Modèle dialogue : composants Mouth ; locuteurs camille, sami',
      );
    } finally {
      await client.close();
    }
  });
});

describe('MCP voice tools on the real project store', () => {
  let t: TestRoot;
  let store: FileProjectStore;
  let server: http.Server;
  let tokens: McpTokens;
  let url: string;
  let projectId: string;
  // A write that lands once between a tool's read of the project and its own write.
  let meanwhile: (() => Promise<unknown>) | null = null;

  before(async () => {
    t = await makeRoot();
    store = new FileProjectStore(t.config, { templates: new FileTemplateStore(t.config), brands: new FileBrandStore(t.config) });
    projectId = (await store.create({ name: 'Dialogue', brand: null, formats: ['16:9'], fps: 30 })).id;
    tokens = new McpTokens(t.config, path.join(t.root, 'mcp-token'));
    const voiceOver = { sync: async () => {} } as unknown as VoiceOverService;
    const racing = new Proxy(store, {
      get: (target, key) => {
        if (key === 'get') {
          return async (id: string) => {
            const state = await target.get(id);
            const write = meanwhile;
            meanwhile = null;
            await write?.();
            return state;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const handler = createMcpHandler({ config: t.config, store: racing, tokens, voiceOver } as unknown as McpDeps);
    server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await t.cleanup();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<Result> {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const token = tokens.issue({ kind: 'project', projectId });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      return (await client.callTool({ name, arguments: args })) as Result;
    } finally {
      await client.close();
    }
  }
  const message = (result: Result) => result.content.map((c) => c.text ?? '').join('\n');
  const speaker = (id: string, voice = 'fr_FR-siwis-medium') => ({ id, name: id, voice });

  test('set_speakers: the store refuses a bad voice, 11 speakers and removing a speaker a line uses', async () => {
    const set = await call('set_speakers', { speakers: [speaker('camille'), speaker('sami', 'fr_FR-tom-medium')] });
    assert.ok(!set.isError, message(set));
    assert.deepEqual(
      (await store.get(projectId)).voiceOver.speakers?.map((s) => s.id),
      ['camille', 'sami'],
    );

    const badVoice = await call('set_speakers', { speakers: [speaker('camille', 'nope')] });
    assert.equal(badVoice.isError, true);
    assert.match(message(badVoice), /^Réglages de voix off invalides/);
    const eleven = await call('set_speakers', { speakers: Array.from({ length: 11 }, (_, i) => speaker(`s${i}`)) });
    assert.equal(eleven.isError, true);
    assert.match(message(eleven), /^Réglages de voix off invalides/);

    const [scene] = (await store.get(projectId)).scenes;
    await store.updateScene(projectId, scene.id, { voiceOver: { lines: [{ speaker: 'sami', text: 'Salut.' }], at: 0 } });
    const removed = await call('set_speakers', { speakers: [speaker('camille')] });
    assert.equal(removed.isError, true);
    assert.equal(message(removed), `Le locuteur "sami" dit encore des répliques dans la scène "${scene.name}"`);
    assert.equal((await store.get(projectId)).voiceOver.speakers?.length, 2, 'nothing changed');
  });

  test('set_voice_over with text over a scene said in lines is refused and the lines stay', async () => {
    await store.update(projectId, {
      voiceOver: {
        voice: 'fr_FR-siwis-medium',
        speed: 1,
        musicLevel: 0.3,
        speakers: [speaker('camille'), speaker('sami', 'fr_FR-tom-medium')],
      },
    });
    const [scene] = (await store.get(projectId)).scenes;
    const lines = [{ id: 'bonjour', speaker: 'camille', text: 'Bonjour.' }];
    await store.updateScene(projectId, scene.id, { voiceOver: { lines, at: 0.5 } });

    const result = await call('set_voice_over', { sceneId: scene.id, text: 'Autre chose.' });
    assert.equal(result.isError, true);
    assert.match(message(result), /lines/);
    assert.deepEqual((await store.get(projectId)).scenes[0].voiceOver, { text: 'Bonjour.', at: 0.5, lines });
  });

  test('set_voice_over with a speaker the project lacks points to set_speakers and writes nothing', async () => {
    const [scene] = (await store.get(projectId)).scenes;
    const before = scene.voiceOver;

    const result = await call('set_voice_over', { sceneId: scene.id, lines: [{ speaker: 'zoe', text: 'Salut.' }] });
    assert.equal(result.isError, true);
    assert.equal(
      message(result),
      "« zoe » n'est pas un locuteur du projet : une réplique nomme l'id d'un locuteur réglé avec set_speakers (dans le chat du projet).",
    );
    assert.deepEqual((await store.get(projectId)).scenes[0].voiceOver, before);
  });

  test('set_voice_over with an empty text removes the voice-over of a scene said in lines', async () => {
    const [scene] = (await store.get(projectId)).scenes;
    await store.updateScene(projectId, scene.id, { voiceOver: { lines: [{ speaker: 'camille', text: 'Bonjour.' }], at: 0 } });

    const result = await call('set_voice_over', { sceneId: scene.id, text: '' });
    assert.ok(!result.isError, message(result));
    assert.equal(message(result), `${scene.id} has no voice-over any more.`);
    assert.equal((await store.get(projectId)).scenes[0].voiceOver, undefined);
  });

  test('set_speakers on an ElevenLabs project keeps the engine, the project model and each speaker model', async () => {
    const settings = {
      engine: 'elevenlabs' as const,
      voice: 'JBFqnCBsd6RMkjVDRZzb',
      model: 'eleven_multilingual_v2',
      speed: 1,
      musicLevel: 0.3,
    };
    await store.update(projectId, { voiceOver: settings });
    const camille = { id: 'camille', name: 'Camille', voice: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_v3' };

    const result = await call('set_speakers', { speakers: [camille] });
    assert.ok(!result.isError, message(result));
    assert.deepEqual((await store.get(projectId)).voiceOver, { ...settings, speakers: [camille] });
  });

  test('set_speakers keeps a voice-over change saved after it read the project', async () => {
    await store.update(projectId, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 } });
    const changed = { voice: 'fr_FR-tom-medium', speed: 1.2, musicLevel: 0.5 };
    meanwhile = () => store.update(projectId, { voiceOver: changed });

    const result = await call('set_speakers', { speakers: [speaker('camille')] });
    assert.ok(!result.isError, message(result));
    assert.equal(meanwhile, null, 'the change landed');
    assert.deepEqual((await store.get(projectId)).voiceOver, { ...changed, speakers: [speaker('camille')] });
  });
});
