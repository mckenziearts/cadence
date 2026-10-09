// Adapted from saeedvaziry/caleb-video-editor (MIT)
import {
  FORMATS,
  type Language,
  type Playhead,
  type ProjectState,
  type SceneState,
  type SeamResult,
  type Speaker,
} from '../../src/shared/types';
import { language } from '../i18n';

/** Everything the per-turn context needs; gathered by ChatManager. */
export interface TurnContext {
  project: ProjectState;
  /** The chat's scene, or null for the project chat. */
  scene: SceneState | null;
  text: string;
  playhead?: Playhead;
  /** Brand notes and art direction; null when this session already has them unchanged. */
  brief: { brand: string; artDirection: string } | null;
  /** The brand's language (brand.json), which the project's own setting overrides. */
  brandLanguage?: 'fr' | 'en' | null;
  /** MusicService.context() output. */
  music: string;
  /** Last known seam results (possibly stale). */
  seams: SeamResult[];
  /** Render errors of the scene at t = 0; null when unknown. */
  errors: string[] | null;
  /** Absolute paths of the reference screenshots in assets/refs/. */
  references: string[];
  dirs: { brand: string; templates: string; runtime: string };
}

const sec = (seconds: number) => seconds.toFixed(3);
const LANGUAGE_NAMES: Record<Language, string> = { fr: 'French', en: 'English' };

/** Seconds per bar: the music grid's when there is a track, else 4/4 at the project tempo. */
export function barSeconds(project: ProjectState): number {
  const grid = project.musicGrid;
  return grid ? (grid.beatsPerBar * 60) / grid.bpm : 240 / project.tempo;
}

function bars(project: ProjectState, seconds: number): string {
  return String(Math.round((seconds / barSeconds(project)) * 100) / 100);
}

function projectHeader(p: ProjectState, brandLanguage?: Language | null, interfaceLanguage?: Language): string {
  const formats = p.formats
    .map((id, i) => `${id} ${FORMATS[id].width}×${FORMATS[id].height}${i === 0 ? ' (primary)' : ''}`)
    .join(', ');
  const tempo = p.musicGrid
    ? `music at ${Math.round(p.musicGrid.bpm * 10) / 10} BPM, ${p.musicGrid.beatsPerBar} beats per bar`
    : `no music track, grid at ${p.tempo} BPM`;
  // Scenes read it as brand.language (templates pick their COPY with it).
  const onScreen = p.language ?? brandLanguage;
  return [
    `Project "${p.name}" (id ${p.id}), folder ${p.dir}`,
    `Brand: ${p.brand ?? 'cadence (neutral default)'} · formats: ${formats} · ${p.fps} fps · ${tempo}, 1 bar = ${sec(barSeconds(p))} s`,
    ...(onScreen
      ? [`On-screen language: ${LANGUAGE_NAMES[onScreen]} (${p.language ? 'project setting' : 'brand default'}).`]
      : []),
    // The language Claude answers in (guide.md, "Answering").
    ...(interfaceLanguage ? [`Interface language: ${LANGUAGE_NAMES[interfaceLanguage]}.`] : []),
    `Video: ${p.scenes.length} scene${p.scenes.length === 1 ? '' : 's'}, ${sec(p.duration)} s. Scene files: ${p.dir}/scenes/<id>.tsx`,
  ].join('\n');
}

/** Scene list with video-time starts, durations and lengths in bars. */
export function sceneTable(p: ProjectState, current?: string | null): string {
  const rows = p.scenes.map(
    (s) =>
      `| ${s.index + 1} | ${s.id}${s.id === current ? ' (this chat)' : ''} | ${s.name.replace(/\|/g, '/')} | ${sec(s.start)} | ${sec(s.duration)} | ${bars(p, s.duration)} |`,
  );
  return ['| # | id | name | start (s) | duration (s) | bars |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

/** get_project output and the head of every turn's context. */
export function projectOverview(p: ProjectState): string {
  const voiceOver = voiceOverSummary(p);
  return `${projectHeader(p)}\n\n${sceneTable(p)}${voiceOver ? `\n\n${voiceOver}` : ''}`;
}

/**
 * The project's speakers, then the voice-over of each scene (or of `only`) and when its sentences are spoken, in scene
 * seconds; '' when there is neither.
 */
export function voiceOverSummary(p: ProjectState, only?: string | null): string {
  const scenes = p.scenes.filter((s) => s.voiceOver && (!only || s.id === only));
  const speakers = p.voiceOver.speakers?.length ? [speakerLine(p.voiceOver.speakers)] : [];
  if (!scenes.length) return speakers.join('\n');
  const { engine, voice, model, speed, musicLevel } = p.voiceOver;
  const said = (speaker: string | null | undefined, text: string) => `${speaker ? `${speaker}: ` : ''}"${text}"`;
  const rows = scenes.map((s) => {
    if (p.voiceOverPending.includes(s.id)) {
      const script = s.voiceOver!.lines?.map((l) => said(l.speaker, l.text)).join(' / ') ?? said(null, s.voiceOver!.text);
      return `- ${s.id}: from ${sec(s.voiceOver!.at)} s, ${script} (not generated yet, so no timing)`;
    }
    const lines = p.voiceOverLines.filter((l) => l.sceneId === s.id);
    const spoken = lines.map((l) => `${sec(l.start - s.start)}-${sec(l.end - s.start)} ${said(l.speaker, l.text)}`).join(' / ');
    const over = (lines.at(-1)?.end ?? 0) - (s.start + s.duration);
    return `- ${s.id}: ${spoken}${over > 0.05 ? `; it runs ${sec(over)} s past the end of the scene` : ''}`;
  });
  const settings = [
    `${engine === 'elevenlabs' ? 'ElevenLabs ' : ''}voice ${voice}`,
    ...(model ? [`model ${model}`] : []),
    `speed ${speed}`,
    `music at ${Math.round(musicLevel * 100)} % while it speaks`,
  ];
  return [
    `Voice-over (${settings.join(', ')}), sentence times in scene seconds (props.voiceOver.lines):`,
    ...speakers,
    ...rows,
  ].join('\n');
}

/** Each speaker's id (what script lines name), display name and voice. */
export function speakerLine(speakers: Speaker[]): string {
  const described = speakers.map((s) => `${s.id} "${s.name}" (voice ${s.voice}${s.model ? `, model ${s.model}` : ''})`);
  return `Speakers: ${described.join(', ')}`;
}

function neighbour(s: SceneState | undefined, none: string): string {
  return s ? `${s.id} "${s.name}" (${sec(s.duration)} s)` : none;
}

function playheadLine(ph: Playhead, p: ProjectState, scene: SceneState | null): string {
  const where = (() => {
    if (ph.sceneId === null) {
      const shown = p.scenes.find((s) => ph.t >= s.start && ph.t < s.start + s.duration) ?? p.scenes.at(-1);
      return `video time ${sec(ph.t)} s${shown ? ` (scene ${shown.id} at ${sec(ph.t - shown.start)} s)` : ''}`;
    }
    if (ph.sceneId === scene?.id) return `t = ${sec(ph.t)} s of this scene`;
    return `scene ${ph.sceneId} at t = ${sec(ph.t)} s`;
  })();
  return `Playhead: the user is looking at ${where}, format ${ph.format}.`;
}

function seamLine(results: SeamResult[]): string {
  if (!results.length) return 'Seams: not checked yet.';
  const items = results.map(
    (r) => `${r.from} → ${r.to} (${r.format}) ${r.diffPercent.toFixed(2)} %${r.error ? `, error: ${r.error}` : ''}`,
  );
  return `Seams at the last check (may be stale): ${items.join(' · ')}`;
}

/** The user's text with the Cadence context in front of it. */
export function buildTurnPrompt(c: TurnContext): string {
  const { project: p, scene } = c;
  const lines = [projectHeader(p, c.brandLanguage, language()), '', sceneTable(p, scene?.id), ''];
  if (scene) {
    lines.push(
      `This chat edits scene ${scene.index + 1} "${scene.name}" (${scene.id}): ${scene.file}`,
      `It plays from ${sec(scene.start)} s to ${sec(scene.start + scene.duration)} s of the video. Previous: ${neighbour(p.scenes[scene.index - 1], 'none, it opens the video')}. Next: ${neighbour(p.scenes[scene.index + 1], 'none, it ends the video')}.`,
    );
  } else {
    lines.push('This is the project chat: the whole video is in scope.');
  }
  if (c.playhead) lines.push(playheadLine(c.playhead, p, scene));
  lines.push(`Read-only folders: brand ${c.dirs.brand}, templates ${c.dirs.templates}, runtime ${c.dirs.runtime}.`);
  if (c.references.length) lines.push(`Reference screenshots (Read them to look at them): ${c.references.join(', ')}`);
  lines.push(scene ? seamLine(c.seams.filter((r) => r.from === scene.id || r.to === scene.id)) : seamLine(c.seams));
  if (c.errors) lines.push(c.errors.length ? `Render errors at t = 0:\n${c.errors.join('\n')}` : 'Render errors at t = 0: none.');
  if (!c.brief) {
    lines.push('Brand notes and art direction: unchanged since earlier in this conversation (get_brand, art-direction.md).');
  }
  if (c.music.trim()) lines.push('', 'Music:', c.music.trim());
  const voiceOver = voiceOverSummary(p, scene?.id);
  if (voiceOver) lines.push('', voiceOver);

  const blocks = [`<cadence_context>\n${lines.join('\n')}\n</cadence_context>`];
  if (c.brief) {
    blocks.push(`<brand>\n${c.brief.brand.trim()}\n</brand>`);
    blocks.push(`<art_direction>\n${c.brief.artDirection.trim() || '(empty)'}\n</art_direction>`);
  }
  blocks.push(c.text);
  return blocks.join('\n\n');
}
