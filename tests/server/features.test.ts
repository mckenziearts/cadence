// StartOptions.features: the flags a host app passes to hide editor sections, served to the editor in /api/state.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startServer, type StartOptions } from '../../server/index';
import { pathExists } from '../../server/util';
import type { AppState, ChatState, VoicesState } from '../../src/shared/types';
import { makeRoot, type TestRoot } from './helpers';

let t: TestRoot;
let options: StartOptions;

before(async () => {
  process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/features');
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
});

after(async () => {
  await t?.cleanup();
});

async function features(extra: Pick<StartOptions, 'features'>): Promise<AppState['features']> {
  const server = await startServer({ ...options, ...extra });
  try {
    const res = await fetch(`${server.config.editorOrigin}/api/state`);
    return ((await res.json()) as AppState).features;
  } finally {
    await server.close();
  }
}

test('every feature is on when the host passes none', async () => {
  assert.deepEqual(await features({}), {
    agentPicker: true,
    gitSources: true,
    networkApps: true,
    modelPicker: true,
    costs: true,
  });
});

test('a feature the host turns off is off, the others stay on', async () => {
  assert.deepEqual(await features({ features: { gitSources: false } }), {
    agentPicker: true,
    gitSources: false,
    networkApps: true,
    modelPicker: true,
    costs: true,
  });
});

test('a host can hide the model choice and the costs', async () => {
  assert.deepEqual(await features({ features: { modelPicker: false, costs: false } }), {
    agentPicker: true,
    gitSources: true,
    networkApps: true,
    modelPicker: false,
    costs: false,
  });
});

test('an undefined flag stays on and an unknown key is not served', async () => {
  const flags = { agentPicker: undefined, gitSources: false, legacy: false } as Partial<AppState['features']>;
  assert.deepEqual(await features({ features: flags }), {
    agentPicker: true,
    gitSources: false,
    networkApps: true,
    modelPicker: true,
    costs: true,
  });
});

test('the server hands agentPicker to the chat and the API: its 409s say "Notre IA"', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const provider = {
    id: 'fake',
    label: 'Agent de test',
    status: async () => ({ ok: true, label: 'Agent de test' }),
    async *run() {
      await gate;
      yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
    },
  };
  const server = await startServer({ ...options, provider, features: { agentPicker: false } });
  const call = async (method: string, route: string, body?: object) => {
    const res = await fetch(`${server.config.editorOrigin}/api${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-cadence-token': server.editorToken },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const project = await call('POST', '/projects', { name: 'Occupé', brand: null, formats: ['16:9'], fps: 30 });
    assert.equal(project.status, 200);
    const id = project.body.id as string;
    assert.equal((await call('POST', `/projects/${id}/chats/project/messages`, { text: 'Bonjour' })).status, 200);
    assert.deepEqual(await call('POST', `/projects/${id}/chats/project/messages`, { text: 'Encore' }), {
      status: 409,
      body: { error: 'Notre IA travaille encore sur le message précédent de ce chat.' },
    });
    assert.deepEqual(await call('DELETE', `/projects/${id}`), {
      status: 409,
      body: { error: "Notre IA travaille sur ce projet : arrêtez d'abord la réponse en cours." },
    });
  } finally {
    release();
    await server.close();
  }
});

// A host that hides the agent choice and runs the built-in providers: their turn errors name no agent either.
test('without agentPicker, the built-in agents refused by their CLI say "Notre IA"', async () => {
  const { provider: _, ...builtIn } = options;
  const bin = await mkdtemp(path.join(os.tmpdir(), 'cadence-cli-'));
  const stub = async (name: string, stderr: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`, { mode: 0o755 });
    return file;
  };
  const server = await startServer({
    ...builtIn,
    features: { agentPicker: false },
    claudePath: await stub('claude', 'Not logged in'),
    codexPath: await stub('codex', '401 Unauthorized'),
  });
  const call = async (method: string, route: string, body?: object) => {
    const res = await fetch(`${server.config.editorOrigin}/api${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-cadence-token': server.editorToken },
      body: body && JSON.stringify(body),
    });
    assert.ok(res.ok, `${method} ${route}: ${res.status}`);
    return res.json();
  };
  try {
    const { id } = (await call('POST', '/projects', { name: 'Refus', brand: null, formats: ['16:9'], fps: 30 })) as {
      id: string;
    };
    for (const agent of ['claude-code', 'codex']) {
      await call('PUT', '/settings', { agent });
      await call('POST', `/projects/${id}/chats/project/messages`, { text: 'Bonjour' });
      let chat: ChatState;
      for (let i = 0; ; i++) {
        chat = (await call('GET', `/projects/${id}/chats/project`)) as ChatState;
        if ((!chat.running && !chat.queued) || i === 300) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const error = chat.messages.at(-1)?.error ?? '';
      assert.ok(error.startsWith('Notre IA a refusé la connexion'), `${agent}: ${error}`);
      assert.ok(!/Claude Code|Codex/.test(error), `${agent}: ${error}`);
    }
  } finally {
    await server.close();
    await rm(bin, { recursive: true, force: true });
  }
});

test("a host app's secret store passed to startServer is where the ElevenLabs key is read", async () => {
  const asked: string[] = [];
  const server = await startServer({
    ...options,
    speech: { check: async () => ({ ok: true }), speak: async () => undefined },
    elevenLabs: { voices: async () => [], models: async () => [], speak: async () => undefined },
    secrets: { get: async (name) => (asked.push(name), 'sk_from_store'), set: async () => undefined },
  });
  try {
    const res = await fetch(`${server.config.editorOrigin}/api/voices`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as VoicesState).elevenLabs, { configured: true });
    assert.deepEqual(asked, ['elevenlabs']);
    assert.equal(await pathExists(path.join(server.config.stateDir, 'elevenlabs.json')), false);
  } finally {
    await server.close();
  }
});
