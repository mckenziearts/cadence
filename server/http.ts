// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import type { AccountService, CadenceConfig, McpTokenIssuer } from './contracts';
import type { EditorApp } from './editor';
import { language, m } from './i18n';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface EditorHandlerDeps {
  config: CadenceConfig;
  /** Random per start; only the editor HTML carries it. */
  editorToken: string;
  tokens: Pick<McpTokenIssuer, 'resolve'>;
  accounts: Pick<AccountService, 'callback'>;
  api: { fetch: (request: Request, env: HttpBindings) => Response | Promise<Response> };
  mcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  editor: EditorApp;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/** Request handler of the editor origin: guards (see ARCHITECTURE.md "Processes, origins and security"), then routing. */
export function createEditorHandler(deps: EditorHandlerDeps): Handler {
  const { config, editorToken, tokens, accounts, mcp, editor } = deps;
  const api = getRequestListener(deps.api.fetch as (request: Request, env: unknown) => Response | Promise<Response>);
  const hosts = new Set([`127.0.0.1:${config.editorPort}`, `localhost:${config.editorPort}`]);

  return (req, res) => {
    // DNS rebinding: a hostile name resolving to 127.0.0.1 carries its own Host header.
    if (!hosts.has(req.headers.host ?? '')) return reply(res, 403, m().core.http.host);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://local');
    } catch {
      return reply(res, 400, m().core.http.badRequest);
    }
    const { pathname, searchParams } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const safe = SAFE_METHODS.has(method);
      // The frame origin is `cross-site` (`same-site` for an editor opened as localhost): scene code must never reach the API.
      const fetchSite = header(req, 'sec-fetch-site');
      const sseToken = safe && pathname === '/api/events' && sameToken(searchParams.get('token') ?? undefined, editorToken);
      if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite) && !sseToken) {
        return reply(res, 403, m().core.http.crossSite, true);
      }
      // A custom header forces a CORS preflight, which is never approved: only the editor page can send it.
      if (!safe && !sameToken(header(req, 'x-cadence-token'), editorToken)) {
        // `code`: what the editor recognizes (a page older than the server), whatever the language.
        return reply(res, 403, m().core.http.token, true, 'token');
      }
      void api(req, res);
      return;
    }

    if (pathname === '/mcp') {
      // Browsers always send Origin on these requests; MCP clients never do.
      if (req.headers.origin) return reply(res, 403, m().core.http.origin, true);
      const bearer = /^Bearer (.+)$/.exec(header(req, 'authorization') ?? '')?.[1];
      if (!tokens.resolve(bearer)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return reply(res, 401, m().core.http.mcpToken, true);
      }
      mcp(req, res).catch((e: Error) => {
        console.error(m().core.http.mcpLog, e);
        if (!res.headersSent) reply(res, 500, m().core.http.mcpError(e.message), true);
        else res.end();
      });
      return;
    }

    // A network sends the person back here once they allow Cadence: a cross-site navigation, hence outside /api. The
    // single-use state, issued through POST /api/networks/:id/connect (editor token), is what authorizes it.
    const callback = /^\/oauth\/([a-z]+)\/callback$/.exec(pathname);
    if (callback && SAFE_METHODS.has(method)) {
      accounts.callback(callback[1], searchParams).then(
        (result) => {
          res.writeHead(result.ok ? 200 : 400, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(callbackPage(result));
        },
        (e: Error) => reply(res, 500, m().accounts.callback.unavailable(e.message)),
      );
      return;
    }

    // Frames and kits (scene and brand code) live on the frame origin only; Vite's open-in-editor endpoint would let any
    // website launch the user's editor.
    if (pathname === '/frame.html' || pathname === '/kit.html' || pathname.startsWith('/__open-in-editor')) {
      return reply(res, 404, m().core.http.notFound);
    }
    if ((pathname === '/' || pathname === '/index.html') && SAFE_METHODS.has(method)) {
      editorHtml(req.url ?? '/').then(
        (html) => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(html);
        },
        (e: Error) => reply(res, 500, m().core.http.editorUnavailable(e.message)),
      );
      return;
    }
    editor.serve(req, res);
  };

  async function editorHtml(url: string): Promise<string> {
    const html = await editor.html(url);
    const meta = `<meta name="cadence-token" content="${editorToken}" />\n    <meta name="cadence-frame-origin" content="${config.frameOrigin}" />`;
    // The page starts in the server's language; the editor then follows the setting.
    return html
      .replace(/<html lang="[a-z]+"/i, `<html lang="${language()}"`)
      .replace(/<head[^>]*>/i, (head) => `${head}\n    ${meta}`);
  }
}

/** What the person reads in the tab the network sent back; it closes itself when the connection worked. */
function callbackPage(result: { ok: boolean; title: string; detail: string }): string {
  const text = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="${language()}">
<head>
<meta charset="utf-8">
<title>${text(result.title)}</title>
<style>
body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f4efe4; color: #18181b; font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 30rem; margin: 1rem; padding: 1.5rem 1.75rem; border: 2px solid #18181b; background: #fffdf8; box-shadow: 4px 4px 0 #18181b; }
h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>${text(result.title)}</h1>
<p>${text(result.detail)}</p>
<p><a href="/#/@profil">${text(m().accounts.callback.back)}</a></p>
</main>
${result.ok ? '<script>setTimeout(() => window.close(), 1500);</script>' : ''}
</body>
</html>
`;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, message: string, json = false, code?: string): void {
  res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' });
  res.end(json ? JSON.stringify({ error: message, code }) : message);
}
