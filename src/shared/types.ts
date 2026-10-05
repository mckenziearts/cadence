// Data shapes shared by the server, the editor UI, the frame page and the scene runtime.
// This file is the contract between modules: change it deliberately, never ad hoc.

// Formats & models

export type FormatId = '16:9' | '9:16' | '1:1' | '4:5';
export type Orientation = 'landscape' | 'portrait' | 'square';

export interface FormatSpec {
  id: FormatId;
  /** Canvas size in CSS pixels. Scenes are designed at this size. */
  width: number;
  height: number;
  orientation: Orientation;
}

export const FORMATS: Record<FormatId, FormatSpec> = {
  '16:9': { id: '16:9', width: 1920, height: 1080, orientation: 'landscape' },
  '9:16': { id: '9:16', width: 1080, height: 1920, orientation: 'portrait' },
  '1:1': { id: '1:1', width: 1080, height: 1080, orientation: 'square' },
  '4:5': { id: '4:5', width: 1080, height: 1350, orientation: 'portrait' },
};

export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Margins (canvas px) kept clear of social-app UI (captions, buttons, progress bars). Scenes read them via useFormat(). */
export const SAFE_AREAS: Record<FormatId, SafeArea> = {
  '16:9': { top: 72, right: 72, bottom: 72, left: 72 },
  '9:16': { top: 220, right: 60, bottom: 380, left: 60 },
  '1:1': { top: 60, right: 60, bottom: 60, left: 60 },
  '4:5': { top: 60, right: 60, bottom: 60, left: 60 },
};

export function isFormatId(value: unknown): value is FormatId {
  return typeof value === 'string' && value in FORMATS;
}

// The superset across agents: Claude stops at 'max', Codex adds 'ultra'. Each model lists the efforts it actually offers.
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface ModelSpec {
  id: string;
  label: string;
  /** Haiku 4.5 rejects the effort parameter. */
  supportsEffort: boolean;
  hint: Record<Language, string>;
  /** The efforts this model offers (varies per model for Codex). Filled by the server catalogue, read by the picker. */
  efforts?: Effort[];
  defaultEffort?: Effort;
}

/** A model id goes to the claude CLI as an argument value: no leading dash, no spaces. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:@[\]-]{0,99}$/;

export const MODELS: ModelSpec[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    supportsEffort: true,
    hint: { fr: 'Création et scènes complexes', en: 'Creation and complex scenes' },
  },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', supportsEffort: true, hint: { fr: 'Retouches rapides', en: 'Quick edits' } },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    supportsEffort: true,
    hint: { fr: 'Le plus puissant, 2,5× le prix d’Opus', en: 'The most powerful, 2.5× the price of Opus' },
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    supportsEffort: false,
    hint: { fr: 'Très rapide, petites corrections', en: 'Very fast, small fixes' },
  },
];

// Projects (projects/<id>/project.json on disk)

/** Project ids and scene ids: lowercase kebab-case, 1-64 chars. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SceneFile {
  /** File-safe id; the scene lives at `scenes/<id>.tsx`. */
  id: string;
  name: string;
  /** Seconds, rounded to the millisecond, >= 0.1. */
  duration: number;
  /** Scene template this scene was created from, if any (informational). */
  template?: string | null;
  /** What the project's voice says over this scene; absent = no voice-over. */
  voiceOver?: SceneVoiceOver;
}

/** A scene's voice-over: spoken sentence by sentence by the project's voice (Piper), from `at`. */
export interface SceneVoiceOver {
  text: string;
  /** Seconds into the scene where the first sentence starts (>= 0). */
  at: number;
}

/** The project's voice-over voice, the same for every scene. */
export interface VoiceOverSettings {
  /** Piper voice id, e.g. `fr_FR-siwis-medium` (see GET /api/voices). */
  voice: string;
  /** 1 = the voice's own pace; 1.2 speaks 20 % faster (0.5 to 2). */
  speed: number;
  /** Music volume while the voice speaks, as a share of its usual volume (0 to 1). */
  musicLevel: number;
}

/** One generated sentence of a voice-over, in video seconds. */
export interface VoiceOverLine {
  sceneId: string;
  text: string;
  start: number;
  end: number;
}

/** A Piper voice Cadence offers (GET /api/voices). */
export interface VoiceInfo {
  id: string;
  language: 'fr' | 'en';
  /** Region of the accent, e.g. `fr_FR`, `en_US`, `en_GB`. */
  locale: string;
  name: string;
  quality: 'low' | 'medium' | 'high';
  license: string;
  /** The license allows a video that sells something; false = personal use only. */
  commercial: boolean;
  /** The license asks to credit the voice's dataset (CC-BY). */
  credit: boolean;
  /** Size of the download in bytes. */
  size: number;
  installed: boolean;
}

export interface VoicesState {
  /** Piper answers on this machine; `error` says why not. */
  piper: { ok: boolean; error?: string };
  voices: VoiceInfo[];
}

export interface MusicSettings {
  /** Path relative to the project folder, e.g. `music/track.mp3`. */
  file: string;
  /** Seconds into the track that line up with video time 0 (>= 0). */
  start: number;
  /** Linear gain 0..1 for playback and renders. */
  volume: number;
  /** Manual tempo override (BPM). null/undefined = use the analysis. */
  bpm?: number | null;
  /** Beats per bar: 3, 4 (default) or 6. */
  beatsPerBar?: number;
  /** Shift the downbeat phase by n beats (0 to beatsPerBar - 1) when the analysis picked the wrong "one". */
  barOffset?: number;
  /** Nudge the whole grid in seconds (-0.25 to 0.25). */
  gridOffset?: number;
}

/** PATCH /api/projects/:id/music body. null resets an override to the detected value. */
export interface MusicSettingsPatch {
  start?: number;
  volume?: number;
  bpm?: number | null;
  beatsPerBar?: number | null;
  barOffset?: number | null;
  gridOffset?: number | null;
}

export interface ProjectFile {
  version: 1;
  name: string;
  /** Brand preset id (folder in brands/), or null for the neutral default brand. */
  brand: string | null;
  /** 24, 30 or 60. */
  fps: number;
  /** Non-empty; the first one is the primary format shown by default. */
  formats: FormatId[];
  /** Tempo (BPM, 4/4) of the beat grid when there is no music track; also converts template bars to seconds. Default 120. */
  tempo: number;
  /** On-screen language of this video; null/absent = the brand's language. Scenes read it as brand.language. */
  language?: 'fr' | 'en' | null;
  scenes: SceneFile[];
  music: MusicSettings | null;
  /** The voice-over voice; null/absent = the default voice of the video's language. */
  voiceOver?: VoiceOverSettings | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneState extends SceneFile {
  index: number;
  /** Global start time in the video, seconds. */
  start: number;
  /** Absolute path of `scenes/<id>.tsx`. */
  file: string;
  /** Module URL the frame page imports (e.g. `/@fs/abs/path/scenes/intro.tsx`), without cache-busting query. */
  url: string;
  /** Changes whenever this scene's file changes (content hash, short). */
  codeVersion: string;
}

export interface ProjectState {
  id: string;
  /** Absolute path of the project folder. */
  dir: string;
  name: string;
  brand: string | null;
  fps: number;
  formats: FormatId[];
  /** See ProjectFile.tempo. */
  tempo: number;
  /** See ProjectFile.language (null = the brand's language). */
  language: 'fr' | 'en' | null;
  scenes: SceneState[];
  /** Sum of scene durations, seconds. */
  duration: number;
  music: MusicSettings | null;
  /** URL (editor origin) the browser can stream the audio from, or null. */
  musicUrl: string | null;
  /** Beat grid after manual overrides, in TRACK seconds; null without music or while analysing. */
  musicGrid: MusicGridData | null;
  /** The voice-over voice in use (the language's default until one is chosen). */
  voiceOver: VoiceOverSettings;
  /** Every generated sentence as one track over the video (editor origin), or null while none is. */
  voiceOverUrl: string | null;
  /** Generated sentences, in video seconds and in order: the music ducks under them. */
  voiceOverLines: VoiceOverLine[];
  /** Scenes whose voice-over is not generated yet (being generated, or Piper failed). */
  voiceOverPending: string[];
  /** Why Piper last failed on the sentences still missing; null while a sync tries them again, or when none failed. */
  voiceOverError: string | null;
  /** Bumped whenever any code file of the project (or its brand) changes; frames re-import when it moves. */
  codeGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  brand: string | null;
  formats: FormatId[];
  sceneCount: number;
  duration: number;
  updatedAt: string;
  /** Scene pictured on the home card (the first one); null without scenes. */
  cover: string | null;
}

export interface CreateProjectInput {
  name: string;
  /** Optional explicit id; derived from the name when omitted. */
  id?: string;
  brand: string | null;
  formats: FormatId[];
  fps: number;
  /** Project (campaign) template id; null = one blank starter scene. */
  template?: string | null;
  /** On-screen language; null/absent = the brand's language. */
  language?: 'fr' | 'en' | null;
}

export interface UpdateProjectInput {
  name?: string;
  brand?: string | null;
  formats?: FormatId[];
  fps?: number;
  tempo?: number;
  language?: 'fr' | 'en' | null;
  /** null = back to the default voice of the video's language. */
  voiceOver?: VoiceOverSettings | null;
}

export interface CreateSceneInput {
  name: string;
  /** Insert after this scene id; null/undefined = at the end. */
  after?: string | null;
  /** Scene template id to copy; ignored when `code` is given. */
  template?: string | null;
  /** Full TSX source for the new scene. */
  code?: string;
  /** Seconds; defaults to the template's bars at the project tempo, else 3. */
  duration?: number;
}

// Music

/** Output of the music analyzer. All times are seconds of TRACK time. */
export interface MusicAnalysis {
  version: 2;
  duration: number;
  sampleRate: number;
  bpm: number;
  beatsPerBar: number;
  beats: number[];
  /** Bar starts; a subset of `beats`. */
  downbeats: number[];
  /** Phrase starts (every 4 or 8 bars, aligned to the structure); a subset of `downbeats`. */
  phrases: number[];
  /** Structural segments with a coarse label (intro, build, drop, break, outro, A, B...) and mean loudness 0..1. */
  sections: { start: number; end: number; label: string; energy: number }[];
  /** Strong onsets, sorted by time, strength 0..1. */
  accents: { t: number; strength: number }[];
  /** Evenly spaced peak amplitudes 0..1 across the whole track (about 1000 points), for drawing. */
  waveform: number[];
  /** 0..1, how regular the beat grid is. */
  confidence: number;
}

/** The grid scenes and the editor use: the analysis with MusicSettings overrides applied. Track seconds. */
export interface MusicGridData {
  bpm: number;
  beatsPerBar: number;
  beats: number[];
  downbeats: number[];
  phrases: number[];
  sections: { start: number; end: number; label: string; energy: number }[];
  accents: { t: number; strength: number }[];
  waveform: number[];
  duration: number;
  confidence: number;
}

export type SnapGrid = 'beat' | 'bar' | 'phrase';

// Brands (brands/<id>/brand.json on disk)

export interface BrandColors {
  /** Page/canvas background. */
  background: string;
  /** Card / raised surface. */
  surface: string;
  /** Primary text. */
  ink: string;
  /** Secondary text. */
  muted: string;
  /** Hairlines and borders. */
  line: string;
  /** Brand color. */
  primary: string;
  /** Text on top of `primary`. */
  primaryInk: string;
  /** Secondary brand accent (annotations, highlights). */
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

export interface BrandFonts {
  /** CSS font-family names as loaded by the brand's theme.css, e.g. "'Space Grotesk Variable', sans-serif". */
  display: string;
  body: string;
  mono: string;
  /** Font faces the frame must wait for before capturing, e.g. ["700 32px 'Space Grotesk Variable'"]. */
  preload: string[];
}

export interface BrandFile {
  id: string;
  name: string;
  tagline: string;
  url: string;
  /** Main language of the brand's videos. */
  language: 'fr' | 'en';
  /** All colors as #rrggbb (hex only: the runtime color helpers interpolate them). */
  colors: BrandColors;
  fonts: BrandFonts;
  radius: { sm: number; md: number; lg: number; xl: number };
  /** Paths relative to the brand folder. */
  logo: { mark: string; full: string };
  /** Tone of voice, one or two sentences, used by the agent when writing copy. */
  voice: string;
}

export interface BrandSummary {
  id: string;
  name: string;
  tagline: string;
  colors: Pick<BrandColors, 'primary' | 'background' | 'ink' | 'accent'>;
  /** Editor-origin URL of the mark logo (SVG). */
  logoUrl: string | null;
}

/** A repository a brand can be built from. */
export interface RepoSummary {
  /** owner/name */
  fullName: string;
  description: string | null;
  private: boolean;
  /** ISO date of the last push. */
  pushedAt: string;
  url: string;
  /** The product's site, when the repository names one. */
  homepage: string | null;
}

/** GET /api/brand-sources/:host: the repositories the host's CLI on this machine (gh, glab) can see. */
export type RepoListing =
  | { available: true; account: string; repos: RepoSummary[] }
  | { available: false; reason: 'missing' | 'logged-out' | 'error'; detail?: string };

/** POST /api/brand-builds */
export interface StartBrandBuildInput {
  /** owner/name (GitHub), or a github.com or gitlab.com address, https or SSH. */
  repo: string;
  name: string;
}

/** A brand kit Claude builds from a repository into brands/<brandId>/ (hidden from the brand list until done). */
export interface BrandBuild {
  id: string;
  brandId: string;
  name: string;
  /** owner/name on GitHub, gitlab.com/group/name on GitLab. */
  repo: string;
  status: 'queued' | 'cloning' | 'building' | 'checking' | 'done' | 'error' | 'cancelled';
  /** What Claude is doing now, for the progress line. */
  activity: string | null;
  /** Files of the brand folder Claude wrote, in the order it first wrote them. */
  files: string[];
  costUsd: number | null;
  createdAt: string;
  finishedAt?: string;
  /** Claude's closing words: what it took from the repository and what it had to approximate. */
  summary?: string;
  error?: string;
  /** What the final check still found wrong (status error). */
  problems?: string[];
}

/** Git hosts a brand can be built from, reached through their CLI logged in on this machine (gh, glab). */
export type GitHost = 'github' | 'gitlab';

/** Who a host's CLI is logged in as. */
export type GitAccount = { available: true; account: string } | Extract<RepoListing, { available: false }>;

// Accounts & publishing (the Profile page, « Publier » on an exported video)

export const NETWORK_IDS = ['youtube', 'linkedin', 'instagram', 'tiktok'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

/** A network Cadence publishes to, as the Profile page shows it: never a token nor the app's secret. */
export interface NetworkAccount {
  id: NetworkId;
  label: string;
  /** Client id of the developer app the team created on the network; null until its keys are saved. */
  clientId: string | null;
  /** Where the network sends people back once they allow Cadence (some apps must list it). */
  redirectUri: string;
  account: { name: string; url: string; avatar: string | null; connectedAt: string } | null;
  fields: PublishFields;
}

/** connections: LinkedIn's members of your network. draft: sent to the network's app, where you post it (TikTok). */
export const VISIBILITIES = ['private', 'unlisted', 'public', 'connections', 'draft'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** What « Publier » asks for on a network. */
export interface PublishFields {
  /** Longest title; null when the network takes none. */
  title: number | null;
  /** Longest text (description, caption, post text); null when the network takes none. */
  text: number | null;
  /** The network refuses an empty text (LinkedIn). */
  textRequired?: boolean;
  /** Visibilities offered, the least public first: the default. */
  visibilities: Visibility[];
}

/** POST /api/projects/:id/publications */
export interface PublishRequest {
  /** File name inside projects/<id>/renders/. */
  file: string;
  network: NetworkId;
  /** Empty when the network takes no title (see PublishFields). */
  title: string;
  description: string;
  visibility: Visibility;
}

/** A video a network received, kept in projects/<id>/.cadence/publications.json (newest first). */
export interface Publication {
  file: string;
  network: NetworkId;
  title: string;
  /** null for a draft: it gets an address once posted from the network's app. */
  url: string | null;
  /** What the network applied: YouTube keeps the uploads of an unaudited Google project private. */
  visibility: Visibility;
  requested: Visibility;
  publishedAt: string;
}

/** A video on its way to a network (jobs of this run). */
export interface PublishJob {
  id: string;
  projectId: string;
  file: string;
  network: NetworkId;
  status: 'uploading' | 'done' | 'error';
  /** 0..1, share of the file sent. */
  progress: number;
  createdAt: string;
  finishedAt?: string;
  publication?: Publication;
  error?: string;
}

/** GET /api/projects/:id/publications */
export interface Publications {
  jobs: PublishJob[];
  publications: Publication[];
}

// Templates (templates/scenes/<id>/, templates/projects/<id>/)

export type SceneTemplateCategory = 'intro' | 'title' | 'ui' | 'feature' | 'data' | 'transition' | 'outro';

export interface SceneTemplateMeta {
  id: string;
  name: string;
  description: string;
  category: SceneTemplateCategory;
  /** Default length in bars (4/4); converted to seconds with the project tempo (120 BPM without music). */
  bars: number;
  /** Formats the template lays out well in. */
  formats: FormatId[];
  tags: string[];
  /** Short list of what to change after inserting it (copy, which UI, colors...). */
  customize: string[];
}

export interface ProjectTemplateMeta {
  id: string;
  name: string;
  description: string;
  fps: number;
  formats: FormatId[];
  /** Tempo the bar lengths assume until a track is added. */
  bpm: number;
  scenes: { template: string; name: string; bars: number }[];
}

// Versions (projects/<id>/.cadence/versions)

export type VersionSource = 'baseline' | 'agent' | 'manual' | 'restore' | 'external' | 'template';

export interface VersionEntry {
  /** Sortable id, e.g. "v0001". */
  id: string;
  createdAt: string;
  /** Human label: the prompt that produced it, "Sauvegarde manuelle", "Restauration de v0012"... */
  label: string;
  source: VersionSource;
  /** Chat that produced it, when source = agent. */
  chatKey?: ChatKey;
  /** Scene ids whose file or duration changed in this version. */
  scenes: string[];
  /** Project-relative paths that changed in this version. */
  files: string[];
  costUsd?: number;
}

// Chat

/** 'project' for the project chat, `scene:<sceneId>` for a scene chat. */
export type ChatKey = 'project' | `scene:${string}`;

export function chatKeyForScene(sceneId: string): ChatKey {
  return `scene:${sceneId}`;
}

export function sceneIdFromChatKey(key: ChatKey): string | null {
  return key.startsWith('scene:') ? key.slice(6) : null;
}

export interface Playhead {
  /** Scene the user was looking at, or null in whole-video mode. */
  sceneId: string | null;
  /** Seconds: scene-local when sceneId is set, video time otherwise. */
  t: number;
  format: FormatId;
}

export interface ChatActivity {
  /** Tool call id. */
  id: string;
  tool: string;
  /** French, user-facing ("Rendu de 4 images", "Modification de scenes/intro.tsx"). */
  label: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
  /** Editor-origin URLs of frames the agent looked at during this tool call. */
  images?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  model?: string;
  effort?: Effort;
  playhead?: Playhead;
  activity?: ChatActivity[];
  /** Reasoning notes the model shared (collapsed in the UI). */
  notes?: string[];
  durationMs?: number;
  /** API-equivalent cost reported by Claude Code for this turn. */
  costUsd?: number;
  /** Version created by this turn, if it changed files. */
  versionId?: string;
  error?: string;
}

export interface ChatState {
  key: ChatKey;
  messages: ChatMessage[];
  /** A turn of this chat is running. */
  running: boolean;
  /** A turn of this chat waits for another turn of the same project to finish. */
  queued: boolean;
  totalCostUsd: number;
}

export interface SendMessageInput {
  text: string;
  model?: string;
  effort?: Effort;
  playhead?: Playhead;
}

/** Tokens Claude Code counted, every model summed. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What Claude Code runs used. The cost is Claude Code's API-equivalent estimate, not an invoice. */
export interface UsageCount {
  costUsd: number;
  tokens: UsageTokens;
}

/** One agent run Cadence started: a line of .cadence/usage.jsonl. Lines written before per-agent tracking are Claude Code's. */
export type UsageEntry = UsageCount & { at: string; agent: AgentId } & (
    { kind: 'chat'; projectId: string; chat: ChatKey } | { kind: 'brand'; brandId: string }
  );

export interface UsageTotals extends UsageCount {
  runs: number;
}

/** GET /api/usage: everything recorded since the first line (`since` is null before any run). */
export interface UsageSummary {
  since: string | null;
  chats: UsageTotals;
  brands: UsageTotals;
}

// Seams, renders, assets

export interface SeamResult {
  from: string;
  to: string;
  format: FormatId;
  /** Percentage of pixels that differ (0..100). */
  diffPercent: number;
  checkedAt: string;
  error?: string;
}

export type RenderQuality = 'draft' | 'standard' | 'master';

export interface RenderRequest {
  formats: FormatId[];
  /** Defaults to the project fps. */
  fps?: number;
  /** Output pixel ratio: 0.5, 1 (default) or 2 (4K from a 1080p canvas). */
  scale?: number;
  quality: RenderQuality;
  /** Capture at 2× the output size then downscale (smoother edges and text). */
  supersample?: boolean;
  /** Optional sub-range of the video, seconds. */
  range?: { from: number; to: number };
}

export interface RenderJob {
  id: string;
  projectId: string;
  format: FormatId;
  status: 'queued' | 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled';
  /** 0..1 */
  progress: number;
  framesDone: number;
  framesTotal: number;
  width: number;
  height: number;
  fps: number;
  request: RenderRequest;
  createdAt: string;
  finishedAt?: string;
  /** File name inside projects/<id>/renders/. */
  file?: string;
  /** Editor-origin URL of the finished MP4. */
  url?: string;
  error?: string;
}

export interface RenderFile {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  format: FormatId | null;
}

export type AssetKind = 'image' | 'svg' | 'font' | 'audio' | 'other';

export interface AssetInfo {
  /** Path relative to the project's assets/ folder, e.g. `refs/dashboard-desktop.png`. */
  path: string;
  /** Editor-origin URL. */
  url: string;
  size: number;
  kind: AssetKind;
  /** Lives under assets/refs/ (reference screenshots for the agent). */
  isReference: boolean;
}

export interface CaptureRefInput {
  url: string;
  device: 'desktop' | 'mobile';
  fullPage?: boolean;
  /** File name without extension; derived from the URL when omitted. */
  name?: string;
}

// Settings & status

/** Languages of the interface (editor, server messages, CLI). */
export const LANGUAGES = ['fr', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** The coding agent that drives chats and brand builds, through its own CLI logged in on this computer. */
export const AGENT_IDS = ['claude-code', 'codex', 'grok', 'gemini'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** A model and effort choice per chat scope. */
export interface AgentPrefs {
  sceneModel: string;
  sceneEffort: Effort;
  projectModel: string;
  projectEffort: Effort;
}

export interface Settings extends AgentPrefs {
  /** Interface language; null until the editor first opens and picks the browser's. */
  language: Language | null;
  /** Which agent the chats and brand builds run on. One at a time. */
  agent: AgentId;
  /** Per-agent model/effort, so each assistant keeps its own. The flat fields above are Claude Code's. */
  agentPrefs?: Partial<Record<AgentId, Partial<AgentPrefs>>>;
}

/** The model and effort for a chat scope, for the active agent: Claude Code uses the flat fields, others use agentPrefs. */
export function agentPicks(settings: Settings, scope: 'scene' | 'project'): { model: string; effort: Effort } {
  const base: Partial<AgentPrefs> = settings.agent === 'claude-code' ? settings : (settings.agentPrefs?.[settings.agent] ?? {});
  return scope === 'scene'
    ? { model: base.sceneModel ?? '', effort: base.sceneEffort ?? 'medium' }
    : { model: base.projectModel ?? '', effort: base.projectEffort ?? 'medium' };
}

export interface AgentStatus {
  ok: boolean;
  label: string;
  version?: string;
  detail?: string;
  /** Why it is not ok, so the Profile can offer the right install or login help. */
  reason?: 'missing' | 'logged-out' | 'error';
}

/**
 * Editor sections a host app can hide (StartOptions.features). They shape the UI only: the routes behind a hidden section
 * still answer.
 */
export interface Features {
  /** The agent cards and usage on the Profile, and the agent choice of the new project and new brand dialogs. */
  agentPicker: boolean;
  /** The Git accounts (gh, glab) on the Profile. */
  gitSources: boolean;
  /** The buttons that edit a network app's keys; connect and disconnect stay. */
  networkApps: boolean;
  /** The model and effort choice of the settings and the chat composers. */
  modelPicker: boolean;
  /** Every dollar amount: chat messages, versions, brand builds, Profile usage and the project total. */
  costs: boolean;
}

export const DEFAULT_FEATURES: Features = {
  agentPicker: true,
  gitSources: true,
  networkApps: true,
  modelPicker: true,
  costs: true,
};

/** GET /api/state */
export interface AppState {
  projects: ProjectSummary[];
  brands: BrandSummary[];
  templates: { scenes: SceneTemplateMeta[]; projects: ProjectTemplateMeta[] };
  settings: Settings;
  agent: AgentStatus;
  /** Origin of the frame server, e.g. http://127.0.0.1:5311 (the editor loads frames from there). */
  frameOrigin: string;
  models: ModelSpec[];
  /** Brand builds of this run, newest first. */
  brandBuilds: BrandBuild[];
  networks: NetworkAccount[];
  features: Features;
}

// Server -> editor events (SSE on /api/events)

export type ServerEvent =
  | { type: 'projects-changed' }
  | { type: 'brands-changed' }
  | { type: 'accounts-changed' }
  /** The interface language changed: every open editor reloads in it. */
  | { type: 'language-changed'; language: Language }
  | { type: 'project-changed'; projectId: string }
  | { type: 'code-changed'; projectId: string; generation: number }
  | { type: 'chat'; projectId: string; state: ChatState }
  /** The running reply changed (tool call, note, end): only that message travels, not the whole chat. */
  | { type: 'chat-message'; projectId: string; key: ChatKey; message: ChatMessage }
  | { type: 'chat-delta'; projectId: string; key: ChatKey; messageId: string; text: string }
  | { type: 'render'; job: RenderJob }
  | { type: 'publish'; job: PublishJob }
  | { type: 'brand-build'; build: BrandBuild }
  | { type: 'seams'; projectId: string; results: SeamResult[] }
  | { type: 'music'; projectId: string; status: 'analyzing' | 'ready' | 'error'; error?: string }
  | { type: 'voice-over'; projectId: string; status: 'speaking' | 'ready' | 'error'; error?: string }
  | { type: 'versions'; projectId: string }
  | { type: 'assets'; projectId: string };
