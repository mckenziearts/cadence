// Capture and render Chromium runs in a child process (server/capture/browser-host.ts), the core's fork or a host app's
// (browserServer): its lifecycle, its transport, and what a page that logs too much does to it. No frame harness, so
// these run in CI.
import assert from 'node:assert/strict';
import { execFile, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { CHROMIUM_ARGS, launchChromium } from '../../server/capture/capture';
import { serveChromium } from '../../server/capture/serve-chromium.mjs';
import { chromiumSandbox } from '../../server/config';
import type { BrowserServer, ChromiumOptions } from '../../server/contracts';
import { startServer, type RunningServer } from '../../server/index';
import { makeRoot, type TestRoot } from './helpers';

const run = promisify(execFile);
let installed = false;

before(async () => {
  try {
    await (await launchChromium()).close();
    installed = true;
  } catch (e) {
    if (!/Executable doesn't exist/i.test((e as Error).message)) throw e;
  }
});

/** Skips a test that needs Chromium, except in CI, where the workflow installs it and a skip would hide the check. */
function chromiumMissing(t: TestContext): void {
  assert.ok(!process.env.CI, 'Chromium missing in CI: the workflow must run npm run setup');
  t.skip('Chromium missing (npm run setup)');
}

/** Pids of the Chromium host processes (browser-host.ts) that `parent` started and that are still running. */
async function hostPids(parent = process.pid): Promise<number[]> {
  const { stdout } = await run('pgrep', ['-P', String(parent), '-f', 'chromium-server.mjs']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter(Boolean).map(Number);
}

/** The host process launchChromium() just started, given the hosts running before. */
async function newHost(before: number[]): Promise<number> {
  const [pid] = (await hostPids()).filter((p) => !before.includes(p));
  assert.ok(pid, 'no Chromium host process');
  return pid;
}

/** Names of what process `pid` has open among `selection` (lsof options): files, sockets. */
async function openFiles(pid: number, ...selection: string[]): Promise<string[]> {
  // lsof exits with 1 when nothing matches.
  const { stdout } = await run('lsof', ['-a', '-p', String(pid), ...selection, '-F', 'n']).catch(() => ({ stdout: '' }));
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

/** The 0700 folder holding the Unix socket that host process `pid` listens on. */
async function socketDir(pid: number): Promise<string> {
  const socket = (await openFiles(pid, '-U')).map((name) => /(\S*\/cadence-chromium-[^/\s]+)\/s\.sock/.exec(name)).find(Boolean);
  assert.ok(socket, 'no Unix socket in a cadence-chromium- folder');
  return socket[1];
}

/**
 * `promise`, or a failure after `ms`: an endless wait would skip the cleanup that closes the browser, and the file would
 * never end. The deadline holds the event loop: under Node 22 a test waiting on unref'd timers alone ends the file.
 */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      promise,
      sleep(ms, undefined, { signal: deadline.signal }).then(() => assert.fail(`${what} within ${ms} ms`)),
    ]);
  } finally {
    deadline.abort();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${what} within ${ms} ms`);
    await sleep(50);
  }
}

const HOST_APP = path.join(import.meta.dirname, '../fixtures/capture/browser-server-host.mjs');

interface HostApp {
  hook: (options: ChromiumOptions) => Promise<BrowserServer>;
  /** The options of each call. */
  calls: ChromiumOptions[];
  /** The process each call started, and its socket folder. */
  pids: number[];
  dirs: string[];
  closes: number;
  /** When set, the next calls reject with this message without starting anything. */
  refuse?: string;
}

/** A host app's browserServer: each call starts browser-server-host.mjs, as the host would start its own process. */
function hostApp(): HostApp {
  const app: HostApp = {
    calls: [],
    pids: [],
    dirs: [],
    closes: 0,
    hook: async (options) => {
      app.calls.push(options);
      if (app.refuse) throw new Error(app.refuse);
      const child = fork(HOST_APP, [JSON.stringify(options)], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      app.pids.push(child.pid!);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const { wsEndpoint, dir } = await new Promise<{ wsEndpoint: string; dir: string }>((resolve, reject) => {
        child.once('message', (message) => {
          const { error, ...served } = message as { wsEndpoint: string; dir: string; error?: string };
          if (error) reject(new Error(error));
          else resolve(served);
        });
        child.once('exit', (code) => reject(new Error(`host app process exited (${code})`)));
      });
      app.dirs.push(dir);
      return {
        wsEndpoint,
        exited,
        close: async () => {
          app.closes++;
          if (child.connected) child.disconnect();
          await exited;
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  };
  return app;
}

test('Chromium runs in a child process that ends when the browser is closed', async (t) => {
  if (!installed) return chromiumMissing(t);
  const running = (await hostPids()).length;
  const browser = await launchChromium();
  assert.equal((await hostPids()).length, running + 1);
  const page = await browser.newPage();
  assert.equal(await page.evaluate(() => 1 + 1), 2);
  await browser.close();
  assert.equal((await hostPids()).length, running);
});

test('Chromium is driven over a Unix socket in a folder only this user opens, with no TCP port', async (t) => {
  if (!installed) return chromiumMissing(t);
  // A loopback port would let any local process drive the capture browser: Playwright's /json gives its endpoint away.
  const before = await hostPids();
  const browser = await launchChromium();
  let dir = '';
  try {
    const host = await newHost(before);
    assert.deepEqual(await openFiles(host, '-iTCP', '-sTCP:LISTEN'), []);
    dir = await socketDir(host);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const page = await browser.newPage();
    assert.equal(await page.evaluate(() => 1 + 1), 2);
  } finally {
    await browser.close();
  }
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

test('Chromium stays through Ctrl+C, SIGTERM and a closed terminal, which reach its process too: Cadence closes it itself', async (t) => {
  if (!installed) return chromiumMissing(t);
  const before = await hostPids();
  const browser = await launchChromium();
  try {
    const host = await newHost(before);
    process.kill(host, 'SIGINT');
    process.kill(host, 'SIGTERM');
    process.kill(host, 'SIGHUP');
    await sleep(500);
    const page = await browser.newPage();
    assert.equal(await page.evaluate(() => 1 + 1), 2);
  } finally {
    await browser.close();
  }
});

test('the child process and Chromium end when the server process dies', { timeout: 30_000 }, async (t) => {
  if (!installed) return chromiumMissing(t);
  const root = path.join(import.meta.dirname, '../..');
  const server = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/capture/hosted-chromium.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const pids: number[] = [];
  try {
    // A fixture that crashes before printing closes stdout without a line: its exit ends the wait.
    const line = await within(
      Promise.race([
        once(createInterface({ input: server.stdout }), 'line').then(([first]) => first as string),
        once(server, 'exit').then(() => undefined),
      ]),
      20_000,
      'hosted-chromium.ts printed no line',
    );
    assert.ok(line, 'hosted-chromium.ts exited before printing its browser pid');
    pids.push((JSON.parse(line) as { browser: number }).browser, ...(await hostPids(server.pid!)));
    assert.equal(pids.length, 2);
    const dir = await socketDir(pids[1]);
    server.kill('SIGKILL');
    const deadline = Date.now() + 10_000;
    while (pids.some(alive) && Date.now() < deadline) await sleep(100);
    assert.deepEqual(pids.filter(alive), []);
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  } finally {
    server.kill('SIGKILL');
    for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
  }
});

test('the child process ends, and removes its socket folder, when its Chromium dies', { timeout: 30_000 }, async (t) => {
  if (!installed) return chromiumMissing(t);
  const before = await hostPids();
  const browser = await launchChromium();
  const host = await newHost(before);
  try {
    const dir = await socketDir(host);
    const { processInfo } = await (await browser.newBrowserCDPSession()).send('SystemInfo.getProcessInfo');
    const lost = new Promise((resolve) => browser.once('disconnected', resolve));
    process.kill(processInfo.find((info) => info.type === 'browser')!.id, 'SIGKILL');
    await within(lost, 10_000, 'no disconnect');
    const deadline = Date.now() + 5_000;
    while (alive(host) && Date.now() < deadline) await sleep(100);
    assert.equal(alive(host), false);
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  } finally {
    await browser.close().catch(() => undefined);
    if (alive(host)) process.kill(host, 'SIGKILL');
  }
});

test('closing the browser kills a child process that does not end by itself', { timeout: 30_000 }, async (t) => {
  if (!installed) return chromiumMissing(t);
  const initial = process.env.NODE_OPTIONS;
  const preload = path.join(import.meta.dirname, '../fixtures/capture/chromium-host-stays.mjs');
  process.env.NODE_OPTIONS = `--import ${pathToFileURL(preload).href}`;
  const before = await hostPids();
  let host = 0;
  try {
    const browser = await launchChromium();
    host = await newHost(before);
    const dir = await socketDir(host);
    await within(browser.close(), 20_000, 'close() did not return');
    assert.equal(alive(host), false);
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  } finally {
    if (initial === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = initial;
    if (host && alive(host)) process.kill(host, 'SIGKILL');
  }
});

test('under Electron, the launch refuses to fork without CADENCE_NODE_PATH', async () => {
  // A packaged Electron app usually turns its RunAsNode fuse off: the forked binary would start the app instead of this
  // script. The host names a Node binary or starts Chromium itself (browserServer), so a missing one fails in development too.
  const initial = process.env.CADENCE_NODE_PATH;
  delete process.env.CADENCE_NODE_PATH;
  Object.defineProperty(process.versions, 'electron', { value: '44.5.1', configurable: true });
  const before = await hostPids();
  try {
    const launch = launchChromium();
    launch.then(
      (browser) => browser.close(),
      () => undefined,
    );
    await assert.rejects(launch, /CADENCE_NODE_PATH.*browserServer/);
    assert.deepEqual(await hostPids(), before);
  } finally {
    delete (process.versions as Record<string, string>).electron;
    if (initial !== undefined) process.env.CADENCE_NODE_PATH = initial;
  }
});

test('under Electron, a launch through browserServer needs no CADENCE_NODE_PATH', async (t) => {
  if (!installed) return chromiumMissing(t);
  // A host app whose binary cannot run as Node starts the Chromium process itself: nothing is forked.
  const initial = process.env.CADENCE_NODE_PATH;
  delete process.env.CADENCE_NODE_PATH;
  Object.defineProperty(process.versions, 'electron', { value: '44.5.1', configurable: true });
  const app = hostApp();
  const before = await hostPids();
  try {
    const browser = await launchChromium(app.hook);
    try {
      assert.deepEqual(await hostPids(), before);
      const page = await browser.newPage();
      assert.equal(await page.evaluate(() => 1 + 1), 2);
    } finally {
      await browser.close();
    }
    assert.equal(app.calls.length, 1);
  } finally {
    delete (process.versions as Record<string, string>).electron;
    if (initial !== undefined) process.env.CADENCE_NODE_PATH = initial;
  }
});

test('the launch fails, instead of waiting forever, when the child process cannot start', { timeout: 10_000 }, async () => {
  const execPath = process.execPath;
  process.execPath = path.join(import.meta.dirname, 'no-such-node');
  try {
    await assert.rejects(launchChromium());
  } finally {
    process.execPath = execPath;
  }
});

test("the child process runs under CADENCE_NODE_PATH, without the server's own flags", async (t) => {
  if (!installed) return chromiumMissing(t);
  // An Electron host cannot always fork itself as Node: it names a Node binary instead.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cadence-node-'));
  const node = path.join(dir, 'node');
  await writeFile(node, `#!/bin/sh\nprintf '%s\\n' "$ELECTRON_RUN_AS_NODE" "$@" > "$0.ran"\nexec "${process.execPath}" "$@"\n`);
  await chmod(node, 0o755);
  const initial = process.env.CADENCE_NODE_PATH;
  process.env.CADENCE_NODE_PATH = node;
  try {
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      assert.equal(await page.evaluate(() => 1 + 1), 2);
    } finally {
      await browser.close();
    }
    const [runAsNode, ...args] = (await readFile(`${node}.ran`, 'utf8')).trimEnd().split('\n');
    // The binary is a Node binary: the core never asks an Electron binary to run as Node.
    assert.equal(runAsNode, process.env.ELECTRON_RUN_AS_NODE ?? '');
    // This test file runs with --import tsx and the runner's --test flags: none of them may reach the child.
    assert.deepEqual(
      args.slice(0, -1).map((arg) => path.basename(arg)),
      ['chromium-server.mjs'],
    );
    assert.equal(typeof JSON.parse(args.at(-1)!), 'object');
  } finally {
    if (initial === undefined) delete process.env.CADENCE_NODE_PATH;
    else process.env.CADENCE_NODE_PATH = initial;
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'a page that logs more than a string can hold ends its Chromium host, not the server, and the next launch works',
  { timeout: 60_000 },
  async (t) => {
    if (!installed) return chromiumMissing(t);
    const before = await hostPids();
    const browser = await launchChromium();
    const host = await newHost(before);
    const dir = await socketDir(host);
    const lost = new Promise((resolve) => browser.once('disconnected', resolve));
    try {
      const page = await browser.newPage();
      await page
        .setContent(`<script>const big = 'x'.repeat(300_000_000); console.log(big, big);</script>`)
        .catch(() => undefined);
      await within(lost, 30_000, 'no disconnect');
      await assert.rejects(
        page.evaluate(() => 1),
        /closed|disconnected/,
      );
    } finally {
      await browser.close().catch(() => undefined);
    }
    assert.equal(alive(host), false);
    await assert.rejects(stat(dir), { code: 'ENOENT' });
    const next = await launchChromium();
    try {
      const page = await next.newPage();
      assert.equal(await page.evaluate(() => 1 + 1), 2);
      assert.notEqual(await newHost(before), host);
    } finally {
      await next.close();
    }
  },
);

test(
  'a page that logs one string past what the host can hold ends the host and leaves no socket folder',
  { timeout: 60_000 },
  async (t) => {
    if (!installed) return chromiumMissing(t);
    // The host dies of a fatal out-of-memory error here, which skips its own exit handlers: the server removes the folder.
    const before = await hostPids();
    const browser = await launchChromium();
    const host = await newHost(before);
    const dir = await socketDir(host);
    const lost = new Promise((resolve) => browser.once('disconnected', resolve));
    try {
      const page = await browser.newPage();
      // Capture listens to the console (its problems): only then does the host build a message for the server.
      page.on('console', () => undefined);
      await page.setContent(`<script>console.log('x'.repeat(300_000_000));</script>`).catch(() => undefined);
      await within(lost, 30_000, 'no disconnect');
    } finally {
      await browser.close().catch(() => undefined);
    }
    assert.equal(alive(host), false);
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  },
);

test('a host app starts the Chromium process through browserServer, once per launch, and close() ends it', async (t) => {
  if (!installed) return chromiumMissing(t);
  const app = hostApp();
  const before = await hostPids();
  const browser = await launchChromium(app.hook);
  try {
    // The core decides the arguments and the sandbox: the host forwards them as is to serveChromium().
    assert.deepEqual(app.calls, [
      { args: CHROMIUM_ARGS, chromiumSandbox: chromiumSandbox(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false },
    ]);
    assert.deepEqual(await hostPids(), before);
    const page = await browser.newPage();
    assert.equal(await page.evaluate(() => 1 + 1), 2);
    assert.equal(app.closes, 0);
  } finally {
    await within(browser.close(), 20_000, 'close() did not return');
  }
  assert.equal(app.closes, 1);
  assert.equal(alive(app.pids[0]), false);
  await assert.rejects(stat(app.dirs[0]), { code: 'ENOENT' });
});

for (const outcome of ['resolves', 'rejects'] as const) {
  test(`the browser is dropped once the host app's process has ended (exited ${outcome}), and the next launch calls browserServer again`, async (t) => {
    if (!installed) return chromiumMissing(t);
    // Only `exited` says so here: the process and its socket stay up until close().
    const app = hostApp();
    let reportExit = () => {};
    const hook = async (options: ChromiumOptions) => {
      const served = await app.hook(options);
      const exited = new Promise((resolve, reject) => {
        reportExit = () => (outcome === 'resolves' ? resolve(undefined) : reject(new Error('host process crashed')));
      });
      return { ...served, exited };
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const browser = await launchChromium(hook);
      try {
        const page = await browser.newPage();
        const lost = new Promise((resolve) => browser.once('disconnected', resolve));
        const inFlight = assert.rejects(
          page.evaluate(() => new Promise(() => undefined)),
          /closed|disconnected/,
        );
        reportExit();
        await within(lost, 10_000, 'no disconnect');
        await inFlight;
        await assert.rejects(
          page.evaluate(() => 1),
          /closed|disconnected/,
        );
        assert.equal(app.closes, 1);
        await until(() => !alive(app.pids[0]), 10_000, 'the host process did not end');
      } finally {
        await within(
          browser.close().catch(() => undefined),
          20_000,
          'close() did not return',
        );
      }
      assert.equal(app.closes, 1);
      const next = await launchChromium(hook);
      try {
        assert.equal(app.calls.length, 2);
        assert.equal(await (await next.newPage()).evaluate(() => 1 + 1), 2);
      } finally {
        await within(next.close(), 20_000, 'close() did not return');
      }
      assert.equal(app.closes, 2);
      await sleep(50);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
}

/** A hook that starts nothing: it hands `wsEndpoint` back and counts the close() calls. */
function fakeServer(wsEndpoint: string, close: () => Promise<void> = async () => undefined) {
  const fake = {
    closes: 0,
    hook: async (): Promise<BrowserServer> => ({
      wsEndpoint,
      exited: new Promise(() => undefined),
      close: () => {
        fake.closes++;
        return close();
      },
    }),
  };
  return fake;
}

test('the launch refuses a browserServer endpoint that is not a Unix socket, and closes it', async () => {
  // A host that calls launchServer() without a socket `port` listens on loopback TCP, which any local process can drive.
  const listener = net.createServer();
  let connections = 0;
  listener.on('connection', (socket) => {
    connections++;
    socket.destroy();
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try {
    const { port } = listener.address() as net.AddressInfo;
    const fake = fakeServer(`ws://127.0.0.1:${port}/x`);
    await assert.rejects(launchChromium(fake.hook), (e: Error) => {
      assert.match(e.message, /Unix socket/);
      assert.doesNotMatch(e.message, /npm run setup/);
      return true;
    });
    assert.equal(fake.closes, 1);
    await sleep(100);
    assert.equal(connections, 0);
  } finally {
    listener.close();
  }
});

test('the launch fails, and closes the host process, when its endpoint cannot be reached', async () => {
  const fake = fakeServer('ws+unix:/nonexistent-cadence/s.sock:/x');
  await assert.rejects(launchChromium(fake.hook));
  assert.equal(fake.closes, 1);
});

test('a host close() that never settles holds a failed launch 11 s at most', { timeout: 30_000 }, async () => {
  // Past that, the process and its folder are the host's to end: a launch, a render or server.close() never hangs on it.
  const fake = fakeServer('ws+unix:/nonexistent-cadence/s.sock:/x', () => new Promise(() => undefined));
  await within(assert.rejects(launchChromium(fake.hook)), 15_000, 'the launch did not fail');
  assert.equal(fake.closes, 1);
});

test('serveChromium() listens on a Unix socket in a 0700 folder, and close() closes it and removes the folder', async (t) => {
  // No Chromium: launchServer is mocked, so this also runs where Chromium is missing.
  const closed: string[] = [];
  let dir = '';
  t.mock.method(chromium, 'launchServer', async (options: { port: string }) => {
    dir = path.dirname(options.port);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    return { wsEndpoint: () => `${options.port}/abc`, close: async () => void closed.push(dir) };
  });
  const served = await serveChromium({ args: ['--mute-audio'] });
  assert.equal(served.dir, dir);
  assert.equal(served.wsEndpoint, `ws+unix:${path.join(dir, 's.sock')}:/abc`);
  await served.close();
  assert.deepEqual(closed, [dir]);
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

test('serveChromium() refuses an endpoint off its socket, closes that server and removes the folder', async (t) => {
  const closed: string[] = [];
  let dir = '';
  t.mock.method(chromium, 'launchServer', async (options: { port: string }) => {
    dir = path.dirname(options.port);
    return { wsEndpoint: () => 'ws://127.0.0.1:9/abc', close: async () => void closed.push(dir) };
  });
  await assert.rejects(serveChromium({}), /did not listen on its Unix socket/);
  assert.ok(dir, 'launchServer was not called');
  assert.deepEqual(closed, [dir]);
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

test(
  "a page that logs more than a string can hold ends the host app's process, not the server, and browserServer starts the next",
  { timeout: 60_000 },
  async (t) => {
    if (!installed) return chromiumMissing(t);
    const app = hostApp();
    const browser = await launchChromium(app.hook);
    const lost = new Promise((resolve) => browser.once('disconnected', resolve));
    try {
      const page = await browser.newPage();
      await page
        .setContent(`<script>const big = 'x'.repeat(300_000_000); console.log(big, big);</script>`)
        .catch(() => undefined);
      await within(lost, 30_000, 'no disconnect');
      await assert.rejects(
        page.evaluate(() => 1),
        /closed|disconnected/,
      );
    } finally {
      await within(
        browser.close().catch(() => undefined),
        20_000,
        'close() did not return',
      );
    }
    assert.equal(app.closes, 1);
    assert.equal(alive(app.pids[0]), false);
    await assert.rejects(stat(app.dirs[0]), { code: 'ENOENT' });
    const next = await launchChromium(app.hook);
    try {
      assert.equal(app.calls.length, 2);
      assert.equal(await (await next.newPage()).evaluate(() => 1 + 1), 2);
    } finally {
      await within(next.close(), 20_000, 'close() did not return');
    }
  },
);

describe('startServer({ browserServer })', () => {
  const app = hostApp();
  const tile = PNG.sync.write(new PNG({ width: 4, height: 4 }));
  let root: TestRoot;
  let server: RunningServer | undefined;
  let projectId: string;

  before(async () => {
    // Own dependency cache: test files run in parallel and must not disturb a running Cadence.
    process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/browser-host');
    root = await makeRoot();
    const { projectsDir, brandsDir, templatesDir, stateDir } = root.config;
    server = await startServer({
      projectsDir,
      brandsDir,
      templatesDir,
      stateDir,
      editorPort: 0,
      framePort: 0,
      quiet: true,
      provider: {
        id: 'fake',
        label: 'Agent de test',
        status: async () => ({ ok: true, label: 'Agent de test' }),
        async *run() {
          yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
        },
      },
      browserServer: app.hook,
    });
    projectId = (await server.services.store.create({ name: 'Host', brand: 'cadence', formats: ['16:9'], fps: 30 })).id;
  });

  after(async () => {
    if (server) await within(server.close(), 30_000, 'server.close() did not return');
    await root?.cleanup();
  });

  /** Ends the host processes still up, so that the next capture launches: each one lost is closed once. */
  async function dropBrowser(): Promise<void> {
    for (const pid of app.pids.filter(alive)) process.kill(pid, 'SIGKILL');
    await until(() => app.closes === app.pids.length, 10_000, 'the browser was not dropped');
  }

  test('captures launch through browserServer, and again once the host process is gone', { timeout: 60_000 }, async (t) => {
    if (!installed) return chromiumMissing(t);
    await dropBrowser();
    const before = await hostPids();
    const calls = app.calls.length;
    const pids = app.pids.length;
    const { capture } = server!.services;
    await capture.contactSheet([tile], { columns: 1, gap: 0 });
    await capture.contactSheet([tile], { columns: 1, gap: 0 });
    assert.equal(app.calls.length, calls + 1);
    assert.deepEqual(await hostPids(), before);
    process.kill(app.pids[pids], 'SIGKILL');
    await until(() => app.closes === app.pids.length, 10_000, 'the browser was not dropped');
    assert.ok((await capture.contactSheet([tile], { columns: 1, gap: 0 })).length > 0);
    assert.equal(app.calls.length, calls + 2);
  });

  test('a launch the host app refuses fails each capture with its text, and the next capture asks again', async (t) => {
    await dropBrowser();
    const { capture } = server!.services;
    const calls = app.calls.length;
    app.refuse = 'the host app refused this launch';
    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(capture.contactSheet([tile], { columns: 1, gap: 0 }), (e: Error) => {
          assert.match(e.message, /the host app refused this launch/);
          // `npm run setup` installs the core's Chromium, which a host app's process does not use.
          assert.doesNotMatch(e.message, /npm run setup/);
          return true;
        });
      }
      assert.equal(app.calls.length, calls + 2);
    } finally {
      app.refuse = undefined;
    }
    if (!installed) return chromiumMissing(t);
    assert.ok((await capture.contactSheet([tile], { columns: 1, gap: 0 })).length > 0);
    assert.equal(app.calls.length, calls + 3);
  });

  test('a render launches its Chromium through browserServer', async () => {
    // A refusal is enough to see the render go through the hook: no Chromium, no ffmpeg.
    const { renders } = server!.services;
    const calls = app.calls.length;
    app.refuse = 'the host app refused this launch';
    try {
      const [queued] = await renders.start(projectId, { formats: ['16:9'], quality: 'draft', range: { from: 0, to: 0.5 } });
      const job = await renders.wait(queued.id);
      assert.equal(job.status, 'error');
      assert.match(job.error ?? '', /the host app refused this launch/);
      assert.equal(app.calls.length, calls + 1);
    } finally {
      app.refuse = undefined;
    }
  });

  test("closing the server closes the host app's process", async (t) => {
    if (!installed) return chromiumMissing(t);
    await dropBrowser();
    const pids = app.pids.length;
    await server!.services.capture.contactSheet([tile], { columns: 1, gap: 0 });
    assert.equal(app.pids.length, pids + 1);
    const pid = app.pids[pids];
    assert.ok(alive(pid));
    const closes = app.closes;
    await within(server!.close(), 30_000, 'server.close() did not return');
    server = undefined;
    assert.equal(app.closes, closes + 1);
    assert.equal(alive(pid), false);
  });
});
