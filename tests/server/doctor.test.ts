// The doctor's port check probes both addresses Cadence listens on (server/index.ts).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { before, test } from 'node:test';
import { checkPort } from '../../server/doctor';
import { failListen, occupy } from './helpers';

let ipv6 = false;

/** A port nobody holds right now. */
async function freePort(): Promise<number> {
  const probe = await occupy(0, '127.0.0.1');
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

before(async () => {
  ipv6 = await occupy(0, '::1').then(
    (probe) => new Promise<boolean>((resolve) => probe.close(() => resolve(true))),
    () => false,
  );
});

test('a port taken on 127.0.0.1 warns, naming 127.0.0.1:<port>', async () => {
  const blocker = await occupy(0, '127.0.0.1');
  const { port } = blocker.address() as AddressInfo;
  try {
    const check = await checkPort(port, '127.0.0.1', 'editor', 'CADENCE_PORT');
    assert.equal(check.level, 'warn');
    assert.ok(check.label.includes(`127.0.0.1:${port}`), check.label);
  } finally {
    blocker.close();
  }
});

test('a port taken on ::1 only warns, naming [::1]:<port>', async (ctx) => {
  if (!ipv6) return ctx.skip('no IPv6 loopback on this host');
  const blocker = await occupy(0, '::1');
  const { port } = blocker.address() as AddressInfo;
  try {
    const check = await checkPort(port, '127.0.0.1', 'editor', 'CADENCE_PORT');
    assert.equal(check.level, 'warn');
    assert.ok(check.label.includes(`[::1]:${port}`), check.label);
  } finally {
    blocker.close();
  }
});

test('a free port is ok', async () => {
  assert.equal((await checkPort(await freePort(), '127.0.0.1', 'editor', 'CADENCE_PORT')).level, 'ok');
});

for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
  test(`no IPv6 (${code}) counts as free on ::1`, async (ctx) => {
    failListen(ctx, '::1', code);
    assert.equal((await checkPort(await freePort(), '127.0.0.1', 'editor', 'CADENCE_PORT')).level, 'ok');
  });
}
