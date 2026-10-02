import type { BrandKit } from '../shared/brandKit';
import type { FormatId, Orientation } from '../shared/types';
import type { Music } from './music';

export type { BrandKit, FormatId, Orientation };

export interface SceneInfo {
  id: string;
  name: string;
  /** 0-based position in the video. */
  index: number;
  count: number;
  /** Start time of this scene in the whole video (seconds). */
  start: number;
}

/** Props every scene component receives. Render purely from these: no state, effects or timers. */
export interface SceneProps {
  /** Seconds since this scene started: 0 to duration. */
  t: number;
  /** Length of this scene in seconds. */
  duration: number;
  /** Canvas size in CSS pixels (e.g. 1920 × 1080 for 16:9). */
  width: number;
  height: number;
  format: FormatId;
  orientation: Orientation;
  fps: number;
  music: Music;
  scene: SceneInfo;
  brand: BrandKit;
}

export interface Point {
  x: number;
  y: number;
}
