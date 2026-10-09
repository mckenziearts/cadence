import { voiceLevel, type VoiceOverInfo } from 'cadence';

/** A black bar centered on `x`: 20 px tall when the speaker is silent, 420 px at their loudest. */
export function Mouth({ voiceOver, t, speaker, x }: { voiceOver: VoiceOverInfo; t: number; speaker: string; x: number }) {
  const height = 20 + 400 * voiceLevel(voiceOver, t, speaker);
  return (
    <div style={{ position: 'absolute', left: x - 150, top: 540 - height / 2, width: 300, height, background: '#000000' }} />
  );
}
