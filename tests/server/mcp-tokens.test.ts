import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CadenceConfig, McpActivity } from '../../server/contracts';
import { McpTokens } from '../../server/mcp/tokens';

const config = {} as CadenceConfig;

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-tokens-'));
  return path.join(dir, 'config', 'cadence', 'mcp-token');
}

test('issued tokens resolve to their scope until revoked', async () => {
  const tokens = new McpTokens(config, await tempFile());
  const scene = tokens.issue({ kind: 'scene', projectId: 'demo', sceneId: 'intro' });
  const project = tokens.issue({ kind: 'project', projectId: 'demo' });
  assert.notEqual(scene, project);
  assert.ok(scene.length >= 32);
  assert.deepEqual(tokens.resolve(scene), { kind: 'scene', projectId: 'demo', sceneId: 'intro' });
  assert.deepEqual(tokens.resolve(project), { kind: 'project', projectId: 'demo' });
  tokens.revoke(scene);
  assert.equal(tokens.resolve(scene), null);
  assert.deepEqual(tokens.resolve(project), { kind: 'project', projectId: 'demo' });
  for (const bad of [undefined, null, '', 'nope']) assert.equal(tokens.resolve(bad), null);
});

test('tokens expire', async () => {
  const tokens = new McpTokens(config, await tempFile());
  const token = tokens.issue({ kind: 'project', projectId: 'demo' }, { ttlMs: 20 });
  assert.ok(tokens.resolve(token));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(tokens.resolve(token), null);
});

test('the terminal token is persisted with mode 0600 and opens every project', async () => {
  const file = await tempFile();
  const tokens = new McpTokens(config, file);
  const token = await tokens.terminalToken();
  assert.equal(await tokens.terminalToken(), token, 'stable');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(file, 'utf8')).trim(), token);
  assert.deepEqual(tokens.resolve(token), { kind: 'open' });
  // Another process (the `cadence mcp` CLI) sees the same token, and a running server accepts a token created later.
  const other = new McpTokens(config, file);
  assert.equal(await other.terminalToken(), token);
  const file2 = await tempFile();
  const server = new McpTokens(config, file2);
  const cli = new McpTokens(config, file2);
  const created = await cli.terminalToken();
  assert.deepEqual(server.resolve(created), { kind: 'open' });
});

test('an unusable token file is replaced', async () => {
  const file = await tempFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'short\n', { mode: 0o644 });
  const tokens = new McpTokens(config, file);
  assert.equal(tokens.resolve('short'), null);
  const token = await tokens.terminalToken();
  assert.ok(token.length >= 32);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('activity reaches the listeners of that token only', async () => {
  const tokens = new McpTokens(config, await tempFile());
  const a = tokens.issue({ kind: 'project', projectId: 'demo' });
  const b = tokens.issue({ kind: 'project', projectId: 'demo' });
  const seen: McpActivity[] = [];
  const unsubscribe = tokens.onActivity(a, (activity) => seen.push(activity));
  const broken = tokens.onActivity(a, () => {
    throw new Error('a broken listener does not break the tool');
  });
  const frames: McpActivity = { type: 'frames', sceneId: 'intro', times: [0], urls: ['/api/projects/demo/agent-frames/1-1.jpg'] };
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    tokens.reportActivity(a, frames);
    tokens.reportActivity(b, { type: 'seams', results: [] });
  } finally {
    console.error = originalError;
    broken();
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(seen, [frames]);
  unsubscribe();
  tokens.reportActivity(a, frames);
  assert.equal(seen.length, 1);
  tokens.revoke(a);
  tokens.reportActivity(a, frames);
  assert.equal(seen.length, 1);
});
