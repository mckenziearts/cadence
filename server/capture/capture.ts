// Headless Chromium rendering frame.html pages: the agent's frames, thumbnails, seam checks, brand kit sheets and
// reference screenshots of web pages. MP4 renders open their own pages with the same helpers (render.ts).
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, errors as playwrightErrors, type Browser, type BrowserContext, type Page } from 'playwright';
import type { FrameRenderResult } from '../../src/shared/frameProtocol';
import { FORMATS, isFormatId, type FormatId, type ProjectState, type SceneState } from '../../src/shared/types';
import { captureLocale } from '../config';
import type { CadenceConfig, CapturedFrame, CaptureService, ProjectStore } from '../contracts';
import { language, m } from '../i18n';
import { formatSeconds, HttpError, KeyedMutex, roundMs, shortHash, writeFileAtomic } from '../util';
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
/** The discard port: nothing listens there, so capture pages reach nothing but their own origin (bypassed). */
const NOWHERE_PROXY = 'http://127.0.0.1:9';

/** Never captured, whatever the entry point: link-local (cloud metadata), unspecified, multicast and broadcast. */
const RESERVED = new net.BlockList();
RESERVED.addSubnet('169.254.0.0', 16);
RESERVED.addSubnet('0.0.0.0', 8);
RESERVED.addSubnet('224.0.0.0', 3);
RESERVED.addSubnet('fe80::', 10, 'ipv6');
RESERVED.addAddress('::', 'ipv6');
RESERVED.addSubnet('ff00::', 8, 'ipv6');
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8);
LOOPBACK.addAddress('::1', 'ipv6');

export class FrameTimeoutError extends Error {}

export async function launchChromium(): Promise<Browser> {
  try {
    // Playwright's own handlers would exit on Ctrl+C before Cadence stops its turns and renders, and its SIGHUP handler
    // keeps the process alive once the terminal is closed: Cadence closes the browser itself (server.close()).
    return await chromium.launch({ args: CHROMIUM_ARGS, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (e) {
    throw new Error(m().media.capture.chromium((e as Error).message));
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
  opts: { width: number; height: number; scale: number },
): Promise<FramePage & { problems: string[] }> {
  const origin = new URL(frameOrigin);
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale,
    locale: captureLocale(),
    // Service workers' requests would skip the routes below.
    serviceWorkers: 'block',
    proxy: { server: NOWHERE_PROXY, bypass: origin.hostname },
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
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
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
  opts: { projectId: string; sceneId: string | null; format: FormatId; scale: number; captions?: boolean },
): Promise<FramePage> {
  const { width, height } = FORMATS[opts.format];
  const { context, page, problems } = await openIsolatedPage(browser, frameOrigin, { width, height, scale: opts.scale });
  try {
    const params = new URLSearchParams({ project: opts.projectId, format: opts.format, mode: 'capture' });
    if (opts.sceneId) params.set('scene', opts.sceneId);
    if (opts.captions === false) params.set('captions', '0');
    await page.goto(`${frameOrigin}/frame.html?${params}`, { timeout: LOAD_TIMEOUT_MS });
    if (!(await page.evaluate(() => window.__cadence !== undefined))) {
      throw new Error(m().media.capture.frameNotStarted(problems));
    }
    await withTimeout(
      page.evaluate(() => window.__cadence!.ready),
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
export function seekFrame(page: Page, t: number, timeoutMs = RENDER_TIMEOUT_MS): Promise<FrameRenderResult> {
  return withTimeout(
    page.evaluate((time) => window.__cadence!.seek(time), t),
    timeoutMs,
    m().media.capture.seekTimeout(formatSeconds(t), timeoutMs / 1000),
  );
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
  private browserPromise: Promise<Browser> | null = null;
  /** Captures queued behind a slot lock must not launch a new Chromium once the service is closed. */
  private closed = false;
  private slots = new Map<string, Slot>();
  private locks = new KeyedMutex();
  /** Code generations restart at 0 in every process: cached thumbnails of an earlier run must never match. */
  private readonly run = randomBytes(4).toString('hex');

  constructor(deps: { config: CadenceConfig; store: ProjectStore; renderTimeoutMs?: number }) {
    this.config = deps.config;
    this.store = deps.store;
    this.timeoutMs = deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
  }

  private browser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new HttpError(503, m().media.capture.stopping));
    if (!this.browserPromise) {
      const launching = launchChromium();
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
          page.evaluate((g) => window.__cadence!.reload(g), generation),
          this.timeoutMs,
          m().media.reloadTimeout,
        );
        if (sceneId) {
          await withTimeout(
            page.evaluate((id) => window.__cadence!.setScene(id), sceneId),
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
    });
    try {
      const params = new URLSearchParams({ brand: brandId, v: String(Date.now()) });
      await page.goto(`${this.config.frameOrigin}/kit.html?${params}`, { timeout: LOAD_TIMEOUT_MS });
      const sheet = await withTimeout(
        page.evaluate(
          (missing) => window.__cadenceKit?.ready ?? { problems: [missing], loaded: true },
          m().media.capture.kitNotStarted,
        ),
        LOAD_TIMEOUT_MS,
        m().media.capture.kitLoadTimeout,
      );
      const image = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true, timeout: 30_000 });
      return { image, problems: [...new Set([...sheet.problems, ...problems])], loaded: sheet.loaded };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async contactSheet(tiles: Buffer[], layout: { columns: number; gap: number }): Promise<Buffer> {
    return contactSheet(await this.browser(), tiles, layout);
  }

  async screenshotUrl(url: string, opts: { device: 'desktop' | 'mobile'; fullPage?: boolean }): Promise<Buffer> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new HttpError(400, m().media.capture.invalidUrl(url));
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new HttpError(400, m().media.capture.httpOnly);
    }
    // Every request is checked, per origin: local dev sites are fine, Cadence itself and reserved addresses are not.
    const ownPorts = [this.config.editorPort, this.config.framePort];
    const checked = new Map<string, Promise<string | null>>();
    const check = (href: string): Promise<string | null> => {
      const url = new URL(href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve(null);
      let reason = checked.get(url.origin);
      if (!reason) checked.set(url.origin, (reason = refusal(url, ownPorts)));
      return reason;
    };
    const first = await check(target.href);
    if (first) throw new HttpError(400, first);
    const browser = await this.browser();
    const context = await browser.newContext({
      ...(opts.device === 'mobile'
        ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: MOBILE_UA }
        : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }),
      // Service workers' requests would skip the route below.
      serviceWorkers: 'block',
    });
    let refused = null as string | null;
    const pending: Promise<void>[] = [];
    try {
      await context.route('**', async (route) => {
        const reason = await check(route.request().url());
        await (reason ? route.abort('aborted') : route.continue()).catch(() => undefined);
      });
      // Routes never see redirect hops (Playwright follows them itself), so each hop is checked as it starts and a
      // refused one voids the capture. That hop still gets its request; a checking forward proxy would stop it.
      context.on('request', (request) => {
        if (!request.redirectedFrom()) return;
        const hop = check(request.url()).then((reason) => {
          if (!reason || refused) return;
          refused = reason;
          void context.close().catch(() => undefined);
        });
        pending.push(hop);
      });
      const page = await context.newPage();
      const shot = await (async () => {
        try {
          await page.goto(target.href, { waitUntil: 'networkidle', timeout: 30_000 });
        } catch (e) {
          // Pages that keep polling never go idle: take what has loaded after 30 s.
          if (!(e instanceof playwrightErrors.TimeoutError)) {
            throw new HttpError(502, m().media.capture.openFailed(target.href, (e as Error).message.split('\n')[0]));
          }
        }
        await sleep(500);
        return page.screenshot({ type: 'png', fullPage: Boolean(opts.fullPage), timeout: 30_000 });
      })().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      await Promise.all(pending);
      if (refused) throw new HttpError(400, refused);
      if (shot instanceof Error) throw shot;
      return shot;
    } finally {
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

/**
 * Why a reference capture may not load `url`, or null. Host names are resolved: a public name may point at a reserved
 * address. Local dev servers stay allowed (a documented use), except Cadence's own ports.
 * Chromium resolves the name again: a DNS answer that changes in between (rebinding) is not caught.
 */
async function refusal(url: URL, ownPorts: number[]): Promise<string | null> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = await dns.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) return m().media.capture.hostNotFound(url.hostname);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  for (const { address, family } of addresses) {
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (RESERVED.check(address, type)) {
      return m().media.capture.reserved(url.hostname, address === host ? null : address);
    }
    if (LOOPBACK.check(address, type) && ownPorts.includes(port)) return m().media.capture.itself;
  }
  return null;
}
