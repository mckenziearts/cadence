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

test('the done event names the provider picked for the turn, the fallback included', async () => {
  const providers = { 'claude-code': fakeProvider('claude-code'), codex: fakeProvider('codex') };
  const provider = async (router: RoutingProvider) => {
    for await (const event of router.run({} as AgentTurn)) if (event.type === 'done') return event.provider;
  };
  assert.equal(await provider(new RoutingProvider(providers, settingsWith('codex'), 'claude-code')), 'codex');
  assert.equal(await provider(new RoutingProvider(providers, settingsWith('grok'), 'claude-code')), 'claude-code');
});

test('forwards every event of the picked provider in order, only done gains the provider', async () => {
  const stream: AgentEvent[] = [
    { type: 'init', sessionId: 's1' },
    { type: 'text-delta', text: 'Je regarde' },
    { type: 'tool-start', id: '1', name: 'Read', input: { file_path: 'a.tsx' } },
    { type: 'tool-end', id: '1', output: 'ok', isError: false },
    { type: 'done', text: 'Fini', isError: false, durationMs: 1 },
  ];
  const codex: AgentProvider = {
    ...fakeProvider('codex'),
    async *run() {
      yield* stream;
    },
  };
  const router = new RoutingProvider({ codex }, settingsWith('codex'), 'codex');
  const forwarded: AgentEvent[] = [];
  for await (const event of router.run({} as AgentTurn)) forwarded.push(event);
  assert.deepEqual(forwarded, [...stream.slice(0, -1), { ...stream[4], provider: 'codex' }]);
});
