// Voice-over: the engine (Piper on this machine, or ElevenLabs with the person's key or a host app's), the voice, speed
// and music level, the speakers of a dialogue, then each scene's text and timing.
import clsx from 'clsx';
import { AlertTriangle, AudioLines, Copy, Download, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SceneState, ScriptLine, ScriptLineInput, Speaker, VoiceOverSettings, VoicesState } from '../../shared/types';
import { PIPER_DEFAULT_VOICE } from '../../shared/voiceOver';
import { ApiError, api, ignore } from '../api';
import { ScriptLines } from '../components/voiceLines';
import { ElevenLabsVoiceSelect, PIPER_INSTALL, Row, useElevenLabsCatalog, type ElevenLabsCatalog } from '../components/voiceOver';
import {
  Button,
  Checkbox,
  IconButton,
  SectionTitle,
  Segmented,
  Slider,
  Spinner,
  fieldBase,
  inputClass,
  useFocusAfter,
} from '../components/ui';
import { useT } from '../i18n';
import { bytes, parseDecimal, percentShort, secs, secsLabel } from '../lib/format';
import { lineTimes, nextSpeaker, onVoice, voiceOverUpdate } from '../lib/voiceOver';
import { useStore } from '../store';
import { applyProject, playVoiceOver, PROFILE_PAGE } from '../store/project';
import { copyText } from '../store/ui';

/** Each engine's speed range (the server checks the same ones). */
const SPEEDS = { piper: [0.5, 2], elevenlabs: [0.7, 1.2] } as const;
const MAX_SPEAKERS = 10;

type Engine = 'piper' | 'elevenlabs';
type Save = (patch: Partial<VoiceOverSettings>) => Promise<void>;
/** Runs `send` once the voice-over PATCHes before it answered, with the settings as last saved. */
type Queue = (send: (settings: VoiceOverSettings) => Promise<unknown>) => Promise<unknown>;
/** `change` gets the speakers and settings as last saved, not as this render saw them; false when the server refused it. */
type SaveSpeakers = (change: (speakers: Speaker[], settings: VoiceOverSettings) => Speaker[]) => Promise<boolean>;
/** A scene's voice-over edit; a lines edit gets the lines as last saved. */
type SceneEdit = { text: string } | { at: number } | { lines: (lines: ScriptLine[]) => ScriptLineInput[] };

const clampSpeed = (speed: number, engine: Engine) => Math.min(Math.max(speed, SPEEDS[engine][0]), SPEEDS[engine][1]);

export function VoicePanel() {
  const project = useStore((s) => s.project)!;
  const [voices, setVoices] = useState<VoicesState | null>(null);
  // The engine picked but not saved yet: ElevenLabs is saved only once a voice is set.
  const [chosen, setChosen] = useState<Engine | null>(null);
  const saved = project.voiceOver.engine ?? 'piper';
  const engine = chosen ?? saved;
  const load = () => void api.voices().then(setVoices).catch(ignore);
  useEffect(load, []);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-6 px-4 py-4">
        {engine === 'piper' && voices && !voices.piper.ok && <PiperMissing />}
        <Voice voices={voices} engine={engine} onEngine={setChosen} onVoices={load} />
        <Status />
        <Subtitles />
        <Script engine={saved} />
      </div>
    </div>
  );
}

function Subtitles() {
  const texts = useT().production.voiceOver.subtitles;
  const project = useStore((s) => s.project)!;
  // The route's 409 and 404, known ahead: no click for a refusal.
  const hint = project.voiceOverPending.length ? texts.notSpoken : project.voiceOverLines.length ? null : texts.none;
  const hintId = useId();
  const burn = (captions: boolean) => void api.updateProject(project.id, { captions }).then(applyProject).catch(ignore);
  // Fetched rather than linked: a refusal shows its message instead of saving it as the file.
  const download = async (format: 'srt' | 'vtt') => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([await api.subtitles(project.id, format)]));
    link.download = `${project.id}.${format}`;
    link.click();
    // Some browsers read the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  return (
    <section className="space-y-3.5">
      <SectionTitle>{texts.title}</SectionTitle>
      <Checkbox checked={project.captions} onChange={burn} label={texts.burn} description={texts.burnHint} />
      <div className="flex gap-2">
        {(['srt', 'vtt'] as const).map((format) => (
          <Button
            key={format}
            size="sm"
            variant="secondary"
            icon={<Download className="size-3.5" />}
            disabled={hint !== null}
            aria-label={texts.download(format.toUpperCase())}
            aria-describedby={hint ? hintId : undefined}
            onClick={() => void download(format).catch(ignore)}
          >
            {format.toUpperCase()}
          </Button>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="text-xs text-ink-3">
          {hint}
        </p>
      )}
    </section>
  );
}

function PiperMissing() {
  const texts = useT().production.voiceOver.piper;
  return (
    <div role="alert" className="space-y-2 border border-warn/30 bg-warn/8 px-3 py-2.5 text-[13px] text-warn-ink">
      <p className="flex items-start gap-2 font-semibold">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {texts.missing}
      </p>
      <p>{texts.install}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate border border-ink bg-white px-2 py-1 font-mono text-xs text-ink">
          {PIPER_INSTALL}
        </code>
        <Button
          size="xs"
          variant="secondary"
          icon={<Copy className="size-3" />}
          onClick={() => void copyText(PIPER_INSTALL, texts.copied)}
        >
          {texts.copy}
        </Button>
      </div>
    </div>
  );
}

function Voice(props: {
  voices: VoicesState | null;
  engine: Engine;
  onEngine: (engine: Engine | null) => void;
  onVoices: () => void;
}) {
  const { voices, engine, onEngine, onVoices } = props;
  const t = useT().production.voiceOver;
  const project = useStore((s) => s.project)!;
  const settings = project.voiceOver;
  const saved = settings.engine ?? 'piper';
  // A sync speaks with the settings it started with: a change during it would bill ElevenLabs for a voice nobody hears.
  const locked = useStore((s) => s.voiceOver.status === 'speaking') && saved === 'elevenlabs';
  // Once for the video's voice and the speakers': each load asks ElevenLabs for its voices and models.
  const catalog = useElevenLabsCatalog(engine === 'elevenlabs' && !!voices?.elevenLabs.configured);
  // One voice-over PATCH at a time, each from the settings the one before saved: a voice picked while a speaker is
  // added does not put back the speakers as they were, nor the other way round.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const queued: Queue = (send) => {
    const { id } = project;
    const run = queue.current.then(() => {
      const latest = useStore.getState().project;
      return latest?.id === id ? send(latest.voiceOver) : undefined;
    });
    queue.current = run.catch(ignore);
    return run;
  };
  const save: Save = async (patch) => {
    await queued(async (latest) => applyProject(await api.updateProject(project.id, { voiceOver: { ...latest, ...patch } })));
    onEngine(null);
  };
  const choose = async (next: Engine) => {
    onEngine(next === saved ? null : next);
    if (next !== 'piper' || saved !== 'elevenlabs') return;
    await queued(async (latest) => {
      const { musicLevel, speakers } = latest;
      const speed = clampSpeed(latest.speed, 'piper');
      if (speakers) {
        // `voiceOver: null` would drop the speakers the lines name: the default voice and the speakers on it, at once.
        // The service's language: the video's, else its brand's ('cadence' is DEFAULT_BRAND in server/store/brands.ts).
        const language = project.language ?? (await api.brand(project.brand ?? 'cadence')).language;
        // The server's default voice too (`defaultVoiceOver`): the switch that `voiceOver: null` cannot make.
        const voice = PIPER_DEFAULT_VOICE[language];
        const voiceOver = { voice, speed, musicLevel, speakers: onVoice(speakers, voice) };
        applyProject(await api.updateProject(project.id, { voiceOver }));
        return;
      }
      // The default voice of the video's language, then this project's speed and level.
      const reset = await api.updateProject(project.id, { voiceOver: null });
      applyProject(reset);
      if (speed !== reset.voiceOver.speed || musicLevel !== reset.voiceOver.musicLevel) {
        applyProject(await api.updateProject(project.id, { voiceOver: { ...reset.voiceOver, speed, musicLevel } }));
      }
    });
    onEngine(null);
  };

  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3.5">
      <SectionTitle>{t.voice.title}</SectionTitle>
      <div className="space-y-1.5">
        <Segmented
          label={t.engine.label}
          size="sm"
          stretch
          value={engine}
          // A refused switch (already reported) shows the saved engine again.
          onChange={(next) => void choose(next).catch(() => onEngine(null))}
          options={[
            { value: 'piper', label: 'Piper' },
            { value: 'elevenlabs', label: 'ElevenLabs' },
          ]}
        />
        <p className="text-xs text-ink-3">
          {engine === 'elevenlabs' && voices?.elevenLabs.hosted ? t.engine.hosted : t.engine.hints[engine]}
        </p>
      </div>
      {engine === 'piper' ? (
        <PiperVoice voices={voices} save={save} onDownloaded={onVoices} />
      ) : voices?.elevenLabs.configured ? (
        <ElevenLabsVoices catalog={catalog} save={save} />
      ) : (
        voices && <ElevenLabsNoKey />
      )}
      {/* Sliders for the saved engine only: ElevenLabs without a voice yet has nothing to save. */}
      {engine === saved && <Levels engine={engine} save={save} />}
      {/* Inside the voice's fieldset: the same lock while ElevenLabs speaks. */}
      {engine === saved && <Speakers voices={voices} catalog={catalog} queued={queued} />}
    </fieldset>
  );
}

function PiperVoice({ voices, save, onDownloaded }: { voices: VoicesState | null; save: Save; onDownloaded: () => void }) {
  const texts = useT().production.voiceOver.voice;
  const project = useStore((s) => s.project)!;
  const settings = project.voiceOver;
  const [downloading, setDownloading] = useState(false);
  const current = voices?.voices.find((v) => v.id === settings.voice);
  const download = async () => {
    setDownloading(true);
    try {
      await api.downloadVoice(settings.voice);
      onDownloaded();
      // The scenes waiting for this voice were refused: speak them now.
      if (project.voiceOverPending.length) applyProject(await api.syncVoiceOver(project.id));
    } catch {
      // already reported
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <select
        aria-label={texts.label}
        value={settings.voice}
        onChange={(e) => void save({ voice: e.target.value }).catch(ignore)}
        className={clsx(inputClass, 'appearance-none')}
      >
        {voices ? (
          (['fr', 'en'] as const).map((language) => (
            <optgroup key={language} label={texts.groups[language]}>
              {voices.voices
                .filter((v) => v.language === language)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {texts.option(v.name, v.locale, texts.qualities[v.quality])}
                    {v.commercial ? '' : texts.nonCommercialTag}
                  </option>
                ))}
            </optgroup>
          ))
        ) : (
          <option value={settings.voice}>{settings.voice}</option>
        )}
      </select>
      {current && (
        <p className={clsx('text-xs', current.commercial ? 'text-ink-3' : 'text-alert')}>
          {texts.license(current.license)} {current.commercial ? texts.commercial : texts.nonCommercial}
          {current.credit ? ` ${texts.credit}` : ''}
        </p>
      )}
      {current && !current.installed && (
        <div className="space-y-2">
          <p className="text-xs text-ink-2">{texts.notDownloaded}</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<Download className="size-3.5" />}
            loading={downloading}
            onClick={() => void download()}
          >
            {texts.download(bytes(current.size))}
          </Button>
        </div>
      )}
    </>
  );
}

/** The key lives in the Profile with the other accounts: one line and the way there. */
function ElevenLabsNoKey() {
  const texts = useT().production.voiceOver.elevenLabs;
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-2">{texts.noKey}</p>
      <Button size="sm" variant="secondary" onClick={() => (location.hash = `#/${PROFILE_PAGE}`)}>
        {texts.openProfile}
      </Button>
    </div>
  );
}

function ElevenLabsVoices({ catalog, save }: { catalog: ElevenLabsCatalog; save: Save }) {
  const texts = useT().production.voiceOver.elevenLabs;
  const settings = useStore((s) => s.project!.voiceOver);
  const ready = settings.engine === 'elevenlabs';
  return (
    <ElevenLabsVoiceSelect
      label={texts.voiceLabel}
      none={texts.pick}
      catalog={catalog}
      value={ready ? { voice: settings.voice, model: settings.model! } : null}
      onChange={(next) =>
        next &&
        void save({
          engine: 'elevenlabs',
          ...next,
          speed: clampSpeed(settings.speed, 'elevenlabs'),
          // From Piper, the speakers take the voice just picked in the same PATCH: their Piper voices would be refused.
          ...(!ready && settings.speakers ? { speakers: onVoice(settings.speakers, next.voice) } : {}),
        }).catch(ignore)
      }
    />
  );
}

function Levels({ engine, save }: { engine: Engine; save: Save }) {
  const texts = useT().production.voiceOver.voice;
  const settings = useStore((s) => s.project!.voiceOver);
  const [speed, setSpeed] = useState<number | null>(null);
  const [level, setLevel] = useState<number | null>(null);
  const release = (value: number | null, saved: number, key: 'speed' | 'musicLevel', reset: () => void) => {
    if (value === null) return;
    reset();
    if (value !== saved) void save({ [key]: value }).catch(ignore);
  };

  return (
    <>
      <Row label={texts.speed}>
        <Slider
          min={SPEEDS[engine][0]}
          max={SPEEDS[engine][1]}
          step={0.05}
          value={speed ?? settings.speed}
          label={texts.speedLabel}
          onChange={setSpeed}
          onRelease={() => release(speed, settings.speed, 'speed', () => setSpeed(null))}
        />
        <span className="w-10 text-right text-xs font-semibold text-ink-2">
          {percentShort(Math.round((speed ?? settings.speed) * 100))}
        </span>
      </Row>
      <Row label={texts.musicLevel}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={level ?? settings.musicLevel}
          label={texts.musicLevelLabel}
          onChange={setLevel}
          onRelease={() => release(level, settings.musicLevel, 'musicLevel', () => setLevel(null))}
        />
        <span className="w-10 text-right text-xs font-semibold text-ink-2">
          {percentShort(Math.round((level ?? settings.musicLevel) * 100))}
        </span>
      </Row>
    </>
  );
}

function Speakers(props: { voices: VoicesState | null; catalog: ElevenLabsCatalog; queued: Queue }) {
  const { voices, catalog, queued } = props;
  const texts = useT().production.voiceOver;
  const project = useStore((s) => s.project)!;
  const speakers = project.voiceOver.speakers ?? [];
  const elevenLabs = project.voiceOver.engine === 'elevenlabs';
  // The server's refusal (a speaker a line still names), until the next change.
  const [error, setError] = useState<string | null>(null);
  const save: SaveSpeakers = (change) => {
    setError(null);
    return queued((latest) =>
      api
        .updateProject(project.id, { voiceOver: { ...latest, speakers: change(latest.speakers ?? [], latest) } }, { quiet: true })
        .then(
          (state) => {
            applyProject(state);
            return true;
          },
          (failure: ApiError) => {
            setError(failure.message);
            return false;
          },
        ),
    ).then((ok) => ok === true);
  };
  const add = () => void save((list, settings) => [...list, nextSpeaker(list, settings.voice, texts.speakers.defaultName)]);
  const { list: rows, focusAfter } = useFocusAfter<HTMLDivElement>();
  // The next speaker's button takes the focus, or the add button after the last one.
  const remove = (id: string, next: string | undefined) =>
    focusAfter(
      save((list) => list.filter((s) => s.id !== id)),
      [...(next ? [`[data-speaker="${next}"] [data-control="remove"]`] : []), '[data-control="add"]'],
    );
  const options = elevenLabs
    ? (catalog.catalog?.voices.map((v) => ({ id: v.id, label: v.name })) ?? [])
    : (voices?.voices ?? [])
        .filter((v) => v.installed)
        .map((v) => ({ id: v.id, label: texts.voice.option(v.name, v.locale, texts.voice.qualities[v.quality]) }));

  return (
    <div ref={rows} className="space-y-3.5 pt-2.5">
      <SectionTitle>{texts.speakers.title}</SectionTitle>
      <p className="text-xs text-ink-3">{texts.speakers.hint}</p>
      <SpeakerList speakers={speakers} options={options} save={save} onRemove={remove} />
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-alert">
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <Button
        size="sm"
        variant="secondary"
        icon={<Plus className="size-3.5" />}
        disabled={speakers.length >= MAX_SPEAKERS}
        data-control="add"
        onClick={add}
      >
        {texts.speakers.add}
      </Button>
    </div>
  );
}

function SpeakerList(props: {
  speakers: Speaker[];
  options: { id: string; label: string }[];
  save: SaveSpeakers;
  onRemove: (id: string, next: string | undefined) => void;
}) {
  const { speakers, options, save, onRemove } = props;
  const update = (id: string, patch: Partial<Speaker>) => save((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  return (
    <ul className="space-y-3">
      {speakers.map((speaker, i) => (
        <SpeakerRow
          key={speaker.id}
          speaker={speaker}
          options={options}
          onChange={(patch) => void update(speaker.id, patch)}
          onRemove={() => onRemove(speaker.id, speakers[i + 1]?.id)}
        />
      ))}
    </ul>
  );
}

function SpeakerRow(props: {
  speaker: Speaker;
  options: { id: string; label: string }[];
  onChange: (patch: Partial<Speaker>) => void;
  onRemove: () => void;
}) {
  const { speaker, options, onChange, onRemove } = props;
  const texts = useT().production.voiceOver.speakers;
  const [name, setName] = useState<string | null>(null);
  // Saved once the picker lets go of the field: dragging in it would send a PATCH per step.
  const [color, setColor] = useState<string | null>(null);
  return (
    <li data-speaker={speaker.id} className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={texts.colorLabel(speaker.name)}
          value={color ?? speaker.color ?? '#000000'}
          onChange={(e) => setColor(e.target.value)}
          onBlur={() => {
            if (color === null) return;
            setColor(null);
            if (color !== speaker.color) onChange({ color });
          }}
          className="size-8 shrink-0 cursor-pointer border border-ink bg-white p-0.5"
        />
        <input
          aria-label={texts.nameLabel(speaker.name)}
          maxLength={40}
          value={name ?? speaker.name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={() => {
            if (name === null) return;
            setName(null);
            const next = name.trim();
            if (next && next !== speaker.name) onChange({ name: next });
          }}
          className={clsx(inputClass, 'min-w-0 flex-1')}
        />
        <IconButton
          size="sm"
          label={texts.remove(speaker.name)}
          icon={<Trash2 className="size-3.5" />}
          data-control="remove"
          onClick={onRemove}
        />
      </div>
      <select
        aria-label={texts.voiceLabel(speaker.name)}
        value={speaker.voice}
        onChange={(e) => onChange({ voice: e.target.value })}
        className={clsx(inputClass, 'appearance-none')}
      >
        {!options.some((o) => o.id === speaker.voice) && <option value={speaker.voice}>{speaker.voice}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </li>
  );
}

function Status() {
  const texts = useT().production.voiceOver.status;
  const project = useStore((s) => s.project)!;
  const speaking = useStore((s) => s.voiceOver.status === 'speaking');
  if (speaking) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink-2">
        <Spinner className="size-3.5" />
        {texts.speaking}
      </p>
    );
  }
  if (!project.voiceOverError || !project.voiceOverPending.length) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-xs text-alert">
      <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /> {project.voiceOverError}
    </p>
  );
}

function Script({ engine }: { engine: Engine }) {
  const texts = useT().production.voiceOver.script;
  const scenes = useStore((s) => s.project!.scenes);
  return (
    <section className="space-y-3.5">
      <SectionTitle>{texts.title}</SectionTitle>
      <p className="text-xs text-ink-3">{texts.hint[engine]}</p>
      <ol className="space-y-4">
        {scenes.map((scene) => (
          <SceneVoice key={scene.id} scene={scene} />
        ))}
      </ol>
    </section>
  );
}

function SceneVoice({ scene }: { scene: SceneState }) {
  const texts = useT().production.voiceOver.script;
  const project = useStore((s) => s.project)!;
  const speaking = useStore((s) => s.voiceOver.status === 'speaking');
  const saved = scene.voiceOver;
  const speakers = project.voiceOver.speakers ?? [];
  // Lines once the project has speakers, unless the scene is a text its voice says: lines a hand-edited project kept
  // without speakers show too, rather than a text that would replace them.
  const dialogue = !!saved?.lines || (speakers.length > 0 && !saved);
  const [text, setText] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // The server's refusal, beside the fields, until the next change.
  const [error, setError] = useState<string | null>(null);
  const lines = project.voiceOverLines.filter((l) => l.sceneId === scene.id);
  const pending = project.voiceOverPending.includes(scene.id);
  const overflow = (lines.at(-1)?.end ?? 0) - (scene.start + scene.duration);

  // One PATCH at a time, each from the voice-over the one before saved: a line typed then another removed keeps both.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (edit: SceneEdit): Promise<boolean> => {
    setError(null);
    const run = queue.current.then(async () => {
      const latest = useStore.getState().project;
      if (latest?.id !== project.id) return true;
      const current = latest.scenes.find((s) => s.id === scene.id)?.voiceOver;
      const voiceOver = voiceOverUpdate(current, 'lines' in edit ? { lines: edit.lines(current?.lines ?? []) } : edit);
      if (voiceOver === undefined) return true;
      return api.updateScene(project.id, scene.id, { voiceOver }, { quiet: true }).then(
        (state) => {
          applyProject(state);
          return true;
        },
        (failure: ApiError) => {
          setError(failure.message);
          return false;
        },
      );
    });
    queue.current = run.catch(ignore);
    return run;
  };

  const generate = () => {
    setGenerating(true);
    // The route speaks every missing sentence, the failed ones included.
    void api
      .syncVoiceOver(project.id)
      .then(applyProject)
      .catch(ignore)
      .finally(() => setGenerating(false));
  };

  let timing: ReactNode = null;
  // ElevenLabs speaks on this button only: its pending scenes wait for it, failed or not.
  if (pending && !speaking && (project.voiceOverError || project.voiceOver.engine === 'elevenlabs')) {
    timing = (
      <Button
        size="xs"
        variant="secondary"
        icon={<AudioLines className="size-3" />}
        aria-label={texts.generateLabel(scene.name)}
        loading={generating}
        onClick={generate}
      >
        {texts.generate}
      </Button>
    );
  } else if (pending) timing = texts.speaking;
  else if (lines.length) {
    const from = secsLabel(lines[0].start - scene.start);
    timing = texts.timing(texts.sentences(lines.length), from, secsLabel(lines.at(-1)!.end - scene.start));
  }

  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="grid h-5 min-w-5 place-items-center bg-ink px-1 text-[11px] font-bold text-white">
          {scene.index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{scene.name}</span>
        <span className="text-xs text-ink-3">{secsLabel(scene.duration)}</span>
        {!pending && lines.length > 0 && (
          <IconButton
            size="xs"
            label={texts.listenLabel(scene.name)}
            icon={<Play className="size-3" />}
            onClick={() => playVoiceOver(scene.id)}
            className="-my-0.5"
          />
        )}
      </div>
      {dialogue ? (
        <ScriptLines
          scene={scene.name}
          speakers={speakers}
          lines={saved?.lines ?? []}
          times={
            pending
              ? null
              : lineTimes(lines, saved?.lines?.length ?? 0).map(
                  (t) => t && { start: t.start - scene.start, end: t.end - scene.start },
                )
          }
          onChange={(change) => save({ lines: change })}
        />
      ) : (
        <textarea
          aria-label={texts.textLabel(scene.name)}
          placeholder={texts.placeholder}
          rows={2}
          maxLength={2000}
          value={text ?? saved?.text ?? ''}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text === null) return;
            setText(null);
            void save({ text });
          }}
          className={clsx(fieldBase, 'block w-full resize-y px-2 py-1.5 text-[13px]')}
        />
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-alert">
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <span className="label-caps text-[11px] text-ink-2">{texts.at}</span>
        <input
          inputMode="decimal"
          aria-label={texts.atLabel(scene.name)}
          disabled={!saved}
          value={at ?? secs(saved?.at ?? 0, 2)}
          onChange={(e) => setAt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={() => {
            if (at === null) return;
            const value = parseDecimal(at);
            setAt(null);
            if (Number.isFinite(value) && value >= 0) void save({ at: Math.round(value * 1000) / 1000 });
          }}
          className={clsx(fieldBase, 'h-7 w-16 text-right text-[13px]')}
        />
        <span>s</span>
        <span className="ml-auto text-right">{timing}</span>
      </div>
      {overflow > 0.05 && <p className="text-xs text-alert">{texts.overflow(secsLabel(overflow))}</p>}
    </li>
  );
}
