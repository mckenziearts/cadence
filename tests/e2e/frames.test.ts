// Frame origin + frame page in a real Chromium: guards, rendering at exact times, brand/fonts/assets, errors,
// reloads (scene, component, Tailwind class), CSP and the postMessage bridge.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { CHROMIUM_ARGS } from '../../server/capture/capture';
import type { FrameRenderResult } from '../../src/shared/frameProtocol';
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
