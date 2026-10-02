// Side panel: scene chat, project chat + settings, versions, music, voice-over, media.
import clsx from 'clsx';
import { ChevronRight, ScanEye, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { chatKeyForScene, FORMAT_IDS, type FormatId } from '../../shared/types';
import { ignore } from '../api';
import { Button, Field, FormatGlyph, Segmented, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { bars, secsLabel } from '../lib/format';
import { sceneBars } from '../lib/timeline';
import { currentScene, set, useStore, type Panel, NONE } from '../store';
import { checkSeams, updateProject } from '../store/project';
import { Chat, ChatHeaderActions } from './Chat';
import { MediaPanel } from './MediaPanel';
import { MusicPanel } from './MusicPanel';
import { VersionsPanel } from './VersionsPanel';
import { VoicePanel } from './VoicePanel';

const TABS: Panel[] = ['scene', 'project', 'versions', 'music', 'voice', 'media'];

export function SidePanel() {
  const texts = useT().conversation.sidePanel;
  const panel = useStore((s) => s.panel);
  return (
    <aside
      className="flex min-h-0 w-[348px] shrink-0 flex-col border-l-2 border-ink bg-paper xl:w-[400px]"
      aria-label={texts.label}
    >
      <div className="shrink-0 border-b-2 border-ink px-3 pt-3">
        <Segmented
          label={texts.tabsLabel}
          look="tabs"
          stretch
          value={panel}
          onChange={(value) => set({ panel: value })}
          options={TABS.map((value) => ({ value, label: texts.tabs[value] }))}
        />
      </div>
      {panel === 'scene' && <ScenePanel />}
      {panel === 'project' && <ProjectPanel />}
      {panel === 'versions' && <VersionsPanel />}
      {panel === 'music' && <MusicPanel />}
      {panel === 'voice' && <VoicePanel />}
      {panel === 'media' && <MediaPanel />}
    </aside>
  );
}

function ScenePanel() {
  const project = useStore((s) => s.project)!;
  const scene = useStore((s) => currentScene(s));
  if (!scene) return null;
  const key = chatKeyForScene(scene.id);
  return (
    <Chat
      key={key}
      chatKey={key}
      header={
        <div className="flex shrink-0 items-center gap-2.5 border-b border-rule px-4 py-3">
          <span className="grid h-6 min-w-6 place-items-center bg-ink px-1 text-xs font-bold text-white">{scene.index + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="display-caps truncate text-lg/6 text-ink">{scene.name}</p>
            <p className="truncate text-xs whitespace-nowrap text-ink-3">
              {secsLabel(scene.duration)} · {bars(sceneBars(project, scene))}
            </p>
          </div>
          <ChatHeaderActions chatKey={key} />
        </div>
      }
    />
  );
}

function ProjectPanel() {
  const texts = useT().conversation.sidePanel;
  const [open, setOpen] = useState(false);
  return (
    <Chat
      chatKey="project"
      header={
        // Capped so the composer stays on screen (1440×900): the settings scroll inside.
        <div className="flex max-h-[45%] shrink-0 flex-col border-b border-rule">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="focus-ring flex w-full shrink-0 items-start gap-2 px-4 py-2.5 text-left hover:bg-wash"
          >
            <ChevronRight
              className={clsx('mt-0.5 size-3.5 shrink-0 text-ink transition-transform', open && 'rotate-90')}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="label-caps flex items-center gap-1.5 text-[11px] text-ink">
                <Settings2 className="size-3.5 text-ink-3" aria-hidden />
                {texts.projectSettings}
              </span>
              {!open && <ProjectSummary />}
            </span>
          </button>
          {open && <ProjectSettings />}
          <div className="flex shrink-0 items-center gap-2 border-t border-rule px-4 py-1.5">
            <p className="label-caps flex-1 text-[11px] text-ink-3">{texts.projectChat}</p>
            <ChatHeaderActions chatKey="project" />
          </div>
        </div>
      }
    />
  );
}

function ProjectSummary() {
  const texts = useT().conversation.sidePanel;
  const project = useStore((s) => s.project)!;
  const brand = useStore((s) => s.app?.brands.find((b) => b.id === (project.brand ?? 'cadence')));
  return (
    <span className="mt-0.5 block truncate text-xs text-ink-3">
      {brand?.name ?? texts.noBrand} · {project.formats.join(', ')} · {texts.fps(project.fps)} · {Math.round(project.tempo)}
      &nbsp;BPM
    </span>
  );
}

function ProjectSettings() {
  const t = useT();
  const texts = t.conversation.sidePanel;
  const project = useStore((s) => s.project)!;
  const brands = useStore((s) => s.app?.brands ?? NONE);
  const checking = useStore((s) => s.seamsChecking);
  const hasMusic = Boolean(project.music);

  const toggleFormat = (format: FormatId) => {
    const formats = project.formats.includes(format) ? project.formats.filter((f) => f !== format) : [...project.formats, format];
    if (formats.length === 0) return;
    void updateProject({ formats: FORMAT_IDS.filter((f) => formats.includes(f)) }).catch(ignore);
  };

  return (
    <div className="min-h-0 space-y-3.5 overflow-y-auto px-4 pt-1 pb-4">
      <Field label={texts.name} htmlFor="project-name">
        <input
          id="project-name"
          key={project.name}
          defaultValue={project.name}
          maxLength={120}
          className={inputClass}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            if (name && name !== project.name) void updateProject({ name }).catch(ignore);
            else e.currentTarget.value = project.name;
          }}
        />
      </Field>
      <Field label={texts.brand} htmlFor="project-brand" hint={texts.brandHint}>
        <select
          id="project-brand"
          value={project.brand ?? 'cadence'}
          onChange={(e) => void updateProject({ brand: e.target.value }).catch(ignore)}
          className={clsx(inputClass, 'appearance-none')}
        >
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={texts.textLanguage} htmlFor="project-language" hint={texts.textLanguageHint}>
        <select
          id="project-language"
          value={project.language ?? ''}
          onChange={(e) => void updateProject({ language: (e.target.value || null) as 'fr' | 'en' | null }).catch(ignore)}
          className={clsx(inputClass, 'appearance-none')}
        >
          <option value="">{texts.brandLanguage}</option>
          <option value="fr">{texts.languages.fr}</option>
          <option value="en">{texts.languages.en}</option>
        </select>
      </Field>
      <Field label={texts.formats}>
        <div className="grid grid-cols-2 gap-1.5">
          {FORMAT_IDS.map((format) => {
            const on = project.formats.includes(format);
            return (
              <button
                key={format}
                type="button"
                aria-pressed={on}
                onClick={() => toggleFormat(format)}
                disabled={on && project.formats.length === 1}
                title={on && project.formats.length === 1 ? texts.lastFormat : undefined}
                className={clsx(
                  'focus-ring press flex h-8 items-center gap-2 border-2 border-ink px-2.5 text-[13px] font-semibold',
                  on ? 'bg-ink text-white' : 'bg-white text-ink-2 hover:bg-wash',
                )}
              >
                <FormatGlyph format={format} />
                {t.common.formats[format]}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={texts.frameRate}>
          <Segmented
            label={texts.frameRate}
            size="sm"
            stretch
            value={String(project.fps)}
            onChange={(fps) => void updateProject({ fps: Number(fps) }).catch(ignore)}
            options={['24', '30', '60'].map((v) => ({ value: v, label: v }))}
          />
        </Field>
        <Field label={texts.tempo} htmlFor="project-tempo">
          <input
            id="project-tempo"
            key={project.tempo}
            type="number"
            min={30}
            max={300}
            step={1}
            defaultValue={project.tempo}
            disabled={hasMusic}
            title={hasMusic ? texts.tempoFromMusic : undefined}
            className={inputClass}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            onBlur={(e) => {
              const tempo = Number(e.currentTarget.value);
              if (Number.isFinite(tempo) && tempo >= 30 && tempo <= 300 && tempo !== project.tempo)
                void updateProject({ tempo }).catch(ignore);
              else e.currentTarget.value = String(project.tempo);
            }}
          />
        </Field>
      </div>
      <p className="text-xs text-ink-3">{hasMusic ? texts.gridFromMusic : texts.gridFromTempo}</p>
      <Button
        variant="secondary"
        size="sm"
        icon={<ScanEye className="size-3.5" />}
        loading={checking}
        onClick={() => void checkSeams().catch(ignore)}
      >
        {texts.checkCuts}
      </Button>
    </div>
  );
}
