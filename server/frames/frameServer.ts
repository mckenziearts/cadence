// Request handler of the FRAME origin, every response under its CSP: frame.html, read-only project data for the frame
// page, and Vite modules (runtime, brands, scenes). Scene code runs here, on an origin that cannot reach the editor API.
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { BrandFile, ProjectState } from '../../src/shared/types';
import type { BrandStore, CadenceConfig, ProjectStore } from '../contracts';
import { language, m } from '../i18n';
import { assertId, HttpError } from '../util';
import { diagnoseFile } from './vite';

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

export function createFrameHandler(deps: {
  config: CadenceConfig;
  vite: ViteDevServer;
  store: ProjectStore;
  brands: BrandStore;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, vite, store, brands } = deps;

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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // On every response, not only the pages: scene code could load any other document of this origin (project data, an
    // SVG or HTML asset, an error page) in an iframe and send requests from there.
    res.setHeader('Content-Security-Policy', frameCsp(config));
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${config.framePort}` && host !== `localhost:${config.framePort}`) {
      return send(res, req, 403, 'text/plain; charset=utf-8', m().core.http.host);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, req, 405, 'text/plain; charset=utf-8', m().api.frames.method);
    }
    const url = req.url ?? '/';
    const { pathname } = new URL(url, 'http://frame');
    if (pathname === '/frame.html' || pathname === '/kit.html') {
      res.setHeader('Cache-Control', 'no-store');
      return send(
        res,
        req,
        200,
        'text/html; charset=utf-8',
        await frameHtml(url, pathname === '/kit.html' ? 'kit.html' : 'frame.html'),
      );
    }
    // Ids are [a-z0-9-]: anything percent-encoded fails assertId.
    let match = /^\/frame-api\/projects\/([^/]+)$/.exec(pathname);
    if (match) return json(res, req, 200, await projectData(match[1]));
    match = /^\/frame-api\/brands\/([^/]+)$/.exec(pathname);
    if (match) {
      const brandId = assertId(match[1], m().api.ids.brand);
      const data: FrameBrandData = { brand: await brands.get(brandId), brandId, brandUrl: `/@fs${brands.dir(brandId)}/` };
      return json(res, req, 200, data);
    }
    match = /^\/frame-api\/projects\/([^/]+)\/scenes\/([^/]+)\/diagnostics$/.exec(pathname);
    if (match) {
      const file = store.sceneFile(assertId(match[1], m().api.ids.project), assertId(match[2], m().api.ids.scene));
      return json(res, req, 200, { error: await diagnoseFile(vite, file) });
    }
    // Vite's /__open-in-editor would let any page (or scene) launch the user's code editor.
    if (pathname === '/' || pathname === '/index.html' || /^\/(api|mcp|frame-api|__open-in-editor)(\/|$)/.test(pathname)) {
      return send(res, req, 404, 'text/plain; charset=utf-8', m().core.http.notFound);
    }
    // The editor's brand panel loads the brand fonts from here: kit.html tells it the files, never the kit's CSS.
    const origin = req.headers.origin;
    if (origin && FONT_FILE.test(pathname) && editorOrigins(config).includes(origin)) {
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
