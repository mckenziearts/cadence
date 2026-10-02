// The voice-over in the preview and in Present: its track follows the video clock, the music ducks under it as in the MP4.
import type { ProjectState, VoiceOverLine } from '../../shared/types';
import { duckGain, voiceSpans } from '../../shared/voiceOver';

/** Past this drift, the voice jumps back onto the picture (a jump is heard: keep it rare). */
const MAX_DRIFT_S = 0.08;

const spansOf = new WeakMap<VoiceOverLine[], [number, number][]>();

/** Music volume at video time `t`: `volume`, lowered to the project's music level while the voice speaks. */
export function duckedVolume(project: ProjectState, volume: number, t: number): number {
  const lines = project.voiceOverLines;
  if (!lines.length) return volume;
  let spans = spansOf.get(lines);
  if (!spans) spansOf.set(lines, (spans = voiceSpans(lines)));
  return Math.min(1, Math.max(0, volume * duckGain(spans, project.voiceOver.musicLevel, t)));
}

/** Keep the voice track at video time `t` while playing; it stops at its end, which comes before the video's. */
export function followVoice(voice: HTMLAudioElement | null, t: number): void {
  if (!voice?.src) return;
  if (Number.isFinite(voice.duration) && t >= voice.duration) {
    if (!voice.paused) voice.pause();
    return;
  }
  if (Math.abs(voice.currentTime - t) > MAX_DRIFT_S) voice.currentTime = t;
  if (voice.paused) void voice.play().catch(() => undefined);
}
