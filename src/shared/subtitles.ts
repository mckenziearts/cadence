// Subtitles from the voice-over sentences: the cues of the SRT and WebVTT downloads.
import type { VoiceOverLine } from './types';

/** One subtitle shown from `start` to `end`, in video seconds. */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const ENDS_CLAUSE = /[,;:.!?\u2026]$/;
const PUNCTUATION_ONLY = /^\p{P}+$/u;
const OPENING_ONLY = /^[\p{Ps}\p{Pi}\u00bf\u00a1]+$/u;

/**
 * Cues of at most `maxChars` characters: a longer sentence splits at word boundaries into balanced chunks timed in
 * proportion to their characters, and sentences that overlap show one at a time, the latest started on screen.
 */
export function subtitleCues(
  lines: Pick<VoiceOverLine, 'text' | 'start' | 'end'>[],
  { maxChars }: { maxChars: number },
): SubtitleCue[] {
  const cues = lines
    .flatMap(({ text, start, end }) => {
      const chunks = splitText(text, maxChars);
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      let done = 0;
      return chunks.map((chunk) => {
        const from = start + ((end - start) * done) / total;
        done += chunk.length;
        return { start: roundMs(from), end: roundMs(start + ((end - start) * done) / total), text: chunk };
      });
    })
    // On a shared start the shorter cue sorts last, so it shows first and the longer one follows.
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const times = [...new Set(cues.flatMap((cue) => [cue.start, cue.end]))].sort((a, b) => a - b);
  const shown: (SubtitleCue & { source: SubtitleCue })[] = [];
  for (const [i, start] of times.slice(0, -1).entries()) {
    const end = times[i + 1];
    // The cue that started last is on screen; one it interrupted comes back once it ends.
    const source = cues.findLast((cue) => cue.start <= start && cue.end >= end);
    if (!source) continue;
    const last = shown.at(-1);
    if (last?.source === source && last.end === start) last.end = end;
    else shown.push({ start, end, text: source.text, source });
  }
  return shown.map(({ start, end, text }) => ({ start, end, text }));
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: SubtitleCue[]): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return ['WEBVTT\n', ...cues.map((c) => `${timestamp(c.start, '.')} --> ${timestamp(c.end, '.')}\n${escape(c.text)}\n`)].join(
    '\n',
  );
}

/** The fewest chunks that fit, as even as possible, preferring to end a chunk after punctuation. */
function splitText(text: string, maxChars: number): string[] {
  const words: string[] = [];
  let opening = '';
  // French puts a non-breaking space inside `« »` and before `!`, `?`, `:`: it joins its neighbours into one word,
  // and stays in the cue.
  for (const word of text.split(/[^\S\u00a0\u202f]+/).filter(Boolean)) {
    // French spaces off `«` and `»`, `!`, `?`, `:`: an opening mark stays with the word after it, never ending a cue,
    // and the others with the word before, never opening one.
    if (OPENING_ONLY.test(word)) opening += `${word} `;
    else if (!opening && words.length && PUNCTUATION_ONLY.test(word)) words.push(`${words.pop()} ${word}`);
    else {
      words.push(opening + word);
      opening = '';
    }
  }
  if (opening) words.push(words.length ? `${words.pop()} ${opening.trimEnd()}` : opening.trimEnd());
  const tokens = words.flatMap((word) => (word.length > maxChars ? cutWord(word, maxChars) : [word]));
  const offsets = [0];
  for (const token of tokens) offsets.push(offsets.at(-1)! + token.length);
  const width = (from: number, to: number) => offsets[to] - offsets[from] + to - from - 1;

  let count = 0;
  for (let from = 0, to = 1; to <= tokens.length; to++) {
    if (to === tokens.length || width(from, to + 1) > maxChars) {
      count++;
      from = to;
    }
  }
  if (count <= 1) return tokens.length ? [tokens.join(' ')] : [];

  const target = width(0, tokens.length) / count;
  // How far from even a chunk may get to end on punctuation: half the target either way.
  const clauseBonus = (target / 2) ** 2;
  // cost[k][j]: the best split of the first j tokens into k chunks; cut[k][j]: where its last chunk starts.
  const cost = Array.from({ length: count + 1 }, () => new Array<number>(tokens.length + 1).fill(Infinity));
  const cut = Array.from({ length: count + 1 }, () => new Array<number>(tokens.length + 1).fill(0));
  cost[0][0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let j = k; j <= tokens.length; j++) {
      const bonus = j < tokens.length && ENDS_CLAUSE.test(tokens[j - 1]) ? clauseBonus : 0;
      for (let i = j - 1; i >= k - 1 && width(i, j) <= maxChars; i--) {
        const value = cost[k - 1][i] + (width(i, j) - target) ** 2 - bonus;
        if (value < cost[k][j]) {
          cost[k][j] = value;
          cut[k][j] = i;
        }
      }
    }
  }
  const chunks: string[] = [];
  for (let k = count, j = tokens.length; k > 0; j = cut[k][j], k--) chunks.unshift(tokens.slice(cut[k][j], j).join(' '));
  return chunks;
}

/** Pieces of at most `maxChars` of a word too long for a cue, its punctuation included. */
function cutWord(word: string, maxChars: number): string[] {
  // Cuts fall between its letters: the punctuation before them stays on the first piece, the one after on the last.
  const start = /^[\p{P}\s]*/u.exec(word)![0].length;
  const end = word.search(/[\p{P}\s]*$/u);
  const pieces: string[] = [];
  let from = 0;
  while (word.length - from > maxChars) {
    const to = Math.min(from + maxChars, end - 1);
    // ponytail: punctuation wider than a cue (a maxChars of a few characters) leaves a token over maxChars, and the
    // sentence then shows as one cue; a greedy fill would fix it if cues ever get that narrow.
    if (to <= Math.max(from, start)) break;
    pieces.push(word.slice(from, to));
    from = to;
  }
  return [...pieces, word.slice(from)];
}

function timestamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
