// grokStatus/geminiStatus against fake binaries: installed-vs-not detection, with no login-status command to rely on.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { geminiStatus, grokStatus } from '../../server/agent/cliAgents';
import { makeRoot } from './helpers';

async function fakeBin(name: string, body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-cli-'));
  const bin = path.join(dir, name);
  await fs.writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('grokStatus: missing binary is reason "missing"', async () => {
  const { config, cleanup } = await makeRoot();
  try {
    const status = await grokStatus({ ...config, grokPath: path.join(os.tmpdir(), 'no-such-grok-xyz') });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'missing');
  } finally {
    await cleanup();
  }
});

test('grokStatus: installed reports "logged-out" (login not verifiable) with the version', async () => {
  const { config, cleanup } = await makeRoot();
  const grokPath = await fakeBin('grok', 'echo "grok 1.2.3"');
  try {
    const status = await grokStatus({ ...config, grokPath });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'logged-out');
    assert.equal(status.version, '1.2.3');
  } finally {
    await cleanup();
  }
});

test('geminiStatus: installed even when --version exits non-zero (unknown flag), no false "missing"', async () => {
  const { config, cleanup } = await makeRoot();
  const geminiPath = await fakeBin('gemini', 'echo "err" >&2; exit 2');
  try {
    const status = await geminiStatus({ ...config, geminiPath });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'logged-out');
    assert.equal(status.version, undefined);
  } finally {
    await cleanup();
  }
});
