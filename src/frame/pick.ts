// Which scenes the frame draws at a time: one, or two during the transition into a scene.
import type { SceneState } from '../shared/types';
import { tidy } from './voiceOver';

/** Absorbs float sums like 0.5 + 0.6: a time this close before a scene's start already belongs to it. */
const EPSILON = 1e-9;

export interface Picked {
  scene: SceneState;
  local: number;
  /** During the transition into `scene`: the scene before it at its own time, and the cut's progress from 0 to 1. */
  outgoing?: { scene: SceneState; local: number; progress: number };
}

/** `sceneId` set: that scene alone, without its transition, at a time clamped to it. */
export function pickScene(scenes: SceneState[], t: number, sceneId: string | null): Picked | null {
  if (sceneId) {
    const scene = scenes.find((s) => s.id === sceneId);
    return scene ? { scene, local: tidy(Math.min(Math.max(0, t), scene.duration)) } : null;
  }
  // The last scene started at t: a frame exactly on a cut, or at the end of an overlap, belongs to the next scene.
  let i = 0;
  while (i + 1 < scenes.length && t >= scenes[i + 1].start - EPSILON) i++;
  const scene = scenes[i];
  if (!scene) return null;
  const elapsed = t - scene.start;
  const picked: Picked = { scene, local: tidy(Math.min(Math.max(0, elapsed), scene.duration)) };
  const cut = scene.transition;
  // i > 0: an optimistic reorder in the editor can put a scene that keeps its transition first.
  if (cut && i > 0 && elapsed < cut.duration - EPSILON) {
    const previous = scenes[i - 1];
    picked.outgoing = { scene: previous, local: tidy(t - previous.start), progress: tidy(Math.max(0, elapsed) / cut.duration) };
  }
  return picked;
}
