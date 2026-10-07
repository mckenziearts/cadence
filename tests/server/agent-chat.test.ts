import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatManager, activityLabel, allowRules } from '../../server/agent/chat';
import type {
  AgentEvent,
  AgentProvider,
  AgentTurn,
  AssetStore,
  BrandStore,
  CadenceConfig,
  CaptureService,
  MusicService,
  ProjectStore,
  SeamService,
  SettingsStore,
  TemplateStore,
  VersionStore,
} from '../../server/contracts';
import { McpTokens } from '../../server/mcp/tokens';
import { FileUsageLog } from '../../server/usage';
import { HttpError } from '../../server/util';
import type {
  ChatKey,
  ChatState,
  ProjectState,
  ServerEvent,
  Settings,
  VersionEntry,
  VersionSource,
} from '../../src/shared/types';

type Script = (turn: AgentTurn, index: number) => AsyncIterable<AgentEvent>;

const SETTINGS: Settings = {
  sceneModel: 'claude-opus-5-5',
  sceneEffort: 'high',
  projectModel: 'claude-sonnet-5-5',
  projectEffort: 'medium',
  language: 'fr',
  agent: 'claude-code',
};

function makeProject(dir: string, ids: string[]): ProjectState {
  let start = 0;
  const scenes = ids.map((id, index) => {
    const scene = {
      id,
      name: id.toUpperCase(),
      duration: 2,
      template: null,
      index,
      start,
      file: path.join(dir, 'scenes', `${id}.tsx`),
      url: `/@fs${dir}/scenes/${id}.tsx`,
      codeVersion: 'abc',
    };
    start += 2;
    return scene;
  });
  return {
    id: 'demo',
    dir,
    name: 'Démo',
    brand: null,
    fps: 60,
    formats: ['16:9', '9:16'],
    tempo: 120,
    language: null,
    scenes,
    duration: start,
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
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
}

async function setup(script: Script) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-chat-'));
  const projectDir = path.join(root, 'projects', 'demo');
  await fs.mkdir(path.join(projectDir, 'scenes'), { recursive: true });
  const project = makeProject(projectDir, ['intro', 'outro']);
  const config = {
    root,
    projectsDir: path.join(root, 'projects'),
    brandsDir: path.join(root, 'brands'),
    templatesDir: path.join(root, 'templates'),
    stateDir: path.join(root, '.cadence'),
    mcpUrl: 'http://127.0.0.1:5299/mcp',
  } as CadenceConfig;

  const events: ServerEvent[] = [];
  const hub = { send: (e: ServerEvent) => events.push(JSON.parse(JSON.stringify(e))), handleSse: () => undefined };

  const snapshots: { label: string; source: VersionSource; chatKey?: ChatKey; costUsd?: number }[] = [];
  const entries: VersionEntry[] = [];
  const files = { dirty: false };
  const versions = {
    list: async () => entries,
    snapshot: async (_id: string, meta: (typeof snapshots)[number]) => {
      snapshots.push(meta);
      if (entries.length && !files.dirty) return null;
      files.dirty = false;
      const entry: VersionEntry = {
        id: `v${String(entries.length + 1).padStart(4, '0')}`,
        createdAt: new Date().toISOString(),
        label: meta.label,
        source: meta.source,
        scenes: [],
        files: [],
      };
      entries.push(entry);
      return entry;
    },
  } as unknown as VersionStore;

  // Tests change these between turns.
  const hooks = { artDirection: 'Fond clair, typographie serrée.', beforeFrames: async () => {} };
  let syncs = 0;
  const store = {
    root: config.projectsDir,
    events: new EventEmitter(),
    get: async (id: string) => {
      if (id !== 'demo') throw new HttpError(404, `Projet introuvable : ${id}`);
      return project;
    },
    exists: async (id: string) => id === 'demo',
    dir: (id: string) => path.join(config.projectsDir, id),
    readArtDirection: async () => hooks.artDirection,
    syncCode: async () => {
      syncs++;
      return true;
    },
  } as unknown as ProjectStore;

  const seamChecks: unknown[] = [];
  const seams = {
    cached: () => [{ from: 'intro', to: 'outro', format: '16:9', diffPercent: 0, checkedAt: '' }],
    check: async (_id: string, opts: unknown) => {
      seamChecks.push(opts);
      return [];
    },
  } as unknown as SeamService;
  const capture = {
    frames: async () => {
      await hooks.beforeFrames();
      return [{ t: 0, sceneId: 'intro', localTime: 0, image: Buffer.alloc(0), mime: 'image/jpeg', errors: [] }];
    },
  } as unknown as CaptureService;
  const brands = {
    get: async () => ({ language: 'fr' }),
    describe: async () => 'Marque neutre : encre #111, fond #fafafa.',
    dir: (id: string) => path.join(config.brandsDir, id),
  } as unknown as BrandStore;
  const assets = {
    list: async () => [{ path: 'refs/site-desktop.png', url: '', size: 1, kind: 'image', isReference: true }],
    resolve: (_id: string, rel: string) => path.join(projectDir, 'assets', rel),
  } as unknown as AssetStore;
  const music = { context: async () => 'No track: steady grid at 120 BPM.' } as unknown as MusicService;
  const settings = { get: async () => SETTINGS } as unknown as SettingsStore;
  const tokens = new McpTokens(config, path.join(root, 'mcp-token'));
  const usage = new FileUsageLog({ ...config, stateDir: path.join(root, '.cadence') });

  const turns: AgentTurn[] = [];
  const provider: AgentProvider = {
    id: 'fake',
    label: 'Fake',
    status: async () => ({ ok: true, label: 'Fake' }),
    run: (turn) => {
      turns.push(turn);
      return script(turn, turns.length - 1);
    },
  };

  const manager = new ChatManager({
    config,
    store,
    brands,
    templates: {} as TemplateStore,
    versions,
    capture,
    seams,
    music,
    assets,
    hub,
    provider,
    tokens,
    settings,
    usage,
  });
  const idle = (key: ChatKey) => waitFor(async () => !isBusy(await manager.get('demo', key)));
  return {
    root,
    projectDir,
    manager,
    turns,
    events,
    snapshots,
    files,
    tokens,
    usage,
    seamChecks,
    idle,
    hooks,
    syncs: () => syncs,
  };
}

const isBusy = (state: ChatState) => state.running || state.queued;

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tokenOf(turn: AgentTurn): string {
  return (turn.mcpServers.cadence as { headers: { Authorization: string } }).headers.Authorization.replace('Bearer ', '');
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

test('a scene turn: context, rules, streaming, activity, version, cost and session', async (t) => {
  let tokens!: McpTokens;
  let files!: { dirty: boolean };
  const env = await setup(async function* (turn) {
    yield { type: 'init', sessionId: turn.sessionId };
    yield { type: 'text-delta', text: 'Je regarde ' };
    yield { type: 'text-delta', text: 'la scène.' };
    yield { type: 'tool-start', id: 't1', name: 'Edit', input: { file_path: path.join(turn.cwd, 'scenes', 'intro.tsx') } };
    files.dirty = true;
    yield { type: 'tool-end', id: 't1', isError: false, output: 'ok' };
    yield { type: 'tool-start', id: 't2', name: 'mcp__cadence__render_frames', input: { times: [0, 1.5] } };
    tokens.reportActivity(tokenOf(turn), {
      type: 'frames',
      sceneId: 'intro',
      times: [0, 1.5],
      urls: ['/api/projects/demo/agent-frames/1-1.jpg', '/api/projects/demo/agent-frames/1-2.jpg'],
    });
    yield { type: 'tool-end', id: 't2', isError: false, output: 'Rendered 2 frames' };
    yield { type: 'text-delta', text: 'Titre agrandi à 140 px.' };
    yield {
      type: 'done',
      text: 'Titre agrandi à 140 px.',
      isError: false,
      durationMs: 1234,
      costUsd: 0.12,
      sessionId: turn.sessionId,
    };
  });
  ({ tokens, files } = env);
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  const sent = await env.manager.send('demo', 'scene:intro', {
    text: '  Agrandis le titre  ',
    playhead: { sceneId: 'intro', t: 1.25, format: '16:9' },
  });
  assert.equal(sent.running, true);
  assert.equal(sent.queued, false);
  assert.deepEqual(
    sent.messages.map((m) => [m.role, m.text, m.status]),
    [
      ['user', 'Agrandis le titre', undefined],
      ['assistant', '', 'streaming'],
    ],
  );
  await env.idle('scene:intro');

  const state = await env.manager.get('demo', 'scene:intro');
  const reply = state.messages[1];
  assert.equal(reply.status, 'done');
  assert.equal(reply.text, 'Titre agrandi à 140 px.');
  assert.deepEqual(reply.notes, ['Je regarde la scène.']);
  assert.deepEqual(
    reply.activity?.map((a) => [a.label, a.status]),
    [
      ['Modification de scenes/intro.tsx', 'ok'],
      ['Rendu de 2 images', 'ok'],
    ],
  );
  assert.deepEqual(reply.activity?.[1].images, [
    '/api/projects/demo/agent-frames/1-1.jpg',
    '/api/projects/demo/agent-frames/1-2.jpg',
  ]);
  assert.equal(reply.model, 'claude-opus-5-5');
  assert.equal(reply.effort, 'high');
  assert.equal(reply.costUsd, 0.12);
  assert.equal(reply.durationMs, 1234);
  assert.equal(reply.versionId, 'v0002');
  assert.equal(state.totalCostUsd, 0.12);
  assert.equal(await env.manager.totalCost('demo'), 0.12);

  // The turn handed to Claude Code.
  const [turn] = env.turns;
  assert.equal(turn.resume, false);
  assert.match(turn.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(turn.cwd, env.projectDir);
  assert.equal(turn.model, 'claude-opus-5-5');
  assert.equal(turn.effort, 'high');
  assert.deepEqual(turn.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
  assert.deepEqual(turn.addDirs, [
    path.join(env.root, 'brands', 'cadence'),
    path.join(env.root, 'templates'),
    path.join(env.root, 'src', 'runtime'),
  ]);
  const scene = `//${path.join(env.projectDir, 'scenes', 'intro.tsx').slice(1)}`;
  assert.ok(turn.allow.includes(`Edit(${scene})`) && turn.allow.includes(`Write(${scene})`));
  assert.ok(turn.allow.includes(`Read(//${env.projectDir.slice(1)}/**)`));
  assert.ok(turn.allow.includes('mcp__cadence__render_frames'));
  assert.ok(!turn.allow.some((rule) => rule.includes('components') || rule === 'mcp__cadence__create_scene'));
  const keys = path.join(env.root, '.cadence').slice(1);
  assert.deepEqual(turn.deny, [`Read(//${keys}/accounts.json)`, `Read(//${keys}/elevenlabs.json)`]);
  assert.match(turn.systemPrompt, /## Scope: scene chat/);
  assert.doesNotMatch(turn.systemPrompt, /## Scope: project chat/);
  assert.match(turn.prompt, /^<cadence_context>/);
  assert.match(turn.prompt, /This chat edits scene 1 "INTRO" \(intro\): .*scenes\/intro\.tsx/);
  assert.match(turn.prompt, /Playhead: the user is looking at t = 1\.250 s of this scene, format 16:9\./);
  assert.match(turn.prompt, /Render errors at t = 0: none\./);
  assert.match(turn.prompt, /intro → outro \(16:9\) 0\.00 %/);
  assert.match(turn.prompt, /assets\/refs\/site-desktop\.png/);
  assert.match(turn.prompt, /<brand>\nMarque neutre/);
  assert.match(turn.prompt, /<art_direction>\nFond clair/);
  assert.match(turn.prompt, /No track: steady grid/);
  assert.match(turn.prompt, /On-screen language: French \(brand default\)\./);
  assert.ok(turn.prompt.endsWith('\n\nAgrandis le titre'));

  // Per-turn token: scene scope during the turn, revoked after.
  assert.equal(env.tokens.resolve(tokenOf(turn)), null);

  // Versions: baseline before the first turn, then this turn's changes.
  assert.deepEqual(
    env.snapshots.map((s) => [s.source, s.label]),
    [
      ['baseline', 'État initial'],
      ['agent', 'Agrandis le titre'],
    ],
  );
  assert.equal(env.snapshots[1].chatKey, 'scene:intro');
  assert.equal(env.snapshots[1].costUsd, 0.12);
  assert.equal(env.syncs(), 1);
  assert.deepEqual(env.seamChecks, [{ sceneId: 'intro' }]);

  // Streaming over SSE.
  const deltas = env.events.filter((e) => e.type === 'chat-delta');
  assert.deepEqual(
    deltas.map((e) => e.type === 'chat-delta' && [e.key, e.messageId, e.text]),
    ['Je regarde ', 'la scène.', 'Titre agrandi à 140 px.'].map((text) => ['scene:intro', reply.id, text]),
  );
  // Inside the turn only the reply travels; the whole chat goes out when the turn starts and when it ends.
  const replies = env.events.filter((e) => e.type === 'chat-message');
  assert.ok(replies.length > 0 && replies.every((e) => e.type === 'chat-message' && e.message.id === reply.id));
  const chats = env.events.filter((e) => e.type === 'chat');
  assert.equal(chats.length, 2);
  const last = chats.at(-1);
  assert.ok(last?.type === 'chat' && !last.state.running && last.state.messages[1].versionId === 'v0002');

  // Persisted with the Claude session id.
  const file = JSON.parse(await fs.readFile(path.join(env.projectDir, '.cadence', 'chats', 'scene-intro.json'), 'utf8'));
  assert.equal(file.sessionId, turn.sessionId);
  assert.equal(file.messages.length, 2);

  // The next turn resumes the session; brand notes and art direction are not resent while unchanged.
  await env.manager.send('demo', 'scene:intro', { text: 'Plus lent' });
  await env.idle('scene:intro');
  const second = env.turns[1];
  assert.equal(second.resume, true);
  assert.equal(second.sessionId, turn.sessionId);
  assert.doesNotMatch(second.prompt, /<brand>/);
  assert.match(second.prompt, /unchanged since earlier in this conversation/);
  assert.equal(env.snapshots.at(-2)?.source, 'external');
});

test('a turn stopped before reaching Claude leaves the new art direction to be sent', async (t) => {
  const env = await setup(async function* (turn) {
    yield { type: 'init', sessionId: turn.sessionId };
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1, sessionId: turn.sessionId };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await env.manager.send('demo', 'scene:intro', { text: 'Un' });
  await env.idle('scene:intro');

  // Stopped while its context is gathered (the pre-turn capture): Claude never sees that prompt.
  env.hooks.artDirection = 'NOUVELLE DIRECTION';
  const capturing = gate();
  const release = gate();
  env.hooks.beforeFrames = async () => {
    capturing.open();
    await release.opened;
  };
  await env.manager.send('demo', 'scene:intro', { text: 'Deux' });
  await capturing.opened;
  env.manager.stop('demo', 'scene:intro');
  release.open();
  await env.idle('scene:intro');
  assert.equal(env.turns.length, 1);

  env.hooks.beforeFrames = async () => {};
  await env.manager.send('demo', 'scene:intro', { text: 'Trois' });
  await env.idle('scene:intro');
  assert.equal(env.turns[1].resume, true);
  assert.match(env.turns[1].prompt, /<art_direction>\nNOUVELLE DIRECTION/);
});

test('one turn per project: the others queue; a busy chat refuses a second message', async (t) => {
  const release = gate();
  const env = await setup(async function* (turn, index) {
    if (index === 0) await release.opened;
    yield { type: 'done', text: `Fini ${index}`, isError: false, durationMs: 1, costUsd: 0.01, sessionId: turn.sessionId };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  const first = await env.manager.send('demo', 'scene:intro', { text: 'Un' });
  const second = await env.manager.send('demo', 'project', { text: 'Deux' });
  assert.equal(first.running, true);
  assert.deepEqual([second.running, second.queued], [false, true]);
  await assert.rejects(env.manager.send('demo', 'scene:intro', { text: 'Encore' }), (e: HttpError) => e.status === 409);
  await assert.rejects(env.manager.clear('demo', 'project'), { status: 409, message: 'Arrêtez d’abord la réponse en cours.' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.turns.length, 1);
  assert.deepEqual([env.manager.busy('demo'), env.manager.busy('autre')], [true, false]);

  release.open();
  await env.idle('project');
  await env.idle('scene:intro');
  assert.equal(env.turns.length, 2);
  assert.equal(env.manager.busy('demo'), false);
  const project = env.turns[1];
  assert.equal(project.model, 'claude-sonnet-5-5');
  assert.equal(project.effort, 'medium');
  assert.ok(project.allow.includes(`Edit(//${path.join(env.projectDir, 'components', '**').slice(1)})`));
  assert.ok(project.allow.includes('mcp__cadence__create_scene'));
  assert.match(project.systemPrompt, /## Scope: project chat/);
  assert.match(project.prompt, /This is the project chat/);
  assert.doesNotMatch(project.prompt, /Render errors/);
  assert.equal((await env.manager.get('demo', 'project')).messages[1].text, 'Fini 1');
  assert.equal(await env.manager.totalCost('demo'), 0.02);
});

test('Claude Code reports session totals: a resumed turn records only what it added', async (t) => {
  const totals = [
    { costUsd: 0.12, tokens: { input: 10, output: 100, cacheRead: 1000, cacheWrite: 200 } },
    { costUsd: 0.3, tokens: { input: 25, output: 260, cacheRead: 3000, cacheWrite: 260 } },
    { costUsd: 0.05, tokens: { input: 5, output: 40, cacheRead: 0, cacheWrite: 900 } },
  ];
  const env = await setup(async function* (turn, index) {
    yield { type: 'done', text: `Fini ${index}`, isError: false, durationMs: 1, sessionId: turn.sessionId, ...totals[index] };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  for (const text of ['Un', 'Deux']) {
    await env.manager.send('demo', 'project', { text });
    await env.idle('project');
  }
  assert.equal(env.turns[1].resume, true);
  const replies = (await env.manager.get('demo', 'project')).messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(
    replies.map((m) => m.costUsd),
    [0.12, 0.18],
  );
  assert.equal(await env.manager.totalCost('demo'), 0.3);

  // A new conversation is a new session: its totals start from zero.
  await env.manager.clear('demo', 'project');
  await env.manager.send('demo', 'project', { text: 'Trois' });
  await env.idle('project');
  assert.equal(env.turns[2].resume, false);
  assert.equal(await env.manager.totalCost('demo'), 0.35);

  const usage = await env.usage.summary();
  assert.deepEqual(usage.chats, {
    runs: 3,
    costUsd: 0.35,
    tokens: { input: 30, output: 300, cacheRead: 3000, cacheWrite: 1160 },
  });
  assert.equal(usage.brands.runs, 0);
});

test('stop: a running turn is aborted, a queued one never runs', async (t) => {
  const env = await setup(async function* (turn) {
    yield { type: 'text-delta', text: 'Je commence' };
    await new Promise((resolve) => turn.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'done', text: 'Arrêté.', isError: false, durationMs: 5, subtype: 'aborted' };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  await env.manager.send('demo', 'scene:intro', { text: 'Long travail' });
  await env.manager.send('demo', 'project', { text: 'En attente' });
  env.manager.stop('demo', 'project');
  const dropped = await env.manager.get('demo', 'project');
  assert.deepEqual([dropped.running, dropped.queued, dropped.messages[1].status], [false, false, 'stopped']);

  await waitFor(() => env.turns.length === 1);
  env.manager.stop('demo', 'scene:intro');
  await env.idle('scene:intro');
  const stopped = (await env.manager.get('demo', 'scene:intro')).messages[1];
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.text, 'Je commence');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.turns.length, 1, 'the dropped project turn never reached Claude');
  // Nothing changed, but the turn still ends with a version check.
  assert.equal(env.snapshots.at(-1)?.source, 'agent');
});

test('stopAll aborts running turns, drops queued ones and refuses new messages', async (t) => {
  const env = await setup(async function* (turn) {
    yield { type: 'text-delta', text: 'Je commence' };
    await new Promise((resolve) => turn.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'done', text: 'Arrêté.', isError: false, durationMs: 5, subtype: 'aborted' };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  await env.manager.send('demo', 'scene:intro', { text: 'Long travail' });
  await env.manager.send('demo', 'project', { text: 'En attente' });
  await waitFor(() => env.turns.length === 1);
  await env.manager.stopAll();

  assert.equal(env.turns[0].signal.aborted, true);
  const [running, queued] = await Promise.all([env.manager.get('demo', 'scene:intro'), env.manager.get('demo', 'project')]);
  assert.deepEqual([running.running, running.messages[1].status], [false, 'stopped']);
  assert.deepEqual([queued.queued, queued.messages[1].status], [false, 'stopped']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.turns.length, 1, 'the queued turn never reached Claude');
  await assert.rejects(env.manager.send('demo', 'scene:outro', { text: 'Encore' }), { status: 503 });
});

test('errors become assistant messages in French', async (t) => {
  const env = await setup(async function* (_turn, index) {
    if (index === 1) throw new Error('le fournisseur a planté');
    yield { type: 'text-delta', text: 'API Error: 529 Overloaded' };
    yield {
      type: 'done',
      text: 'Claude Code a renvoyé une erreur : API Error: 529 Overloaded',
      isError: true,
      durationMs: 9,
    };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  await env.manager.send('demo', 'project', { text: 'Salut' });
  await env.idle('project');
  let reply = (await env.manager.get('demo', 'project')).messages[1];
  assert.equal(reply.status, 'error');
  assert.equal(reply.error, 'Claude Code a renvoyé une erreur : API Error: 529 Overloaded');
  assert.equal(reply.text, '', 'the error is shown once');

  await env.manager.send('demo', 'project', { text: 'Encore' });
  await env.idle('project');
  reply = (await env.manager.get('demo', 'project')).messages[3];
  assert.equal(reply.status, 'error');
  assert.equal(reply.error, 'Erreur interne : le fournisseur a planté');
});

test('a lost session is restarted once, with the full context', async (t) => {
  const env = await setup(async function* (turn) {
    if (turn.resume) {
      yield { type: 'done', text: 'No conversation found with session ID: old-session', isError: true, durationMs: 1 };
      return;
    }
    yield { type: 'init', sessionId: turn.sessionId };
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1, sessionId: turn.sessionId };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const file = path.join(env.projectDir, '.cadence', 'chats', 'project.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ key: 'project', sessionId: 'old-session', briefHash: 'x', messages: [] }));

  await env.manager.send('demo', 'project', { text: 'Bonjour' });
  await env.idle('project');
  assert.deepEqual(
    env.turns.map((turn) => [turn.resume, turn.sessionId === 'old-session']),
    [
      [true, true],
      [false, false],
    ],
  );
  assert.match(env.turns[1].prompt, /<brand>/);
  const state = await env.manager.get('demo', 'project');
  assert.equal(state.messages[1].status, 'done');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).sessionId, env.turns[1].sessionId);
});

test('clear archives the conversation and starts a new session', async (t) => {
  const env = await setup(async function* (turn) {
    yield { type: 'init', sessionId: turn.sessionId };
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1, costUsd: 0.5, sessionId: turn.sessionId };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  await env.manager.send('demo', 'scene:outro', { text: 'Un' });
  await env.idle('scene:outro');
  const cleared = await env.manager.clear('demo', 'scene:outro');
  assert.deepEqual(cleared, { key: 'scene:outro', messages: [], running: false, queued: false, totalCostUsd: 0 });
  const archive = path.join(env.projectDir, '.cadence', 'chats', 'archive');
  const [archived] = await fs.readdir(archive);
  assert.match(archived, /^scene-outro-.*\.json$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(archive, archived), 'utf8')).messages.length, 2);
  assert.equal(await env.manager.totalCost('demo'), 0.5, 'archived conversations still count');

  await env.manager.send('demo', 'scene:outro', { text: 'Deux' });
  await env.idle('scene:outro');
  assert.equal(env.turns[1].resume, false);
  assert.notEqual(env.turns[1].sessionId, env.turns[0].sessionId);
});

test('models without effort support get none; unknown models keep it', async (t) => {
  const env = await setup(async function* () {
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1 };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await env.manager.send('demo', 'project', { text: 'a', model: 'claude-haiku-4-5-20251001', effort: 'high' });
  await env.idle('project');
  await env.manager.send('demo', 'project', { text: 'b', model: 'claude-future-9', effort: 'low' });
  await env.idle('project');
  assert.deepEqual(
    env.turns.map((turn) => [turn.model, turn.effort]),
    [
      ['claude-haiku-4-5-20251001', null],
      ['claude-future-9', 'low'],
    ],
  );
  assert.equal((await env.manager.get('demo', 'project')).messages[1].effort, undefined);
});

test('invalid requests are refused with French errors', async (t) => {
  const env = await setup(async function* () {
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1 };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const status = (code: number) => (e: HttpError) => e instanceof HttpError && e.status === code && /[a-zé]/.test(e.message);
  await assert.rejects(env.manager.send('demo', 'project', { text: '   ' }), status(400));
  await assert.rejects(env.manager.send('demo', 'project', { text: 'a', model: '--dangerously-skip-permissions' }), status(400));
  await assert.rejects(env.manager.send('demo', 'project', { text: 'a', effort: 'turbo' as never }), status(400));
  await assert.rejects(env.manager.send('demo', 'scene:../x' as ChatKey, { text: 'a' }), status(400));
  await assert.rejects(env.manager.send('demo', 'scene:nope', { text: 'a' }), status(404));
  await assert.rejects(env.manager.get('ghost', 'project'), status(404));
  assert.equal(env.turns.length, 0);
});

test('a reply left streaming by a crash is shown as interrupted', async (t) => {
  const env = await setup(async function* () {
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1 };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const file = path.join(env.projectDir, '.cadence', 'chats', 'project.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const reply = { id: 'r', role: 'assistant', text: 'à moitié', createdAt: '', status: 'streaming' };
  await fs.writeFile(file, JSON.stringify({ key: 'project', sessionId: null, briefHash: null, messages: [reply] }));
  const [message] = (await env.manager.get('demo', 'project')).messages;
  assert.equal(message.status, 'error');
  assert.match(message.error ?? '', /interrompue/);
});

test('a damaged chat file is reported, never replaced by the next message', async (t) => {
  const env = await setup(async function* () {
    yield { type: 'done', text: 'OK', isError: false, durationMs: 1 };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const file = path.join(env.projectDir, '.cadence', 'chats', 'project.json');
  const damaged = '{"key": "project", "messages": [{"id": "u", "role": "user", "text": "à garder"},';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, damaged);
  const unreadable = { status: 500, message: /chats\/project\.json illisible/ };
  await assert.rejects(env.manager.get('demo', 'project'), unreadable);
  await assert.rejects(env.manager.send('demo', 'project', { text: 'a' }), unreadable);
  assert.equal(await fs.readFile(file, 'utf8'), damaged);
  assert.equal(env.turns.length, 0);
});

test('rules and labels', () => {
  const dirs = { brand: '/r/brands/orbit', templates: '/r/templates', runtime: '/r/src/runtime' };
  assert.deepEqual(allowRules('/r/projects/demo', 'intro', dirs), [
    'Read(//r/projects/demo/**)',
    'Read(//r/brands/orbit/**)',
    'Read(//r/templates/**)',
    'Read(//r/src/runtime/**)',
    'Glob',
    'Grep',
    'Edit(//r/projects/demo/scenes/intro.tsx)',
    'Write(//r/projects/demo/scenes/intro.tsx)',
    'mcp__cadence__get_project',
    'mcp__cadence__get_brand',
    'mcp__cadence__get_music_context',
    'mcp__cadence__list_templates',
    'mcp__cadence__render_frames',
    'mcp__cadence__check_seams',
    'mcp__cadence__check_motion',
    'mcp__cadence__set_scene_duration',
    'mcp__cadence__set_voice_over',
    'mcp__cadence__save_version',
  ]);
  const project = allowRules('/r/projects/demo', null, dirs);
  for (const rule of [
    'Edit(//r/projects/demo/scenes/**)',
    'Write(//r/projects/demo/components/**)',
    'Edit(//r/projects/demo/art-direction.md)',
    'mcp__cadence__capture_reference',
    'mcp__cadence__snap_cuts_to_music',
  ]) {
    assert.ok(project.includes(rule), rule);
  }
  const label = (name: string, input: Record<string, unknown>) => activityLabel(name, input, '/r/projects/demo', '/r');
  assert.equal(label('Read', { file_path: '/r/brands/orbit/KIT.md' }), 'Lecture de brands/orbit/KIT.md');
  assert.equal(label('Write', { file_path: '/r/projects/demo/components/layout.ts' }), 'Modification de components/layout.ts');
  assert.equal(label('mcp__cadence__render_frames', { times: [1] }), 'Rendu d’une image');
  assert.equal(
    label('mcp__cadence__render_frames', { times: [0, 1, 2], wholeVideo: true, format: '9:16' }),
    'Rendu de 3 images de la vidéo (9:16)',
  );
  assert.equal(label('mcp__cadence__render_frames', { strip: { at: 1 } }), 'Rendu de 12 images');
  assert.equal(label('mcp__cadence__check_motion', { sceneId: 'intro' }), 'Vérification du mouvement');
  assert.equal(
    label('mcp__cadence__render_frames', { strip: { at: 1, frames: 6 }, sceneId: 'intro' }),
    'Rendu de 6 images de intro',
  );
  assert.equal(label('mcp__cadence__set_scene_duration', { seconds: 3.32 }), 'Durée réglée à 3,32 s');
  assert.equal(label('mcp__cadence__snap_cuts_to_music', { grid: 'phrase' }), 'Coupes calées sur les phrases');
  assert.equal(label('mcp__cadence__set_voice_over', { text: 'Bonjour.' }), 'Voix off écrite et générée');
  assert.equal(label('mcp__cadence__set_voice_over', { text: '' }), 'Voix off retirée');
});
