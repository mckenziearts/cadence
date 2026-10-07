// Burned-in captions: the subtitle cue of the video time, over the scene at the bottom of the safe area. The same layer
// draws them in the preview, the agent's frames and the MP4.
import { useMemo } from 'react';
import { subtitleCues, type SubtitleCue } from '../shared/subtitles';
import { SAFE_AREAS, type FormatSpec, type VoiceOverLine } from '../shared/types';

// ponytail: sized for glyphs near 0.52 em wide (Inter, Geist): a cue fits on two lines even with a long word. A much
// wider brand body font could wrap one onto a third line; measure the text if a brand ever needs it.
const LAYOUT: Record<FormatSpec['orientation'], { fontSize: number; maxChars: number }> = {
  landscape: { fontSize: 44, maxChars: 84 },
  square: { fontSize: 48, maxChars: 48 },
  portrait: { fontSize: 52, maxChars: 42 },
};

export function Captions({ lines, spec, t }: { lines: VoiceOverLine[]; spec: FormatSpec; t: number }) {
  const { fontSize, maxChars } = LAYOUT[spec.orientation];
  // `lines` only changes with a project load: the cues are not worked out again on every frame.
  const cues = useMemo(() => subtitleCues(lines, { maxChars }), [lines, maxChars]);
  const cue = cueAt(cues, t);
  if (!cue) return null;
  const safe = SAFE_AREAS[spec.id];
  return (
    <div
      data-cadence-captions=""
      style={{
        position: 'absolute',
        left: safe.left,
        right: safe.right,
        bottom: safe.bottom,
        zIndex: 2147483647,
        pointerEvents: 'none',
        color: '#ffffff',
        fontSize,
        fontWeight: 600,
        lineHeight: 1.45,
        textAlign: 'center',
        textWrap: 'balance',
        // A word as long as a cue (a URL, a hashtag) is wider than the safe area: it breaks between its letters. Chromium
        // then leaves out the end padding the line's box clones, which the inset keeps inside the safe area.
        overflowWrap: 'anywhere',
        paddingInline: '0.4em',
      }}
    >
      {/* A box per line: one box around wrapped text would span the whole safe area. The line height leaves a thin
          gap between the boxes, where overlapping ones would draw a darker stripe. */}
      <span
        style={{
          padding: '0.08em 0.4em',
          borderRadius: '0.25em',
          background: 'rgba(0, 0, 0, 0.72)',
          WebkitBoxDecorationBreak: 'clone',
          boxDecorationBreak: 'clone',
        }}
      >
        {cue.text}
      </span>
    </div>
  );
}

/** The cue on screen at `t`: cues are sorted by start and never overlap. */
function cueAt(cues: SubtitleCue[], t: number): SubtitleCue | null {
  let after = 0;
  for (let end = cues.length; after < end;) {
    const mid = (after + end) >> 1;
    if (cues[mid].start <= t) after = mid + 1;
    else end = mid;
  }
  const cue = cues[after - 1];
  return cue && t < cue.end ? cue : null;
}
