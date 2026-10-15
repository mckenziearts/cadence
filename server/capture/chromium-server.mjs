// Chromium for capture and render pages, in a process of its own (browser-host.ts): Playwright reads the browser's CDP
// pipe here, so a page message too large for a string ends this process, not the server. JavaScript, so that it starts
// without the server's tsx hooks (an Electron host drops them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Ctrl+C, a closed terminal and a SIGTERM sent to the process group reach this process too: it lives as long as the
// server keeps its IPC channel open, so the server stops its renders before Chromium goes.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);
process.on('SIGHUP', () => undefined);

// A loopback port would let any local process drive this browser (Playwright's /json hands out the endpoint path), so
// the server listens on a Unix socket in a folder only this user can open (mkdtemp makes it 0700). launchServer takes
// a socket path as `port` (Playwright 1.63, not documented): tests/server/browser-host.test.ts checks it on every update.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-chromium-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const socket = path.join(dir, 's.sock');

try {
  // sun_path holds 104 bytes on macOS, 108 on Linux, NUL included: past that, listen() fails once Chromium runs.
  if (Buffer.byteLength(socket) > 103)
    throw new Error(`Chromium host socket path too long (${socket}): set TMPDIR to a shorter folder`);
  const server = await chromium.launchServer({ ...JSON.parse(process.argv[2]), port: socket });
  const endpoint = server.wsEndpoint();
  if (!endpoint.startsWith(`${socket}/`)) {
    await server.close();
    throw new Error(`Chromium host did not listen on its Unix socket: ${endpoint}`);
  }
  const close = () => void server.close().finally(() => process.exit(0));
  if (process.connected) {
    process.on('disconnect', close);
    process.send({ wsEndpoint: `ws+unix:${socket}:${endpoint.slice(socket.length)}`, dir });
  } else close();
} catch (e) {
  // Chromium may run already (launchServer failed after starting it): exiting closes its pipe, which ends it too.
  process.exitCode = 1;
  if (process.connected) process.send({ error: e instanceof Error ? e.message : String(e) }, () => process.exit());
  else process.exit();
}
