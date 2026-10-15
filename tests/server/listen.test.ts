// Both servers listen on 127.0.0.1 and ::1: Chromium tries `localhost` on ::1 too, where another local user could answer.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { m } from '../../server/i18n';
import { startServer, type RunningServer } from '../../server/index';
import { failListen, makeRoot, occupy, type TestRoot } from './helpers';

let t: TestRoot;
let server: RunningServer | undefined;
let ipv6 = false;

const provider = {
  id: 'fake',
  label: 'Agent de test',
  status: async () => ({ ok: true, label: 'Agent de test' }),
  async *run() {
    yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
  },
};

function start(editorPort: number, framePort = 0) {
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  return startServer({ projectsDir, brandsDir, templatesDir, stateDir, editorPort, framePort, quiet: true, provider });
}

/** A GET as Chromium sends it for `localhost`, to one address. */
function get(address: string, port: number, pathname: string): Promise<{ status: number; csp: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: address, port, path: pathname, headers: { host: `localhost:${port}` } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, csp: 'content-security-policy' in res.headers, body }));
      })
      .once('error', reject);
  });
}

before(async () => {
  process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/listen');
  t = await makeRoot();
  ipv6 = await occupy(0, '::1').then(
    (probe) => new Promise<boolean>((resolve) => probe.close(() => resolve(true))),
    () => false,
  );
});

after(async () => {
  await server?.close();
  await t.cleanup();
});

test('a fixed port taken on ::1 makes start fail and frees 127.0.0.1', async (ctx) => {
  if (!ipv6) return ctx.skip('no IPv6 loopback on this host');
  const blocker = await occupy(0, '::1');
  const port = (blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(
      start(port).then((started) => started.close()),
      (e: Error) => e.message.includes(`[::1]:${port}`),
    );
    (await occupy(port, '127.0.0.1')).close();
  } finally {
    blocker.close();
  }
});

test('a frame port taken on ::1 makes start fail and frees the editor on both addresses', { timeout: 10_000 }, async (ctx) => {
  if (!ipv6) return ctx.skip('no IPv6 loopback on this host');
  const probe = await occupy(0, '127.0.0.1');
  const editorPort = (probe.address() as AddressInfo).port;
  probe.close();
  const blocker = await occupy(0, '::1');
  const framePort = (blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(
      start(editorPort, framePort).then((started) => started.close()),
      (e: Error) => e.message.includes(`[::1]:${framePort}`),
    );
    const freed = await Promise.all([occupy(editorPort, '127.0.0.1'), occupy(editorPort, '::1'), occupy(framePort, '127.0.0.1')]);
    for (const socket of freed) socket.close();
  } finally {
    blocker.close();
  }
});

test('a port 0 start answers on 127.0.0.1 and ::1, then close() closes both', async (ctx) => {
  if (!ipv6) return ctx.skip('no IPv6 loopback on this host');
  server = await start(0);
  const { editorPort, framePort } = server.config;
  for (const address of ['127.0.0.1', '::1']) {
    const editor = await get(address, editorPort, '/');
    assert.equal(editor.status, 200, address);
    assert.ok(editor.body.includes(server.editorToken), address);
    assert.ok((await get(address, framePort, '/frame.html')).csp, address);
  }

  await server.close();
  // Bound right away: other test files start servers on port 0 too, and a freed port soon serves one of them.
  const freed = await Promise.all(
    ['127.0.0.1', '::1'].flatMap((address) => [editorPort, framePort].map((port) => occupy(port, address))),
  );
  for (const blocker of freed) blocker.close();
});

test('a fixed port taken on 127.0.0.1 makes start fail naming 127.0.0.1:<port>', async () => {
  const blocker = await occupy(0, '127.0.0.1');
  const port = (blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(
      start(port).then((started) => started.close()),
      (e: Error) => e.message === m().api.server.portInUse(`127.0.0.1:${port}`),
    );
  } finally {
    blocker.close();
  }
});

test('port 0: ::1 taken once, both start again on a new port that answers on both addresses', async (ctx) => {
  if (!ipv6) return ctx.skip('no IPv6 loopback on this host');
  const listen = failListen(ctx, '::1', 'EADDRINUSE', 1);
  const started = await start(0);
  try {
    const onIpv6 = listen.mock.calls.filter((call) => call.arguments[1] === '::1').map((call) => call.arguments[0]);
    // Editor: the failed try, then the retry; frame: one try.
    assert.equal(onIpv6.length, 3);
    assert.equal(onIpv6[1], started.config.editorPort);
    for (const address of ['127.0.0.1', '::1']) {
      const editor = await get(address, started.config.editorPort, '/');
      assert.equal(editor.status, 200, address);
      assert.ok(editor.body.includes(started.editorToken), address);
    }
  } finally {
    await started.close();
  }
});

test('port 0: ::1 taken 5 times makes start fail naming [::1]:<port> and frees 127.0.0.1', async (ctx) => {
  const listen = failListen(ctx, '::1', 'EADDRINUSE');
  const error = await start(0).then(
    (started) => started.close().then(() => null),
    (e: Error) => e,
  );
  const onIpv6 = listen.mock.calls.filter((call) => call.arguments[1] === '::1').map((call) => call.arguments[0] as number);
  assert.equal(onIpv6.length, 5);
  const last = onIpv6[4];
  assert.equal(error?.message, m().api.server.portInUse(`[::1]:${last}`));
  (await occupy(last, '127.0.0.1')).close();
});

for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
  test(`no IPv6 (${code}): start goes on with 127.0.0.1 only, and close() frees it`, async (ctx) => {
    failListen(ctx, '::1', code);
    const started = await start(0);
    const { editorPort, framePort } = started.config;
    try {
      const editor = await get('127.0.0.1', editorPort, '/');
      assert.equal(editor.status, 200);
      assert.ok(editor.body.includes(started.editorToken));
      assert.ok((await get('127.0.0.1', framePort, '/frame.html')).csp);
    } finally {
      await started.close();
    }
    const freed = await Promise.all([editorPort, framePort].map((port) => occupy(port, '127.0.0.1')));
    for (const blocker of freed) blocker.close();
  });
}
