// One zustand store; each file of store/ owns a slice of it (state shape here, actions next to their domain).
import { create } from 'zustand';
import type {
  AppState,
  ChatKey,
  ChatState,
  Effort,
  FormatId,
  Language,
  ProjectState,
  Publications,
  RenderFile,
  RenderJob,
  SceneState,
  SeamResult,
} from '../../shared/types';

export type View = 'scenes' | 'render';
export type Panel = 'scene' | 'project' | 'versions' | 'music' | 'voice' | 'media';
export type PreviewMode = 'scene' | 'whole';
export type MusicStatus = 'idle' | 'analyzing' | 'ready' | 'error';
export type VoiceOverStatus = 'idle' | 'speaking' | 'ready' | 'error';
export type ChatKind = 'scene' | 'project';

export type Modal =
  | { kind: 'new-project'; brand?: string | null }
  /** Pick a repository, or follow the build `buildId`. */
  | { kind: 'new-brand'; buildId?: string }
  | { kind: 'art' }
  | { kind: 'seam'; from: string; to: string; format: FormatId }
  | { kind: 'templates' }
  | { kind: 'settings' }
  | { kind: 'lightbox'; images: string[]; index: number }
  /** Send `file` (in the project's renders/) to a network. */
  | { kind: 'publish'; file: string };

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface EditorState {
  // App
  app: AppState | null;
  appError: string | null;
  /** SSE stream open. */
  connected: boolean;
  /** The server restarted since this page loaded: its token is stale, mutations need a reload. */
  stale: boolean;
  /** Interface language: the setting, else the browser's; the page starts with the one the server wrote in <html lang>. */
  language: Language;

  // Project & selection
  project: ProjectState | null;
  projectLoading: boolean;
  sceneId: string | null;
  format: FormatId;
  view: View;
  panel: Panel;
  /** Newest code generation announced for the open project (frames reload up to it). */
  generation: number;

  // Playback
  mode: PreviewMode;
  /** Playhead: scene-local in scene mode, video time in whole-video mode. */
  time: number;
  playing: boolean;
  scrubbing: boolean;
  loop: boolean;
  muted: boolean;
  /** Music volume while its slider moves: the playing track follows it, the project saves it on release. */
  volumeDraft: number | null;
  /** Bumped on user seeks so the audio clock re-syncs during playback. */
  seekNonce: number;
  safeArea: boolean;
  frameErrors: string[];
  /** Bumped to remount frames (server restarted: generations start over). */
  frameEpoch: number;
  /** Bumped to make frames re-fetch the project (code or project changed). */
  frameReload: number;
  /** Bumped to refetch thumbnails. */
  thumbEpoch: number;

  // Project data
  chats: Partial<Record<ChatKey, ChatState>>;
  /** Unsent composer text by `<projectId>/<chatKey>` (kept in sessionStorage across reloads). */
  drafts: Record<string, string>;
  /** Text to put in a composer (suggestions, "ask Claude to fix"). */
  fill: { key: ChatKey; text: string; nonce: number } | null;
  /** Model/effort picked in the composers this session; the settings are the defaults. */
  picks: Partial<Record<ChatKind, { model: string; effort: Effort }>>;
  seams: SeamResult[];
  seamsChecking: boolean;
  renders: { jobs: RenderJob[]; files: RenderFile[] };
  publishing: Publications;
  music: { status: MusicStatus; error: string | null };
  /** Piper's latest run on the open project. */
  voiceOver: { status: VoiceOverStatus };
  versionsTick: number;
  assetsTick: number;
  cost: number | null;
  /** Version to highlight in the Versions panel. */
  focusVersion: string | null;
  /** Unsaved art direction per project. */
  artDrafts: Record<string, string>;

  // UI
  modal: Modal | null;
  presenting: boolean;
  /** Keyboard shortcuts popover. */
  shortcuts: boolean;
  toasts: Toast[];
  /** Scene whose name is being edited in the filmstrip. */
  renaming: string | null;
  /** Finished brand builds their window has shown: the top bar no longer lists them. */
  seenBuilds: string[];
  /** The Profile page (#/@profil) in place of the home. */
  profile: boolean;
}

/** localStorage can throw (private mode, blocked site data): conveniences only. */
export const memory = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`cadence:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`cadence:${key}`, value);
    } catch {
      // not remembered, that's all
    }
  },
};

export const useStore = create<EditorState>()(() => ({
  app: null,
  appError: null,
  connected: false,
  stale: false,
  language: document.documentElement.lang === 'en' ? 'en' : 'fr',
  project: null,
  projectLoading: false,
  sceneId: null,
  format: '16:9',
  view: 'scenes',
  panel: 'scene',
  generation: 0,
  mode: 'scene',
  time: 0,
  playing: false,
  scrubbing: false,
  loop: true,
  muted: false,
  volumeDraft: null,
  seekNonce: 0,
  safeArea: false,
  frameErrors: [],
  frameEpoch: 0,
  frameReload: 0,
  thumbEpoch: 0,
  chats: {},
  drafts: {},
  fill: null,
  picks: {},
  seams: [],
  seamsChecking: false,
  renders: { jobs: [], files: [] },
  publishing: { jobs: [], publications: [] },
  music: { status: 'idle', error: null },
  voiceOver: { status: 'idle' },
  versionsTick: 0,
  assetsTick: 0,
  cost: null,
  focusVersion: null,
  artDrafts: {},
  modal: null,
  presenting: false,
  shortcuts: false,
  toasts: [],
  renaming: null,
  seenBuilds: memory.get('seen-builds')?.split(' ') ?? [],
  profile: false,
}));

/** Stable empty list for selectors (a fresh `[]` per call would re-render forever). */
export const NONE: never[] = [];

export const get = useStore.getState;
export const set = useStore.setState;

// Derived

export function currentScene(s: EditorState = get()): SceneState | null {
  return s.project?.scenes.find((x) => x.id === s.sceneId) ?? s.project?.scenes[0] ?? null;
}

/** Length of what the preview shows. */
export function previewDuration(s: EditorState = get()): number {
  return s.mode === 'whole' ? (s.project?.duration ?? 0) : (currentScene(s)?.duration ?? 0);
}

/** Scene playing at video time t (a frame exactly on a cut belongs to the next scene, like the frame page). */
export function sceneAt(project: ProjectState, t: number): SceneState | null {
  for (const scene of project.scenes) if (t < scene.start + scene.duration - 1e-9) return scene;
  return project.scenes.at(-1) ?? null;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
