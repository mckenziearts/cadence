// The Rendu tab's rules per output: what can be transparent, the request a render sends, how a finished file shows.
import type { FormatId, OutputSupport, RenderOutput, RenderQuality, RenderRequest, SceneState } from '../../shared/types';

/** Outputs with an alpha channel, the ones the server accepts `transparent` for (server/capture/render.ts). */
const ALPHA: readonly RenderOutput[] = ['webm', 'mov', 'png', 'png-sequence'];

export const hasAlpha = (output: RenderOutput) => ALPHA.includes(output);

/** Why the ffmpeg in use cannot make `output`, or null. Before the server answers every output stays open: it checks on start. */
export function unavailable(output: RenderOutput, outputs: Record<RenderOutput, OutputSupport> | undefined): string | null {
  const support = outputs?.[output];
  return support && !support.available ? support.reason : null;
}

export interface RenderSettings {
  formats: FormatId[];
  quality: RenderQuality;
  scale: number;
  fps: number;
  supersample: boolean;
  output: RenderOutput;
  transparent: boolean;
  /** The chosen range in video seconds, null for the whole video. */
  range: { from: number; to: number } | null;
  /** Playhead in video seconds. */
  playhead: number;
}

/** A PNG image is the frame at the playhead: the server renders `range.from`, the range is one frame long to be valid. */
export function renderRequest(settings: RenderSettings): RenderRequest {
  const { playhead, output, transparent, range, ...rest } = settings;
  const span = output === 'png' ? { from: playhead, to: playhead + 1 / settings.fps } : range;
  return { ...rest, output, transparent: transparent && hasAlpha(output), ...(span ? { range: span } : {}) };
}

/**
 * The video time of a PNG image taken in the scene view. The whole video gives a scene's end to the next scene and its
 * entry transition to the previous one, so the time stays inside the frames that show this scene alone.
 */
export function stillTime(scene: Pick<SceneState, 'start' | 'duration' | 'transition'>, time: number, fps: number): number {
  return scene.start + Math.min(Math.max(time, scene.transition?.duration ?? 0), scene.duration - 1 / fps);
}

/** How a finished render shows on its card: a sequence is a folder, so it has no preview and nothing to download. */
export function fileView(output: RenderOutput): { preview: 'video' | 'image' | 'frames'; download: boolean; publish: boolean } {
  const preview = output === 'gif' || output === 'png' ? 'image' : output === 'png-sequence' ? 'frames' : 'video';
  return { preview, download: output !== 'png-sequence', publish: output === 'mp4' };
}

/** The render whose row takes the place of a deleted one: the next, else the one before, else null (the empty state). */
export function fileAfterRemoval(names: string[], removed: string): string | null {
  const left = names.filter((name) => name !== removed);
  return left[Math.min(names.indexOf(removed), left.length - 1)] ?? null;
}
