// Projects home: one card per project (a frame of its first scene), search and brand filter; the pitch before the first.
import clsx from 'clsx';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BrandSummary, ProjectSummary } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { relative, secsLabel } from '../lib/format';
import { NONE, useStore } from '../store';
import { openModal, toast } from '../store/ui';
import { AGENTS } from './agents';
import { BrandMark, Logo } from './TopBar';
import { Button, ConfirmButton, Segmented, fieldBase } from './ui';

/** Brand filter value for every project (brand ids are folder names, never "*"). */
const ALL = '*';

const brandOf = (project: ProjectSummary) => project.brand ?? 'cadence';

export function Home() {
  const t = useT();
  const projects = useStore((s) => s.app?.projects ?? NONE);
  const brands = useStore((s) => s.app?.brands ?? NONE);
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState(ALL);

  const counts = useMemo(() => {
    const byBrand = new Map<string, number>();
    for (const p of projects) byBrand.set(brandOf(p), (byBrand.get(brandOf(p)) ?? 0) + 1);
    return byBrand;
  }, [projects]);

  if (projects.length === 0) return <Pitch brands={brands} />;

  const nameOf = (id: string) => brands.find((b) => b.id === id)?.name ?? id;
  const q = query.trim().toLowerCase();
  const shown = projects.filter(
    (p) => (brand === ALL || brandOf(p) === brand) && (!q || p.name.toLowerCase().includes(q) || p.id.includes(q)),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-grid-fade">
      <div className="mx-auto max-w-[92rem] px-6 py-10">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="mr-auto">
            <h1 className="display-caps text-5xl/none text-ink">{t.shell.projects.title}</h1>
            <p className="mt-2 text-[13px] text-ink-3">
              {t.shell.home.projects(projects.length)} · {t.shell.home.brands(counts.size)}
            </p>
          </div>
          <label className={clsx(fieldBase, 'flex h-10 w-80 items-center gap-2 focus-within:border-now')}>
            <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.shell.projects.searchPlaceholder}
              aria-label={t.shell.projects.search}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-4"
            />
          </label>
        </div>
        {counts.size > 1 && (
          <Segmented
            label={t.shell.home.brandFilter}
            size="sm"
            value={brand}
            onChange={setBrand}
            className="mt-5 flex-wrap"
            options={[
              { value: ALL, label: <Count label={t.shell.home.all} n={projects.length} /> },
              ...[...counts]
                .sort(([a], [b]) => nameOf(a).localeCompare(nameOf(b), 'fr'))
                .map(([id, n]) => ({ value: id, label: <Count label={nameOf(id)} n={n} /> })),
            ]}
          />
        )}
        <ul className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6">
          <li>
            <button
              type="button"
              onClick={() => openModal({ kind: 'new-project' })}
              className="focus-ring flex size-full min-h-64 flex-col items-center justify-center gap-2 border-2 border-dashed border-ink bg-paper/70 p-6 text-ink hover:bg-white"
            >
              <span className="mb-1 grid size-11 place-items-center border-2 border-ink bg-now shadow-hard-sm">
                <Plus className="size-5" />
              </span>
              <span className="display-caps text-[22px]/7">{t.shell.projects.new}</span>
              <span className="text-xs text-ink-3">{t.shell.home.newHint}</span>
            </button>
          </li>
          {shown.map((p) => (
            <li key={p.id} className="group relative">
              <ProjectCard project={p} brand={brands.find((b) => b.id === brandOf(p))} />
              <DeleteProject project={p} />
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="mt-6 text-[13px] text-ink-3">{t.shell.home.noMatch(query.trim())}</p>}
      </div>
    </div>
  );
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <>
      {label} <span className="opacity-60">{n}</span>
    </>
  );
}

function ProjectCard({ project, brand }: { project: ProjectSummary; brand: BrandSummary | undefined }) {
  const t = useT();
  const edited = relative(project.updatedAt);
  return (
    <a
      href={`#/${encodeURIComponent(project.id)}`}
      className="focus-ring press flex size-full flex-col border-2 border-ink bg-white hover:bg-wash"
    >
      <Cover project={project} />
      <span className="flex flex-1 flex-col px-3.5 pt-3 pb-3.5">
        <span className="label-caps flex items-center gap-1.5 text-[10px] text-ink-3">
          <BrandMark brand={brand} className="size-4" />
          {brand?.name ?? t.shell.projects.noBrand}
        </span>
        <span className="display-caps mt-1.5 text-[22px]/7 text-ink">{project.name}</span>
        <span className="mt-1 text-xs text-ink-3">
          {project.formats.join(', ')} · {secsLabel(project.duration, 1)} · {t.shell.projects.scenes(project.sceneCount)}
        </span>
        <span className="text-xs text-ink-3">{t.shell.home.edited(edited)}</span>
      </span>
    </a>
  );
}

/** Over the cover, on hover or keyboard focus: a link cannot hold a button, so it sits next to the card. */
function DeleteProject({ project }: { project: ProjectSummary }) {
  const t = useT();
  return (
    <div className="absolute top-2.5 right-2.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
      <ConfirmButton
        variant="secondary"
        iconOnly
        label={t.shell.home.delete(project.name)}
        confirmLabel={t.shell.home.deleteConfirm}
        icon={<Trash2 className="size-3.5" />}
        onConfirm={async () => {
          await api.deleteProject(project.id);
          toast(t.shell.home.deleted(project.name), 'info');
        }}
      />
    </div>
  );
}

/** The middle of the first scene in the first format; the graph paper stays while it renders or if it fails. */
function Cover({ project }: { project: ProjectSummary }) {
  const epoch = useStore((s) => s.thumbEpoch);
  const [broken, setBroken] = useState<string | null>(null);
  const url = project.cover && api.thumbnailUrl(project.id, project.cover, project.formats[0], `${project.updatedAt}-${epoch}`);
  return (
    <span className="relative block aspect-video overflow-hidden border-b-2 border-ink bg-stage bg-grid">
      {url && broken !== url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setBroken(url)}
          className="absolute inset-0 size-full object-contain"
        />
      )}
    </span>
  );
}

/** Before the first project: what Cadence does, and a start from each brand. */
function Pitch({ brands }: { brands: BrandSummary[] }) {
  const t = useT();
  const picker = useStore((s) => s.app?.features.agentPicker ?? true);
  const agent = useStore((s) => s.app?.settings.agent ?? 'claude-code');
  // A host that hides the agent choice runs one agent: the pitch names that one.
  const names = AGENTS.filter((a) => (picker ? !a.soon : a.id === agent)).map((a) => a.name);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-grid-fade">
      <div className="mx-auto max-w-3xl px-8 py-16">
        <Logo className="size-11" />
        <h1 className="display-caps mt-8 text-5xl/[1.05] text-balance text-ink">
          {t.shell.home.pitch.title(<AgentNames names={names} />)}
        </h1>
        <p className="mt-5 max-w-xl text-[15px]/6 text-pretty text-ink-2">{t.shell.home.pitch.body}</p>
        <Button
          variant="primary"
          size="lg"
          className="mt-7"
          icon={<Plus className="size-4" />}
          onClick={() => openModal({ kind: 'new-project' })}
        >
          {t.shell.home.pitch.create}
        </Button>
        {brands.length > 0 && (
          <section className="mt-14">
            <h2 className="display-caps text-[22px]/7 text-ink">{t.shell.home.pitch.brands}</h2>
            <ul className="mt-4 grid grid-cols-3 gap-5">
              {brands.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => openModal({ kind: 'new-project', brand: b.id })}
                    className="focus-ring press group w-full overflow-hidden border-2 border-ink bg-white text-left hover:bg-wash"
                  >
                    <span
                      className="flex h-24 items-center justify-center border-b-2 border-ink"
                      style={{ background: b.colors.background }}
                    >
                      <BrandMark brand={b} className="size-10 transition-transform group-hover:-translate-y-0.5" />
                    </span>
                    <span className="block px-3.5 py-3">
                      <span className="flex items-center gap-2">
                        <span className="display-caps text-[17px] text-ink">{b.name}</span>
                        <span className="ml-auto flex gap-1" aria-hidden>
                          {[b.colors.primary, b.colors.accent, b.colors.ink].map((c, i) => (
                            <span key={i} className="size-3 border border-ink" style={{ background: c }} />
                          ))}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-3">{b.tagline}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * The agents a video can be written with, one after the other in the same box, so the line never reflows. One round of
 * 2 s turns, back to the first, then still: motion past 5 s needs a pause control (WCAG 2.2.2), which a third name would
 * reach. Screen readers and reduced motion get them all at once.
 */
function AgentNames({ names }: { names: string[] }) {
  const language = useStore((s) => s.language);
  const [still] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [turn, setTurn] = useState(0);
  const rotates = !still && names.length > 1;

  useEffect(() => {
    if (!rotates || turn === names.length) return;
    const id = setTimeout(() => setTurn(turn + 1), 2000);
    return () => clearTimeout(id);
  }, [rotates, turn, names.length]);

  const all = new Intl.ListFormat(language, { type: 'disjunction' }).format(names);
  if (!rotates) return all;
  const shown = turn % names.length;
  return (
    <>
      <span className="sr-only">{all}</span>
      <span aria-hidden className="inline-grid">
        {names.map((name, i) => (
          // The scenes' SwapWords: the outgoing name lifts away, the next one rises from behind a mask under the line. The
          // mask closes on the line box (SwapWords leaves room for descenders): capitals have none, the next line starts there.
          <span key={name} className="[grid-area:1/1] [clip-path:inset(-1em_-0.15em_0_-0.15em)]">
            <span
              className={clsx(
                'inline-block',
                i === shown ? turn > 0 && 'animate-word-in' : i === (turn - 1) % names.length ? 'animate-word-out' : 'opacity-0',
              )}
            >
              {name}
            </span>
          </span>
        ))}
      </span>
    </>
  );
}
