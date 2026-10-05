import clsx from 'clsx';
import { Check, FileText, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { FORMAT_IDS, type FormatId } from '../../shared/types';
import { api, ignore } from '../api';
import { AgentPicker } from '../components/AgentPicker';
import { BrandMark } from '../components/TopBar';
import {
  BeatPills,
  Button,
  ConfirmButton,
  Field,
  FormatGlyph,
  Modal,
  Segmented,
  SectionTitle,
  Select,
  fieldBase,
} from '../components/ui';
import { useT } from '../i18n';
import { NBSP, secsLabel } from '../lib/format';
import { useStore } from '../store';
import { loadApp, openProject } from '../store/project';
import { closeModal, openModal, toast } from '../store/ui';

export function NewProjectModal({ brand: initialBrand }: { brand?: string | null }) {
  const t = useT();
  const app = useStore((s) => s.app)!;
  const [name, setName] = useState('');
  const [brand, setBrand] = useState<string>(initialBrand ?? app.brands[0]?.id ?? 'cadence');
  const [template, setTemplate] = useState<string | null>(null);
  const [formats, setFormats] = useState<FormatId[]>(['16:9', '9:16']);
  const [fps, setFps] = useState('60');
  const [language, setLanguage] = useState<'' | 'fr' | 'en'>('');
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const brandGrid = useRef<HTMLDivElement>(null);

  const pickTemplate = (id: string | null) => {
    setTemplate(id);
    const meta = app.templates.projects.find((t) => t.id === id);
    if (meta) {
      setFormats(meta.formats);
      setFps(String(meta.fps));
    }
  };

  const create = async () => {
    if (!name.trim()) return nameInput.current?.focus();
    setBusy(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        brand,
        formats: FORMAT_IDS.filter((f) => formats.includes(f)),
        fps: Number(fps),
        template,
        ...(language ? { language } : {}),
      });
      closeModal();
      await loadApp().catch(ignore);
      await openProject(project.id);
      toast(t.dialogs.newProject.created(project.name), 'success');
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t.dialogs.newProject.title}
      subtitle={t.dialogs.newProject.subtitle}
      onClose={closeModal}
      width="max-w-[760px]"
      initialFocus={nameInput}
      footer={
        <>
          <p className="mr-auto text-xs text-ink-3">
            {!name.trim()
              ? t.dialogs.newProject.needName
              : formats.length === 0
                ? t.dialogs.newProject.needFormat
                : `${FORMAT_IDS.filter((f) => formats.includes(f)).join(', ')} · ${t.dialogs.newProject.fps(fps)}`}
          </p>
          <Button variant="ghost" onClick={closeModal}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={formats.length === 0 || !name.trim()} onClick={() => void create()}>
            {t.dialogs.newProject.create}
          </Button>
        </>
      }
    >
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label={t.dialogs.newProject.name} htmlFor="new-project-name">
          <input
            ref={nameInput}
            id="new-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.dialogs.newProject.namePlaceholder}
            maxLength={120}
            className={clsx(fieldBase, 'h-9 w-full text-sm')}
          />
        </Field>
        <section className="space-y-2">
          <SectionTitle>{t.dialogs.newProject.brand}</SectionTitle>
          <div ref={brandGrid} className="grid grid-cols-3 gap-2">
            {app.brands.map((b) => {
              const on = b.id === brand;
              return (
                <div key={b.id} className="group relative">
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setBrand(b.id)}
                    className={clsx(
                      'focus-ring relative flex size-full items-center gap-3 rounded-xl p-2.5 text-left ring-inset transition-shadow',
                      on ? 'bg-wash ring-2 ring-ink' : 'ring-1 ring-rule hover:ring-track',
                    )}
                  >
                    <span
                      className="grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-black/5"
                      style={{ background: b.colors.background }}
                    >
                      <BrandMark brand={b} className="size-6" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{b.name}</span>
                      <span className="mt-1 flex gap-1" aria-hidden>
                        {[b.colors.primary, b.colors.accent, b.colors.ink, b.colors.background].map((c, i) => (
                          <span key={i} className="size-3 rounded-full ring-1 ring-black/10" style={{ background: c }} />
                        ))}
                      </span>
                    </span>
                    {on && <Check className="absolute top-2 right-2 size-3.5 text-ink" aria-hidden />}
                  </button>
                  {/* The neutral kit stays: new brands start from it. */}
                  {b.id !== 'cadence' && (
                    <div className="absolute right-1.5 bottom-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <ConfirmButton
                        size="xs"
                        variant="secondary"
                        iconOnly
                        label={t.dialogs.newProject.deleteBrand(b.name)}
                        confirmLabel={t.dialogs.newProject.deleteConfirm}
                        icon={<Trash2 className="size-3" />}
                        onConfirm={async () => {
                          await api.deleteBrand(b.id);
                          setBrand((current) => (current === b.id ? 'cadence' : current));
                          // The card leaves with the focus: Escape and Tab would no longer reach the dialog.
                          brandGrid.current?.querySelector<HTMLElement>('[aria-pressed]')?.focus();
                          toast(t.dialogs.brandDeleted(b.name), 'info');
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {app.brandBuilds
              .filter((b) => !b.finishedAt)
              .map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => openModal({ kind: 'new-brand', buildId: b.id })}
                  className="focus-ring flex items-center gap-3 p-2.5 text-left ring-1 ring-rule ring-inset hover:ring-track"
                >
                  <span className="grid size-10 shrink-0 place-items-center bg-wash text-ink">
                    <BeatPills />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{b.name}</span>
                    <span className="block truncate text-xs text-ink-3">{t.dialogs.newProject.building}</span>
                  </span>
                </button>
              ))}
            <button
              type="button"
              onClick={() => openModal({ kind: 'new-brand' })}
              className="focus-ring flex items-center gap-3 border border-dashed border-ink p-2.5 text-left hover:bg-white"
            >
              <span className="grid size-10 shrink-0 place-items-center border-2 border-ink bg-now text-ink">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-ink">{t.dialogs.newProject.newBrand}</span>
                <span className="block truncate text-xs text-ink-3">{t.dialogs.newProject.newBrandHint}</span>
              </span>
            </button>
          </div>
          <div className="flex items-center gap-2.5 pt-1">
            <label htmlFor="new-project-language" className="text-[12.5px] font-medium text-ink-2">
              {t.dialogs.newProject.language}
            </label>
            <Select
              id="new-project-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value as '' | 'fr' | 'en')}
              className="w-48"
            >
              <option value="">{t.dialogs.newProject.languages.brand}</option>
              <option value="fr">{t.dialogs.newProject.languages.fr}</option>
              <option value="en">{t.dialogs.newProject.languages.en}</option>
            </Select>
          </div>
        </section>
        <section className="space-y-2">
          <SectionTitle>{t.dialogs.newProject.start}</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <TemplateOption
              active={template === null}
              onClick={() => pickTemplate(null)}
              icon={<FileText className="size-4" />}
              title={t.dialogs.newProject.blank}
              description={t.dialogs.newProject.blankHint}
            />
            {/* The flagship campaign first; each card says how long the video runs at the campaign's tempo. */}
            {[...app.templates.projects]
              .sort((a, b) => Number(b.id === 'teaser-produit') - Number(a.id === 'teaser-produit'))
              .map((campaign) => (
                <TemplateOption
                  key={campaign.id}
                  active={template === campaign.id}
                  onClick={() => pickTemplate(campaign.id)}
                  icon={<LayoutTemplate className="size-4" />}
                  title={campaign.name}
                  description={campaign.description}
                  meta={`${t.dialogs.newProject.scenes(campaign.scenes.length)} · ${secsLabel((campaign.scenes.reduce((n, s) => n + s.bars, 0) * 240) / campaign.bpm, 0)} · ${campaign.formats.join(', ')} · ${campaign.bpm}${NBSP}BPM`}
                />
              ))}
          </div>
        </section>
        {app.features.agentPicker && (
          <section className="space-y-2">
            <SectionTitle>{t.profile.agents.title}</SectionTitle>
            <AgentPicker />
          </section>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-6">
          <section className="space-y-2">
            <SectionTitle>{t.dialogs.newProject.formats}</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5">
              {FORMAT_IDS.map((f) => {
                const on = formats.includes(f);
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFormats(on ? formats.filter((x) => x !== f) : [...formats, f])}
                    className={clsx(
                      'focus-ring flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium ring-1 ring-inset transition-colors',
                      on ? 'bg-ink text-white ring-ink' : 'bg-white text-ink-2 ring-rule hover:ring-track',
                    )}
                  >
                    <FormatGlyph format={f} className={on ? 'opacity-90' : 'opacity-50'} />
                    {t.common.formats[f]}
                  </button>
                );
              })}
            </div>
          </section>
          <section className="space-y-2">
            <SectionTitle>{t.dialogs.newProject.frameRate}</SectionTitle>
            <Segmented
              label={t.dialogs.newProject.frameRate}
              value={fps}
              onChange={setFps}
              options={['24', '30', '60'].map((v) => ({ value: v, label: v }))}
            />
          </section>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function TemplateOption(props: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  description: string;
  meta?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={clsx(
        'focus-ring flex items-start gap-3 rounded-xl p-3 text-left ring-inset transition-shadow',
        props.active ? 'bg-wash ring-2 ring-ink' : 'ring-1 ring-rule hover:ring-track',
      )}
    >
      <span
        className={clsx(
          'grid size-8 shrink-0 place-items-center rounded-lg',
          props.active ? 'bg-ink text-white' : 'bg-wash text-ink-3',
        )}
      >
        {props.icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{props.title}</span>
        <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-3">{props.description}</span>
        {props.meta && <span className="mt-1 block text-[11px] text-ink-4">{props.meta}</span>}
      </span>
    </button>
  );
}
