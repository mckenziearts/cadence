// The editor page and its assets: a production build made at every start (about 150 ms, kept in memory, so never
// stale), or Vite's dev server for work on Cadence itself (`npm run dev`).
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, type Rolldown, type ViteDevServer } from 'vite';
import { m } from './i18n';

export interface EditorApp {
  /** index.html, before the server adds the token and the frame origin. */
  html(url: string): Promise<string>;
  /** What the editor origin serves besides its page, the API, MCP and the network callbacks. */
  serve(req: IncomingMessage, res: ServerResponse): void;
}

export function devEditor(vite: ViteDevServer, root: string): EditorApp {
  return {
    html: async (url) => vite.transformIndexHtml(url, await fs.readFile(path.join(root, 'index.html'), 'utf8')),
    serve: (req, res) => vite.middlewares(req, res),
  };
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Vite reads NODE_ENV for the React build it bundles: startServer() sets it first. */
export async function builtEditor(root: string): Promise<EditorApp> {
  const result = await build({
    root,
    configFile: false,
    envDir: false,
    logLevel: 'warn',
    plugins: [react(), tailwindcss()],
    build: {
      write: false,
      copyPublicDir: false,
      // Loaded from this machine: one bundle is fine, and the warning would print at every start.
      chunkSizeWarningLimit: 2048,
      rolldownOptions: { input: path.join(root, 'index.html') },
    },
  });
  let html = '';
  const files = new Map<string, Buffer>();
  for (const file of (result as Rolldown.RolldownOutput).output) {
    const body = Buffer.from(file.type === 'chunk' ? file.code : file.source);
    if (file.fileName === 'index.html') html = body.toString();
    else files.set(`/${file.fileName}`, body);
  }
  return {
    html: async () => html,
    serve(req, res) {
      const { pathname } = new URL(req.url ?? '/', 'http://local');
      const body = files.get(pathname);
      if (!body || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(m().core.http.notFound);
        return;
      }
      sendFile(req, res, body, TYPES[path.extname(pathname)] ?? 'application/octet-stream');
    },
  };
}

/** File names carry a hash: one never changes. Audio previews ask for byte ranges, which Safari requires. */
function sendFile(req: IncomingMessage, res: ServerResponse, body: Buffer, type: string): void {
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  let [start, end] = [0, body.length - 1];
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) [start, end] = [Number(range[1]), range[2] ? Math.min(Number(range[2]), end) : end];
    else start = Math.max(0, body.length - Number(range[2]));
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(headers['Content-Range'] ? 206 : 200, headers);
  res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
}
