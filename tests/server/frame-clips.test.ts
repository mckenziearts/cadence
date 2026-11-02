// How a seek learns that a <Clip> frame did not decode (src/frame/clips.ts decodeImages), in Chromium without the frame
// harness, so these run in CI: a missing or damaged frame would otherwise be captured blank.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Browser, Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { launchChromium } from '../../server/capture/capture';

let browser: Browser | undefined;
let page: Page;
let script: string;

before(async () => {
  const built = [
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(import.meta.dirname, '../../src/frame/clips.ts'), formats: ['iife'], name: 'cadenceClips' },
      },
    }),
  ].flat()[0] as Rolldown.RolldownOutput;
  script = built.output[0].code;
  try {
    browser = await launchChromium();
  } catch (e) {
    if (!/Executable doesn't exist/i.test((e as Error).message)) throw e;
    return;
  }
  page = await browser.newPage();
  await page.route('**/clips/**', (route) =>
    route.request().url().includes('/missing/')
      ? route.fulfill({ status: 404, body: 'Not found' })
      : route.fulfill({ status: 200, contentType: 'image/jpeg', body: 'not a jpeg' }),
  );
});

after(async () => {
  await browser?.close();
});

/** Skips a test that needs Chromium, except in CI, where the workflow installs it and a skip would hide the check. */
function needsChromium(t: TestContext): boolean {
  if (browser) return true;
  assert.ok(!process.env.CI, 'Chromium missing in CI: the workflow must run npm run setup');
  t.skip('Chromium missing (npm run setup)');
  return false;
}

const base = 'http://127.0.0.1:9/@fs/home/a/demo/clips';

async function decode(): Promise<string[]> {
  return page.evaluate(() =>
    (Reflect.get(window, 'cadenceClips') as typeof import('../../src/frame/clips')).decodeImages(
      document.images,
      new WeakMap(),
      Reflect.get(window, 'clipTexts') as { clipFrameFailed: (file: string, frame: string) => string },
    ),
  );
}

/** The fake texts go in as a script: tsx names the functions declared in an evaluate callback with a helper the page lacks. */
async function show(body: string): Promise<void> {
  await page.setContent(`<body style="margin:0">${body}</body>`);
  await page.addScriptTag({ content: script });
  await page.addScriptTag({ content: "window.clipTexts = { clipFrameFailed: (file, frame) => file + ' ' + frame };" });
}

test('reports a <Clip> frame that answers 404, naming the asset and the frame file', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  await show(`<img data-cadence-clip="loops/spin.gif" src="${base}/missing/000007.jpg">`);
  assert.deepEqual(await decode(), ['loops/spin.gif 000007.jpg']);
});

test('reports a <Clip> frame whose bytes are not a JPEG', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  await show(`<img data-cadence-clip="intro.mp4" src="${base}/intro-1a2b/000001.jpg">`);
  assert.deepEqual(await decode(), ['intro.mp4 000001.jpg']);
});

test('ignores a broken <img> that is no clip frame', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  await show(`<img src="${base}/missing/000001.jpg">`);
  assert.deepEqual(await decode(), []);
});

test('names only the <Clip> frame when a clip frame and a plain <img> both fail', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  await show(`<img src="${base}/missing/000001.jpg"><img data-cadence-clip="intro.mp4" src="${base}/missing/000003.jpg">`);
  assert.deepEqual(await decode(), ['intro.mp4 000003.jpg']);
});

test('reports a failed frame again at the next call, decoding it again', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  await show(`<img data-cadence-clip="loops/spin.gif" src="${base}/missing/000007.jpg">`);
  const runs = await page.evaluate(async () => {
    const { decodeImages } = Reflect.get(window, 'cadenceClips') as typeof import('../../src/frame/clips');
    const clipTexts = Reflect.get(window, 'clipTexts') as { clipFrameFailed: (file: string, frame: string) => string };
    const decoded = new WeakMap<HTMLImageElement, string>();
    const img = document.images[0];
    let count = 0;
    const decodeOnce = img.decode.bind(img);
    img.decode = () => {
      count++;
      return decodeOnce();
    };
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const before = count;
      const failed = await decodeImages(document.images, decoded, clipTexts);
      runs.push({ decodes: count - before, failed });
    }
    return runs;
  });
  assert.deepEqual(runs, [
    { decodes: 1, failed: ['loops/spin.gif 000007.jpg'] },
    { decodes: 1, failed: ['loops/spin.gif 000007.jpg'] },
  ]);
});

test('does not decode a frame again while its src stays the same', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  await show('<img data-cadence-clip="intro.mp4">');
  const counted = await page.evaluate(async () => {
    const { decodeImages } = Reflect.get(window, 'cadenceClips') as typeof import('../../src/frame/clips');
    const clipTexts = Reflect.get(window, 'clipTexts') as { clipFrameFailed: (file: string, frame: string) => string };
    const decoded = new WeakMap<HTMLImageElement, string>();
    const img = document.images[0];
    img.src = document.createElement('canvas').toDataURL('image/jpeg');
    let count = 0;
    const decodeOnce = img.decode.bind(img);
    img.decode = () => {
      count++;
      return decodeOnce();
    };
    const runs = [];
    for (const src of [img.src, img.src, document.createElement('canvas').toDataURL('image/png')]) {
      img.src = src;
      const before = count;
      const failed = await decodeImages(document.images, decoded, clipTexts);
      runs.push({ decodes: count - before, failed });
    }
    return runs;
  });
  assert.deepEqual(counted, [
    { decodes: 1, failed: [] },
    { decodes: 0, failed: [] },
    { decodes: 1, failed: [] },
  ]);
});
