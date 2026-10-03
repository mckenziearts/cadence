// Brand builds: copy a repository, let a restricted Claude turn make brands/<id>/ (a copy of the neutral kit) the
// product's kit, check it, then list it. One build at a time. The brand folder stays out of the brand list while it
// holds `.building`, and is removed if the build fails or is cancelled; the clone is always removed.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MODELS,
  agentPicks,
  type AgentId,
  type BrandBuild,
  type GitHost,
  type StartBrandBuildInput,
  type UsageCount,
} from '../../src/shared/types';
import { activityLabel } from '../agent/chat';
import { buildBrandGuide } from '../agent/guide';
import type {
  AgentProvider,
  AgentTurn,
  BrandBuildService,
  BrandSource,
  BrandStore,
  CadenceConfig,
  CaptureService,
  Hub,
  McpTokenIssuer,
  RepoRef,
  SettingsStore,
  UsageLog,
} from '../contracts';
import { language, m } from '../i18n';
import { BRAND_TOOLS } from '../mcp/brandTools';
import { BUILDING_MARKER } from '../store/brands';
import { NO_TOKENS, addedSince } from '../usage';
import { HttpError, isInside, nowIso, slugify, writeJsonAtomic } from '../util';
import { checkBrand } from './check';
import { parseRepo } from './source';

const TEMPLATE = 'cadence';
const MCP_PREFIX = 'mcp__cadence__';
const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
/** A build reads a whole repository and writes a dozen components: it may take a while. */
const TOKEN_TTL_MS = 6 * 3_600_000;

class BuildCancelled extends Error {}

class BrandIncomplete extends Error {
  constructor(readonly problems: string[]) {
    super(m().media.brands.build.incomplete);
  }
}

interface State {
  build: BrandBuild;
  repo: RepoRef;
  abort: AbortController;
  done: Promise<BrandBuild>;
  settle: (build: BrandBuild) => void;
  lastEmit: number;
  /** The agent that runs this build (set when its turn is built); its usage is recorded under it. */
  agent: AgentId;
  /** Running totals of the build's Claude Code session, as its last run reported them. */
  sessionUsage?: UsageCount;
}

export interface BrandBuilderDeps {
  config: CadenceConfig;
  brands: BrandStore;
  sources: Record<GitHost, BrandSource>;
  provider: AgentProvider;
  tokens: McpTokenIssuer;
  settings: SettingsStore;
  capture: Pick<CaptureService, 'kitSheet'>;
  hub: Hub;
  usage: UsageLog;
  diagnose: (file: string) => Promise<string | null>;
}

export class BrandBuilder implements BrandBuildService {
  private states = new Map<string, State>();
  private queue: State[] = [];
  private running = false;

  constructor(private readonly deps: BrandBuilderDeps) {}

  async start(input: StartBrandBuildInput): Promise<BrandBuild> {
    const repo = parseRepo(input.repo ?? '');
    if (!repo) throw new HttpError(400, m().media.brands.build.badRepo);
    const name = (input.name ?? '').trim();
    if (!name) throw new HttpError(400, m().media.brands.build.noName);
    const id = randomUUID();
    const brandId = await this.reserve(slugify(name, 'marque'), id);
    let settle!: (build: BrandBuild) => void;
    const done = new Promise<BrandBuild>((resolve) => (settle = resolve));
    const build: BrandBuild = {
      id,
      brandId,
      name,
      // owner/name stays GitHub when pasted again (« Recommencer »): GitLab keeps its host.
      repo: repo.host === 'gitlab' ? `gitlab.com/${repo.fullName}` : repo.fullName,
      status: 'queued',
      activity: null,
      files: [],
      costUsd: null,
      createdAt: new Date().toISOString(),
    };
    const state: State = { build, repo, abort: new AbortController(), done, settle, lastEmit: 0, agent: 'claude-code' };
    this.states.set(build.id, state);
    this.queue.push(state);
    this.emit(state, true);
    void this.pump();
    return { ...build };
  }

  cancel(id: string): void {
    const state = this.states.get(id);
    if (!state) throw new HttpError(404, m().media.brands.build.notFound);
    if (state.build.finishedAt) return;
    state.abort.abort(new BuildCancelled());
    const queued = this.queue.indexOf(state);
    if (queued === -1) return;
    this.queue.splice(queued, 1);
    void fs.rm(this.deps.brands.dir(state.build.brandId), { recursive: true, force: true });
    this.end(state, { status: 'cancelled' });
  }

  list(): BrandBuild[] {
    return [...this.states.values()].map((s) => ({ ...s.build, files: [...s.build.files] })).reverse();
  }

  wait(id: string): Promise<BrandBuild> {
    const state = this.states.get(id);
    if (!state) return Promise.reject(new HttpError(404, m().media.brands.build.notFound));
    return state.done;
  }

  /**
   * Builds of a Cadence that stopped mid-way leave their marked brand folder and their clone: remove them. Several
   * Cadence processes share brands/ (tests, a second server): the marker names its process, live ones are left alone.
   */
  async sweep(): Promise<void> {
    const { brandsDir, stateDir } = this.deps.config;
    for (const entry of await fs.readdir(brandsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const marker = await fs.readFile(path.join(brandsDir, entry.name, BUILDING_MARKER), 'utf8').catch(() => null);
      if (marker === null) continue;
      const [pid, buildId] = marker.trim().split(' ');
      if (alive(Number(pid))) continue;
      await fs.rm(path.join(brandsDir, entry.name), { recursive: true, force: true });
      if (/^[\w-]+$/.test(buildId ?? ''))
        await fs.rm(path.join(stateDir, 'brand-sources', buildId), { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    const open = [...this.states.values()].filter((s) => !s.build.finishedAt);
    for (const state of open) this.cancel(state.build.id);
    await Promise.all(open.map((s) => s.done));
  }

  /** A free brand id from `base`, its folder created at once (with the marker) so two builds never share it. */
  private async reserve(base: string, buildId: string): Promise<string> {
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base.slice(0, 60)}-${i}`;
      const dir = this.deps.brands.dir(id);
      try {
        await fs.mkdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      await fs.writeFile(path.join(dir, BUILDING_MARKER), `${process.pid} ${buildId}\n`);
      return id;
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) await this.run(next);
    } finally {
      this.running = false;
    }
  }

  private async run(state: State): Promise<void> {
    const { build, abort } = state;
    const { config, brands, sources, tokens } = this.deps;
    const brandDir = brands.dir(build.brandId);
    const repoDir = path.join(config.stateDir, 'brand-sources', build.id);
    let token: string | null = null;
    let outcome: Partial<BrandBuild>;
    try {
      this.patch(state, { status: 'cloning', activity: m().media.brands.build.cloning(build.repo) });
      await fs.mkdir(path.dirname(repoDir), { recursive: true });
      await sources[state.repo.host].fetch(state.repo, repoDir, abort.signal);
      await removeLinks(repoDir);
      this.stopIfCancelled(state);

      // The neutral kit with this brand's id and name: a valid brand from the first minute.
      await fs.cp(brands.dir(TEMPLATE), brandDir, { recursive: true });
      const file = JSON.parse(await fs.readFile(path.join(brandDir, 'brand.json'), 'utf8')) as Record<string, unknown>;
      await writeJsonAtomic(path.join(brandDir, 'brand.json'), { ...file, id: build.brandId, name: build.name });

      token = tokens.issue({ kind: 'brand', brandId: build.brandId, repoDir }, { ttlMs: TOKEN_TTL_MS });
      const turn = await this.turn(state, brandDir, repoDir, token);
      this.patch(state, { status: 'building', activity: m().media.brands.build.reading });
      await this.stream(state, brandDir, repoDir, {
        ...turn,
        prompt:
          `Construis la marque « ${build.name} » à partir du dépôt ${build.repo}, copié dans ${repoDir}. ` +
          `Le dossier ${brandDir} est une copie du kit neutre de Cadence : adapte chaque fichier au produit en suivant ` +
          'le guide, puis appelle check_brand jusqu’à ce qu’il ne signale plus rien.',
        resume: false,
      });

      this.patch(state, { status: 'checking', activity: m().media.brands.build.checking });
      let problems = await this.check(brandDir);
      this.stopIfCancelled(state);
      if (problems.length) {
        this.patch(state, { status: 'building', activity: m().media.brands.build.fixing });
        await this.stream(state, brandDir, repoDir, {
          ...turn,
          prompt:
            `La vérification finale de Cadence signale encore :\n- ${problems.join('\n- ')}\n\n` +
            `Corrige ces points, appelle check_brand jusqu’à ce qu’il ne signale plus rien, puis résume en ${language() === 'en' ? 'anglais' : 'français'} ce que tu as repris du dépôt et ce que tu as dû approcher.`,
          resume: true,
        });
        this.patch(state, { status: 'checking', activity: m().media.brands.build.checkingAgain });
        problems = await this.check(brandDir);
      }
      if (problems.length) throw new BrandIncomplete(problems);
      await fs.rm(path.join(brandDir, BUILDING_MARKER), { force: true });
      outcome = { status: 'done' };
    } catch (e) {
      await fs.rm(brandDir, { recursive: true, force: true });
      if (abort.signal.aborted || e instanceof BuildCancelled) outcome = { status: 'cancelled' };
      else if (e instanceof BrandIncomplete) outcome = { status: 'error', error: e.message, problems: e.problems };
      else outcome = { status: 'error', error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (token) tokens.revoke(token);
      await fs.rm(repoDir, { recursive: true, force: true });
    }
    // Only once everything is cleaned up: whoever waits for the build may look at the folders.
    this.end(state, outcome);
  }

  /** Reads the clone, the brands (examples) and the kit contract; writes the brand folder only. */
  private async turn(
    state: State,
    brandDir: string,
    repoDir: string,
    token: string,
  ): Promise<Omit<AgentTurn, 'prompt' | 'resume'>> {
    const { config } = this.deps;
    const settings = await this.deps.settings.get();
    state.agent = settings.agent;
    const picks = agentPicks(settings, 'project');
    const model = picks.model;
    const effort = MODELS.find((m) => m.id === model)?.supportsEffort === false ? null : picks.effort;
    const shared = path.join(config.root, 'src', 'shared');
    const rule = (tool: string, target: string) => `${tool}(//${target.replace(/^\/+/, '')})`;
    const pkg = JSON.parse(await fs.readFile(path.join(config.root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const fontsource = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@fontsource'));
    return {
      cwd: brandDir,
      systemPrompt: buildBrandGuide({
        REPO_DIR: repoDir,
        REPO: state.build.repo,
        BRAND_DIR: brandDir,
        BRAND_ID: state.build.brandId,
        BRAND_NAME: state.build.name,
        BRANDS_DIR: config.brandsDir,
        SHARED_DIR: shared,
        FONTSOURCE: fontsource.map((name) => `\`${name}\``).join(', '),
        // The summary shows in the editor, in its language.
        LANGUAGE: language() === 'en' ? 'English' : 'French',
      }),
      model,
      effort,
      tools: TOOLS,
      allow: [
        rule('Read', `${repoDir}/**`),
        rule('Read', `${config.brandsDir}/**`),
        rule('Read', `${shared}/**`),
        'Glob',
        'Grep',
        rule('Edit', `${brandDir}/**`),
        rule('Write', `${brandDir}/**`),
        ...BRAND_TOOLS.map((tool) => `${MCP_PREFIX}${tool}`),
      ],
      addDirs: [repoDir, config.brandsDir, shared],
      mcpServers: { cadence: { type: 'http', url: config.mcpUrl, headers: { Authorization: `Bearer ${token}` } } },
      sessionId: randomUUID(),
      signal: state.abort.signal,
    };
  }

  private async stream(state: State, brandDir: string, repoDir: string, turn: AgentTurn): Promise<void> {
    for await (const event of this.deps.provider.run(turn)) {
      if (event.type === 'tool-start') {
        const { name, input } = event;
        const tools: Record<string, string> = m().media.brands.build.tools;
        const label = name.startsWith(MCP_PREFIX)
          ? (tools[name.slice(MCP_PREFIX.length)] ?? name)
          : activityLabel(name, input, brandDir, repoDir);
        const written =
          name === 'Write' || name === 'Edit' ? input.file_path : name === `${MCP_PREFIX}copy_from_repo` ? input.to : null;
        const file = typeof written === 'string' ? path.resolve(brandDir, written) : null;
        const files = state.build.files;
        if (file && isInside(brandDir, file) && !files.includes(path.relative(brandDir, file))) {
          files.push(path.relative(brandDir, file));
        }
        this.patch(state, { activity: label });
      } else if (event.type === 'done') {
        // Claude Code reports a running session total (subtract the previous run); Codex reports this run's tokens, no cost.
        if (event.costUsd !== undefined || event.tokens) {
          const claude = state.agent === 'claude-code';
          const totals = { costUsd: event.costUsd ?? 0, tokens: event.tokens ?? NO_TOKENS };
          const spent = claude ? addedSince(totals, turn.resume ? state.sessionUsage : undefined) : totals;
          if (claude) {
            state.sessionUsage = totals;
            state.build.costUsd = (state.build.costUsd ?? 0) + spent.costUsd;
          }
          await this.deps.usage.record({
            at: nowIso(),
            agent: state.agent,
            kind: 'brand',
            brandId: state.build.brandId,
            ...spent,
          });
        }
        if (event.subtype === 'aborted' || state.abort.signal.aborted) throw new BuildCancelled();
        if (event.isError) throw new Error(event.text || m().media.brands.build.unfinished);
        if (event.text.trim()) state.build.summary = event.text.trim();
      }
    }
    this.stopIfCancelled(state);
  }

  private check(brandDir: string): Promise<string[]> {
    const { config, capture, diagnose } = this.deps;
    return checkBrand({ dir: brandDir, root: config.root, capture, diagnose });
  }

  private stopIfCancelled(state: State): void {
    if (state.abort.signal.aborted) throw new BuildCancelled();
  }

  private patch(state: State, patch: Partial<BrandBuild>): void {
    Object.assign(state.build, patch);
    this.emit(state, 'status' in patch);
  }

  private end(state: State, patch: Partial<BrandBuild>): void {
    Object.assign(state.build, { activity: null, ...patch, finishedAt: new Date().toISOString() });
    this.emit(state, true);
    state.settle({ ...state.build, files: [...state.build.files] });
  }

  /** Activity changes many times a second while Claude reads: at most one event per 100 ms unless the status moves. */
  private emit(state: State, force: boolean): void {
    const now = Date.now();
    if (!force && now - state.lastEmit < 100) return;
    state.lastEmit = now;
    this.deps.hub.send({ type: 'brand-build', build: { ...state.build, files: [...state.build.files] } });
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A repository may hold symbolic links to anywhere on the machine: none of them survives the copy. */
async function removeLinks(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) await fs.rm(path.join(entry.parentPath, entry.name), { force: true });
  }
}
