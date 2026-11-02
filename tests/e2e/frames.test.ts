// Frame origin + frame page in a real Chromium: guards, rendering at exact times, brand/fonts/assets, errors,
// reloads (scene, component, Tailwind class), text checks, CSP and the postMessage bridge.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { auditFrame, CHROMIUM_ARGS, PlaywrightCapture, seekFrame } from '../../server/capture/capture';
import { LOCAL } from '../../server/capture/policy';
import { LocalClipService } from '../../server/clips/service';
import type { CadenceConfig } from '../../server/contracts';
import { createFrameHandler } from '../../server/frames/frameServer';
import type { AuditFinding, FrameRenderResult } from '../../src/shared/frameProtocol';
import { frameOriginOf } from '../../src/shared/frameOrigin';
import type { MusicGridData, ProjectFile, SceneTransition } from '../../src/shared/types';
import { near, pixel, RecordingHub, startHarness, type Harness } from './helpers/harness';

let h: Harness;
let browser: Browser;
let id: string;
/** The project's own frame origin, and the fixture brand's. */
let projectOrigin: string;
let brandOrigin: string;

before(async () => {
  h = await startHarness('frames');
  browser = await chromium.launch({ args: CHROMIUM_ARGS });
  id = await h.project('frames');
  projectOrigin = await frameOriginOf(h.config.frameOrigin, 'project', id);
  brandOrigin = await frameOriginOf(h.config.frameOrigin, 'brand', 'test');
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
    `${projectOrigin}/frame.html?${new URLSearchParams({ project: id, format: '16:9', mode: 'capture', ...query })}`,
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

/** Takes scenes added by addScene out of the shared project again, so the tests after it see the project they expect. */
async function removeScenes(...sceneIds: string[]): Promise<void> {
  const file = path.join(h.store.dir(id), 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
  project.scenes = project.scenes.filter((scene) => !sceneIds.includes(scene.id));
  await writeFile(file, JSON.stringify(project, null, 2));
  await Promise.all(sceneIds.map((sceneId) => rm(h.store.sceneFile(id, sceneId), { force: true })));
  await h.store.syncCode(id);
}

/** A raw request to 127.0.0.1 with the Host header of the project's frame origin, or `host`: Node does not resolve every
 * `*.localhost` name. */
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
        headers: { host: init.host ?? new URL(projectOrigin).host, ...(init.origin ? { origin: init.origin } : {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`${pathname}: no answer in 10 s`)));
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
  });

  it('answers only the origins of existing projects and brands', async () => {
    const port = h.config.framePort;
    const hostOf = async (kind: 'project' | 'brand', of: string) =>
      new URL(await frameOriginOf(h.config.frameOrigin, kind, of)).host;
    assert.equal((await request(`/frame.html?project=${id}`)).status, 200);
    assert.equal((await request('/kit.html?brand=test', { host: new URL(brandOrigin).host })).status, 200);
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      await hostOf('project', 'e2e-missing'),
      // A project's label is not a brand's origin, nor a brand's label a project's.
      await hostOf('brand', id),
      await hostOf('project', 'test'),
      `${new URL(projectOrigin).hostname}:${port + 1}`,
    ]) {
      assert.equal((await request(`/frame.html?project=${id}`, { host })).status, 403, host);
    }

    const created = await h.project('frames');
    assert.equal((await request(`/frame.html?project=${created}`, { host: await hostOf('project', created) })).status, 200);
    await rm(h.store.dir(created), { recursive: true });
    assert.equal((await request(`/frame.html?project=${created}`, { host: await hostOf('project', created) })).status, 403);
  });

  it('serves frame.html with the CSP and the editor origins', async () => {
    const res = await request(`/frame.html?project=${id}`);
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /font-src 'self' data:/);
    assert.match(csp, new RegExp(`frame-ancestors ${h.config.editorOrigin} http://localhost:${h.config.editorPort}`));
    assert.match(
      res.body,
      new RegExp(`<meta name="cadence-editor-origin" content="${h.config.editorOrigin} http://localhost:${h.config.editorPort}"`),
    );
    assert.match(res.body, /\/src\/frame\/main\.tsx/);
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
    const data = JSON.parse((await request(`/frame-api/projects/${id}`)).body) as {
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
    assert.equal((await request('/frame-api/projects/Nope!')).status, 403);
    assert.equal((await request('/frame-api/projects/e2e-missing')).status, 403);
    const ok = await request(`/frame-api/projects/${id}/scenes/green/diagnostics`);
    assert.deepEqual(JSON.parse(ok.body), { error: null });
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

  it('lets the editor load font files from a brand origin, and nothing else, for its brand panel', async () => {
    const font = '/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';
    const brand = new URL(brandOrigin).host;
    const allowed = (await request(font, { host: brand, origin: h.config.editorOrigin })).headers;
    assert.equal(allowed['access-control-allow-origin'], h.config.editorOrigin);
    assert.equal(allowed.vary, 'Origin');
    assert.equal(
      (await request(font, { host: brand, origin: 'http://evil.test' })).headers['access-control-allow-origin'],
      undefined,
    );
    assert.equal((await request(font, { origin: h.config.editorOrigin })).headers['access-control-allow-origin'], undefined);
    const script = await request('/src/frame/main.tsx', { host: brand, origin: h.config.editorOrigin });
    assert.equal(script.status, 200);
    assert.equal(script.headers['access-control-allow-origin'], undefined);
  });
});

describe('frame origins keep to their own project or brand', () => {
  /** Project B, a second brand, and the hosts of every origin involved. */
  let other: string;
  let projectHost: string;
  let otherHost: string;
  let brandHost: string;
  let otherBrandHost: string;
  const hostOf = async (kind: 'project' | 'brand', of: string) =>
    new URL(await frameOriginOf(h.config.frameOrigin, kind, of)).host;
  const fromRoot = (file: string) => `/${path.relative(h.config.root, file)}`;

  before(async () => {
    other = await h.project('frames');
    await cp(h.brands.dir('test'), h.brands.dir('other'), { recursive: true });
    projectHost = new URL(projectOrigin).host;
    otherHost = await hostOf('project', other);
    brandHost = new URL(brandOrigin).host;
    otherBrandHost = await hostOf('brand', 'other');
  });

  after(async () => {
    await rm(h.store.dir(other), { recursive: true, force: true });
    await rm(h.brands.dir('other'), { recursive: true, force: true });
  });

  it('answers /frame-api only for the project or the brand of the origin', async () => {
    const status = async (url: string, host: string) => (await request(url, { host })).status;
    assert.equal(await status(`/frame-api/projects/${id}`, projectHost), 200);
    assert.equal(await status(`/frame-api/projects/${id}/scenes/blue/diagnostics`, projectHost), 200);
    assert.equal(await status('/frame-api/brands/test', brandHost), 200);
    assert.equal(await status('/frame-api/brands/other', otherBrandHost), 200);
    for (const [url, host] of [
      [`/frame-api/projects/${other}`, projectHost],
      [`/frame-api/projects/${other}/scenes/blue/diagnostics`, projectHost],
      ['/frame-api/brands/test', projectHost],
      [`/frame-api/projects/${id}`, otherHost],
      [`/frame-api/projects/${id}`, brandHost],
      [`/frame-api/projects/${id}/scenes/blue/diagnostics`, brandHost],
      ['/frame-api/brands/other', brandHost],
    ]) {
      assert.equal(await status(url, host), 403, `${url} from ${host}`);
    }
  });

  it('serves frame.html and kit.html only on the origin of the project or brand they name', async () => {
    const status = async (url: string, host: string) => (await request(url, { host })).status;
    assert.equal(await status(`/frame.html?project=${other}`, otherHost), 200);
    for (const [url, host] of [
      [`/frame.html?project=${id}`, otherHost],
      [`/frame.html?project=${id}&project=${other}`, otherHost],
      ['/frame.html', projectHost],
      [`/frame.html?project=${id}`, brandHost],
      ['/kit.html?brand=test', otherBrandHost],
      ['/kit.html?brand=test', projectHost],
    ]) {
      assert.equal(await status(url, host), 403, `${url} from ${host}`);
    }
  });

  it("serves a project origin its own files, its brand, the templates and the app, and nothing of another project's or brand's", async () => {
    for (const url of [
      `/@fs${h.store.sceneFile(id, 'blue')}`,
      `/@fs${h.store.dir(id)}/assets/square.svg`,
      `/@fs${h.brands.dir('test')}/index.tsx`,
      `${fromRoot(h.brands.dir('test'))}/brand.json?import`,
      `/@fs${h.config.templatesDir}/scenes/title-reveal/scene.tsx`,
      '/src/frame/main.tsx',
      '/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
    ]) {
      assert.equal((await request(url)).status, 200, url);
    }
    const scene = h.store.sceneFile(other, 'blue');
    const own = h.store.dir(id);
    for (const url of [
      `/@fs${scene}`,
      `/@fs${scene}?import`,
      `/@fs${scene}?raw`,
      `/@fs${scene}?url`,
      `/@fs${scene}.map`,
      fromRoot(scene),
      `${fromRoot(scene)}?raw`,
      scene,
      scene.replace(/\.tsx$/, ''),
      `/@id/${scene}`,
      `/@fs${h.store.dir(other)}/project.json`,
      `/@fs${h.store.dir(other)}/assets/square.svg`,
      `/@fs${h.brands.dir('other')}/index.tsx`,
      `/@fs${h.brands.dir('other')}/brand.json?import`,
      `/@fs${h.brands.dir('other')}/theme.css?inline`,
      `/@fs${h.brands.dir('test')}/theme.css?inline&project=${other}`,
      `${fromRoot(h.brands.dir('other'))}/index.tsx`,
      '/@id/@brands/other/index.tsx',
      `/@fs${own}/../${other}/scenes/blue.tsx`,
      `/@fs${own}/%2e%2e/${other}/scenes/blue.tsx`,
      `/@fs${own}/..%5c${other}/scenes/blue.tsx`,
      `/@fs${own}/..\\${other}/scenes/blue.tsx`,
    ]) {
      assert.equal((await request(url)).status, 403, url);
    }
  });

  it('serves a brand origin its own folder and the app, and no project or other brand', async () => {
    for (const url of [
      `/@fs${h.brands.dir('test')}/index.tsx`,
      `/@fs${h.brands.dir('test')}/theme.css?inline`,
      '/src/frame/kit.tsx',
    ]) {
      assert.equal((await request(url, { host: brandHost })).status, 200, url);
    }
    for (const url of [
      `/@fs${h.store.sceneFile(id, 'blue')}`,
      fromRoot(h.store.sceneFile(id, 'blue')),
      `/@fs${h.brands.dir('other')}/index.tsx`,
      `/@fs${h.brands.dir('test')}/theme.css?inline&project=${id}`,
    ]) {
      assert.equal((await request(url, { host: brandHost })).status, 403, url);
    }
  });

  it("refuses a scene's import of another brand, and diagnostics say why", async () => {
    const scene = h.store.sceneFile(id, 'brands');
    await writeFile(
      scene,
      "import otherKit from '@brands/other';\nimport ownKit from '@brands/test';\nexport default () => String(Boolean(otherKit && ownKit));\n",
    );
    try {
      const code = (await request(`/@fs${scene}?import`)).body;
      const imports = [...code.matchAll(/from "([^"]+)"/g)].map(([, url]) => url);
      const otherUrl = imports.find((url) => url.includes('/brands/other/'));
      const ownUrl = imports.find((url) => url.includes('/brands/test/'));
      assert.ok(otherUrl && ownUrl, code);
      assert.equal((await request(otherUrl)).status, 403, otherUrl);
      assert.equal((await request(ownUrl)).status, 200, ownUrl);
      const { error } = JSON.parse((await request(`/frame-api/projects/${id}/scenes/brands/diagnostics`)).body) as {
        error: string | null;
      };
      assert.match(error ?? '', /brands\/other\/index\.tsx/);
    } finally {
      await rm(scene);
    }
  });

  it('refuses a link that leads out of the project folder', async () => {
    const linked = await h.project('frames');
    try {
      await symlink(h.store.dir(other), path.join(h.store.dir(linked), 'linked'));
      await symlink(h.store.sceneFile(other, 'blue'), h.store.sceneFile(linked, 'linked'));
      const host = await hostOf('project', linked);
      assert.equal((await request(`/@fs${h.store.sceneFile(linked, 'blue')}`, { host })).status, 200);
      for (const url of [
        `/@fs${h.store.dir(linked)}/linked/scenes/blue.tsx`,
        `/@fs${h.store.sceneFile(linked, 'linked')}`,
        fromRoot(h.store.sceneFile(linked, 'linked')),
      ]) {
        assert.equal((await request(url, { host })).status, 403, url);
      }
    } finally {
      await rm(h.store.dir(linked), { recursive: true, force: true });
    }
  });

  it('turns DNS prefetching off on every response', async () => {
    for (const [url, host] of [
      [`/frame.html?project=${id}`, projectHost],
      ['/src/frame/main.tsx', projectHost],
      [`/frame-api/projects/${id}`, projectHost],
      [`/frame-api/projects/${other}`, projectHost],
      ['/api/state', projectHost],
      ['/kit.html?brand=test', brandHost],
      [`/frame.html?project=${id}`, `evil.test:${h.config.framePort}`],
    ]) {
      assert.equal((await request(url, { host })).headers['x-dns-prefetch-control'], 'off', `${url} from ${host}`);
    }
  });

  it("keeps a page on another project's or brand's origin from loading that project or brand", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const requested: string[] = [];
      page.on('request', (r) => {
        if (!r.url().endsWith('/favicon.ico')) requested.push(r.url());
      });
      const otherOrigin = `http://${otherHost}`;
      const crossed = [
        `${otherOrigin}/frame.html?project=${id}&format=16:9&mode=capture`,
        `http://${otherBrandHost}/kit.html?brand=test`,
      ];
      for (const url of crossed) {
        assert.equal((await page.goto(url))?.status(), 403, url);
      }
      assert.deepEqual(requested, crossed);

      // B's own page, reaching for A from script.
      await page.goto(`${otherOrigin}/frame.html?project=${other}&format=16:9&mode=capture`);
      await page.evaluate(() => window.__cadence!.ready);
      const statuses = await page.evaluate(
        (urls) => Promise.all(urls.map((url) => fetch(url).then((res) => res.status))),
        [`/frame-api/projects/${id}`, `/@fs${h.store.sceneFile(id, 'blue')}`, `/@fs${h.brands.dir('other')}/index.tsx`],
      );
      assert.deepEqual(statuses, [403, 403, 403]);
      const imported = await page.evaluate(
        (url) =>
          import(url).then(
            () => 'loaded',
            () => 'refused',
          ),
        `/@fs${h.store.sceneFile(id, 'blue')}?import`,
      );
      assert.equal(imported, 'refused');
    } finally {
      await context.close();
    }
  });

  describe('stylesheets', () => {
    const SECRET = 'cross-project-secret';
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><text>${SECRET}</text></svg>`;
    /** The secret as it may land in compiled CSS: plain, or a whole file in base64. */
    const leaked = (body: string) =>
      [SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SVG).toString('base64').replace(/=+$/, '')].some((s) =>
        body.includes(s),
      );

    before(async () => {
      await mkdir(path.join(h.store.dir(other), 'components'), { recursive: true });
      await mkdir(path.join(h.store.dir(id), 'components'), { recursive: true });
      await writeFile(path.join(h.store.dir(other), 'components/secret.css'), `.secret { --secret: '${SECRET}'; }\n`);
      await writeFile(path.join(h.store.dir(other), 'secret.txt'), SECRET);
      await writeFile(path.join(h.store.dir(other), 'assets/secret.svg'), SVG);
      await writeFile(path.join(h.brands.dir('other'), 'secret.svg'), SVG);
    });

    /** Compiles `css` as a stylesheet of project A, from A's origin. */
    async function compile(name: string, css: string): Promise<{ status: number; body: string }> {
      const file = path.join(h.store.dir(id), 'components', `${name}.css`);
      await writeFile(file, css);
      try {
        return await request(`/@fs${file}?inline`);
      } finally {
        await rm(file);
      }
    }

    it("compiles a project's stylesheet that imports and links its own files", async () => {
      const own = path.join(h.store.dir(id), 'components/own.css');
      await writeFile(own, `.own { --own: 'own-marker'; }\n`);
      try {
        const res = await compile('importsOwn', `@import './own.css';\n.a { background: url(../assets/square.svg); }\n`);
        assert.equal(res.status, 200, res.body);
        assert.match(res.body, /own-marker/);
      } finally {
        await rm(own);
      }
    });

    it("keeps a project's stylesheet from importing or linking another project's or brand's files", async () => {
      const toB = `../../${other}`;
      const forms: Record<string, string> = {
        importQuoted: `@import "${toB}/components/secret.css";`,
        importUrlQuoted: `@import url("${toB}/components/secret.css");`,
        importUrlBare: `@import url(${toB}/components/secret.css);`,
        importUrlTxt: `@import url("${toB}/secret.txt");`,
        importComment: `@import/**/"${toB}/components/secret.css";`,
        urlInline: `.a { background: url("${toB}/secret.txt?inline"); }`,
        urlSvg: `.a { background: url(${toB}/assets/secret.svg); }`,
        imageSet: `.a { background: image-set("${toB}/assets/secret.svg" 1x); }`,
        twUrlSvg: `@import 'tailwindcss' source(none);\n.a { background: url(${toB}/assets/secret.svg); }`,
        alias: '.a { background: url(@brands/other/secret.svg); }',
        rootAbsolute: `.a { background: url(${fromRoot(path.join(h.store.dir(other), 'assets/secret.svg'))}); }`,
        // A package name resolves under root/node_modules, from where dot segments climb back to the projects.
        bareDots: `.a { background: url(react/${path.relative(path.join(h.config.root, 'node_modules/react'), path.join(h.store.dir(other), 'assets/secret.svg'))}); }`,
      };
      for (const [name, css] of Object.entries(forms)) {
        const res = await compile(name, css);
        assert.notEqual(res.status, 200, name);
        assert.ok(!leaked(res.body), `${name}: ${res.body.slice(0, 300)}`);
      }
    });
  });
});

describe('frame origin with a request secret', () => {
  const SECRET = 'frame-request-secret-0123456789abcdef';
  let server: http.Server;
  let config: CadenceConfig;

  before(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const framePort = (server.address() as AddressInfo).port;
    config = { ...h.config, framePort, frameOrigin: `http://localhost:${framePort}`, requestSecret: SECRET };
    server.on('request', createFrameHandler({ config, vite: h.vite, store: h.store, brands: h.brands }));
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('lets capture pages through with the secret and never sends it to a reference site', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const site = http.createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('Content-Type', 'text/html');
      res.end('<body><h1>Référence</h1><img src="/logo.png"></body>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const capture = new PlaywrightCapture({ config, store: h.store });
    try {
      const [shot] = await capture.frames(id, { sceneId: null, times: [0.5], format: '16:9' });
      assert.deepEqual(shot.errors, []);
      assert.ok(shot.image.length > 0);
      const kit = await capture.kitSheet('test');
      assert.deepEqual([kit.loaded, kit.problems], [true, []]);
      assert.ok(kit.image.length > 0);
      await capture.screenshotUrl(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`, {
        device: 'desktop',
        policy: LOCAL,
      });
      assert.ok(seen.length >= 2, 'the page and its image');
      for (const headers of seen) assert.equal(headers['x-cadence-secret'], undefined);
    } finally {
      await capture.close();
      site.closeAllConnections();
      await new Promise((resolve) => site.close(resolve));
    }
  });

  it('never sends the secret to a WebSocket or a fetch on another localhost port', async () => {
    // The capture context routes block other origins' HTTP requests but not WebSockets, and localhost skips the proxy:
    // only the frame CSP (connect-src 'self') keeps the extra header from reaching such a socket.
    const events: string[] = [];
    const site = http.createServer((req, res) => {
      events.push(`http ${req.url} ${req.headers['x-cadence-secret'] ?? ''}`);
      res.end();
    });
    site.on('upgrade', (req, socket) => {
      events.push(`websocket ${req.url} ${req.headers['x-cadence-secret'] ?? ''}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const out = `localhost:${(site.address() as AddressInfo).port}`;
    const projectId = await h.project('frames');
    const dir = h.store.dir(projectId);
    const tried = `const tried = (url) => new Promise((resolve) => {
  try {
    const socket = new WebSocket(url);
    socket.onerror = socket.onclose = resolve;
  } catch {
    resolve();
  }
});\n`;
    await mkdir(path.join(dir, 'components'), { recursive: true });
    await writeFile(
      path.join(dir, 'components', 'sockets.js'),
      `${tried}fetch('http://${out}/worker-fetch').catch(() => undefined).then(() => tried('ws://${out}/worker')).then(() => postMessage('done'));\n`,
    );
    await writeFile(
      path.join(dir, 'scenes', 'sockets.tsx'),
      `${tried}// A same-origin worker gets the frame CSP from its own response.
const worker = new Worker(new URL('../components/sockets.js', import.meta.url));
await Promise.race([
  Promise.all([
    tried('ws://${out}/scene'),
    fetch('http://${out}/scene-fetch').catch(() => undefined),
    new Promise((resolve) => (worker.onmessage = resolve)),
  ]),
  new Promise((resolve) => setTimeout(resolve, 3000)),
]);
export default function Sockets() {
  return <div style={{ position: 'absolute', inset: 0, background: '#00ff00' }} />;
}\n`,
    );
    const file = path.join(dir, 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
    project.scenes.push({ id: 'sockets', name: 'sockets', duration: 1 });
    await writeFile(file, JSON.stringify(project, null, 2));
    const capture = new PlaywrightCapture({ config, store: h.store });
    try {
      const [shot] = await capture.frames(projectId, { sceneId: 'sockets', times: [0.5], format: '16:9' });
      assert.deepEqual(shot.errors, []);
      assert.deepEqual(events, [], 'nothing reached the other port');
    } finally {
      await capture.close();
      site.closeAllConnections();
      await new Promise((resolve) => site.close(resolve));
    }
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
    await page.goto(`${projectOrigin}/frame.html?project=${id}&scene=red-blue&format=9:16&mode=editor`);
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

    const diagnostics = await request(`/frame-api/projects/${id}/scenes/imports-bad/diagnostics`);
    assert.match((JSON.parse(diagnostics.body) as { error: string }).error, /components\/Bad\.tsx/);
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

describe('transitions', () => {
  const solid = (color: string, throwsAfter = Infinity) =>
    `export default function Solid({ t }) {\n  if (t > ${throwsAfter}) throw new Error('Boum à ' + t);\n` +
    `  return <div style={{ position: 'absolute', inset: 0, background: '${color}' }} />;\n}\n`;

  /** A project of its own: scene `out` (1 s), then scene `in` (1 s) with `transition`, so `in` starts at 1 - duration. */
  async function cut(
    transition: SceneTransition,
    out: string,
    into: string,
    captions = false,
  ): Promise<{ id: string; page: Page }> {
    const projectId = await h.project('frames');
    const file = path.join(h.store.dir(projectId), 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
    project.scenes = [
      { id: 'out', name: 'Sortante', duration: 1 },
      { id: 'in', name: 'Entrante', duration: 1, transition },
    ];
    project.captions = captions;
    await writeFile(file, JSON.stringify(project, null, 2));
    await writeFile(h.store.sceneFile(projectId, 'out'), out);
    await writeFile(h.store.sceneFile(projectId, 'in'), into);
    await h.store.syncCode(projectId);
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 });
    const page = await context.newPage();
    const origin = await frameOriginOf(h.config.frameOrigin, 'project', projectId);
    await page.goto(`${origin}/frame.html?${new URLSearchParams({ project: projectId, format: '16:9', mode: 'capture' })}`);
    await page.evaluate(() => window.__cadence!.ready);
    return { id: projectId, page };
  }

  const drawn = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-cadence-scene]')].map((el) => el.getAttribute('data-cadence-scene')),
    );

  it('blends two solid scenes halfway through a fade, then draws the incoming one alone from the end of the outgoing one', async () => {
    const { page } = await cut({ kind: 'fade', duration: 0.5 }, solid('#ff0000'), solid('#0000ff'));
    assert.equal(await page.evaluate(() => window.__cadence!.duration()), 1.5);
    assert.deepEqual(await seek(page, 0.5), { errors: [], sceneId: 'in', localTime: 0 });
    assert.ok(near(await colorAt(page, 960, 540), [255, 0, 0]), 'progress 0: the outgoing scene only');
    assert.deepEqual(await seek(page, 0.75), { errors: [], sceneId: 'in', localTime: 0.25 });
    assert.deepEqual(await drawn(page), ['out', 'in'], 'the incoming scene on top');
    const mid = await colorAt(page, 960, 540);
    assert.ok(near(mid, [128, 0, 128], 3), `between red and blue, got ${mid}`);
    await page.evaluate(() => document.querySelector('[data-cadence-scene="in"]')!.setAttribute('data-probe', ''));
    assert.deepEqual(await seek(page, 1), { errors: [], sceneId: 'in', localTime: 0.5 });
    assert.deepEqual(await drawn(page), ['in']);
    assert.ok(await page.locator('[data-cadence-scene="in"][data-probe]').count(), 'the incoming scene keeps its element');
    assert.ok(near(await colorAt(page, 960, 540), [0, 0, 255]));
    await page.context().close();
  });

  it("keeps drawing one scene while the other throws, and reports both scenes' errors with the incoming scene's id", async () => {
    // A wipe to the left: the outgoing scene keeps the left part, the incoming one comes in from the right edge.
    const { page } = await cut({ kind: 'wipe', direction: 'left', duration: 0.5 }, solid('#ff0000', 0.6), solid('#0000ff', 0.2));
    const one = await seek(page, 0.65);
    assert.equal(one.sceneId, 'in');
    assert.equal(one.errors.length, 1);
    assert.match(one.errors[0], /Erreur d’exécution · scenes\/out\.tsx/);
    assert.ok(near(await colorAt(page, 480, 1000), [254, 243, 242]), "the outgoing scene's error");
    assert.ok(near(await colorAt(page, 1900, 1000), [0, 0, 255]), 'the incoming scene still draws');
    await page.evaluate(() => document.querySelector('[data-cadence-scene="in"] > div')!.setAttribute('data-probe', ''));
    assert.equal((await seek(page, 0.68)).errors.length, 1);
    assert.equal(
      await page.locator('[data-cadence-scene="in"] > div[data-probe]').count(),
      1,
      'the outgoing scene failing again does not remount the incoming one',
    );
    const both = await seek(page, 0.75);
    assert.deepEqual(
      both.errors.map((e) => e.split('\n')[0]),
      ['Erreur d’exécution · scenes/out.tsx', 'Erreur d’exécution · scenes/in.tsx'],
    );
    assert.equal(both.sceneId, 'in');
    await page.context().close();
  });

  it('slides the incoming scene in from the side the motion comes from', async () => {
    const { page } = await cut({ kind: 'slide', direction: 'left', duration: 0.5 }, solid('#ff0000'), solid('#0000ff'));
    await seek(page, 0.75);
    assert.ok(near(await colorAt(page, 480, 540), [255, 0, 0]), 'the outgoing scene leaves by the left');
    assert.ok(near(await colorAt(page, 1440, 540), [0, 0, 255]), 'the incoming scene comes from the right');
    await page.context().close();
  });

  it('flips the scenes without ever showing their back', async () => {
    // The incoming scene draws its left half only: what its transparent right half lets through tells the faces apart.
    const half =
      'export default function Half() {\n' +
      "  return <div style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: '100%', background: '#0000ff' }} />;\n}\n";
    const { page } = await cut({ kind: 'flip', direction: 'left', duration: 0.5 }, solid('#ff0000'), half);
    const background: [number, number, number] = [244, 244, 245];
    // Progress 0.4: the outgoing scene has turned under 90 degrees, the incoming one over 90, back to the viewer.
    await seek(page, 0.7);
    assert.ok(near(await colorAt(page, 20, 540), background), 'the outgoing scene turns away from the canvas edges');
    assert.ok(near(await colorAt(page, 720, 540), [255, 0, 0]));
    assert.ok(near(await colorAt(page, 1200, 540), [255, 0, 0]), "the incoming scene's mirrored half stays hidden");
    // Progress 0.6: the faces have swapped.
    await seek(page, 0.8);
    assert.ok(near(await colorAt(page, 720, 540), [0, 0, 255]));
    assert.ok(near(await colorAt(page, 1200, 540), background), "the outgoing scene's back stays hidden");
    await page.context().close();
  });

  it("reports both scenes' sounds() and compile errors during the cut, and hides the captions over a compile error alone", async () => {
    const sounds = `export function sounds() {\n  throw new Error('Sons cassés');\n}\n${solid('#ff0000')}`;
    const broken = 'export default function Broken() {\n  return <div>oops</span>;\n}\n';
    const first = await cut({ kind: 'fade', duration: 0.5 }, sounds, broken, true);
    h.store.voiceOverLines.set(first.id, [
      { sceneId: 'in', text: 'Sous-titre.', start: 0.5, end: 1.5, speaker: null, words: [], level: [] },
    ]);
    await first.page.evaluate(() => window.__cadence!.reload(0));
    const during = await seek(first.page, 0.75);
    assert.equal(during.sceneId, 'in');
    assert.deepEqual(
      during.errors.map((e) => e.split('\n')[0]),
      ['Erreur de compilation · scenes/in.tsx', 'Erreur dans sounds() · scenes/out.tsx'],
    );
    assert.match(during.errors[1], /Sons cassés/);
    assert.equal(await first.page.locator('[data-cadence-captions]').count(), 1, 'the outgoing scene still draws');
    await seek(first.page, 1.2);
    assert.equal(await first.page.locator('[data-cadence-captions]').count(), 0);
    h.store.voiceOverLines.delete(first.id);
    await first.page.context().close();

    const second = await cut({ kind: 'fade', duration: 0.5 }, broken, sounds);
    assert.deepEqual(
      (await seek(second.page, 0.75)).errors.map((e) => e.split('\n')[0]),
      ['Erreur de compilation · scenes/out.tsx', 'Erreur dans sounds() · scenes/in.tsx'],
    );
    await second.page.context().close();
  });

  it('draws the brand background and the captions once, outside both scenes', async () => {
    const { id: projectId, page } = await cut(
      { kind: 'slide', direction: 'left', duration: 0.5 },
      solid('transparent'),
      solid('transparent', 0.2),
      true,
    );
    h.store.voiceOverLines.set(projectId, [
      { sceneId: 'in', text: 'Un seul sous-titre.', start: 0.5, end: 1.5, speaker: null, words: [], level: [] },
    ]);
    await page.evaluate(() => window.__cadence!.reload(0));
    const result = await seek(page, 0.6);
    assert.deepEqual(result.errors, []);
    const layout = await page.evaluate(() => {
      const stage = document.querySelector('[data-cadence-stage]')!;
      const scenes = [...stage.querySelectorAll<HTMLElement>('[data-cadence-scene]')];
      return {
        captions: [...stage.querySelectorAll('[data-cadence-captions]')].map((el) => [
          el.parentElement === stage,
          el.textContent,
        ]),
        stage: getComputedStyle(stage).backgroundColor,
        scenes: scenes.map((el) => getComputedStyle(el).backgroundColor),
      };
    });
    assert.deepEqual(layout, {
      captions: [[true, 'Un seul sous-titre.']],
      stage: 'rgb(244, 244, 245)',
      scenes: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'],
    });
    // A scene that throws keeps the captions.
    const failed = await seek(page, 0.8);
    assert.equal(failed.errors.length, 1);
    assert.equal(await page.locator('[data-cadence-captions]').count(), 1);
    h.store.voiceOverLines.delete(projectId);
    await page.context().close();
  });

  it('runs the text checks on a settled scene, not on two scenes caught halfway through a slide', async () => {
    const centred = (text: string, extra = '') =>
      `export default function Centred() {\n  return (\n    <div style={{ position: 'absolute', inset: 0, display: 'flex', ` +
      `alignItems: 'center', justifyContent: 'center', background: '#ffffff', color: '#111111' }}>\n` +
      `      <h1 style={{ margin: 0, fontSize: 96 }}>${text}</h1>\n${extra}    </div>\n  );\n}\n`;
    const offCanvas = `      <h2 style={{ position: 'absolute', left: 1600, top: 800, margin: 0, fontSize: 80, whiteSpace: 'nowrap' }}>Hors cadre</h2>\n`;
    const { page } = await cut(
      { kind: 'slide', direction: 'left', duration: 0.5 },
      centred('Avant la coupe'),
      centred('Après la coupe', offCanvas),
    );
    const audit = () => page.evaluate(() => window.__cadence!.audit());
    await seek(page, 0.25);
    assert.deepEqual(await audit(), [], 'the outgoing scene alone, clean');
    await seek(page, 0.75);
    assert.deepEqual(await drawn(page), ['out', 'in']);
    assert.deepEqual(await audit(), [], 'both headings cross a canvas edge only because the cut moves them');
    await seek(page, 1.25);
    assert.deepEqual(
      (await audit()).map((f) => `${f.kind} ${f.text}`),
      ['offCanvas Hors cadre'],
      'the incoming scene alone is checked again',
    );
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
    assert.deepEqual((await page.evaluate(() => window.__cadence!.sounds()))[0], { at: 0.25, sound: 'pop', gain: 1 });
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

  it('judges the text of a motion blur once, at t, and leaves the copies out of the text budget', async () => {
    // 16 copies of 40 labels would take 640 of the 500 text nodes walked: the line after the blur would go unseen.
    await addScene(
      'audit-blur',
      `import { MotionBlur } from 'cadence';
const at = (left, top, style) => ({ position: 'absolute', left, top, margin: 0, ...style });
export default function Blurred({ t, fps }) {
  return (
    <div style={{ position: 'absolute', inset: 0, color: '#111111' }}>
      <MotionBlur t={t} fps={fps} samples={16} shutter={1}>
        {(time) => (
          <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
            {Array.from({ length: 40 }, (_, i) => (
              <span key={i} style={at(100 + (i % 8) * 200, 100 + Math.floor(i / 8) * 60, { fontSize: 32 })}>{i}</span>
            ))}
            <p style={at(100, 500, { fontSize: 40, color: '#bbbbbb' })}>Faint in the blur</p>
            <h2 style={at(1600 + 100 * time, 700, { fontSize: 80, whiteSpace: 'nowrap' })}>Half off canvas</h2>
          </div>
        )}
      </MotionBlur>
      <p style={at(1700, 900, { fontSize: 40, whiteSpace: 'nowrap' })}>After the blur, past the edge</p>
    </div>
  );
}
`,
    );
    await h.store.syncCode(id);
    const page = await open({ scene: 'audit-blur' });
    await seek(page, 0.25);
    const findings = await audit(page);
    await page.context().close();
    assert.deepEqual(kinds(findings), [
      'offCanvas Half off canvas',
      'offCanvas After the blur, past the edge',
      'contrast Faint in the blur',
    ]);
    assert.equal(findings[2].ratio, 1.92, 'judged on its own background, through the copies drawn over it');
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
    await page.goto(`${projectOrigin}/frame.html?project=${id}&scene=brand&format=16:9&mode=capture`);
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
    const frameUrl = `${projectOrigin}/frame.html?project=${id}&scene=throws&format=16:9&mode=editor`;
    await page.goto(h.editorPage(frameUrl));
    const ready = await waitFor(page, 'ready');
    assert.equal(ready.origin, projectOrigin);
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
    await page.goto(h.editorPage(`${projectOrigin}/frame.html?project=${id}&scene=bridge-sounds&format=16:9&mode=editor`));
    const first = await waitFor(page, 'sounds');
    assert.equal(first.origin, projectOrigin);
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
    await page.goto(h.editorPage(`${projectOrigin}/frame.html?project=${id}&scene=format-sounds&format=16:9&mode=editor`));
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
    await page.goto(h.editorPage(`${projectOrigin}/frame.html?project=${id}&format=16:9&mode=editor`));
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
      res.end(`<iframe id="frame" src="${projectOrigin}/frame.html?project=${id}&amp;mode=editor"></iframe>`);
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

describe('motion blur', () => {
  it('keeps static content pixel-identical and leaves a trail behind a moving square', async () => {
    const content = `<div style={{ position: 'absolute', inset: 0, background: '#1d4ed8' }}>
      <div style={{ position: 'absolute', left: 300, top: 200, width: 500, height: 300, borderRadius: 40,
        background: 'linear-gradient(90deg, rgba(255, 255, 255, 0.8), rgba(255, 0, 128, 0.4))' }} />
      <div style={{ position: 'absolute', left: 1000, top: 600, fontSize: 96, color: '#ffffff' }}>Static</div>
    </div>`;
    await addScene('blur-plain', `export default function Plain() {\n  return ${content};\n}\n`);
    await addScene(
      'blur-static',
      `import { MotionBlur } from 'cadence';
export default function Still({ t, fps }) {
  return <MotionBlur t={t} fps={fps} shutter={1}>{() => ${content}}</MotionBlur>;
}
`,
    );
    // 1200 px/s at 30 fps with a full shutter: 8 samples 5 canvas px apart, the square's left edge at 1000 px at 0.5 s.
    await addScene(
      'blur-move',
      `import { MotionBlur } from 'cadence';
export default function Move({ t, fps }) {
  return (
    <MotionBlur t={t} fps={fps} shutter={1}>
      {(time) => (
        <div style={{ position: 'absolute', inset: 0, background: '#000000' }}>
          <div style={{ position: 'absolute', left: 400 + 1200 * time, top: 440, width: 200, height: 200, background: '#ffffff', zIndex: 1 }} />
        </div>
      )}
    </MotionBlur>
  );
}
`,
    );
    await h.store.syncCode(id);

    const shot = async (scene: string) => {
      const page = await open({ scene });
      assert.deepEqual((await seek(page, 0.5)).errors, []);
      const png = await page.screenshot({ type: 'png' });
      await page.context().close();
      return PNG.sync.read(png).data;
    };
    const [plain, still] = [await shot('blur-plain'), await shot('blur-static')];
    assert.equal(still.length, plain.length);
    let worst = 0;
    for (let i = 0; i < plain.length; i++) worst = Math.max(worst, Math.abs(plain[i] - still[i]));
    assert.ok(worst <= 1, `static content changed by ${worst} levels`);

    const page = await open({ scene: 'blur-move' });
    await seek(page, 0.5);
    assert.ok(near(await colorAt(page, 1100, 540), [255, 255, 255]), 'covered by every sample');
    const trail = await colorAt(page, 980, 540);
    assert.ok(near(trail, [128, 128, 128], 3), `half the samples cover the trail: ${trail}`);
    assert.ok(near(await colorAt(page, 950, 540), [0, 0, 0]), 'behind the oldest sample');
    // The square's zIndex stays inside each copy: the leading edge is covered by 2 of the 8 samples, not by the copy at t alone.
    const lead = await colorAt(page, 1192, 540);
    assert.ok(near(lead, [64, 64, 64], 3), `two samples cover the leading edge: ${lead}`);
    await page.context().close();
  });
});

describe('music spectrum', () => {
  const track = 'music/track.mp3';
  const grid: MusicGridData = {
    bpm: 120,
    beatsPerBar: 4,
    beats: [0, 0.5, 1],
    downbeats: [0],
    phrases: [0],
    sections: [],
    accents: [],
    waveform: [],
    duration: 60,
    confidence: 1,
  };
  // 60 s at 25 rows a second; band b of row r is (r % 64) * 2 + b.
  const rows = 60 * 25;
  const bytes = Uint8Array.from({ length: rows * 24 }, (_, i) => (Math.floor(i / 24) % 64) * 2 + (i % 24));
  let start = 0;

  before(async () => {
    await addScene(
      'bars',
      'export default ({ t, music }) => <div id="bars" data-levels={JSON.stringify(music.spectrum(t, 4))} />;\n',
    );
    await addScene(
      'bars-name',
      `export default function Name({ t, music }) {
  try {
    music.spectrum(t);
    return <div id="name" data-name="" />;
  } catch (e) {
    return <div id="name" data-name={e.name} />;
  }
}
`,
    );
    await h.store.syncCode(id);
    start = (await h.store.get(id)).scenes.find((s) => s.id === 'bars')!.start;
  });

  /** Selects a track whose spectrum file holds `content` (none: no file), analysed or not; gives the project back after. */
  async function withTrack(content: Uint8Array | null, analysed: boolean, run: () => Promise<void>): Promise<void> {
    const dir = h.store.dir(id);
    const file = path.join(dir, 'project.json');
    const saved = await readFile(file, 'utf8');
    await mkdir(path.join(dir, 'music'), { recursive: true });
    await writeFile(path.join(dir, track), 'not really audio');
    if (content) await writeFile(path.join(dir, `${track}.spectrum.bin`), content);
    await writeFile(file, JSON.stringify({ ...(JSON.parse(saved) as ProjectFile), music: { file: track, start: 0, volume: 1 } }));
    if (analysed) {
      h.store.analysedMusic.set(id, {
        grid,
        spectrum: { bands: 24, rate: 25, file: `${track}.spectrum.bin`, size: bytes.length },
      });
    }
    try {
      await run();
    } finally {
      h.store.analysedMusic.delete(id);
      await writeFile(file, saved);
      await rm(path.join(dir, 'music'), { recursive: true, force: true });
    }
  }

  /** No error at scene time `t`, and the 4 groups of the 'bars' scene read `bytes` at that time, interpolated between
   * rows: earlier suites add scenes of 0.25 s, so the scene start is not always on a row. */
  async function assertRowAt(page: Page, t: number): Promise<void> {
    assert.deepEqual((await seek(page, t)).errors, []);
    const at = videoTime(start, t) * 25;
    const row = Math.floor(at);
    const w = at - row;
    const levels = JSON.parse((await page.getAttribute('#bars', 'data-levels'))!) as number[];
    assert.equal(levels.length, 4);
    for (const [g, level] of levels.entries()) {
      const band = (r: number) => ((r % 64) * 2 + 6 * g + 2.5) / 255;
      assert.ok(Math.abs(level - (band(row) * (1 - w) + band(row + 1) * w)) < 1e-6, `group ${g}: ${level}`);
    }
  }

  it('reads the spectrum file from the frame origin and gives music.spectrum(t) in scene time', async () => {
    await withTrack(bytes, true, async () => {
      const page = await open({ scene: 'bars' });
      const fetched: string[] = [];
      page.on('request', (r) => fetched.push(r.url()));
      await page.evaluate(() => window.__cadence!.reload());
      assert.ok(
        fetched.some((url) => url.startsWith(`${projectOrigin}/@fs${h.store.dir(id)}/${track}.spectrum.bin`)),
        fetched.join('\n'),
      );
      await assertRowAt(page, 0.4);
      await page.context().close();
    });
  });

  it('gives zeros without a track', async () => {
    const page = await open({ scene: 'bars' });
    assert.deepEqual((await seek(page, 0.4)).errors, []);
    assert.deepEqual(JSON.parse((await page.getAttribute('#bars', 'data-levels'))!), [0, 0, 0, 0]);
    await page.context().close();
  });

  it('drops the pending error on reload once the analysis wrote the spectrum', async () => {
    await withTrack(bytes, false, async () => {
      const page = await open({ scene: 'bars' });
      const { errors } = await seek(page, 0.4);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /l’analyse de la musique est en cours/);
      h.store.analysedMusic.set(id, {
        grid,
        spectrum: { bands: 24, rate: 25, file: `${track}.spectrum.bin`, size: bytes.length },
      });
      await page.evaluate(() => window.__cadence!.reload());
      await assertRowAt(page, 0.4);
      await page.context().close();
    });
  });

  it('turns a missing or truncated spectrum file into a translated load error', async () => {
    for (const [content, reason] of [
      [null, /HTTP 40\d/],
      [bytes.subarray(1), new RegExp(`${bytes.length - 1} octets au lieu de ${bytes.length}`)],
    ] as const) {
      await withTrack(content, true, async () => {
        const page = await open({ scene: 'green' });
        const { errors } = await seek(page, 0.2);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Impossible de charger le projet/);
        assert.match(errors[0], /Impossible de lire le spectre de la musique music\/track\.mp3\.spectrum\.bin/);
        assert.match(errors[0], reason);
        await page.context().close();
      });
    }
  });

  it('makes music.spectrum throw a named error while the analysis runs, and leaves other scenes alone', async () => {
    await withTrack(null, false, async () => {
      const page = await open({ scene: 'bars' });
      const { errors } = await seek(page, 0.4);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Erreur d’exécution · scenes\/bars\.tsx/);
      assert.match(errors[0], /music\.spectrum\(\) n’est pas encore disponible : l’analyse de la musique est en cours/);
      await page.evaluate(() => window.__cadence!.setScene('bars-name'));
      assert.deepEqual((await seek(page, 0.4)).errors, []);
      assert.equal(await page.getAttribute('#name', 'data-name'), 'MusicAnalysisPending');
      await page.evaluate(() => window.__cadence!.setScene('green'));
      assert.deepEqual((await seek(page, 0.2)).errors, []);
      await page.context().close();
    });
  });
});

describe('WebGL', () => {
  const TRIANGLE = `import { GLCanvas } from 'cadence';
const VERTEX = \`#version 300 es
uniform float angle;
const vec2 corners[3] = vec2[3](vec2(0.0, 0.8), vec2(-0.7, -0.6), vec2(0.7, -0.6));
void main() {
  vec2 p = corners[gl_VertexID];
  gl_Position = vec4(cos(angle) * p.x - sin(angle) * p.y, sin(angle) * p.x + cos(angle) * p.y, 0.0, 1.0);
}\`;
const FRAGMENT = \`#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(1.0, 0.0, 0.0, 1.0); }\`;
function draw(gl, t) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.uniform1f(gl.getUniformLocation(program, 'angle'), t * Math.PI);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
// draw does not clear: GLCanvas does, so the triangle of an earlier t never stays on the canvas.
export default ({ t, width, height }) => (
  <div style={{ background: '#000' }}>
    <GLCanvas t={t} width={width} height={height} draw={draw} />
  </div>
);
`;
  // Counts setups, renders and disposals on window: the test reads them back.
  const CUBE = `import { THREE, ThreeCanvas } from 'cadence/three';
function setup(renderer) {
  window.setups = (window.setups ?? 0) + 1;
  const dispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    window.disposals = (window.disposals ?? 0) + 1;
    dispose();
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#202040');
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  // Far enough for the whole cube to fit the width of 9:16 too.
  camera.position.set(0, 0, 10);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: '#ff8800' }));
  const light = new THREE.DirectionalLight('#ffffff', 3);
  light.position.set(2, 3, 4);
  scene.add(cube, light, new THREE.AmbientLight('#ffffff', 0.3));
  return { scene, camera, cube };
}
function render({ scene, camera, cube }, t, renderer, width, height) {
  window.renders = (window.renders ?? 0) + 1;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  cube.rotation.set(0.5 + t, t * 2, 0);
  renderer.render(scene, camera);
}
export default ({ t, width, height }) => (
  <ThreeCanvas t={t} width={width} height={height} setup={setup} render={(state, t, renderer) => render(state, t, renderer, width, height)} />
);
`;

  before(async () => {
    await addScene('triangle', TRIANGLE);
    await addScene('cube', CUBE);
    await h.store.syncCode(id);
  });

  /** Whether the scene's canvas has lost its WebGL context once the frame shows another scene. */
  async function lostOnUnmount(page: Page): Promise<boolean> {
    await page.evaluate(() => Reflect.set(window, 'unmounted', document.querySelector('canvas')));
    await page.evaluate(() => window.__cadence!.setScene('green'));
    assert.deepEqual((await seek(page, 0.2)).errors, []);
    return page.evaluate(() => (Reflect.get(window, 'unmounted') as HTMLCanvasElement).getContext('webgl2')!.isContextLost());
  }

  /** Whether the page fetched the bundled three module. */
  function loadedThree(page: Page): Promise<boolean> {
    return page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/deps\/three\.js/.test(e.name)));
  }

  it('draws a GLCanvas at t through the capture path, the same pixels for the same t', async () => {
    const capture = new PlaywrightCapture({ config: h.config, store: h.store });
    try {
      const [first, other, again] = await capture.frames(id, {
        sceneId: 'triangle',
        times: [0.2, 0.6, 0.2],
        format: '16:9',
        imageFormat: 'png',
      });
      for (const frame of [first, other, again]) assert.deepEqual(frame.errors, []);
      assert.ok(near(pixel(first.image, 480, 270), [255, 0, 0]), String(pixel(first.image, 480, 270)));
      assert.ok(near(pixel(first.image, 10, 10), [0, 0, 0]));
      assert.notDeepEqual(other.image, first.image, 'the triangle turns with t');
      assert.deepEqual(again.image, first.image);
    } finally {
      await capture.close();
    }
    const page = await open({ scene: 'triangle' });
    assert.deepEqual((await seek(page, 0.2)).errors, []);
    assert.deepEqual(
      await page.evaluate(() => [document.querySelector('canvas')!.width, document.querySelector('canvas')!.height]),
      [960, 540],
      'the drawing buffer follows the pixel ratio',
    );
    assert.equal(await loadedThree(page), false, 'a scene without cadence/three does not load three');
    assert.equal(await lostOnUnmount(page), true, 'the unmounted canvas gives its WebGL context back');
    await page.context().close();
  });

  it('sizes the drawing buffer to the preview scaled down to fit, not to the full canvas', async () => {
    for (const scene of ['triangle', 'cube']) {
      const page = await open({ scene, mode: 'editor' }, { width: 640, height: 360 });
      assert.deepEqual((await seek(page, 0.2)).errors, []);
      assert.deepEqual(
        await page.evaluate(() => [document.querySelector('canvas')!.width, document.querySelector('canvas')!.height]),
        [320, 180],
        `${scene}: 1920 x 1080 canvas px shown at a third of their size, at a pixel ratio of 0.5`,
      );
      if (scene === 'triangle')
        assert.ok(near(await colorAt(page, 320, 180), [255, 0, 0]), String(await colorAt(page, 320, 180)));
      await page.context().close();
    }
  });

  it('draws a lit three.js cube through the capture path, the same pixels for the same t', async () => {
    const capture = new PlaywrightCapture({ config: h.config, store: h.store });
    try {
      const [first, other, again] = await capture.frames(id, {
        sceneId: 'cube',
        times: [0.2, 0.6, 0.2],
        format: '16:9',
        imageFormat: 'png',
      });
      for (const frame of [first, other, again]) assert.deepEqual(frame.errors, []);
      const center = pixel(first.image, 480, 270);
      assert.ok(near(pixel(first.image, 10, 10), [32, 32, 64]), 'background');
      assert.ok(!near(center, [32, 32, 64], 10) && !near(center, [0, 0, 0], 10), `a lit cube: ${center}`);
      assert.notDeepEqual(other.image, first.image, 'the cube turns with t');
      assert.deepEqual(again.image, first.image);
    } finally {
      await capture.close();
    }
  });

  it('creates the three.js renderer once, without an animation loop, and disposes of it on unmount', async () => {
    const page = await open({ scene: 'cube' });
    const counts = () => page.evaluate(() => [Reflect.get(window, 'setups'), Reflect.get(window, 'disposals') ?? 0]);
    for (const t of [0.1, 0.5, 0.9]) assert.deepEqual((await seek(page, t)).errors, []);
    assert.equal(await loadedThree(page), true);
    assert.deepEqual(await counts(), [1, 0]);
    const renders = await page.evaluate(() => Reflect.get(window, 'renders'));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(await page.evaluate(() => Reflect.get(window, 'renders')), renders, 'nothing draws between renders');
    assert.equal(await lostOnUnmount(page), true, 'the unmounted canvas gives its WebGL context back');
    assert.deepEqual(await counts(), [1, 1]);
    await page.context().close();
  });

  it('draws on the whole canvas again after a format change', async () => {
    for (const scene of ['triangle', 'cube']) {
      const page = await open({ scene });
      assert.deepEqual((await seek(page, 0.2)).errors, []);
      const landscape = await colorAt(page, 960, 540);
      await page.setViewportSize({ width: 1080, height: 1920 });
      await page.evaluate(() => window.__cadence!.setFormat('9:16'));
      assert.deepEqual((await seek(page, 0.2)).errors, []);
      assert.ok(
        near(await colorAt(page, 540, 960), landscape, 10),
        `${scene}: ${await colorAt(page, 540, 960)} for ${landscape}`,
      );
      await page.context().close();
    }
  });

  it('keeps the cube in proportion after a format change, the camera following the size render gets', async () => {
    /** Width over height of what is not the background, in the page's screenshot. */
    async function cubeRatio(page: Page): Promise<number> {
      const image = PNG.sync.read(await page.screenshot({ type: 'png' }));
      let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const i = (image.width * y + x) * 4;
          if (near([image.data[i], image.data[i + 1], image.data[i + 2]], [32, 32, 64], 10)) continue;
          [left, right, top, bottom] = [Math.min(left, x), Math.max(right, x), Math.min(top, y), Math.max(bottom, y)];
        }
      }
      return (right - left) / (bottom - top);
    }
    const page = await open({ scene: 'cube' });
    assert.deepEqual((await seek(page, 0.2)).errors, []);
    const landscape = await cubeRatio(page);
    await page.setViewportSize({ width: 1080, height: 1920 });
    await page.evaluate(() => window.__cadence!.setFormat('9:16'));
    assert.deepEqual((await seek(page, 0.2)).errors, []);
    const portrait = await cubeRatio(page);
    assert.ok(Math.abs(portrait / landscape - 1) < 0.05, `${portrait} in 9:16 for ${landscape} in 16:9`);
    await page.context().close();
  });

  it('turns a lost WebGL context into a translated scene error', async () => {
    const page = await open({ scene: 'triangle' });
    assert.deepEqual((await seek(page, 0.2)).errors, []);
    await page.evaluate(() =>
      document.querySelector('canvas')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext(),
    );
    const { errors } = await seek(page, 0.3);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Erreur d’exécution · scenes\/triangle\.tsx/);
    assert.match(errors[0], /Le contexte WebGL a été perdu/);
    await page.context().close();
  });
});

describe('clip frames', () => {
  const skip = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 ? false : 'ffmpeg introuvable';

  it('extracts the frames of a real video and GIF, and the project origin serves them', { skip, timeout: 60_000 }, async () => {
    const dir = h.store.dir(id);
    const lavfi = (source: string, file: string, ...args: string[]) =>
      promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, ...args, path.join(dir, 'assets', file)]);
    await mkdir(path.join(dir, 'assets', 'loops'), { recursive: true });
    await lavfi(
      'testsrc2=size=320x240:rate=30:duration=1',
      'clip.mp4',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-pix_fmt',
      'yuv420p',
    );
    await lavfi('testsrc=size=200x100:rate=10:duration=1', 'loops/spin.gif');
    const clips = new LocalClipService({ config: h.config, store: h.store, hub: new RecordingHub() });
    try {
      await clips.whenIdle(id);
      const states = await clips.sync(id);
      const expected = {
        'clip.mp4': { fps: 30, frames: 30, width: 320, height: 240, audio: true },
        'loops/spin.gif': { fps: 10, frames: 10, width: 200, height: 100, audio: false },
      };
      for (const [rel, want] of Object.entries(expected)) {
        const state = states[rel];
        assert.ok(state?.status === 'ready', `${rel}: ${JSON.stringify(state)}`);
        const { fps, frames, width, height, audio, duration } = state;
        assert.deepEqual({ fps, frames, width, height, audio }, want, rel);
        assert.ok(Math.abs(duration - 1) < 0.1, `${rel}: ${duration}`);
        const folder = path.join(dir, 'clips', state.key);
        assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'clip.json'), 'utf8')), {
          fps,
          frames,
          width,
          height,
          duration,
          audio,
        });
        const files = (await readdir(folder)).filter((name) => name.endsWith('.jpg')).sort();
        assert.equal(files.length, want.frames);
        assert.equal(files.at(-1), `${String(want.frames).padStart(6, '0')}.jpg`);
        const served = await request(`/@fs${path.join(folder, '000001.jpg')}`);
        assert.equal(served.status, 200);
        assert.match(String(served.headers['content-type']), /^image\/jpeg/);
      }
    } finally {
      await rm(path.join(dir, 'assets', 'clip.mp4'), { force: true });
      await rm(path.join(dir, 'assets', 'loops'), { recursive: true, force: true });
      await rm(path.join(dir, 'clips'), { recursive: true, force: true });
    }
  });

  it(
    'shows the clip frame at the scene time, the same on every run, and reports a frame that does not load',
    { skip, timeout: 90_000 },
    async () => {
      const dir = h.store.dir(id);
      await mkdir(path.join(dir, 'assets', 'clips-e2e'), { recursive: true });
      await promisify(execFile)('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p'],
        path.join(dir, 'assets', 'clips-e2e', 'test src.mp4'),
      ]);
      const clips = new LocalClipService({ config: h.config, store: h.store, hub: new RecordingHub() });
      h.store.setClipsProvider((project) => clips.sync(project));
      const style = "{{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}";
      // A broken <img> that is no clip frame is not reported: only <Clip> frames are.
      await addScene(
        'clip-play',
        `import { Clip } from 'cadence';\nexport default function Play({ t }) {\n  return <><img src="/nowhere.png" alt="" /><Clip src="clips-e2e/test src.mp4" time={t} style=${style} /></>;\n}\n`,
      );
      await addScene(
        'clip-unknown',
        `import { Clip } from 'cadence';\nexport default function Unknown({ t }) {\n  return <Clip src="clips-e2e/missing.mp4" time={t} />;\n}\n`,
      );
      try {
        await clips.whenIdle(id);
        await h.store.syncCode(id);
        const shot = async (time: number) => {
          const page = await open({ scene: 'clip-play' });
          assert.deepEqual((await seek(page, time)).errors, []);
          const png = await page.screenshot({ type: 'png' });
          await page.context().close();
          return createHash('sha256').update(png).digest('hex');
        };
        const [early, late] = [await shot(0.2), await shot(0.6)];
        assert.notEqual(early, late, 'two times show two source frames');
        assert.equal(await shot(0.2), early, 'a second run shows the same frame');
        assert.equal(await shot(0.6), late, 'a second run shows the same frame');

        const unknown = await open({ scene: 'clip-unknown' });
        const { errors } = await seek(unknown, 0.2);
        assert.ok(
          errors.some((error) => error.includes('<Clip>') && error.includes('assets/clips-e2e/missing.mp4')),
          JSON.stringify(errors),
        );
        await unknown.context().close();

        // 0.5 s and 0.8 s show source frames 16 and 25 (files numbered from 1).
        const { key } = (await clips.sync(id))['clips-e2e/test src.mp4'] as { key: string };
        await rm(path.join(dir, 'clips', key, '000016.jpg'));
        await writeFile(path.join(dir, 'clips', key, '000025.jpg'), 'not a jpeg');
        for (const [time, frame] of [
          [0.5, '000016.jpg'],
          [0.8, '000025.jpg'],
        ] as const) {
          const page = await open({ scene: 'clip-play' });
          const result = await seekFrame(page, time);
          assert.ok(
            result.errors.some(
              (error) => error.includes('<Clip>') && error.includes('assets/clips-e2e/test src.mp4') && error.includes(frame),
            ),
            `${time} s: ${JSON.stringify(result.errors)}`,
          );
          assert.deepEqual(await page.evaluate(() => window.__cadence!.errors()), result.errors, 'the editor shows them too');
          await page.context().close();
        }
      } finally {
        h.store.setClipsProvider(async () => ({}));
        await removeScenes('clip-play', 'clip-unknown');
        await rm(path.join(dir, 'assets', 'clips-e2e'), { recursive: true, force: true });
        await rm(path.join(dir, 'clips'), { recursive: true, force: true });
      }
    },
  );

  it(
    'a scene showing a preparing clip shows its frame after reload once the clip is ready',
    { skip, timeout: 90_000 },
    async () => {
      const dir = h.store.dir(id);
      await mkdir(path.join(dir, 'assets', 'clips-e2e'), { recursive: true });
      await promisify(execFile)('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-pix_fmt', 'yuv420p'],
        path.join(dir, 'assets', 'clips-e2e', 'ready.mp4'),
      ]);
      const clips = new LocalClipService({ config: h.config, store: h.store, hub: new RecordingHub() });
      h.store.setClipsProvider(async () => ({ 'clips-e2e/ready.mp4': { status: 'preparing' } }));
      await addScene(
        'clip-ready',
        `import { Clip } from 'cadence';\nexport default function Ready({ t }) {\n  return <Clip src="clips-e2e/ready.mp4" time={t} />;\n}\n`,
      );
      try {
        await h.store.syncCode(id);
        const page = await open({ scene: 'clip-ready' });
        const preparing = (await seek(page, 0.2)).errors;
        assert.ok(
          preparing.some((error) => error.includes('assets/clips-e2e/ready.mp4') && /en cours d.extraction/.test(error)),
          JSON.stringify(preparing),
        );

        await clips.whenIdle(id);
        h.store.setClipsProvider((projectId) => clips.sync(projectId));
        // What the editor does on project-changed, which a clip becoming ready sends.
        await page.evaluate((g) => window.__cadence!.reload(g), h.store.generation(id));
        assert.deepEqual((await seek(page, 0.2)).errors, []);
        assert.equal(
          await page.evaluate(() => document.querySelector<HTMLImageElement>('img[data-cadence-clip]')?.naturalWidth),
          320,
          'the frame is drawn',
        );
        await page.context().close();
      } finally {
        h.store.setClipsProvider(async () => ({}));
        await removeScenes('clip-ready');
        await rm(path.join(dir, 'assets', 'clips-e2e'), { recursive: true, force: true });
        await rm(path.join(dir, 'clips'), { recursive: true, force: true });
      }
    },
  );
});
