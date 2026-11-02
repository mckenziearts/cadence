// <Lottie> in the capture Chromium, without the frame harness, so these run in CI (test:unit, Linux): the frame shown
// at a time, players created and destroyed, and the errors a scene shows. tests/e2e plays one through the capture path.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Browser, Page } from 'playwright';
import { PNG } from 'pngjs';
import { build, type Rolldown } from 'vite';
import { launchChromium } from '../../server/capture/capture';
import { loadConfig } from '../../server/config';
import { frameCsp } from '../../server/frames/frameServer';

type Runtime = typeof import('../fixtures/lottie/entry');

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
        lib: { entry: path.join(import.meta.dirname, '../fixtures/lottie/entry.tsx'), formats: ['iife'], name: 'cadenceLottie' },
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

/** A page in `lang` with the fixture loaded, closed when the test ends. */
async function open(t: TestContext, lang = 'fr'): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
  t.after(() => page.close());
  await page.setContent(`<html lang="${lang}"><body style="margin:0"></body></html>`);
  await page.addScriptTag({ content: script });
  return page;
}

const round = (values: number[]) => values.map((value) => Math.round(value * 10) / 10);

const still = (k: unknown) => ({ a: 0, k });
/** An image layer showing asset `refId` with its top-left corner at (70, 70). */
const imageLayer = (ind: number, refId: string) => ({
  ...{ ddd: 0, ind, ty: 2, nm: refId, refId, sr: 1, ip: 0, op: 200, st: 0, bm: 0 },
  ks: { o: still(100), r: still(0), p: still([80, 80, 0]), a: still([10, 10, 0]), s: still([100, 100, 100]) },
});

test('shows frame ip + time * fr, holding the first and last frames, or wrapping with loop', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const shown = await page.evaluate(() => {
    const { show, boxX, move } = Reflect.get(window, 'cadenceLottie') as Runtime;
    // The box's x is the frame number: it starts at 10 in this copy.
    const late = { ...move, ip: 10, op: 110 };
    const cases = {
      times: [0, 0.2, 0.455, 0.6].map((time) => ({ time })),
      late: [0, 0.2].map((time) => ({ data: late, time })),
      held: [-1, 0.99, 1, 1.5].map((time) => ({ time })),
      looped: [1.25, -0.25, 2].map((time) => ({ time, loop: true })),
    };
    return Object.fromEntries(
      Object.entries(cases).map(([name, list]) => [
        name,
        list.map((props) => {
          const errors = show(props);
          if (errors.length) throw new Error(errors.join('\n'));
          return boxX();
        }),
      ]),
    ) as Record<keyof typeof cases, number[]>;
  });
  assert.deepEqual(
    { times: round(shown.times), late: round(shown.late), held: round(shown.held), looped: round(shown.looped) },
    { times: [0, 20, 45.5, 60], late: [10, 30], held: [0, 99, 99, 99], looped: [25, 75, 0] },
  );
});

test('a time that lands a hair before a frame in floating point shows that frame', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const shown = await page.evaluate(() => {
    const { show, flagShown } = Reflect.get(window, 'cadenceLottie') as Runtime;
    // 0.29 * 100 is 28.999999999999996: the flag layer is in from frame 29.
    return [0.28, 0.29].map((time) => (show({ time }), flagShown()));
  });
  assert.deepEqual(shown, [false, true]);
});

test(
  'one player per mount, a new one for new data, none after unmount; the data stays as imported',
  { timeout: 30_000 },
  async (t) => {
    if (!needsChromium(t)) return;
    const page = await open(t);
    const seen = await page.evaluate(() => {
      const { show, boxX, players, move } = Reflect.get(window, 'cadenceLottie') as Runtime;
      const before = JSON.stringify(move);
      const late = { ...move, ip: 10, op: 110 };
      const steps = [];
      for (const props of [{ time: 0.2 }, { time: 0.6 }, { data: late, time: 0.2 }, { data: late, time: 0.4 }]) {
        show(props);
        steps.push({ ...players(), x: Math.round(boxX()) });
      }
      show(null);
      return { steps, unmounted: players(), untouched: JSON.stringify(move) === before };
    });
    assert.deepEqual(seen, {
      steps: [
        { animations: 1, svgs: 1, x: 20 },
        { animations: 1, svgs: 1, x: 60 },
        { animations: 1, svgs: 1, x: 30 },
        { animations: 1, svgs: 1, x: 50 },
      ],
      unmounted: { animations: 0, svgs: 0 },
      untouched: true,
    });
  },
);

test('fit sets how the animation fills a box of another shape', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const fits = await page.evaluate(() => {
    const { show, aspect } = Reflect.get(window, 'cadenceLottie') as Runtime;
    return [undefined, 'cover', 'fill', 'contain'].map((fit) => (show(fit ? { fit: fit as 'cover' } : {}), aspect()));
  });
  assert.deepEqual(fits, ['xMidYMid meet', 'xMidYMid slice', 'none', 'xMidYMid meet']);
});

test('without a size, the animation takes the width it is given and its own aspect ratio', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const size = await page.evaluate(() => {
    const { show, move } = Reflect.get(window, 'cadenceLottie') as Runtime;
    show({ data: { ...move, w: 200, h: 100 }, style: {} });
    const { width, height } = document.querySelector('body > div > div')!.getBoundingClientRect();
    return [width, height];
  });
  assert.deepEqual(size, [200, 100]);
});

test('an animation a scene cannot play says why, in the page language', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  for (const lang of ['fr', 'en']) {
    const page = await open(t, lang);
    const errors = await page.evaluate(() => {
      const { show, move } = Reflect.get(window, 'cadenceLottie') as Runtime;
      return [
        show({ data: { ...move, assets: [{ id: 'img_0', u: 'images/', p: 'img_0.png' }] } }),
        show({
          data: { ...move, fonts: { list: [{ fName: 'Inter', fFamily: 'Inter', fPath: 'https://fonts.test/inter.css' }] } },
        }),
        show({ data: { ...move, assets: [{ id: 'data_0', t: 3, u: '', p: 'data.json' }] } }),
        show({ data: { ...move, layers: undefined } }),
        show({ data: [] }),
        show({ time: Number.NaN }),
      ].map((messages) => messages.join('\n'));
    });
    const [image, font, file, header, array, time] = errors;
    assert.match(image, lang === 'fr' ? /image externe \(img_0\.png\)/ : /external image \(img_0\.png\)/);
    assert.match(
      font,
      lang === 'fr' ? /police externe \(https:\/\/fonts\.test\/inter\.css\)/ : /external font \(https:\/\/fonts\.test/,
    );
    assert.match(file, lang === 'fr' ? /autre fichier \(data\.json\)/ : /another file \(data\.json\)/);
    assert.match(header, lang === 'fr' ? /pas une animation Lottie/ : /not a Lottie animation/);
    assert.match(array, lang === 'fr' ? /pas une animation Lottie/ : /not a Lottie animation/);
    assert.match(time, /<Lottie> time must be a finite number of seconds, got NaN/);
  }
});

test(
  'an animation that would load a file builds no player, draws no image and sends no request',
  { timeout: 30_000 },
  async (t) => {
    if (!needsChromium(t)) return;
    const page = await open(t);
    const requests: string[] = [];
    await page.route('**/*', (route) => (requests.push(route.request().url()), route.abort()));
    const layers = { precomp: imageLayer(3, 'comp_0'), first: imageLayer(3, 'img_0'), second: imageLayer(4, 'img_0') };
    const seen = await page.evaluate((layers) => {
      const { show, players, move } = Reflect.get(window, 'cadenceLottie') as Runtime;
      const embedded = 'data:image/png;base64,iVBORw0KGgo=';
      // A JSON import may set a prototype (a "__proto__" key in Vite's object literal): lottie-web gets a clone without it.
      const inherited = Object.setPrototypeOf({ id: 'img_0', u: 'https://x.test/', p: embedded }, { e: 1 });
      const slot = { p: { p: 'https://x.test/slot.png', e: 1 } };
      return [
        { ...move, assets: [{ id: 'img_0', w: 10, h: 10, u: 'https://x.test/pless' }] },
        { ...move, assets: [{ id: 'data_0', t: 3, u: 'https://x.test/', p: 'data.json' }] },
        { ...move, assets: [{ id: 'img_0', u: '', p: embedded, e: 1, sid: 'logo' }], slots: { logo: slot } },
        { ...move, segments: [{ time: 1 }] },
        { ...move, assets: [inherited] },
        { ...move, op: move.ip },
        // lottie-web gives an image layer the first asset of its refId, a precomp holding a path too.
        {
          ...move,
          assets: [{ id: 'comp_0', layers: [], p: 'https://x.test/precomp.png', e: 1 }],
          layers: [...move.layers, layers.precomp],
        },
        // lottie-web assigns the slot onto the asset at each image layer: the second one reads the sid the first set.
        {
          ...move,
          assets: [{ id: 'img_0', u: '', p: embedded, e: 1, sid: 'logo' }],
          slots: { logo: { p: { sid: 'next' } }, next: { p: { p: 'https://x.test/chain.png', e: 1 } } },
          layers: [...move.layers, layers.first, layers.second],
        },
        // An own "__proto__" key, as JSON.parse makes it: Object.assign sets the asset's prototype, where u is found.
        {
          ...move,
          assets: [{ id: 'img_0', p: embedded, sid: 'logo' }],
          slots: JSON.parse('{"logo":{"p":{"__proto__":{"u":"https://x.test/"}}}}') as object,
          layers: [...move.layers, layers.first],
        },
      ].map((data) => ({ errors: show({ data }).join('\n'), ...players(), images: document.querySelectorAll('image').length }));
    }, layers);
    assert.deepEqual(
      seen.map(({ animations, svgs, images }) => ({ animations, svgs, images })),
      seen.map(() => ({ animations: 0, svgs: 0, images: 0 })),
    );
    const expected = [
      /image externe \(https:\/\/x\.test\/pless\)/,
      /autre fichier \(data\.json\)/,
      /image externe \(https:\/\/x\.test\/slot\.png\)/,
      /autre fichier \(segments\)/,
      /image externe \(https:\/\/x\.test\/\)/,
      /pas une animation Lottie/,
      /image externe \(https:\/\/x\.test\/precomp\.png\)/,
      /autre fichier \(slots\.logo\)/,
      /autre fichier \(slots\.logo\)/,
    ];
    seen.forEach(({ errors }, i) => assert.match(errors, expected[i]));
    // A request the page sends last: any load the animations started has reached the route before it.
    await page.evaluate(() => fetch('https://sentinel.test/').catch(() => undefined));
    assert.deepEqual(requests, ['https://sentinel.test/']);
  },
);

test('a new time only seeks the player; new data or another fit builds a new one', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await open(t);
  const kept = await page.evaluate(() => {
    const { show, boxX, move } = Reflect.get(window, 'cadenceLottie') as Runtime;
    show({ time: 0.2 });
    const first = document.querySelector('svg');
    show({ time: 0.6 });
    const seeked = document.querySelector('svg') === first;
    show({ time: 0.6, fit: 'cover' });
    const refit = document.querySelector('svg');
    // A new player starts at its first frame: it is sought to the time as well.
    const refitX = Math.round(boxX());
    show({ data: { ...move }, time: 0.6, fit: 'cover' });
    const renewedX = Math.round(boxX());
    return { seeked, refit: refit !== first, renewed: document.querySelector('svg') !== refit, refitX, renewedX };
  });
  assert.deepEqual(kept, { seeked: true, refit: true, renewed: true, refitX: 60, renewedX: 60 });
});

test('builds, seeks and draws an embedded image under the frame CSP, with no violation', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const page = await browser!.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
  t.after(() => page.close());
  // The fixture is served from the page's own origin: the frame CSP refuses an inline script.
  await page.route('http://frame.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('/lottie.js')
        ? { contentType: 'text/javascript', body: script }
        : {
            contentType: 'text/html',
            headers: { 'Content-Security-Policy': frameCsp(loadConfig()) },
            body: '<html lang="fr"><body style="margin:0"><script src="/lottie.js"></script></body></html>',
          },
    ),
  );
  await page.addInitScript(
    "window.violations = []; document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));",
  );
  await page.goto('http://frame.test/');
  const move = JSON.parse(await readFile(new URL('../fixtures/lottie/move.json', import.meta.url), 'utf8'));
  const blue = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#00f"/></svg>';
  move.assets = [{ id: 'logo', w: 20, h: 20, u: '', p: `data:image/svg+xml,${encodeURIComponent(blue)}`, e: 1 }];
  move.layers.push(imageLayer(3, 'logo'));
  const drawn = await page.evaluate((data) => {
    const { show, boxX } = Reflect.get(window, 'cadenceLottie') as Runtime;
    const errors = show({ data, time: 0.2 });
    return { errors, x: Math.round(boxX()), image: document.querySelector('image')?.getAttribute('href')?.slice(0, 19) };
  }, move);
  assert.deepEqual(drawn, { errors: [], x: 20, image: 'data:image/svg+xml,' });
  await page.evaluate(() => (document.querySelector('image') as SVGImageElement & { decode(): Promise<void> }).decode());
  const shot = PNG.sync.read(await page.screenshot({ clip: { x: 80, y: 80, width: 1, height: 1 } }));
  assert.deepEqual([...shot.data.subarray(0, 3)], [0, 0, 255]);
  // A load the CSP refuses shows the listener hears violations: it is then the only one.
  await page.evaluate(() => (new Image().src = 'https://x.test/a.png'));
  await page.waitForFunction(() => Reflect.get(window, 'violations').length > 0);
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'violations')), ['img-src https://x.test/a.png']);
});
