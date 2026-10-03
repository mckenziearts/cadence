// codexStatus() against fake `codex` executables: the three states the Profile card shows, with no real binary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexStatus } from '../../server/agent/codex';
import { makeRoot } from './helpers';

async function fakeCodex(body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-'));
  const bin = path.join(dir, 'codex');
  await fs.writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('codexStatus: missing binary is reason "missing"', async () => {
  const { config, cleanup } = await makeRoot();
  try {
    const status = await codexStatus({ ...config, codexPath: path.join(os.tmpdir(), 'no-such-codex-xyz') });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'missing');
  } finally {
    await cleanup();
  }
});

test('codexStatus: installed but not logged in is reason "logged-out"', async () => {
  const { config, cleanup } = await makeRoot();
  const codexPath = await fakeCodex('case "$1" in --version) echo "codex-cli 0.159.2";; *) echo "Not logged in"; exit 1;; esac');
  try {
    const status = await codexStatus({ ...config, codexPath });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'logged-out');
    assert.equal(status.version, '0.159.2');
  } finally {
    await cleanup();
  }
});

test('codexStatus: installed and logged in is ok, with the version', async () => {
  const { config, cleanup } = await makeRoot();
  const codexPath = await fakeCodex(
    'case "$1" in --version) echo "codex-cli 0.159.2";; *) echo "Logged in using ChatGPT"; exit 0;; esac',
  );
  try {
    const status = await codexStatus({ ...config, codexPath });
    assert.equal(status.ok, true);
    assert.equal(status.version, '0.159.2');
    assert.equal(status.reason, undefined);
  } finally {
    await cleanup();
  }
});
