// Contract between the frame page (frame.html, served on the FRAME origin) and its hosts:
// - the editor (cross-origin iframe: postMessage only, origins checked on both sides),
// - headless capture (Playwright: window.__cadence directly).
import type { BrandKit } from './brandKit';
import type { FormatId } from './types';

export interface FrameRenderResult {
  /** Errors raised while importing or rendering what this frame shows. */
  errors: string[];
  /** Scene actually shown (whole-video mode picks one by time). */
  sceneId: string | null;
  /** Scene-local time that was rendered. */
  localTime: number;
}

export interface FrameApi {
  /** Resolves once project, brand and scene modules are loaded and the first frame rendered. */
  ready: Promise<void>;
  /** Synchronous render at time t (scene-local in scene mode, video time in whole mode). Used for playback. */
  render(t: number): FrameRenderResult;
  /** Render at t, then wait for fonts, images and two animation frames. Use before every screenshot. */
  seek(t: number): Promise<FrameRenderResult>;
  /** Re-fetch the project and re-import changed modules. Resolves when the frame is at >= generation. */
  reload(generation?: number): Promise<void>;
  /** Scene shown in scene mode; null = whole video. */
  setScene(sceneId: string | null): Promise<void>;
  setFormat(format: FormatId): Promise<void>;
  /** Length of what this frame shows, in seconds. */
  duration(): number;
  errors(): string[];
  /** Code generation currently loaded. */
  generation(): number;
}

export type EditorToFrame =
  | { source: 'cadence-editor'; type: 'render'; t: number }
  | { source: 'cadence-editor'; type: 'seek'; t: number; requestId: string }
  | { source: 'cadence-editor'; type: 'reload'; generation: number }
  | { source: 'cadence-editor'; type: 'set-scene'; sceneId: string | null }
  | { source: 'cadence-editor'; type: 'set-format'; format: FormatId };

export type FrameToEditor =
  | { source: 'cadence-frame'; type: 'ready'; generation: number }
  | { source: 'cadence-frame'; type: 'reloaded'; generation: number }
  | { source: 'cadence-frame'; type: 'errors'; errors: string[] }
  | { source: 'cadence-frame'; type: 'seeked'; requestId: string; result: FrameRenderResult };

/**
 * kit.html?view=panel|extra in the editor's brand panel: the kit is brand code, so the editor only gets its natural size
 * to scale the iframe and, from the panel view, the names and texts it lists. Kit code shares that page: the editor
 * checks every message before using it.
 */
export type KitToEditor =
  | { source: 'cadence-kit'; type: 'size'; width: number; height: number }
  | {
      source: 'cadence-kit';
      type: 'kit';
      extras: { name: string; description: string }[];
      copy: BrandKit['copy'];
      /** The theme's @font-face rules as data: the editor loads the files, never the kit's CSS. */
      fonts: KitFontFace[];
    }
  | { source: 'cadence-kit'; type: 'failed'; error: string };

export interface KitFontFace {
  family: string;
  /** Absolute URLs on the frame origin. */
  sources: { url: string; format?: string }[];
  weight?: string;
  style?: string;
  stretch?: string;
  unicodeRange?: string;
}

/** kit.html once the kit sheet is painted: what failed to render or load (empty when the kit is sound). */
export interface KitSheetResult {
  problems: string[];
  /** The brand's index.tsx and theme loaded; when not, `problems` ends with why. */
  loaded: boolean;
}

declare global {
  interface Window {
    __cadence?: FrameApi;
    __cadenceKit?: { ready: Promise<KitSheetResult> };
  }
}
