// StartOptions.features: the flags a host app passes to hide editor sections, served to the editor in /api/state.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startServer, type StartOptions } from '../../server/index';
import type { AppState } from '../../src/shared/types';
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
  assert.deepEqual(await features({}), { agentPicker: true, gitSources: true, networkApps: true });
});

test('a feature the host turns off is off, the others stay on', async () => {
  assert.deepEqual(await features({ features: { gitSources: false } }), {
    agentPicker: true,
    gitSources: false,
    networkApps: true,
  });
});

test('an undefined flag stays on and an unknown key is not served', async () => {
  const flags = { agentPicker: undefined, gitSources: false, legacy: false } as Partial<AppState['features']>;
  assert.deepEqual(await features({ features: flags }), { agentPicker: true, gitSources: false, networkApps: true });
});
