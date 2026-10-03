// New brand: pick one of your GitHub or GitLab repositories (listed through the gh or glab CLI of this Mac) or paste its
// address, name the brand, then follow Claude while it builds the kit (server/brands/build.ts). Closing the window does
// not stop it.
import clsx from 'clsx';
import { Check, Lock, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BrandBuild, GitHost, RepoListing, RepoSummary } from '../../shared/types';
import { api, ignore } from '../api';
import { AgentPicker } from '../components/AgentPicker';
import { GIT_LOGOS } from '../components/logos';
import { BeatPills, Button, ConfirmButton, Field, Kbd, Modal, Segmented, Spinner, fieldBase } from '../components/ui';
import { useT } from '../i18n';
import { relative, usd } from '../lib/format';
import { useStore } from '../store';
import { closeModal, markBuildSeen, openModal, toast } from '../store/ui';

export function NewBrandModal({ buildId }: { buildId?: string }) {
  const [current, setCurrent] = useState(buildId ?? null);
  const build = useStore((s) => s.app?.brandBuilds.find((b) => b.id === current) ?? null);
  if (current && build) return <Progress build={build} onRestart={(next) => setCurrent(next.id)} />;
  return <PickRepo onStarted={(next) => setCurrent(next.id)} />;
}

/** The repository name as a brand name: "acme/orbit-app" gives "Orbit App". */
function brandName(fullName: string): string {
  const repo = fullName.split('/').pop() ?? '';
  return repo
    .replace(/\.git$/, '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

const HOSTS: Record<GitHost, { label: string; cli: string; install: string }> = {
  github: { label: 'GitHub', cli: 'gh', install: 'GitHub CLI' },
  gitlab: { label: 'GitLab', cli: 'glab', install: 'GitLab CLI' },
};

function PickRepo({ onStarted }: { onStarted: (build: BrandBuild) => void }) {
  const t = useT();
  const [host, setHost] = useState<GitHost>('github');
  const [listings, setListings] = useState<Partial<Record<GitHost, RepoListing>>>({});
  const listing = listings[host] ?? null;
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (listings[host]) return;
    const keep = (value: RepoListing) => setListings((all) => ({ ...all, [host]: value }));
    api.repos(host).then(keep, () => keep({ available: false, reason: 'error' }));
  }, [host, listings]);

  // A GitLab project goes by its address: owner/name alone means GitHub.
  const address = (r: RepoSummary) => (host === 'gitlab' ? r.url : r.fullName);
  const pick = (r: RepoSummary) => {
    setRepo(address(r));
    if (!named) setName(brandName(r.fullName));
  };
  const start = async () => {
    if (!repo.trim() || !name.trim()) return;
    setBusy(true);
    try {
      onStarted(await api.startBrandBuild({ repo: repo.trim(), name: name.trim() }));
    } catch {
      setBusy(false);
    }
  };
  const q = query.trim().toLowerCase();
  const repos = listing?.available
    ? listing.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q))
    : [];

  return (
    <Modal
      title={t.dialogs.newBrand.title}
      subtitle={t.dialogs.newBrand.subtitle}
      onClose={closeModal}
      width="max-w-[760px]"
      initialFocus={search}
      footer={
        <>
          <p className="mr-auto text-xs text-ink-3">
            {!repo.trim()
              ? t.dialogs.newBrand.needRepo
              : !name.trim()
                ? t.dialogs.newBrand.needName
                : t.dialogs.newBrand.duration}
          </p>
          <Button variant="ghost" onClick={closeModal}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!repo.trim() || !name.trim()} onClick={() => void start()}>
            {t.dialogs.newBrand.start}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h3 className="display-caps text-[15px] text-ink">{t.dialogs.newBrand.repo}</h3>
              <Segmented
                label={t.dialogs.newBrand.host}
                size="sm"
                value={host}
                onChange={setHost}
                options={(['github', 'gitlab'] as const).map((value) => {
                  const Logo = GIT_LOGOS[value];
                  return {
                    value,
                    label: (
                      <span className="flex items-center gap-1.5">
                        <Logo className="size-3.5" />
                        {HOSTS[value].label}
                      </span>
                    ),
                  };
                })}
              />
            </div>
            {listing?.available && <p className="text-xs text-ink-3">{t.dialogs.newBrand.account(listing.account)}</p>}
          </div>
          {!listing ? (
            <p className="flex items-center gap-2 border-2 border-ink bg-white px-3 py-4 text-[13px] text-ink-3">
              <Spinner /> {t.dialogs.newBrand.reading(HOSTS[host].label)}
            </p>
          ) : listing.available ? (
            <div className="border-2 border-ink bg-white">
              <label className="flex h-10 items-center gap-2 border-b-2 border-ink px-3">
                <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
                <input
                  ref={search}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t.dialogs.newBrand.searchPlaceholder}
                  aria-label={t.dialogs.newBrand.search}
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
                />
              </label>
              <ul className="max-h-64 divide-y divide-rule overflow-y-auto" aria-label={t.dialogs.newBrand.repos}>
                {repos.length === 0 && (
                  <li className="px-3 py-5 text-center text-[13px] text-ink-3">{t.dialogs.newBrand.noMatch}</li>
                )}
                {repos.map((r) => (
                  <li key={r.fullName}>
                    <RepoRow repo={r} selected={repo.trim() === address(r)} onPick={() => pick(r)} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Unavailable listing={listing} host={host} />
          )}
          <Field label={t.dialogs.newBrand.address} htmlFor="brand-repo">
            <input
              id="brand-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onBlur={() => !named && repo.includes('/') && setName(brandName(repo.trim()))}
              placeholder={t.dialogs.newBrand.addressPlaceholder}
              spellCheck={false}
              className={clsx(fieldBase, 'h-9 w-full font-mono text-[13px]')}
            />
          </Field>
        </section>
        <Field label={t.dialogs.newBrand.name} htmlFor="brand-name">
          <input
            id="brand-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNamed(true);
            }}
            placeholder={t.dialogs.newBrand.namePlaceholder}
            maxLength={60}
            className={clsx(fieldBase, 'h-9 w-full text-sm')}
          />
        </Field>
        <section className="space-y-2">
          <h3 className="display-caps text-[15px] text-ink">{t.profile.agents.title}</h3>
          <AgentPicker />
        </section>
      </form>
    </Modal>
  );
}

function RepoRow({ repo, selected, onPick }: { repo: RepoSummary; selected: boolean; onPick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={clsx(
        'focus-ring flex w-full items-center gap-3 px-3 py-2 text-left',
        selected ? 'bg-ink text-white' : 'hover:bg-wash',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{repo.fullName}</span>
        {repo.description && (
          <span className={clsx('block truncate text-xs', selected ? 'text-ink-4' : 'text-ink-3')}>{repo.description}</span>
        )}
      </span>
      {repo.private && (
        <span className={clsx('label-caps flex items-center gap-1 text-[10px]', selected ? 'text-ink-4' : 'text-ink-3')}>
          <Lock className="size-3" aria-hidden /> {t.dialogs.newBrand.private}
        </span>
      )}
      {repo.pushedAt && (
        <span className={clsx('shrink-0 text-xs', selected ? 'text-ink-4' : 'text-ink-3')}>{relative(repo.pushedAt)}</span>
      )}
      {selected && <Check className="size-4 shrink-0 text-now" aria-hidden />}
    </button>
  );
}

function Unavailable({ listing, host }: { listing: Extract<RepoListing, { available: false }>; host: GitHost }) {
  const t = useT();
  const { label, cli, install } = HOSTS[host];
  const login = <Kbd>{cli} auth login</Kbd>;
  return (
    <div className="space-y-1.5 border-2 border-dashed border-ink bg-paper/70 px-3 py-3 text-[13px] text-ink-2">
      <p>
        {listing.reason === 'missing'
          ? t.dialogs.newBrand.missing(install, <Kbd>brew install {cli}</Kbd>, login)
          : listing.reason === 'logged-out'
            ? t.dialogs.newBrand.loggedOut(install, login)
            : t.dialogs.newBrand.unreadable(label, listing.detail)}
      </p>
      <p className="text-xs text-ink-3">{t.dialogs.newBrand.pasteInstead}</p>
    </div>
  );
}

const STEPS: { id: 'copy' | 'build' | 'check' | 'ready'; statuses: BrandBuild['status'][] }[] = [
  { id: 'copy', statuses: ['queued', 'cloning'] },
  { id: 'build', statuses: ['building'] },
  { id: 'check', statuses: ['checking'] },
  { id: 'ready', statuses: ['done'] },
];

/** The kit sheet once the brand is ready: laid out at the box width over this scale, so it reflows to two columns. */
const BOARD_SCALE = 0.6;

function Progress({ build, onRestart }: { build: BrandBuild; onRestart: (build: BrandBuild) => void }) {
  const t = useT();
  const frameOrigin = useStore((s) => s.app?.frameOrigin ?? '');
  const live = !build.finishedAt;
  const step = STEPS.findIndex((s) => s.statuses.includes(build.status));
  const restart = async () => onRestart(await api.startBrandBuild({ repo: build.repo, name: build.name }).catch(() => build));
  // Seen here, a finished build leaves the top bar.
  useEffect(() => {
    if (build.finishedAt) markBuildSeen(build.id);
  }, [build.id, build.finishedAt]);
  const title =
    build.status === 'done'
      ? t.dialogs.newBrand.progress.ready(build.name)
      : build.status === 'error'
        ? t.dialogs.newBrand.progress.failed
        : build.status === 'cancelled'
          ? t.dialogs.newBrand.progress.cancelled
          : t.dialogs.newBrand.progress.building(build.name);

  return (
    <Modal
      title={title}
      subtitle={`${t.dialogs.newBrand.progress.from(build.repo)}${build.costUsd ? ` · ${usd(build.costUsd)}` : ''}`}
      onClose={closeModal}
      width="max-w-[760px]"
      footer={
        live ? (
          <>
            <p className="mr-auto text-xs text-ink-3">{t.dialogs.newBrand.progress.keepsRunning}</p>
            <ConfirmButton
              label={t.dialogs.newBrand.progress.cancel}
              confirmLabel={t.dialogs.newBrand.progress.cancelConfirm}
              variant="danger"
              size="md"
              onConfirm={() => api.cancelBrandBuild(build.id).catch(ignore)}
            />
            <Button onClick={closeModal}>{t.common.close}</Button>
          </>
        ) : build.status === 'done' ? (
          <>
            <ConfirmButton
              label={t.dialogs.newBrand.progress.delete}
              confirmLabel={t.dialogs.newBrand.progress.deleteConfirm}
              size="md"
              icon={<Trash2 className="size-4" />}
              className="mr-auto"
              onConfirm={async () => {
                await api.deleteBrand(build.brandId);
                closeModal();
                toast(t.dialogs.brandDeleted(build.name), 'info');
              }}
            />
            <Button variant="ghost" onClick={closeModal}>
              {t.common.close}
            </Button>
            <Button variant="primary" onClick={() => openModal({ kind: 'new-project', brand: build.brandId })}>
              {t.dialogs.newBrand.progress.newProject}
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto" />
            <Button variant="ghost" onClick={closeModal}>
              {t.common.close}
            </Button>
            <Button variant="primary" onClick={() => void restart()}>
              {t.dialogs.newBrand.progress.restart}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        <ol className="grid grid-cols-4 gap-2" aria-label={t.dialogs.newBrand.progress.stepsLabel}>
          {STEPS.map((s, i) => {
            const passed = build.status === 'done' || (step > i && live);
            const now = live && step === i;
            return (
              <li
                key={s.id}
                aria-current={now ? 'step' : undefined}
                className={clsx(
                  'flex items-center gap-2 border-2 px-2.5 py-2 text-[12.5px] font-semibold',
                  now ? 'border-ink bg-now text-ink' : passed ? 'border-ink bg-ink text-white' : 'border-track text-ink-4',
                )}
              >
                {passed ? <Check className="size-3.5 shrink-0" aria-hidden /> : now ? <BeatPills /> : null}
                {t.dialogs.newBrand.progress.steps[s.id]}
              </li>
            );
          })}
        </ol>

        {live && (
          <p className="flex items-center gap-2 text-[13px] text-ink-2" role="status">
            {build.activity ?? t.dialogs.newBrand.progress.waiting}
            <span className="ml-auto shrink-0 text-xs text-ink-3">
              {t.dialogs.newBrand.progress.started(relative(build.createdAt))}
            </span>
          </p>
        )}

        {build.status === 'error' && (
          <div className="space-y-2 border-2 border-ink bg-alert/10 px-3 py-3 text-[13px] text-ink">
            <p className="font-semibold">{build.error}</p>
            {build.problems && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                {build.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {build.summary && build.status === 'done' && (
          <p className="text-[13px]/5 whitespace-pre-line text-ink-2">{build.summary}</p>
        )}

        {build.status === 'done' && (
          <figure className="space-y-1.5">
            <div className="relative h-[360px] overflow-hidden border-2 border-ink bg-white">
              <iframe
                title={t.dialogs.newBrand.progress.board(build.name)}
                src={`${frameOrigin}/kit.html?brand=${encodeURIComponent(build.brandId)}&v=${encodeURIComponent(build.finishedAt ?? '')}`}
                // Own origin kept (it fetches the brand); no navigation, popups or forms.
                sandbox="allow-scripts allow-same-origin"
                className="absolute top-0 left-0 origin-top-left border-0"
                style={{ width: `${100 / BOARD_SCALE}%`, height: `${100 / BOARD_SCALE}%`, transform: `scale(${BOARD_SCALE})` }}
              />
            </div>
            <figcaption className="text-xs text-ink-3">{t.dialogs.newBrand.progress.boardCaption}</figcaption>
          </figure>
        )}

        {build.files.length > 0 && build.status !== 'cancelled' && (
          <details className="text-[13px] text-ink-2" open={live}>
            <summary className="cursor-pointer font-semibold text-ink">
              {t.dialogs.newBrand.progress.files(build.files.length)}
            </summary>
            <ul className="mt-1.5 max-h-36 overflow-y-auto font-mono text-xs text-ink-3">
              {build.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}
