// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentStatus, UsageTokens } from '../../src/shared/types';
import type { CadenceConfig } from '../contracts';
import { m } from '../i18n';
import { NO_TOKENS } from '../usage';
import { AsyncQueue } from '../util';
import type { AgentEvent, AgentProvider, AgentTurn } from './types';

type Json = Record<string, any>;
type DoneEvent = Extract<AgentEvent, { type: 'done' }>;

/** Markers a parent Claude Code session leaves in the environment: a child that sees them believes it is nested. */
const NESTED_SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  // The parent's effort would apply when we omit --effort (models without effort support reject it).
  'CLAUDE_EFFORT',
]);
const NESTED_SESSION_PREFIX = /^CLAUDE_CODE_(SESSION|MESSAGING)_/;

const AUTH_ERROR = /not logged in|please run \/login|invalid api key|authentication_error|oauth token/i;

/** Environment for the child `claude`: no nested-session markers, subscription login unless the API key is wanted. */
export function claudeEnv(source: NodeJS.ProcessEnv, useApiKey: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!NESTED_SESSION_VARS.has(name) && !NESTED_SESSION_PREFIX.test(name)) env[name] = value;
  }
  if (!useApiKey) delete env.ANTHROPIC_API_KEY;
  // render_frames, check_seams and check_motion capture real frames; allow long tool calls and large image results.
  env.MCP_TOOL_TIMEOUT = '300000';
  env.MAX_MCP_OUTPUT_TOKENS = '120000';
  return env;
}

/** Files holding the turn's secrets: the MCP bearer token and the long guide stay out of `ps` output. */
export interface TurnFiles {
  systemPrompt: string;
  mcpConfig: string;
}

/** Write the turn files (0600) in a private temp folder (0700); returns their paths and a cleanup function. */
export function writeTurnFiles(turn: AgentTurn): { files: TurnFiles; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-turn-'));
  const files = { systemPrompt: path.join(dir, 'system-prompt.md'), mcpConfig: path.join(dir, 'mcp.json') };
  fs.writeFileSync(files.systemPrompt, turn.systemPrompt, { mode: 0o600 });
  fs.writeFileSync(files.mcpConfig, JSON.stringify({ mcpServers: turn.mcpServers }), { mode: 0o600 });
  return { files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Command line of one turn (see ARCHITECTURE.md, "Agent"). The prompt itself goes through stdin. */
export function claudeArgs(turn: AgentTurn, files: TurnFiles): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    turn.model,
    ...(turn.effort ? ['--effort', turn.effort] : []),
    // No shell or web tools, file tools confined to the working directories.
    '--restricted',
    '--tools',
    turn.tools.join(','),
    // Only the pre-approved rules run; anything else is denied instead of prompting.
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    // Variadic options: each one must be followed by another option, never by a positional argument.
    ...(turn.allow.length ? ['--allowedTools', ...turn.allow] : []),
    ...(turn.deny.length ? ['--disallowedTools', ...turn.deny] : []),
    ...(turn.addDirs.length ? ['--add-dir', ...turn.addDirs] : []),
    '--mcp-config',
    files.mcpConfig,
    '--strict-mcp-config',
    '--append-system-prompt-file',
    files.systemPrompt,
    ...(turn.resume ? ['--resume', turn.sessionId] : ['--session-id', turn.sessionId]),
  ];
}

/** Runs turns through the locally installed Claude Code CLI (`claude -p`, stream-json) with the user's own login. */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  private statusCache: { at: number; value: Promise<AgentStatus> } | null = null;

  constructor(private config: CadenceConfig) {}

  /** Cached for 30 s: the editor asks on every load and each check spawns two processes. */
  status(): Promise<AgentStatus> {
    if (!this.statusCache || Date.now() - this.statusCache.at > 30_000) {
      this.statusCache = { at: Date.now(), value: this.checkStatus() };
    }
    return this.statusCache.value;
  }

  private async checkStatus(): Promise<AgentStatus> {
    const bin = this.config.claudePath;
    const env = claudeEnv(process.env, this.config.useApiKey);
    let version: string;
    try {
      const out = await exec(bin, ['--version'], env);
      if (out.code !== 0) throw new Error(m().agent.claudeCode.exitCode(out.code));
      version = out.stdout.trim().split(/\s+/)[0] ?? '';
    } catch (e) {
      return {
        ok: false,
        label: this.label,
        reason: 'missing',
        detail: m().agent.claudeCode.notFound(bin, (e as Error).message),
      };
    }
    let auth: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    try {
      auth = JSON.parse((await exec(bin, ['auth', 'status', '--json'], env)).stdout);
    } catch {
      return { ok: true, label: this.label, version }; // older CLIs have no `auth status --json`
    }
    if (auth.loggedIn === false && !(this.config.useApiKey && env.ANTHROPIC_API_KEY)) {
      return { ok: false, label: this.label, version, reason: 'logged-out', detail: m().agent.claudeCode.notLoggedIn };
    }
    const how = [auth.authMethod, auth.subscriptionType].filter(Boolean).join(', ');
    return { ok: true, label: this.label, version, detail: how ? m().agent.claudeCode.loggedIn(how) : undefined };
  }

  run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const started = Date.now();
    const bin = this.config.claudePath;
    let finished = false;
    const finish = (event: DoneEvent) => {
      if (finished) return;
      finished = true;
      queue.push(event);
    };

    const { files, cleanup } = writeTurnFiles(turn);
    const child = spawn(bin, claudeArgs(turn, files), {
      cwd: turn.cwd,
      env: claudeEnv(process.env, this.config.useApiKey),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.once('close', cleanup);
    child.once('error', cleanup);
    child.stdin.on('error', () => undefined);
    child.stdin.end(turn.prompt);

    const log = this.config.agentLog ? fs.createWriteStream(this.config.agentLog, { flags: 'a' }) : null;
    log?.on('error', () => undefined);
    const parser = new StreamJsonParser((event) => {
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
    // Claude Code stops the request and saves the session on SIGINT; escalate if it does not exit.
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
        text: m().agent.claudeCode.spawnFailed(bin, e.message),
        isError: true,
        durationMs: Date.now() - started,
        subtype: 'spawn_error',
      });
      queue.end();
    });
    child.on('close', (code) => {
      turn.signal.removeEventListener('abort', onAbort);
      log?.end();
      const aborted = turn.signal.aborted;
      finish({
        type: 'done',
        text: aborted ? m().agent.claudeCode.stopped : crashText(code, stderr),
        isError: !aborted,
        durationMs: Date.now() - started,
        subtype: aborted ? 'aborted' : 'crashed',
      });
      queue.end();
    });
    return queue;
  }
}

function exec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: 15_000 }, (error, stdout) => {
      // A numeric code is a normal non-zero exit (stdout is still useful); anything else is a spawn failure or timeout.
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: String(stdout), code: error ? Number(error.code) : 0 });
    });
  });
}

function crashText(code: number | null, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-6).join('\n');
  if (AUTH_ERROR.test(tail)) return `${m().agent.claudeCode.notLoggedIn}\n\n${tail}`;
  return m().agent.claudeCode.crashed(code, tail);
}

/** User-facing text for an error result; keeps Claude Code's own message for context. */
function explainError(text: string, subtype: string | undefined): string {
  if (AUTH_ERROR.test(text)) return `${m().agent.claudeCode.notLoggedIn}\n\n${text}`.trim();
  const kind = subtype && subtype !== 'success' ? ` (${subtype})` : '';
  return m().agent.claudeCode.returnedError(kind, text);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: Json) => (part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Maps Claude Code's stream-json lines onto AgentEvents. Text streams from `stream_event` deltas; thinking, tool calls
 * and text that was not streamed come from the complete `assistant` lines (one per content block).
 */
export class StreamJsonParser {
  private messageId: string | null = null;
  /** Assistant messages whose text already went out as deltas. */
  private streamed = new Set<string>();

  constructor(private emit: (event: AgentEvent) => void) {}

  line(raw: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Sub-agent traffic carries the id of the Task tool call that spawned it.
    if (!msg || typeof msg !== 'object' || msg.parent_tool_use_id) return;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.emit({ type: 'init', sessionId: String(msg.session_id ?? ''), model: msg.model });
        break;
      case 'stream_event':
        this.streamEvent(msg.event ?? {});
        break;
      case 'assistant':
        this.assistant(msg.message ?? {});
        break;
      case 'user':
        this.user(msg.message ?? {});
        break;
      case 'result':
        this.result(msg);
        break;
    }
  }

  private streamEvent(ev: Json) {
    if (ev.type === 'message_start') this.messageId = ev.message?.id ?? null;
    else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      if (this.messageId) this.streamed.add(this.messageId);
      this.emit({ type: 'text-delta', text: String(ev.delta.text ?? '') });
    }
  }

  private assistant(message: Json) {
    const id = typeof message.id === 'string' ? message.id : null;
    for (const block of (Array.isArray(message.content) ? message.content : []) as Json[]) {
      if (block.type === 'tool_use') {
        this.emit({ type: 'tool-start', id: String(block.id), name: String(block.name), input: block.input ?? {} });
      } else if (block.type === 'text' && block.text && !(id && this.streamed.has(id))) {
        this.emit({ type: 'text', text: String(block.text) });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        this.emit({ type: 'note', text: block.thinking.trim() });
      }
    }
  }

  private user(message: Json) {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content as Json[]) {
      if (block.type !== 'tool_result') continue;
      this.emit({
        type: 'tool-end',
        id: String(block.tool_use_id),
        isError: Boolean(block.is_error),
        output: toolResultText(block.content),
      });
    }
  }

  private result(msg: Json) {
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
    const isError = Boolean(msg.is_error) || Boolean(subtype?.startsWith('error'));
    const text = typeof msg.result === 'string' ? msg.result : Array.isArray(msg.errors) ? msg.errors.map(String).join('\n') : '';
    this.emit({
      type: 'done',
      text: isError ? explainError(text, subtype) : text,
      isError,
      durationMs: Number(msg.duration_ms) || 0,
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
      tokens: tokenTotals(msg.modelUsage),
      sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined,
      subtype,
    });
  }
}

/** `modelUsage` holds the session's totals per model, subagents included. */
function tokenTotals(modelUsage: unknown): UsageTokens | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const tokens = { ...NO_TOKENS };
  for (const usage of Object.values(modelUsage as Record<string, Json>)) {
    tokens.input += Number(usage?.inputTokens) || 0;
    tokens.output += Number(usage?.outputTokens) || 0;
    tokens.cacheRead += Number(usage?.cacheReadInputTokens) || 0;
    tokens.cacheWrite += Number(usage?.cacheCreationInputTokens) || 0;
  }
  return tokens;
}
