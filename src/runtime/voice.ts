// How loud the voice-over is at a scene time, for a mouth that opens with the voice.
import type { VoiceOverInfo } from './types';

const LEVELS_PER_SECOND = 25;

/**
 * 0 (silent) to 1 (the sentence's loudest moment) at `t` scene seconds: the `level` of the sentence spoken at `t`,
 * interpolated between its 25 readings a second. 0 when no sentence is spoken at `t`, or another speaker's is.
 */
export function voiceLevel(voiceOver: VoiceOverInfo, t: number, speaker?: string): number {
  const line = voiceOver.lines.find((l) => l.start <= t && t < l.end && (speaker === undefined || l.speaker === speaker));
  if (!line) return 0;
  const at = (t - line.start) * LEVELS_PER_SECOND;
  const i = Math.floor(at);
  const from = line.level[i] ?? 0;
  const to = line.level[i + 1] ?? from;
  return (from + (to - from) * (at - i)) / 255;
}
