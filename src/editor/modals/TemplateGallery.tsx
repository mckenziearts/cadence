import clsx from 'clsx';
import {
  ArrowRightLeft,
  BarChart3,
  Flag,
  LayoutPanelTop,
  PanelsTopLeft,
  Plus,
  Sparkles,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { chatKeyForScene, type SceneTemplateCategory, type SceneTemplateMeta } from '../../shared/types';
import { Button, Modal, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { bars as barsLabel, secsLabel } from '../lib/format';
import { sceneMusic } from '../lib/timeline';
import { currentScene, useStore, NONE } from '../store';
import { prefill } from '../store/chat';
import { addScene } from '../store/project';
import { closeModal } from '../store/ui';

const CATEGORIES: { value: SceneTemplateCategory; icon: LucideIcon; tone: string }[] = [
  { value: 'intro', icon: Sparkles, tone: 'bg-now/25 text-ink' },
  { value: 'title', icon: Type, tone: 'bg-white text-ink' },
  { value: 'ui', icon: PanelsTopLeft, tone: 'bg-wash text-ink' },
  { value: 'feature', icon: LayoutPanelTop, tone: 'bg-ok/15 text-ink' },
  { value: 'data', icon: BarChart3, tone: 'bg-warn/20 text-ink' },
  { value: 'transition', icon: ArrowRightLeft, tone: 'bg-now text-ink' },
  { value: 'outro', icon: Flag, tone: 'bg-ink text-white' },
];

const BLANK = '__blank__';

export function TemplateGallery() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const templates = useStore((s) => s.app?.templates.scenes ?? NONE);
  const after = useStore((s) => currentScene(s));
  const [category, setCategory] = useState<SceneTemplateCategory | 'all'>('all');
  const [selected, setSelected] = useState<string>(BLANK);
  const [name, setName] = useState(t.dialogs.templateGallery.newScene);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  // Template lengths are bars at the grid the new scene will play on (the project's music or tempo).
  const barLength = useMemo(() => (after ? sceneMusic(project, after).barLength : 240 / project.tempo), [project, after]);
  const shown = templates.filter((t) => category === 'all' || t.category === category);
  const counts = new Map(CATEGORIES.map((c) => [c.value, templates.filter((t) => t.category === c.value).length]));
  const template = templates.find((t) => t.id === selected) ?? null;

  const choose = (id: string, defaultName: string) => {
    setSelected(id);
    setName(defaultName);
  };

  const insert = async (id = selected, sceneName = name) => {
    const trimmed = sceneName.trim();
    if (!trimmed) return nameInput.current?.focus();
    setBusy(true);
    try {
      await addScene({ name: trimmed, after: after?.id ?? null, template: id === BLANK ? null : id });
      closeModal();
      const created = useStore.getState().sceneId;
      // A blank scene is described in its chat right away.
      if (id === BLANK && created) prefill(chatKeyForScene(created), '');
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t.dialogs.templateGallery.title}
      subtitle={after ? t.dialogs.templateGallery.after(after.name) : t.dialogs.templateGallery.atEnd}
      onClose={closeModal}
      width="max-w-[920px]"
      bodyClassName="p-0"
      footer={
        <>
          <label htmlFor="template-scene-name" className="text-[12.5px] font-medium whitespace-nowrap text-ink-2">
            {t.dialogs.templateGallery.name}
          </label>
          <input
            ref={nameInput}
            id="template-scene-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void insert()}
            maxLength={120}
            className={clsx(inputClass, 'max-w-64')}
          />
          <span className="mr-auto" />
          <Button variant="ghost" onClick={closeModal}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" icon={<Plus className="size-3.5" />} loading={busy} onClick={() => void insert()}>
            {template ? t.dialogs.templateGallery.insert(template.name) : t.dialogs.templateGallery.insertBlank}
          </Button>
        </>
      }
    >
      <div className="flex min-h-[420px]">
        <nav
          className="w-48 shrink-0 space-y-0.5 border-r border-rule p-3"
          aria-label={t.dialogs.templateGallery.categoriesLabel}
        >
          <CategoryButton
            active={category === 'all'}
            onClick={() => setCategory('all')}
            label={t.dialogs.templateGallery.all}
            count={templates.length}
          />
          {CATEGORIES.map((c) => (
            <CategoryButton
              key={c.value}
              active={category === c.value}
              onClick={() => setCategory(c.value)}
              label={t.dialogs.templateGallery.categories[c.value]}
              count={counts.get(c.value) ?? 0}
            />
          ))}
        </nav>
        <div className="min-w-0 flex-1 p-4">
          <ul className="grid grid-cols-3 gap-3" role="listbox" aria-label={t.dialogs.templateGallery.list}>
            {category === 'all' && (
              <li role="option" aria-selected={selected === BLANK}>
                <button
                  type="button"
                  onClick={() => choose(BLANK, t.dialogs.templateGallery.newScene)}
                  onDoubleClick={() => void insert(BLANK, name)}
                  className={clsx(cardClass, selected === BLANK ? selectedClass : idleClass)}
                >
                  <span className="grid aspect-video w-full place-items-center rounded-lg border border-dashed border-track bg-wash text-ink-4">
                    <Plus className="size-6" />
                  </span>
                  <span className="mt-2.5 block text-[13px] font-medium text-ink">{t.dialogs.templateGallery.blank}</span>
                  <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-3">
                    {t.dialogs.templateGallery.blankHint}
                  </span>
                  <span className="mt-1.5 block font-mono text-[11px] text-ink-4">{secsLabel(3)}</span>
                </button>
              </li>
            )}
            {shown.map((t) => (
              <li key={t.id} role="option" aria-selected={selected === t.id}>
                <TemplateCard
                  template={t}
                  selected={selected === t.id}
                  barLength={barLength}
                  formats={project.formats}
                  onSelect={() => choose(t.id, t.name)}
                  onInsert={() => void insert(t.id, t.name)}
                />
              </li>
            ))}
          </ul>
          {templates.length === 0 && <p className="mt-6 text-center text-[13px] text-ink-3">{t.dialogs.templateGallery.empty}</p>}
        </div>
      </div>
    </Modal>
  );
}

const cardClass = 'focus-ring flex h-full w-full flex-col rounded-xl p-2.5 text-left ring-inset transition-shadow';
const selectedClass = 'bg-wash ring-2 ring-ink';
const idleClass = 'ring-1 ring-rule hover:ring-track';

function CategoryButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'focus-ring flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px]',
        active ? 'bg-wash font-medium text-ink' : 'text-ink-2 hover:bg-wash',
      )}
    >
      {label}
      <span className="font-mono text-[11px] text-ink-4">{count}</span>
    </button>
  );
}

function TemplateCard(props: {
  template: SceneTemplateMeta;
  selected: boolean;
  barLength: number;
  formats: string[];
  onSelect: () => void;
  onInsert: () => void;
}) {
  const t = useT();
  const { template, selected, barLength } = props;
  const category = CATEGORIES.find((c) => c.value === template.category) ?? CATEGORIES[0];
  const Icon = category.icon;
  const missing = props.formats.filter((f) => !template.formats.includes(f as never));
  return (
    <button
      type="button"
      onClick={props.onSelect}
      onDoubleClick={props.onInsert}
      className={clsx(cardClass, selected ? selectedClass : idleClass)}
    >
      <span className={clsx('bg-grid grid aspect-video w-full place-items-center border-2 border-ink', category.tone)}>
        <Icon className="size-7 opacity-80" />
      </span>
      <span className="mt-2.5 flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-ink">{template.name}</span>
        <span className="ml-auto shrink-0 rounded bg-wash px-1.5 py-px text-[10.5px] text-ink-3">
          {t.dialogs.templateGallery.categories[category.value]}
        </span>
      </span>
      <span className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-ink-3" title={template.description}>
        {template.description}
      </span>
      <span className="mt-1.5 block font-mono text-[11px] text-ink-4">
        {barsLabel(template.bars)} · {secsLabel(template.bars * barLength)}
      </span>
      {(template.tags.length > 0 || missing.length > 0) && (
        <span className="mt-2 flex flex-wrap gap-1">
          {template.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded-md bg-wash px-1.5 py-0.5 text-[10.5px] text-ink-2">
              {tag}
            </span>
          ))}
          {missing.length > 0 && (
            <span
              className="rounded-md bg-warn/8 px-1.5 py-0.5 text-[10.5px] text-warn-ink"
              title={t.dialogs.templateGallery.designedFor(template.formats.join(', '))}
            >
              {t.dialogs.templateGallery.toAdapt(missing.join(', '))}
            </span>
          )}
        </span>
      )}
    </button>
  );
}
