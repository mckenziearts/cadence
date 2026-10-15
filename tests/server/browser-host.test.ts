// Capture and render Chromium runs in a child process (server/capture/browser-host.ts): its lifecycle, its transport, and
// what a page that logs too much does to it. No frame harness, so these run in CI.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { before, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { launchChromium } from '../../server/capture/capture';

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

/** `promise`, or a failure after `ms`: an endless wait would skip the cleanup that closes the browser, and the file would never end. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, sleep(ms, undefined, { ref: false }).then(() => assert.fail(`${what} within ${ms} ms`))]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  // Electron's RunAsNode fuse, which ELECTRON_RUN_AS_NODE needs, is often off in a packaged app: the forked binary would
  // start the app instead of this script. The host names the Node binary, so a missing one fails in development too.
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
    await assert.rejects(launch, /CADENCE_NODE_PATH/);
    assert.deepEqual(await hostPids(), before);
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

test("the child process runs under CADENCE_NODE_PATH as Node, without the server's own flags", async (t) => {
  if (!installed) return chromiumMissing(t);
  // An Electron host with its RunAsNode fuse off cannot fork itself as Node: it names a Node binary instead.
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
    assert.equal(runAsNode, '1');
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
