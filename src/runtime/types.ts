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

/** The scene's voice-over: what is said, and when each sentence is spoken. */
export interface VoiceOverInfo {
  /** '' when the scene has no voice-over. */
  text: string;
  /** Each sentence in scene seconds; empty until Cadence has generated the voice. */
  lines: {
    text: string;
    start: number;
    end: number;
    /** The project speaker who says it; null when the scene's voice-over is plain text (the project's voice). */
    speaker: string | null;
    /** Each word heard, in scene seconds. */
    words: { text: string; start: number; end: number }[];
    /** How loud the voice is, 0-255, 25 values per second from `start`: read it with `voiceLevel`. */
    level: number[];
    /** The `gesture` of its script line, free text for the scene's code. */
    gesture?: string;
  }[];
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
  voiceOver: VoiceOverInfo;
  scene: SceneInfo;
  brand: BrandKit;
}

export interface Point {
  x: number;
  y: number;
}
