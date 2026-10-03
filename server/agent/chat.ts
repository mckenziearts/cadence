// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EFFORTS,
  ID_PATTERN,
  MODEL_ID_PATTERN,
  MODELS,
  agentPicks,
  isFormatId,
  sceneIdFromChatKey,
  type AgentId,
  type ChatKey,
  type ChatMessage,
  type ChatState,
  type Effort,
  type Playhead,
  type ProjectState,
  type SceneState,
  type SendMessageInput,
} from '../../src/shared/types';
import type {
  AgentProvider,
  AgentTurn,
  AssetStore,
  BrandStore,
  CadenceConfig,
  CaptureService,
  ChatService,
  Hub,
  McpActivity,
  McpTokenIssuer,
  MusicService,
  ProjectStore,
  SeamService,
  SettingsStore,
  TemplateStore,
  UsageLog,
  VersionStore,
} from '../contracts';
import { m } from '../i18n';
import { PROJECT_TOOLS, SCENE_TOOLS } from '../mcp/tools';
import { NO_TOKENS, addedSince } from '../usage';
import {
  HttpError,
  KeyedMutex,
  assertId,
  formatSeconds,
  isInside,
  nowIso,
  readJsonOr,
  shortHash,
  writeJsonAtomic,
} from '../util';
import { buildSystemPrompt } from './guide';
import { buildTurnPrompt } from './prompts';
import type { ChatFile } from './types';

export interface ChatDeps {
  config: CadenceConfig;
  store: ProjectStore;
  brands: BrandStore;
  templates: TemplateStore;
  versions: VersionStore;
  capture: CaptureService;
  seams: SeamService;
  music: MusicService;
  assets: AssetStore;
  hub: Hub;
  provider: AgentProvider;
  tokens: McpTokenIssuer;
  settings: SettingsStore;
  usage: UsageLog;
}

type Dirs = { brand: string; templates: string; runtime: string };

interface Turn {
  projectId: string;
  key: ChatKey;
  chat: ChatFile;
  reply: ChatMessage;
  text: string;
  model?: string;
  effort?: Effort;
  playhead?: Playhead;
  abort: AbortController;
  running: boolean;
}

const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const MCP_PREFIX = 'mcp__cadence__';
/** The pre-turn capture only adds context: never let it hold the turn back for long. */
const ERRORS_TIMEOUT_MS = 15_000;

const chatId = (projectId: string, key: ChatKey) => `${projectId}/${key}`;
const emptyChat = (key: ChatKey): ChatFile => ({ key, sessionId: null, briefHash: null, messages: [] });
const sumCost = (messages: ChatMessage[]) => Math.round(messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0) * 1e6) / 1e6;

function assertKey(key: string): asserts key is ChatKey {
  const sceneId = key.startsWith('scene:') ? key.slice(6) : null;
  if (key !== 'project' && !(sceneId && ID_PATTERN.test(sceneId))) throw new HttpError(400, m().agent.chat.invalidKey(key));
}

function validPlayhead(value: unknown): Playhead | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { sceneId, t, format } = value as Playhead;
  if ((sceneId !== null && typeof sceneId !== 'string') || !Number.isFinite(t) || !isFormatId(format)) return undefined;
  return { sceneId, t, format };
}

/** Permission rules of a turn. `//` marks an absolute path in Claude Code rules. */
export function allowRules(projectDir: string, sceneId: string | null, dirs: Dirs): string[] {
  const rule = (tool: string, file: string) => `${tool}(//${file.replace(/^\/+/, '')})`;
  const reads = [projectDir, dirs.brand, dirs.templates, dirs.runtime].map((dir) => rule('Read', path.join(dir, '**')));
  const writable = sceneId
    ? [path.join(projectDir, 'scenes', `${sceneId}.tsx`)]
    : ['scenes/**', 'components/**', 'art-direction.md'].map((rel) => path.join(projectDir, rel));
  const tools = (sceneId ? SCENE_TOOLS : PROJECT_TOOLS).map((name) => `${MCP_PREFIX}${name}`);
  return [...reads, 'Glob', 'Grep', ...writable.flatMap((file) => [rule('Edit', file), rule('Write', file)]), ...tools];
}

function displayPath(file: unknown, projectDir: string, root: string): string {
  if (typeof file !== 'string') return m().agent.chat.activity.file;
  if (isInside(projectDir, file)) return path.relative(projectDir, file);
  return isInside(root, file) ? path.relative(root, file) : file;
}

/** Label of a tool call for the chat activity list, in the interface language. */
export function activityLabel(name: string, input: Record<string, unknown>, projectDir: string, root: string): string {
  const words = m().agent.chat.activity;
  const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
  switch (name) {
    case 'Read':
      return words.read(displayPath(input.file_path, projectDir, root));
    case 'Edit':
    case 'Write':
      return words.edit(displayPath(input.file_path, projectDir, root));
    case 'Glob':
      return words.glob(str(input.pattern));
    case 'Grep':
      return words.grep(str(input.pattern));
  }
  if (!name.startsWith(MCP_PREFIX)) return name;
  const tool = name.slice(MCP_PREFIX.length);
  const scene = str(input.sceneId, words.scene);
  switch (tool) {
    case 'render_frames': {
      const count = Array.isArray(input.times) ? input.times.length : 0;
      const of = input.wholeVideo ? words.video : typeof input.sceneId === 'string' ? input.sceneId : null;
      return words.render(count, of, typeof input.format === 'string' ? input.format : null);
    }
    case 'check_seams':
      return words.seams;
    case 'get_project':
      return words.project;
    case 'get_brand':
      return words.brand;
    case 'get_music_context':
      return words.music;
    case 'list_templates':
      return words.templates;
    case 'set_scene_duration':
      return words.duration(formatSeconds(Number(input.seconds) || 0));
    case 'set_voice_over':
      return words.voiceOver(!str(input.text).trim());
    case 'save_version':
      return words.version(str(input.label));
    case 'create_scene':
      return words.newScene(str(input.name));
    case 'duplicate_scene':
      return words.duplicate(scene);
    case 'delete_scene':
      return words.remove(scene);
    case 'move_scene':
      return words.move(scene, String(input.position ?? '?'));
    case 'rename_scene':
      return words.rename(scene, str(input.name));
    case 'snap_cuts_to_music':
      return words.snap(words.grids[str(input.grid, 'bar')] ?? words.grid);
    case 'capture_reference':
      return words.capture(str(input.url, words.page));
    default:
      return tool.replace(/_/g, ' ');
  }
}

/**
 * Scene and project chats backed by Claude Code sessions. One turn runs at a time per project (others queue); each
 * turn gets its own MCP token, streams over SSE, and ends with a version of whatever it changed.
 */
export class ChatManager implements ChatService {
  /** Accepted turn (queued or running) of each chat; at most one. */
  private turns = new Map<string, Turn>();
  /** Chats whose send() is still validating/persisting the message. */
  private reserved = new Set<string>();
  /** Turns of each project in arrival order; the first one runs. */
  private queues = new Map<string, Turn[]>();
  /** Serializes reads-modify-writes of each chat file. */
  private files = new KeyedMutex();
  /** Promises of running turns, so shutdown can wait for the Claude processes. */
  private running = new Set<Promise<void>>();
  private stopping = false;

  constructor(private deps: ChatDeps) {}

  async get(projectId: string, key: ChatKey): Promise<ChatState> {
    await this.checkProject(projectId, key);
    const id = chatId(projectId, key);
    const live = this.turns.get(id);
    if (live) return this.state(live.chat, live);
    // Under the file lock: pending writes (a dropped turn, a new message) land before the read.
    return this.files.run(id, async () => {
      const turn = this.turns.get(id);
      return turn ? this.state(turn.chat, turn) : this.state(await this.load(projectId, key));
    });
  }

  async send(projectId: string, key: ChatKey, input: SendMessageInput): Promise<ChatState> {
    await this.checkProject(projectId, key);
    const { model, effort } = input ?? {};
    const text = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!text) throw new HttpError(400, m().agent.chat.empty);
    if (model !== undefined && !MODEL_ID_PATTERN.test(model)) throw new HttpError(400, m().agent.chat.invalidModel(model));
    if (effort !== undefined && !EFFORTS.includes(effort)) throw new HttpError(400, m().agent.chat.invalidEffort(effort));
    const id = chatId(projectId, key);
    if (this.stopping) throw new HttpError(503, m().agent.chat.stopping);
    if (this.turns.has(id) || this.reserved.has(id)) throw new HttpError(409, m().agent.chat.busy);
    this.reserved.add(id);
    let turn: Turn;
    try {
      const sceneId = sceneIdFromChatKey(key);
      if (sceneId && !(await this.deps.store.get(projectId)).scenes.some((s) => s.id === sceneId)) {
        throw new HttpError(404, m().agent.chat.sceneNotFound(sceneId));
      }
      turn = await this.files.run(id, async () => {
        const chat = await this.load(projectId, key);
        const playhead = validPlayhead(input.playhead);
        const reply: ChatMessage = { id: randomUUID(), role: 'assistant', text: '', createdAt: nowIso(), status: 'streaming' };
        chat.messages.push({ id: randomUUID(), role: 'user', text, createdAt: nowIso(), ...(playhead && { playhead }) }, reply);
        const accepted: Turn = {
          projectId,
          key,
          chat,
          reply,
          text,
          model,
          effort,
          playhead,
          abort: new AbortController(),
          running: false,
        };
        this.turns.set(id, accepted);
        try {
          await this.save(projectId, chat);
        } catch (e) {
          this.turns.delete(id);
          throw e;
        }
        return accepted;
      });
    } finally {
      this.reserved.delete(id);
    }
    // stop() may have dropped it while the file was being written.
    if (this.turns.get(id) !== turn) return this.state(turn.chat);
    const queue = this.queues.get(projectId) ?? [];
    queue.push(turn);
    this.queues.set(projectId, queue);
    if (queue.length === 1) this.start(turn);
    else this.emit(turn);
    return this.state(turn.chat, turn);
  }

  stop(projectId: string, key: ChatKey): void {
    const id = chatId(projectId, key);
    const turn = this.turns.get(id);
    if (!turn) return;
    if (turn.running) {
      turn.abort.abort();
      return;
    }
    // Still queued: it never reached Claude, drop it.
    this.turns.delete(id);
    const queue = this.queues.get(projectId) ?? [];
    if (queue.includes(turn)) queue.splice(queue.indexOf(turn), 1);
    turn.reply.status = 'stopped';
    this.emit(turn);
    void this.files.run(id, () => this.save(projectId, turn.chat)).catch((e) => console.error(m().agent.chat.notSaved, e));
  }

  async clear(projectId: string, key: ChatKey): Promise<ChatState> {
    await this.checkProject(projectId, key);
    const id = chatId(projectId, key);
    return this.files.run(id, async () => {
      if (this.turns.has(id) || this.reserved.has(id)) throw new HttpError(409, m().agent.chat.stopFirst);
      const chat = await this.load(projectId, key);
      if (chat.messages.length) {
        const name = `${this.fileName(key)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        await writeJsonAtomic(path.join(this.chatsDir(projectId), 'archive', name), chat);
      }
      const fresh = emptyChat(key);
      await this.save(projectId, fresh);
      const state = this.state(fresh);
      this.deps.hub.send({ type: 'chat', projectId, state });
      return state;
    });
  }

  /** Every chat of the project, archived conversations included. */
  async totalCost(projectId: string): Promise<number> {
    assertId(projectId, m().api.ids.project);
    const dir = this.chatsDir(projectId);
    let total = 0;
    for (const folder of [dir, path.join(dir, 'archive')]) {
      const names = await fs.readdir(folder).catch(() => [] as string[]);
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        // A damaged chat says so when it opens (load); the total leaves it out.
        const chat = await readJsonOr<Partial<ChatFile>>(path.join(folder, name), {}).catch(() => ({}) as Partial<ChatFile>);
        total += sumCost(Array.isArray(chat.messages) ? chat.messages : []);
      }
    }
    return Math.round(total * 1e6) / 1e6;
  }

  private async checkProject(projectId: string, key: string): Promise<void> {
    assertKey(key);
    assertId(projectId, m().api.ids.project);
    if (!(await this.deps.store.exists(projectId))) throw new HttpError(404, m().agent.chat.projectNotFound(projectId));
  }

  private chatsDir(projectId: string): string {
    return path.join(this.deps.store.dir(projectId), '.cadence', 'chats');
  }

  /** `scene:intro` becomes `scene-intro`: no colon in file names (it means something else on Windows). */
  private fileName(key: ChatKey): string {
    return key.replace(':', '-');
  }

  private async load(projectId: string, key: ChatKey): Promise<ChatFile> {
    const stored = await readJsonOr<Partial<ChatFile>>(path.join(this.chatsDir(projectId), `${this.fileName(key)}.json`), {});
    const messages = Array.isArray(stored.messages) ? stored.messages : [];
    // Called under the chat's file lock with no turn pending: a reply still "streaming" was cut off by a restart.
    for (const message of messages) {
      if (message.status === 'streaming') {
        message.status = 'error';
        message.error = m().agent.chat.interrupted;
      }
    }
    return {
      key,
      sessionId: stored.sessionId ?? null,
      briefHash: stored.briefHash ?? null,
      messages,
      sessionUsage: stored.sessionUsage,
    };
  }

  private save(projectId: string, chat: ChatFile): Promise<void> {
    return writeJsonAtomic(path.join(this.chatsDir(projectId), `${this.fileName(chat.key)}.json`), chat);
  }

  private state(chat: ChatFile, turn?: Turn): ChatState {
    return {
      key: chat.key,
      messages: chat.messages,
      running: Boolean(turn?.running),
      queued: Boolean(turn && !turn.running),
      totalCostUsd: sumCost(chat.messages),
    };
  }

  private emit(turn: Turn): void {
    const live = this.turns.get(chatId(turn.projectId, turn.key)) === turn ? turn : undefined;
    this.deps.hub.send({ type: 'chat', projectId: turn.projectId, state: this.state(turn.chat, live) });
  }

  /** Inside a turn only the reply changes: a long chat would weigh megabytes for every tool call. */
  private emitReply(turn: Turn): void {
    this.deps.hub.send({ type: 'chat-message', projectId: turn.projectId, key: turn.key, message: turn.reply });
  }

  busy(projectId: string): boolean {
    return (this.queues.get(projectId)?.length ?? 0) > 0;
  }

  /** Abort running turns, drop queued ones and wait for the Claude processes to exit (server shutdown). */
  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const turn of [...this.turns.values()]) this.stop(turn.projectId, turn.key);
    await Promise.allSettled([...this.running]);
  }

  private start(turn: Turn): void {
    turn.running = true;
    this.emit(turn);
    const done = this.run(turn)
      .catch((e) => console.error(m().agent.chat.turnFailed, e))
      .finally(() => {
        this.running.delete(done);
        this.finish(turn);
      });
    this.running.add(done);
  }

  private finish(turn: Turn): void {
    this.turns.delete(chatId(turn.projectId, turn.key));
    const queue = this.queues.get(turn.projectId) ?? [];
    if (queue.includes(turn)) queue.splice(queue.indexOf(turn), 1);
    this.emit(turn);
    if (queue.length && !this.stopping) this.start(queue[0]);
    else this.queues.delete(turn.projectId);
  }

  private async run(turn: Turn): Promise<void> {
    const { projectId, key, chat, reply } = turn;
    const { config, store, versions, tokens } = this.deps;
    const sceneId = sceneIdFromChatKey(key);
    const started = Date.now();
    let token: string | null = null;
    let unsubscribe = () => {};
    try {
      const project = await store.get(projectId);
      const scene = sceneId ? (project.scenes.find((s) => s.id === sceneId) ?? null) : null;
      if (sceneId && !scene) throw new HttpError(404, m().agent.chat.sceneGone(sceneId));

      // Version the untouched project before the first ever turn, and edits made outside the chat before the next
      // ones, so the version this turn ends with holds only this turn's changes.
      const history = await versions.list(projectId);
      await versions.snapshot(
        projectId,
        history.length
          ? { label: m().agent.chat.outsideChanges, source: 'external' }
          : { label: m().api.versions.initial, source: 'baseline' },
      );

      const settings = await this.deps.settings.get();
      const picks = agentPicks(settings, scene ? 'scene' : 'project');
      const model = turn.model ?? picks.model;
      // MODELS only knows Claude; a Codex model is absent, so effort is kept and the provider decides what it accepts.
      const effort = MODELS.find((m) => m.id === model)?.supportsEffort === false ? null : (turn.effort ?? picks.effort);
      reply.model = model;
      if (effort) reply.effort = effort;

      token = tokens.issue(scene ? { kind: 'scene', projectId, sceneId: scene.id } : { kind: 'project', projectId });
      unsubscribe = tokens.onActivity(token, (activity) => this.onActivity(turn, activity));
      // Frames fall back to the neutral brand when the project's brand is gone: point the agent at that one too.
      const brandId = project.brand && (await this.deps.brands.exists(project.brand)) ? project.brand : 'cadence';
      const dirs: Dirs = {
        brand: this.deps.brands.dir(brandId),
        templates: config.templatesDir,
        runtime: path.join(config.root, 'src', 'runtime'),
      };
      const base = {
        cwd: project.dir,
        systemPrompt: buildSystemPrompt({ scope: scene ? 'scene' : 'project' }),
        model,
        effort,
        tools: TOOLS,
        allow: allowRules(project.dir, scene?.id ?? null, dirs),
        addDirs: [dirs.brand, dirs.templates, dirs.runtime],
        mcpServers: { cadence: { type: 'http', url: config.mcpUrl, headers: { Authorization: `Bearer ${token}` } } },
        signal: turn.abort.signal,
      };
      // A second attempt only happens when the saved session is gone (moved folder, cleared Claude Code history).
      for (let attempt = 0; attempt < 2; attempt++) {
        const resume = chat.sessionId !== null;
        const { prompt, briefHash } = await this.prompt(turn, project, scene, brandId, dirs, resume);
        if (turn.abort.signal.aborted) break; // stopped while the context was being gathered
        const agentTurn = { ...base, prompt, sessionId: chat.sessionId ?? randomUUID(), resume };
        const outcome = await this.stream(turn, agentTurn, started, briefHash, settings.agent);
        if (outcome !== 'session-lost') break;
        chat.sessionId = null;
        chat.briefHash = null;
      }
    } catch (e) {
      if (reply.status === 'streaming') {
        reply.status = 'error';
        reply.error = e instanceof HttpError ? e.message : m().agent.internalError((e as Error).message);
      }
    } finally {
      unsubscribe();
      if (token) tokens.revoke(token);
    }
    if (reply.status === 'streaming') reply.status = turn.abort.signal.aborted ? 'stopped' : 'done';
    reply.durationMs ??= Date.now() - started;
    for (const activity of reply.activity ?? []) if (activity.status === 'running') activity.status = 'error';
    await this.wrapUp(turn);
  }

  /**
   * The user's text with the Cadence context in front; brand notes and art direction only when new to the session.
   * `briefHash` identifies those: the chat records it once Claude has the prompt (stream, on 'init').
   */
  private async prompt(
    turn: Turn,
    project: ProjectState,
    scene: SceneState | null,
    brandId: string,
    dirs: Dirs,
    resume: boolean,
  ): Promise<{ prompt: string; briefHash: string }> {
    const { brands, store, music, seams, assets } = this.deps;
    const [brand, brandLanguage, artDirection, musicText, errors, references] = await Promise.all([
      brands.describe(brandId).catch((e) => `Brand notes unavailable: ${(e as Error).message}`),
      brands
        .get(brandId)
        .then((b) => b.language)
        .catch(() => null),
      store.readArtDirection(project.id).catch(() => ''),
      music.context(project.id, scene?.id ?? null).catch(() => ''),
      scene ? this.renderErrors(project.id, scene.id) : null,
      assets
        .list(project.id)
        .then((list) => list.filter((a) => a.isReference).map((a) => assets.resolve(project.id, a.path)))
        .catch(() => []),
    ]);
    const briefHash = shortHash(`${brand}\0${artDirection}`);
    const brief = !resume || turn.chat.briefHash !== briefHash ? { brand, artDirection } : null;
    const prompt = buildTurnPrompt({
      project,
      scene,
      text: turn.text,
      playhead: turn.playhead,
      brief,
      brandLanguage,
      music: musicText,
      seams: seams.cached(project.id),
      errors,
      references,
      dirs,
    });
    return { prompt, briefHash };
  }

  /**
   * Errors of the scene's first frame right now (null when the capture is unavailable or slow). Default format and
   * scale on purpose: it warms up the very page render_frames will use.
   */
  private async renderErrors(projectId: string, sceneId: string): Promise<string[] | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ERRORS_TIMEOUT_MS);
    });
    try {
      const frames = await Promise.race([this.deps.capture.frames(projectId, { sceneId, times: [0] }), timeout]);
      return frames ? (frames[0]?.errors ?? []) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Feeds one provider run into the reply. 'session-lost' when the resumed Claude Code session no longer exists. */
  private async stream(
    turn: Turn,
    agentTurn: AgentTurn,
    started: number,
    briefHash: string,
    agent: AgentId,
  ): Promise<'ok' | 'session-lost'> {
    const { reply, chat, projectId, key } = turn;
    for await (const ev of this.deps.provider.run(agentTurn)) {
      switch (ev.type) {
        case 'init':
          if (ev.sessionId) chat.sessionId = ev.sessionId;
          // The session has the prompt now: a turn stopped or failed before this point never sent the brief.
          chat.briefHash = briefHash;
          break;
        case 'text-delta':
          reply.text += ev.text;
          this.deps.hub.send({ type: 'chat-delta', projectId, key, messageId: reply.id, text: ev.text });
          break;
        case 'text':
          reply.text = reply.text ? `${reply.text}\n\n${ev.text}` : ev.text;
          this.emitReply(turn);
          break;
        case 'note':
          (reply.notes ??= []).push(ev.text);
          this.emitReply(turn);
          break;
        case 'tool-start':
          // Text written before a tool call is narration ("Je regarde la scène..."): keep it as a note, not as the answer.
          if (reply.text.trim()) (reply.notes ??= []).push(reply.text.trim());
          reply.text = '';
          (reply.activity ??= []).push({
            id: ev.id,
            tool: ev.name,
            label: activityLabel(ev.name, ev.input, agentTurn.cwd, this.deps.config.root),
            status: 'running',
          });
          this.emitReply(turn);
          break;
        case 'tool-end': {
          const activity = reply.activity?.find((a) => a.id === ev.id);
          if (activity) {
            activity.status = ev.isError ? 'error' : 'ok';
            if (ev.isError) activity.detail = ev.output.slice(0, 600);
          }
          this.emitReply(turn);
          break;
        }
        case 'done':
          // Claude Code: "No conversation found"; Codex: a missing thread on resume.
          const sessionLost = /no conversation found|session not found|thread .*not found|failed to resume/i;
          if (agentTurn.resume && ev.isError && sessionLost.test(ev.text)) return 'session-lost';
          if (ev.sessionId) chat.sessionId = ev.sessionId;
          reply.durationMs = ev.durationMs || Date.now() - started;
          // Claude Code reports a running session total (subtract the previous run); Codex reports this turn's tokens, no cost.
          if (ev.costUsd !== undefined || ev.tokens) {
            const claude = agent === 'claude-code';
            const totals = { costUsd: ev.costUsd ?? 0, tokens: ev.tokens ?? NO_TOKENS };
            const spent = claude ? addedSince(totals, agentTurn.resume ? chat.sessionUsage : undefined) : totals;
            if (claude) chat.sessionUsage = totals;
            if (ev.costUsd !== undefined) reply.costUsd = spent.costUsd;
            await this.deps.usage.record({ at: nowIso(), agent, kind: 'chat', projectId, chat: key, ...spent });
          }
          if (turn.abort.signal.aborted) {
            reply.status = 'stopped';
          } else if (ev.isError) {
            reply.status = 'error';
            reply.error = ev.text || m().agent.chat.failed;
            // Claude Code often streams the error as text too: show it once.
            if (reply.text.trim() && reply.error.includes(reply.text.trim())) reply.text = '';
          } else {
            reply.status = 'done';
            if (!reply.text.trim()) reply.text = ev.text;
          }
          this.emitReply(turn);
          break;
      }
    }
    return 'ok';
  }

  private onActivity(turn: Turn, activity: McpActivity): void {
    const tool = `${MCP_PREFIX}${activity.type === 'frames' ? 'render_frames' : 'check_seams'}`;
    const calls = (turn.reply.activity ?? []).filter((a) => a.tool === tool);
    const target = calls.find((a) => a.status === 'running' && !a.images && !a.detail) ?? calls.at(-1);
    if (!target) return;
    if (activity.type === 'frames') target.images = [...(target.images ?? []), ...activity.urls];
    else target.detail = activity.results.map(m().agent.chat.seam).join('\n');
    this.emitReply(turn);
  }

  /** Version what the turn changed, refresh code and seams, persist the chat. Never throws. */
  private async wrapUp(turn: Turn): Promise<void> {
    const { projectId, key, reply } = turn;
    const { store, versions, seams } = this.deps;
    // Deleted meanwhile (moved to the trash): writing now would recreate its folder.
    if (!(await store.exists(projectId).catch(() => false))) return;
    try {
      const entry = await versions.snapshot(projectId, {
        label: turn.text.replace(/\s+/g, ' ').slice(0, 80),
        source: 'agent',
        chatKey: key,
        costUsd: reply.costUsd,
      });
      if (entry) {
        reply.versionId = entry.id;
        await store.syncCode(projectId);
        const sceneId = sceneIdFromChatKey(key);
        if (sceneId) void seams.check(projectId, { sceneId }).catch(() => undefined);
      }
    } catch (e) {
      console.error(m().agent.chat.wrapUpFailed(projectId, key), e);
    }
    await this.files
      .run(chatId(projectId, key), () => this.save(projectId, turn.chat))
      .catch((e) => console.error(m().agent.chat.notSaved, e));
  }
}
