import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CadenceConfig, McpActivity, McpScope, McpTokenIssuer } from '../contracts';
import { m } from '../i18n';
import { randomToken } from '../util';

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** Per-turn MCP tokens (in memory) plus one long-lived terminal token persisted outside the repository. */
export class McpTokens implements McpTokenIssuer {
  private tokens = new Map<string, { scope: McpScope; expiresAt: number }>();
  private listeners = new Map<string, Set<(activity: McpActivity) => void>>();

  constructor(
    _config: CadenceConfig,
    private terminalFile = path.join(os.homedir(), '.config', 'cadence', 'mcp-token'),
  ) {}

  issue(scope: McpScope, opts: { ttlMs?: number } = {}): string {
    const now = Date.now();
    for (const [token, entry] of this.tokens) if (entry.expiresAt <= now) this.revoke(token);
    const token = randomToken();
    this.tokens.set(token, { scope, expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS) });
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
    this.listeners.delete(token);
  }

  resolve(token: string | undefined | null): McpScope | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (entry) {
      if (entry.expiresAt > Date.now()) return entry.scope;
      this.revoke(token);
      return null;
    }
    // Read the file each time: `cadence mcp` may create it from another process while the server runs.
    return token === this.readTerminalToken() ? { kind: 'open' } : null;
  }

  async terminalToken(): Promise<string> {
    const existing = this.readTerminalToken();
    if (existing) return existing;
    await fs.promises.mkdir(path.dirname(this.terminalFile), { recursive: true, mode: 0o700 });
    const token = randomToken();
    try {
      await fs.promises.writeFile(this.terminalFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Another process created it first (use theirs), or the file holds no usable token (replace it).
    const theirs = this.readTerminalToken();
    if (theirs) return theirs;
    await fs.promises.writeFile(this.terminalFile, `${token}\n`, { mode: 0o600 });
    await fs.promises.chmod(this.terminalFile, 0o600);
    return token;
  }

  onActivity(token: string, listener: (activity: McpActivity) => void): () => void {
    const set = this.listeners.get(token) ?? new Set();
    set.add(listener);
    this.listeners.set(token, set);
    return () => {
      set.delete(listener);
      if (!set.size && this.listeners.get(token) === set) this.listeners.delete(token);
    };
  }

  reportActivity(token: string, activity: McpActivity): void {
    for (const listener of this.listeners.get(token) ?? []) {
      try {
        listener(activity);
      } catch (e) {
        console.error(m().agent.mcpTokens.listenerFailed, e);
      }
    }
  }

  private readTerminalToken(): string | null {
    try {
      const token = fs.readFileSync(this.terminalFile, 'utf8').trim();
      return token.length >= 32 ? token : null;
    } catch {
      return null;
    }
  }
}
