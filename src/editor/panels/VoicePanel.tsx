// Voice-over: Piper's state, the voice (download, license), speed and music level, then each scene's text and timing.
import clsx from 'clsx';
import { AlertTriangle, Copy, Download, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { SceneState, SceneVoiceOver, VoiceOverSettings, VoicesState } from '../../shared/types';
import { api, ignore } from '../api';
import { Button, SectionTitle, Slider, Spinner, fieldBase, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { bytes, parseDecimal, percentShort, secs, secsLabel } from '../lib/format';
import { useStore } from '../store';
import { applyProject } from '../store/project';
import { copyText } from '../store/ui';

const PIPER_INSTALL = 'pipx install piper-tts';

export function VoicePanel() {
  const [voices, setVoices] = useState<VoicesState | null>(null);
  const load = () => void api.voices().then(setVoices).catch(ignore);
  useEffect(load, []);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-6 px-4 py-4">
        {voices && !voices.piper.ok && <PiperMissing />}
        <Voice voices={voices} onDownloaded={load} />
        <Status />
        <Script />
      </div>
    </div>
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

function Voice({ voices, onDownloaded }: { voices: VoicesState | null; onDownloaded: () => void }) {
  const texts = useT().production.voiceOver.voice;
  const project = useStore((s) => s.project)!;
  const settings = project.voiceOver;
  const [speed, setSpeed] = useState<number | null>(null);
  const [level, setLevel] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const current = voices?.voices.find((v) => v.id === settings.voice);
  const save = async (patch: Partial<VoiceOverSettings>) => {
    applyProject(await api.updateProject(project.id, { voiceOver: { ...settings, ...patch } }));
  };
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
  const release = (value: number | null, saved: number, key: 'speed' | 'musicLevel', reset: () => void) => {
    if (value === null) return;
    reset();
    if (value !== saved) void save({ [key]: value }).catch(ignore);
  };

  return (
    <section className="space-y-3.5">
      <SectionTitle>{texts.title}</SectionTitle>
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
      <Row label={texts.speed}>
        <Slider
          min={0.5}
          max={2}
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
    </section>
  );
}

function Status() {
  const texts = useT().production.voiceOver.status;
  const project = useStore((s) => s.project)!;
  const { status, error } = useStore((s) => s.voiceOver);
  if (status === 'speaking') {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink-2">
        <Spinner className="size-3.5" />
        {texts.speaking}
      </p>
    );
  }
  if (status !== 'error' || !project.voiceOverPending.length) return null;
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-1.5 text-xs text-alert">
        <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /> {error ?? texts.failed}
      </p>
      <Button
        size="xs"
        variant="secondary"
        icon={<RotateCcw className="size-3" />}
        onClick={() => void api.syncVoiceOver(project.id).then(applyProject).catch(ignore)}
      >
        {texts.retry}
      </Button>
    </div>
  );
}

function Script() {
  const texts = useT().production.voiceOver.script;
  const scenes = useStore((s) => s.project!.scenes);
  return (
    <section className="space-y-3.5">
      <SectionTitle>{texts.title}</SectionTitle>
      <p className="text-xs text-ink-3">{texts.hint}</p>
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
  const lines = project.voiceOverLines.filter((l) => l.sceneId === scene.id);
  const pending = project.voiceOverPending.includes(scene.id);
  const overflow = (lines.at(-1)?.end ?? 0) - (scene.start + scene.duration);

  const save = (next: SceneVoiceOver) => {
    if (next.text.trim() === (saved?.text ?? '') && next.at === (saved?.at ?? 0)) return;
    const voiceOver = next.text.trim() ? next : null;
    void api.updateScene(project.id, scene.id, { voiceOver }).then(applyProject).catch(ignore);
  };

  let timing: ReactNode = null;
  if (pending) timing = speaking ? texts.speaking : texts.pending;
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <span className="label-caps w-[108px] shrink-0 text-[11px] text-ink-2">{label}</span>
      {children}
    </div>
  );
}
