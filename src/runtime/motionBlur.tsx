// Motion blur drawn by the scene itself, so the preview and the render match.
import type { ReactNode } from 'react';
import { clamp } from './animate';

export interface MotionBlurProps {
  /** Scene time. */
  t: number;
  /** Frames per second of the video: the shutter is a share of one frame. */
  fps: number;
  /** Copies drawn, 1 to 16 (default 8). */
  samples?: number;
  /** Share of a frame the shutter stays open, 0 to 1 (default 0.5). */
  shutter?: number;
  /** Draws the content at a time: called once per sample. */
  children: (t: number) => ReactNode;
}

/**
 * Draws its children at `samples` times spread over `shutter` of a frame before `t`, stacked so the result is their
 * mean: copy k has opacity 1 / (k + 1). Each copy fills the nearest positioned ancestor.
 */
export function MotionBlur({ t, fps, samples = 8, shutter = 0.5, children }: MotionBlurProps) {
  const count = Math.round(clamp(samples, 1, 16));
  if (count === 1) return children(t);
  const step = clamp(shutter) / fps / count;
  return Array.from({ length: count }, (_, k) => (
    <div
      key={k}
      aria-hidden={k > 0 || undefined}
      // Copies are decor for the text checks: judged once, at t, and drawn over without hiding it.
      data-cadence-decor={k > 0 ? '' : undefined}
      // The opacity property rounds each composite down in Chromium (3 levels off after 8 copies); the filter does not.
      // Isolated like the filtered copies, so a zIndex or a blend mode in the content cannot leave the copy at t.
      style={{ position: 'absolute', inset: 0, isolation: 'isolate', filter: k > 0 ? `opacity(${1 / (k + 1)})` : undefined }}
    >
      {children(Math.max(0, t - k * step))}
    </div>
  ));
}
