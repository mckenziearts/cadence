// The hosts the person approved for the agent's captures, per project, kept in the state folder.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileCaptureHosts } from '../../server/store/captureHosts';
import { HttpError } from '../../server/util';

test('approvals are kept per project in the state folder, once each', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-capture-hosts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, '.cadence');
  const hosts = new FileCaptureHosts({ stateDir });

  assert.deepEqual(await hosts.list('demo'), []);
  assert.deepEqual(await hosts.approve('demo', 'example.com'), ['example.com']);
  assert.deepEqual(await hosts.approve('demo', 'localhost:5173'), ['example.com', 'localhost:5173']);
  assert.deepEqual(await hosts.approve('demo', 'example.com'), ['example.com', 'localhost:5173']);
  await hosts.approve('autre', '[::1]:8080');
  // A project id that is also an Object.prototype key.
  assert.deepEqual(await hosts.list('constructor'), []);
  await hosts.approve('constructor', '192.168.1.10:3000');

  const again = new FileCaptureHosts({ stateDir });
  assert.deepEqual(await again.list('demo'), ['example.com', 'localhost:5173']);
  assert.deepEqual(await again.list('autre'), ['[::1]:8080']);
  assert.deepEqual(await again.list('constructor'), ['192.168.1.10:3000']);

  assert.deepEqual(await again.revoke('demo', 'example.com'), ['localhost:5173']);
  assert.deepEqual(await again.revoke('demo', 'unknown.test'), ['localhost:5173'], 'a host never approved changes nothing');
  assert.deepEqual(await again.revoke('autre', '[::1]:8080'), []);
  assert.deepEqual(await again.list('autre'), []);
  await again.approve('autre', '[::1]:8080');
  assert.deepEqual(await again.list('demo'), ['localhost:5173']);

  await again.drop('demo');
  assert.deepEqual(await again.list('demo'), []);
  assert.deepEqual(await again.list('autre'), ['[::1]:8080']);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(stateDir, 'capture-hosts.json'), 'utf8'))).sort(), [
    'autre',
    'constructor',
  ]);
});

test('only a host written as a URL writes it is approved', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-capture-hosts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hosts = new FileCaptureHosts({ stateDir: root });
  for (const host of ['', 'Example.com', 'example.com:80', 'example.com/path', 'user@example.com', '0x7f.1', 'a b.test', '::1']) {
    await assert.rejects(
      hosts.approve('demo', host),
      (e) => e instanceof HttpError && e.status === 400 && e.message === `Hôte invalide : ${host}`,
      host,
    );
  }
  assert.deepEqual(await hosts.list('demo'), []);
});

test('approvals made at the same time are all kept', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-capture-hosts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hosts = new FileCaptureHosts({ stateDir: root });
  await Promise.all(['a.test', 'b.test', 'c.test'].map((host) => hosts.approve('demo', host)));
  assert.deepEqual((await hosts.list('demo')).sort(), ['a.test', 'b.test', 'c.test']);
});
