// Frame origin + frame page in a real Chromium: guards, rendering at exact times, brand/fonts/assets, errors,
// reloads (scene, component, Tailwind class), text checks, CSP and the postMessage bridge.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { auditFrame, CHROMIUM_ARGS, PlaywrightCapture } from '../../server/capture/capture';
import type { AuditFinding, FrameRenderResult } from '../../src/shared/frameProtocol';
import type { ProjectFile } from '../../src/shared/types';
import { near, pixel, startHarness, type Harness } from './helpers/harness';

let h: Harness;
let browser: Browser;
let id: string;

before(async () => {
  h = await startHarness('frames');
  browser = await chromium.launch({ args: CHROMIUM_ARGS });
  id = await h.project('frames');
});

after(async () => {
  await browser?.close();
  await h?.close();
});

/** A frame page in capture mode at half resolution (pixel coordinates below are canvas px / 2). */
async function open(query: Record<string, string>, viewport = { width: 1920, height: 1080 }): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 0.5 });
  const page = await context.newPage();
  await page.goto(
    `${h.config.frameOrigin}/frame.html?${new URLSearchParams({ project: id, format: '16:9', mode: 'capture', ...query })}`,
  );
  await page.evaluate(() => window.__cadence!.ready);
  return page;
}

function seek(page: Page, t: number): Promise<FrameRenderResult> {
  return page.evaluate((time) => window.__cadence!.seek(time), t);
}

/** A scene time on the video timeline, rounded to the nanosecond like the frame: scene starts are not always binary fractions. */
const videoTime = (start: number, local: number) => Math.round((start + local) * 1e9) / 1e9;

async function colorAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return pixel(await page.screenshot({ type: 'png' }), x / 2, y / 2);
}

/** Bump the code generation like the file watcher would, then bring the frame to it. */
async function sync(page: Page): Promise<void> {
  assert.equal(await h.store.syncCode(id), true, 'the edit should change the code generation');
  await page.evaluate((g) => window.__cadence!.reload(g), h.store.generation(id));
  assert.equal(await page.evaluate(() => window.__cadence!.generation()), h.store.generation(id));
}

async function addScene(sceneId: string, code: string, duration = 1): Promise<void> {
  await writeFile(h.store.sceneFile(id, sceneId), code);
  const file = path.join(h.store.dir(id), 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
  project.scenes.push({ id: sceneId, name: sceneId, duration });
  await writeFile(file, JSON.stringify(project, null, 2));
}

function request(
  pathname: string,
  init: { method?: string; host?: string; origin?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.config.framePort,
        path: pathname,
        method: init.method ?? 'GET',
        headers: { host: init.host ?? `127.0.0.1:${h.config.framePort}`, ...(init.origin ? { origin: init.origin } : {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('frame origin', () => {
  it('only answers GET/HEAD for its own host and never serves the editor API', async () => {
    assert.equal((await request('/frame.html', { host: `evil.test:${h.config.framePort}` })).status, 403);
    assert.equal((await request('/frame.html', { method: 'POST' })).status, 405);
    for (const blocked of ['/', '/index.html', '/api/state', '/mcp', '/frame-api/nope', '/__open-in-editor?file=frame.html']) {
      assert.equal((await request(blocked)).status, 404, blocked);
    }
    assert.equal((await request(`/frame.html?project=${id}`, { host: `localhost:${h.config.framePort}` })).status, 200);
  });

  it('serves frame.html with the CSP and the editor origins', async () => {
    const res = await fetch(`${h.config.frameOrigin}/frame.html?project=${id}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /font-src 'self' data:/);
    assert.match(csp, new RegExp(`frame-ancestors ${h.config.editorOrigin} http://localhost:${h.config.editorPort}`));
    const html = await res.text();
    assert.match(
      html,
      new RegExp(`<meta name="cadence-editor-origin" content="${h.config.editorOrigin} http://localhost:${h.config.editorPort}"`),
    );
    assert.match(html, /\/src\/frame\/main\.tsx/);
  });

  it('puts the frame CSP on every response, not only on the pages', async () => {
    const csp = (await request(`/frame.html?project=${id}`)).headers['content-security-policy'];
    assert.ok(csp);
    for (const url of [
      `/frame-api/projects/${id}`,
      `/@fs${h.store.dir(id)}/assets/square.svg`,
      '/src/frame/main.tsx',
      `/@fs${h.config.root}/package.json`,
      '/api/state',
    ]) {
      assert.equal((await request(url)).headers['content-security-policy'], csp, url);
    }
  });

  it('gives the frame read-only project data and diagnostics', async () => {
    const res = await fetch(`${h.config.frameOrigin}/frame-api/projects/${id}`);
    const data = (await res.json()) as {
      project: { id: string; scenes: unknown[] };
      brand: { id: string };
      brandId: string;
      brandUrl: string;
    };
    assert.equal(data.project.id, id);
    assert.equal(data.project.scenes.length, 6);
    assert.equal(data.brandId, 'test');
    assert.equal(data.brand.id, 'test');
    assert.equal(data.brandUrl, `/@fs${h.brands.dir('test')}/`);
    assert.equal((await fetch(`${h.config.frameOrigin}/frame-api/projects/Nope!`)).status, 400);
    assert.equal((await fetch(`${h.config.frameOrigin}/frame-api/projects/e2e-missing`)).status, 404);
    const ok = await fetch(`${h.config.frameOrigin}/frame-api/projects/${id}/scenes/green/diagnostics`);
    assert.deepEqual(await ok.json(), { error: null });
  });

  it('keeps .cadence folders out of reach', async () => {
    const secret = path.join(h.store.dir(id), '.cadence', 'secret.json');
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, '{"token":"nope"}');
    const fromRoot = `/${path.relative(h.config.root, secret)}`;
    for (const url of [`/@fs${secret}`, fromRoot, `/@fs${secret}?import`, `/@fs${secret}?raw`, `${fromRoot}?url`]) {
      const res = await request(url);
      assert.notEqual(res.status, 200, url);
      assert.doesNotMatch(res.body, /nope/, url);
    }
  });

  it('serves what frames load (runtime, scenes, brands, packages) but not the app source or the root files', async () => {
    const root = h.config.root;
    for (const url of [
      `/@fs${root}/server/http.ts`,
      '/server/http.ts',
      `/@fs${root}/package.json`,
      '/tests/e2e/frames.test.ts',
    ]) {
      const res = await request(url);
      assert.notEqual(res.status, 200, url);
      assert.doesNotMatch(res.body, /X-Cadence-Token|"scripts"|serves what frames load/, url);
    }
    for (const url of [
      '/src/frame/main.tsx',
      `/@fs${h.store.sceneFile(id, 'blue')}`,
      `/@fs${h.brands.dir('test')}/index.tsx`,
      '/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
    ]) {
      assert.equal((await request(url)).status, 200, url);
    }
  });

  it('lets the editor load font files, and nothing else, for its brand panel', async () => {
    const font = '/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';
    const allowed = (await request(font, { origin: h.config.editorOrigin })).headers;
    assert.equal(allowed['access-control-allow-origin'], h.config.editorOrigin);
    assert.equal(allowed.vary, 'Origin');
    assert.equal((await request(font, { origin: 'http://evil.test' })).headers['access-control-allow-origin'], undefined);
    const script = await request('/src/frame/main.tsx', { origin: h.config.editorOrigin });
    assert.equal(script.status, 200);
    assert.equal(script.headers['access-control-allow-origin'], undefined);
  });
});

describe('frame page', () => {
  it('renders a scene at exact times with the documented props', async () => {
    const page = await open({ scene: 'red-blue' });
    assert.deepEqual(await seek(page, 0.25), { errors: [], sceneId: 'red-blue', localTime: 0.25 });
    assert.ok(near(await colorAt(page, 960, 540), [255, 0, 0]));
    await seek(page, 0.75);
    assert.ok(near(await colorAt(page, 960, 540), [0, 0, 255]));
    const props = JSON.parse((await page.getAttribute('#props', 'data-props'))!);
    assert.deepEqual(props, {
      t: 0.75,
      duration: 1,
      width: 1920,
      height: 1080,
      format: '16:9',
      orientation: 'landscape',
      fps: 30,
      scene: { id: 'red-blue', name: 'Rouge puis bleu', index: 0, count: 6, start: 0 },
    });
    assert.equal(await page.evaluate(() => window.__cadence!.duration()), 1);
    // Times are clamped to the scene.
    assert.equal((await seek(page, 5)).localTime, 1);
    await page.context().close();
  });

  it('lays the canvas out for the requested format', async () => {
    const page = await open({ scene: 'red-blue', format: '9:16' }, { width: 1080, height: 1920 });
    await seek(page, 0.2);
    let props = JSON.parse((await page.getAttribute('#props', 'data-props'))!);
    assert.deepEqual([props.width, props.height, props.format, props.orientation], [1080, 1920, '9:16', 'portrait']);
    assert.ok(near(await colorAt(page, 1070, 1910), [255, 0, 0]));
    await page.evaluate(() => window.__cadence!.setFormat('1:1'));
    props = JSON.parse((await page.getAttribute('#props', 'data-props'))!);
    assert.deepEqual([props.width, props.height, props.orientation], [1080, 1080, 'square']);
    await page.context().close();
  });

  it('fits and centers the canvas in editor mode', async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await context.newPage();
    await page.goto(`${h.config.frameOrigin}/frame.html?project=${id}&scene=red-blue&format=9:16&mode=editor`);
    await page.evaluate(() => window.__cadence!.ready);
    const rect = await page.evaluate(() => {
      const r = document.querySelector('[data-cadence-stage]')!.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map(Math.round);
    });
    // 1080 × 1920 scaled by 540 / 1920, centered horizontally.
    assert.deepEqual(rect, [328, 0, 304, 540]);
    await context.close();
  });

  it('picks the scene by video time in whole-video mode', async () => {
    const page = await open({});
    assert.equal(await page.evaluate(() => window.__cadence!.duration()), 5);
    assert.deepEqual(await seek(page, 1.25), { errors: [], sceneId: 'blue', localTime: 0.25 });
    // A frame exactly on a cut belongs to the next scene.
    assert.deepEqual(await seek(page, 1.5), { errors: [], sceneId: 'green', localTime: 0 });
    assert.ok(near(await colorAt(page, 960, 540), [0, 255, 0]));
    const end = await seek(page, 99);
    assert.deepEqual([end.sceneId, end.localTime], ['throws', 1]);
    await page.context().close();
  });

  it('renders the brand kit, waits for brand fonts and resolves project assets', async () => {
    const page = await open({ scene: 'brand' });
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 100, 100), [0, 200, 255]), 'asset() image');
    assert.ok(near(await colorAt(page, 1800, 1000), [124, 58, 237]), 'brand primary background');
    assert.ok(near(await colorAt(page, 640, 440), [255, 255, 255]), 'kit Card surface');
    assert.equal(await page.evaluate(() => document.fonts.check("700 32px 'Space Grotesk Variable'")), true);
    const theme = await page.evaluate(() => document.getElementById('cadence-brand')?.textContent ?? '');
    assert.match(theme, /--color-primary/);
    await page.context().close();
  });

  it('reports runtime errors and renders again once the scene stops throwing', async () => {
    const page = await open({ scene: 'throws' });
    assert.deepEqual((await seek(page, 0.25)).errors, []);
    const failed = await seek(page, 0.75);
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /Erreur d’exécution · scenes\/throws\.tsx/);
    assert.match(failed.errors[0], /Boum à 0\.75 s/);
    assert.deepEqual(await page.evaluate(() => window.__cadence!.errors()), failed.errors);
    assert.deepEqual((await seek(page, 0.25)).errors, []);
    assert.ok(near(await colorAt(page, 960, 540), [255, 255, 255]));
    await page.context().close();
  });

  it('reports compile errors with the compiler message and code frame, also from imported files', async () => {
    await addScene('broken', 'export default function Broken() {\n  return <div style={{ color: "red" }}>oops</span>;\n}\n');
    await mkdir(path.join(h.store.dir(id), 'components'), { recursive: true });
    await writeFile(path.join(h.store.dir(id), 'components', 'Bad.tsx'), 'export const Bad = () => <div>;\n');
    await addScene(
      'imports-bad',
      "import { Bad } from '../components/Bad';\nexport default function ImportsBad() {\n  return <Bad />;\n}\n",
    );
    await h.store.syncCode(id);

    const page = await open({ scene: 'broken' });
    const result = await seek(page, 0.1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Erreur de compilation · scenes\/broken\.tsx/);
    assert.match(result.errors[0], /oops<\/span>/, 'code frame');
    assert.doesNotMatch(result.errors[0], /Failed to fetch dynamically imported module/);

    await page.evaluate(() => window.__cadence!.setScene('imports-bad'));
    const transitive = await seek(page, 0.1);
    assert.match(transitive.errors[0], /Bad\.tsx/);

    const diagnostics = await fetch(`${h.config.frameOrigin}/frame-api/projects/${id}/scenes/imports-bad/diagnostics`);
    assert.match(((await diagnostics.json()) as { error: string }).error, /components\/Bad\.tsx/);
    await page.context().close();
  });

  it('reloads edited scenes and the components they import', async () => {
    await writeFile(path.join(h.store.dir(id), 'components', 'color.ts'), "export const COLOR = '#ff8800';\n");
    await addScene(
      'uses-color',
      "import { COLOR } from '../components/color';\nexport default function UsesColor() {\n  return <div style={{ position: 'absolute', inset: 0, background: COLOR }} />;\n}\n",
    );
    await h.store.syncCode(id);
    const page = await open({ scene: 'uses-color' });
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 960, 540), [255, 136, 0]));

    await writeFile(path.join(h.store.dir(id), 'components', 'color.ts'), "export const COLOR = '#008844';\n");
    await sync(page);
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 960, 540), [0, 136, 68]), 'component edit');

    await writeFile(
      h.store.sceneFile(id, 'uses-color'),
      "export default function UsesColor() {\n  return <div style={{ position: 'absolute', inset: 0, background: '#ff00ff' }} />;\n}\n",
    );
    await sync(page);
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 960, 540), [255, 0, 255]), 'scene edit');
    await page.context().close();
  });

  it('picks up a Tailwind class added to a scene', async () => {
    const page = await open({ scene: 'tailwind' });
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 960, 540), [124, 58, 237]), 'bg-primary from the brand theme');
    await writeFile(
      h.store.sceneFile(id, 'tailwind'),
      'export default function Tailwind() {\n  return <div className="absolute inset-0 bg-[#12ab34]" />;\n}\n',
    );
    await sync(page);
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 960, 540), [18, 171, 52]));
    await page.context().close();
  });
});

describe('scene sounds', () => {
  const draw = (color: string) =>
    `export default function Scene() {\n  return <div style={{ position: 'absolute', inset: 0, background: '${color}' }} />;\n}\n`;

  it('returns the cues of the shown scenes on the frame timeline, sorted, from a plain call with the props but t', async () => {
    await addScene('pad', `export const sounds = () => [{ at: 0.25, sound: 'pop' }];\n${draw('#000000')}`, 0.25);
    await addScene(
      'beats',
      "export function sounds(props) {\n  if ('t' in props) throw new Error('t in the props of sounds()');\n" +
        "  if (this !== undefined) throw new Error('sounds() called as a method');\n" +
        "  return [{ at: props.music.beat(1), sound: 'click' }, { at: props.music.beat(0), sound: 'whoosh', gain: 0.5 }];\n}\n" +
        draw('#ff8800'),
    );
    await h.store.syncCode(id);
    const start = (await h.store.get(id)).scenes.find((s) => s.id === 'beats')!.start;
    // Off the video's 120 BPM grid: without a track the runtime's beats start with the scene, not with the video.
    assert.equal(start % 0.5, 0.25, 'the scene starts between two video beats');
    const beats = [
      { at: 0, sound: 'whoosh', gain: 0.5 },
      { at: 0.5, sound: 'click', gain: 1 },
    ];

    const whole = await open({});
    assert.deepEqual(await whole.evaluate(() => window.__cadence!.sounds()), [
      { at: start, sound: 'pop', gain: 1 },
      ...beats.map((cue) => ({ ...cue, at: videoTime(start, cue.at) })),
    ]);
    await whole.context().close();

    // Scene seconds in scene mode, like render, seek and duration.
    const single = await open({ scene: 'beats' });
    assert.deepEqual(await single.evaluate(() => window.__cadence!.sounds()), beats);
    assert.deepEqual((await seek(single, 0.5)).errors, []);
    await single.context().close();
  });

  it('turns a sounds() that throws, is not a function or returns an invalid cue into a render error, and still draws', async () => {
    await addScene('sounds-throws', `export function sounds() {\n  throw new Error('Pas de son ici');\n}\n${draw('#00ff00')}`);
    await addScene('sounds-opaque', `export function sounds() {\n  throw Object.create(null);\n}\n${draw('#00ff00')}`);
    await addScene(
      'sounds-message',
      `export function sounds() {\n  const e = new Error();\n  delete e.stack;\n  Object.defineProperty(e, 'message', { value: Object.create(null) });\n  throw e;\n}\n${draw('#00ff00')}`,
    );
    await addScene('sounds-value', `export const sounds = 3;\n${draw('#00ff00')}`);
    await addScene(
      'sounds-invalid',
      `export const sounds = () => [{ at: 0.2, sound: 'click' }, { at: 0.4, sound: 'boing' }];\n${draw('#00ff00')}`,
    );
    await h.store.syncCode(id);
    for (const [scene, message] of [
      ['sounds-throws', /Pas de son ici/],
      ['sounds-opaque', /\nobject$/],
      ['sounds-message', /\nobject$/],
      ['sounds-value', /doit être une fonction \(props\) => SoundCue\[\]/],
      ['sounds-invalid', /son 1 : son inconnu "boing" \(click, key, pop, whoosh, impact\)/],
    ] as const) {
      const page = await open({ scene });
      const result = await seek(page, 0.5);
      assert.equal(result.errors.length, 1, scene);
      assert.match(result.errors[0], new RegExp(`Erreur dans sounds\\(\\) · scenes/${scene}\\.tsx`));
      assert.match(result.errors[0], message);
      assert.deepEqual(await page.evaluate(() => window.__cadence!.errors()), result.errors);
      assert.ok(near(await colorAt(page, 960, 540), [0, 255, 0]), `${scene} still draws`);
      assert.deepEqual(await page.evaluate(() => window.__cadence!.sounds()), []);
      await page.context().close();
    }
  });

  it('keeps the cues of the other scenes and reports a failing sounds() only inside its scene in whole-video mode', async () => {
    const { scenes } = await h.store.get(id);
    const startOf = (sceneId: string) => scenes.find((s) => s.id === sceneId)!.start;
    const page = await open({});
    assert.deepEqual(await page.evaluate(() => window.__cadence!.sounds()), [
      { at: videoTime(startOf('pad'), 0.25), sound: 'pop', gain: 1 },
      { at: startOf('beats'), sound: 'whoosh', gain: 0.5 },
      { at: videoTime(startOf('beats'), 0.5), sound: 'click', gain: 1 },
    ]);
    assert.deepEqual((await seek(page, startOf('beats') + 0.5)).errors, []);
    const failing = await seek(page, startOf('sounds-throws') + 0.5);
    assert.equal(failing.sceneId, 'sounds-throws');
    assert.equal(failing.errors.length, 1);
    assert.match(failing.errors[0], /^Erreur dans sounds\(\) · scenes\/sounds-throws\.tsx\n.*Pas de son ici/);
    await page.context().close();
  });

  it('adds no cues while the project fails to load, and gives them back once it loads', async () => {
    await addScene('sounds-offline', `export const sounds = () => [{ at: 0.5, sound: 'pop' }];\n${draw('#00ff00')}`);
    await h.store.syncCode(id);
    const page = await open({ scene: 'sounds-offline' });
    const cues = await page.evaluate(() => window.__cadence!.sounds());
    assert.deepEqual(cues, [{ at: 0.5, sound: 'pop', gain: 1 }]);
    const project = (url: URL) => url.pathname === `/frame-api/projects/${id}`;
    await page.route(project, (route) => route.fulfill({ status: 503, json: { error: 'serveur absent' } }));
    await page.evaluate(() => window.__cadence!.reload());
    const failed = await seek(page, 0.5);
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /Impossible de charger le projet .*serveur absent/);
    assert.deepEqual(await page.evaluate(() => window.__cadence!.sounds()), []);

    await page.unroute(project);
    await page.evaluate(() => window.__cadence!.reload());
    assert.deepEqual((await seek(page, 0.5)).errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cadence!.sounds()), cues);
    await page.context().close();
  });

  it('re-evaluates sounds() after a reload that only changed the scene duration', async () => {
    await addScene('sounds-duration', `export const sounds = () => [{ at: 0.5, sound: 'pop' }];\n${draw('#00ff00')}`);
    await h.store.syncCode(id);
    const page = await open({ scene: 'sounds-duration' });
    assert.deepEqual((await seek(page, 0.2)).errors, []);
    assert.equal((await page.evaluate(() => window.__cadence!.sounds())).length, 1);

    const generation = h.store.generation(id);
    const file = path.join(h.store.dir(id), 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
    project.scenes.find((s) => s.id === 'sounds-duration')!.duration = 0.4;
    await writeFile(file, JSON.stringify(project, null, 2));
    assert.equal(await h.store.syncCode(id), false, 'a duration change is no code change');
    await page.evaluate((g) => window.__cadence!.reload(g), generation);
    const result = await seek(page, 0.2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /son 0 : at doit être un nombre de secondes entre 0 et 0\.4/);
    assert.deepEqual(await page.evaluate(() => window.__cadence!.sounds()), []);
    await page.context().close();
  });

  it('does not keep the cues of an old module rendered while set-scene imports the new one', async () => {
    await addScene('sounds-stale', `export const sounds = () => [{ at: 0.25, sound: 'pop' }];\n${draw('#00ff00')}`);
    await addScene('sounds-other', draw('#0000ff'));
    await h.store.syncCode(id);
    const page = await open({ scene: 'sounds-stale' });
    assert.equal((await page.evaluate(() => window.__cadence!.sounds()))[0].sound, 'pop');
    await page.evaluate(() => window.__cadence!.setScene('sounds-other'));

    await writeFile(
      h.store.sceneFile(id, 'sounds-stale'),
      `export const sounds = () => [{ at: 0.5, sound: 'key' }];\n${draw('#00ff00')}`,
    );
    await sync(page);
    // The editor keeps sending render during playback, outside the queue that set-scene runs in.
    const cues = await page.evaluate(async () => {
      const api = window.__cadence!;
      let done = false;
      const switched = api.setScene('sounds-stale').then(() => (done = true));
      while (!done) {
        api.render(0);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await switched;
      return api.sounds();
    });
    assert.deepEqual(cues, [{ at: 0.5, sound: 'key', gain: 1 }]);
    await page.context().close();
  });

  it('does not remount a scene on every render when only its sounds() fails', async () => {
    await addScene(
      'sounds-mounts',
      "import { useState } from 'react';\nexport const sounds = 3;\nexport default function Scene() {\n" +
        '  useState(() => (window.mounts = (window.mounts ?? 0) + 1));\n' +
        "  return <div style={{ position: 'absolute', inset: 0, background: '#00ff00' }} />;\n}\n",
    );
    await h.store.syncCode(id);
    const page = await open({ scene: 'sounds-mounts' });
    for (const t of [0.1, 0.2, 0.3]) assert.equal((await seek(page, t)).errors.length, 1);
    assert.equal(await page.evaluate(() => (window as unknown as { mounts: number }).mounts), 1);
    await page.context().close();
  });

  it('adds no cues and no sounds() error for a scene that fails to compile', async () => {
    await addScene(
      'sounds-broken',
      "export const sounds = () => [{ at: 0.5, sound: 'pop' }];\nexport default function Broken() {\n  return <div>;\n}\n",
    );
    await h.store.syncCode(id);
    const page = await open({ scene: 'sounds-broken' });
    const result = await seek(page, 0.1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Erreur de compilation · scenes\/sounds-broken\.tsx/);
    assert.deepEqual(await page.evaluate(() => window.__cadence!.sounds()), []);
    await page.context().close();
  });
});

describe('text checks', () => {
  // Before 0.5 s: what the checks must catch, next to what they must leave alone (a clean heading, a faded label, text
  // on a gradient, a title in a tight reveal mask). After: the clean heading alone.
  const AUDIT_SCENE = `const at = (left, top, style) => ({ position: 'absolute', left, top, margin: 0, ...style });
export default function Audit({ t }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff', color: '#111111' }}>
      <h1 style={at(200, 200, { fontSize: 96 })}>Clean heading</h1>
      {t < 0.5 && (
        <>
          <div style={at(200, 450, { width: 300, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 40 })}>
            This sentence is far too long for its box, really
          </div>
          <h2 style={at(1600, 600, { fontSize: 80, whiteSpace: 'nowrap' })}>Half off canvas</h2>
          <div style={at(200, 750, { padding: 20, background: '#888888', color: '#999999', fontSize: 32 })}>Grey label</div>
          <div style={{ opacity: 0.5 }}>
            <p style={at(-100, 900, { fontSize: 40, color: '#eeeeee' })}>Fading in</p>
          </div>
          <div style={at(1000, 200, { padding: 20, backgroundImage: 'linear-gradient(#000000, #ffffff)', color: '#777777', fontSize: 20 })}>
            On a gradient
          </div>
          <div style={at(1000, 350, { overflow: 'hidden', lineHeight: 1, fontSize: 64 })}>Masked title</div>
          <p style={at(1000, 20, { fontSize: 14 })}>Small print</p>
        </>
      )}
    </div>
  );
}
`;

  const audit = (page: Page) => page.evaluate(() => window.__cadence!.audit());
  const kinds = (findings: AuditFinding[] | null) => findings?.map((f) => `${f.kind} ${f.text}`);

  before(async () => {
    await addScene('audit', AUDIT_SCENE);
    await h.store.syncCode(id);
  });

  it('reports clipped, off-canvas and low-contrast text, worst first, without touching the page', async () => {
    const page = await open({ scene: 'audit' });
    await seek(page, 0.25);
    const html = await page.content();
    const sheets = () => page.evaluate(() => document.adoptedStyleSheets.length);
    const adopted = await sheets();
    const findings = await audit(page);
    assert.deepEqual(kinds(findings), [
      'clipped This sentence is far too long for its bo',
      'offCanvas Half off canvas',
      'contrast Grey label',
    ]);
    const [, off, contrast] = findings;
    assert.equal(off.box.x, 1600);
    assert.ok(off.box.x + off.box.width > 1920, JSON.stringify(off.box));
    assert.equal(contrast.required, 3, '32 px is large text');
    assert.ok(contrast.ratio! > 1 && contrast.ratio! < 1.5, String(contrast.ratio));
    assert.equal(await page.content(), html, 'the checks read the page and never write it');
    assert.equal(await sheets(), adopted, 'their hit-test sheet is gone');

    await seek(page, 0.75);
    assert.deepEqual(await audit(page), [], 'a clean frame');
    await page.context().close();
  });

  it('flags large text in the safe margins and scene text under the captions', async () => {
    const projectFile = path.join(h.store.dir(id), 'project.json');
    const saved = await readFile(projectFile, 'utf8');
    await writeFile(projectFile, JSON.stringify({ ...(JSON.parse(saved) as ProjectFile), captions: true }, null, 2));
    await addScene(
      'audit-safe',
      `export default function Safe() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff', color: '#111111' }}>
      <h1 style={{ position: 'absolute', left: 40, top: 300, margin: 0, fontSize: 48 }}>In the margin</h1>
      <p style={{ position: 'absolute', left: 700, top: 950, margin: 0, fontSize: 40 }}>Under the caption</p>
    </div>
  );
}
`,
    );
    await h.store.syncCode(id);
    const start = (await h.store.get(id)).scenes.find((s) => s.id === 'audit-safe')!.start;
    h.store.voiceOverLines.set(id, [
      { sceneId: 'audit-safe', text: 'Bonjour tout le monde.', start, end: start + 0.5, speaker: null, words: [], level: [] },
    ]);
    try {
      const page = await open({ scene: 'audit-safe' });
      await seek(page, 0.25);
      assert.deepEqual(kinds(await audit(page)), ['underCaptions Under the caption', 'outsideSafe In the margin']);
      await seek(page, 0.75);
      assert.deepEqual(kinds(await audit(page)), ['outsideSafe In the margin'], 'no caption, nothing under it');
      await page.context().close();
    } finally {
      h.store.voiceOverLines.delete(id);
      await writeFile(projectFile, saved);
    }
  });

  /** A scene drawing `body` on a white canvas, its findings at 0.25 s. */
  async function auditOf(sceneId: string, body: string, format: '16:9' | '9:16' = '16:9', root = ''): Promise<AuditFinding[]> {
    await addScene(
      sceneId,
      `const at = (left, top, style) => ({ position: 'absolute', left, top, margin: 0, ...style });
const cell = (left, top, layer, text, style) => (
  <div style={at(left, top, { width: 360, height: 100 })}>
    {layer}
    <p style={{ position: 'relative', margin: 0, padding: 20, fontSize: 32, color: '#ffffff', ...style }}>{text}</p>
  </div>
);
const layer = (style) => ({ position: 'absolute', inset: 0, width: '100%', height: '100%', ...style });
export default function Checked() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff', color: '#111111', ${root} }}>
      ${body}
    </div>
  );
}
`,
    );
    await h.store.syncCode(id);
    const portrait = format === '9:16';
    const page = await open({ scene: sceneId, format }, portrait ? { width: 1080, height: 1920 } : undefined);
    await seek(page, 0.25);
    const findings = await audit(page);
    await page.context().close();
    return findings;
  }

  it('leaves alone what styles cannot judge or nobody sees', async () => {
    const black = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10'/%3E%3C/svg%3E`;
    const findings = await auditOf(
      'audit-quiet',
      `{cell(100, 100, <img src="${black}" style={layer({})} />, 'Over an image')}
      {cell(500, 100, <svg style={layer({})}><rect width="100%" height="100%" /></svg>, 'Over an svg')}
      {cell(900, 100, <canvas style={layer({})} />, 'Over a canvas')}
      {cell(1300, 100, <div style={layer({ background: '#000000', filter: 'brightness(0.5)' })} />, 'Over a filter')}
      {cell(100, 300, <div style={layer({ background: 'rgba(0, 0, 0, 0.6)' })} />, 'On a dark veil', { fontSize: 20 })}
      {cell(500, 300, <div style={layer({ background: '#000000' })} />, 'Outlined', { color: 'transparent', WebkitTextStroke: '2px #ffffff' })}
      {cell(900, 300, <div style={{ ...layer({ background: '#ffffff' }), zIndex: 1 }} />, 'Under a card', { color: '#eeeeee' })}
      {cell(1300, 300, <div style={layer({ background: '#000000', pointerEvents: 'none' })} />, 'Over a click-through layer')}
      <h1 style={at(20, 500, { fontSize: 80, clipPath: 'inset(0 100% 0 0)' })}>Wipe reveal</h1>
      <h1 style={at(20, 600, { fontSize: 80, maskImage: 'linear-gradient(transparent, transparent)' })}>Mask reveal</h1>
      <p style={at(2000, 600, { fontSize: 40 })}>Off to the right</p>
      <div style={at(500, 700, { width: 400, height: 60, overflow: 'hidden' })}>
        <p style={{ margin: 0, fontSize: 40, transform: 'translateY(100px)' }}>Behind the mask</p>
      </div>
      <div style={at(900, 700, { width: 100, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 40, visibility: 'hidden' })}>
        Hidden and far too long
      </div>
      <p style={at(1300, 700, { fontSize: 40, color: '#dddddd', opacity: 0.9 })}>Faint at 0.9</p>`,
    );
    assert.deepEqual(kinds(findings), []);
  });

  it('reports one finding per line of text and per fix: an ellipsis, a word-by-word reveal, a title letter by letter, split text', async () => {
    const findings = await auditOf(
      'audit-blocks',
      `<div style={at(100, 100, { width: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 40 })}>
        <b>Title</b> and a tail far too long to fit
      </div>
      <div style={at(100, 300, { fontSize: 80, lineHeight: 1.04, whiteSpace: 'nowrap' })}>
        {['Ship', 'it', 'today'].map((word, i) => (
          <span key={word}>
            {i > 0 ? ' ' : null}
            <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.12em', marginBottom: '-0.12em' }}>
              <span style={{ display: 'inline-block', transform: 'translateY(60%)' }}>{word}</span>
            </span>
          </span>
        ))}
      </div>
      <div style={at(100, 500, { fontSize: 64, color: '#cccccc' })}>
        {[...'HEADLINE'].map((letter, i) => <span key={i} style={{ display: 'inline-block' }}>{letter}</span>)}
      </div>
      <p style={at(100, 700, { fontSize: 40, color: '#dddddd' })}>{12} items</p>
      <p style={at(100, 850, { fontSize: 30 })}>
        Normal text <span style={{ color: '#cccccc' }}>faint one</span> more normal text <span style={{ color: '#dddddd' }}>fainter two</span>
      </p>`,
    );
    assert.deepEqual(kinds(findings), [
      'clipped and a tail far too long to fit',
      'clipped Ship it today',
      'contrast 12 items',
      'contrast HEADLINE',
    ]);
    const [, reveal, , letters] = findings;
    assert.ok(reveal.box.width > 300, `the box spans the line: ${JSON.stringify(reveal.box)}`);
    assert.ok(letters.box.width > 250, `the box spans the word: ${JSON.stringify(letters.box)}`);
  });

  it('blends veils under and over the text, sees click-through labels, judges text at its rendered size, takes canvas-wide clips for the canvas', async () => {
    const findings = await auditOf(
      'audit-layers',
      `<h2 style={at(1600, 100, { fontSize: 80, whiteSpace: 'nowrap' })}>Half off canvas</h2>
      <div style={at(100, 300, { padding: 20, background: 'rgba(255, 255, 255, 0.5)', color: '#777777', fontSize: 20 })}>Grey on a veil</div>
      <div style={at(100, 500, { pointerEvents: 'none' })}>
        <span style={{ display: 'inline-block', padding: 8, background: '#222222', color: '#333333', fontSize: 28, whiteSpace: 'nowrap' }}>Tag label</span>
      </div>
      <div style={at(0, 0, { transformOrigin: '0 0', transform: 'scale(2.5)' })}>
        <p style={at(400, 300, { fontSize: 16, color: '#888888', whiteSpace: 'nowrap' })}>Zoomed in</p>
      </div>
      <p style={at(1000, 300, { fontSize: 16, color: '#888888' })}>Not zoomed</p>
      <p style={at(1000, 500, { fontSize: 20 })}>
        <span style={{ transform: 'scale(2)', color: '#8c8c8c' }}>Inline scaled</span>
      </p>
      <div style={at(0, 800, { width: 1920, height: 120, overflow: 'hidden', background: '#000000', color: '#ffffff' })}>
        <div style={at(-300, 20, { fontSize: 60, whiteSpace: 'nowrap' })}>Breaking news ticker running past both edges of the canvas and on</div>
      </div>
      <div style={layer({})} />
      <div style={layer({ background: '#000000', opacity: 0.08 })} />`,
      '16:9',
      "overflow: 'hidden'",
    );
    assert.deepEqual(kinds(findings), [
      'offCanvas Half off canvas',
      'offCanvas Breaking news ticker running past both e',
      'contrast Tag label',
      'contrast Inline scaled',
      'contrast Not zoomed',
      'contrast Grey on a veil',
    ]);
    // The 8% black layer over the canvas blends in: #888888 on white drops from 3.54 to 3.43, #8c8c8c from 3.36 to 3.26,
    // #777777 from 4.48 to 4.29.
    assert.deepEqual(
      findings.slice(3).map((f) => [f.ratio, f.required]),
      [
        [3.26, 4.5],
        [3.43, 4.5],
        [4.29, 4.5],
      ],
    );
    assert.equal(findings[2].required, 3, '28 px is large text');
  });

  it('keeps judging text under transparent layers, faint veils and runtime decor', async () => {
    const findings = await auditOf(
      'audit-overlays',
      `<p style={at(300, 400, { fontSize: 40, color: '#bbbbbb' })}>Faint under layers</p>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <path d="M1500 900 L1700 950" stroke="#000000" strokeWidth={4} />
      </svg>
      <div style={layer({ background: 'rgba(0, 0, 0, 0.05)' })} />
      <div style={layer({ background: 'rgba(0, 0, 0, 0.02)' })} />
      <div data-cadence-decor="" style={layer({ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.45) 100%)' })} />`,
    );
    // The 5% and 2% black veils blend in (#bbbbbb on white alone: 1.92); the svg and the decor gradient do not.
    assert.deepEqual(
      findings.map((f) => [f.kind, f.text, f.ratio]),
      [['contrast', 'Faint under layers', 1.9]],
    );
  });

  it('groups words and letters of a flex row, keeps the lines of a flex column apart, and sees into rounded cards', async () => {
    const findings = await auditOf(
      'audit-shapes',
      `<h1 style={at(100, 100, { display: 'flex', gap: 20, fontSize: 80, color: '#dddddd' })}>
        {['Ship', 'faster', 'with', 'code'].map((word) => <span key={word}>{word}</span>)}
      </h1>
      <div style={at(100, 250, { display: 'flex', fontSize: 64, color: '#cccccc' })}>
        {[...'HEADLINE'].map((letter, i) => <span key={i}>{letter}</span>)}
      </div>
      <h1 style={at(100, 400, { display: 'flex', gap: 20, fontSize: 80, color: '#e4e4e4' })}>
        {['Ship', 'faster'].map((word) => (
          <span key={word} style={{ display: 'inline-flex' }}>
            {[...word].map((letter, i) => <span key={i}>{letter}</span>)}
          </span>
        ))}
      </h1>
      <div style={at(100, 600, { display: 'flex', flexDirection: 'column', fontSize: 40 })}>
        <span style={{ color: '#eeeeee' }}>First line</span>
        <span style={{ color: '#e8e8e8' }}>Second line</span>
      </div>
      <div style={at(1000, 600, { width: 600, height: 150, clipPath: 'inset(0 round 32px)', background: '#ffffff' })}>
        <p style={{ margin: 0, padding: 30, fontSize: 40, color: '#bbbbbb' }}>Faint in a rounded card</p>
      </div>`,
    );
    assert.deepEqual(kinds(findings), [
      'contrast First line',
      'contrast Second line',
      'contrast Ship faster',
      'contrast Ship faster with code',
      'contrast HEADLINE',
      'contrast Faint in a rounded card',
    ]);
  });

  it('keeps the lines of a reveal, a staircase title and the cards of a grid apart', async () => {
    const findings = await auditOf(
      'audit-lines',
      `<div style={at(100, 100, { fontSize: 80, lineHeight: 1.04, whiteSpace: 'nowrap' })}>
        {['Ship', 'it', 'today', 'and', 'every', 'day'].map((word, i) => (
          <span key={word}>
            {i === 3 ? <br /> : i > 0 ? ' ' : null}
            <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.12em', marginBottom: '-0.12em' }}>
              <span style={{ display: 'inline-block', transform: 'translateY(60%)' }}>{word}</span>
            </span>
          </span>
        ))}
      </div>
      <p style={at(100, 400, { fontSize: 40, color: '#eeeeee' })}>Stair</p>
      <p style={at(200, 460, { fontSize: 40, color: '#e0e0e0' })}>case</p>
      <div style={at(100, 700, { display: 'grid', gridTemplateColumns: 'repeat(3, 500px)', gap: 40 })}>
        {[['First card body text', '#cccccc'], ['Second card is fine', '#111111'], ['Third card faint too', '#dddddd']].map(([text, color]) => (
          <div key={text} style={{ padding: 24, background: '#ffffff', border: '1px solid #eeeeee', fontSize: 28, color }}>{text}</div>
        ))}
      </div>`,
    );
    assert.deepEqual(kinds(findings), [
      'clipped Ship it today',
      'clipped and every day',
      'contrast Stair',
      'contrast case',
      'contrast Third card faint too',
      'contrast First card body text',
    ]);
  });

  it('keeps a title and its side note apart in a flex row, and the parts of a header', async () => {
    const findings = await auditOf(
      'audit-rows',
      `<h1 style={{ margin: 0, fontSize: 80, color: '#dddddd' }}>Big title</h1>
      <p style={{ margin: 0, fontSize: 20, color: '#bbbbbb' }}>Side note small</p>
      <header style={at(100, 100, { display: 'flex', gap: 40, alignItems: 'center', fontSize: 28, width: 1700 })}>
        <div style={{ color: '#cccccc' }}>Acme</div>
        <nav style={{ display: 'flex', gap: 24 }}>
          <a style={{ color: '#d4d4d4' }}>Pricing</a>
          <a>Docs</a>
          <a style={{ color: '#c4c4c4' }}>Blog</a>
        </nav>
        <button style={{ fontSize: 28, color: '#bcbcbc', background: '#ffffff', border: 0 }}>Sign up today</button>
      </header>`,
      '16:9',
      "display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12",
    );
    assert.deepEqual(kinds(findings), [
      'contrast Side note small',
      'contrast Big title',
      'contrast Pricing',
      'contrast Acme',
      'contrast Blog',
      'contrast Sign up today',
    ]);
    assert.deepEqual(
      findings.slice(0, 2).map((f) => [f.ratio, f.required]),
      [
        [1.92, 4.5],
        [1.36, 3],
      ],
    );
  });

  it('leaves text under a scrim or stacked veils alone, sees into inset(0%) cards, takes a band at the top edge for the canvas', async () => {
    const findings = await auditOf(
      'audit-veils',
      `<p style={at(100, 400, { fontSize: 40, color: '#949494' })}>Passes alone at 3.03</p>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={at(80, 380, { width: 800, height: 100, background: 'rgba(0, 0, 0, 0.08)' })} />
      ))}
      <p style={at(100, 600, { fontSize: 40, color: '#ffffff' })}>White under a scrim</p>
      <div style={at(80, 580, { width: 800, height: 100, background: 'rgba(0, 0, 0, 0.3)' })} />
      <div style={at(1000, 400, { width: 600, height: 150, clipPath: 'inset(0%)', background: '#ffffff' })}>
        <p style={{ margin: 0, padding: 30, fontSize: 40, color: '#bbbbbb' }}>Faint in a square card</p>
      </div>
      <div style={at(0, 0.4, { width: 1920, height: 120, overflow: 'hidden', background: '#000000', color: '#ffffff' })}>
        <div style={at(300, -50, { fontSize: 60, whiteSpace: 'nowrap' })}>Band text rising above</div>
      </div>`,
    );
    // Four 8% layers stack to 28%, the scrim is 30%: like a card, they hide the text (dimmed on purpose) from the ratio.
    assert.deepEqual(
      findings.map((f) => [f.kind, f.text, f.ratio]),
      [
        ['offCanvas', 'Band text rising above', undefined],
        ['contrast', 'Faint in a square card', 1.92],
      ],
    );
  });

  it('reports the faint title of a modal, not the rows dimmed behind its backdrop', async () => {
    const findings = await auditOf(
      'audit-modal',
      `{Array.from({ length: 8 }, (_, i) => (
        <p key={i} style={at(100 + (i % 2) * 1100, 120 + Math.floor(i / 2) * 230, { fontSize: 32, color: '#666666' })}>
          Dashboard row {i} text
        </p>
      ))}
      <div style={layer({ background: 'rgba(0, 0, 0, 0.6)' })} />
      <div style={at(660, 400, { width: 600, padding: 40, background: '#ffffff', fontSize: 28 })}>
        <h2 style={{ margin: 0, fontSize: 28, color: '#999999' }}>Faint modal title</h2>
        <p style={{ margin: '16px 0 0', color: '#111111' }}>Modal body text</p>
      </div>`,
    );
    assert.deepEqual(
      findings.map((f) => [f.kind, f.text, f.ratio, f.required]),
      [['contrast', 'Faint modal title', 2.85, 3]],
    );
  });

  it('keeps a popping title whole, spaces words set apart by a margin, gives a grid in one color one finding', async () => {
    const findings = await auditOf(
      'audit-pops',
      `<h1 style={at(100, 100, { fontSize: 80, color: '#dddddd' })}>
        {[...'HEADLINE'].map((letter, i) => (
          <span key={i} style={{ display: 'inline-block', transform: \`scale(\${[1, 1.08, 1.15, 1.1, 1, 0.92, 0.88, 0.9][i]})\` }}>
            {letter}
          </span>
        ))}
      </h1>
      <h2 style={at(100, 300, { fontSize: 64, color: '#eeeeee' })}>
        {['Ship', 'fast', 'now'].map((word) => (
          <span key={word} style={{ display: 'inline-block', marginRight: '0.17em' }}>
            {word}
          </span>
        ))}
      </h2>
      <div style={at(100, 500, { display: 'grid', gridTemplateColumns: 'repeat(3, 200px)', fontSize: 28, color: '#cccccc' })}>
        {['Name', 'Price', 'Qty', 'Apples', '3.20', '12'].map((cell) => <span key={cell}>{cell}</span>)}
      </div>
      <div style={at(1000, 500, { width: 300, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 40 })}>
        This line is far too long for its box
      </div>`,
    );
    assert.deepEqual(kinds(findings), [
      'clipped This line is far too long for its box',
      'contrast Ship fast now',
      'contrast HEADLINE',
      'contrast Name',
    ]);
    const cells = findings[3].box;
    assert.ok(cells.width > 400 && cells.height > 60, `the box spans the grid: ${JSON.stringify(cells)}`);
  });

  it('measures the safe margins of the format on the rendered font size', async () => {
    const findings = await auditOf(
      'audit-portrait',
      `<h1 style={at(100, 100, { fontSize: 48 })}>Top title</h1>
      <p style={at(100, 170, { fontSize: 22, lineHeight: 1.5 })}>Small line</p>
      <h1 style={at(100, 300, { fontSize: 48 })}>Safe title</h1>
      <div style={at(0, 0, { transformOrigin: '0 0', transform: 'scale(3)' })}>
        <p style={at(40, 20, { fontSize: 12, whiteSpace: 'nowrap' })}>Zoomed note</p>
      </div>`,
      '9:16',
    );
    assert.deepEqual(kinds(findings), ['outsideSafe Top title', 'outsideSafe Zoomed note']);
  });

  it('stops checking contrast after 100 texts', async () => {
    const findings = await auditOf(
      'audit-many',
      `{Array.from({ length: 100 }, (_, i) => (
        <p key={i} style={at(100 + (i % 10) * 150, 100 + Math.floor(i / 10) * 40, { fontSize: 12 })}>Line {i}</p>
      ))}
      <p style={at(100, 600, { fontSize: 40, color: '#eeeeee' })}>Past the cap</p>`,
    );
    assert.deepEqual(kinds(findings), []);
  });

  it('reports nothing on a frame that shows a scene error', async () => {
    await addScene(
      'audit-throws',
      `export default function Throws({ t }) {
  if (t >= 0.5) throw new Error('Broken: ' + 'a very long message '.repeat(40));
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff', color: '#111111' }}>
      <div style={{ position: 'absolute', left: 200, top: 450, width: 300, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 40 }}>
        Far too long for its box, really
      </div>
    </div>
  );
}
`,
    );
    await h.store.syncCode(id);
    const page = await open({ scene: 'audit-throws' });
    const clipped = ['clipped Far too long for its box, really'];
    await seek(page, 0.25);
    assert.deepEqual(kinds(await audit(page)), clipped);
    assert.notDeepEqual((await seek(page, 0.75)).errors, []);
    assert.deepEqual(await audit(page), []);
    await seek(page, 0.25);
    assert.deepEqual(kinds(await audit(page)), clipped);
    await page.context().close();
  });

  it('gives null when scene code replaces the checks with junk', { timeout: 10_000 }, async () => {
    const page = await open({ scene: 'audit' });
    await seek(page, 0.25);
    // The checks run in the frame next to scene code: the server trusts nothing back (tests/server/capture-audit.test.ts).
    await page.evaluate(() => {
      window.__cadence!.audit = () => 'junk' as unknown as AuditFinding[];
    });
    assert.equal(await auditFrame(page), null);
    await page.context().close();
  });

  it('runs in capture.frames on request only, after each screenshot', async () => {
    const capture = new PlaywrightCapture({ config: h.config, store: h.store });
    try {
      const [dirty, clean] = await capture.frames(id, { sceneId: 'audit', times: [0.25, 0.75], format: '16:9', audit: true });
      assert.deepEqual(
        dirty.audit?.map((f) => f.kind),
        ['clipped', 'offCanvas', 'contrast'],
      );
      assert.deepEqual(clean.audit, []);
      const [plain] = await capture.frames(id, { sceneId: 'audit', times: [0.25], format: '16:9' });
      assert.equal(plain.audit, undefined);
    } finally {
      await capture.close();
    }
  });
});

describe('frame CSP', () => {
  it('lets Vite modules, style tags, fonts and images work but blocks other origins', async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 });
    await context.addInitScript(() => {
      const w = window as unknown as { violations: string[] };
      w.violations = [];
      document.addEventListener('securitypolicyviolation', (e) => w.violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
    });
    const page = await context.newPage();
    await page.goto(`${h.config.frameOrigin}/frame.html?project=${id}&scene=brand&format=16:9&mode=capture`);
    await page.evaluate(() => window.__cadence!.ready);
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 100, 100), [0, 200, 255]));
    // data: and blob: images, a data: font (what scenes and brand themes may inline). No named inner functions:
    // tsx would wrap them in a __name() helper the page does not have.
    const inlined = await page.evaluate(async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>';
      const sources = [
        `data:image/svg+xml,${encodeURIComponent(svg)}`,
        URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
      ];
      const widths = await Promise.all(
        sources.map((src) => {
          const img = new Image();
          img.src = src;
          return img.decode().then(
            () => img.naturalWidth,
            () => 0,
          );
        }),
      );
      const woff2 = await (
        await fetch('/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')
      ).arrayBuffer();
      const base64 = btoa(Array.from(new Uint8Array(woff2), (byte) => String.fromCharCode(byte)).join(''));
      const font = await new FontFace('Inlined', `url(data:font/woff2;base64,${base64})`).load().then(
        () => 'loaded',
        () => 'blocked',
      );
      return { data: widths[0], blob: widths[1], font };
    });
    assert.deepEqual(inlined, { data: 4, blob: 4, font: 'loaded' });
    const outside = `${h.config.editorOrigin}/x`;
    assert.equal(
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => 'loaded',
            () => 'blocked',
          ),
        outside,
      ),
      'blocked',
    );
    await page.evaluate(async (url) => {
      const img = new Image();
      img.src = `${url}.png`;
      await img.decode().catch(() => undefined);
    }, outside);
    const violations = await page.evaluate(() => (window as unknown as { violations: string[] }).violations);
    // Vite's client no longer dials its HMR websocket (port 24678 in middleware mode): no ws: violation either.
    const unexpected = violations.filter((v) => !v.includes(h.config.editorOrigin));
    assert.deepEqual(unexpected, []);
    assert.ok(violations.some((v) => v.startsWith('connect-src') && v.includes(h.config.editorOrigin)));
    assert.ok(violations.some((v) => v.startsWith('img-src') && v.includes(h.config.editorOrigin)));
    await context.close();
  });

  it('keeps scene code from fetching another site through another document of the frame origin', async () => {
    let requests = 0;
    const other = http.createServer((_req, res) => {
      requests++;
      res.end();
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const page = await open({ scene: 'blue' });
    try {
      // Project data and a project asset, loaded as documents next to the scene to send a request from there. Their
      // frame-ancestors refuses them under a scene, and their connect-src (the CSP test above) would stop the request.
      await page.evaluate(
        ([sources, url]) =>
          Promise.all(
            sources.map(async (src) => {
              const frame = Object.assign(document.createElement('iframe'), { src });
              const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
              document.body.append(frame);
              await loaded;
              try {
                await frame.contentWindow!.fetch(url, { method: 'POST', body: 'secret' });
              } catch {
                // Refused, or sent and refused a CORS answer: only the count of requests tells.
              }
            }),
          ),
        [
          [`/frame-api/projects/${id}`, `/@fs${h.store.dir(id)}/assets/square.svg`],
          `http://127.0.0.1:${(other.address() as AddressInfo).port}/`,
        ] as const,
      );
      assert.equal(requests, 0);
    } finally {
      await page.context().close();
      other.close();
    }
  });
});

describe('postMessage bridge', () => {
  type Received = { origin: string; data: { source: string; type: string; [key: string]: unknown } };

  /** Latest message of that type once one arrived (and, with `count`, once there are at least that many). */
  async function waitFor(page: Page, type: string, count = 1): Promise<Received> {
    const handle = await page.waitForFunction(
      ([t, n]) => {
        const matching = (window as unknown as { received: Received[] }).received.filter((m) => m.data?.type === t);
        return matching.length >= n && matching[matching.length - 1];
      },
      [type, count] as const,
    );
    return (await handle.jsonValue()) as Received;
  }

  it('talks to the editor origin only', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const frameUrl = `${h.config.frameOrigin}/frame.html?project=${id}&scene=throws&format=16:9&mode=editor`;
    await page.goto(h.editorPage(frameUrl));
    const ready = await waitFor(page, 'ready');
    assert.equal(ready.origin, h.config.frameOrigin);
    assert.equal(ready.data.source, 'cadence-frame');
    assert.equal(ready.data.generation, h.store.generation(id));

    const post = (message: object) =>
      page.evaluate((m) => (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), message);
    await post({ source: 'cadence-editor', type: 'seek', t: 0.75, requestId: 'r1' });
    const seeked = await waitFor(page, 'seeked');
    assert.equal(seeked.data.requestId, 'r1');
    const result = seeked.data.result as FrameRenderResult;
    assert.equal(result.sceneId, 'throws');
    assert.match(result.errors[0], /Boum/);
    // First render: no errors; the seek at 0.75 s: one.
    const errors = await waitFor(page, 'errors', 2);
    assert.equal((errors.data.errors as string[]).length, 1);

    await post({ source: 'cadence-editor', type: 'reload', generation: h.store.generation(id) });
    assert.equal((await waitFor(page, 'reloaded')).data.generation, h.store.generation(id));
    await context.close();
  });

  it('posts the sound cues after ready and after a reload that changed them', async () => {
    await addScene('bridge-sounds', `export const sounds = () => [{ at: 0.5, sound: 'pop' }];\nexport default () => null;\n`);
    await h.store.syncCode(id);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(h.editorPage(`${h.config.frameOrigin}/frame.html?project=${id}&scene=bridge-sounds&format=16:9&mode=editor`));
    const first = await waitFor(page, 'sounds');
    assert.equal(first.origin, h.config.frameOrigin);
    assert.equal(first.data.sceneId, 'bridge-sounds');
    assert.deepEqual(first.data.cues, [{ at: 0.5, sound: 'pop', gain: 1 }]);
    const types = await page.evaluate(() => (window as unknown as { received: Received[] }).received.map((m) => m.data.type));
    assert.ok(types.indexOf('ready') < types.indexOf('sounds'), types.join(', '));

    const post = (message: object) =>
      page.evaluate((m) => (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), message);
    await post({ source: 'cadence-editor', type: 'reload', generation: h.store.generation(id) });
    await waitFor(page, 'reloaded');
    const count = () =>
      page.evaluate(
        () => (window as unknown as { received: Received[] }).received.filter((m) => m.data.type === 'sounds').length,
      );
    assert.equal(await count(), 1, 'same cues: no new message');

    await writeFile(
      h.store.sceneFile(id, 'bridge-sounds'),
      `export const sounds = () => [{ at: 0.25, sound: 'key', gain: 0.8 }];\nexport default () => null;\n`,
    );
    assert.equal(await h.store.syncCode(id), true);
    await post({ source: 'cadence-editor', type: 'reload', generation: h.store.generation(id) });
    await waitFor(page, 'reloaded', 2);
    assert.equal(await count(), 2);
    assert.deepEqual((await waitFor(page, 'sounds', 2)).data.cues, [{ at: 0.25, sound: 'key', gain: 0.8 }]);

    await writeFile(
      h.store.sceneFile(id, 'bridge-sounds'),
      `export function sounds() {\n  throw new Error('plus de son');\n}\nexport default () => null;\n`,
    );
    assert.equal(await h.store.syncCode(id), true);
    await post({ source: 'cadence-editor', type: 'reload', generation: h.store.generation(id) });
    assert.deepEqual((await waitFor(page, 'sounds', 3)).data.cues, [], 'no stale cues once sounds() fails');
    await context.close();
  });

  it('posts new cues after set-format when sounds() depends on the format', async () => {
    await addScene(
      'format-sounds',
      `export const sounds = (p) => [{ at: p.format === '9:16' ? 0.5 : 0.25, sound: 'pop' }];\nexport default () => null;\n`,
    );
    await h.store.syncCode(id);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(h.editorPage(`${h.config.frameOrigin}/frame.html?project=${id}&scene=format-sounds&format=16:9&mode=editor`));
    assert.deepEqual((await waitFor(page, 'sounds')).data.cues, [{ at: 0.25, sound: 'pop', gain: 1 }]);

    const post = (message: object) =>
      page.evaluate((m) => (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), message);
    await post({ source: 'cadence-editor', type: 'set-format', format: '9:16' });
    assert.deepEqual((await waitFor(page, 'sounds', 2)).data.cues, [{ at: 0.5, sound: 'pop', gain: 1 }]);
    await post({ source: 'cadence-editor', type: 'set-format', format: '16:9' });
    assert.deepEqual((await waitFor(page, 'sounds', 3)).data.cues, [{ at: 0.25, sound: 'pop', gain: 1 }]);
    await context.close();
  });

  it('posts the cues of the shown scene after set-scene', async () => {
    const code = `export const sounds = () => [{ at: 0.1, sound: 'key' }, { at: 0.3, sound: 'impact', gain: 0.4 }];\nexport default () => null;\n`;
    await addScene('set-scene-sounds', code);
    await addScene('set-scene-twin', code);
    await h.store.syncCode(id);
    const start = (await h.store.get(id)).scenes.find((s) => s.id === 'set-scene-sounds')!.start;
    const own = [
      { at: 0.1, sound: 'key', gain: 1 },
      { at: 0.3, sound: 'impact', gain: 0.4 },
    ];
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(h.editorPage(`${h.config.frameOrigin}/frame.html?project=${id}&format=16:9&mode=editor`));
    const whole = await waitFor(page, 'sounds');
    assert.equal(whole.data.sceneId, null);
    const cues = whole.data.cues as unknown[];
    assert.ok(cues.length > own.length, 'the whole video has the cues of the other scenes too');
    for (const cue of own) {
      const inVideo = { ...cue, at: videoTime(start, cue.at) };
      assert.ok(cues.some((c) => JSON.stringify(c) === JSON.stringify(inVideo)));
    }

    const post = (message: object) =>
      page.evaluate((m) => (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), message);
    await post({ source: 'cadence-editor', type: 'set-scene', sceneId: 'set-scene-sounds' });
    const shown = await waitFor(page, 'sounds', 2);
    assert.equal(shown.data.sceneId, 'set-scene-sounds');
    assert.deepEqual(shown.data.cues, own);

    await post({ source: 'cadence-editor', type: 'set-scene', sceneId: 'set-scene-sounds' });
    // seek is queued behind set-scene: once it answers, set-scene has run.
    await post({ source: 'cadence-editor', type: 'seek', t: 0, requestId: 'after-same-scene' });
    await waitFor(page, 'seeked');
    const count = await page.evaluate(
      () => (window as unknown as { received: Received[] }).received.filter((m) => m.data.type === 'sounds').length,
    );
    assert.equal(count, 2, 'same scene: no new message');

    await post({ source: 'cadence-editor', type: 'set-scene', sceneId: 'set-scene-twin' });
    const twin = await waitFor(page, 'sounds', 3);
    assert.equal(twin.data.sceneId, 'set-scene-twin', 'the same cues from another scene are a new message');
    assert.deepEqual(twin.data.cues, own);
    await context.close();
  });

  it('cannot be embedded by another origin', async () => {
    const other = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<iframe id="frame" src="${h.config.frameOrigin}/frame.html?project=${id}&amp;mode=editor"></iframe>`);
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`);
    await page.waitForTimeout(1500);
    const child = page.frames().find((frame) => frame !== page.mainFrame());
    const started = await child?.evaluate(() => typeof window.__cadence !== 'undefined').catch(() => false);
    assert.equal(started ?? false, false);
    await context.close();
    other.close();
  });
});

describe('scene voice-over', () => {
  it('gives the scene its sentences with their words in scene seconds, speaker, level and gesture', async () => {
    await addScene(
      'voice-props',
      `export default function Voice({ voiceOver }) {
  return <div id="voice" data-voice={JSON.stringify(voiceOver)} />;
}
`,
    );
    await h.store.syncCode(id);
    const start = (await h.store.get(id)).scenes.find((s) => s.id === 'voice-props')!.start;
    h.store.voiceOverLines.set(id, [
      {
        sceneId: 'voice-props',
        text: 'Oui, bien.',
        start: start + 0.1,
        end: start + 0.6,
        speaker: 'ana',
        words: [
          { text: 'Oui,', start: start + 0.1, end: start + 0.3 },
          { text: 'bien.', start: start + 0.35, end: start + 0.6 },
        ],
        level: [0, 128, 255],
        gesture: 'wave',
      },
    ]);
    try {
      const page = await open({ scene: 'voice-props' });
      await seek(page, 0.25);
      assert.deepEqual(JSON.parse((await page.getAttribute('#voice', 'data-voice'))!).lines, [
        {
          text: 'Oui, bien.',
          start: 0.1,
          end: 0.6,
          speaker: 'ana',
          words: [
            { text: 'Oui,', start: 0.1, end: 0.3 },
            { text: 'bien.', start: 0.35, end: 0.6 },
          ],
          level: [0, 128, 255],
          gesture: 'wave',
        },
      ]);
      await page.context().close();
    } finally {
      h.store.voiceOverLines.delete(id);
    }
  });
});
