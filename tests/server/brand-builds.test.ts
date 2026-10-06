// Brand builds without gh, git or Claude: fake executables for the GitHub source, a fake agent and a fake kit sheet
// for the builder. The brand checks are the real ones.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { BrandBuilder } from '../../server/brands/build';
import { GitHubSource, GitLabSource, parseRepo } from '../../server/brands/source';
import type { AgentEvent, AgentProvider, AgentTurn, BrandSource, Hub, McpScope, RepoRef } from '../../server/contracts';
import { McpTokens } from '../../server/mcp/tokens';
import { FileSettingsStore } from '../../server/settings';
import { BUILDING_MARKER, FileBrandStore } from '../../server/store/brands';
import { FileUsageLog } from '../../server/usage';
import type { BrandBuild, GitHost, ServerEvent } from '../../src/shared/types';
import { makeRoot, rejectsWithStatus, type TestRoot } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('parseRepo takes what people paste and nothing else', () => {
  const github = (fullName: string, ssh = false) => ({ host: 'github' as const, fullName, ssh });
  const gitlab = (fullName: string, ssh = false) => ({ host: 'gitlab' as const, fullName, ssh });
  const cases: [string, ReturnType<typeof parseRepo>][] = [
    ['acme/site', github('acme/site')],
    ['https://github.com/acme/site', github('acme/site')],
    ['https://github.com/acme/site.git', github('acme/site')],
    ['github.com/Acme-Labs/my.site/tree/main/src', github('Acme-Labs/my.site')],
    ['  https://www.github.com/acme/site/  ', github('acme/site')],
    ['git@github.com:acme/site.git', github('acme/site', true)],
    ['https://gitlab.com/acme/site', gitlab('acme/site')],
    ['https://gitlab.com/acme/design/web-site.git', gitlab('acme/design/web-site')],
    ['gitlab.com/acme/design/site/-/tree/main/src', gitlab('acme/design/site')],
    ['git@gitlab.com:acme/design/site.git', gitlab('acme/design/site', true)],
    ['https://gitlab.com/acme', null],
    ['https://gitlab.com/acme/-site', null],
    ['https://gitlab.com/acme/../site', null],
    ['https://gitlab.example.com/acme/site', null],
    ['http://github.com/acme/site', null],
    ['ext::sh -c touch% /tmp/pwned', null],
    ['acme/..', null],
    ['-acme/site', null],
    ['acme', null],
    ['', null],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseRepo(input), expected, input);
});

let t: TestRoot;
let bin: string;

beforeEach(async () => {
  t = await makeRoot();
  bin = path.join(t.root, 'bin');
  await fs.mkdir(bin);
});
afterEach(() => t.cleanup());

/** An executable shell script standing in for gh or git. */
async function fake(name: string, script: string): Promise<string> {
  const file = path.join(bin, name);
  await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

const CLONE = 'dest="$1"; mkdir -p "$dest/.git" "$dest/src"; echo "body { color: red }" > "$dest/src/app.css"';

test('GitHubSource lists the repositories of the gh login, most recently pushed first as gh returns them', async () => {
  const repos = JSON.stringify([
    {
      full_name: 'acme/site',
      description: 'Le site',
      private: true,
      pushed_at: '2026-09-30T10:00:00Z',
      html_url: 'https://github.com/acme/site',
      homepage: 'https://acme.test',
    },
    {
      full_name: 'acme/api',
      description: '',
      private: false,
      pushed_at: null,
      html_url: 'https://github.com/acme/api',
      homepage: '',
    },
  ]);
  const gh = await fake('gh', `if [ "$2" = user ]; then echo ada; else echo '${repos}'; fi`);
  assert.deepEqual(await new GitHubSource({ gh, git: 'git' }).repos(), {
    available: true,
    account: 'ada',
    repos: [
      {
        fullName: 'acme/site',
        description: 'Le site',
        private: true,
        pushedAt: '2026-09-30T10:00:00Z',
        url: 'https://github.com/acme/site',
        homepage: 'https://acme.test',
      },
      {
        fullName: 'acme/api',
        description: null,
        private: false,
        pushedAt: '',
        url: 'https://github.com/acme/api',
        homepage: null,
      },
    ],
  });
  const loggedOut = await fake('gh-out', 'echo "To get started with GitHub CLI, please run: gh auth login" >&2; exit 4');
  assert.deepEqual(await new GitHubSource({ gh: loggedOut, git: 'git' }).repos(), { available: false, reason: 'logged-out' });
  const missing = path.join(bin, 'nowhere');
  assert.deepEqual(await new GitHubSource({ gh: missing, git: 'git' }).repos(), { available: false, reason: 'missing' });
});

test('GitHubSource copies with gh, falls back to git without gh or its login, and drops the history', async () => {
  const signal = new AbortController().signal;
  const gh = await fake('gh', `shift 3; ${CLONE}; echo "$@" > "$dest/args"`);
  const dest = path.join(t.root, 'clone-gh');
  await new GitHubSource({ gh, git: 'nowhere' }).fetch({ host: 'github', fullName: 'acme/site', ssh: false }, dest, signal);
  assert.equal((await fs.readFile(path.join(dest, 'args'), 'utf8')).trim(), `${dest} -- --depth 1 --single-branch --no-tags`);
  await assert.rejects(fs.access(path.join(dest, '.git')));

  const git = await fake('git', `for last; do :; done; url="$6"; set -- "$last"; ${CLONE}; echo "$url" > "$dest/url"`);
  for (const [gh2, ssh, url] of [
    [path.join(bin, 'nowhere'), false, 'https://github.com/acme/site.git'],
    [await fake('gh-out', 'exit 4'), true, 'git@github.com:acme/site.git'],
  ] as const) {
    const target = path.join(t.root, `clone-git-${ssh}`);
    await new GitHubSource({ gh: gh2, git }).fetch({ host: 'github', fullName: 'acme/site', ssh }, target, signal);
    assert.equal((await fs.readFile(path.join(target, 'url'), 'utf8')).trim(), url);
    assert.equal(await fs.readFile(path.join(target, 'src/app.css'), 'utf8'), 'body { color: red }\n');
  }

  const failing = await fake('gh-fail', 'echo "GraphQL: Could not resolve to a Repository" >&2; exit 1');
  await rejectsWithStatus(
    new GitHubSource({ gh: failing, git }).fetch(
      { host: 'github', fullName: 'acme/nope', ssh: false },
      path.join(t.root, 'x'),
      signal,
    ),
    502,
    /Impossible de copier acme\/nope : GraphQL: Could not resolve to a Repository/,
  );
});

test('GitLabSource lists the projects of the glab login on gitlab.com, nested groups included', async () => {
  const projects = JSON.stringify([
    {
      path_with_namespace: 'acme/design/site',
      description: 'Le site',
      visibility: 'private',
      last_activity_at: '2026-09-30T10:00:00Z',
      web_url: 'https://gitlab.com/acme/design/site',
    },
    {
      path_with_namespace: 'acme/api',
      description: '',
      visibility: 'public',
      last_activity_at: null,
      web_url: 'https://gitlab.com/acme/api',
    },
  ]);
  // glab api --hostname gitlab.com <endpoint>: never the host of the folder it runs in.
  const glab = await fake(
    'glab',
    `[ "$2 $3" = "--hostname gitlab.com" ] || exit 9; if [ "$4" = user ]; then echo '{"username":"ada"}'; else echo '${projects}'; fi`,
  );
  const source = new GitLabSource({ glab, git: 'git' });
  assert.deepEqual(await source.account(), { available: true, account: 'ada' });
  assert.deepEqual(await source.repos(), {
    available: true,
    account: 'ada',
    repos: [
      {
        fullName: 'acme/design/site',
        description: 'Le site',
        private: true,
        pushedAt: '2026-09-30T10:00:00Z',
        url: 'https://gitlab.com/acme/design/site',
        homepage: null,
      },
      {
        fullName: 'acme/api',
        description: null,
        private: false,
        pushedAt: '',
        url: 'https://gitlab.com/acme/api',
        homepage: null,
      },
    ],
  });
  // What glab prints without a login: 1.120 exits 1, 1.36 (Ubuntu 24.04's) exits 0.
  for (const exit of [1, 0]) {
    const loggedOut = await fake(
      `glab-out-${exit}`,
      `echo '{"message":"401 Unauthorized"}'; echo "glab: 401 Unauthorized (HTTP 401)" >&2; exit ${exit}`,
    );
    const source = new GitLabSource({ glab: loggedOut, git: 'git' });
    assert.deepEqual(await source.account(), { available: false, reason: 'logged-out' });
    assert.deepEqual(await source.repos(), { available: false, reason: 'logged-out' });
  }
  assert.deepEqual(await new GitLabSource({ glab: path.join(bin, 'nowhere'), git: 'git' }).repos(), {
    available: false,
    reason: 'missing',
  });
  const broken = await fake('glab-broken', 'echo "glab: connection refused" >&2; exit 1');
  assert.deepEqual(await new GitLabSource({ glab: broken, git: 'git' }).account(), {
    available: false,
    reason: 'error',
    detail: 'glab: connection refused',
  });
});

test('GitLabSource copies with glab, falls back to git without glab or its login, and drops the history', async () => {
  const signal = new AbortController().signal;
  const glab = await fake('glab', `shift 3; ${CLONE}; echo "$@" > "$dest/args"`);
  const dest = path.join(t.root, 'clone-glab');
  await new GitLabSource({ glab, git: 'nowhere' }).fetch(
    { host: 'gitlab', fullName: 'acme/design/site', ssh: false },
    dest,
    signal,
  );
  assert.equal((await fs.readFile(path.join(dest, 'args'), 'utf8')).trim(), `${dest} -- --depth 1 --single-branch --no-tags`);
  await assert.rejects(fs.access(path.join(dest, '.git')));

  const git = await fake('git', `for last; do :; done; url="$6"; set -- "$last"; ${CLONE}; echo "$url" > "$dest/url"`);
  for (const [glab2, ssh, url] of [
    [path.join(bin, 'nowhere'), false, 'https://gitlab.com/acme/design/site.git'],
    [await fake('glab-out', 'echo "glab: 401 Unauthorized" >&2; exit 1'), true, 'git@gitlab.com:acme/design/site.git'],
  ] as const) {
    const target = path.join(t.root, `clone-gl-${ssh}`);
    await new GitLabSource({ glab: glab2, git }).fetch({ host: 'gitlab', fullName: 'acme/design/site', ssh }, target, signal);
    assert.equal((await fs.readFile(path.join(target, 'url'), 'utf8')).trim(), url);
  }
});

// Builder

interface Fixture {
  builder: BrandBuilder;
  brands: FileBrandStore;
  tokens: McpTokens;
  usage: FileUsageLog;
  turns: AgentTurn[];
  scopes: (McpScope | null)[];
  events: ServerEvent[];
}

/** The real neutral kit as the template, Cadence's own node_modules for the font packages. */
async function builder(
  agent: (turn: AgentTurn, index: number) => AsyncIterable<AgentEvent>,
  copies: (RepoRef & { via: GitHost })[] = [],
): Promise<Fixture> {
  await fs.rm(path.join(t.config.brandsDir, 'cadence'), { recursive: true });
  await fs.cp(path.join(ROOT, 'brands', 'cadence'), path.join(t.config.brandsDir, 'cadence'), { recursive: true });
  const config = { ...t.config, root: ROOT };
  const brands = new FileBrandStore(config);
  const tokens = new McpTokens(config);
  const turns: AgentTurn[] = [];
  const scopes: (McpScope | null)[] = [];
  const events: ServerEvent[] = [];
  const source = (via: GitHost): BrandSource => ({
    account: async () => ({ available: false, reason: 'missing' }),
    repos: async () => ({ available: false, reason: 'missing' }),
    async fetch(repo, dest) {
      copies.push({ via, ...repo });
      await fs.mkdir(path.join(dest, 'public'), { recursive: true });
      await fs.writeFile(path.join(dest, 'public', 'logo.svg'), '<svg viewBox="0 0 10 10"></svg>');
      await fs.symlink('/etc/hosts', path.join(dest, 'public', 'hosts.svg'));
    },
  });
  const provider: AgentProvider = {
    id: 'fake',
    label: 'Agent factice',
    status: async () => ({ ok: true, label: 'Agent factice' }),
    run(turn) {
      turns.push(turn);
      const bearer = String((turn.mcpServers.cadence as { headers: Record<string, string> }).headers.Authorization);
      scopes.push(tokens.resolve(bearer.replace('Bearer ', '')));
      return agent(turn, turns.length - 1);
    },
  };
  const hub = { send: (event: ServerEvent) => void events.push(event), handleSse: () => undefined } as unknown as Hub;
  const capture = { kitSheet: async () => ({ image: Buffer.alloc(0), problems: [], loaded: true }) };
  const settings = new FileSettingsStore(config);
  const usage = new FileUsageLog(config);
  const instance = new BrandBuilder({
    config,
    brands,
    sources: { github: source('github'), gitlab: source('gitlab') },
    provider,
    tokens,
    settings,
    capture,
    hub,
    usage,
    diagnose: async () => null,
  });
  return { builder: instance, brands, tokens, usage, turns, scopes, events };
}

const done = (text: string, extra: Partial<Extract<AgentEvent, { type: 'done' }>> = {}): AgentEvent => ({
  type: 'done',
  text,
  isError: false,
  durationMs: 1,
  ...extra,
});

test('a build adapts the neutral kit in brands/<id>/ from the clone, checks it, then lists the brand', async () => {
  const fx = await builder(async function* (turn) {
    const repo = turn.addDirs[0]!;
    await assert.rejects(fs.lstat(path.join(repo, 'public', 'hosts.svg')), 'symbolic links are gone');
    assert.ok(!(await fx.brands.list()).some((b) => b.id === 'acme-studio'), 'hidden while it builds');
    yield { type: 'tool-start', id: '1', name: 'Read', input: { file_path: path.join(repo, 'public', 'logo.svg') } };
    const button = path.join(turn.cwd, 'ui', 'Button.tsx');
    yield { type: 'tool-start', id: '2', name: 'Edit', input: { file_path: button } };
    await fs.appendFile(button, '\n');
    yield {
      type: 'tool-start',
      id: '3',
      name: 'mcp__cadence__copy_from_repo',
      input: { from: 'public/logo.svg', to: 'assets/logo-mark.svg' },
    };
    yield done('Couleurs, polices et logo repris du dépôt.', { costUsd: 0.75 });
  });
  const started = await fx.builder.start({ repo: 'https://github.com/acme/site', name: ' Acme Studio ' });
  assert.deepEqual([started.brandId, started.name, started.repo], ['acme-studio', 'Acme Studio', 'acme/site']);
  const build = await fx.builder.wait(started.id);
  assert.equal(build.status, 'done', build.error ?? '');
  assert.deepEqual(build.files, ['ui/Button.tsx', 'assets/logo-mark.svg']);
  assert.equal(build.summary, 'Couleurs, polices et logo repris du dépôt.');
  assert.equal(build.costUsd, 0.75);

  const dir = fx.brands.dir('acme-studio');
  const listed = (await fx.brands.list()).find((b) => b.id === 'acme-studio');
  assert.equal(listed?.name, 'Acme Studio');
  await assert.rejects(fs.access(path.join(dir, BUILDING_MARKER)));
  await assert.rejects(fs.access(path.join(t.config.stateDir, 'brand-sources', build.id)), 'the clone is removed');

  const [turn] = fx.turns;
  assert.equal(turn.cwd, dir);
  const writes = turn.allow.filter((rule) => /^(Write|Edit)\(/.test(rule));
  assert.deepEqual(writes, [`Edit(/${dir}/**)`, `Write(/${dir}/**)`]);
  assert.deepEqual(turn.deny, [`Read(/${t.config.stateDir}/accounts.json)`, `Read(/${t.config.stateDir}/elevenlabs.json)`]);
  assert.deepEqual(fx.scopes, [{ kind: 'brand', brandId: 'acme-studio', repoDir: turn.addDirs[0] }]);
  assert.equal(fx.tokens.resolve(/Bearer (\S+)/.exec(JSON.stringify(turn.mcpServers))![1]), null, 'the token is revoked');
  const statuses = fx.events.map((e) => (e as { build: BrandBuild }).build.status);
  assert.deepEqual([...new Set(statuses)], ['queued', 'cloning', 'building', 'checking', 'done']);
});

test('a brand still incomplete after the fix turn ends in error, and its folder goes', async () => {
  const fx = await builder(async function* (turn, index) {
    if (index === 0) {
      const file = path.join(turn.cwd, 'brand.json');
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as { colors: Record<string, string> };
      json.colors.accent = '#FF0000';
      await fs.writeFile(file, JSON.stringify(json));
    }
    yield done(index === 0 ? 'Fini.' : 'Corrigé.');
  });
  const started = await fx.builder.start({ repo: 'acme/site', name: 'Acme' });
  const build = await fx.builder.wait(started.id);
  assert.equal(build.status, 'error');
  assert.ok(
    build.problems?.some((p) => p.includes('colors.accent')),
    JSON.stringify(build.problems),
  );
  assert.equal(fx.turns.length, 2);
  assert.equal(fx.turns[1].resume, true);
  assert.equal(fx.turns[1].sessionId, fx.turns[0].sessionId);
  assert.match(fx.turns[1].prompt, /colors\.accent/);
  await assert.rejects(fs.access(fx.brands.dir('acme')));
});

test('the fix turn resumes the session: the build and the usage log count only what it added', async () => {
  // Claude Code reports the session's running totals: the fix turn's include the first turn's.
  const totals = [
    { costUsd: 0.4, tokens: { input: 20, output: 3000, cacheRead: 90_000, cacheWrite: 12_000 } },
    { costUsd: 0.65, tokens: { input: 30, output: 4500, cacheRead: 150_000, cacheWrite: 15_000 } },
  ];
  const fx = await builder(async function* (turn, index) {
    if (index === 0) {
      const file = path.join(turn.cwd, 'brand.json');
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as { colors: Record<string, string> };
      json.colors.accent = '#FF0000';
      await fs.writeFile(file, JSON.stringify(json));
    }
    yield done(index === 0 ? 'Fini.' : 'Corrigé.', totals[index]);
  });
  const started = await fx.builder.start({ repo: 'acme/site', name: 'Acme' });
  const build = await fx.builder.wait(started.id);
  assert.equal(fx.turns[1].resume, true);
  assert.equal(build.costUsd, 0.65);
  const usage = await fx.usage.summary();
  assert.deepEqual(usage.brands, { runs: 2, ...totals[1] }, 'a failed build still counts what it used');
  assert.equal(usage.chats.runs, 0);
});

test('cancelling a build stops Claude and removes the brand folder and the clone', async () => {
  const fx = await builder(async function* (turn) {
    yield { type: 'tool-start', id: '1', name: 'Glob', input: { pattern: '**/*.css' } };
    await new Promise((resolve) => turn.signal.addEventListener('abort', resolve, { once: true }));
    yield done('Arrêté.', { subtype: 'aborted' });
  });
  const started = await fx.builder.start({ repo: 'acme/site', name: 'Acme' });
  for (let i = 0; i < 200 && fx.builder.list()[0].status !== 'building'; i++) await new Promise((r) => setTimeout(r, 10));
  fx.builder.cancel(started.id);
  const build = await fx.builder.wait(started.id);
  assert.equal(build.status, 'cancelled');
  await assert.rejects(fs.access(fx.brands.dir('acme')));
  await assert.rejects(fs.access(path.join(t.config.stateDir, 'brand-sources', build.id)));
});

test('builds refuse unknown repositories and blank names, and never share a brand id', async () => {
  const fx = await builder(async function* () {
    yield done('Fini.');
  });
  await rejectsWithStatus(fx.builder.start({ repo: 'https://bitbucket.org/acme/site', name: 'Acme' }), 400, /Dépôt non reconnu/);
  await rejectsWithStatus(fx.builder.start({ repo: 'acme/site', name: '   ' }), 400);
  const first = await fx.builder.start({ repo: 'acme/site', name: 'Cadence' });
  const second = await fx.builder.start({ repo: 'acme/site', name: 'Cadence' });
  assert.deepEqual([first.brandId, second.brandId], ['cadence-2', 'cadence-3']);
  for (const build of [first, second]) assert.equal((await fx.builder.wait(build.id)).status, 'done');
});

test('sweep removes what a stopped Cadence left building, never a live build', async () => {
  const fx = await builder(async function* () {
    yield done('Fini.');
  });
  const leftover = (name: string, pid: number) =>
    fs
      .mkdir(path.join(t.config.brandsDir, name), { recursive: true })
      .then(() => fs.writeFile(path.join(t.config.brandsDir, name, BUILDING_MARKER), `${pid} build-${name}\n`));
  await leftover('dead', 2 ** 22 + 17);
  await leftover('live', process.pid);
  await fs.mkdir(path.join(t.config.stateDir, 'brand-sources', 'build-dead'), { recursive: true });
  await fx.builder.sweep();
  await assert.rejects(fs.access(path.join(t.config.brandsDir, 'dead')));
  await assert.rejects(fs.access(path.join(t.config.stateDir, 'brand-sources', 'build-dead')));
  await fs.access(path.join(t.config.brandsDir, 'live'));
});

test('a gitlab.com address is copied by the GitLab source and keeps its host', async () => {
  const copies: (RepoRef & { via: GitHost })[] = [];
  const fx = await builder(async function* () {
    yield done('Fini.');
  }, copies);
  const started = await fx.builder.start({ repo: 'https://gitlab.com/acme/design/site/-/tree/main', name: 'Acme GitLab' });
  assert.equal(started.repo, 'gitlab.com/acme/design/site');
  await fx.builder.wait(started.id);
  assert.deepEqual(copies, [{ via: 'gitlab', host: 'gitlab', fullName: 'acme/design/site', ssh: false }]);
  await rejectsWithStatus(fx.builder.start({ repo: 'https://bitbucket.org/acme/site', name: 'X' }), 400, /Dépôt non reconnu/);
});

test('GitHubSource never waits for a password', async () => {
  const gh = await fake('gh', 'echo "$GIT_TERMINAL_PROMPT $GH_PROMPT_DISABLED $GIT_LFS_SKIP_SMUDGE" >&2; exit 1');
  const dest = path.join(os.tmpdir(), `cadence-never-${process.pid}`);
  await rejectsWithStatus(
    new GitHubSource({ gh, git: 'git' }).fetch(
      { host: 'github', fullName: 'acme/site', ssh: false },
      dest,
      new AbortController().signal,
    ),
    502,
    /: 0 1 1$/,
  );
});
