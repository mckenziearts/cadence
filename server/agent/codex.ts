import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { EFFORTS, type AgentStatus, type Effort, type ModelSpec, type UsageTokens } from '../../src/shared/types';
import type { CadenceConfig } from '../contracts';
import { m } from '../i18n';
import { AsyncQueue } from '../util';
import type { AgentEvent, AgentProvider, AgentTurn } from './types';

const LABEL = 'Codex';
type Json = Record<string, any>;
type DoneEvent = Extract<AgentEvent, { type: 'done' }>;

const AUTH_ERROR = /not logged in|please run .*login|unauthorized|invalid api key|401/i;
/** The child reads its MCP bearer from this variable (never on the command line, so it stays out of `ps`). */
const TOKEN_ENV = 'CADENCE_MCP_TOKEN';

/**
 * Codex's status as the Profile shows it: is the `codex` CLI installed on this computer, and is it logged in. Mirrors
 * ClaudeCodeProvider.status().
 */
export async function codexStatus(config: CadenceConfig): Promise<AgentStatus> {
  const bin = config.codexPath;
  let version: string;
  try {
    const out = await exec(bin, ['--version']);
    if (out.code !== 0) throw new Error(m().agent.codex.exitCode(out.code));
    version = out.stdout.trim().split(/\s+/).pop() ?? ''; // "codex-cli 0.159.2"
  } catch (e) {
    return { ok: false, label: LABEL, reason: 'missing', detail: m().agent.codex.notFound(bin, (e as Error).message) };
  }
  // Exit 1 or "Not logged in" both mean no usable login in the home Codex reads.
  const login = await exec(bin, ['login', 'status']).catch(() => ({ code: 1, stdout: '' }));
  if (login.code !== 0 || /not logged in/i.test(login.stdout)) {
    return { ok: false, label: LABEL, version, reason: 'logged-out', detail: m().agent.codex.notLoggedIn };
  }
  return { ok: true, label: LABEL, version, detail: m().agent.codex.loggedIn };
}

const modelsCache = new Map<string, { at: number; value: Promise<ModelSpec[]> }>();

/** Codex's selectable models (GPT-6-Sol, etc.) with the efforts each one offers, from the installed CLI's own catalogue. */
export function codexModels(config: CadenceConfig): Promise<ModelSpec[]> {
  const hit = modelsCache.get(config.codexPath);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const entry = { at: Date.now(), value: loadModels(config) };
  modelsCache.set(config.codexPath, entry);
  return entry.value;
}

async function loadModels(config: CadenceConfig): Promise<ModelSpec[]> {
  const out = await exec(config.codexPath, ['debug', 'models', '--bundled']).catch(() => null);
  if (!out || out.code !== 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : ((raw as Json)?.models ?? []);
  const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);
  return (list as Json[])
    .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
    .map((model) => {
      const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .map((level: Json) => level.effort)
        .filter(isEffort);
      const description = typeof model.description === 'string' ? model.description : '';
      return {
        id: String(model.slug),
        label: String(model.display_name ?? model.slug),
        supportsEffort: efforts.length > 0,
        hint: { fr: description, en: description },
        efforts,
        defaultEffort: isEffort(model.default_reasoning_level) ? model.default_reasoning_level : undefined,
      } satisfies ModelSpec;
    });
}

/**
 * `codex exec --json` arguments. The sandbox (workspace-write, no network) confines file writes to the project folder,
 * `--ignore-user-config` keeps the user's own config, skills and project docs out of the turn while their login still
 * works, and the Cadence MCP server is injected inline so no `~/.codex/config.toml` entry is needed.
 */
export function codexArgs(turn: AgentTurn, config: CadenceConfig, model: string | null): string[] {
  const server = ((turn.mcpServers as Record<string, Json>)?.cadence ?? {}) as Json;
  const url = String(server.url ?? config.mcpUrl);
  const overrides = [
    '-c',
    `mcp_servers.cadence.url="${url}"`,
    '-c',
    `mcp_servers.cadence.bearer_token_env_var="${TOKEN_ENV}"`,
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'tools.web_search=false',
    // Codex supports low/medium/high/xhigh/max/ultra natively, so the effort passes through unchanged.
    ...(turn.effort ? ['-c', `model_reasoning_effort="${turn.effort}"`] : []),
    ...(model ? ['-m', model] : []),
  ];
  const common = ['--json', '--skip-git-repo-check', '--ignore-user-config', ...overrides];
  // '-' reads the prompt from stdin. On resume the cwd and the Cadence guide already live in the thread.
  return turn.resume ? ['exec', 'resume', turn.sessionId, ...common, '-'] : ['exec', ...common, '-'];
}

function bearerToken(mcpServers: Record<string, unknown>): string {
  const auth = ((mcpServers?.cadence as Json)?.headers?.Authorization as string) ?? '';
  return auth.replace(/^Bearer\s+/i, '');
}

/** Runs turns through the locally installed Codex CLI (`codex exec --json`) with the user's own ChatGPT login. */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly label = LABEL;
  private statusCache: { at: number; value: Promise<AgentStatus> } | null = null;

  constructor(private config: CadenceConfig) {}

  status(): Promise<AgentStatus> {
    if (!this.statusCache || Date.now() - this.statusCache.at > 30_000) {
      this.statusCache = { at: Date.now(), value: codexStatus(this.config) };
    }
    return this.statusCache.value;
  }

  run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const started = Date.now();
    const bin = this.config.codexPath;
    let threadId: string | undefined;
    let finished = false;
    const finish = (event: DoneEvent) => {
      if (finished) return;
      finished = true;
      queue.push({ ...event, durationMs: Date.now() - started, sessionId: event.sessionId ?? threadId });
    };

    // Resolve the model against Codex's own catalogue first (a stale Claude id from before a switch falls back to the
    // account default); the lookup is cached, so it only spawns `codex debug models` once.
    void (async () => {
      let model: string | null = null;
      try {
        const models = await codexModels(this.config);
        model = models.some((spec) => spec.id === turn.model) ? turn.model : null;
      } catch {
        model = null;
      }
      if (turn.signal.aborted) {
        finish({ type: 'done', text: m().agent.codex.stopped, isError: false, durationMs: 0, subtype: 'aborted' });
        return queue.end();
      }

      const guide = turn.resume ? '' : `${turn.systemPrompt}\n\n`;
      const child = spawn(bin, codexArgs(turn, this.config, model), {
        cwd: turn.cwd,
        env: { ...process.env, [TOKEN_ENV]: bearerToken(turn.mcpServers) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(guide + turn.prompt);

      const log = this.config.agentLog ? fs.createWriteStream(this.config.agentLog, { flags: 'a' }) : null;
      log?.on('error', () => undefined);
      const parser = new CodexStreamParser((event) => {
        if (event.type === 'init') threadId = event.sessionId || threadId;
        if (event.type === 'done') finish(event);
        else if (!finished) queue.push(event);
      });
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        log?.write(`${line}\n`);
        parser.line(line);
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });

      const alive = () => child.exitCode === null && child.signalCode === null;
      const onAbort = () => {
        child.kill('SIGINT');
        setTimeout(() => alive() && child.kill('SIGTERM'), 1500).unref();
        setTimeout(() => alive() && child.kill('SIGKILL'), 5000).unref();
      };
      if (turn.signal.aborted) onAbort();
      else turn.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (e) => {
        finish({
          type: 'done',
          text: m().agent.codex.spawnFailed(bin, e.message),
          isError: true,
          durationMs: 0,
          subtype: 'spawn_error',
        });
        queue.end();
      });
      child.on('close', (code) => {
        turn.signal.removeEventListener('abort', onAbort);
        log?.end();
        const aborted = turn.signal.aborted;
        // turn.completed/turn.failed already produced the done event; this only covers an abort or a crash before it.
        finish({
          type: 'done',
          text: aborted ? m().agent.codex.stopped : crashText(code, stderr),
          isError: !aborted,
          durationMs: 0,
          subtype: aborted ? 'aborted' : 'crashed',
        });
        queue.end();
      });
    })();
    return queue;
  }
}

function exec(file: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (error, stdout) => {
      // A numeric code is a normal non-zero exit (stdout still useful); anything else is a spawn failure or timeout.
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: String(stdout), code: error ? Number(error.code) : 0 });
    });
  });
}

function crashText(code: number | null, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-6).join('\n');
  if (AUTH_ERROR.test(tail)) return `${m().agent.codex.notLoggedIn}\n\n${tail}`;
  return m().agent.codex.crashed(code, tail);
}

/**
 * Maps Codex's `exec --json` lines (thread/item/turn events) onto AgentEvents. Text streams from `item.updated` when
 * Codex sends partials, otherwise the completed item carries it whole; reasoning becomes notes, and shell, MCP and
 * file-change items become tool activity.
 */
export class CodexStreamParser {
  private streamed = new Set<string>();
  private partial = new Map<string, string>();
  private lastMessage = '';

  constructor(private emit: (event: AgentEvent) => void) {}

  line(raw: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'thread.started':
        this.emit({ type: 'init', sessionId: String(msg.thread_id ?? '') });
        break;
      case 'item.started':
      case 'item.updated':
        this.item(msg.item, false);
        break;
      case 'item.completed':
        this.item(msg.item, true);
        break;
      case 'turn.completed':
        this.emit(this.done(false, '', msg.usage));
        break;
      case 'turn.failed':
        this.emit(this.done(true, String(msg.error?.message ?? msg.error ?? ''), undefined));
        break;
    }
  }

  private item(item: Json, completed: boolean): void {
    if (!item || typeof item !== 'object') return;
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'agent_message':
        this.message(id, String(item.text ?? ''), completed);
        break;
      case 'reasoning':
        if (completed && typeof item.text === 'string' && item.text.trim()) this.emit({ type: 'note', text: item.text.trim() });
        break;
      case 'command_execution':
        if (!completed) this.emit({ type: 'tool-start', id, name: 'shell', input: { command: item.command } });
        else
          this.emit({
            type: 'tool-end',
            id,
            isError: item.status === 'failed' || (item.exit_code != null && Number(item.exit_code) !== 0),
            output: String(item.aggregated_output ?? ''),
          });
        break;
      case 'mcp_tool_call': {
        const name = `mcp__${item.server ?? 'cadence'}__${item.tool ?? ''}`;
        if (!completed) this.emit({ type: 'tool-start', id, name, input: (item.arguments ?? item.input ?? {}) as Json });
        else
          this.emit({ type: 'tool-end', id, isError: item.status === 'failed', output: String(item.result ?? item.error ?? '') });
        break;
      }
      case 'file_change':
        if (completed)
          for (const change of Array.isArray(item.changes) ? item.changes : []) {
            const cid = `${id}:${change.path}`;
            this.emit({ type: 'tool-start', id: cid, name: 'Edit', input: { file_path: change.path } });
            this.emit({ type: 'tool-end', id: cid, isError: false, output: '' });
          }
        break;
      case 'error':
        if (completed && item.message) this.emit({ type: 'note', text: String(item.message) });
        break;
    }
  }

  private message(id: string, text: string, completed: boolean): void {
    const prev = this.partial.get(id) ?? '';
    if (!completed) {
      if (text.length > prev.length) {
        this.emit({ type: 'text-delta', text: text.slice(prev.length) });
        this.streamed.add(id);
      }
      this.partial.set(id, text);
      return;
    }
    this.lastMessage = text;
    if (!this.streamed.has(id)) this.emit({ type: 'text', text });
    else if (text.length > prev.length) this.emit({ type: 'text-delta', text: text.slice(prev.length) });
  }

  private done(isError: boolean, text: string, usage: unknown): DoneEvent {
    return {
      type: 'done',
      text: isError ? text : this.lastMessage,
      isError,
      durationMs: 0,
      tokens: tokensFrom(usage),
      subtype: isError ? 'error' : 'success',
    };
  }
}

/** Codex reports a subscription turn with no per-turn dollar cost, so only token counts carry over. */
function tokensFrom(usage: unknown): UsageTokens | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Json;
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cached_input_tokens) || 0,
    cacheWrite: Number(u.cache_write_input_tokens) || 0,
  };
}
