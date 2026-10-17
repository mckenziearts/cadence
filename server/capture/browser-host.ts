// Capture and render browsers run in a process of their own (serve-chromium.mjs) that the server drives over a WebSocket
// on a private Unix socket: a child it forks (chromium-server.mjs), or a host app's process (StartOptions.browserServer).
// Playwright reads a browser's CDP pipe in the process that launched it, and a page message larger than a string can hold
// ends that process (ERR_STRING_TOO_LONG): here it ends the child, its pages fail, the server stays up.
import { fork } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';
import type { BrowserServer, ChromiumOptions } from '../contracts';

const SERVER_SCRIPT = new URL('./chromium-server.mjs', import.meta.url);
/** A child still closing Chromium by then is killed (Chromium ends with its CDP pipe). */
const STOP_TIMEOUT_MS = 10_000;
/**
 * How long a close() may hold a render, server.close() or a failed launch. A host's close() must settle within
 * STOP_TIMEOUT_MS; the extra second lets the fork reap the child it killed and remove its socket folder.
 */
const CLOSE_TIMEOUT_MS = STOP_TIMEOUT_MS + 1_000;

/** Chromium in a child process of the server. close() disconnects it and waits until it has exited. */
export async function forkChromium(options: ChromiumOptions): Promise<BrowserServer> {
  // Under Electron, process.execPath runs as Node only while the RunAsNode fuse is on, which a packaged app usually turns
  // off: forked, it would start the app instead of this script. The host names the binary, so a missing one fails early.
  const node = process.env.CADENCE_NODE_PATH || (process.versions.electron ? undefined : process.execPath);
  if (!node) throw new Error('Chromium host needs a Node binary under Electron: set CADENCE_NODE_PATH, or pass browserServer');
  const child = fork(SERVER_SCRIPT, [JSON.stringify(options)], {
    execPath: node,
    // The server's own flags (tsx hooks, the test runner's) mean nothing to this script.
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let socketDir: string | undefined;
  const close = async () => {
    // A child that never started (fork's 'error') never emits 'exit'.
    if (child.pid === undefined) return;
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS).unref();
    await exited;
    clearTimeout(timer);
    // The child removes it on exit, but a fatal error (out of memory) ends it without running its exit handlers.
    if (socketDir) await rm(socketDir, { recursive: true, force: true });
  };
  try {
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      child.once('message', (message) => {
        const { wsEndpoint, dir, error } = message as { wsEndpoint?: string; dir?: string; error?: string };
        socketDir = dir;
        if (wsEndpoint) resolve(wsEndpoint);
        else reject(new Error(error));
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Chromium host exited (${signal ?? code})`)));
    });
    return { wsEndpoint, exited, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * Chromium in the process `start` runs. Closing the browser, or losing it, ends that process; close() waits until it
 * has, CLOSE_TIMEOUT_MS at most.
 */
export async function hostChromium(
  options: ChromiumOptions,
  start: (options: ChromiumOptions) => Promise<BrowserServer> = forkChromium,
): Promise<Browser> {
  const server = await start(options);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= Promise.race([server.close(), sleep(CLOSE_TIMEOUT_MS, undefined, { ref: false })]));
  try {
    // A loopback TCP endpoint (launchServer without a socket `port`) would let any local process drive this browser.
    if (!server.wsEndpoint.startsWith('ws+unix:'))
      throw new Error(`Chromium host did not listen on a Unix socket: ${server.wsEndpoint}`);
    const browser = await chromium.connect(server.wsEndpoint);
    // A connected browser's close() only disconnects: the process then closes Chromium.
    const disconnect = browser.close.bind(browser);
    browser.on('disconnected', () => void close().catch(() => undefined));
    browser.close = async (closeOptions) => {
      await disconnect(closeOptions);
      await close();
    };
    // A process that ended may leave the socket open (Chromium still up): pages in flight fail now, the next launch starts anew.
    const drop = () => void disconnect().catch(() => undefined);
    server.exited.then(drop, drop);
    return browser;
  } catch (e) {
    await close();
    throw e;
  }
}
