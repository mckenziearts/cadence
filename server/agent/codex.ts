import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { AGENT_NAMES, EFFORTS, type AgentStatus, type Effort, type ModelSpec, type UsageTokens } from '../../src/shared/types';
import type { CadenceConfig } from '../contracts';
import { m } from '../i18n';
import { AsyncQueue, absolutePath, isInside } from '../util';
import type { AgentEvent, AgentProvider, AgentTurn } from './types';

const LABEL = 'Codex';
type Json = Record<string, any>;
type DoneEvent = Extract<AgentEvent, { type: 'done' }>;

const AUTH_ERROR = /not logged in|please run .*login|unauthorized|invalid api key|401/i;
/** A resumed thread Codex no longer has (0.161.0: "thread/resume failed: no rollout found for thread id"). */
const SESSION_LOST = /no rollout found for (?:thread|conversation) id/i;
/** The child reads its MCP bearer from this variable (never on the command line, so it stays out of `ps`). */
const TOKEN_ENV = 'CADENCE_MCP_TOKEN';
/** What `codex` needs to run, log in and reach OpenAI through a proxy; nothing else of Cadence's environment reaches it. */
const CHILD_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CODEX_CA_CERTIFICATE',
]);
const CHILD_ENV_PATTERN = /^(LC_\w+|(https?|all|no)_proxy)$/i;

/** The first `codex` whose `sandbox -P` and `[permissions.<name>]` profiles the probe and the turns rely on. */
const MIN_VERSION = [0, 161, 0];

/** Whether a dotted version is at least `min`; anything else (a dev build, an empty string) is not. */
function atLeast(version: string, min: number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  const diff = parts.map((part, i) => part - min[i]).find((d) => d !== 0) ?? 0;
  return diff >= 0;
}

/**
 * Codex's status as the Profile shows it: is the `codex` CLI installed on this computer, does it apply the permission
 * profile, and is it logged in. Mirrors ClaudeCodeProvider.status().
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
  // Older CLIs lack the permission profiles the probe relies on: refused without asking their sandbox.
  const confined = atLeast(version, MIN_VERSION) && (await appliesProfile(bin).catch((e: Error) => e));
  if (confined instanceof Error) {
    return { ok: false, label: LABEL, version, reason: 'error', detail: m().agent.codex.probeFailed(confined.message) };
  }
  if (!confined) return { ok: false, label: LABEL, version, reason: 'unconfined', detail: m().agent.codex.unconfined(LABEL) };
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
 * The turn's file access as a Codex permission profile (an inline `[permissions.cadence.filesystem]` table): read the
 * cwd and the addDirs, write what the turn's Edit and Write rules allow, never read what its deny rules name. `:minimal`
 * is what a shell needs to start; it also opens /tmp read-write, which `:slash_tmp` closes again. A path listed twice
 * (a brand build's folder is its cwd, an addDir and writable) keeps its last access, since TOML rejects duplicate keys.
 */
export function codexFilesystem(turn: Pick<AgentTurn, 'cwd' | 'addDirs' | 'allow' | 'deny'>): string {
  const access = new Map<string, 'read' | 'write' | 'deny'>([
    [':minimal', 'read'],
    [':slash_tmp', 'deny'],
  ]);
  for (const dir of [turn.cwd, ...turn.addDirs]) access.set(dir, 'read');
  for (const rule of turn.allow) {
    const match = /^(?:Edit|Write)\(\/(\/.+?)(?:\/\*\*)?\)$/.exec(rule);
    if (match) access.set(match[1], 'write');
  }
  for (const rule of turn.deny) {
    const match = /^Read\(\/(\/.+)\)$/.exec(rule);
    if (match) access.set(match[1], 'deny');
  }
  return `{${[...access].map(([target, mode]) => `${JSON.stringify(target)}="${mode}"`).join(',')}}`;
}

/** A path the sandbox can match: it compares real paths. One not created yet resolves through its closest existing parent. */
async function realPath(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(await realPath(parent), path.basename(target));
  }
}

/**
 * The turn with its folders and rule paths resolved: given through a symlink, a writable root makes Codex refuse the
 * whole profile, and a readable one blocks every read under it. A write target is resolved through its parent only: an
 * earlier turn may have put a link there, and following it would grant writes on whatever it points to, so a link, or
 * a parent leading out of the cwd, refuses the turn. A writable folder is created first: the sandbox then keeps the
 * turn from replacing it with a link.
 */
async function realTurn(turn: AgentTurn): Promise<AgentTurn> {
  const cwd = await realPath(turn.cwd);
  const realRule = async (rule: string) => {
    const match = /^(\w+)\(\/(\/.+?)(\/\*\*)?\)$/.exec(rule);
    if (!match) return rule;
    const [, tool, target, glob = ''] = match;
    if (tool !== 'Edit' && tool !== 'Write') return `${tool}(/${await realPath(target)}${glob})`;
    const real = path.join(await realPath(path.dirname(target)), path.basename(target));
    const stat = await fs.promises.lstat(real).catch(() => null);
    if (stat?.isSymbolicLink() || (real !== cwd && !isInside(cwd, real))) throw new Error(m().agent.codex.linkedTarget(target));
    if (!stat && glob) await fs.promises.mkdir(real, { recursive: true });
    return `${tool}(/${real}${glob})`;
  };
  return {
    ...turn,
    cwd,
    addDirs: await Promise.all(turn.addDirs.map(realPath)),
    allow: await Promise.all(turn.allow.map(realRule)),
    deny: await Promise.all(turn.deny.map(realRule)),
  };
}

/** The `cadence` permission profile as `-c` overrides: the turn's files (codexFilesystem) and no network. */
function profileArgs(turn: Pick<AgentTurn, 'cwd' | 'addDirs' | 'allow' | 'deny'>): string[] {
  return [
    '-c',
    'default_permissions="cadence"',
    '-c',
    `permissions.cadence.filesystem=${codexFilesystem(turn)}`,
    '-c',
    'permissions.cadence.network.enabled=false',
  ];
}

/**
 * Whether this `codex` applies the profile: a CLI that does not know its keys runs the turn under its default sandbox,
 * which reads the whole disk. `codex sandbox` (its `-P` sets `default_permissions`) with the flags a turn gets, in an
 * empty CODEX_HOME, must read a file in the profile's folder and fail on one beside it.
 */
async function appliesProfile(bin: string): Promise<boolean> {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-probe-')));
  try {
    const [inside, outside, home] = ['inside', 'outside', 'home'].map((name) => path.join(root, name));
    for (const dir of [inside, outside, home]) await fs.promises.mkdir(dir);
    await fs.promises.writeFile(path.join(inside, 'probe'), 'readable-marker');
    await fs.promises.writeFile(path.join(outside, 'probe'), 'denied-marker');
    const profile = profileArgs({ cwd: inside, addDirs: [], allow: [], deny: [] });
    const args = ['sandbox', '-P', 'cadence', ...profile, '-C', inside, '/bin/cat', 'probe', path.join(outside, 'probe')];
    const out = await exec(bin, args, { cwd: inside, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home } }).catch(
      () => null,
    );
    return !!out?.stdout.includes('readable-marker') && !out.stdout.includes('denied-marker');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

/**
 * `codex exec --json` arguments. The `cadence` permission profile (codexFilesystem, no network) confines the shell and
 * apply_patch to the turn's folders, `--ignore-user-config` keeps the user's own config, skills and project docs out of
 * the turn while their login still works, `--ignore-rules` keeps their execpolicy prefixes from approving commands, and
 * the Cadence MCP server is injected inline so no `~/.codex/config.toml` entry is needed. `exec` has no `-P` and
 * `exec resume` no `-s`, so every setting goes through `-c`.
 */
export function codexArgs(turn: AgentTurn, config: CadenceConfig, model: string | null): string[] {
  const server = ((turn.mcpServers as Record<string, Json>)?.cadence ?? {}) as Json;
  const url = String(server.url ?? config.mcpUrl);
  const overrides = [
    '-c',
    `mcp_servers.cadence.url="${url}"`,
    '-c',
    `mcp_servers.cadence.bearer_token_env_var="${TOKEN_ENV}"`,
    ...profileArgs(turn),
    // Also stops Codex from reading AGENTS.md up to the git root: outside the profile, that read fails the turn.
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'tools.web_search=false',
    // A model that asks for escalated permissions (sandbox_permissions "require_escalated") is never granted them.
    '-c',
    'approval_policy="never"',
    // Commands the agent runs see none of Codex's own environment (its login, the MCP token, proxies).
    '-c',
    'shell_environment_policy.inherit="core"',
    '-c',
    'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_*"]',
    // Codex supports low/medium/high/xhigh/max/ultra natively, so the effort passes through unchanged.
    ...(turn.effort ? ['-c', `model_reasoning_effort="${turn.effort}"`] : []),
    ...(model ? ['-m', model] : []),
  ];
  const common = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', ...overrides];
  // '-' reads the prompt from stdin. On resume the cwd and the Cadence guide already live in the thread.
  return turn.resume ? ['exec', 'resume', turn.sessionId, ...common, '-'] : ['exec', ...common, '-'];
}

/** Environment for the child `codex`: the allowlist above, then the turn's MCP bearer token. */
export function codexEnv(source: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (CHILD_ENV.has(name) || CHILD_ENV_PATTERN.test(name))) env[name] = value;
  }
  if (env.PATH !== undefined) env.PATH = absolutePath(env.PATH);
  // An empty PATH makes spawn look a bare command up in the turn folder; with no PATH it uses the system default.
  if (!env.PATH) delete env.PATH;
  env[TOKEN_ENV] = token;
  return env;
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

  /** `agent` is the name the turn errors give it: null when the host hides the agent choice (`agentName()`). */
  constructor(
    private config: CadenceConfig,
    private agent: string | null = AGENT_NAMES.codex,
  ) {}

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

      // Fail closed: no turn starts until the probe has found this binary confined (and logged in).
      const status = await this.status().catch((e: Error): AgentStatus => ({
        ok: false,
        label: LABEL,
        reason: 'error',
        detail: m().agent.codex.probeFailed(e.message),
      }));
      if (!status.ok) {
        finish({
          type: 'done',
          text: refusal(status, this.agent),
          isError: true,
          durationMs: 0,
          subtype: status.reason ?? 'error',
        });
        return queue.end();
      }
      let real: AgentTurn;
      try {
        real = await realTurn(turn);
      } catch (e) {
        finish({ type: 'done', text: (e as Error).message, isError: true, durationMs: 0, subtype: 'error' });
        return queue.end();
      }

      const guide = turn.resume ? '' : `${turn.systemPrompt}\n\n`;
      const child = spawn(bin, codexArgs(real, this.config, model), {
        cwd: real.cwd,
        env: codexEnv(process.env, bearerToken(turn.mcpServers)),
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
      }, this.agent);
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
          text: this.agent ? m().agent.codex.spawnFailed(bin, e.message) : m().agent.refused,
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
          text: aborted ? m().agent.codex.stopped : crashText(this.agent, code, stderr),
          isError: !aborted,
          durationMs: 0,
          subtype: aborted ? 'aborted' : SESSION_LOST.test(stderr) ? 'session_lost' : 'crashed',
        });
        queue.end();
      });
    })();
    return queue;
  }
}

function exec(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, ...options }, (error, stdout) => {
      // A numeric code is a normal non-zero exit (stdout still useful); anything else is a spawn failure or timeout.
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: String(stdout), code: error ? Number(error.code) : 0 });
    });
  });
}

/** Why a turn is refused before Codex starts, from the status that refused it. */
function refusal(status: AgentStatus, agent: string | null): string {
  if (status.reason === 'unconfined') return m().agent.codex.unconfined(agent);
  // Every detail names Codex, which a host that hides the agent never shows.
  if (!agent) return m().agent.refused;
  if (status.reason === 'logged-out') return m().agent.codex.notLoggedIn;
  return status.detail ?? m().agent.codex.unconfined(agent);
}

/** Codex's stderr names Codex, ChatGPT or OpenAI: a host that hides the agent gets the generic text alone. */
function crashText(agent: string | null, code: number | null, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-6).join('\n');
  if (AUTH_ERROR.test(tail)) return agent ? `${m().agent.codex.notLoggedIn}\n\n${tail}` : m().agent.refused;
  return m().agent.codex.crashed(agent, code, agent ? tail : '');
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

  /** `agent` null: Codex's own error messages name it, so a failed turn gets a generic text and its error notes are dropped. */
  constructor(
    private emit: (event: AgentEvent) => void,
    private agent: string | null = AGENT_NAMES.codex,
  ) {}

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
      case 'turn.failed': {
        const message = String(msg.error?.message ?? msg.error ?? '');
        const done = this.done(true, this.agent ? message : m().agent.chat.failed(null), undefined);
        this.emit(SESSION_LOST.test(message) ? { ...done, subtype: 'session_lost' } : done);
        break;
      }
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
        if (completed && item.message && this.agent) this.emit({ type: 'note', text: String(item.message) });
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
