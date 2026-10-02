// Music grid marks for the scrubber and scene lengths in bars, computed with the runtime's own createMusic so the
// editor shows exactly the grid scenes animate on (no track: steady project tempo restarting at every scene).
import { createMusic, type Music } from '../../runtime/music';
import type { ProjectState, SceneState } from '../../shared/types';

export function sceneMusic(project: ProjectState, scene: SceneState): Music {
  return createMusic({
    grid: project.musicGrid,
    tempo: project.tempo,
    musicStart: project.music?.start ?? 0,
    sceneStart: scene.start,
    sceneDuration: scene.duration,
  });
}

/** Length of a scene in bars of the grid it plays on. */
export function sceneBars(project: ProjectState, scene: SceneState): number {
  const music = sceneMusic(project, scene);
  return music.barLength > 0 ? scene.duration / music.barLength : 0;
}

/**
 * Seconds between the scene's end (its cut) and the nearest bar line of its grid, negative when the cut comes first;
 * null when the cut is on the bar line (within 2 % of a bar). Without a track it is |bars − round(bars)| > 0.02; with
 * one it checks the real cut, so a first scene that also holds the lead-in before bar 1 is not flagged.
 */
export function barDrift(project: ProjectState, scene: SceneState): number | null {
  const music = sceneMusic(project, scene);
  const drift = scene.duration - music.snap(scene.duration, 'bar');
  return Math.abs(drift) > 0.02 * music.barLength ? drift : null;
}

export interface TimelineMarks {
  beats: number[];
  bars: number[];
  phrases: number[];
  /** Scene starts after the first one (whole-video mode only). */
  cuts: { t: number; scene: SceneState }[];
}

/** Marks in preview time: scene-local for one scene, video time for the whole video. Each point keeps its strongest kind. */
export function timelineMarks(project: ProjectState, scene: SceneState | null): TimelineMarks {
  const phrases = new Map<number, number>();
  const bars = new Map<number, number>();
  const beats = new Map<number, number>();
  const cuts: TimelineMarks['cuts'] = [];
  const key = (t: number) => Math.round(t * 1000);
  for (const s of scene ? [scene] : project.scenes) {
    const music = sceneMusic(project, s);
    const offset = scene ? 0 : s.start;
    for (const t of music.phrases) phrases.set(key(t + offset), t + offset);
    for (const t of music.downbeats) if (!phrases.has(key(t + offset))) bars.set(key(t + offset), t + offset);
    for (const t of music.beats) {
      const k = key(t + offset);
      if (!phrases.has(k) && !bars.has(k)) beats.set(k, t + offset);
    }
    if (!scene && s.index > 0) cuts.push({ t: s.start, scene: s });
  }
  const sorted = (m: Map<number, number>) => [...m.values()].sort((a, b) => a - b);
  return { beats: sorted(beats), bars: sorted(bars), phrases: sorted(phrases), cuts };
}

/** Margins kept clear of social-app UI, in canvas px: the same table scenes read through useFormat().safe. */
export { SAFE_AREAS } from '../../shared/types';

/** Start of the frame showing at `t`: the preview draws whole frames, at the times the export renders (i / fps). */
export function frameStart(t: number, fps: number): number {
  // A thousandth of a frame absorbs float error (1.16 * 25 is 28.999999999999996) and stepFrame's rounding to the µs.
  return Math.floor(t * fps + 1e-3) / fps;
}

/**
 * Playback time at a display tick, `elapsed` seconds after the last one. The display paces the frames; the track being
 * heard pulls the time back once the two differ by more than a frame. Followed at every tick, the audio clock's few ms
 * of jitter would repeat and skip frames whenever the project's fps matches the screen's.
 */
export function playbackTime(clock: number, elapsed: number, heard: number | null, fps: number): number {
  const time = clock + elapsed;
  return heard !== null && Math.abs(heard - time) > 1 / fps ? heard : time;
}

/** Time-label spacing for a ruler `width` px wide showing `duration` seconds (labels at least ~64 px apart). */
export function rulerStep(duration: number, width: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => (width / Math.max(duration, 0.001)) * step >= 64) ?? 600;
}
