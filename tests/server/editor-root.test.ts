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
import type { BrandSource, HostBrandSource } from '../../server/contracts';
import { startServer, type RunningServer } from '../../server/index';
import { makeRoot, type TestRoot } from './helpers';

const repo = path.resolve(import.meta.dirname, '../..');
const HOST_PAGE = 'Host page marker';
const NEW_BRAND_PAGE = 'Host new brand page';
const NEW_BRAND_HINT = 'From the host sources';
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
    `import { createRoot } from 'react-dom/client';
import { App, Profile, api, openNewBrand, redo, undo } from '${core}/index';
import './styles.css';

// A host Edit menu calls the core steps: the build fails if index.ts stops exporting them.
function X() {
  return (
    <div>
      <p>${HOST_PAGE}</p>
      <button onClick={() => void undo()}>Undo</button>
      <button onClick={() => void redo()}>Redo</button>
    </div>
  );
}

const build = (input: Parameters<typeof api.startBrandBuild>[0]) =>
  void api.startBrandBuild(input).then((b) => openNewBrand(b.id));

function NewBrand() {
  return (
    <div>
      <p>${NEW_BRAND_PAGE}</p>
      <button onClick={() => openNewBrand()}>Repositories</button>
      <button onClick={() => build({ source: 'site', ref: 'r1', name: 'Host brand' })}>From the host</button>
      <button onClick={() => build({ repo: 'acme/host-site', name: 'Repository brand' })}>From a repository</button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div className="bg-[#c0ffee]">
    <App pages={{ '@x': X, '@moi': () => <Profile />, '@new': NewBrand }} newBrand="@new" newBrandHint="${NEW_BRAND_HINT}" profile={false} />
  </div>,
);
`,
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

/** One repository to pick; its copy fails, so the build ends in error without an agent turn. */
const github: BrandSource = {
  account: async () => ({ available: true, account: 'host' }),
  repos: async () => ({
    available: true,
    account: 'host',
    repos: [
      {
        fullName: 'acme/host-site',
        description: null,
        private: false,
        pushedAt: '2026-10-01T10:00:00Z',
        url: 'https://github.com/acme/host-site',
        homepage: null,
      },
    ],
  }),
  fetch: async () => {
    throw new Error('copy failed');
  },
};
const gitlab: BrandSource = {
  account: async () => ({ available: false, reason: 'missing' }),
  repos: async () => ({ available: false, reason: 'missing' }),
  fetch: async () => undefined,
};
/** A brand source of the host app whose fill fails. */
const site: HostBrandSource = {
  describe: async (ref) => ({ label: `Site ${ref}` }),
  fill: async () => {
    throw new Error('fill failed');
  },
};

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
    brandSources: { github, gitlab },
    hostBrandSources: { site },
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

test('a host page opens from the hash, the core Profile too, an unknown page goes home', async (t) => {
  const browser = await chromium.launch().catch(() => null);
  if (!browser) return t.skip('Chromium missing (npm run setup)');
  try {
    const page = await browser.newPage();
    await page.goto(`${server.config.editorOrigin}/#/@x`);
    await page.getByText(HOST_PAGE, { exact: true }).waitFor({ timeout: 30_000 });
    // The host took the Profile entry off the top bar (profile={false}); the rest of the bar stays.
    const bar = page.getByRole('banner');
    await bar.getByRole('button', { name: /^(Réglages|Settings)$/ }).waitFor();
    assert.equal(await bar.getByRole('button', { name: /^Profile?$/ }).count(), 0);
    await page.goto(`${server.config.editorOrigin}/#/@moi`);
    await page.getByRole('listitem', { name: 'YouTube' }).waitFor({ timeout: 30_000 });
    await page.goto(`${server.config.editorOrigin}/#/@nope`);
    await page.waitForFunction(() => location.hash === '#/', null, { timeout: 30_000 });
    assert.equal(await page.getByText(HOST_PAGE, { exact: true }).count(), 0);
  } finally {
    await browser.close();
  }
});

test('the New brand card says what the host page builds from, opens it, and its buttons open the repository modal and a build', async (t) => {
  const browser = await chromium.launch().catch(() => null);
  if (!browser) return t.skip('Chromium missing (npm run setup)');
  try {
    const page = await browser.newPage();
    const dialog = page.getByRole('dialog');
    await page.goto(`${server.config.editorOrigin}/#/`);
    await page.getByRole('button', { name: /^(Créer un projet|Create a project)$/ }).click({ timeout: 30_000 });
    const card = dialog.getByRole('button', { name: /Nouvelle marque|New brand/ });
    assert.ok((await card.textContent())?.includes(NEW_BRAND_HINT));
    assert.doesNotMatch(
      (await card.textContent()) ?? '',
      /Depuis un dépôt GitHub|From a GitHub repository/,
      'the host hint replaces the core line',
    );
    await card.click();
    await page.getByText(NEW_BRAND_PAGE, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#/@new');
    assert.equal(await dialog.count(), 0, 'the card closed the new project modal');

    await page.getByRole('button', { name: 'Repositories', exact: true }).click();
    await dialog.getByRole('button', { name: /acme\/host-site/ }).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    const failed = page.getByRole('heading', { name: /^(La marque n’a pas pu être construite|The brand could not be built)$/ });
    const restart = dialog.getByRole('button', { name: /^(Recommencer|Start over)$/ });
    await page.getByRole('button', { name: 'From the host', exact: true }).click();
    await dialog.getByText(/^(Depuis|From) Site r1$/).waitFor();
    await failed.waitFor({ timeout: 30_000 });
    assert.equal(await restart.count(), 0, 'a host source build has no Restart');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'From a repository', exact: true }).click();
    await dialog.getByText(/^(Depuis|From) acme\/host-site$/).waitFor();
    await failed.waitFor({ timeout: 30_000 });
    await restart.waitFor();
  } finally {
    await browser.close();
  }
});

test('dev mode refuses an editorRoot', async () => {
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  const options = { projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0, quiet: true };
  await assert.rejects(startServer({ ...options, dev: true, editorRoot: host }), { message: m().core.editorRootDev });
});
