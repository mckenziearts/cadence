// Scene-level building blocks: contexts the frame provides, format helpers, assets.
// Fill, SceneContext/useScene and asset are adapted from saeedvaziry/caleb-video-editor (MIT).
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import type { BrandKit } from '../shared/brandKit';
import { SAFE_AREAS, type FormatId, type Orientation, type SafeArea } from '../shared/types';
import type { SceneProps } from './types';

export const SceneContext = createContext<SceneProps | null>(null);

/** Scene props from anywhere inside a scene (for nested components). */
export function useScene(): SceneProps {
  const value = useContext(SceneContext);
  if (!value) throw new Error('useScene() must be called inside a Cadence scene (no SceneContext provider)');
  return value;
}

export const BrandContext = createContext<BrandKit | null>(null);

/** The project's brand kit (colors, fonts, radius, Logo, ui components, extras, copy). */
export function useBrand(): BrandKit {
  const brand = useContext(BrandContext);
  const scene = useContext(SceneContext);
  const value = brand ?? scene?.brand;
  if (!value) throw new Error('useBrand() must be called inside a Cadence scene or a BrandContext provider');
  return value;
}

/** Values per orientation; `square` falls back to `portrait`; an exact format key ('4:5') wins over its orientation. */
export type FormatValues<T> = { landscape: T; portrait: T; square?: T } & Partial<Record<FormatId, T>>;

export interface FormatInfo {
  format: FormatId;
  width: number;
  height: number;
  orientation: Orientation;
  isPortrait: boolean;
  isLandscape: boolean;
  isSquare: boolean;
  pick<T>(values: FormatValues<T>): T;
  /** Margins (canvas px) kept clear of social-app UI (captions, buttons, progress bars). */
  safe: SafeArea;
}

/** Current format and helpers to lay out one scene for 16:9, 9:16, 1:1 and 4:5. */
export function useFormat(): FormatInfo {
  const { format, width, height, orientation } = useScene();
  return {
    format,
    width,
    height,
    orientation,
    isPortrait: orientation === 'portrait',
    isLandscape: orientation === 'landscape',
    isSquare: orientation === 'square',
    pick<T>(values: FormatValues<T>): T {
      if (Object.hasOwn(values, format)) return values[format] as T;
      if (orientation === 'landscape') return values.landscape;
      return orientation === 'square' && values.square !== undefined ? values.square : values.portrait;
    },
    safe: SAFE_AREAS[format] ?? SAFE_AREAS['16:9'],
  };
}

/** Canvas size for kit components; 1920 × 1080 outside a scene (tests, brand previews). */
export function useCanvas(): { width: number; height: number } {
  const scene = useContext(SceneContext);
  return { width: scene?.width ?? 1920, height: scene?.height ?? 1080 };
}

export interface KitTheme {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  background: string;
  accent: string;
  font: string;
  mono: string;
}

/** Defaults for kit components: the brand's tokens when there is one, neutral values otherwise. */
export function useKitTheme(): KitTheme {
  const brand = useContext(BrandContext);
  const scene = useContext(SceneContext);
  const b = brand ?? scene?.brand;
  return {
    ink: b?.colors.ink ?? '#0a0a0a',
    muted: b?.colors.muted ?? '#71717a',
    line: b?.colors.line ?? '#e4e4e7',
    surface: b?.colors.surface ?? '#ffffff',
    background: b?.colors.background ?? '#fafafa',
    accent: b?.colors.accent ?? '#ff2e88',
    font: b?.fonts.body ?? 'system-ui, sans-serif',
    mono: b?.fonts.mono ?? 'ui-monospace, monospace',
  };
}

/** Absolutely positioned layer covering the whole canvas. */
export function Fill(props: { children?: ReactNode; style?: CSSProperties; className?: string; center?: boolean }) {
  return (
    <div
      className={props.className}
      style={{
        position: 'absolute',
        inset: 0,
        ...(props.center ? { display: 'flex', alignItems: 'center', justifyContent: 'center' } : null),
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

// The only module-level state of the runtime: set by the frame when it loads a project.
let assetBase = '';

/** @internal Set by the frame page: URL prefix of the project's `assets/` folder. */
export function setAssetBase(base: string) {
  assetBase = base === '' || base.endsWith('/') ? base : `${base}/`;
}

/** URL of a file in this project's `assets/` folder: <img src={asset('screens/home.png')} /> */
export function asset(path: string): string {
  return assetBase + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}
