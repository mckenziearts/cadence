// Service interfaces the server modules implement and depend on (constructor injection).
// Each interface lists the module and export name that implements it, so server/index.ts can wire them.
// Modules must depend on these interfaces, never on each other's concrete classes.
import type { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AuditFinding } from '../src/shared/frameProtocol';
import type {
  AssetInfo,
  BrandBuild,
  BrandFile,
  BrandSummary,
  CaptureRefInput,
  ChatKey,
  ChatState,
  CreateProjectInput,
  CreateSceneInput,
  ElevenLabsModel,
  ElevenLabsVoice,
  FormatId,
  GitAccount,
  GitHost,
  MusicAnalysis,
  MusicGridData,
  MusicSettings,
  MusicSettingsPatch,
  NetworkAccount,
  NetworkId,
  ProjectFile,
  ProjectState,
  ProjectSummary,
  ProjectTemplateMeta,
  Publications,
  PublishFields,
  PublishJob,
  PublishRequest,
  RenderFile,
  RenderJob,
  RenderRequest,
  RepoListing,
  SceneState,
  SceneTemplateMeta,
  SceneVoiceOver,
  SeamResult,
  SendMessageInput,
  ServerEvent,
  Settings,
  SnapGrid,
  StartBrandBuildInput,
  UpdateProjectInput,
  UsageEntry,
  UsageSummary,
  UsageTokens,
  VersionEntry,
  VersionSource,
  Visibility,
  VoiceInfo,
  VoiceOverLine,
  VoicesState,
} from '../src/shared/types';

// Paths and options: server/config.ts exports `loadConfig(overrides?)`, which returns this.

export interface CadenceConfig {
  /** Repository root (contains package.json, brands/, templates/, projects/). */
  root: string;
  projectsDir: string;
  brandsDir: string;
  templatesDir: string;
  /** Global state, never served: <root>/.cadence (settings, accounts, usage, brand clones, trashed brands). */
  stateDir: string;
  host: '127.0.0.1';
  /** Editor + API + SSE + MCP. */
  editorPort: number;
  /** Frame pages + modules, read-only data. Different port = different origin. */
  framePort: number;
  editorOrigin: string;
  frameOrigin: string;
  mcpUrl: string;
  ffmpegPath: string;
  ffprobePath: string;
  claudePath: string;
  codexPath: string;
  grokPath: string;
  geminiPath: string;
  /** Piper, for voice-overs (env PIPER_PATH): optional, each user installs it. */
  piperPath: string;
  /** Default model/effort (env CADENCE_MODEL / CADENCE_EFFORT), overridden by settings.json. */
  defaultModel: string;
  defaultEffort: Settings['sceneEffort'];
  /** Keep ANTHROPIC_API_KEY in the agent's env (default: removed, so Claude Code uses the subscription login). */
  useApiKey: boolean;
  /** Append the agent's raw stream-json to this file (debug). */
  agentLog: string | null;
}

// server/hub.ts: export class SseHub implements Hub

export interface Hub {
  send(event: ServerEvent): void;
  /** Handle GET /api/events (text/event-stream, keep-alive pings every 20 s). */
  handleSse(req: IncomingMessage, res: ServerResponse): void;
}

// server/store/projects.ts: export class FileProjectStore implements ProjectStore
//   constructor(config: CadenceConfig, deps?: { templates: TemplateStore; brands: BrandStore }), deps default to the File* stores
//
// Events on `events`:
//   'list-changed'                           a project folder was added/removed/renamed
//   'changed'       (projectId)              project.json or art-direction.md changed
//   'code-changed'  (projectId, generation)  a code file (scenes/**, components/**, brand files) changed; generation bumped
//   'versions-changed' (projectId)           FileVersionStore recorded a version (hub event 'versions')
//   'assets-changed'   (projectId)           assets/** changed on disk (hub event 'assets')

/** Vite's file watcher (chokidar `all` events: name, absolute path): it already watches the root, see server/frames/vite.ts. */
export type FileEvents = Pick<EventEmitter, 'on' | 'off'>;

export interface ProjectStore {
  readonly root: string;
  readonly events: EventEmitter;
  /** Turn a watcher's file events under projects/ and brands/ into the events above, debounced 60 ms. */
  watch(files: FileEvents): void;
  close(): void;
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectState>;
  exists(id: string): Promise<boolean>;
  dir(id: string): string;
  sceneFile(id: string, sceneId: string): string;
  create(input: CreateProjectInput): Promise<ProjectState>;
  update(id: string, patch: UpdateProjectInput): Promise<ProjectState>;
  /** Moves the folder to projects/.trash/<id>-<timestamp>. */
  remove(id: string): Promise<void>;
  createScene(id: string, input: CreateSceneInput): Promise<SceneState>;
  /** `voiceOver: null` (or blank text) removes the scene's voice-over. */
  updateScene(
    id: string,
    sceneId: string,
    patch: { name?: string; duration?: number; voiceOver?: SceneVoiceOver | null },
  ): Promise<ProjectState>;
  duplicateScene(id: string, sceneId: string): Promise<SceneState>;
  /** Moves the scene file to projects/<id>/.cadence/trash/. */
  deleteScene(id: string, sceneId: string): Promise<ProjectState>;
  reorderScenes(id: string, sceneIds: string[]): Promise<ProjectState>;
  /** Set scene durations in one write (used by snap-to-music). */
  setDurations(id: string, durations: Record<string, number>): Promise<ProjectState>;
  setMusic(id: string, music: MusicSettings | null): Promise<ProjectState>;
  readArtDirection(id: string): Promise<string>;
  writeArtDirection(id: string, text: string): Promise<void>;
  /** Re-hash code files; if anything changed, bump the generation, invalidate modules and emit 'code-changed'. */
  syncCode(id: string): Promise<boolean>;
  generation(id: string): number;
  /**
   * Serialize read-modify-write of project.json (and other per-project critical sections). Re-entrant within the same
   * async context. Lock order: project lock first, then the versions mutex.
   */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** Injected by server/index.ts: called with the project dir (and brand dir) before 'code-changed' is emitted. */
  setModuleInvalidator(fn: (dirs: string[]) => void): void;
  /** Injected by server/index.ts: resolves the music grid for ProjectState.musicGrid. */
  setMusicGridProvider(fn: (id: string) => Promise<MusicGridData | null>): void;
  /** Injected by server/index.ts: resolves the voice-over fields of ProjectState from what is already generated. */
  setVoiceOverProvider(fn: VoiceOverProvider): void;
}

export type VoiceOverProvider = (
  id: string,
  data: ProjectFile,
  scenes: SceneState[],
) => Promise<Pick<ProjectState, 'voiceOver' | 'voiceOverUrl' | 'voiceOverLines' | 'voiceOverPending' | 'voiceOverError'>>;

// server/store/brands.ts: export class FileBrandStore implements BrandStore  (constructor(config: CadenceConfig))

export interface BrandStore {
  list(): Promise<BrandSummary[]>;
  get(id: string): Promise<BrandFile>;
  exists(id: string): Promise<boolean>;
  dir(id: string): string;
  /** Move the brand to .cadence/trash/brands; never a brand being built. */
  remove(id: string): Promise<void>;
  /** Markdown for the agent: tokens, fonts, voice, kit components and extras (from brands/<id>/KIT.md). */
  describe(id: string | null): Promise<string>;
}

// server/brands/source.ts: export class GitHubSource, GitLabSource implements BrandSource
// server/brands/build.ts: export class BrandBuilder implements BrandBuildService

/** A repository as the user named it: its host, its path (owner/name, group/sub/name), whether they gave its SSH address. */
export interface RepoRef {
  host: GitHost;
  fullName: string;
  ssh: boolean;
}

export interface BrandSource {
  /** Who the host's CLI is logged in as (the Profile page). */
  account(): Promise<GitAccount>;
  /** Repositories the host's CLI login can see, most recently active first. */
  repos(): Promise<RepoListing>;
  /** Copy of the repository's default branch into `dest`, without history, with this machine's own Git access. */
  fetch(repo: RepoRef, dest: string, signal: AbortSignal): Promise<void>;
}

// server/networks/youtube.ts: export class YouTubeNetwork implements Network
// server/accounts/accounts.ts: export class FileAccountService implements AccountService
// server/accounts/publish.ts: export class Publisher implements PublishService

/** Keys of the developer app the team created on a network; they stay in .cadence/accounts.json. */
export interface NetworkApp {
  clientId: string;
  clientSecret: string;
}

export interface NetworkTokens {
  access: string;
  refresh: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The account to publish to, chosen at connection, when one sign-in reaches several (Instagram). */
  account?: string;
}

export interface NetworkIdentity {
  name: string;
  url: string;
  avatar: string | null;
}

/** The HTTP client of a network: fetch, or a test's fake network. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A network Cadence publishes to: OAuth 2 (with PKCE where the network takes it) and a loopback redirect, then the upload. */
export interface Network {
  id: NetworkId;
  label: string;
  /** What « Publier » asks for on this network; the publisher checks requests against it. */
  fields: PublishFields;
  /** Host of the loopback redirect: 127.0.0.1 unless the network only accepts localhost. */
  redirectHost?: 'localhost';
  /** The consent page the person opens; `challenge` is PKCE's S256 (base64url), for networks that use it. */
  authorizeUrl(app: NetworkApp, input: { redirectUri: string; state: string; challenge: string }): string;
  /** Tokens for the code of the redirect, and who allowed Cadence. */
  connect(
    app: NetworkApp,
    input: { redirectUri: string; code: string; verifier: string },
  ): Promise<{ identity: NetworkIdentity; tokens: NetworkTokens }>;
  /** Fresh tokens; HttpError 401 when the connection is revoked or expired for good. */
  refresh(app: NetworkApp, tokens: NetworkTokens): Promise<NetworkTokens>;
  revoke(app: NetworkApp, tokens: NetworkTokens): Promise<void>;
  /** Send an MP4; `onProgress` gets the bytes the network has received. */
  publish(input: {
    tokens: NetworkTokens;
    file: string;
    size: number;
    title: string;
    description: string;
    visibility: Visibility;
    onProgress(sent: number): void;
  }): Promise<{ url: string | null; visibility: Visibility }>;
}

export interface AccountService {
  networks(): Promise<NetworkAccount[]>;
  git(): Promise<Record<GitHost, GitAccount>>;
  /** New keys drop the connection made with the previous ones. */
  saveApp(id: NetworkId, app: NetworkApp): Promise<void>;
  /** The consent page, bound to a single-use state that expires after 10 minutes. */
  connect(id: NetworkId): Promise<{ url: string }>;
  /** GET /oauth/<network>/callback: never throws, the result is the page the person reads. */
  callback(network: string, params: URLSearchParams): Promise<{ ok: boolean; title: string; detail: string }>;
  disconnect(id: NetworkId): Promise<void>;
  /** Tokens to call the network with, refreshed first when they are about to expire. */
  tokens(id: NetworkId): Promise<NetworkTokens>;
}

export interface PublishService {
  start(projectId: string, req: PublishRequest): Promise<PublishJob>;
  list(projectId: string): Promise<Publications>;
  /** A video of the project (that file, when given) is on its way: deleting the project, or that video, waits. */
  busy(projectId: string, file?: string): boolean;
}

export interface BrandBuildService {
  start(input: StartBrandBuildInput): Promise<BrandBuild>;
  cancel(id: string): void;
  /** Builds of this run, newest first. */
  list(): BrandBuild[];
  /** The build once it has ended. */
  wait(id: string): Promise<BrandBuild>;
  /** Remove what interrupted builds left (brand folders still marked as building, clones). */
  sweep(): Promise<void>;
  /** Cancel the running builds and wait for them (shutdown). */
  close(): Promise<void>;
}

// server/store/templates.ts: export class FileTemplateStore implements TemplateStore  (constructor(config: CadenceConfig))

export interface TemplateStore {
  scenes(): Promise<SceneTemplateMeta[]>;
  projects(): Promise<ProjectTemplateMeta[]>;
  sceneTemplate(id: string): Promise<{ meta: SceneTemplateMeta; code: string }>;
  projectTemplate(id: string): Promise<ProjectTemplateMeta & { artDirection: string | null }>;
  /** Markdown catalogue for the agent. */
  describe(): Promise<string>;
}

// server/store/versions.ts: export class FileVersionStore implements VersionStore  (constructor(store: ProjectStore))
// Tracked files: project.json, art-direction.md, scenes/**, components/** (text files < 2 MB).

export interface VersionStore {
  /** Newest first. */
  list(projectId: string, opts?: { sceneId?: string }): Promise<VersionEntry[]>;
  /** Snapshot the tracked files. Returns null when nothing changed since the latest version. */
  snapshot(
    projectId: string,
    meta: { label: string; source: VersionSource; chatKey?: ChatKey; costUsd?: number },
  ): Promise<VersionEntry | null>;
  /**
   * Restore a version (whole project, or one scene's file + duration). Never loses work: unsaved changes are
   * snapshotted first (source 'external'), and the restore itself becomes a new version (source 'restore').
   */
  restore(projectId: string, versionId: string, opts?: { sceneId?: string }): Promise<VersionEntry>;
  /** Content of one tracked file at a version (for previews/diffs), or null if absent in that version. */
  read(projectId: string, versionId: string, file: string): Promise<string | null>;
}

// server/store/assets.ts: export class FileAssetStore implements AssetStore  (constructor(store: ProjectStore, capture: CaptureService))

export interface AssetStore {
  list(projectId: string): Promise<AssetInfo[]>;
  /** Save an uploaded file under assets/ (images, SVG, fonts; 50 MB max). Name is sanitized. */
  upload(projectId: string, file: { name: string; data: Buffer }): Promise<AssetInfo>;
  remove(projectId: string, assetPath: string): Promise<void>;
  /** Screenshot a web page into assets/refs/<name>-<device>.png (reference material for the agent). */
  captureReference(projectId: string, input: CaptureRefInput): Promise<AssetInfo>;
  /** Absolute path of an asset, after checking it stays inside assets/. */
  resolve(projectId: string, assetPath: string): string;
}

// server/capture/capture.ts: export class PlaywrightCapture implements CaptureService
//   constructor(deps: { config: CadenceConfig; store: ProjectStore })

export interface CapturedFrame {
  /** Requested time (scene-local with sceneId, video time without). */
  t: number;
  sceneId: string | null;
  localTime: number;
  image: Buffer;
  mime: 'image/jpeg' | 'image/png';
  errors: string[];
  /** With `audit`: what the text checks found, null when they failed (scene code can break them). */
  audit?: AuditFinding[] | null;
}

export interface CaptureService {
  frames(
    projectId: string,
    req: {
      sceneId: string | null;
      times: number[];
      format?: FormatId;
      /** Pixel ratio relative to the canvas (0.25 thumbnails, 0.5 agent, 1 full). */
      scale?: number;
      imageFormat?: 'jpeg' | 'png';
      quality?: number;
      /** Burned-in captions when the project has them on (default true); seam checks and thumbnails pass false. */
      captions?: boolean;
      /** Run the frame's text checks after each screenshot (render_frames). */
      audit?: boolean;
      /** Epoch ms: no seek starts from then on, the frames already taken come back (check_motion's time budget). */
      deadline?: number;
    },
  ): Promise<CapturedFrame[]>;
  /** Small JPEG of a scene (cached per code generation + scene + format + t). */
  thumbnail(projectId: string, sceneId: string, opts?: { t?: number; format?: FormatId }): Promise<Buffer>;
  /** Screenshot an external http(s) page (reference capture). */
  screenshotUrl(url: string, opts: { device: 'desktop' | 'mobile'; fullPage?: boolean }): Promise<Buffer>;
  /** JPEG of a brand's kit sheet (kit.html, sandboxed), with what failed to render or load there. */
  kitSheet(brandId: string, opts?: { scale?: number }): Promise<{ image: Buffer; problems: string[]; loaded: boolean }>;
  /** One JPEG of PNG tiles of one size in reading order, `columns` per row, `gap` px apart (render_frames strips). */
  contactSheet(tiles: Buffer[], layout: { columns: number; gap: number }): Promise<Buffer>;
  close(): Promise<void>;
}

// server/capture/seams.ts: export class PixelSeamService implements SeamService
//   constructor(deps: { store: ProjectStore; capture: CaptureService; hub: Hub })

export interface SeamDetail {
  result: SeamResult;
  fromImage: Buffer;
  toImage: Buffer;
  diffImage: Buffer;
}

export interface SeamService {
  /** Check the cuts into/out of one scene, or all cuts, in `format` or every project format. Emits a 'seams' event. */
  check(projectId: string, opts?: { sceneId?: string; format?: FormatId }): Promise<SeamResult[]>;
  /** Check every cut again in the background once the project's edits settle: a burst of edits is one check. */
  recheck(projectId: string): void;
  detail(projectId: string, from: string, to: string, format?: FormatId): Promise<SeamDetail>;
  /** Last known results (may be stale after edits). */
  cached(projectId: string): SeamResult[];
}

// server/capture/render.ts: export class FfmpegRenderService implements RenderService
//   constructor(deps: { config: CadenceConfig; store: ProjectStore; music: MusicService; voiceOver: VoiceOverService; hub: Hub })

export interface RenderService {
  /** One job per format; jobs run one at a time, frames captured by up to 4 parallel pages. */
  start(projectId: string, req: RenderRequest): Promise<RenderJob[]>;
  cancel(jobId: string): void;
  jobs(projectId?: string): RenderJob[];
  files(projectId: string): Promise<RenderFile[]>;
  /** Absolute path of a finished render, after checking it stays inside renders/. */
  resolveFile(projectId: string, name: string): string;
  /** Moves a finished render to the project's .cadence/trash. */
  remove(projectId: string, name: string): Promise<void>;
  /** Resolves when the job ends (done, error or cancelled). Used by the CLI. */
  wait(jobId: string): Promise<RenderJob>;
}

// server/music/service.ts: export class LocalMusicService implements MusicService
//   constructor(deps: { config: CadenceConfig; store: ProjectStore; hub: Hub })
// Tracks live in projects/<id>/music/; analysis cached next to them as <file>.analysis.json.

/** An uploaded file: its bytes as they arrive, so a large one is written to disk without being held in memory. */
export interface Upload {
  name: string;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface MusicService {
  /** Save an audio file (mp3, wav, m4a, aac, flac, ogg; 200 MB max), select it, analyse it in the background. */
  upload(projectId: string, file: Upload): Promise<ProjectState>;
  /** Tracks present in music/. */
  tracks(projectId: string): Promise<{ file: string; size: number; analysed: boolean }[]>;
  select(projectId: string, file: string): Promise<ProjectState>;
  update(projectId: string, patch: MusicSettingsPatch): Promise<ProjectState>;
  remove(projectId: string): Promise<ProjectState>;
  analysis(projectId: string): Promise<MusicAnalysis | null>;
  /** Analysis with the project's overrides applied (bpm, beatsPerBar, barOffset, gridOffset). */
  grid(projectId: string): Promise<MusicGridData | null>;
  /**
   * Move every cut to the nearest grid point (video time); each scene keeps >= 0.4 s.
   * keepBars: keep each scene's bar count (round(duration × tempo / 240), at least 1) and lay the cuts on the
   * detected downbeats instead, so campaign structures and beat-timed payoffs survive a new tempo. It also sets
   * project.tempo to 240 / bar length (30-300), so a second snap keeps the same counts.
   */
  snapCuts(projectId: string, grid: SnapGrid, opts?: { keepBars?: boolean }): Promise<ProjectState>;
  /** Plain-text tempo/bars/phrases/cuts summary for the agent, in scene-local seconds when sceneId is given. */
  context(projectId: string, sceneId?: string | null): Promise<string>;
  /** Absolute path of the selected track, or null. */
  audioPath(projectId: string): Promise<string | null>;
}

// server/voiceover/piper.ts: export class PiperEngine implements SpeechEngine  (constructor(bin: string))

/** Text to speech (tests: a fake that never runs Piper). */
export interface SpeechEngine {
  /** The engine answers; `error` says how to install it when it does not. */
  check(): Promise<{ ok: boolean; error?: string }>;
  /** Speaks each sentence into the WAV file at the same index of `files`. `model` is the voice's .onnx file. */
  speak(input: { model: string; sentences: string[]; lengthScale: number; files: string[] }): Promise<void>;
}

// server/voiceover/elevenlabs.ts: export class ElevenLabsClient implements ElevenLabsApi  (constructor(http?: Fetch))

/** ElevenLabs with the person's own API key (tests: a fake Fetch, never the network). */
export interface ElevenLabsApi {
  /** The account's voices (one page of 100); a refused key is a 400. */
  voices(key: string): Promise<ElevenLabsVoice[]>;
  /** The models that speak text. */
  models(key: string): Promise<ElevenLabsModel[]>;
  /** Speaks each sentence, one request at a time, into the 24 kHz WAV file at the same index of `files`. */
  speak(input: { key: string; voice: string; model: string; speed: number; sentences: string[]; files: string[] }): Promise<void>;
}

// server/voiceover/service.ts: export class LocalVoiceOverService implements VoiceOverService
//   constructor(deps: { config: CadenceConfig; store: ProjectStore; brands: BrandStore; hub: Hub; engine: SpeechEngine; elevenLabs: ElevenLabsApi })

export interface VoiceOverService {
  /** Piper's state and the voices Cadence offers, with which ones are downloaded, and whether an ElevenLabs key is saved. */
  voices(): Promise<VoicesState>;
  /** Download a voice into <root>/.cadence/voices/ (md5 checked); resolves once both files are in place. */
  download(id: string): Promise<VoiceInfo>;
  /** The voices and models of the saved ElevenLabs key's account; 409 when no key is saved. */
  elevenLabs(): Promise<{ voices: ElevenLabsVoice[]; models: ElevenLabsModel[] }>;
  /** Save the ElevenLabs key once ElevenLabs accepts it (its refusal passes through), or remove it with null. */
  setElevenLabsKey(key: string | null): Promise<void>;
  /** Speak the sentences of the project not generated yet. Rejects with the engine's error (also sent to the editor). */
  sync(projectId: string): Promise<void>;
  /** The generated voice-over as one WAV over the video, with its sentences, or null when nothing is generated. */
  track(projectId: string): Promise<VoiceOverTrack | null>;
}

export interface VoiceOverTrack {
  file: string;
  lines: VoiceOverLine[];
  /** Music volume under the voice (VoiceOverSettings.musicLevel). */
  musicLevel: number;
}

// server/agent/chat.ts: export class ChatManager implements ChatService
//   constructor(deps: { config; store; brands; templates; versions; capture; seams; music; assets; hub; provider: AgentProvider; tokens: McpTokenIssuer; settings: SettingsStore; usage: UsageLog; features: Features })

export interface ChatService {
  get(projectId: string, key: ChatKey): Promise<ChatState>;
  /** Append the user message and start (or queue) the turn. Returns immediately; progress arrives over SSE. */
  send(projectId: string, key: ChatKey, input: SendMessageInput): Promise<ChatState>;
  stop(projectId: string, key: ChatKey): void;
  /**
   * Forget the conversation (new Claude Code session). Messages are archived, not deleted. Throws HttpError 409 while a
   * turn of that chat is running or queued (stop first).
   */
  clear(projectId: string, key: ChatKey): Promise<ChatState>;
  totalCost(projectId: string): Promise<number>;
  /** Abort every running turn and drop queued ones (server shutdown); resolves when the processes have exited. */
  stopAll(): Promise<void>;
  /** A turn of this project is running or queued (restores and deletions wait for it). */
  busy(projectId: string): boolean;
}

// server/mcp/tokens.ts: export class McpTokens implements McpTokenIssuer  (constructor(config: CadenceConfig, terminalFile?: string))
// server/mcp/server.ts: export function createMcpHandler(deps): (req, res) => Promise<void>
//   deps: { config; store; brands; templates; versions; capture; seams; music; assets; tokens: McpTokenIssuer; diagnose }

export type McpScope =
  | { kind: 'scene'; projectId: string; sceneId: string }
  | { kind: 'project'; projectId: string }
  /** Terminal usage (`claude mcp add ...`): every tool, any project. */
  | { kind: 'open' }
  /** A brand build: the brand tools only, bound to brands/<brandId>/ and the cloned repository. */
  | { kind: 'brand'; brandId: string; repoDir: string };

/** Reported by MCP tools so the chat UI can show what the agent looked at. */
export type McpActivity =
  { type: 'frames'; sceneId: string | null; times: number[]; urls: string[] } | { type: 'seams'; results: SeamResult[] };

export interface McpTokenIssuer {
  /** Random 32-byte token bound to a scope; valid until revoked or expired (default ttl 2 h). */
  issue(scope: McpScope, opts?: { ttlMs?: number }): string;
  revoke(token: string): void;
  resolve(token: string | undefined | null): McpScope | null;
  /** Long-lived token for terminal usage, persisted outside the repo (~/.config/cadence/mcp-token, mode 0600). */
  terminalToken(): Promise<string>;
  /** ChatManager subscribes per turn token; returns an unsubscribe function. */
  onActivity(token: string, listener: (activity: McpActivity) => void): () => void;
  /** Called by MCP tools. */
  reportActivity(token: string, activity: McpActivity): void;
}

// Agent provider, server/agent/claudeCode.ts: export class ClaudeCodeProvider implements AgentProvider (constructor(config, agent name))
// Tests inject fake providers through startServer({ provider }).

export interface AgentTurn {
  /** Working directory (the project folder). */
  cwd: string;
  prompt: string;
  /** Appended to Claude Code's default system prompt. */
  systemPrompt: string;
  model: string;
  /** null when the model does not support effort. */
  effort: import('../src/shared/types').Effort | null;
  /** Built-in tools available (e.g. Read, Edit, Write, Glob, Grep). */
  tools: string[];
  /** Pre-approved permission rules (--allowedTools); anything else is denied without prompting. */
  allow: string[];
  /** Permission rules denied even inside a readable directory (--disallowedTools). */
  deny: string[];
  /** Extra readable directories (--add-dir). */
  addDirs: string[];
  /** --mcp-config mcpServers object. */
  mcpServers: Record<string, unknown>;
  sessionId: string;
  /** Resume `sessionId` instead of starting it. */
  resume: boolean;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'init'; sessionId: string; model?: string }
  | { type: 'text-delta'; text: string }
  /** Complete text block not already streamed as deltas. */
  | { type: 'text'; text: string }
  /** Reasoning shared by the model. */
  | { type: 'note'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-end'; id: string; isError: boolean; output: string }
  | {
      type: 'done';
      text: string;
      isError: boolean;
      durationMs: number;
      /** Running totals of the session: Claude Code starts a resumed session from the totals it saved. */
      costUsd?: number;
      tokens?: UsageTokens;
      sessionId?: string;
      /** success, error_max_turns, aborted, crashed... */
      subtype?: string;
    };

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  status(): Promise<import('../src/shared/types').AgentStatus>;
  run(turn: AgentTurn): AsyncIterable<AgentEvent>;
}

// server/usage.ts: export class FileUsageLog implements UsageLog  (constructor(config: CadenceConfig))

export interface UsageLog {
  /** Append the run to <root>/.cadence/usage.jsonl. Never rejects: a lost line must not fail the run. */
  record(entry: UsageEntry): Promise<void>;
  summary(agent?: import('../src/shared/types').AgentId): Promise<UsageSummary>;
}

// server/settings.ts: export class FileSettingsStore implements SettingsStore  (constructor(config: CadenceConfig))

export interface SettingsStore {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
}

// server/api/index.ts: export function createApi(deps: ApiDeps): Hono   (routes under /api, see ARCHITECTURE.md)

/** A host app's route groups, each mounted under /api/<name> behind the editor guards (ARCHITECTURE.md "Embedding Cadence"). */
export type HostApi = Record<string, Hono<{ Bindings: HttpBindings }>>;

export interface ApiDeps {
  config: CadenceConfig;
  store: ProjectStore;
  brands: BrandStore;
  templates: TemplateStore;
  versions: VersionStore;
  assets: AssetStore;
  capture: CaptureService;
  seams: SeamService;
  renders: RenderService;
  music: MusicService;
  voiceOver: VoiceOverService;
  chats: ChatService;
  settings: SettingsStore;
  usage: UsageLog;
  hub: Hub;
  brandSources: Record<GitHost, BrandSource>;
  brandBuilds: BrandBuildService;
  accounts: AccountService;
  publisher: PublishService;
  agentStatus: () => Promise<import('../src/shared/types').AgentStatus>;
  /** CLI status on this computer for the other agents, for the Profile's cards (the running agent stays Claude for now). */
  codexStatus: () => Promise<import('../src/shared/types').AgentStatus>;
  grokStatus: () => Promise<import('../src/shared/types').AgentStatus>;
  geminiStatus: () => Promise<import('../src/shared/types').AgentStatus>;
  /** The models the given agent offers, with each model's efforts, for the chat picker. */
  models: (agent: import('../src/shared/types').AgentId) => Promise<import('../src/shared/types').ModelSpec[]>;
  /** Compile a scene file through Vite and return the error text (with code frame), or null. */
  diagnose: (file: string) => Promise<string | null>;
  hostApi?: HostApi;
  features: import('../src/shared/types').Features;
}
