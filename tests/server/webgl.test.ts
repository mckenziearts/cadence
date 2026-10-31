// GLCanvas and ThreeCanvas in the capture Chromium, without the frame harness, so these run in CI (test:unit, Linux):
// what a capture at t shows, after seeks, resizes, unmounts and lost contexts. tests/e2e draws real scenes through the
// capture path.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Browser, Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { launchChromium } from '../../server/capture/capture';

type Runtime = typeof import('../fixtures/webgl/entry');

let browser: Browser | undefined;
let script: string;

before(async () => {
  const built = [
    await build({
      configFile: false,
      logLevel: 'silent',
      // Library mode leaves process.env in place for the app that bundles it: React reads NODE_ENV.
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(import.meta.dirname, '../fixtures/webgl/entry.tsx'), formats: ['iife'], name: 'cadenceGL' },
      },
    }),
  ].flat()[0] as Rolldown.RolldownOutput;
  script = built.output[0].code;
  try {
    browser = await launchChromium();
  } catch (e) {
    if (!/Executable doesn't exist/i.test((e as Error).message)) throw e;
  }
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

/** A page in `lang` at a pixel ratio of 1 with the fixture loaded, closed when the test ends. */
async function open(t: TestContext, lang = 'fr'): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
  t.after(() => page.close());
  await page.setContent(`<html lang="${lang}"><body style="margin:0"></body></html>`);
  await page.addScriptTag({ content: script });
  return page;
}

const near = (actual: number[], expected: number[]) => actual.every((v, i) => Math.abs(v - expected[i]) <= 2);

test('GLCanvas calls draw synchronously at every render with its t', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const drawn = await page.evaluate(() => {
    const { show, glCanvas, pixel } = Reflect.get(window, 'cadenceGL') as Runtime;
    const draws: number[] = [];
    const pixels: number[][] = [];
    for (const at of [0.2, 0.6]) {
      show(
        glCanvas(at, (gl, drawnAt) => {
          gl.clearColor(drawnAt, 0, 1 - drawnAt, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          draws.push(drawnAt);
        }),
      );
      pixels.push(pixel(4, 4));
    }
    return { draws, pixels };
  });
  assert.deepEqual(drawn, {
    draws: [0.2, 0.6],
    pixels: [
      [51, 0, 204, 255],
      [153, 0, 102, 255],
    ],
  });
});

test('GLCanvas clears to transparent before draw, whatever state the last draw left', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  for (const leftover of ['scissor', 'colorMask', 'rasterizerDiscard', 'framebuffer', 'drawBuffers'] as const) {
    const seen = await page.evaluate((name) => {
      const { show, glCanvas, pixel, paint, leftovers } = Reflect.get(window, 'cadenceGL') as Runtime;
      show(
        glCanvas(0, (gl) => {
          paint(gl, [1, 0, 0, 1]);
          leftovers[name](gl);
        }),
      );
      show(glCanvas(1, () => {}));
      return pixel(4, 4);
    }, leftover);
    assert.deepEqual(seen, [0, 0, 0, 0], leftover);
  }
  // Depth: what t = 0 drew nearer must not hide what t = 1 draws.
  for (const leftover of ['none', 'depthMask', 'clearDepth'] as const) {
    const seen = await page.evaluate((name) => {
      const { show, glCanvas, pixel, paint, leftovers } = Reflect.get(window, 'cadenceGL') as Runtime;
      show(
        glCanvas(0, (gl) => {
          paint(gl, [1, 0, 0, 1], -0.5);
          leftovers[name](gl);
        }),
      );
      show(glCanvas(1, (gl) => paint(gl, [0, 1, 0, 1])));
      return pixel(4, 4);
    }, leftover);
    assert.deepEqual(seen, [0, 255, 0, 255], leftover);
  }
});

test('GLCanvas sizes its buffer and sets the viewport to the whole of it after a resize', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const resized = await page.evaluate(() => {
    const { show, glCanvas, pixel, paint, bufferSize } = Reflect.get(window, 'cadenceGL') as Runtime;
    show(glCanvas(0, () => {}, 32));
    show(glCanvas(0, (gl) => paint(gl, [1, 0, 0, 1]), 64));
    return { size: bufferSize(), corner: pixel(60, 4) };
  });
  assert.deepEqual(resized, { size: [64, 64], corner: [255, 0, 0, 255] });
});

test('GLCanvas loses its context when it unmounts', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const lost = await page.evaluate(() => {
    const { show, glCanvas } = Reflect.get(window, 'cadenceGL') as Runtime;
    show(glCanvas(0, () => {}));
    const canvas = document.querySelector('canvas')!;
    show(null);
    return canvas.getContext('webgl2')!.isContextLost();
  });
  assert.equal(lost, true);
});

test('a context lost between two renders fails the render with a translated error', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  for (const [lang, component, message] of [
    ['fr', 'GLCanvas', /^Le contexte WebGL a été perdu : 16 contextes WebGL au plus/],
    ['en', 'GLCanvas', /^The WebGL context was lost: 16 WebGL contexts at most/],
    ['fr', 'ThreeCanvas', /^Le contexte WebGL a été perdu : 16 contextes WebGL au plus/],
  ] as const) {
    const page = await open(t, lang);
    const errors = await page.evaluate((three) => {
      const { show, glCanvas, threeCanvas, loseContext } = Reflect.get(window, 'cadenceGL') as Runtime;
      show(three ? threeCanvas(0) : glCanvas(0, () => {}));
      loseContext();
      return show(three ? threeCanvas(0.5) : glCanvas(0.5, () => {}));
    }, component === 'ThreeCanvas');
    assert.equal(errors.length, 1, `${component} ${lang}`);
    assert.match(errors[0], message);
  }
});

test('ThreeCanvas runs setup once and renders at each render with its t, no animation loop', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const rendered = await page.evaluate(async () => {
    const { show, threeCanvas, pixel, calls } = Reflect.get(window, 'cadenceGL') as Runtime;
    const pixels: number[][] = [];
    for (const at of [0.2, 0.6]) {
      show(threeCanvas(at));
      pixels.push(pixel(4, 4));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { calls: { ...calls }, pixels };
  });
  assert.deepEqual(rendered.calls, { setups: 1, renders: 2, disposals: 0 });
  assert.ok(near(rendered.pixels[0], [51, 0, 204, 255]), String(rendered.pixels[0]));
  assert.ok(near(rendered.pixels[1], [153, 0, 102, 255]), String(rendered.pixels[1]));
});

test('ThreeCanvas disposes of its renderer and loses its context when it unmounts', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const unmounted = await page.evaluate(() => {
    const { show, threeCanvas, calls } = Reflect.get(window, 'cadenceGL') as Runtime;
    show(threeCanvas(0));
    const canvas = document.querySelector('canvas')!;
    show(null);
    return { disposals: calls.disposals, lost: canvas.getContext('webgl2')!.isContextLost() };
  });
  assert.deepEqual(unmounted, { disposals: 1, lost: true });
});

test('ThreeCanvas draws on the whole buffer after a resize, with the same renderer', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const resized = await page.evaluate(() => {
    const { show, threeCanvas, pixel, bufferSize, calls } = Reflect.get(window, 'cadenceGL') as Runtime;
    show(threeCanvas(1, 32));
    show(threeCanvas(1, 64));
    return { size: bufferSize(), corner: pixel(60, 4), setups: calls.setups };
  });
  assert.deepEqual(resized, { size: [64, 64], corner: [255, 0, 0, 255], setups: 1 });
});
