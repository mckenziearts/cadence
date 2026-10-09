// When the music steps down under a voice-over: the same spans and ramps in the editor's preview and in the MP4. And the
// Piper voice of each language, for the server's defaults and the editor's switch back to Piper.
import type { VoiceOverLine } from './types';

export const PIPER_DEFAULT_VOICE = { fr: 'fr_FR-siwis-medium', en: 'en_US-joe-medium' } as const;

/** The music slides down this long before a sentence, and back up as long after it. */
export const DUCK_RAMP_S = 0.25;

/** The spans where the voice speaks, `from` seconds in: back-to-back sentences make one span, so the music stays down. */
export function voiceSpans(lines: Pick<VoiceOverLine, 'start' | 'end'>[], from = 0): [number, number][] {
  const spans: [number, number][] = [];
  for (const { start, end } of [...lines].sort((a, b) => a.start - b.start)) {
    const last = spans.at(-1);
    if (last && start - from <= last[1] + 2 * DUCK_RAMP_S) last[1] = Math.max(last[1], end - from);
    else spans.push([start - from, end - from]);
  }
  return spans.filter(([, end]) => end > -DUCK_RAMP_S);
}

/** Music gain at `t` (the spans' clock): `level` inside a span, 1 away from them, with linear ramps of DUCK_RAMP_S. */
export function duckGain(spans: [number, number][], level: number, t: number): number {
  let depth = 0;
  for (const [start, end] of spans) {
    const ramp = Math.min((t - (start - DUCK_RAMP_S)) / DUCK_RAMP_S, (end + DUCK_RAMP_S - t) / DUCK_RAMP_S);
    depth = Math.max(depth, Math.min(1, Math.max(0, ramp)));
  }
  return 1 - (1 - level) * depth;
}
