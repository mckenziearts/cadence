// Voice-over: the engine (Piper on this machine or ElevenLabs with the person's key), the voice, speed and music level,
// then each scene's text and timing.
import clsx from 'clsx';
import { AlertTriangle, AudioLines, Copy, Download, Play } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { SceneState, SceneVoiceOver, VoiceOverSettings, VoicesState } from '../../shared/types';
import { api, ignore } from '../api';
import { ElevenLabsVoiceSelect, PIPER_INSTALL, Row } from '../components/voiceOver';
import { Button, Checkbox, IconButton, SectionTitle, Segmented, Slider, Spinner, fieldBase, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { bytes, parseDecimal, percentShort, secs, secsLabel } from '../lib/format';
import { useStore } from '../store';
import { applyProject, playVoiceOver, PROFILE_PAGE } from '../store/project';
import { copyText } from '../store/ui';

/** Each engine's speed range (the server checks the same ones). */
const SPEEDS = { piper: [0.5, 2], elevenlabs: [0.7, 1.2] } as const;

type Engine = 'piper' | 'elevenlabs';
type Save = (patch: Partial<VoiceOverSettings>) => Promise<void>;

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
            onClick={() => void download(format).catch(ignore)}
          >
            {format.toUpperCase()}
          </Button>
        ))}
      </div>
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
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
  const save: Save = async (patch) => {
    applyProject(await api.updateProject(project.id, { voiceOver: { ...settings, ...patch } }));
    onEngine(null);
  };
  const choose = async (next: Engine) => {
    onEngine(next === saved ? null : next);
    if (next !== 'piper' || saved !== 'elevenlabs') return;
    // The default voice of the video's language (the server knows the brand's), then this project's speed and level.
    const reset = await api.updateProject(project.id, { voiceOver: null });
    applyProject(reset);
    onEngine(null);
    const { musicLevel } = settings;
    const speed = clampSpeed(settings.speed, 'piper');
    if (speed !== reset.voiceOver.speed || musicLevel !== reset.voiceOver.musicLevel) {
      applyProject(await api.updateProject(project.id, { voiceOver: { ...reset.voiceOver, speed, musicLevel } }));
    }
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
        <p className="text-xs text-ink-3">{t.engine.hints[engine]}</p>
      </div>
      {engine === 'piper' ? (
        <PiperVoice voices={voices} save={save} onDownloaded={onVoices} />
      ) : voices?.elevenLabs.configured ? (
        <ElevenLabsVoices save={save} />
      ) : (
        voices && <ElevenLabsNoKey />
      )}
      {/* Sliders for the saved engine only: ElevenLabs without a voice yet has nothing to save. */}
      {engine === saved && <Levels engine={engine} save={save} />}
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

function ElevenLabsVoices({ save }: { save: Save }) {
  const texts = useT().production.voiceOver.elevenLabs;
  const settings = useStore((s) => s.project!.voiceOver);
  const ready = settings.engine === 'elevenlabs';
  return (
    <ElevenLabsVoiceSelect
      label={texts.voiceLabel}
      none={texts.pick}
      value={ready ? { voice: settings.voice, model: settings.model! } : null}
      onChange={(next) =>
        next && void save({ engine: 'elevenlabs', ...next, speed: clampSpeed(settings.speed, 'elevenlabs') }).catch(ignore)
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
  const [text, setText] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const lines = project.voiceOverLines.filter((l) => l.sceneId === scene.id);
  const pending = project.voiceOverPending.includes(scene.id);
  const overflow = (lines.at(-1)?.end ?? 0) - (scene.start + scene.duration);

  const save = (next: SceneVoiceOver) => {
    if (next.text.trim() === (saved?.text ?? '') && next.at === (saved?.at ?? 0)) return;
    const voiceOver = next.text.trim() ? next : null;
    void api.updateScene(project.id, scene.id, { voiceOver }).then(applyProject).catch(ignore);
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
          save({ text, at: saved?.at ?? 0 });
        }}
        className={clsx(fieldBase, 'block w-full resize-y px-2 py-1.5 text-[13px]')}
      />
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
            if (saved && Number.isFinite(value) && value >= 0) save({ text: saved.text, at: Math.round(value * 1000) / 1000 });
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
