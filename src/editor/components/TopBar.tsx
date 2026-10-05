// Top bar: home link, project switcher, new project, Scènes | Rendu, brand builds, brand, art direction, path, cost, present,
// settings.
import clsx from 'clsx';
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  CircleUserRound,
  Copy,
  Maximize,
  Palette,
  Plus,
  Search,
  Settings,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { BrandBuild, BrandSummary, ProjectSummary } from '../../shared/types';
import { useT } from '../i18n';
import { secsLabel, usd } from '../lib/format';
import { set, useStore, NONE } from '../store';
import { openProject, PROFILE_PAGE } from '../store/project';
import { copyText, openModal } from '../store/ui';
import { ignore } from '../api';
import { BrandPanel } from './BrandPanel';
import { BeatPills, Button, IconButton, Popover, Segmented, Tooltip } from './ui';

/** The Cadence mark (same drawing as brands/cadence/assets/logo-mark.svg): clips on a timeline, crossed by the playhead. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 160" className={className} aria-hidden>
      <rect width="160" height="160" rx="42" fill="#18181b" />
      <rect x="28" y="49" width="62" height="18" rx="9" fill="#fff" />
      <rect x="50" y="75" width="82" height="18" rx="9" fill="#fff" />
      <rect x="36" y="101" width="56" height="18" rx="9" fill="#fff" />
      <rect x="101" y="40" width="5" height="88" rx="2.5" fill="#ff2e88" />
      <circle cx="103.5" cy="40" r="7.5" fill="#ff2e88" />
    </svg>
  );
}

export function TopBar() {
  const t = useT();
  const project = useStore((s) => s.project);
  const loading = useStore((s) => s.projectLoading);
  const view = useStore((s) => s.view);
  const page = useStore((s) => s.page);
  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b-2 border-ink bg-paper px-3">
      <Tooltip label={t.shell.topBar.home}>
        <a href="#/" aria-label={t.shell.topBar.homeLink} className="focus-ring flex items-center gap-2.5 pr-2 pl-1 text-ink">
          <Logo className="size-7" />
          <span className="display-caps text-[22px]/none">Cadence</span>
        </a>
      </Tooltip>
      {/* The home lists the projects and has its own "Nouveau projet". */}
      {(project || loading) && (
        <>
          <ProjectSwitcher />
          <IconButton
            label={t.shell.projects.new}
            icon={<Plus className="size-4" />}
            onClick={() => openModal({ kind: 'new-project' })}
          />
        </>
      )}
      {project && (
        <Segmented
          label={t.shell.topBar.view}
          accent
          value={view}
          onChange={(value) => set({ view: value, playing: false })}
          options={[
            { value: 'scenes', label: t.shell.topBar.scenes },
            { value: 'render', label: t.shell.topBar.render },
          ]}
          className="ml-3"
        />
      )}
      <div className="flex-1" />
      <BrandBuildChips />
      {project && (
        <div className="flex items-center gap-1">
          <BrandChip />
          <Tooltip label={t.shell.topBar.artDirectionHint}>
            <Button
              variant="ghost"
              icon={<Palette className="size-4" />}
              onClick={() => openModal({ kind: 'art' })}
              aria-label={t.shell.topBar.artDirection}
            >
              <span className="hidden min-[1380px]:inline">{t.shell.topBar.artDirection}</span>
            </Button>
          </Tooltip>
          <Tooltip label={t.shell.topBar.copyPathHint(project.dir)}>
            <Button
              variant="ghost"
              square
              icon={<Copy className="size-4" />}
              onClick={() => void copyText(project.dir, t.shell.topBar.pathCopied)}
              aria-label={t.shell.topBar.copyPath}
            />
          </Tooltip>
          <span className="mx-2 h-6 w-px bg-rule" aria-hidden />
          <CostPill />
          <Button
            variant="secondary"
            icon={<Maximize className="size-4" />}
            className="mx-2"
            onClick={() => {
              void document.documentElement.requestFullscreen?.().catch(() => undefined);
              set({ presenting: true, playing: false });
            }}
          >
            {t.shell.topBar.present}
          </Button>
        </div>
      )}
      <IconButton
        label={t.shell.topBar.profile}
        icon={<CircleUserRound className="size-4" />}
        active={page === PROFILE_PAGE}
        onClick={() => (location.hash = `#/${PROFILE_PAGE}`)}
      />
      <IconButton
        label={t.shell.topBar.settings}
        icon={<Settings className="size-4" />}
        onClick={() => openModal({ kind: 'settings' })}
      />
    </header>
  );
}

function CostPill() {
  const t = useT();
  const cost = useStore((s) => s.cost);
  const amount = cost === null ? null : usd(cost);
  return (
    <Tooltip label={t.shell.topBar.cost.hint}>
      <span
        tabIndex={0}
        className="focus-ring inline-flex h-8 items-center gap-2 border-2 border-ink bg-white px-2"
        aria-label={t.shell.topBar.cost.label(amount)}
      >
        <span className="label-caps text-[10px] text-ink-3">{t.shell.topBar.cost.title}</span>
        <span className="text-[13px] font-semibold text-ink">{amount ?? t.shell.topBar.cost.unknown}</span>
      </span>
    </Tooltip>
  );
}

/** Brand builds stay in sight on every screen: running ones, then finished ones until their window has shown them. */
function BrandBuildChips() {
  const builds = useStore((s) => s.app?.brandBuilds ?? NONE);
  const seen = useStore((s) => s.seenBuilds);
  return builds
    .filter((b) => !b.finishedAt || (b.status !== 'cancelled' && !seen.includes(b.id)))
    .map((b) => <BrandBuildChip key={b.id} build={b} />);
}

function BrandBuildChip({ build }: { build: BrandBuild }) {
  const t = useT();
  const live = !build.finishedAt;
  const done = build.status === 'done';
  const step = t.shell.topBar.build.steps[build.status];
  // The step over the name keeps the chip narrow; on a small screen the name gives way (min-w-0), never a button.
  return (
    <Tooltip
      label={live ? (build.activity ?? step) : done ? t.shell.topBar.build.open : t.shell.topBar.build.failed}
      className="min-w-0"
    >
      <button
        type="button"
        onClick={() => openModal({ kind: 'new-brand', buildId: build.id })}
        aria-label={t.shell.topBar.build.label(build.name, step)}
        className={clsx(
          'focus-ring inline-flex h-8 min-w-0 items-center gap-2 border-2 border-ink px-2 text-left font-semibold',
          done
            ? 'bg-ink text-white hover:bg-ink-2'
            : live
              ? 'bg-white text-ink hover:bg-wash'
              : 'bg-alert/10 text-ink hover:bg-alert/20',
        )}
      >
        {live ? (
          <BeatPills />
        ) : done ? (
          <Check className="size-3.5 shrink-0 text-now" aria-hidden />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-alert" aria-hidden />
        )}
        <span className="flex min-w-0 flex-col">
          <span
            className={clsx('label-caps truncate text-[9px]/[11px]', done ? 'text-ink-4' : live ? 'text-ink-3' : 'text-alert')}
          >
            {step}
          </span>
          <span className="max-w-40 truncate text-[12.5px]/[15px]">{build.name}</span>
        </span>
      </button>
    </Tooltip>
  );
}

function BrandChip() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const brands = useStore((s) => s.app?.brands ?? NONE);
  const [open, setOpen] = useState(false);
  const brand = brands.find((b) => b.id === (project.brand ?? 'cadence'));
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      label={t.shell.topBar.brand.label(brand?.name ?? '')}
      className="w-[440px] overflow-hidden"
      trigger={
        <Tooltip label={t.shell.topBar.brand.hint}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={clsx(
              'focus-ring inline-flex h-8 max-w-44 items-center gap-2 px-2 text-[13px] font-semibold text-ink',
              open ? 'bg-wash' : 'hover:bg-wash',
            )}
          >
            <BrandMark brand={brand} className="size-5" />
            <span className="truncate">{brand?.name ?? t.shell.projects.noBrand}</span>
          </button>
        </Tooltip>
      }
    >
      {open && brand && <BrandPanel key={brand.id} brandId={brand.id} />}
    </Popover>
  );
}

export function BrandMark({ brand, className }: { brand: BrandSummary | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!brand?.logoUrl || broken)
    return (
      <span
        className={clsx('inline-block shrink-0 border border-ink', className)}
        style={{ background: brand?.colors.primary ?? '#18181b' }}
        aria-hidden
      />
    );
  return (
    <img src={brand.logoUrl} alt="" className={clsx('shrink-0 object-contain', className)} onError={() => setBroken(true)} />
  );
}

// Project switcher

function ProjectSwitcher() {
  const t = useT();
  const project = useStore((s) => s.project);
  const loading = useStore((s) => s.projectLoading);
  const projects = useStore((s) => s.app?.projects ?? NONE);
  const brands = useStore((s) => s.app?.brands ?? NONE);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const brand = brands.find((b) => b.id === (project?.brand ?? 'cadence'));

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q));
    const byBrand = new Map<string, ProjectSummary[]>();
    for (const p of matches) {
      const key = p.brand ?? 'cadence';
      byBrand.set(key, [...(byBrand.get(key) ?? []), p]);
    }
    return [...byBrand.entries()]
      .map(([id, items]) => ({ brand: brands.find((b) => b.id === id), id, items }))
      .sort((a, b) => (a.brand?.name ?? a.id).localeCompare(b.brand?.name ?? b.id, 'fr'));
  }, [projects, brands, query]);
  const flat = groups.flatMap((g) => g.items);

  const choose = (id: string) => {
    setOpen(false);
    setQuery('');
    if (id !== project?.id) void openProject(id).catch(ignore);
  };

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      label={t.shell.projects.title}
      className="w-[340px]"
      trigger={
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setActive(
              Math.max(
                0,
                flat.findIndex((p) => p.id === project?.id),
              ),
            );
          }}
          className="focus-ring press inline-flex h-8 w-[240px] items-center gap-2 border-2 border-ink bg-white pr-2 pl-1.5 text-left hover:bg-wash xl:w-[300px]"
        >
          {project && <BrandMark brand={brand} className="size-5" />}
          <span className={clsx('min-w-0 flex-1 truncate text-[13px] font-semibold', project ? 'text-ink' : 'text-ink-3')}>
            {project?.name ?? (loading ? t.shell.projectSwitcher.loading : t.shell.projectSwitcher.choose)}
          </span>
          {project && brand && <span className="shrink-0 truncate text-xs text-ink-3">{brand.name}</span>}
          <ChevronsUpDown className="size-4 shrink-0 text-ink" />
        </button>
      }
    >
      <div className="flex items-center gap-2 border-b-2 border-ink px-3">
        <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const next = Math.min(flat.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1)));
              setActive(next);
              list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && flat[active]) {
              e.preventDefault();
              choose(flat[active].id);
            }
          }}
          placeholder={t.shell.projects.searchPlaceholder}
          aria-label={t.shell.projects.search}
          role="combobox"
          aria-expanded="true"
          aria-controls="project-list"
          aria-activedescendant={flat[active] ? `project-${flat[active].id}` : undefined}
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>
      <ul
        ref={list}
        id="project-list"
        role="listbox"
        aria-label={t.shell.projects.title}
        className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5"
      >
        {flat.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">{t.shell.projectSwitcher.noMatch}</li>}
        {groups.map((group) => (
          <li key={group.id} role="presentation" className="mb-1 last:mb-0">
            <div className="label-caps flex items-center gap-2 px-2 pt-1.5 pb-1 text-[10px] text-ink-3">
              <span
                className="size-2 border border-ink"
                style={{ background: group.brand?.colors.primary ?? '#a19b8f' }}
                aria-hidden
              />
              {group.brand?.name ?? group.id}
            </div>
            <ul role="group">
              {group.items.map((p) => {
                const index = flat.indexOf(p);
                const current = p.id === project?.id;
                return (
                  <li
                    key={p.id}
                    id={`project-${p.id}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => choose(p.id)}
                    className={clsx('flex cursor-pointer items-center gap-2 px-2 py-1.5', index === active && 'bg-wash')}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-ink">{p.name}</p>
                      <p className="truncate text-xs text-ink-3">
                        {t.shell.projects.scenes(p.sceneCount)} · {secsLabel(p.duration, 1)} · {p.formats.join(', ')}
                      </p>
                    </div>
                    {current && (
                      <Check className="size-4 shrink-0 text-now-strong" aria-label={t.shell.projectSwitcher.current} />
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <div className="border-t-2 border-ink p-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            openModal({ kind: 'new-project' });
          }}
          className="focus-ring label-caps flex w-full items-center gap-2 px-2 py-1.5 text-[11px] text-ink hover:bg-wash"
        >
          <Plus className="size-4" /> {t.shell.projects.new}
        </button>
      </div>
    </Popover>
  );
}
