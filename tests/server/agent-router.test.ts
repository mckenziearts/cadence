import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentId, Settings } from '../../src/shared/types';
import type { AgentEvent, AgentProvider, AgentTurn } from '../../server/agent/types';
import { RoutingProvider } from '../../server/agent/router';
import type { SettingsStore } from '../../server/contracts';

function fakeProvider(id: string): AgentProvider {
  return {
    id,
    label: id,
    status: async () => ({ ok: true, label: id, version: id }),
    async *run(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', text: id, isError: false, durationMs: 0 };
    },
  };
}

const settingsWith = (agent: AgentId): SettingsStore => ({
  get: async () => ({ agent }) as Settings,
  update: async () => ({ agent }) as Settings,
});

async function ran(router: RoutingProvider): Promise<string> {
  for await (const event of router.run({} as AgentTurn)) if (event.type === 'done') return event.text;
  return '';
}

test('routes the turn and status to the agent chosen in settings', async () => {
  const router = new RoutingProvider(
    { 'claude-code': fakeProvider('claude-code'), codex: fakeProvider('codex') },
    settingsWith('codex'),
    'claude-code',
  );
  assert.equal((await router.status()).version, 'codex');
  assert.equal(await ran(router), 'codex');
});

test('falls back to the default when the selected agent has no running provider', async () => {
  const router = new RoutingProvider({ 'claude-code': fakeProvider('claude-code') }, settingsWith('grok'), 'claude-code');
  assert.equal((await router.status()).version, 'claude-code');
  assert.equal(await ran(router), 'claude-code');
});
