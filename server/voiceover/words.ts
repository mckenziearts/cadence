// When each word of a spoken sentence is said, for captions that follow the voice. Pure: no fs, no clock.

/** A word of a sentence, in seconds from the start of the sentence's audio. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** Character timings of a spoken sentence, one entry per character of the text sent to the engine. */
export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** An audio tag like `[surprised]`, with the spaces before it, so removing it leaves one space between two words. */
const AUDIO_TAG = /\s*\[[^[\]]*\]/g;

/** The text as heard: audio tags and the spaces they leave removed. */
export function stripAudioTags(text: string): string {
  return spoken(text)
    .map((i) => (i === BREAK ? ' ' : text[i]))
    .join('')
    .trim();
}

/** Words split on whitespace, timed by the engine's characters; tags are timed but give no word. */
export function wordsFromAlignment(text: string, alignment: Alignment): Word[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  // Times per UTF-16 unit of `text`: a character outside the basic plane is one entry of the alignment, two units here.
  const unitStarts: number[] = [];
  const unitEnds: number[] = [];
  characters.forEach((character, i) => {
    for (let unit = 0; unit < character.length; unit++) {
      unitStarts.push(starts[i]);
      unitEnds.push(ends[i]);
    }
  });
  if (characters.join('') !== text || starts.length !== characters.length || ends.length !== characters.length) {
    return wordsByProrata(text, ends.length ? Math.max(...ends) : 0);
  }
  return group(
    spoken(text).map((i) =>
      i === BREAK ? { char: ' ', start: 0, end: 0 } : { char: text[i], start: unitStarts[i], end: unitEnds[i] },
    ),
  );
}

/** Words split on whitespace, tags removed, each character of the text heard taking an equal share of `seconds`. */
export function wordsByProrata(text: string, seconds: number): Word[] {
  const heard = stripAudioTags(text);
  return group(
    [...heard].map((char, i, all) => ({ char, start: (i * seconds) / all.length, end: ((i + 1) * seconds) / all.length })),
  );
}

/** Stands for the space a tag leaves when a word follows it with no space (`Oui [laughs]bien`). */
const BREAK = -1;

/** Indexes of the characters of `text` left once its audio tags are removed, with a BREAK where a tag split two words. */
function spoken(text: string): number[] {
  const kept: number[] = [];
  let from = 0;
  for (const tag of text.matchAll(AUDIO_TAG)) {
    for (let i = from; i < tag.index; i++) kept.push(i);
    from = tag.index + tag[0].length;
    // Closing punctuation right after a tag stays on the word before it (`Bon [laughs], ok` reads `Bon, ok`),
    // anything else starts the next word: `dit [whispers]«non»`, and straight quotes, `¡` or `¿`, which open more often.
    const next = text[from];
    if (next && !/[\s\p{Pe}\p{Pf},.;:!?\u2026]/u.test(next)) kept.push(BREAK);
  }
  for (let i = from; i < text.length; i++) kept.push(i);
  return kept;
}

function group(characters: { char: string; start: number; end: number }[]): Word[] {
  const words: Word[] = [];
  let word: Word | null = null;
  for (const { char, start, end } of characters) {
    if (/\s/.test(char)) word = null;
    else if (word) {
      word.text += char;
      word.end = end;
    } else {
      word = { text: char, start, end };
      words.push(word);
    }
  }
  return words;
}
