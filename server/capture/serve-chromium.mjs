// The Chromium server behind capture and render pages, run in a process other than the Cadence server's: the core's
// fork (chromium-server.mjs), or a host app's own process (StartOptions.browserServer). Playwright reads the browser's
// CDP pipe in that process, so a page message too large for a string ends it, not the server. JavaScript, so that it
// starts without the server's tsx hooks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

/** Launches Chromium with the core's launch options, as received, on a private Unix socket. */
export async function serveChromium(options) {
  // A loopback port would let any local process drive this browser (Playwright's /json hands out the endpoint path), so
  // the server listens on a Unix socket in a folder only this user can open (mkdtemp makes it 0700). launchServer takes
  // a socket path as `port` (Playwright 1.63, not documented): tests/server/browser-host.test.ts checks it on every update.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-chromium-'));
  const socket = path.join(dir, 's.sock');
  try {
    // sun_path holds 104 bytes on macOS, 108 on Linux, NUL included: past that, listen() fails once Chromium runs.
    if (Buffer.byteLength(socket) > 103)
      throw new Error(`Chromium host socket path too long (${socket}): set TMPDIR to a shorter folder`);
    const server = await chromium.launchServer({ ...options, port: socket });
    const endpoint = server.wsEndpoint();
    if (!endpoint.startsWith(`${socket}/`)) {
      await server.close();
      throw new Error(`Chromium host did not listen on its Unix socket: ${endpoint}`);
    }
    return {
      wsEndpoint: `ws+unix:${socket}:${endpoint.slice(socket.length)}`,
      dir,
      close: async () => {
        try {
          await server.close();
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}
