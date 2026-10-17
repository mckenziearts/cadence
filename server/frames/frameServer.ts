// Request handler of the FRAME origin, every response under its CSP: frame.html, read-only project data for the frame
// page, and Vite modules (runtime, brands, scenes). Scene code runs here, on an origin that cannot reach the editor API.
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { type FrameKind, frameLabel, frameSite } from '../../src/shared/frameOrigin';
import { type BrandFile, ID_PATTERN, type ProjectState } from '../../src/shared/types';
import type { BrandStore, CadenceConfig, ProjectStore } from '../contracts';
import { hasRequestSecret } from '../http';
import { language, m } from '../i18n';
import { assertId, HttpError } from '../util';
import { diagnoseFile, frameReach } from './vite';

/** GET /frame-api/brands/:id (kit.html) */
export interface FrameBrandData {
  brand: BrandFile;
  brandId: string;
  /** Module URL of the brand folder, with a trailing slash. */
  brandUrl: string;
}

/** GET /frame-api/projects/:id */
export interface FrameProjectData {
  project: ProjectState;
  brand: BrandFile;
  brandId: string;
  /** Module URL of the brand folder, with a trailing slash (`<brandUrl>theme.css`, `<brandUrl>index.tsx`). */
  brandUrl: string;
}

const FONT_FILE = /\.(woff2?|ttf|otf)$/i;
/** What Vite serves on its own (no file under the managed dirs): its client, which frame.html and kit.html import. */
const VITE_CLIENT = new Set(['/@vite/client', '/@vite/env']);

interface Site {
  kind: FrameKind;
  id: string;
}

export function createFrameHandler(deps: {
  config: CadenceConfig;
  vite: ViteDevServer;
  store: ProjectStore;
  brands: BrandStore;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, vite, store, brands } = deps;
  /** `<kind> <label>` to id. A label nobody knows rescans the folder: the project or brand may be new. */
  const ids = new Map<string, string>();

  async function scan(kind: FrameKind): Promise<void> {
    const names = await fs.readdir(kind === 'project' ? config.projectsDir : config.brandsDir).catch(() => []);
    for (const name of names.filter((n) => ID_PATTERN.test(n))) ids.set(`${kind} ${await frameLabel(name)}`, name);
  }

  /** The existing project or brand whose origin the Host names, else null. */
  async function siteOf(host: string): Promise<Site | null> {
    const site = frameSite(config.frameOrigin, host);
    if (!site) return null;
    const key = `${site.kind} ${site.label}`;
    if (!ids.has(key)) await scan(site.kind);
    const id = ids.get(key);
    if (!id || !(await (site.kind === 'project' ? store : brands).exists(id))) return null;
    return { kind: site.kind, id };
  }

  async function frameHtml(url: string, page: 'frame.html' | 'kit.html'): Promise<string> {
    const source = await fs.readFile(path.join(config.root, page), 'utf8');
    const meta = `<meta name="cadence-editor-origin" content="${editorOrigins(config).join(' ')}" />`;
    const html = source.replace(/<html lang="[a-z]+"/i, `<html lang="${language()}"`).replace('</head>', `  ${meta}\n  </head>`);
    return vite.transformIndexHtml(url, html);
  }

  async function projectData(id: string): Promise<FrameProjectData> {
    const project = await store.get(assertId(id, m().api.ids.project));
    const brandId = project.brand ?? 'cadence';
    const brand = await brands.get(brandId);
    return { project, brand, brandId, brandUrl: `/@fs${brands.dir(brandId)}/` };
  }

  /** What the frame of `site` may load (see frameReach). */
  function reach(site: Site): Promise<(file: string) => Promise<boolean>> {
    return frameReach(vite, config, path.join(site.kind === 'project' ? config.projectsDir : config.brandsDir, site.id));
  }

  /**
   * Whether Vite may answer `url` on the origin of `site`. Vite serves a plain file at its path, and a module from the
   * file it resolves the URL to, where a plugin may point it: both must be readable. A `.map` is the source map of the
   * module without it.
   */
  async function servable(site: Site, url: string): Promise<boolean> {
    let decoded: string;
    try {
      decoded = decodeURI(url);
    } catch {
      return false;
    }
    const pathname = decoded.replace(/[?#].*$/, '');
    if (VITE_CLIENT.has(pathname)) return true;
    // Vite, its file server and the browser each normalize these their own way (and `__x00__` is Vite's NUL).
    if (/[\\\0]|__x00__/.test(decoded) || pathname.split('/').some((s) => s === '.' || s === '..')) return false;
    const file = pathname.startsWith('/@fs/') ? pathname.slice('/@fs'.length) : path.join(config.root, pathname);
    const readable = await reach(site);
    if (!(await readable(file))) return false;
    const moduleUrl = decoded.replace(/\.map($|\?)/, '$1');
    const env = vite.environments.client;
    const id =
      (await env.moduleGraph.getModuleByUrl(moduleUrl))?.id ?? (await env.pluginContainer.resolveId(moduleUrl))?.id ?? moduleUrl;
    // A virtual module comes from a plugin, not from a file.
    return id.startsWith('\0') || readable(id.replace(/[?#].*$/, ''));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // On every response, not only the pages: scene code could load any other document of this origin (project data, an
    // SVG or HTML asset, an error page) in an iframe and send requests from there.
    res.setHeader('Content-Security-Policy', frameCsp(config));
    // Scene code must not reach another host through a DNS lookup of a link it renders.
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (config.requestSecret && !hasRequestSecret(req, config.requestSecret)) {
      return send(res, req, 403, 'text/plain; charset=utf-8', m().core.http.secret);
    }
    // One origin per project and per brand, so scene or kit code never shares storage or same-origin frames with another
    // project's or brand's. The Host check also stops DNS rebinding.
    const site = await siteOf(req.headers.host ?? '');
    if (!site) return send(res, req, 403, 'text/plain; charset=utf-8', m().core.http.host);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, req, 405, 'text/plain; charset=utf-8', m().api.frames.method);
    }
    const url = req.url ?? '/';
    const { pathname, search } = new URL(url, 'http://frame');
    if (pathname === '/frame.html' || pathname === '/kit.html') {
      // A scene can navigate its own iframe to another frame origin: the page there loads that origin's project or brand
      // only, never the one the scene names.
      const kind = pathname === '/kit.html' ? 'brand' : 'project';
      if (site.kind !== kind || new URLSearchParams(search).get(kind) !== site.id) {
        return send(res, req, 403, 'text/plain; charset=utf-8', m().api.frames.forbidden);
      }
      res.setHeader('Cache-Control', 'no-store');
      return send(res, req, 200, 'text/html; charset=utf-8', await frameHtml(url, kind === 'brand' ? 'kit.html' : 'frame.html'));
    }
    let match = /^\/frame-api\/projects\/([^/]+)$/.exec(pathname);
    if (match) return json(res, req, 200, await projectData(own(site, 'project', match[1])));
    match = /^\/frame-api\/brands\/([^/]+)$/.exec(pathname);
    if (match) {
      const brandId = own(site, 'brand', match[1]);
      const data: FrameBrandData = { brand: await brands.get(brandId), brandId, brandUrl: `/@fs${brands.dir(brandId)}/` };
      return json(res, req, 200, data);
    }
    match = /^\/frame-api\/projects\/([^/]+)\/scenes\/([^/]+)\/diagnostics$/.exec(pathname);
    if (match) {
      const file = store.sceneFile(own(site, 'project', match[1]), assertId(match[2], m().api.ids.scene));
      return json(res, req, 200, { error: await diagnoseFile(vite, file, await reach(site)) });
    }
    // Vite's /__open-in-editor would let any page (or scene) launch the user's code editor.
    // Such a query makes Vite compile a file of any extension as CSS (isCSSRequest), and Tailwind with it.
    if (
      pathname === '/' ||
      pathname === '/index.html' ||
      /^\/(api|mcp|frame-api|__open-in-editor)(\/|$)/.test(pathname) ||
      compiledAsCss(search)
    ) {
      return send(res, req, 404, 'text/plain; charset=utf-8', m().core.http.notFound);
    }
    // A brand theme holds the classes of the project it is compiled for (see compileStylesheet in vite.ts).
    if (!compiledForOwnProject(site, search)) return send(res, req, 403, 'text/plain; charset=utf-8', m().api.frames.forbidden);
    // fs.allow covers every project and brand: a frame reads only its own, whatever path or module leads to another.
    if (!(await servable(site, url))) return send(res, req, 403, 'text/plain; charset=utf-8', m().api.frames.forbidden);
    // The editor's brand panel loads the brand fonts from the brand's origin: kit.html tells it the files, never the kit's CSS.
    const origin = req.headers.origin;
    if (site.kind === 'brand' && origin && FONT_FILE.test(pathname) && editorOrigins(config).includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    vite.middlewares(req, res);
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : m().api.internalError(e instanceof Error ? e.message : String(e));
      json(res, req, status, { error: message });
    });
  };
}

/** `id` when it is the project or brand of this origin's site, else 403: a frame reads no other's data. */
function own(site: Site, kind: FrameKind, id: string): string {
  if (site.kind !== kind || id !== site.id) throw new HttpError(403, m().api.frames.forbidden);
  return id;
}

/** No `project=`, or only this origin's project: Vite decodes the URL once more before the plugins read the query. */
function compiledForOwnProject(site: Site, search: string): boolean {
  try {
    return new URLSearchParams(decodeURI(search)).getAll('project').every((id) => site.kind === 'project' && id === site.id);
  } catch {
    return false;
  }
}

/** Vite decodes the URL before Tailwind sees it; a query that does not decode is refused too. */
function compiledAsCss(search: string): boolean {
  try {
    return /lang\.css|index=\d+\.css/i.test(decodeURIComponent(search));
  } catch {
    return true;
  }
}

/** The editor may be opened as 127.0.0.1 or localhost (the editor server accepts both). */
export function editorOrigins(config: CadenceConfig): string[] {
  return [`http://127.0.0.1:${config.editorPort}`, `http://localhost:${config.editorPort}`];
}

/**
 * Scene code may only load from this origin (no fetch, image, font or script from elsewhere) and only the editor may
 * embed the frame. Vite dev modules are same-origin scripts and CSS arrives as <style> tags. Vite's client still tries
 * its HMR websocket (another port, HMR is off): the CSP blocks it, which is intended.
 */
function frameCsp(config: CadenceConfig): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${editorOrigins(config).join(' ')}`,
  ].join('; ');
}

function send(res: ServerResponse, req: IncomingMessage, status: number, type: string, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

function json(res: ServerResponse, req: IncomingMessage, status: number, value: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  send(res, req, status, 'application/json; charset=utf-8', JSON.stringify(value));
}
