// The voice-over in the preview and in Present: its track follows the video clock, the music ducks under it as in the MP4.
import type {
  ProjectState,
  SceneVoiceOver,
  SceneVoiceOverInput,
  ScriptLine,
  ScriptLineInput,
  Speaker,
  VoiceOverLine,
} from '../../shared/types';
import { duckGain, voiceSpans } from '../../shared/voiceOver';

/** Past this drift, the voice jumps back onto the picture (a jump is heard: keep it rare). */
const MAX_DRIFT_S = 0.08;

/** A color per new speaker: the captions show who speaks by it. */
const SPEAKER_COLORS = [
  '#e4572e',
  '#2e86ab',
  '#f2a541',
  '#3bb273',
  '#7768ae',
  '#e15a97',
  '#4d9de0',
  '#c17c74',
  '#1b998b',
  '#5d576b',
];

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

/**
 * A scene's voice-over once a text, a start or its lines are edited in Voix: `undefined` when nothing changes, `null` to
 * remove it (an empty text, or no line left). A text draft never replaces saved lines: lines replaced the text while it
 * was typed, and a new start keeps them.
 */
export function voiceOverUpdate(
  saved: SceneVoiceOver | undefined,
  edit: { text: string } | { at: number } | { lines: ScriptLineInput[] },
): SceneVoiceOverInput | null | undefined {
  const at = 'at' in edit ? edit.at : (saved?.at ?? 0);
  if ('lines' in edit) {
    if (!edit.lines.length) return saved ? null : undefined;
    return JSON.stringify(edit.lines) === JSON.stringify(saved?.lines) ? undefined : { lines: edit.lines, at };
  }
  if (saved?.lines) return 'at' in edit && at !== saved.at ? { lines: saved.lines, at } : undefined;
  const text = 'text' in edit ? edit.text.trim() : (saved?.text ?? '');
  if (text === (saved?.text ?? '') && at === (saved?.at ?? 0)) return undefined;
  return text ? { text, at } : saved ? null : undefined;
}

/**
 * `change` applied to the line `id` names, found in `lines` rather than by its place on screen: a second click that lands
 * before the first change is saved acts on the same line, or on nothing once it is gone.
 */
export function editLine(
  lines: ScriptLine[],
  id: string,
  change: (lines: ScriptLine[], i: number) => ScriptLine[],
): ScriptLine[] {
  const i = lines.findIndex((line) => line.id === id);
  return i < 0 ? lines : change(lines, i);
}

/** The line `id` names one place up (-1) or down (1); the first and last lines go no further. */
export const moveLine = (lines: ScriptLine[], id: string, by: -1 | 1): ScriptLine[] =>
  editLine(lines, id, (list, i) => {
    if (!list[i + by]) return list;
    const next = [...list];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    return next;
  });

/** Who says a new line: the speaker after the last line's, the first one to start (or after a speaker gone). */
export function nextLineSpeaker(speakers: Pick<Speaker, 'id'>[], lines: Pick<ScriptLine, 'speaker'>[]): string {
  const last = speakers.findIndex((s) => s.id === lines.at(-1)?.speaker);
  return speakers[(last + 1) % speakers.length].id;
}

/** Each script line's start and end in video seconds, from its sentences; null for a line nothing was spoken of. */
export function lineTimes(
  sentences: Pick<VoiceOverLine, 'line' | 'start' | 'end'>[],
  count: number,
): ({ start: number; end: number } | null)[] {
  const times: ({ start: number; end: number } | null)[] = Array.from({ length: count }, () => null);
  for (const { line, start, end } of sentences) {
    if (line === undefined || line >= count) continue;
    times[line] = { start: times[line]?.start ?? start, end };
  }
  return times;
}

/** Every speaker on `voice` with the project's model: the server checks a speaker's voice against the project's engine. */
export const onVoice = (speakers: Speaker[], voice: string): Speaker[] =>
  speakers.map(({ id, name, color }) => ({ id, name, voice, color }));

/** The speaker Voix adds: the lowest free `speaker-n` id and the first color no one has (none once all are taken). */
export function nextSpeaker(speakers: Speaker[], voice: string, name: (n: number) => string): Speaker {
  let n = 1;
  while (speakers.some((s) => s.id === `speaker-${n}`)) n++;
  const color = SPEAKER_COLORS.find((c) => !speakers.some((s) => s.color === c));
  return { id: `speaker-${n}`, name: name(n), voice, color };
}
