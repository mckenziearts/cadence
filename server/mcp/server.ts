// Adapted from saeedvaziry/caleb-video-editor (MIT)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { m } from '../i18n';
import { createToolServer, type McpDeps } from './tools';

export type { McpDeps } from './tools';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

class BodyTooLarge extends Error {}

function fail(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * POST /mcp: streamable HTTP in stateless mode: every request gets a fresh server bound to the scope of its bearer
 * token (per-turn token of a chat, or the terminal token).
 */
export function createMcpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let saved = 0;
  const frameName = (ext: string) => `${Date.now()}-${++saved}.${ext}`;

  return async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, m().agent.mcpServer.method, { Allow: 'POST' });
    // Browsers always send Origin on POST; MCP clients never do.
    if (req.headers.origin !== undefined) return fail(res, 403, m().agent.mcpServer.browser);
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const scope = deps.tokens.resolve(token);
    if (!token || !scope) return fail(res, 401, m().agent.mcpServer.token, { 'WWW-Authenticate': 'Bearer' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      const tooLarge = e instanceof BodyTooLarge;
      return fail(res, tooLarge ? 413 : 400, tooLarge ? m().agent.mcpServer.tooLarge : m().agent.mcpServer.badJson, {
        Connection: 'close',
      });
    }

    try {
      const server = createToolServer({ deps, scope, token, frameName });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, m().agent.mcpServer.internalError((e as Error).message));
      else res.end();
    }
  };
}
