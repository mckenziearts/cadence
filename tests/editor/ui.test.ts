// The editor and the frame page in a real Chromium, against the whole server (fake agent, no Claude turn). Projects
// live in projects/e2e-editor-<pid>-* and are removed at the end. Needs Chromium (npm run setup).
// node --import tsx --test tests/editor/ui.test.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import type { AgentProvider, BrandSource, ElevenLabsApi, SpeechEngine } from '../../server/contracts';
import type { Soundtrack } from '../../server/music/soundtracks';
import { startServer, type RunningServer } from '../../server/index';
import { HttpError } from '../../server/util';
import { writeWav } from '../../server/voiceover/wav';
import {
  DEFAULT_FEATURES,
  type AppState,
  type BrandBuild,
  type ChatState,
  type Features,
  type MusicAnalysis,
  type MusicGridData,
  type ProjectState,
} from '../../src/shared/types';
import { fakeNetwork, makeRoot } from '../server/helpers';

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

/** Piper as the voice-over tests need it: one second per sentence, never the real program. */
const spoken: string[][] = [];
/** Set, Piper fails with this message. */
let speechError: string | null = null;
const speech: SpeechEngine = {
  check: async () => ({ ok: true }),
  speak: async ({ sentences, files }) => {
    if (speechError) throw new Error(speechError);
    spoken.push(sentences);
    for (const file of files) await writeFile(file, writeWav({ sampleRate: 16000, samples: new Int16Array(16000).fill(800) }));
  },
};

/** ElevenLabs as the Voice panel and Profile tests need it: one accepted key, two voices, never the network. */
const ELEVENLABS_KEY = `sk_e2e_${process.pid}`;
const elevenLabsSpoken: string[][] = [];
/** Set, ElevenLabs keeps speaking until it settles. */
let elevenLabsHold: Promise<void> | null = null;
const elevenLabs: ElevenLabsApi = {
  voices: async (key) => {
    if (key !== ELEVENLABS_KEY) throw new HttpError(400, 'ElevenLabs refuse la clé API : vérifiez-la dans le Profil');
    return [
      {
        id: 'voiceAlice1',
        name: 'Alice',
        category: 'premade',
        previewUrl: 'https://example.invalid/alice.mp3',
        languages: ['fr'],
      },
      { id: 'voiceBob2', name: 'Bob', category: 'premade', previewUrl: null, languages: ['en'] },
    ];
  },
  models: async () => [
    { id: 'eleven_flash_v2_5', name: 'Flash v2.5' },
    { id: 'eleven_multilingual_v2', name: 'Multilingual v2' },
  ],
  speak: async ({ sentences, files }) => {
    elevenLabsSpoken.push(sentences);
    await elevenLabsHold;
    for (const file of files) await writeFile(file, writeWav({ sampleRate: 24000, samples: new Int16Array(24000).fill(800) }));
  },
};

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

/** Answers the page's GET of a project (A by default) through `edit` (music, code generation) without touching the files. */
async function rewriteProject(page: Page, edit: (project: ProjectState) => ProjectState, id = A): Promise<void> {
  await page.route(`**/api/projects/${id}`, async (route) => {
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
      speech,
      elevenLabs,
      root: ROOT,
      // The YouTube keys and tokens of the test stay out of this machine's .cadence/accounts.json.
      stateDir,
    });
    browser = await chromium.launch();
    // The default voices count as downloaded (the fake Piper never reads them).
    await mkdir(path.join(stateDir, 'voices'), { recursive: true });
    for (const voice of ['fr_FR-siwis-medium', 'en_US-joe-medium']) {
      for (const ext of ['.onnx', '.onnx.json']) await writeFile(path.join(stateDir, 'voices', `${voice}${ext}`), '{}');
    }
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

  it('keeps the preview on the frame origin: scene code cannot send it to another site', { timeout: 90_000 }, async () => {
    let requests = 0;
    const other = http.createServer((_req, res) => {
      requests++;
      res.end();
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const page = await newPage();
    try {
      await open(`${A}/titre`, page);
      await page.frameLocator('iframe[src*="/frame.html"]').locator('#root').waitFor({ state: 'attached' });
      await page.evaluate(() => {
        const w = window as unknown as { violations: string[] };
        w.violations = [];
        document.addEventListener('securitypolicyviolation', (e) => w.violations.push(e.effectiveDirective));
      });
      const preview = page.frames().find((frame) => frame.url().startsWith(`${server.config.frameOrigin}/frame.html`))!;
      const outside = `http://127.0.0.1:${(other.address() as AddressInfo).port}/?data=secret`;
      // Deferred, so the evaluate returns before the frame leaves.
      await preview.evaluate((url) => void setTimeout(() => location.assign(url)), outside);
      const outcome = await Promise.race([
        page
          .waitForFunction(() => (window as unknown as { violations: string[] }).violations.includes('frame-src'))
          .then(() => 'blocked'),
        once(other, 'request').then(() => 'sent'),
      ]);
      assert.equal(outcome, 'blocked');
      assert.equal(requests, 0);
    } finally {
      await page.context().close();
      other.close();
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

  it('lets a host app drag its window by the top bar, padded for its window buttons', { timeout: 90_000 }, async () => {
    const page = await newPage();
    await page.goto(`${server.config.editorOrigin}/`);
    const home = page.getByRole('link', { name: 'Cadence, accueil des projets' });
    const header = page.locator('header', { has: home });
    await header.waitFor({ timeout: 60_000 });
    const region = (target: Locator) => target.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    const start = () => header.evaluate((el) => getComputedStyle(el).paddingInlineStart);
    assert.equal(await region(header), 'drag');
    assert.equal(await region(home), 'no-drag');
    const settings = header.getByRole('button', { name: 'Réglages', exact: true });
    assert.equal(await region(settings), 'no-drag');
    assert.equal(await start(), '12px');
    await page.evaluate(() => document.documentElement.style.setProperty('--titlebar-inset', '78px'));
    assert.equal(await start(), '90px');
    // Off the editor the bar is a box as wide as the page's content, 16 px down, and the strip around it drags too.
    const box = (target: Locator) => target.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const [bar, title] = await Promise.all([box(header), box(page.getByRole('heading', { name: 'Projets' }))]);
    assert.deepEqual([bar.left, bar.top], [title.left, 16]);
    assert.equal(await region(header.locator('xpath=../..')), 'drag');
    // Past 92rem the box centres with the page, unless the host lifts its max width.
    await page.setViewportSize({ width: 1700, height: 900 });
    assert.equal((await box(header)).left, (1700 - 1472) / 2 + 24);
    await page.evaluate(() => document.documentElement.style.setProperty('--titlebar-max-width', 'none'));
    const wide = await box(header);
    assert.deepEqual([wide.left, wide.right], [24, 1700 - 24]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(A, page);
    const editorBar = await box(header);
    assert.deepEqual([editorBar.left, editorBar.top, editorBar.width], [0, 0, 1440]);
    await settings.click();
    const backdrop = page.getByRole('dialog', { name: 'Réglages' }).locator('..');
    assert.equal(await region(backdrop), 'no-drag');
    await page.context().close();
  });

  it('keeps the presentation and the lightbox out of the window drag', { timeout: 90_000 }, async () => {
    const page = await newPage();
    // A past turn whose tool call looked at a frame, so the chat offers to enlarge it.
    await page.route(`**/api/projects/${A}/chats/scene:titre`, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const chat: ChatState = {
        key: 'scene:titre',
        running: false,
        queued: false,
        totalCostUsd: 0,
        messages: [
          {
            id: 'e2e-frames',
            role: 'assistant',
            text: 'Réponse factice.',
            createdAt: '2026-10-01T10:00:00.000Z',
            status: 'done',
            activity: [{ id: 'e2e-tool', tool: 'render_frames', label: 'Rendu de 1 image', status: 'ok', images: ['/e2e.png'] }],
          },
        ],
      };
      return route.fulfill({ json: chat });
    });
    await open(`${A}/titre`, page);
    const region = (target: Locator) => target.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    await page.getByRole('button', { name: 'Agrandir l’image rendue par Claude Code' }).click({ timeout: 30_000 });
    const lightbox = page.getByRole('dialog', { name: 'Image rendue par Claude Code' });
    assert.equal(await region(lightbox), 'no-drag');
    await page.keyboard.press('Escape');
    await lightbox.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Présenter', exact: true }).click();
    assert.equal(await region(page.getByRole('dialog', { name: 'Présentation' })), 'no-drag');
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

  it(
    'writes a scene voice-over in Voix: spoken once the field is left, heard in the preview, moved, removed',
    { timeout: 90_000 },
    async () => {
      const page = await open(A);
      await panel(page, 'Voix');
      const text = page.getByRole('textbox', { name: /^Voix off de/ }).first();
      await text.fill('Bonjour. Deux phrases.');
      await text.blur();
      await page.getByText(`2${NBSP}phrases, de 0,00${NBSP}s à 2,00${NBSP}s`).waitFor({ timeout: 30_000 });
      assert.deepEqual(spoken.at(-1), ['Bonjour.', 'Deux phrases.']);
      await page.locator('audio[src*="/voice-over/audio"]').waitFor({ state: 'attached' });

      const start = page.getByRole('textbox', { name: /^Départ de la voix dans/ }).first();
      await start.fill('0,5');
      await start.press('Enter');
      await page.getByText(`2${NBSP}phrases, de 0,50${NBSP}s à 2,50${NBSP}s`).waitFor();
      assert.equal(spoken.length, 1, 'moving the voice speaks nothing again');

      await text.fill('');
      await text.blur();
      await page.locator('audio[src*="/voice-over/audio"]').waitFor({ state: 'detached' });
      await page.context().close();
    },
  );

  it(
    'keeps a voice-over failure in Voix after a reload, generates the scene again, and listens from its voice start',
    { timeout: 90_000 },
    async () => {
      const id = `${PREFIX}-v`;
      await api('POST', '/api/projects', { name: 'Voix', id, brand: 'cadence', formats: ['16:9'], fps: 30 });
      const scene = await api<{ id: string }>('POST', `/api/projects/${id}/scenes`, { name: 'Parole', duration: 3 });
      speechError = 'Piper a échoué (code 1)';
      const page = await open(id);
      await panel(page, 'Voix');
      await page.getByRole('textbox', { name: 'Voix off de « Parole »' }).fill('Bonjour.');
      await page.getByRole('textbox', { name: 'Voix off de « Parole »' }).blur();
      const start = page.getByRole('textbox', { name: 'Départ de la voix dans « Parole », en secondes' });
      await start.fill('0,5');
      await start.press('Enter');
      const generate = page.getByRole('button', { name: 'Générer la voix off de « Parole »' });
      await generate.waitFor({ timeout: 30_000 });
      await page.getByRole('alert').filter({ hasText: 'Piper a échoué (code 1)' }).waitFor();

      await page.reload();
      await page.getByRole('group', { name: 'Panneau' }).waitFor({ timeout: 60_000 });
      await panel(page, 'Voix');
      await page.getByRole('alert').filter({ hasText: 'Piper a échoué (code 1)' }).waitFor({ timeout: 10_000 });
      speechError = null;
      await generate.click();
      await page.getByText(`1${NBSP}phrase, de 0,50${NBSP}s à 1,50${NBSP}s`).waitFor({ timeout: 30_000 });
      assert.equal(await page.getByRole('alert').filter({ hasText: 'Piper a échoué' }).count(), 0);

      // By the right edge of the window, the Listen tooltip stays inside it, on one line.
      const listen = page.getByRole('button', { name: 'Écouter la voix off de « Parole »' });
      await listen.hover();
      const tip = (await page.getByRole('tooltip').boundingBox())!;
      assert.ok(tip.x >= 0 && tip.x + tip.width <= 1440 && tip.height < 30, `tooltip ${JSON.stringify(tip)}`);
      // Muted, Listen turns the sound back on: it is there to hear the voice.
      await page.getByRole('button', { name: 'Couper le son' }).click();
      await listen.click();
      await page.getByRole('button', { name: 'Couper le son' }).waitFor({ timeout: 5_000 });
      const pause = page.getByRole('button', { name: 'Pause', exact: true });
      await pause.waitFor({ timeout: 10_000 });
      await pause.click();
      assert.equal(new URL(page.url()).hash, `#/${id}/${scene.id}`);
      const at = await page.getByRole('slider', { name: 'Tête de lecture' }).getAttribute('aria-valuetext');
      const t = Number(at!.replace(',', '.').replace(/[^\d.]/g, ''));
      assert.ok(t >= 0.5 && t < 1.5, `the playhead starts at the voice: ${at}`);
      await page.context().close();
    },
  );

  it(
    'sets the subtitles in Voix: downloads once every scene is spoken, burned into the preview once checked',
    { timeout: 90_000 },
    async () => {
      const id = `${PREFIX}-st`;
      await api('POST', '/api/projects', { name: 'Sous-titres', id, brand: 'cadence', formats: ['16:9'], fps: 30 });
      const scene = await api<{ id: string }>('POST', `/api/projects/${id}/scenes`, { name: 'Parole', duration: 3 });
      const page = await open(`${id}/${scene.id}`);
      await panel(page, 'Voix');
      const srt = page.getByRole('button', { name: 'Télécharger les sous-titres SRT' });
      const vtt = page.getByRole('button', { name: 'Télécharger les sous-titres VTT' });
      const none = page.getByText('Pas encore de phrase : écrivez la voix off d’une scène.');
      await none.waitFor();
      assert.ok((await srt.isDisabled()) && (await vtt.isDisabled()), 'no sentence: the route answers 404');
      for (const button of [srt, vtt]) assert.equal(await button.getAttribute('aria-describedby'), await none.getAttribute('id'));

      speechError = 'Piper a échoué (code 1)';
      const text = page.getByRole('textbox', { name: 'Voix off de « Parole »' });
      await text.fill('Bonjour tout le monde.');
      await text.blur();
      const generate = page.getByRole('button', { name: 'Générer la voix off de « Parole »' });
      await generate.waitFor({ timeout: 30_000 });
      await page.getByText('Les sous-titres se téléchargent une fois la voix off de chaque scène générée.').waitFor();
      assert.ok(await srt.isDisabled(), 'a scene not spoken: the route answers 409');
      speechError = null;
      await generate.click();
      await page.getByText(`1${NBSP}phrase, de 0,00${NBSP}s à 1,00${NBSP}s`).waitFor({ timeout: 30_000 });
      assert.equal(await srt.getAttribute('aria-describedby'), null);

      for (const [button, format] of [
        [srt, 'srt'],
        [vtt, 'vtt'],
      ] as const) {
        const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
        assert.equal(file.suggestedFilename(), `${id}.${format}`);
        const saved = await readFile((await file.path())!, 'utf8');
        const served = await fetch(`${server.config.editorOrigin}/api/projects/${id}/subtitles?format=${format}`);
        assert.equal(saved, await served.text());
        assert.match(saved, /Bonjour tout le monde\./);
      }

      // A refusal the panel could not see coming (the text changed meanwhile) shows its message, never a file.
      await page.route('**/subtitles?**', (route) => route.fulfill({ status: 409, json: { error: 'Voix off pas prête' } }));
      let downloads = 0;
      page.on('download', () => downloads++);
      await srt.click();
      await page.getByText('Voix off pas prête').waitFor();
      assert.equal(downloads, 0);

      const caption = page.frameLocator('iframe[src*="/frame.html"]').locator('[data-cadence-captions]');
      const burn = page.getByRole('checkbox', { name: /Incruster dans la vidéo/ });
      // Checked once the server saved it, like the other voice settings.
      await burn.click();
      await caption.filter({ hasText: 'Bonjour tout le monde.' }).waitFor({ timeout: 30_000 });
      assert.ok(await burn.isChecked());
      assert.equal((await api<ProjectState>('GET', `/api/projects/${id}`)).captions, true);
      await burn.click();
      await caption.waitFor({ state: 'detached', timeout: 30_000 });
      assert.equal((await api<ProjectState>('GET', `/api/projects/${id}`)).captions, false);
      await page.context().close();
    },
  );

  it(
    'sends Voix to the Profile for the ElevenLabs key, picks a voice, and speaks a scene only on Générer',
    { timeout: 90_000 },
    async () => {
      const id = `${PREFIX}-e`;
      await api('POST', '/api/projects', { name: 'ElevenLabs', id, brand: 'cadence', formats: ['16:9'], fps: 30 });
      await api('POST', `/api/projects/${id}/scenes`, { name: 'Parole', duration: 3 });
      const piper = (await api<ProjectState>('GET', `/api/projects/${id}`)).voiceOver;
      // Out of ElevenLabs' range: switching brings it inside.
      await api('PATCH', `/api/projects/${id}`, { voiceOver: { ...piper, speed: 1.8 } });
      let page = await open(id);
      let release = () => {};
      try {
        await panel(page, 'Voix');
        await page.getByText('Cadence la génère dès que vous quittez le champ.').waitFor();
        await page.getByRole('group', { name: 'Moteur de la voix' }).getByRole('button', { name: 'ElevenLabs' }).click();

        // No key form here any more: one line and the way to the Profile.
        await page.getByText('Aucune clé ElevenLabs sur cet ordinateur : ajoutez la vôtre dans le Profil.').waitFor();
        assert.equal(await page.getByLabel('Clé API ElevenLabs').count(), 0);
        await page.getByRole('button', { name: 'Ouvrir le Profil' }).click();
        await page.getByRole('heading', { name: 'Profil', exact: true }).waitFor({ timeout: 10_000 });
        assert.match(page.url(), /#\/@profil$/);
        await page.context().close();

        await api('PUT', '/api/voices/elevenlabs/key', { key: ELEVENLABS_KEY });
        page = await open(id);
        await panel(page, 'Voix');
        await page.getByRole('group', { name: 'Moteur de la voix' }).getByRole('button', { name: 'ElevenLabs' }).click();
        const voice = page.getByRole('combobox', { name: 'Voix ElevenLabs de la vidéo' });
        await voice.waitFor({ timeout: 10_000 });
        // Nothing saved until a voice is set: the project still speaks with Piper.
        assert.equal((await api<ProjectState>('GET', `/api/projects/${id}`)).voiceOver.engine, undefined);
        assert.equal(await page.getByRole('combobox', { name: 'Modèle ElevenLabs' }).inputValue(), 'eleven_multilingual_v2');

        const saved = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/projects/${id}`));
        await voice.selectOption('voiceAlice1');
        assert.deepEqual(JSON.parse((await saved).postData()!), {
          voiceOver: { engine: 'elevenlabs', voice: 'voiceAlice1', model: 'eleven_multilingual_v2', speed: 1.2, musicLevel: 0.3 },
        });
        await page.getByRole('button', { name: 'Écouter un extrait de la voix Alice' }).waitFor();
        await page.getByText('ElevenLabs la génère quand vous cliquez sur Générer.').waitFor();
        assert.equal(await page.getByRole('slider', { name: 'Vitesse de la voix' }).getAttribute('max'), '1.2');
        const project = await api<ProjectState>('GET', `/api/projects/${id}`);
        assert.equal(project.voiceOver.engine, 'elevenlabs');
        assert.equal(project.voiceOver.model, 'eleven_multilingual_v2');

        // A scene's text waits for Générer, and the voice stays put while ElevenLabs speaks with it.
        const text = page.getByRole('textbox', { name: 'Voix off de « Parole »' });
        await text.fill('Bonjour.');
        await text.blur();
        const generate = page.getByRole('button', { name: 'Générer la voix off de « Parole »' });
        await generate.waitFor({ timeout: 10_000 });
        assert.equal(elevenLabsSpoken.length, 0, 'ElevenLabs never speaks on its own');
        elevenLabsHold = new Promise((resolve) => (release = resolve));
        await generate.click();
        await page.locator('fieldset[disabled]').waitFor({ timeout: 10_000 });
        assert.ok(await voice.isDisabled());
        release();
        await page.getByText(`1${NBSP}phrase, de 0,00${NBSP}s à 1,00${NBSP}s`).waitFor({ timeout: 10_000 });
        assert.deepEqual(elevenLabsSpoken, [['Bonjour.']]);
        assert.ok(await voice.isEnabled());

        // Back to Piper: the language's default voice with this project's speed, no ElevenLabs field left behind.
        const kept = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url().endsWith(`/api/projects/${id}`) &&
            /"speed":1\.2/.test(r.request().postData()!),
        );
        await page.getByRole('group', { name: 'Moteur de la voix' }).getByRole('button', { name: 'Piper' }).click();
        await page.getByText('Cadence la génère dès que vous quittez le champ.').waitFor({ timeout: 10_000 });
        assert.equal(await page.getByRole('combobox', { name: 'Voix de la vidéo', exact: true }).inputValue(), piper.voice);
        assert.equal(await page.getByRole('slider', { name: 'Vitesse de la voix' }).getAttribute('max'), '2');
        await kept;
        assert.deepEqual((await api<ProjectState>('GET', `/api/projects/${id}`)).voiceOver, { ...piper, speed: 1.2 });
      } finally {
        release();
        elevenLabsHold = null;
        await api('DELETE', '/api/voices/elevenlabs/key');
        await page.context().close();
      }
    },
  );

  it(
    'saves the ElevenLabs key in the Profile without showing it back, and picks the voice of new projects',
    { timeout: 90_000 },
    async () => {
      const page = await newPage();
      try {
        await page.goto(`${server.config.editorOrigin}/#/@profil`);
        await page.getByRole('heading', { name: 'Voix off' }).waitFor({ timeout: 60_000 });
        const card = page.getByRole('listitem', { name: 'ElevenLabs' });
        await card.getByText('Pas de clé').waitFor({ timeout: 10_000 });
        await page.getByRole('listitem', { name: 'Piper' }).getByText('Installé, gratuit').waitFor();

        const key = card.getByLabel('Clé API ElevenLabs');
        await key.fill('sk_refused');
        await key.press('Enter');
        const refused = card.getByText('ElevenLabs refuse la clé API');
        await refused.waitFor({ timeout: 10_000 });
        assert.equal(await key.getAttribute('aria-invalid'), 'true');
        assert.equal(await key.getAttribute('aria-describedby'), await refused.getAttribute('id'));
        assert.equal(
          await card.getByRole('link', { name: /réglages de votre compte ElevenLabs/ }).getAttribute('target'),
          '_blank',
        );
        await card.getByText(/chaque génération est facturée sur votre compte/).waitFor();

        await key.fill(ELEVENLABS_KEY);
        await card.getByRole('button', { name: 'Enregistrer la clé' }).click();
        await card.getByText('Clé enregistrée').waitFor({ timeout: 10_000 });
        const voice = card.getByRole('combobox', { name: 'Voix des nouveaux projets' });
        await voice.waitFor({ timeout: 10_000 });
        assert.equal(await card.getByLabel('Clé API ElevenLabs').count(), 0);
        assert.ok(!(await page.content()).includes(ELEVENLABS_KEY), 'the key never comes back to the page');
        assert.ok(!JSON.stringify(await api('GET', '/api/voices')).includes(ELEVENLABS_KEY));
        assert.ok(!JSON.stringify(await api('GET', '/api/state')).includes(ELEVENLABS_KEY));
        // Piper until a voice is picked.
        assert.equal(await voice.inputValue(), '');
        assert.equal(await card.getByRole('combobox', { name: 'Modèle ElevenLabs' }).inputValue(), 'eleven_multilingual_v2');

        const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/settings'));
        await voice.selectOption('voiceAlice1');
        const defaultVoice = { engine: 'elevenlabs', voice: 'voiceAlice1', model: 'eleven_multilingual_v2' };
        assert.deepEqual(JSON.parse((await saved).postData()!), { defaultVoice });
        await card.getByRole('button', { name: 'Écouter un extrait de la voix Alice' }).waitFor();

        const id = `${PREFIX}-default`;
        await api('POST', '/api/projects', { name: 'Voix par défaut', id, brand: 'cadence', formats: ['16:9'], fps: 30 });
        assert.deepEqual((await api<ProjectState>('GET', `/api/projects/${id}`)).voiceOver, {
          ...defaultVoice,
          speed: 1,
          musicLevel: 0.3,
        });

        // Without the key, new projects start on Piper again.
        await card.getByRole('button', { name: 'Retirer la clé' }).click();
        await card.getByRole('button', { name: 'Retirer la clé ?' }).click();
        await card.getByText('Pas de clé').waitFor({ timeout: 10_000 });
        await card.getByLabel('Clé API ElevenLabs').waitFor();
        assert.equal((await api<AppState>('GET', '/api/state')).settings.defaultVoice, undefined);
      } finally {
        await api('DELETE', '/api/voices/elevenlabs/key');
        await page.context().close();
      }
    },
  );

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

  type Start = { duration: number; lead: number; offset: number };

  /** A project whose one scene, `name`, plays `cues` and opens the video. */
  async function soundProject(id: string, name: string, cues: { at: number; sound: string; gain?: number }[], duration?: number) {
    await api('POST', '/api/projects', { name, id, brand: 'cadence', formats: ['16:9'], fps: 30 });
    await api('POST', `/api/projects/${id}/scenes`, {
      name,
      duration,
      code: `import type { SoundCue } from 'cadence';\n\nexport const sounds = (): SoundCue[] => ${JSON.stringify(cues)};\n\nexport default function Scene() {\n  return <p>${name}</p>;\n}\n`,
    });
    await api('DELETE', `/api/projects/${id}/scenes/titre`);
  }

  /** Nobody hears the headless browser: each source the page schedules is recorded with its lead over the audio clock. */
  async function recordStarts(page: Page) {
    await page.addInitScript(() => {
      const starts: Start[] = [];
      Object.assign(window, { starts });
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when = 0, offset = 0, ...rest: number[]) {
        starts.push({ duration: this.buffer?.duration ?? 0, lead: when - this.context.currentTime, offset });
        return start.call(this, when, offset, ...rest);
      };
    });
    return {
      starts: () => page.evaluate(() => (window as unknown as { starts: Start[] }).starts),
      startsReach: (count: number, timeout: number) =>
        page.waitForFunction((count) => (window as unknown as { starts: unknown[] }).starts.length >= count, count, { timeout }),
    };
  }

  /** Once the playhead reads `t` seconds or more. */
  const playheadPast = (page: Page, t: number) =>
    page.waitForFunction(
      (t) => {
        const at = document.querySelector('[role="slider"][aria-label="Tête de lecture"]')?.getAttribute('aria-valuetext');
        return at != null && Number(at.replace(',', '.').replace(/[^\d.]/g, '')) >= t;
      },
      t,
      { timeout: 10_000 },
    );

  it("schedules the scene's sound effects in the preview and in Present", { timeout: 90_000 }, async () => {
    const id = `${PREFIX}-s`;
    // The scene opens the video, so its cue at 0 is also Present's opening cue.
    await soundProject(id, 'Sons', [
      { at: 0, sound: 'impact' },
      { at: 0.4, sound: 'pop' },
      { at: 0.8, sound: 'whoosh', gain: 0.5 },
    ]);
    const page = await newPage();
    const { starts, startsReach } = await recordStarts(page);
    await open(`${id}/sons`, page);
    const ready = () => document.querySelector('[data-canvas]')?.querySelectorAll(':scope > div').length === 0;
    await page.waitForFunction(ready, null, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Lecture', exact: true }).click();
    await startsReach(3, 10_000);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const heard = await starts();
    assert.equal(heard.length, 3, JSON.stringify(heard));
    for (const { lead } of heard) assert.ok(lead >= -0.01 && lead <= 0.16, JSON.stringify(heard));
    // By length: the pop, the whoosh, then the impact, which opens the scene even though the first tick comes late.
    const [popped, whooshed, impact] = [...heard].sort((a, b) => a.duration - b.duration);
    assert.equal(heard[0].duration, impact.duration, JSON.stringify(heard));
    assert.ok(impact.offset < 0.1, JSON.stringify(heard));
    assert.deepEqual([popped.offset, whooshed.offset], [0, 0], JSON.stringify(heard));
    await page.evaluate(() => ((window as unknown as { starts: unknown[] }).starts.length = 0));
    await page.getByRole('button', { name: 'Présenter', exact: true }).click();
    await startsReach(1, 15_000);
    assert.equal((await starts())[0].duration, impact.duration, 'a cold Present plays its opening cue');
    await page.context().close();
  });

  it('plays no sound effect while the preview is muted, and the next cue once unmuted', { timeout: 90_000 }, async () => {
    const id = `${PREFIX}-sm`;
    await soundProject(
      id,
      'Muet',
      [
        { at: 0.2, sound: 'pop' },
        { at: 2, sound: 'pop' },
      ],
      4,
    );
    const page = await newPage();
    const { starts, startsReach } = await recordStarts(page);
    // The mute button comes with a soundtrack. Its file is missing, so the playhead follows the wall clock.
    await rewriteProject(
      page,
      (project) => ({
        ...project,
        music: { file: 'music/a.wav', start: 0, volume: 1 },
        musicUrl: `/api/projects/${id}/music/audio?file=music%2Fa.wav`,
      }),
      id,
    );
    await open(`${id}/muet`, page);
    const ready = () => document.querySelector('[data-canvas]')?.querySelectorAll(':scope > div').length === 0;
    await page.waitForFunction(ready, null, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Couper le son' }).click();
    await page.getByRole('button', { name: 'Lecture', exact: true }).click();
    await playheadPast(page, 0.8);
    assert.deepEqual(await starts(), [], 'muted: the cue at 0.2 s is not heard');
    await page.getByRole('button', { name: 'Réactiver le son' }).click();
    await startsReach(1, 10_000);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const heard = await starts();
    // Only the cue at 2 s, scheduled ahead: the one passed while muted is not owed.
    assert.equal(heard.length, 1, JSON.stringify(heard));
    assert.ok(heard[0].lead >= -0.01 && heard[0].lead <= 0.16 && heard[0].offset === 0, JSON.stringify(heard));
    await page.context().close();
  });

  it('plays the opening cue again at each loop restart, never twice', { timeout: 90_000 }, async () => {
    const id = `${PREFIX}-sb`;
    await soundProject(id, 'Boucle', [{ at: 0, sound: 'pop' }], 1);
    const page = await newPage();
    const { starts } = await recordStarts(page);
    await open(`${id}/boucle`, page);
    const ready = () => document.querySelector('[data-canvas]')?.querySelectorAll(':scope > div').length === 0;
    await page.waitForFunction(ready, null, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Lecture en boucle (L)' }).waitFor();
    // A pass begins each time the playhead jumps back.
    type Loops = { restarts: number; time: number };
    await page.evaluate(() => {
      const slider = document.querySelector('[role="slider"][aria-label="Tête de lecture"]')!;
      const loops: Loops = { restarts: 0, time: 0 };
      Object.assign(window, { loops });
      // Inline: tsx would wrap a named helper in a `__name` call the page does not define.
      new MutationObserver(() => {
        const t = Number(
          slider
            .getAttribute('aria-valuetext')!
            .replace(',', '.')
            .replace(/[^\d.]/g, ''),
        );
        if (t < loops.time) loops.restarts++;
        loops.time = t;
      }).observe(slider, { attributeFilter: ['aria-valuetext'] });
    });
    const loops = () => page.evaluate(() => (window as unknown as { loops: Loops }).loops);
    await page.getByRole('button', { name: 'Lecture', exact: true }).click();
    // Paused inside the third pass, well after its opening cue and well before the next restart.
    await page.waitForFunction(
      () => {
        const { loops } = window as unknown as { loops: Loops };
        return loops.restarts >= 2 && loops.time >= 0.3;
      },
      null,
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const { restarts } = await loops();
    const heard = await starts();
    assert.equal(heard.length, restarts + 1, `${restarts} restarts: ${JSON.stringify(heard)}`);
    await page.context().close();
  });

  it('schedules the cues again from where the playhead is moved back while playing', { timeout: 90_000 }, async () => {
    const id = `${PREFIX}-sk`;
    // Long enough that no loop restart comes into it.
    await soundProject(id, 'Retour', [{ at: 0.3, sound: 'pop' }], 6);
    const page = await newPage();
    const { starts, startsReach } = await recordStarts(page);
    await open(`${id}/retour`, page);
    const ready = () => document.querySelector('[data-canvas]')?.querySelectorAll(':scope > div').length === 0;
    await page.waitForFunction(ready, null, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Lecture', exact: true }).click();
    await startsReach(1, 10_000);
    await playheadPast(page, 0.8);
    const scrubber = (await page.getByRole('slider', { name: 'Tête de lecture' }).boundingBox())!;
    await page.mouse.click(scrubber.x + 1, scrubber.y + scrubber.height / 2);
    await playheadPast(page, 0.8);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const heard = await starts();
    assert.equal(heard.length, 2, JSON.stringify(heard));
    assert.ok(heard[1].lead >= -0.01 && heard[1].lead <= 0.16, JSON.stringify(heard));
    await page.context().close();
  });

  it('stays up when scene code posts a malformed errors message', { timeout: 90_000 }, async () => {
    const id = `${PREFIX}-x`;
    await api('POST', '/api/projects', { name: 'Erreurs', id, brand: 'cadence', formats: ['16:9'], fps: 30 });
    await api('POST', `/api/projects/${id}/scenes`, {
      name: 'Erreurs',
      code: "export default function Erreurs() {\n  for (const errors of [1, [{}], [null, 'x']]) parent.postMessage({ source: 'cadence-frame', type: 'errors', errors }, '*');\n  return <p>Erreurs</p>;\n}\n",
    });
    const page = await newPage();
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));
    await open(`${id}/erreurs`, page);
    const ready = () => document.querySelector('[data-canvas]')?.querySelectorAll(':scope > div').length === 0;
    await page.waitForFunction(ready, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    assert.deepEqual(crashes, []);
    await page.getByRole('button', { name: 'Lecture', exact: true }).waitFor({ timeout: 1_000 });
    await page.context().close();
  });
});

describe('features', () => {
  const COST = `0,42${NBSP}$`;
  /**
   * Each turn costs 0,42 $ and changes a versioned file, so the cost reaches the chat, the versions and the totals. Its
   * status is down, so the chat and the settings name it.
   */
  const costly: AgentProvider = {
    ...provider,
    status: async () => ({ ok: false, label: 'Agent factice', version: '1.2.3' }),
    async *run(turn) {
      await writeFile(path.join(turn.cwd, 'art-direction.md'), '# Direction plus chaude\n');
      yield { type: 'init', sessionId: turn.sessionId };
      yield { type: 'text', text: 'Réponse factice.' };
      yield { type: 'done', text: 'Réponse factice.', isError: false, durationMs: 1, costUsd: 0.42 };
    },
  };
  /** A finished brand build that cost 0,42 $, added to the state the editor reads. */
  const BUILD: BrandBuild = {
    id: 'e2e-build',
    brandId: 'orbit',
    name: 'Orbit',
    repo: 'acme/e2e-site',
    status: 'done',
    activity: null,
    files: [],
    costUsd: 0.42,
    createdAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:05:00.000Z',
  };

  // The same lookups with every feature on, then off: a lookup that finds nothing when its section is on would make the
  // second run prove nothing.
  async function sectionCounts(features: Features): Promise<{
    counts: Record<string, number>;
    author: string | null;
    ourAiPitch: number;
    rotating: number;
    ourAiDown: number;
  }> {
    const t = await makeRoot();
    let hosted: RunningServer | undefined;
    try {
      const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
      hosted = await startServer({
        root: ROOT,
        projectsDir,
        brandsDir,
        templatesDir,
        stateDir,
        editorPort: 0,
        framePort: 0,
        quiet: true,
        provider: costly,
        brandSources: { github: brandSource, gitlab: glabMissing },
        networks: { youtube: fakeNetwork() },
        features,
        // No Codex CLI behind the agent picked below: its model list stays empty.
        codexPath: path.join(stateDir, 'no-codex'),
      });
      // A network with its keys keeps its connect button: only the keys controls go.
      const saved = await fetch(`${hosted.config.editorOrigin}/api/networks/youtube/app`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': hosted.editorToken },
        body: JSON.stringify({ clientId: 'e2e-client', clientSecret: 'e2e-secret' }),
      });
      assert.equal(saved.status, 200);
      const send = async (method: string, pathname: string, body?: unknown) => {
        const res = await fetch(`${hosted!.config.editorOrigin}${pathname}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': hosted!.editorToken },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert.ok(res.ok, `${method} ${pathname}: ${res.status}`);
        return res.json();
      };
      await send('POST', '/api/projects', { name: 'Coûts', id: 'couts', brand: 'cadence', formats: ['16:9'], fps: 30 });
      await send('POST', '/api/projects/couts/chats/scene:titre/messages', { text: 'Réchauffe la direction' });
      let chat: ChatState;
      for (let i = 0; ; i++) {
        chat = (await send('GET', '/api/projects/couts/chats/scene:titre')) as ChatState;
        if ((!chat.running && !chat.queued) || i === 300) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const version = chat.messages.at(-1)?.versionId;
      assert.ok(version, 'the turn made a version');
      const counts: Record<string, number> = {};
      const costs = await newPage();
      await costs.route('**/api/state', async (route) => {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...((await response.json()) as AppState), brandBuilds: [BUILD] } });
      });
      await costs.goto(`${hosted.config.editorOrigin}/#/couts/titre`);
      await costs.getByText('Réponse factice.').waitFor({ timeout: 60_000 });
      const author = await costs.locator('article').filter({ hasText: 'Réponse factice.' }).locator('p').first().textContent();
      counts['cost top bar'] = await costs.locator('[aria-label^="Coût estimé des chats de ce projet"]').count();
      counts['cost chat'] = await costs.locator('footer').getByText(COST, { exact: true }).count();
      counts['model composer'] = await costs.getByRole('combobox', { name: /^(Modèle|Effort)$/ }).count();
      const down = costs.getByRole('alert').getByText(/est indisponible$/);
      counts['agent chat banner'] = await down.getByText('Agent factice est indisponible', { exact: true }).count();
      let ourAiDown = await down.getByText('Notre IA est indisponible', { exact: true }).count();
      await panel(costs, 'Versions');
      // The turn changed the art direction, not the scene.
      await costs.getByRole('button', { name: 'Tout le projet' }).click();
      const versionLines = costs.locator('p', { has: costs.locator('time') });
      await versionLines.getByText(version, { exact: true }).waitFor();
      counts['cost versions'] = await versionLines.getByText(COST, { exact: true }).count();
      await costs.getByRole('button', { name: 'Réglages', exact: true }).click();
      const settings = costs.getByRole('dialog', { name: 'Réglages' });
      await settings.getByRole('button', { name: 'Français' }).waitFor();
      counts['model settings'] = await settings.getByRole('combobox', { name: /^(Modèle|Effort) \(/ }).count();
      counts['model settings subtitle'] = await settings.getByText(/le modèle et l’effort/).count();
      counts['cost settings hint'] = await settings.getByText(/le coût affiché/).count();
      counts['agent settings'] = await settings.getByText('Agent factice 1.2.3 est indisponible', { exact: true }).count();
      ourAiDown += await settings.getByText('Notre IA est indisponible', { exact: true }).count();
      await costs.keyboard.press('Escape');
      await costs.getByRole('button', { name: 'Marque « Orbit » : Prête' }).click();
      const built = costs.getByRole('dialog', { name: 'Marque « Orbit » prête' });
      await built.getByText('Depuis acme/e2e-site').waitFor();
      counts['cost brand build'] = await built.getByText(COST).count();
      await costs.goto(`${hosted.config.editorOrigin}/#/@profil`);
      await costs.getByRole('listitem', { name: 'YouTube' }).waitFor({ timeout: 60_000 });
      // Usage is counted per agent and dollars only for Claude Code: read it before the agent becomes Codex below.
      if (features.agentPicker) await costs.getByRole('table').waitFor();
      counts['cost profile'] = await costs.getByRole('columnheader', { name: 'Coût estimé' }).count();
      // Claude Code's hint talks about money: with the costs hidden it goes too, rather than call the agent free.
      counts['cost profile hint'] = await costs.getByText(/^Ce que Cadence a demandé à l’assistant/).count();
      await costs.context().close();
      // The home shows its pitch only before the first project.
      await send('DELETE', '/api/projects/couts');

      const agent = await fetch(`${hosted.config.editorOrigin}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': hosted.editorToken },
        body: JSON.stringify({ agent: 'codex' }),
      });
      assert.equal(agent.status, 200);
      const page = await newPage();
      await page.goto(`${hosted.config.editorOrigin}/#/@profil`);
      const youtube = page.getByRole('listitem', { name: 'YouTube' });
      await youtube.getByRole('button', { name: 'Connecter la chaîne' }).waitFor({ timeout: 60_000 });
      await page.getByRole('listitem', { name: 'LinkedIn' }).waitFor();
      for (const name of ['Assistant IA', 'Dépôts Git', /^Consommation/]) {
        counts[`profile ${name}`] = await page.getByRole('heading', { name, exact: true }).count();
      }
      counts['profile GitHub'] = await page.getByRole('listitem', { name: 'GitHub' }).count();
      counts['profile keys'] = await page.getByRole('button', { name: /^(Configurer|Clés)$/ }).count();
      // Codex counts tokens only: its hint names no cost, so it stays when the host hides the costs.
      counts['profile usage hint'] = await page.getByText(/^Ce que Cadence a demandé à l’assistant/).count();

      await page.goto(`${hosted.config.editorOrigin}/#/`);
      await page.getByRole('button', { name: 'Créer un projet' }).waitFor({ timeout: 60_000 });
      counts['pitch agents'] = await page
        .getByRole('heading', { name: 'Décrivez une vidéo, Claude Code ou Codex l’écrit scène par scène.' })
        .count();
      // Without the choice, the pitch names no agent, even with Codex picked, and does not turn.
      const ourAiPitch = await page
        .getByRole('heading', { name: 'Décrivez une vidéo, notre IA l’écrit scène par scène.', exact: true })
        .count();
      const rotating = await page
        .getByRole('heading', { name: /^Décrivez une vidéo/ })
        .locator('[aria-hidden]')
        .count();
      await page.getByRole('button', { name: 'Créer un projet' }).click();
      const project = page.getByRole('dialog', { name: 'Nouveau projet' });
      await project.getByLabel('Nom du projet').waitFor();
      counts['new project agent'] = await project.getByRole('heading', { name: 'Assistant IA', exact: true }).count();
      await project.getByRole('button', { name: /Nouvelle marque/ }).click();
      const brand = page.getByRole('dialog', { name: 'Nouvelle marque' });
      await brand.getByText('acme/e2e-site').waitFor();
      counts['new brand agent'] = await brand.getByRole('heading', { name: 'Assistant IA', exact: true }).count();
      await page.context().close();
      return { counts, author, ourAiPitch, rotating, ourAiDown };
    } finally {
      await hosted?.close();
      await t.cleanup();
    }
  }

  it('shows every section by default', { timeout: 180_000 }, async () => {
    const { counts, author, ourAiPitch, ourAiDown } = await sectionCounts(DEFAULT_FEATURES);
    for (const [lookup, count] of Object.entries(counts)) assert.ok(count > 0, lookup);
    assert.equal(author, 'Claude Code');
    assert.deepEqual([ourAiPitch, ourAiDown], [0, 0]);
  });

  it('hides every section a host turns off', { timeout: 180_000 }, async () => {
    const { counts, author, ourAiPitch, rotating, ourAiDown } = await sectionCounts({
      agentPicker: false,
      gitSources: false,
      networkApps: false,
      modelPicker: false,
      costs: false,
    });
    for (const [lookup, count] of Object.entries(counts)) assert.equal(count, 0, lookup);
    assert.equal(author, 'Notre IA');
    // The banner and the settings name no agent and give no version.
    assert.deepEqual([ourAiPitch, rotating, ourAiDown], [1, 0, 2]);
  });

  for (const [flag, prefix] of [
    ['modelPicker', 'model '],
    ['costs', 'cost '],
  ] as const) {
    it(`hides only what ${flag} gates`, { timeout: 180_000 }, async () => {
      const { counts } = await sectionCounts({ ...DEFAULT_FEATURES, [flag]: false });
      for (const [lookup, count] of Object.entries(counts)) {
        if (lookup.startsWith(prefix)) assert.equal(count, 0, lookup);
        else assert.ok(count > 0, lookup);
      }
    });
  }

  it(
    'sends no model without the model choice: the turn runs on the settings, outside the catalog too',
    { timeout: 120_000 },
    async () => {
      const t = await makeRoot();
      let hosted: RunningServer | undefined;
      try {
        const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
        const model = 'claude-sonnet-4-6';
        await mkdir(stateDir, { recursive: true });
        await writeFile(path.join(stateDir, 'settings.json'), JSON.stringify({ sceneModel: model }));
        const models: string[] = [];
        hosted = await startServer({
          root: ROOT,
          projectsDir,
          brandsDir,
          templatesDir,
          stateDir,
          editorPort: 0,
          framePort: 0,
          quiet: true,
          provider: {
            ...provider,
            run(turn) {
              models.push(turn.model);
              return provider.run(turn);
            },
          },
          features: { ...DEFAULT_FEATURES, modelPicker: false },
        });
        const created = await fetch(`${hosted.config.editorOrigin}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': hosted.editorToken },
          body: JSON.stringify({ name: 'Modèle', id: 'modele', brand: 'cadence', formats: ['16:9'], fps: 30 }),
        });
        assert.ok(created.ok, `POST /api/projects: ${created.status}`);
        const page = await newPage();
        await page.goto(`${hosted.config.editorOrigin}/#/modele/titre`);
        await page.getByRole('textbox', { name: 'Message pour la scène' }).fill('Bonjour', { timeout: 60_000 });
        const sent = page.waitForRequest((r) => r.url().endsWith('/chats/scene:titre/messages') && r.method() === 'POST');
        await page.getByRole('button', { name: 'Envoyer' }).click();
        const body = (await sent).postDataJSON() as Record<string, unknown>;
        assert.equal(body.model, undefined);
        assert.equal(body.effort, undefined);
        await page.getByText('Réponse factice.').waitFor({ timeout: 30_000 });
        assert.deepEqual(models, [model]);
        await page.context().close();
      } finally {
        await hosted?.close();
        await t.cleanup();
      }
    },
  );
});

describe('agent names', () => {
  let t: Awaited<ReturnType<typeof makeRoot>>;
  let hosted: RunningServer;
  const ID = 'noms';

  before(async () => {
    t = await makeRoot();
    const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
    hosted = await startServer({
      root: ROOT,
      projectsDir,
      brandsDir,
      templatesDir,
      stateDir,
      editorPort: 0,
      framePort: 0,
      quiet: true,
      provider,
      // No Codex CLI behind the agent picked below: its model list stays empty.
      codexPath: path.join(stateDir, 'no-codex'),
    });
    const send = async (method: string, pathname: string, body?: unknown) => {
      const res = await fetch(`${hosted.config.editorOrigin}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': hosted.editorToken },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.ok(res.ok, `${method} ${pathname}: ${res.status}`);
      return res.json();
    };
    await send('POST', '/api/projects', { name: 'Noms', id: ID, brand: 'cadence', formats: ['16:9'], fps: 30 });
    await send('POST', `/api/projects/${ID}/scenes`, { name: 'Deuxième', duration: 3 });
    await send('POST', `/api/projects/${ID}/chats/scene:titre/messages`, { text: 'Bonjour' });
    for (let i = 0; i < 300; i++) {
      const chat = (await send('GET', `/api/projects/${ID}/chats/scene:titre`)) as ChatState;
      if (!chat.running && !chat.queued) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  after(async () => {
    await hosted?.close();
    await t?.cleanup();
  });

  /** The texts that name the agent on the project, and Claude Code's own hints (its subscription, its costs). */
  async function agentTexts(page: Page) {
    const reply = page.locator('article').filter({ hasText: 'Réponse factice.' });
    await reply.waitFor({ timeout: 60_000 });
    const author = await reply.locator('p').first().textContent();

    const pill = page.locator('[aria-label^="Coût estimé des chats de ce projet"]');
    await pill.hover();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const costLabel = await pill.getAttribute('aria-label');
    const costTip = (await page.getByRole('tooltip').allTextContents()).join(' ');
    await page.mouse.move(0, 0);

    await page
      .getByRole('button', { name: /Titre \u2192 Deuxième/ })
      .first()
      .click();
    const seam = page.getByRole('dialog', { name: 'Raccord Titre \u2192 Deuxième' });
    const ask = seam.getByRole('button', { name: /^Demander à/ });
    await ask.waitFor({ timeout: 10_000 });
    const seamText = (await seam.textContent()) ?? '';
    const askLabel = await ask.textContent();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Réglages', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Réglages' });
    await settings.getByRole('button', { name: 'Français' }).waitFor();
    const settingsHint = await settings.getByText(/le coût affiché/).count();
    await page.keyboard.press('Escape');

    await panel(page, 'Médias');
    const references = page.locator('section', { has: page.getByRole('heading', { name: 'Références', exact: true }) });
    const referencesText = (await references.textContent()) ?? '';
    await panel(page, 'Scène');
    return { author, costLabel, costTip, seamText, askLabel, settingsHint, referencesText };
  }

  it(
    "names the active agent, follows a switch in the Profile without a reload, and keeps Claude Code's hints to it",
    {
      timeout: 180_000,
    },
    async () => {
      const page = await newPage();
      await page.route('**/api/agent-accounts', (route) =>
        route.fulfill({
          json: Object.fromEntries(['claude-code', 'codex', 'grok', 'gemini'].map((id) => [id, { ok: true, label: id }])),
        }),
      );
      await page.route('**/seams/detail?**', (route) =>
        route.fulfill({
          json: {
            result: { from: 'titre', to: 'deuxieme', format: '16:9', diffPercent: 1, checkedAt: new Date().toISOString() },
            fromUrl: '',
            toUrl: '',
            diffUrl: '',
          },
        }),
      );
      await page.goto(`${hosted.config.editorOrigin}/#/${ID}/titre`);

      const claude = await agentTexts(page);
      assert.equal(claude.author, 'Claude Code');
      assert.equal(claude.askLabel, 'Demander à Claude Code de corriger');
      assert.match(claude.referencesText, /Claude Code lit ces captures/);
      assert.match(claude.costLabel ?? '', /abonnement Claude/);
      assert.match(claude.costTip, /abonnement Claude/);
      assert.equal(claude.settingsHint, 1);

      await page.evaluate(() => {
        (window as unknown as { sameDocument: boolean }).sameDocument = true;
        location.hash = '#/@profil';
      });
      const codexCard = page.getByRole('listitem', { name: 'Codex' });
      await codexCard.getByRole('button', { name: 'Utiliser' }).click({ timeout: 60_000 });
      await codexCard.getByRole('button', { name: 'Utilisé' }).waitFor();
      await page.evaluate((hash) => (location.hash = hash), `#/${ID}/titre`);

      const codex = await agentTexts(page);
      assert.equal(codex.author, 'Codex');
      assert.equal(codex.askLabel, 'Demander à Codex de corriger');
      assert.match(codex.referencesText, /Codex lit ces captures/);
      for (const [where, text] of Object.entries({
        author: codex.author,
        seam: codex.seamText,
        references: codex.referencesText,
        cost: codex.costLabel,
      })) {
        assert.doesNotMatch(text ?? '', /Claude/, where);
      }
      assert.deepEqual([codex.costTip, codex.settingsHint], ['', 0]);
      assert.equal(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument), true, 'no reload');
      await page.context().close();
    },
  );
});

describe('pitch', () => {
  const title = 'Décrivez une vidéo, Claude Code ou Codex l’écrit scène par scène.';
  let t: Awaited<ReturnType<typeof makeRoot>>;
  let hosted: RunningServer;

  // No project: the home shows the pitch.
  before(async () => {
    t = await makeRoot();
    const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
    hosted = await startServer({
      root: ROOT,
      projectsDir,
      brandsDir,
      templatesDir,
      stateDir,
      editorPort: 0,
      framePort: 0,
      quiet: true,
      provider,
    });
  });

  after(async () => {
    await hosted?.close();
    await t?.cleanup();
  });

  it('turns through the agent names once, then stays on the first', { timeout: 120_000 }, async () => {
    const page = await newPage();
    // The turns run on the page's timers only: the clock stands still until the test moves it.
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 1000);
    await page.goto(`${hosted.config.editorOrigin}/#/`);
    const heading = page.getByRole('heading', { name: title, exact: true });
    await heading.waitFor({ timeout: 60_000 });
    const names = heading.locator('[aria-hidden] > span > span');
    // Each name with its opacity once its animation has ended.
    const shown = (expected: string[]) =>
      names.evaluateAll(
        (spans, expected) =>
          spans.every((span) => span.getAnimations().every((a) => a.playState === 'finished')) &&
          spans.map((span) => `${span.textContent} ${getComputedStyle(span).opacity}`).join(', ') === expected.join(', '),
        expected,
      );
    const settle = async (expected: string[]) => {
      for (let i = 0; i < 100 && !(await shown(expected)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        await names.evaluateAll((spans) => spans.map((span) => `${span.textContent} ${getComputedStyle(span).opacity}`)),
        expected,
      );
    };

    await settle(['Claude Code 1', 'Codex 0']);
    await page.clock.runFor(2000);
    await settle(['Claude Code 0', 'Codex 1']);
    await page.clock.runFor(2000);
    await settle(['Claude Code 1', 'Codex 0']);
    // Back on the first, the title stays still: a next turn would show Codex.
    await page.clock.runFor(10_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await settle(['Claude Code 1', 'Codex 0']);
    assert.equal(await heading.count(), 1);
    await page.context().close();
  });

  it('shows every agent name at once under reduced motion', { timeout: 120_000 }, async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'fr-FR',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(`${hosted.config.editorOrigin}/#/`);
    const heading = page.getByRole('heading', { name: title, exact: true });
    await heading.waitFor({ timeout: 60_000 });
    assert.equal(await heading.locator('[aria-hidden]').count(), 0);
    assert.equal(await heading.textContent(), title);
    await context.close();
  });
});
