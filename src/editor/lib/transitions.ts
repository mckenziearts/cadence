// The filmstrip's cut control: what each pick sends, and when the scenes play less of a transition than declared.
import type { SceneState, SceneTransition, TransitionDirection, TransitionKind } from '../../shared/types';

// The server's bounds (server/store/projects.ts): a duration outside them is refused, so the field clamps first.
const MIN_DURATION = 0.1;
const MAX_DURATION = 5;
const FIRST_DURATION = 0.5;

/**
 * The transition after one pick: `kind: null` is a hard cut. A new kind keeps the duration and the direction; a fade
 * has no direction, the other kinds start to the left. Without a transition, only a kind starts one.
 */
export function editTransition(
  current: SceneTransition | undefined,
  pick: { kind?: TransitionKind | null; direction?: TransitionDirection; duration?: number },
): SceneTransition | null {
  if (pick.kind === null) return null;
  const kind = pick.kind ?? current?.kind;
  if (!kind) return null;
  let duration = current?.duration ?? FIRST_DURATION;
  if (pick.duration !== undefined && Number.isFinite(pick.duration))
    duration = Math.round(Math.min(MAX_DURATION, Math.max(MIN_DURATION, pick.duration)) * 1000) / 1000;
  if (kind === 'fade') return { kind, duration };
  return { kind, direction: pick.direction ?? current?.direction ?? 'left', duration };
}

/** The declared and played durations when the scenes are too short for the declared one, else null. */
export function clampedTransition(
  scene: Pick<SceneState, 'transition' | 'declaredTransition'>,
): { declared: number; played: number } | null {
  const declared = scene.declaredTransition?.duration;
  const played = scene.transition?.duration;
  return declared !== undefined && played !== undefined && played < declared ? { declared, played } : null;
}
