import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CadenceConfig } from '../../server/contracts';
import { FileUsageLog, NO_TOKENS, addedSince } from '../../server/usage';

const FIRST = { costUsd: 0.12, tokens: { input: 10, output: 100, cacheRead: 1000, cacheWrite: 200 } };
const SECOND = { costUsd: 0.3, tokens: { input: 25, output: 260, cacheRead: 3000, cacheWrite: 260 } };

test('addedSince: a resumed run counts what it added to the totals of its session', () => {
  assert.deepEqual(addedSince(FIRST, undefined), FIRST);
  assert.deepEqual(addedSince(SECOND, FIRST), {
    costUsd: 0.18,
    tokens: { input: 15, output: 160, cacheRead: 2000, cacheWrite: 60 },
  });
  // Totals that went down (a session Claude Code could not restore) never make a negative run.
  assert.deepEqual(addedSince(FIRST, SECOND), { costUsd: 0, tokens: NO_TOKENS });
});

test('FileUsageLog sums each kind from its first line and skips the lines it cannot read', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, '.cadence');
  const log = new FileUsageLog({ stateDir } as CadenceConfig);

  await log.record({ at: '2026-10-01T09:00:00.000Z', agent: 'claude-code', kind: 'brand', brandId: 'acme', ...FIRST });
  await fs.appendFile(path.join(stateDir, 'usage.jsonl'), 'pas du json\n{"kind":"chat","costUsd":1}\n{"at":"2026-10');
  await fs.appendFile(path.join(stateDir, 'usage.jsonl'), '\n');
  await log.record({
    at: '2026-10-01T10:00:00.000Z',
    agent: 'codex',
    kind: 'chat',
    projectId: 'demo',
    chat: 'project',
    ...SECOND,
  });

  // No agent filter: every agent, each kind summed from its first line.
  assert.deepEqual(await log.summary(), {
    since: '2026-10-01T09:00:00.000Z',
    chats: { runs: 1, ...SECOND },
    brands: { runs: 1, ...FIRST },
  });
});

test('FileUsageLog.summary(agent) keeps that agent only; lines written before per-agent tracking are Claude Code', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, '.cadence');
  const file = path.join(stateDir, 'usage.jsonl');
  const log = new FileUsageLog({ stateDir } as CadenceConfig);
  const empty = { runs: 0, costUsd: 0, tokens: NO_TOKENS };

  await fs.mkdir(stateDir, { recursive: true });
  // A legacy line with no `agent`: it counts as Claude Code.
  const legacy = { at: '2026-10-01T08:00:00.000Z', kind: 'chat', projectId: 'demo', chat: 'project', ...FIRST };
  await fs.appendFile(file, `${JSON.stringify(legacy)}\n`);
  await log.record({
    at: '2026-10-01T10:00:00.000Z',
    agent: 'codex',
    kind: 'chat',
    projectId: 'demo',
    chat: 'project',
    ...SECOND,
  });

  assert.deepEqual(await log.summary('claude-code'), { since: legacy.at, chats: { runs: 1, ...FIRST }, brands: empty });
  assert.deepEqual(await log.summary('codex'), {
    since: '2026-10-01T10:00:00.000Z',
    chats: { runs: 1, ...SECOND },
    brands: empty,
  });
});
