// Chromium keeps its sandbox: Playwright adds --no-sandbox unless told otherwise, CADENCE_CHROMIUM_SANDBOX=0 opts out.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { launchChromium } from '../../server/capture/capture';
import { checkChromium } from '../../server/doctor';
import { m } from '../../server/i18n';

const run = promisify(execFile);
const initial = process.env.CADENCE_CHROMIUM_SANDBOX;

afterEach(() => {
  if (initial === undefined) delete process.env.CADENCE_CHROMIUM_SANDBOX;
  else process.env.CADENCE_CHROMIUM_SANDBOX = initial;
});

/** A launched browser, or null when Chromium is not installed. Any other launch error fails the test. */
async function launch(): Promise<Browser | null> {
  try {
    return await launchChromium();
  } catch (e) {
    if (/Executable doesn't exist/i.test((e as Error).message)) return null;
    throw e;
  }
}

/** The command line of the browser process itself, read from the system. */
async function commandLine(browser: Browser): Promise<string> {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  const pid = processInfo.find((info) => info.type === 'browser')!.id;
  return (await run('ps', ['-ww', '-o', 'command=', '-p', String(pid)])).stdout;
}

/** Skips a test that needs Chromium, except in CI, where the workflow installs it and a skip would hide the check. */
function chromiumMissing(t: TestContext): void {
  assert.ok(!process.env.CI, 'Chromium missing in CI: the workflow must run npm run setup');
  t.skip('Chromium missing (npm run setup)');
}

async function launchedArguments(t: TestContext): Promise<string | null> {
  const browser = await launch();
  if (!browser) {
    chromiumMissing(t);
    return null;
  }
  try {
    return await commandLine(browser);
  } finally {
    await browser.close();
  }
}

test('Chromium starts with its sandbox', async (t) => {
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  const args = await launchedArguments(t);
  if (args === null) return;
  assert.ok(args.includes('--headless'), args);
  assert.ok(!args.includes('--no-sandbox'), args);
});

test('CADENCE_CHROMIUM_SANDBOX=0 starts Chromium without its sandbox', async (t) => {
  process.env.CADENCE_CHROMIUM_SANDBOX = '0';
  const args = await launchedArguments(t);
  if (args === null) return;
  assert.ok(args.includes('--no-sandbox'), args);
});

test('the doctor warns when the sandbox is off', async (t) => {
  process.env.CADENCE_CHROMIUM_SANDBOX = '0';
  const check = await checkChromium();
  if (check.label === m().media.doctor.chromiumMissing) return chromiumMissing(t);
  assert.equal(check.level, 'warn');
  assert.ok(check.label.includes('CADENCE_CHROMIUM_SANDBOX'), check.label);
});

test('the doctor is fine with the sandbox on', async (t) => {
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  const check = await checkChromium();
  if (check.label === m().media.doctor.chromiumMissing) return chromiumMissing(t);
  assert.equal(check.level, 'ok', check.label);
});

test('the doctor says how to fix a Chromium whose sandbox fails', async (t) => {
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  t.mock.method(chromium, 'launch', async () => {
    throw new Error('browserType.launch: Target page, context or browser has been closed\nChromium sandboxing failed!');
  });
  const check = await checkChromium();
  assert.equal(check.level, 'fail');
  assert.equal(check.fix, m().media.doctor.chromiumSandboxFix);
});

test('the doctor points to the system libraries when Chromium fails for another reason', async (t) => {
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  t.mock.method(chromium, 'launch', async () => {
    throw new Error('browserType.launch: error while loading shared libraries: libnss3.so');
  });
  const check = await checkChromium();
  assert.equal(check.level, 'fail');
  assert.equal(check.fix, process.platform === 'linux' ? m().media.doctor.chromiumLibraries : 'npm run setup');
});

test('the doctor launches Chromium with the sandbox setting', async (t) => {
  const seen: (boolean | undefined)[] = [];
  t.mock.method(chromium, 'launch', async (options?: { chromiumSandbox?: boolean }) => {
    seen.push(options?.chromiumSandbox);
    return { version: () => '1', close: async () => {} };
  });
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  await checkChromium();
  process.env.CADENCE_CHROMIUM_SANDBOX = '0';
  await checkChromium();
  assert.deepEqual(seen, [true, false]);
});

test('a capture whose Chromium sandbox fails says how to fix it', async (t) => {
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  t.mock.method(chromium, 'launch', async () => {
    throw new Error('browserType.launch: Target page, context or browser has been closed\nChromium sandboxing failed!');
  });
  await assert.rejects(launchChromium(), (e: Error) => {
    assert.ok(e.message.includes(m().media.doctor.chromiumSandboxFix), e.message);
    assert.ok(!e.message.includes('npm run setup'), e.message);
    return true;
  });
});

test('a capture whose Chromium fails for another reason points to npm run setup', async (t) => {
  delete process.env.CADENCE_CHROMIUM_SANDBOX;
  const error = 'browserType.launch: error while loading shared libraries: libnss3.so';
  t.mock.method(chromium, 'launch', async () => {
    throw new Error(error);
  });
  await assert.rejects(launchChromium(), (e: Error) => {
    assert.ok(e.message.includes('npm run setup'), e.message);
    assert.ok(e.message.includes(error), e.message);
    assert.ok(!e.message.includes(m().media.doctor.chromiumSandboxFix), e.message);
    return true;
  });
});
