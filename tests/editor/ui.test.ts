// The editor and the frame page in a real Chromium, against the whole server (fake agent, no Claude turn). Projects
// live in projects/e2e-editor-<pid>-* and are removed at the end. Needs Chromium (npm run setup).
// node --import tsx --test tests/editor/ui.test.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import type { AgentProvider, BrandSource } from '../../server/contracts';
import type { Soundtrack } from '../../server/music/soundtracks';
import { startServer, type RunningServer } from '../../server/index';
import type { AppState, ChatState, MusicAnalysis, MusicGridData, ProjectState } from '../../src/shared/types';
import { fakeNetwork } from '../server/helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREFIX = `e2e-editor-${process.pid}`;
const A = `${PREFIX}-a`;
const B = `${PREFIX}-b`;
const SEAM_SUGGESTION = 'Fais correspondre la première image à la dernière de la scène précédente pour une coupe invisible.';
const NBSP = ' ';

const provider: AgentProvider = {
  id: 'fake',
  label: 'Agent factice',
  status: async () => ({ ok: true, label: 'Agent factice' }),
  async *run(turn) {
    yield { type: 'init', sessionId: turn.sessionId };
    yield { type: 'text', text: 'Réponse factice.' };
    yield { type: 'done', text: 'Réponse factice.', isError: false, durationMs: 1 };
  },
};

/** The brand test releases the copy once it has seen the build at its first step in the top bar. */
let releaseCopy!: () => void;
const copyReleased = new Promise<void>((resolve) => (releaseCopy = resolve));

/** Two repositories through a pretend gh login; the copy is a README (Claude is the fake agent above). */
const brandSource: BrandSource = {
  account: async () => ({ available: true, account: 'e2e' }),
  repos: async () => ({
    available: true,
    account: 'e2e',
    repos: [
      {
        fullName: 'acme/e2e-site',
        description: 'Le site de test',
        private: true,
        pushedAt: '2026-09-30T10:00:00Z',
        url: 'https://github.com/acme/e2e-site',
        homepage: null,
      },
      {
        fullName: 'acme/e2e-api',
        description: null,
        private: false,
        pushedAt: '2026-09-29T10:00:00Z',
        url: 'https://github.com/acme/e2e-api',
        homepage: null,
      },
    ],
  }),
  async fetch(_repo, dest, signal) {
    // A cancel (the server closing) lets go too, like a real copy.
    await Promise.race([copyReleased, new Promise((resolve) => signal.addEventListener('abort', resolve))]);
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, 'README.md'), '# Site de test\n');
  },
};
const BRAND_NAME = `E2E Marque ${process.pid}`;
const BRAND_ID = `e2e-marque-${process.pid}`;
/** No glab on the pretend machine. */
const glabMissing: BrandSource = {
  account: async () => ({ available: false, reason: 'missing' }),
  repos: async () => ({ available: false, reason: 'missing' }),
  fetch: async () => undefined,
};
const stateDir = path.join(os.tmpdir(), `cadence-e2e-state-${process.pid}`);

let server: RunningServer;
let browser: Browser;

async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${server.config.editorOrigin}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': server.editorToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${pathname}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A 1440×900 page. Filmstrip thumbnails are refused: none of these checks needs the server to capture scenes. */
async function newPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' });
  await context.route('**/thumbnail?**', (route) => route.abort());
  return context.newPage();
}

/** The editor on a project (and scene), once its layout is there. */
async function open(hash: string, page?: Page): Promise<Page> {
  page ??= await newPage();
  await page.goto(`${server.config.editorOrigin}/#/${hash}`);
  await page.getByRole('group', { name: 'Panneau' }).waitFor({ timeout: 60_000 });
  return page;
}

const panel = (page: Page, name: string) => page.getByRole('group', { name: 'Panneau' }).getByRole('button', { name }).click();

/** Answers the page's GET of project A through `edit` (music, code generation) without touching the files. */
async function rewriteProject(page: Page, edit: (project: ProjectState) => ProjectState): Promise<void> {
  await page.route(`**/api/projects/${A}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, json: edit((await response.json()) as ProjectState) });
  });
}

before(
  async () => {
    // Own dependency cache: never disturb the optimizer of a Cadence the user is running.
    process.env.CADENCE_VITE_CACHE_DIR ??= path.join(ROOT, 'node_modules/.vite-e2e/editor');
    server = await startServer({
      editorPort: 0,
      framePort: 0,
      quiet: true,
      provider,
      brandSources: { github: brandSource, gitlab: glabMissing },
      networks: { youtube: fakeNetwork() },
      root: ROOT,
      // The YouTube keys and tokens of the test stay out of this machine's .cadence/accounts.json.
      stateDir,
    });
    browser = await chromium.launch();
    for (const [id, name] of [
      [A, 'Éditeur A'],
      [B, 'Éditeur B'],
    ]) {
      await api('POST', '/api/projects', { name, id, brand: 'cadence', formats: ['16:9', '9:16'], fps: 30 });
    }
    // 120 BPM without music: 1 bar = 2 s from each scene start. « Deuxième » (3 s = 1,5 mes.) ends mid-bar.
    await api('POST', `/api/projects/${A}/scenes`, { name: 'Deuxième', duration: 3 });
    // B's scene chat has a conversation; both projects open on their « titre » scene, so on the same chat key.
    await api('POST', `/api/projects/${B}/chats/scene:titre/messages`, { text: 'Message de B' });
    for (let i = 0; i < 300; i++) {
      const chat = await api<ChatState>('GET', `/api/projects/${B}/chats/scene:titre`);
      if (!chat.running && !chat.queued) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  { timeout: 180_000 },
);

after(async () => {
  await browser?.close();
  if (!server) return;
  // Seam checks the API started in the background hold capture pages: let them end before closing.
  await server.services.seams.check(A).catch(() => undefined);
  await server.close();
  const { projectsDir, brandsDir, stateDir } = server.config;
  for (const dir of [projectsDir, path.join(projectsDir, '.trash')]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(PREFIX)) await rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
  for (const dir of [brandsDir, path.join(stateDir, 'trash', 'brands')]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(BRAND_ID)) await rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
  await rm(stateDir, { recursive: true, force: true });
});

describe('editor', () => {
  it('reloads the scene chat when a project opens on the same chat key', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/titre`);
    await page.getByText('Suggestions', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Éditeur A' }).click();
    await page.getByRole('combobox', { name: 'Rechercher un projet' }).fill(B);
    await page.keyboard.press('Enter');
    await page.getByText('Message de B').waitFor({ timeout: 10_000 });
    assert.equal(await page.getByLabel('Chargement de la conversation').count(), 0);
    await page.context().close();
  });

  it('opens a project once when asked again while it loads, so the scene chat loads', { timeout: 90_000 }, async () => {
    const page = await newPage();
    let loads = 0;
    let firstLoad!: () => void;
    const loading = new Promise<void>((resolve) => (firstLoad = resolve));
    await page.route(`**/api/projects/${A}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      // A slow first load: the hash change below asks for the project again meanwhile (so does React's development
      // mode, which boots the editor twice). The first answer, last to come, used to empty the chats the second filled.
      if (++loads === 1) {
        firstLoad();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return route.fallback();
    });
    await page.goto(`${server.config.editorOrigin}/#/${A}/titre`);
    await loading;
    await page.evaluate((id) => (location.hash = `#/${id}`), A);
    await page.getByText('Suggestions', { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2000);
    assert.equal(await page.getByLabel('Chargement de la conversation').count(), 0);
    await page.context().close();
  });

  it('keeps the end of a turn when the answer to the message comes after it', { timeout: 90_000 }, async () => {
    const page = await open(`${B}/titre`);
    await page.getByText('Message de B').waitFor({ timeout: 10_000 });
    await page.route(`**/api/projects/${B}/chats/scene:titre/messages`, async (route) => {
      const response = await route.fetch();
      // Held until the events brought the whole turn: this answer is older, and used to bring back « Arrêter ».
      await page.getByText('Réponse factice.').nth(1).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Arrêter' }).waitFor({ state: 'detached', timeout: 30_000 });
      await route.fulfill({ response });
    });
    const answered = page.waitForResponse((r) => r.url().endsWith('/messages') && r.request().method() === 'POST');
    await page.getByRole('textbox', { name: 'Message pour la scène' }).fill('Encore un essai');
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await answered;
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('button', { name: 'Arrêter' }).count(), 0);
    await page.context().close();
  });

  it('runs the preview in its own process: the frame origin is another site', { timeout: 90_000 }, async () => {
    // Chrome isolates sites; the headless shell of the tests only does with this switch.
    const isolated = await chromium.launch({ args: ['--site-per-process'] });
    try {
      const page = await isolated.newPage({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' });
      await page.route('**/thumbnail?**', (route) => route.abort());
      await open(`${A}/titre`, page);
      await page.frameLocator('iframe[src*="/frame.html"]').locator('#root').waitFor({ state: 'attached' });
      // An out-of-process iframe is a target of its own; a same-process one is not.
      const cdp = await isolated.newBrowserCDPSession();
      const { targetInfos } = await cdp.send('Target.getTargets');
      const frame = targetInfos.find((target) => target.type === 'iframe' && target.url.includes('/frame.html'));
      assert.ok(frame?.url.startsWith(`${server.config.frameOrigin}/frame.html`), JSON.stringify(targetInfos));
      assert.equal(new URL(server.config.frameOrigin).hostname, 'localhost');
    } finally {
      await isolated.close();
    }
  });

  it('shows the brand kit from the frame origin: no brand code runs in the editor page', { timeout: 90_000 }, async () => {
    const page = await newPage();
    const fromEditor: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === server.config.editorOrigin && /^\/(brands\/|kit\.html)/.test(url.pathname)) {
        fromEditor.push(url.pathname);
      }
    });
    await open(A, page);
    await page.getByRole('button', { name: 'Cadence', exact: true }).click();
    // Extras and copy come from the kit page, which loaded the kit; the editor only lists them.
    await page.getByText('ProfileCard', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByText(/Written to the millisecond/).waitFor();
    // The brand fonts, loaded from the frame origin under Cadence's own names (never the kit's CSS).
    await page.waitForFunction(() =>
      [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Cadence brand cadence display' && f.status === 'loaded'),
    );
    const sheet = page.locator('iframe[title="Composants du kit"]');
    await sheet.contentFrame().getByText('Olivia Martin').first().waitFor();
    // The sheet reports its size once in view (Chrome does not lay out a cross-origin iframe out of view): the panel
    // scales it and drops the placeholder.
    await sheet.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const box = document.querySelector('iframe[title="Composants du kit"]')?.parentElement;
      return box && !box.classList.contains('skeleton');
    });
    const kits = page.frames().filter((frame) => frame.url().includes('/kit.html'));
    assert.equal(kits.length, 4, 'the sheet and the three extras of the Cadence brand');
    for (const kit of kits) assert.ok(kit.url().startsWith(`${server.config.frameOrigin}/kit.html?brand=cadence&view=`));
    assert.deepEqual(fromEditor, []);
    await page.context().close();
  });

  it('opens on the projects home: a card opens its project, the logo and Back come home', { timeout: 90_000 }, async () => {
    const page = await newPage();
    await page.goto(`${server.config.editorOrigin}/`);
    await page.getByRole('heading', { name: 'Projets' }).waitFor({ timeout: 60_000 });
    const search = page.getByRole('searchbox', { name: 'Rechercher un projet' });
    await search.fill('Éditeur B');
    assert.equal(await page.getByRole('link', { name: /Éditeur A/i }).count(), 0);
    await search.fill('');
    await page.getByRole('link', { name: /Éditeur A/i }).click();
    await page.getByRole('group', { name: 'Panneau' }).waitFor({ timeout: 60_000 });
    assert.equal(new URL(page.url()).hash, `#/${A}/titre`);
    await page.getByRole('link', { name: 'Cadence, accueil des projets' }).click();
    await page.getByRole('heading', { name: 'Projets' }).waitFor();
    await page.goBack();
    await page.getByRole('group', { name: 'Panneau' }).waitFor();
    await page.context().close();
  });

  it('builds a brand from a GitHub repository and offers it for a new project', { timeout: 120_000 }, async () => {
    const page = await open(`${A}/titre`);
    await page.getByRole('button', { name: 'Nouveau projet' }).click();
    await page.getByRole('button', { name: /Nouvelle marque/ }).click();
    await page.getByText('Connecté en tant que @e2e').waitFor();
    await page.getByRole('searchbox', { name: 'Rechercher un dépôt' }).fill('site');
    assert.equal(await page.getByRole('button', { name: /acme\/e2e-api/ }).count(), 0);
    await page.getByRole('button', { name: /acme\/e2e-site/ }).click();
    assert.equal(await page.getByLabel('Nom de la marque').inputValue(), 'E2e Site');
    await page.getByLabel('Nom de la marque').fill(BRAND_NAME);
    await page.getByRole('button', { name: 'Construire la marque' }).click();
    // Closed, the build stays in the top bar: its step while it runs, then « Prête » until its window shows it.
    await page.getByRole('heading', { name: `Construction de « ${BRAND_NAME} »` }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Fermer', exact: true }).last().click();
    await page.getByRole('button', { name: `Marque « ${BRAND_NAME} » : Copie` }).waitFor();
    releaseCopy();
    // The fake agent changes nothing: the neutral kit, under this brand's id and name, passes every check.
    await page.getByRole('button', { name: `Marque « ${BRAND_NAME} » : Prête` }).click({ timeout: 90_000 });
    await page.getByRole('heading', { name: `Marque « ${BRAND_NAME} » prête` }).waitFor();
    await page.getByText('Réponse factice.').waitFor();
    const brand = JSON.parse(await readFile(path.join(server.config.brandsDir, BRAND_ID, 'brand.json'), 'utf8'));
    assert.deepEqual([brand.id, brand.name], [BRAND_ID, BRAND_NAME]);
    await page.getByRole('button', { name: 'Créer un projet avec cette marque' }).click();
    await page.getByRole('button', { name: new RegExp(BRAND_NAME), pressed: true }).hover();
    // Built by mistake, it goes from its card: the choice falls back to the neutral kit.
    await page.getByRole('button', { name: `Supprimer la marque « ${BRAND_NAME} »` }).click();
    await page.getByRole('button', { name: 'Supprimer ?' }).click();
    await page.getByRole('button', { name: new RegExp(`^${BRAND_NAME}`) }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /^Cadence/, pressed: true }).waitFor();
    const trashed = await readdir(path.join(server.config.stateDir, 'trash', 'brands'));
    assert.ok(trashed.some((name) => name.startsWith(`${BRAND_ID}-`)));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(
      await page.getByRole('button', { name: `Marque « ${BRAND_NAME} » :` }).count(),
      0,
      'seen, the build left the top bar',
    );
    await page.context().close();
  });

  it('deletes a project from its home card, once confirmed', { timeout: 90_000 }, async () => {
    const C = `${PREFIX}-c`;
    await api('POST', '/api/projects', { name: 'Éditeur C', id: C, brand: 'cadence', formats: ['16:9'], fps: 30 });
    const page = await newPage();
    await page.goto(`${server.config.editorOrigin}/`);
    await page.getByRole('link', { name: /Éditeur C/ }).hover({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Supprimer le projet « Éditeur C »' }).click();
    await page.getByRole('button', { name: 'Supprimer le projet ?' }).click();
    await page.getByRole('link', { name: /Éditeur C/ }).waitFor({ state: 'detached' });
    assert.ok((await readdir(path.join(server.config.projectsDir, '.trash'))).some((name) => name.startsWith(`${C}-`)));
    await page.context().close();
  });

  it('connects YouTube from the Profile page, then publishes an exported video from Rendu', { timeout: 120_000 }, async () => {
    const page = await newPage();
    await page.goto(`${server.config.editorOrigin}/`);
    await page.getByRole('button', { name: 'Profil', exact: true }).click({ timeout: 60_000 });
    await page.getByRole('heading', { name: 'Profil', exact: true }).waitFor();
    assert.match(page.url(), /#\/@profil$/);
    await page.getByText('e2e (via gh)').waitFor();
    await page.getByText('glab n’est pas installé').waitFor();
    await page.getByRole('listitem', { name: 'YouTube' }).getByRole('button', { name: 'Configurer' }).click();
    const keys = page.getByRole('dialog');
    await keys.getByLabel('ID client').fill('e2e-client');
    await keys.getByLabel('Code secret').fill('e2e-secret');
    await keys.getByRole('button', { name: 'Enregistrer' }).click();
    await keys.waitFor({ state: 'detached' });
    // The fake consent page is the callback itself: the tab says it worked, the profile shows the channel.
    const [tab] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Connecter la chaîne' }).click(),
    ]);
    await tab.getByRole('heading', { name: 'YouTube connecté' }).waitFor();
    await page.getByRole('link', { name: 'Chaîne E2E' }).waitFor();
    assert.ok(!JSON.stringify(await api<AppState>('GET', '/api/state')).includes('e2e-secret'));

    const renders = path.join(server.config.projectsDir, A, 'renders');
    await mkdir(renders, { recursive: true });
    await writeFile(path.join(renders, `${A}-16x9-e2e.mp4`), Buffer.alloc(2048, 1));
    await open(A, page);
    await page.getByRole('button', { name: 'Rendu' }).click();
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Sur la chaîne Chaîne E2E.').waitFor();
    await dialog.getByLabel(/^Titre/).fill('Teaser E2E');
    await dialog.getByRole('button', { name: 'Publique' }).click();
    await dialog.getByRole('button', { name: 'Publier sur YouTube' }).click();
    await dialog.getByText('Envoyée sur YouTube, chaîne Chaîne E2E').waitFor();
    await dialog.getByText(/YouTube l’a gardée privée/).waitFor();
    assert.equal(await dialog.getByRole('link', { name: 'Voir la vidéo' }).getAttribute('href'), 'https://youtu.be/e2e');
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'YouTube', exact: true }).waitFor();
    const saved = JSON.parse(await readFile(path.join(server.config.projectsDir, A, '.cadence', 'publications.json'), 'utf8'));
    assert.deepEqual(
      { title: saved[0].title, requested: saved[0].requested, visibility: saved[0].visibility },
      { title: 'Teaser E2E', requested: 'public', visibility: 'private' },
    );
    await page.context().close();
  });

  it('plays an exported video on the Cadence deck: play key, counter, keyboard seek', { timeout: 90_000 }, async () => {
    const renders = path.join(server.config.projectsDir, B, 'renders');
    const name = `${B}-16x9-deck.mp4`;
    await mkdir(renders, { recursive: true });
    await promisify(execFile)(server.config.ffmpegPath, [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=10:d=2'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(renders, name)],
    ]);
    const page = await open(B);
    await page.getByRole('button', { name: 'Rendu' }).click();
    const card = page.getByRole('listitem').filter({ hasText: name });
    const video = card.locator('video');
    const slider = card.getByRole('slider', { name: 'Tête de lecture' });
    assert.equal(await video.getAttribute('controls'), null);
    // The screen shows the poster frame at 1.2 s; the deck reads 0 until the first play.
    await card.locator('[role="slider"][aria-valuemax="2"]').waitFor();
    assert.equal(await slider.getAttribute('aria-valuetext'), `0,00${NBSP}s`);
    await card.getByRole('button', { name: 'Lecture' }).click();
    await card.getByRole('button', { name: 'Pause' }).click();
    assert.ok((await video.evaluate((v: HTMLVideoElement) => v.currentTime)) < 1, 'the first play starts from the beginning');
    await slider.focus();
    await page.keyboard.press('End');
    assert.equal(await slider.getAttribute('aria-valuetext'), `2,00${NBSP}s`);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await slider.getAttribute('aria-valuetext'), `1,00${NBSP}s`);
    // From 1 s the video plays to its end, then the key comes back up.
    await card.getByRole('button', { name: 'Lecture' }).click();
    await card.getByRole('button', { name: 'Pause' }).waitFor();
    await card.getByRole('button', { name: 'Lecture' }).waitFor({ timeout: 10_000 });
    assert.equal(await slider.getAttribute('aria-valuetext'), `2,00${NBSP}s`);
    await page.context().close();
  });

  it('deletes an exported video from its card, once confirmed, into the project trash', { timeout: 90_000 }, async () => {
    const name = `${B}-16x9-gone.mp4`;
    await writeFile(path.join(server.config.projectsDir, B, 'renders', name), Buffer.alloc(2048, 1));
    const page = await open(B);
    await page.getByRole('button', { name: 'Rendu' }).click();
    const card = page.getByRole('listitem').filter({ hasText: name });
    await card.getByRole('button', { name: 'Supprimer la vidéo' }).click();
    await card.getByRole('button', { name: 'Supprimer ?' }).click();
    await card.waitFor({ state: 'detached' });
    const trash = await readdir(path.join(server.config.projectsDir, B, '.cadence', 'trash'));
    assert.ok(trash.some((file) => file.endsWith(`-${name}`)));
    await page
      .getByRole('listitem')
      .filter({ hasText: `${B}-16x9-deck.mp4` })
      .waitFor();
    await page.context().close();
  });

  it('offers no seam suggestion on the first scene', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/titre`);
    await page.getByText('Suggestions', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Garde la dernière image une seconde de plus.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: SEAM_SUGGESTION }).count(), 0);
    await page.getByRole('button', { name: 'Scène 2 : Deuxième' }).click();
    await page.getByRole('button', { name: SEAM_SUGGESTION }).waitFor({ timeout: 10_000 });
    await page.context().close();
  });

  it('keeps the composer on screen under the project settings, language included', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/titre`);
    await panel(page, 'Projet');
    await page.getByRole('button', { name: /Réglages du projet/ }).click();
    const box = (await page.getByRole('button', { name: 'Envoyer' }).boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    assert.equal(hit, 'Envoyer', 'the send button is on screen and not covered');
    const [patch] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/projects/${A}`)),
      page.locator('#project-language').selectOption('fr'),
    ]);
    assert.deepEqual(patch.postDataJSON(), { language: 'fr' });
    await page.context().close();
  });

  it('checks the seams of every format, not only the previewed one', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/titre`);
    let body: unknown = null;
    await page.route('**/seams', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      body = route.request().postDataJSON();
      return route.fulfill({ json: [] });
    });
    await panel(page, 'Projet');
    await page.getByRole('button', { name: /Réglages du projet/ }).click();
    await page.getByRole('button', { name: 'Vérifier les raccords' }).click();
    await page.getByText('Aucun raccord à vérifier').waitFor({ timeout: 10_000 });
    assert.deepEqual(body, {});
    await page.context().close();
  });

  it('takes durations in bars and flags a cut off the bar grid', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/deuxieme`);
    const card = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Scène 2 : Deuxième' }) });
    const duration = card.getByRole('button', { name: /^Durée/ });
    await duration.waitFor({ timeout: 30_000 });
    assert.ok((await duration.getAttribute('aria-label'))!.includes(`La coupe tombe 1,00${NBSP}s avant une barre de mesure.`));
    assert.match((await duration.locator('span').getAttribute('class'))!, /warn/);
    await duration.click();
    await card.getByRole('textbox').fill('2 mes.');
    const [patch] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/scenes/deuxieme')),
      card.getByRole('textbox').press('Enter'),
    ]);
    assert.deepEqual(patch.postDataJSON(), { duration: 4 });
    await page.waitForFunction(
      (el) => el!.querySelector('[aria-label^="Durée : 4,00"]') && !el!.querySelector('.text-warn-ink'),
      await card.elementHandle(),
      { timeout: 10_000 },
    );
    assert.ok(!(await duration.getAttribute('aria-label'))!.includes('La coupe tombe'));
    await page.context().close();
  });

  it('offers "Garder les mesures" first, next to a "régularité" badge', { timeout: 90_000 }, async () => {
    const beats = Array.from({ length: 61 }, (_, i) => i / 2);
    const grid: MusicGridData = {
      bpm: 120,
      beatsPerBar: 4,
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
      phrases: beats.filter((_, i) => i % 16 === 0),
      sections: [{ start: 0, end: 30, label: 'A', energy: 0.5 }],
      accents: [],
      waveform: Array.from({ length: 200 }, () => 0.5),
      duration: 30,
      confidence: 1,
    };
    // A track without an audio file: the server's project, analysis and track answers get one.
    const withTrack = (project: ProjectState) => ({
      ...project,
      music: { file: 'music/a.wav', start: 0, volume: 1 },
      musicGrid: grid,
    });
    const page = await newPage();
    await rewriteProject(page, withTrack);
    await page.route('**/music/analysis', (route) =>
      route.fulfill({ json: { version: 2, sampleRate: 44100, ...grid } satisfies MusicAnalysis }),
    );
    await page.route('**/music/tracks', (route) =>
      route.fulfill({ json: [{ file: 'music/a.wav', size: 1000, analysed: true }] }),
    );
    let body: unknown = null;
    await page.route('**/music/snap', async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ json: withTrack(await api<ProjectState>('GET', `/api/projects/${A}`)) });
    });
    await open(`${A}/titre`, page);
    await panel(page, 'Musique');
    await page.getByText(/régularité 100/).waitFor({ timeout: 10_000 });
    const snap = page.locator('section', { has: page.getByText('Caler les coupes', { exact: true }) });
    assert.deepEqual(await snap.getByRole('button').allTextContents(), ['Garder les mesures', 'temps', 'mesures', 'phrases']);
    await snap.getByText('Idéal pour les campagnes : chaque scène garde son nombre de mesures.').waitFor();
    await snap.getByRole('button', { name: 'Garder les mesures' }).click();
    await page.getByText('Coupes calées sur les mesures : chaque scène garde son nombre de mesures').waitFor();
    assert.deepEqual(body, { grid: 'bar', keepBars: true });
    await page.context().close();
  });

  it(
    'lists the preset soundtracks under the drop zone and sends the version that covers the video',
    { timeout: 90_000 },
    async () => {
      const project = await api<ProjectState>('GET', `/api/projects/${A}`);
      const presets = JSON.parse(await readFile(path.join(ROOT, 'src/editor/soundtracks/presets.json'), 'utf8')) as Soundtrack[];
      const pulse = presets.find((p) => p.id === 'pulse')!;
      const expected = pulse.versions.find((v) => v.duration >= project.duration - 0.05) ?? pulse.versions.at(-1)!;
      const page = await newPage();
      // The upload is answered with the project as it is: A keeps no music for the other checks.
      let sent = '';
      // The file name rides in the query, which a glob would have to spell out.
      await page.route(
        (url) => url.pathname === `/api/projects/${A}/music`,
        (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          sent = new URL(route.request().url()).searchParams.get('name') ?? '';
          return route.fulfill({ json: project });
        },
      );
      await open(`${A}/titre`, page);
      await panel(page, 'Musique');
      const list = page.getByRole('region', { name: 'Ambiances' });
      const names = await list.getByRole('button', { name: /^Écouter / }).evaluateAll((els) => els.map((el) => el.ariaLabel));
      assert.deepEqual(
        names,
        presets.map((p) => `Écouter ${p.name}`),
      );
      await list.getByRole('button', { name: 'Utiliser Pulse' }).click();
      for (let i = 0; i < 50 && !sent; i++) await page.waitForTimeout(100);
      assert.equal(sent, expected.file);
      await page.context().close();
    },
  );

  it('sets the music volume while its slider moves and saves it once, on release', { timeout: 90_000 }, async () => {
    // A track without an audio file: the editor's <audio> still takes a volume.
    const withTrack = (project: ProjectState, volume = 1): ProjectState => ({
      ...project,
      music: { file: 'music/a.wav', start: 0, volume },
      musicUrl: `/api/projects/${A}/music/audio?file=music%2Fa.wav`,
    });
    const page = await newPage();
    await rewriteProject(page, (project) => withTrack(project));
    await page.route('**/music/tracks', (route) =>
      route.fulfill({ json: [{ file: 'music/a.wav', size: 1000, analysed: true }] }),
    );
    const saved: { volume: number }[] = [];
    await page.route(`**/api/projects/${A}/music`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const body = route.request().postDataJSON() as { volume: number };
      saved.push(body);
      return route.fulfill({ json: withTrack(await api<ProjectState>('GET', `/api/projects/${A}`), body.volume) });
    });
    await open(`${A}/titre`, page);
    await panel(page, 'Musique');
    const box = (await page.getByRole('slider', { name: 'Volume de la musique' }).boundingBox())!;
    const y = box.y + box.height / 2;
    const volume = () => page.evaluate(() => document.querySelector('audio')!.volume);
    await page.mouse.move(box.x + box.width - 1, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (1 - i / 20), y);
    // Held halfway: the track already plays at that volume, and nothing is saved while the slider is held.
    await page.waitForTimeout(600);
    assert.ok((await volume()) < 0.6, `volume ${await volume()}`);
    assert.equal(saved.length, 0);
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/music')),
      page.mouse.up(),
    ]);
    assert.equal(saved.length, 1);
    assert.ok(Math.abs(saved[0].volume - (await volume())) < 0.011, `saved ${saved[0].volume}, playing ${await volume()}`);
    await page.context().close();
  });

  it('speaks English once the setting says so, server messages included', { timeout: 90_000 }, async () => {
    await api('PUT', '/api/settings', { language: 'en' });
    try {
      const page = await newPage();
      await page.goto(`${server.config.editorOrigin}/#/@profil`);
      await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor({ timeout: 60_000 });
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
      // YouTube may already be connected by the publishing test: the other three wait for their keys.
      await page.getByRole('listitem', { name: 'YouTube' }).waitFor();
      for (const name of ['LinkedIn', 'Instagram', 'TikTok']) {
        await page.getByRole('listitem', { name }).getByRole('button', { name: 'Set up' }).waitFor();
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Français' }).waitFor();
      const refused = await fetch(`${server.config.editorOrigin}/api/projects/nope`);
      assert.equal((await refused.json()).error, 'Project not found: nope');
      await page.context().close();
    } finally {
      await api('PUT', '/api/settings', { language: 'fr' });
    }
  });

  it('says "votre abonnement"', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/titre`);
    const cost = page.locator('[aria-label^="Coût estimé des chats de ce projet"]');
    assert.match((await cost.getAttribute('aria-label'))!, /votre abonnement Claude/);
    await page.getByRole('button', { name: 'Réglages', exact: true }).click();
    await page.getByText(/compté sur votre abonnement\./).waitFor({ timeout: 10_000 });
    await page.context().close();
  });

  it('shows on the Profile page what Cadence asked Claude, from the usage log', { timeout: 90_000 }, async () => {
    const at = new Date(2026, 9, 1, 12).toISOString();
    const lines = [
      {
        at,
        kind: 'brand',
        brandId: 'orbit',
        costUsd: 4.2844,
        tokens: { input: 74, output: 87_021, cacheRead: 4_564_662, cacheWrite: 203_850 },
      },
      {
        at,
        kind: 'chat',
        projectId: A,
        chat: 'project',
        costUsd: 0.12,
        tokens: { input: 10, output: 900, cacheRead: 40_000, cacheWrite: 2000 },
      },
    ];
    const log = path.join(server.config.stateDir, 'usage.jsonl');
    await writeFile(log, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const page = await newPage();
    try {
      await page.goto(`${server.config.editorOrigin}/#/@profil`);
      const table = page.getByRole('table');
      await table.waitFor({ timeout: 60_000 });
      const cells = (name: string) =>
        table
          .getByRole('row', { name: new RegExp(`^${name}`) })
          .getByRole('cell')
          .allInnerTexts();
      assert.deepEqual(await cells('Chats des projets'), ['1', `42${NBSP}k`, '900', `0,12${NBSP}$`]);
      assert.deepEqual(await cells('Créations de marque'), ['1', `4,8${NBSP}M`, `87${NBSP}k`, `4,28${NBSP}$`]);
      assert.deepEqual(await cells('Total'), ['2', `4,8${NBSP}M`, `88${NBSP}k`, `4,40${NBSP}$`]);
      assert.equal(
        await page.getByText(/^Compté depuis/).innerText(),
        'Compté depuis le 1 oct., hors travail fait dans un terminal.',
      );
    } finally {
      await rm(log, { force: true });
      await page.context().close();
    }
  });

  it('asks for a reload once the server restarted, whatever the wording of its refusal', { timeout: 90_000 }, async () => {
    const page = await newPage();
    try {
      // The 403 of a page older than the server, in words the editor does not know.
      await page.route(
        (url) => url.pathname === '/api/usage',
        (route) =>
          route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Jeton périmé","code":"token"}' }),
      );
      await page.goto(`${server.config.editorOrigin}/#/@profil`);
      await page.getByText(/^Cadence a redémarré depuis l’ouverture de cette page/).waitFor({ timeout: 60_000 });
      assert.equal(await page.getByText('Jeton périmé').count(), 0, 'no toast');
    } finally {
      await page.context().close();
    }
  });

  it('lists "Teaser produit" first with its length and sends the language', { timeout: 90_000 }, async () => {
    const state = await api<AppState>('GET', '/api/state');
    const teaser = state.templates.projects.find((t) => t.id === 'teaser-produit')!;
    const seconds = Math.round((teaser.scenes.reduce((n, s) => n + s.bars, 0) * 240) / teaser.bpm);
    const page = await open(`${A}/titre`);
    await page.getByText('Suggestions', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Nouveau projet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau projet' });
    const [first] = await dialog.getByRole('button').filter({ hasText: /BPM$/ }).allTextContents();
    assert.ok(first.startsWith('Teaser produit'), first);
    assert.ok(first.includes(`· ${seconds}${NBSP}s ·`), first);
    await dialog.getByLabel('Nom du projet').fill(`${PREFIX}-c`);
    await dialog.getByLabel('Langue des textes').selectOption('en');
    const [create] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/projects')),
      dialog.getByRole('button', { name: 'Créer le projet' }).click(),
    ]);
    assert.equal(create.postDataJSON().language, 'en');
    // The new blank project opens on « titre » like A: its chat must load, not stay on the skeleton.
    await page.waitForFunction((id) => location.hash.startsWith(`#/${id}/`), `${PREFIX}-c`, { timeout: 30_000 });
    await page.getByText('Suggestions', { exact: true }).waitFor({ timeout: 10_000 });
    await page.context().close();
  });
});

describe('preview', () => {
  it("shows the scenes in the project's language rather than the brand's", { timeout: 90_000 }, async () => {
    const id = `${PREFIX}-l`;
    await api('POST', '/api/projects', { name: 'Langue', id, brand: 'cadence', formats: ['16:9'], fps: 30 });
    await api('POST', `/api/projects/${id}/scenes`, {
      name: 'Langue',
      code: "import type { SceneProps } from 'cadence';\n\nexport default function Langue({ brand }: SceneProps) {\n  return <p>{brand.language}</p>;\n}\n",
    });
    await server.services.store.update(id, { language: 'fr' });
    const page = await newPage();
    await page.goto(`${server.config.frameOrigin}/frame.html?project=${id}&scene=langue&format=16:9&mode=capture`);
    await page.waitForFunction(() => window.__cadence?.ready.then(() => true), undefined, { timeout: 30_000 });
    const text = async () => {
      await page.evaluate(() => window.__cadence!.seek(0.5));
      return page.evaluate(() => document.querySelector('[data-cadence-stage]')?.textContent);
    };
    assert.equal(await text(), 'fr', 'cadence is an English brand; the project asks for French');
    // A language change is no code change: the next reload picks it up without a new generation.
    await server.services.store.update(id, { language: null });
    await page.evaluate(() => window.__cadence!.reload());
    assert.equal(await text(), 'en');
    await page.context().close();
  });

  it('remounts the preview frame every 100 code generations', { timeout: 90_000 }, async () => {
    const page = await open(`${A}/titre`);
    const frame = page.locator('iframe[title="Aperçu de la vidéo"]');
    await frame.waitFor({ timeout: 30_000 });
    const first = await frame.elementHandle();
    // The editor learns of 100 more generations from its next refetch of the project (100 real edits would also make
    // the server capture 100 rounds of thumbnails and seams).
    await rewriteProject(page, (project) => ({ ...project, codeGeneration: project.codeGeneration + 100 }));
    await api('PATCH', `/api/projects/${A}`, { name: 'Éditeur A, 100 générations plus tard' });
    await page.waitForFunction((el) => !el!.isConnected, first, { timeout: 20_000 });
    await frame.waitFor({ timeout: 20_000 });
    await page.context().close();
  });

  it('plays the whole video once per frame on the selected scene, then selects where it stops', { timeout: 90_000 }, async () => {
    const [first, second] = (await api<ProjectState>('GET', `/api/projects/${A}`)).scenes;
    const page = await open(`${A}/${first.id}`);
    // The preview is up once its loading cover is gone.
    const ready = () => document.querySelector('[data-canvas]')?.querySelectorAll(':scope > div').length === 0;
    await page.waitForFunction(ready, null, { timeout: 30_000 });
    // A selection that followed the playhead would load the second scene's chat in the middle of playback.
    const secondChat: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(`/chats/scene:${second.id}`)) secondChat.push(request.url());
    });
    const preview = page.frames().find((frame) => frame.url().includes('/frame.html'))!;
    await preview.evaluate(() => {
      const counter = window as unknown as { renders: number };
      counter.renders = 0;
      addEventListener('message', (event) => {
        if (event.data?.type === 'render') counter.renders++;
      });
    });
    await page.getByRole('group', { name: 'Aperçu', exact: true }).getByRole('button', { name: 'Vidéo entière' }).click();
    const started = Date.now();
    await page.getByRole('button', { name: 'Lecture', exact: true }).click();
    // Past the cut, the stage header names the second scene; the selection stays on the first.
    await page.getByText(/^Scène 2\s:\s/).waitFor({ timeout: (first.duration + 10) * 1000 });
    await page.waitForTimeout(500);
    assert.equal(new URL(page.url()).hash, `#/${A}/${first.id}`);
    assert.deepEqual(secondChat, []);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const seconds = (Date.now() - started) / 1000;
    const renders = await preview.evaluate(() => (window as unknown as { renders: number }).renders);
    // A 30 fps project in a 60 Hz page: one render per project frame, not one per display refresh.
    assert.ok(renders > 0 && renders <= seconds * 30 + 3, `${renders} renders in ${seconds.toFixed(1)} s`);
    // Stopped: the selection catches up with the playhead.
    await page.waitForFunction((hash) => location.hash === hash, `#/${A}/${second.id}`);
    await page.context().close();
  });
});
