// A video or GIF asset shown at an exact time, from the frames the server extracted: a <video> plays by the wall clock.
import { createContext, useContext, type CSSProperties } from 'react';

export interface ClipSource {
  fps: number;
  frames: number;
  /** URL of source frame `index`, from 0. */
  url(index: number): string;
}

/** @internal Provided by the frame page: the frames of an asset, or the error that says why it has none. */
export const ClipContext = createContext<((src: string) => ClipSource | Error) | null>(null);

export interface ClipProps {
  /** Path of a video or GIF in the project's `assets/` folder, like `asset()`. */
  src: string;
  /** Seconds into the clip: the scene offsets it (`time={t - 1.5}`). */
  time: number;
  /** Wraps around past the end (and before 0) instead of holding the last (first) frame. */
  loop?: boolean;
  /** CSS object-fit (default 'contain', like a video element). */
  fit?: CSSProperties['objectFit'];
  style?: CSSProperties;
}

function frameAt(time: number, fps: number, frames: number, loop: boolean): number {
  if (!Number.isFinite(time)) throw new RangeError(`<Clip> time must be a finite number of seconds, got ${time}`);
  // A millionth of a frame: 0.29 * 100 is 28.999999999999996, and 0.29 s must show frame 29.
  const index = Math.floor(time * fps + 1e-6);
  return loop ? ((index % frames) + frames) % frames : Math.min(Math.max(index, 0), frames - 1);
}

export function Clip({ src, time, loop = false, fit = 'contain', style }: ClipProps) {
  const lookup = useContext(ClipContext);
  if (!lookup) throw new Error('<Clip> must be rendered inside a Cadence scene (no ClipContext provider)');
  const file = src.replace(/^\/+/, '');
  const clip = lookup(file);
  if (clip instanceof Error) throw clip;
  return (
    <img
      src={clip.url(frameAt(time, clip.fps, clip.frames, loop))}
      alt=""
      // The frame page reports a frame of it that does not decode, naming the asset.
      data-cadence-clip={file}
      style={{ display: 'block', objectFit: fit, ...style }}
    />
  );
}
