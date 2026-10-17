// codexStatus() against fake `codex` executables: the states the Profile card shows, with no real binary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexStatus } from '../../server/agent/codex';
import { makeRoot } from './helpers';

/** The probe runs `codex sandbox ... cat probe <outside>/probe` in the profile's folder: a confined CLI reads only the first. */
const CONFINED = 'sandbox) cat probe;;';
/** A CLI that ignores the profile reads both files. */
const UNCONFINED = 'sandbox) for last; do :; done; cat probe "$last";;';
/** CLIs that read like a confined one but let the probe's write outside the profile, or its connection, through. */
const LEAKS_WRITE = 'sandbox) for last; do :; done; case "$last" in */written) : > "$last";; *) cat probe;; esac;;';
const LEAKS_NETWORK = 'sandbox) for last; do :; done; case "$last" in http*) curl -s -m 3 "$last";; *) cat probe;; esac;;';
const LOGGED_IN = '*) echo "Logged in using ChatGPT"; exit 0;;';
const LOGGED_OUT = '*) echo "Not logged in"; exit 1;;';
const cli = (version: string, sandbox: string, login: string) =>
  `case "$1" in --version) echo "codex-cli ${version}";; ${sandbox} ${login} esac`;

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
  const codexPath = await fakeCodex(cli('0.161.0', CONFINED, LOGGED_OUT));
  try {
    const status = await codexStatus({ ...config, codexPath });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'logged-out');
    assert.equal(status.version, '0.161.0');
  } finally {
    await cleanup();
  }
});

test('codexStatus: installed and logged in is ok, with the version', async () => {
  const { config, cleanup } = await makeRoot();
  const codexPath = await fakeCodex(cli('0.161.0', CONFINED, LOGGED_IN));
  try {
    const status = await codexStatus({ ...config, codexPath });
    assert.equal(status.ok, true);
    assert.equal(status.version, '0.161.0');
    assert.equal(status.reason, undefined);
  } finally {
    await cleanup();
  }
});

for (const [login, body] of [
  ['logged in', LOGGED_IN],
  ['logged out', LOGGED_OUT],
]) {
  test(`codexStatus: a CLI that ignores the permission profile is reason "unconfined", ${login}`, async () => {
    const { config, cleanup } = await makeRoot();
    const codexPath = await fakeCodex(cli('0.161.0', UNCONFINED, body));
    try {
      const status = await codexStatus({ ...config, codexPath });
      assert.equal(status.ok, false);
      assert.equal(status.reason, 'unconfined', 'the probe runs before the login check');
      assert.equal(status.version, '0.161.0');
      assert.match(status.detail ?? '', /ne sait pas limiter ses accès/);
    } finally {
      await cleanup();
    }
  });
}

test('codexStatus: a sandbox that reads nothing, not even the profile\'s own folder, is reason "unconfined"', async () => {
  const { config, cleanup } = await makeRoot();
  const codexPath = await fakeCodex(cli('0.161.0', 'sandbox) exit 1;;', LOGGED_IN));
  try {
    assert.equal((await codexStatus({ ...config, codexPath })).reason, 'unconfined');
  } finally {
    await cleanup();
  }
});

for (const [leak, sandbox] of [
  ['writes outside the profile', LEAKS_WRITE],
  ['connects to the network', LEAKS_NETWORK],
]) {
  test(`codexStatus: a sandbox that reads like a confined one but ${leak} is reason "unconfined"`, async () => {
    const { config, cleanup } = await makeRoot();
    const codexPath = await fakeCodex(cli('0.161.0', sandbox, LOGGED_IN));
    try {
      assert.equal((await codexStatus({ ...config, codexPath })).reason, 'unconfined');
    } finally {
      await cleanup();
      await fs.rm(path.dirname(codexPath), { recursive: true, force: true });
    }
  });
}

test('codexStatus: a version older than 0.161.0 is reason "unconfined", whatever its sandbox prints', async () => {
  const { config, cleanup } = await makeRoot();
  try {
    for (const version of ['0.160.9', '0.99.0', 'dev']) {
      const codexPath = await fakeCodex(cli(version, CONFINED, LOGGED_IN));
      const status = await codexStatus({ ...config, codexPath });
      assert.equal(status.ok, false, version);
      assert.equal(status.reason, 'unconfined', version);
      assert.match(status.detail ?? '', /ne sait pas limiter ses accès/);
    }
    assert.equal((await codexStatus({ ...config, codexPath: await fakeCodex(cli('0.170.2', CONFINED, LOGGED_IN)) })).ok, true);
  } finally {
    await cleanup();
  }
});

test('codexStatus: a probe that cannot run is a status, not a rejection', async (t) => {
  const { config, cleanup } = await makeRoot();
  const codexPath = await fakeCodex(cli('0.161.0', CONFINED, LOGGED_IN));
  const tmpdir = process.env.TMPDIR;
  t.after(() => {
    if (tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpdir;
    return cleanup();
  });
  // The probe makes its folders under os.tmpdir(): a missing one makes it throw.
  process.env.TMPDIR = path.join(os.tmpdir(), 'no-such-tmp-xyz');
  const status = await codexStatus({ ...config, codexPath });
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'error');
  assert.match(status.detail ?? '', /no-such-tmp-xyz/);
});
