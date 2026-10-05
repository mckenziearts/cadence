// editorRoot: a host app builds the editor from its own page and CSS, importing the core through src/editor/index.ts.
// The host fixture lives in a temp dir with its own copies of react, react-dom and scheduler, as a real host would.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { builtEditor } from '../../server/editor';
import { m } from '../../server/i18n';
import { startServer, type RunningServer } from '../../server/index';
import { makeRoot, type TestRoot } from './helpers';

const repo = path.resolve(import.meta.dirname, '../..');
const HOST_PAGE = 'Host page marker';
let t: TestRoot;
let host: string;
let server: RunningServer;
let coreServer: http.Server;
let hostBuild: { html: string; js: string; css: string };
let coreBuild: { html: string; js: string; css: string };

async function writeHost(dir: string): Promise<void> {
  const src = path.join(dir, 'src');
  const core = path.relative(src, path.join(repo, 'src/editor'));
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html>\n<html>\n  <head><title>Host</title></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
  );
  await fs.writeFile(
    path.join(src, 'main.tsx'),
    `import { createRoot } from 'react-dom/client';\nimport { App } from '${core}/index';\nimport './styles.css';\n\nfunction X() {\n  return <p>${HOST_PAGE}</p>;\n}\n\ncreateRoot(document.getElementById('root')!).render(\n  <div className="bg-[#c0ffee]">\n    <App pages={{ '@x': X }} />\n  </div>,\n);\n`,
  );
  await fs.writeFile(path.join(src, 'styles.css'), `@import '${core}/styles.css';\n@source './';\n`);
  for (const name of ['react', 'react-dom', 'scheduler'])
    await fs.cp(path.join(repo, 'node_modules', name), path.join(dir, 'node_modules', name), { recursive: true });
}

/** The page and the concatenated JS and CSS it links to. */
async function load(html: string, origin: string) {
  const text = async (ext: string) => {
    const files = [...html.matchAll(/\/assets\/[\w.-]+\.(js|css)/g)].filter((match) => match[1] === ext);
    return (await Promise.all(files.map(async ([file]) => (await fetch(origin + file)).text()))).join('\n');
  };
  return { html, js: await text('js'), css: await text('css') };
}

const reactElements = (js: string) => js.split('react.transitional.element').length - 1;

before(async () => {
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(repo, 'node_modules/.vite-e2e/editor-root');
  t = await makeRoot();
  // Real path: on macOS the temp dir is a symlink, and Vite resolves the relative barrel import from the real one.
  host = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-host-')));
  await writeHost(host);
  const provider = {
    id: 'fake',
    label: 'Agent de test',
    status: async () => ({ ok: true, label: 'Agent de test' }),
    async *run() {
      yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
    },
  };
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  server = await startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    provider,
    editorRoot: host,
  });
  const { editorOrigin } = server.config;
  hostBuild = await load(await (await fetch(`${editorOrigin}/`)).text(), editorOrigin);

  const core = await builtEditor(repo);
  coreServer = http.createServer((req, res) => core.serve(req, res));
  await new Promise<void>((resolve) => coreServer.listen(0, '127.0.0.1', resolve));
  coreBuild = await load(await core.html('/'), `http://127.0.0.1:${(coreServer.address() as AddressInfo).port}`);
});

after(async () => {
  await server?.close();
  coreServer?.close();
  await t?.cleanup();
  if (host) await fs.rm(host, { recursive: true, force: true });
});

test('startServer builds the editor from editorRoot', () => {
  assert.match(hostBuild.html, /<title>Host<\/title>/);
  assert.match(hostBuild.html, /<meta name="cadence-token"/);
  assert.match(coreBuild.html, /<title>Cadence<\/title>/);
});

test('the host CSS keeps the core classes and adds its own', () => {
  assert.ok(hostBuild.css.includes('#c0ffee'), 'host @source scanned');
  const coreOnly = /grid-template-columns:\s*220px minmax\(0,\s*1fr\)/;
  assert.match(coreBuild.css, coreOnly);
  assert.match(hostBuild.css, coreOnly, 'core @source kept');
});

test('the host bundle holds one React, like the core editor', () => {
  const count = reactElements(coreBuild.js);
  assert.ok(count > 0);
  assert.equal(reactElements(hostBuild.js), count);
});

test('the host bundle carries its pages', () => {
  assert.ok(hostBuild.js.includes(HOST_PAGE));
});

test('a host page opens from the hash, an unknown page goes home', async (t) => {
  const browser = await chromium.launch().catch(() => null);
  if (!browser) return t.skip('Chromium missing (npm run setup)');
  try {
    const page = await browser.newPage();
    await page.goto(`${server.config.editorOrigin}/#/@x`);
    await page.getByText(HOST_PAGE, { exact: true }).waitFor({ timeout: 30_000 });
    await page.goto(`${server.config.editorOrigin}/#/@nope`);
    await page.waitForFunction(() => location.hash === '#/', null, { timeout: 30_000 });
    assert.equal(await page.getByText(HOST_PAGE, { exact: true }).count(), 0);
  } finally {
    await browser.close();
  }
});

test('dev mode refuses an editorRoot', async () => {
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  const options = { projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0, quiet: true };
  await assert.rejects(startServer({ ...options, dev: true, editorRoot: host }), { message: m().core.editorRootDev });
});
