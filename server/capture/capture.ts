// Headless Chromium rendering frame.html pages: the agent's frames, thumbnails, seam checks, brand kit sheets and
// reference screenshots of web pages. MP4 renders open their own pages with the same helpers (render.ts).
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { errors as playwrightErrors, type Browser, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import type { AuditFinding, FrameRenderResult } from '../../src/shared/frameProtocol';
import { FORMATS, isFormatId, type FormatId, type ProjectState, type SceneState } from '../../src/shared/types';
import { captureLocale, CHROMIUM_SANDBOX_FAILED, chromiumSandbox } from '../config';
import type { BrowserServer, CadenceConfig, CapturedFrame, CaptureService, ChromiumOptions, ProjectStore } from '../contracts';
import { language, m } from '../i18n';
import { formatSeconds, HttpError, KeyedMutex, roundMs, shortHash, writeFileAtomic } from '../util';
import { hostChromium } from './browser-host';
import { Budget, fetchPinned, network, type Pinned, type PinnedDeps, Refused } from './pinned';
import { type Policy, portOf, STRICT, urlRefusal } from './policy';
import { contactSheet } from './sheet';

export const CHROMIUM_ARGS = [
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // Frames are produced on demand, not at 60 Hz: seek() stops waiting for vsync (about 50 ms down to 35 ms per 1080p frame).
  '--disable-frame-rate-limit',
  // Animated GIF/WebP/SVG images would play on the wall clock: they keep their first frame (motion comes from t).
  '--blink-settings=imageAnimationPolicy=2',
  // Less raster reused from the previous frame, so a frame depends less on what the page drew before it.
  '--disable-partial-raster',
  // WebRTC ignores the CSP and the routes: no UDP, and TCP only through the context's proxy (see openFramePage).
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** One frame (seek + screenshot) may not take longer than this: a scene stuck in a loop freezes its page. */
export const RENDER_TIMEOUT_MS = 20_000;
/** Opening a page includes Vite's first transforms (and dependency optimization on a cold start). */
const LOAD_TIMEOUT_MS = 60_000;
const SLOT_MAX_USES = 150;
/** Each code generation re-imports the brand and scenes, and Playwright keeps every request of a page until it closes. */
const SLOT_MAX_GENERATIONS = 30;
const SLOT_IDLE_MS = 3 * 60_000;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/**
 * The discard port: nothing listens there. Frame pages reach nothing but their own origin (bypassed); reference captures
 * bypass nothing, so whatever their routes do not answer (worker sockets, preconnects) goes nowhere, unresolved.
 */
const NOWHERE_PROXY = 'http://127.0.0.1:9';
/** A reference capture's whole run: the page, its resources and the screenshot. */
const REFERENCE_MS = 60_000;
/** Request headers a reference capture forwards, so a site serves what it would serve this browser. */
const FORWARDED = ['user-agent', 'accept', 'accept-language', 'referer', 'origin'];

export class FrameTimeoutError extends Error {}

/** Scene code decides what its page logs, throws and answers: the server keeps this many lines of it, this long each. */
export const MAX_PROBLEMS = 20;
export const PROBLEM_CHARS = 2000;
const clip = (text: unknown) => String(text).slice(0, PROBLEM_CHARS);

/** What page code throws comes back as the rejection of page.evaluate: a long message is cut like a logged problem. */
export function fromPage<T>(evaluation: Promise<T>): Promise<T> {
  return evaluation.catch((e: unknown) => {
    if (e instanceof Error && e.message.length <= PROBLEM_CHARS) throw e;
    throw new Error(clip(e instanceof Error ? e.message : e));
  });
}

/** Chromium for capture and render pages, in a child process, or in the host app's when it passes its browserServer. */
export async function launchChromium(browserServer?: (options: ChromiumOptions) => Promise<BrowserServer>): Promise<Browser> {
  try {
    // Playwright's own handlers would exit on Ctrl+C before Cadence stops its turns and renders, and its SIGHUP handler
    // keeps the process alive once the terminal is closed: Cadence closes the browser itself (server.close()).
    const options: ChromiumOptions = {
      args: CHROMIUM_ARGS,
      chromiumSandbox: chromiumSandbox(),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
    return await hostChromium(options, browserServer);
  } catch (e) {
    const message = (e as Error).message;
    if (CHROMIUM_SANDBOX_FAILED.test(message))
      throw new Error(m().media.capture.chromiumSandbox(m().media.doctor.chromiumSandboxFix));
    // `npm run setup` installs the core's Chromium: a host app's process brings its own.
    throw new Error(browserServer ? m().media.doctor.chromiumFailed(message) : m().media.capture.chromium(message));
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FrameTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface FramePage {
  context: BrowserContext;
  page: Page;
}

/**
 * A page of the frame origin in its own context. Kit and scene code are untrusted and the frame CSP covers neither
 * navigations, window.open, workers' sockets nor WebRTC: requests may only reach the frame origin, every other
 * connection goes to a proxy that is not there, popups close. `problems` collects page errors and console errors.
 */
async function openIsolatedPage(
  browser: Browser,
  frameOrigin: string,
  opts: { width: number; height: number; scale: number; requestSecret?: string },
): Promise<FramePage & { problems: string[] }> {
  const origin = new URL(frameOrigin);
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale,
    locale: captureLocale(),
    // Service workers' requests would skip the routes below.
    serviceWorkers: 'block',
    proxy: { server: NOWHERE_PROXY, bypass: origin.hostname },
    // HTTP requests to other origins never leave (routes below). WebSockets skip the routes and localhost skips the proxy:
    // there, the frame CSP (connect-src 'self') is what keeps the secret on the frame origin.
    ...(opts.requestSecret ? { extraHTTPHeaders: { 'X-Cadence-Secret': opts.requestSecret } } : {}),
  });
  try {
    // 'aborted' leaves the page where it is: the other codes show an error page, which would end the capture.
    await context.route('**', (route) => {
      const url = new URL(route.request().url());
      const allowed = (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === origin.origin;
      return (allowed ? route.continue() : route.abort('aborted')).catch(() => undefined);
    });
    const page = await context.newPage();
    page.on('popup', (popup) => void popup.close().catch(() => undefined));
    const problems: string[] = [];
    const keep = (text: string) => {
      if (problems.length < MAX_PROBLEMS) problems.push(clip(text));
    };
    page.on('pageerror', (e) => keep(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') keep(message.text());
    });
    return { context, page, problems };
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
}

/** A frame.html page in capture mode: viewport = canvas, device pixel ratio = output scale. */
export async function openFramePage(
  browser: Browser,
  frameOrigin: string,
  opts: {
    projectId: string;
    sceneId: string | null;
    format: FormatId;
    scale: number;
    captions?: boolean;
    requestSecret?: string;
  },
): Promise<FramePage> {
  const { width, height } = FORMATS[opts.format];
  const { context, page, problems } = await openIsolatedPage(browser, frameOrigin, {
    width,
    height,
    scale: opts.scale,
    requestSecret: opts.requestSecret,
  });
  try {
    const params = new URLSearchParams({ project: opts.projectId, format: opts.format, mode: 'capture' });
    if (opts.sceneId) params.set('scene', opts.sceneId);
    if (opts.captions === false) params.set('captions', '0');
    await page.goto(`${frameOrigin}/frame.html?${params}`, { timeout: LOAD_TIMEOUT_MS });
    if (!(await fromPage(page.evaluate(() => window.__cadence !== undefined)))) {
      throw new Error(m().media.capture.frameNotStarted(problems));
    }
    await withTimeout(
      fromPage(page.evaluate(() => window.__cadence!.ready)),
      LOAD_TIMEOUT_MS,
      m().media.capture.frameLoadTimeout,
    );
    return { context, page };
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
}

/** Render time t and wait until it is painted. */
export async function seekFrame(page: Page, t: number, timeoutMs = RENDER_TIMEOUT_MS): Promise<FrameRenderResult> {
  const result = await withTimeout(
    fromPage(page.evaluate((time) => window.__cadence!.seek(time), t)),
    timeoutMs,
    m().media.capture.seekTimeout(formatSeconds(t), timeoutMs / 1000),
  );
  // frames() hands sceneId to the agent.
  return {
    errors: result.errors.slice(0, MAX_PROBLEMS).map(clip),
    sceneId: typeof result.sceneId === 'string' ? clip(result.sceneId) : null,
    localTime: Number(result.localTime),
  };
}

/** The text checks read layout only: past this, the page is stuck (its next seek times out and drops the slot). */
const AUDIT_TIMEOUT_MS = 2_000;
const AUDIT_TEXT_CHARS = 40;

/** Scene code shares the page with the checks: what reaches the agent's summary is validated, one line per text. */
const auditFinding = {
  text: z.string().transform((text) =>
    Array.from(text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '))
      .slice(0, AUDIT_TEXT_CHARS)
      .join(''),
  ),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
};
const auditFindings = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('contrast'), ...auditFinding, ratio: z.number(), required: z.number() }),
      z.object({ kind: z.enum(['clipped', 'offCanvas', 'outsideSafe', 'underCaptions']), ...auditFinding }),
    ]),
  )
  .max(6);

/** The checks of the frame on the page, or null when they throw, hang or return something else: never a failed frame. */
export async function auditFrame(page: Page, timeoutMs = AUDIT_TIMEOUT_MS): Promise<AuditFinding[] | null> {
  try {
    const found = await withTimeout(
      page.evaluate(() => window.__cadence!.audit()),
      timeoutMs,
      'audit timeout',
    );
    const parsed = auditFindings.safeParse(found);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * What a scene renders from besides shared code: its file, timing, position, fps, tempo, music, brand and language.
 * Components and brand files are only covered by the code generation.
 */
export function sceneSignature(project: ProjectState, scene: SceneState): string {
  return shortHash(
    JSON.stringify([
      scene.codeVersion,
      scene.duration,
      scene.start,
      scene.index,
      project.scenes.length,
      scene.name,
      project.fps,
      project.tempo,
      project.brand,
      project.language,
      project.music?.start ?? null,
      project.musicGrid,
    ]),
  );
}

interface Slot extends FramePage {
  uses: number;
  /** The code generation last loaded, and how many the page went through. */
  generation: number;
  generations: number;
  idle?: NodeJS.Timeout;
}

export class PlaywrightCapture implements CaptureService {
  private readonly config: CadenceConfig;
  private readonly store: ProjectStore;
  private readonly timeoutMs: number;
  private readonly browserServer?: (options: ChromiumOptions) => Promise<BrowserServer>;
  private readonly pinned: PinnedDeps;
  private browserPromise: Promise<Browser> | null = null;
  /** Captures queued behind a slot lock must not launch a new Chromium once the service is closed. */
  private closed = false;
  private slots = new Map<string, Slot>();
  private locks = new KeyedMutex();
  /** Code generations restart at 0 in every process: cached thumbnails of an earlier run must never match. */
  private readonly run = randomBytes(4).toString('hex');

  constructor(deps: {
    config: CadenceConfig;
    store: ProjectStore;
    renderTimeoutMs?: number;
    browserServer?: (options: ChromiumOptions) => Promise<BrowserServer>;
    /** How reference captures resolve and dial: the network unless a test stands in. */
    pinned?: PinnedDeps;
  }) {
    this.config = deps.config;
    this.store = deps.store;
    this.timeoutMs = deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
    this.browserServer = deps.browserServer;
    this.pinned = deps.pinned ?? network;
  }

  private browser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new HttpError(503, m().media.capture.stopping));
    if (!this.browserPromise) {
      const launching = launchChromium(this.browserServer);
      this.browserPromise = launching;
      launching.then(
        (browser) =>
          browser.on('disconnected', () => {
            if (this.browserPromise !== launching) return;
            this.browserPromise = null;
            for (const slot of this.slots.values()) clearTimeout(slot.idle);
            this.slots.clear();
          }),
        () => {
          if (this.browserPromise === launching) this.browserPromise = null;
        },
      );
    }
    return this.browserPromise;
  }

  private async drop(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    clearTimeout(slot.idle);
    await slot.context.close().catch(() => undefined);
  }

  /**
   * Run `fn` on the page kept for (project, scene/whole, format, scale, captions), one caller at a time, after bringing the
   * page to the store's current code generation (and scene). Pages are recycled after 150 uses or 30 code generations,
   * after any failure (timeout, crash) and after a few idle minutes.
   */
  private withSlot<T>(
    projectId: string,
    sceneId: string | null,
    format: FormatId,
    scale: number,
    captions: boolean,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    // The language is in the key: frame pages pick theirs at load, a switch must open fresh ones.
    const key = `${projectId}|${sceneId ? 'scene' : 'whole'}|${format}|${scale}|${captions}|${language()}`;
    return this.locks.run(key, async () => {
      const generation = this.store.generation(projectId);
      let slot = this.slots.get(key);
      if (slot && (slot.uses >= SLOT_MAX_USES || slot.generations >= SLOT_MAX_GENERATIONS || slot.page.isClosed())) {
        await this.drop(key);
        slot = undefined;
      }
      if (!slot) {
        const opened = await openFramePage(await this.browser(), this.config.frameOrigin, {
          projectId,
          sceneId,
          format,
          scale,
          captions,
          requestSecret: this.config.requestSecret,
        });
        slot = { ...opened, uses: 0, generation, generations: 0 };
        this.slots.set(key, slot);
      }
      clearTimeout(slot.idle);
      slot.uses++;
      if (slot.generation !== generation) {
        slot.generation = generation;
        slot.generations++;
      }
      try {
        const { page } = slot;
        await withTimeout(
          fromPage(page.evaluate((g) => window.__cadence!.reload(g), generation)),
          this.timeoutMs,
          m().media.reloadTimeout,
        );
        if (sceneId) {
          await withTimeout(
            fromPage(page.evaluate((id) => window.__cadence!.setScene(id), sceneId)),
            this.timeoutMs,
            m().media.capture.sceneLoadTimeout,
          );
        }
        const result = await fn(page);
        slot.idle = setTimeout(() => void this.locks.run(key, () => this.drop(key)), SLOT_IDLE_MS).unref();
        return result;
      } catch (e) {
        await this.drop(key);
        throw e;
      }
    });
  }

  async frames(projectId: string, req: Parameters<CaptureService['frames']>[1]): Promise<CapturedFrame[]> {
    await this.store.syncCode(projectId);
    const project = await this.store.get(projectId);
    const format = req.format ?? project.formats[0];
    if (!isFormatId(format)) throw new HttpError(400, m().media.capture.invalidFormat(String(format)));
    if (req.sceneId !== null && !project.scenes.some((s) => s.id === req.sceneId)) {
      throw new HttpError(404, m().media.sceneNotFound(req.sceneId));
    }
    if (!req.times.every(Number.isFinite)) throw new HttpError(400, m().media.capture.invalidTime);
    const scale = req.scale ?? 0.5;
    if (!(scale >= 0.1 && scale <= 4)) throw new HttpError(400, m().media.invalidScale(scale));
    const type = req.imageFormat ?? 'jpeg';
    // Without captions in the project, both pages draw the same frames: share the one seams and thumbnails use.
    const captions = project.captions && req.captions !== false;
    return this.withSlot(projectId, req.sceneId, format, scale, captions, async (page) => {
      const out: CapturedFrame[] = [];
      for (const t of req.times) {
        if (req.deadline !== undefined && Date.now() >= req.deadline) break;
        const result = await seekFrame(page, t, this.timeoutMs);
        const image = await page.screenshot({
          type,
          quality: type === 'jpeg' ? (req.quality ?? 82) : undefined,
          timeout: this.timeoutMs,
        });
        out.push({
          t,
          sceneId: result.sceneId,
          localTime: result.localTime,
          image,
          mime: type === 'png' ? 'image/png' : 'image/jpeg',
          errors: result.errors,
          ...(req.audit ? { audit: await auditFrame(page) } : {}),
        });
      }
      return out;
    });
  }

  async thumbnail(projectId: string, sceneId: string, opts: { t?: number; format?: FormatId } = {}): Promise<Buffer> {
    await this.store.syncCode(projectId);
    const project = await this.store.get(projectId);
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new HttpError(404, m().media.sceneNotFound(sceneId));
    const format = opts.format ?? project.formats[0];
    if (!isFormatId(format)) throw new HttpError(400, m().media.capture.invalidFormat(String(format)));
    const requested = opts.t ?? scene.duration / 2;
    if (!Number.isFinite(requested)) throw new HttpError(400, m().media.capture.invalidTime);
    const t = roundMs(Math.min(Math.max(0, requested), scene.duration));
    const dir = path.join(project.dir, '.cadence', 'thumbs');
    const prefix = `${scene.id}-${format.replace(':', 'x')}-${t}-`;
    const file = path.join(dir, `${prefix}g${this.run}.${project.codeGeneration}-${sceneSignature(project, scene)}.jpg`);
    const cached = await fs.readFile(file).catch(() => null);
    if (cached) return cached;
    const [frame] = await this.frames(projectId, { sceneId, times: [t], format, scale: 0.25, quality: 80, captions: false });
    if (frame.errors.length === 0) {
      await writeFileAtomic(file, frame.image);
      // Older versions of this thumbnail will never be asked for again.
      for (const name of await fs.readdir(dir)) {
        if (name.startsWith(prefix) && path.join(dir, name) !== file) await fs.rm(path.join(dir, name), { force: true });
      }
    }
    return frame.image;
  }

  async kitSheet(
    brandId: string,
    opts: { scale?: number } = {},
  ): Promise<{ image: Buffer; problems: string[]; loaded: boolean }> {
    const browser = await this.browser();
    const { context, page, problems } = await openIsolatedPage(browser, this.config.frameOrigin, {
      width: 1920,
      height: 1080,
      scale: opts.scale ?? 0.5,
      requestSecret: this.config.requestSecret,
    });
    try {
      const params = new URLSearchParams({ brand: brandId, v: String(Date.now()) });
      await page.goto(`${this.config.frameOrigin}/kit.html?${params}`, { timeout: LOAD_TIMEOUT_MS });
      const sheet = await withTimeout(
        fromPage(
          page.evaluate(
            (missing) => window.__cadenceKit?.ready ?? { problems: [missing], loaded: true },
            m().media.capture.kitNotStarted,
          ),
        ),
        LOAD_TIMEOUT_MS,
        m().media.capture.kitLoadTimeout,
      );
      const image = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true, timeout: 30_000 });
      const found = [...new Set([...sheet.problems.slice(0, MAX_PROBLEMS), ...problems])].slice(0, MAX_PROBLEMS).map(clip);
      return { image, problems: found, loaded: sheet.loaded };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async contactSheet(tiles: Buffer[], layout: { columns: number; gap: number }): Promise<Buffer> {
    return contactSheet(await this.browser(), tiles, layout);
  }

  async screenshotUrl(url: string, opts: { device: 'desktop' | 'mobile'; fullPage?: boolean; policy?: Policy }): Promise<Buffer> {
    const ownPorts = [this.config.editorPort, this.config.framePort];
    const given = opts.policy ?? STRICT;
    const policy: Policy = { ...given, allowsPort: (port) => !ownPorts.includes(port) && given.allowsPort(port) };
    const refusal = urlRefusal(url, policy);
    if (refusal) throw captureError(new Refused(refusal, url), url, ownPorts);
    const done = new AbortController();
    const budget = new Budget(AbortSignal.any([AbortSignal.timeout(REFERENCE_MS), done.signal]), policy);
    const browser = await this.browser();
    const context = await browser.newContext({
      ...(opts.device === 'mobile'
        ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: MOBILE_UA }
        : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }),
      // Service workers' requests would skip the routes below.
      serviceWorkers: 'block',
      // Chromium itself reaches nothing: every request is answered by the routes, from the pinned fetch.
      proxy: { server: NOWHERE_PROXY },
    });
    try {
      // A socket closed before it opens: Vite's client only reloads once a socket that had opened closes.
      await context.routeWebSocket(
        () => true,
        (ws) => ws.close(),
      );
      // The page itself is fetched before Chromium opens it, so its refusals and errors are the capture's.
      let landing: { url: string; response: Fulfilled } | null = null;
      await context.route('**', async (route) => {
        const request = route.request();
        const response = await (async () => {
          // ponytail: GET only, a page that posts its data (forms, GraphQL) renders without it.
          if (request.method() !== 'GET') return null;
          if (landing?.url === request.url()) {
            const { response } = landing;
            landing = null;
            return response;
          }
          const headers = request.headers();
          const pinned = await fetchPinned(request.url(), budget, this.pinned, {
            headers: pick(headers, FORWARDED),
            sameOrigin: true,
          });
          // Playwright 1.63's fulfill grants the page's origin a cross-origin answer that does not name one: the site's
          // own CORS headers decide, as they would in a browser.
          const crossOrigin = headers.origin !== undefined && headers.origin !== new URL(request.url()).origin;
          if (crossOrigin && pinned.headers['access-control-allow-origin'] === undefined) return null;
          return fulfilled(pinned);
        })().catch(() => null);
        await (response ? route.fulfill(response) : route.abort('aborted')).catch(() => undefined);
      });
      const page = await context.newPage();
      context.on('page', (popup) => void popup.close().catch(() => undefined));
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const first = await fetchPinned(url, budget, this.pinned, {
        headers: { 'user-agent': userAgent },
        navigation: true,
      }).catch((e: unknown) => {
        throw captureError(e, url, ownPorts);
      });
      // Opened at its final URL, so a redirected page's relative links resolve there.
      const final = new URL(first.url);
      final.hash = '';
      landing = { url: final.href, response: fulfilled(first) };
      try {
        await page.goto(final.href, { waitUntil: 'networkidle', timeout: 30_000 });
      } catch (e) {
        // Pages that keep polling never go idle: take what has loaded after 30 s.
        if (!(e instanceof playwrightErrors.TimeoutError)) throw captureError(e, url, ownPorts);
      }
      await sleep(500);
      return await page.screenshot({ type: 'png', fullPage: Boolean(opts.fullPage), timeout: 30_000 });
    } finally {
      done.abort();
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const key of [...this.slots.keys()]) await this.drop(key);
    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => undefined);
  }
}

function pick(headers: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]));
}

type Fulfilled = { status: number; headers: Record<string, string>; body: Buffer };

function fulfilled({ status, headers, body }: Pinned): Fulfilled {
  const flat = Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : (value ?? '')]);
  return { status, headers: Object.fromEntries(flat), body };
}

/**
 * What a reference capture tells the person, and the agent: never the page's or the network's own words. A redirect's
 * target shows as its host only, at most a DNS name long.
 */
export function captureError(e: unknown, target: string, ownPorts: number[]): HttpError {
  const capture = m().media.capture;
  if (e instanceof Refused) {
    const url = URL.parse(e.href);
    const host = (url?.hostname ?? '').slice(0, 253);
    switch (e.reason) {
      case 'invalid':
        return e.href === target
          ? new HttpError(400, capture.invalidUrl(target))
          : new HttpError(502, capture.openFailed(target, capture.badRedirect));
      case 'protocol':
        return new HttpError(400, capture.httpOnly);
      case 'port':
        return new HttpError(
          400,
          url && ownPorts.includes(portOf(url)) ? capture.itself : capture.port((url?.host ?? '').slice(0, 259)),
        );
      case 'credentials':
        return new HttpError(400, capture.credentials);
      case 'unresolved':
        return new HttpError(400, capture.hostNotFound(host));
      case 'private':
        return new HttpError(400, capture.reserved(host));
      case 'redirects':
        return new HttpError(502, capture.openFailed(target, capture.redirects));
      case 'too-large':
      case 'budget':
        return new HttpError(502, capture.openFailed(target, capture.tooLarge));
      case 'slow':
        return new HttpError(502, capture.openFailed(target, capture.slow));
    }
  }
  const { name, code } = e as { name?: string; code?: unknown };
  if (name === 'AbortError' || name === 'TimeoutError') return new HttpError(502, capture.openFailed(target, capture.slow));
  const detail = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : capture.unreachable;
  return new HttpError(502, capture.openFailed(target, detail));
}
