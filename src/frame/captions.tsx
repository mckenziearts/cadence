// Burned-in captions: the subtitle cue of the video time, over the scene at the bottom of the safe area. The same layer
// draws them in the preview, the agent's frames and the MP4.
import { useMemo } from 'react';
import { subtitleCues, type SubtitleCue } from '../shared/subtitles';
import { SAFE_AREAS, type FormatSpec, type Speaker, type VoiceOverLine } from '../shared/types';

// ponytail: sized for glyphs near 0.52 em wide (Inter, Geist): a cue fits on two lines even with a long word. A much
// wider brand body font could wrap one onto a third line; measure the text if a brand ever needs it.
const LAYOUT: Record<FormatSpec['orientation'], { fontSize: number; maxChars: number }> = {
  landscape: { fontSize: 44, maxChars: 84 },
  square: { fontSize: 48, maxChars: 48 },
  portrait: { fontSize: 52, maxChars: 42 },
};

export function Captions({
  lines,
  speakers = [],
  spec,
  t,
}: {
  lines: VoiceOverLine[];
  speakers?: Speaker[];
  spec: FormatSpec;
  t: number;
}) {
  const { fontSize, maxChars } = LAYOUT[spec.orientation];
  // `lines` only changes with a project load: the cues are not worked out again on every frame.
  const cues = useMemo(() => subtitleCues(lines, { maxChars }), [lines, maxChars]);
  const cue = cueAt(cues, t);
  if (!cue) return null;
  const safe = SAFE_AREAS[spec.id];
  const said = wordSaid(lines, speakers, cue.text, t);
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
        {said ? (
          <>
            {cue.text.slice(0, said.from)}
            <span style={{ color: said.color }}>{cue.text.slice(said.from, said.to)}</span>
            {cue.text.slice(said.to)}
          </>
        ) : (
          cue.text
        )}
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

/** Where the word said at `t` sits in the cue, with its speaker's color; null when no speaker with a color says one. */
function wordSaid(
  lines: VoiceOverLine[],
  speakers: Speaker[],
  cue: string,
  t: number,
): { from: number; to: number; color: string } | null {
  // The sentence that started last, like the cue on screen.
  const line = lines.findLast((l) => l.start <= t && t < l.end);
  if (!line) return null;
  const color = speakers.find((s) => s.id === line.speaker)?.color;
  // The last word started: a word stays said through the pause before the next one. French spaces off `?`, `!`, `:` and
  // `« »`, which then come as words of their own: punctuation alone is not said, the word before it stays colored.
  const said = line.words.findLastIndex((w) => w.start <= t && !/^\p{P}+$/u.test(w.text));
  if (!color || said < 0) return null;
  // Words are the sentence's text split on whitespace, in order: each one is found after the one before.
  let from = -1;
  let to = 0;
  for (const word of line.words.slice(0, said + 1)) {
    from = line.text.indexOf(word.text, to);
    if (from < 0) return null;
    to = from + word.text.length;
  }
  // A cue can repeat an earlier one of its sentence: the one on screen is the last that starts at or before the word.
  const offset = line.text.lastIndexOf(cue, from);
  if (offset < 0 || from < offset || to > offset + cue.length) return null;
  return { from: from - offset, to: to - offset, color };
}
