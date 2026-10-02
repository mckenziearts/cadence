// Versions: every agent turn, manual save, template insert and restore, newest first. Restores never lose work.
import clsx from 'clsx';
import {
  Bookmark,
  BookmarkPlus,
  FilePen,
  Flag,
  History,
  LayoutTemplate,
  RotateCcw,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { VersionEntry, VersionSource } from '../../shared/types';
import { api, ignore } from '../api';
import { Button, ConfirmButton, EmptyState, Segmented, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { relative, usd } from '../lib/format';
import { currentScene, set, useStore } from '../store';
import { toast } from '../store/ui';

const SOURCES: Record<VersionSource, { icon: LucideIcon; tone: string }> = {
  agent: { icon: Sparkles, tone: 'bg-now text-ink' },
  manual: { icon: Bookmark, tone: 'bg-ink text-white' },
  restore: { icon: RotateCcw, tone: 'bg-warn text-ink' },
  external: { icon: FilePen, tone: 'bg-white text-ink-2' },
  baseline: { icon: Flag, tone: 'bg-white text-ink-2' },
  template: { icon: LayoutTemplate, tone: 'bg-ok text-white' },
};

export function VersionsPanel() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const scene = useStore((s) => currentScene(s));
  const tick = useStore((s) => s.versionsTick);
  const focus = useStore((s) => s.focusVersion);
  const [scope, setScope] = useState<'scene' | 'project'>(focus ? 'project' : 'scene');
  const [entries, setEntries] = useState<VersionEntry[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const sceneFilter = scope === 'scene' ? (scene?.id ?? null) : null;

  useEffect(() => {
    let live = true;
    api
      .versions(project.id, sceneFilter)
      .then((list) => live && setEntries(list))
      .catch(ignore);
    return () => {
      live = false;
    };
  }, [project.id, sceneFilter, tick]);

  const save = async () => {
    const label = saving?.trim() || t.conversation.versions.defaultLabel;
    try {
      const entry = await api.saveVersion(project.id, label);
      toast(entry ? t.conversation.versions.saved(entry.id) : t.conversation.versions.unchanged, entry ? 'success' : 'info');
      setSaving(null);
    } catch {
      // toast shown
    }
  };

  const names = new Map(project.scenes.map((s) => [s.id, s.name]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2.5 border-y border-rule bg-wash/60 px-4 py-2.5">
        <Segmented
          label={t.conversation.versions.shown}
          size="sm"
          stretch
          value={scope}
          onChange={setScope}
          options={[
            { value: 'scene', label: t.conversation.versions.scene },
            { value: 'project', label: t.conversation.versions.project },
          ]}
        />
        {saving === null ? (
          <button
            type="button"
            onClick={() => setSaving('')}
            className="focus-ring flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-track text-[12.5px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:bg-white hover:text-ink"
          >
            <BookmarkPlus className="size-3.5" aria-hidden />
            {t.conversation.versions.save}
          </button>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              autoFocus
              value={saving}
              onChange={(e) => setSaving(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSaving(null))}
              placeholder={t.conversation.versions.namePlaceholder}
              aria-label={t.conversation.versions.name}
              maxLength={200}
              className={inputClass}
            />
            <Button size="md" variant="primary" type="submit">
              {t.common.save}
            </Button>
            <Button size="md" variant="ghost" onClick={() => setSaving(null)}>
              {t.common.cancel}
            </Button>
          </form>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-16 rounded-xl" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title={t.conversation.versions.emptyTitle}>
            {t.conversation.versions.empty}
          </EmptyState>
        ) : (
          <ol className="relative space-y-1 px-2 py-3 xl:px-3">
            {entries.map((entry, i) => (
              <VersionItem
                key={entry.id}
                entry={entry}
                latest={i === 0}
                names={names}
                focused={entry.id === focus}
                sceneId={scene?.id ?? null}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function VersionItem(props: {
  entry: VersionEntry;
  latest: boolean;
  focused: boolean;
  names: Map<string, string>;
  sceneId: string | null;
}) {
  const { entry, latest, focused, names, sceneId } = props;
  const texts = useT().conversation.versions;
  const language = useStore((s) => s.language);
  const project = useStore((s) => s.project)!;
  const ref = useRef<HTMLLIElement>(null);
  const source = SOURCES[entry.source] ? entry.source : 'external';
  const Icon = SOURCES[source].icon;
  const sourceLabel = texts.sources[source];
  const touched = entry.scenes.map((id) => names.get(id) ?? id);

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => set({ focusVersion: null }), 2400);
    return () => clearTimeout(timer);
  }, [focused]);

  const restore = async (scene: string | null) => {
    const result = await api.restoreVersion(project.id, entry.id, scene);
    toast(scene ? texts.sceneRestored(names.get(scene) ?? scene, entry.id) : texts.projectRestored(entry.id), 'success');
    return result;
  };

  return (
    <li
      ref={ref}
      className={clsx(
        'group rounded-xl px-2.5 py-2.5 transition-colors',
        focused ? 'bg-white shadow-[inset_4px_0_0_0_var(--color-now)]' : 'hover:bg-wash',
      )}
    >
      <div className="flex gap-2.5">
        <span
          className={clsx('mt-0.5 grid size-7 shrink-0 place-items-center border-2 border-ink', SOURCES[source].tone)}
          title={sourceLabel}
        >
          <Icon className="size-3.5" aria-label={sourceLabel} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] leading-snug text-ink-2">{entry.label}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
            <span className="font-mono text-[11px] text-ink-4">{entry.id}</span>
            <span aria-hidden>·</span>
            <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString(language)}>
              {relative(entry.createdAt)}
            </time>
            {entry.costUsd !== undefined && entry.costUsd > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{usd(entry.costUsd)}</span>
              </>
            )}
            {latest && (
              <span className="rounded-md bg-ok/8 px-1.5 py-px text-[10.5px] font-medium text-ok ring-1 ring-ok/30 ring-inset">
                {texts.current}
              </span>
            )}
          </p>
          {touched.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              {touched.slice(0, 4).map((name) => (
                <span key={name} className="rounded-md bg-wash px-1.5 py-0.5 text-[11px] text-ink-2">
                  {name}
                </span>
              ))}
              {touched.length > 4 && <span className="px-1 text-[11px] text-ink-4">+{touched.length - 4}</span>}
            </p>
          )}
          {!latest && (
            <div className="mt-1 -ml-1.5 flex flex-wrap gap-0.5">
              {sceneId && (
                <ConfirmButton
                  size="xs"
                  variant="ghost"
                  label={texts.restoreScene}
                  confirmLabel={texts.restoreSceneConfirm(names.get(sceneId) ?? sceneId)}
                  icon={<RotateCcw className="size-3" />}
                  onConfirm={() => restore(sceneId)}
                />
              )}
              <ConfirmButton
                size="xs"
                variant="ghost"
                label={texts.restoreProject}
                confirmLabel={texts.restoreProjectConfirm}
                icon={<RotateCcw className="size-3" />}
                onConfirm={() => restore(null)}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
