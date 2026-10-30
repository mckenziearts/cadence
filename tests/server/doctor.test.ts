// The doctor's port check probes both addresses Cadence listens on (server/index.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { checkFfmpeg, checkPort } from '../../server/doctor';
import { setLanguage } from '../../server/i18n';
import { ENCODERS_FULL, ENCODERS_NO_VPX, failListen, fakeFfmpeg, occupy } from './helpers';

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

/** checkFfmpeg on a fake ffmpeg answering with `encoders`, in a temp folder removed afterwards. */
async function ffmpegCheck(encoders: string | null) {
  setLanguage('en');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-doctor-'));
  try {
    const bin = path.join(dir, 'ffmpeg');
    if (encoders !== null) await fakeFfmpeg(bin, encoders);
    return { bin, check: await checkFfmpeg(bin) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ffmpeg with every encoder lists every output', async () => {
  const { check } = await ffmpegCheck(ENCODERS_FULL);
  assert.deepEqual(check, { level: 'ok', label: 'ffmpeg 8.1-test renders mp4, webm, mov, gif, png, png-sequence' });
});

test('ffmpeg without libvpx warns that WebM is out, and why, without failing', async () => {
  const { check } = await ffmpegCheck(ENCODERS_NO_VPX);
  assert.deepEqual(check, {
    level: 'warn',
    label: 'ffmpeg 8.1-test renders mp4, mov, gif, png, png-sequence; webm: The ffmpeg in use has no libvpx-vp9 encoder',
  });
});

test('ffmpeg without libx264 or aac fails: MP4 is the render every project needs', async () => {
  const { check } = await ffmpegCheck(ENCODERS_FULL.replace(/^.* aac .*\n/m, ''));
  assert.equal(check.level, 'fail');
  assert.equal(check.label, 'ffmpeg 8.1-test without the aac encoder');
  assert.ok(check.fix?.includes('libx264 and aac'));
});

test('a missing ffmpeg fails with how to install it', async () => {
  const { bin, check } = await ffmpegCheck(null);
  assert.equal(check.level, 'fail');
  assert.equal(check.label, `ffmpeg not found (${bin})`);
});
