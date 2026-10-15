// Capture and render browsers run in a child process (chromium-server.mjs) that the server drives over a WebSocket on a
// private Unix socket. Playwright reads a browser's CDP pipe in the process that launched it, and a page message larger than a
// string can hold ends that process (ERR_STRING_TOO_LONG): here it ends the child, its pages fail, the server stays up.
import { fork } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { chromium, type Browser, type LaunchOptions } from 'playwright';

const SERVER_SCRIPT = new URL('./chromium-server.mjs', import.meta.url);
/** A child still closing Chromium by then is killed (Chromium ends with its CDP pipe). */
const STOP_TIMEOUT_MS = 10_000;

export type HostOptions = Pick<LaunchOptions, 'args' | 'chromiumSandbox' | 'handleSIGINT' | 'handleSIGTERM' | 'handleSIGHUP'>;

/** Chromium in a child process. Closing the browser, or losing it, ends the child; close() waits until it has. */
export async function hostChromium(options: HostOptions): Promise<Browser> {
  // Under Electron, process.execPath runs as Node only while the RunAsNode fuse is on, which a packaged app usually turns
  // off: forked, it would start the app instead of this script. The host names the binary, so a missing one fails early.
  const node = process.env.CADENCE_NODE_PATH || (process.versions.electron ? undefined : process.execPath);
  if (!node) throw new Error('Chromium host needs a Node binary under Electron: set CADENCE_NODE_PATH');
  const child = fork(SERVER_SCRIPT, [JSON.stringify(options)], {
    execPath: node,
    // The server's own flags (tsx hooks, the test runner's) mean nothing to this script.
    execArgv: [],
    // CADENCE_NODE_PATH may name an Electron binary whose RunAsNode fuse is on: this makes it run as Node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let socketDir: string | undefined;
  const stop = async () => {
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
    const browser = await chromium.connect(wsEndpoint);
    browser.on('disconnected', () => void stop());
    // A connected browser's close() only disconnects: the child then closes Chromium.
    const disconnect = browser.close.bind(browser);
    browser.close = async (closeOptions) => {
      await disconnect(closeOptions);
      await stop();
    };
    return browser;
  } catch (e) {
    await stop();
    throw e;
  }
}
