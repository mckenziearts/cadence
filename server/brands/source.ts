// Where a brand comes from: a GitHub or GitLab repository, listed through the host's CLI already logged in on this machine
// (gh, glab) and copied with this machine's own Git access (the CLI's login, else git's SSH keys or keychain). Cadence
// keeps no token.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitAccount, RepoListing, RepoSummary } from '../../src/shared/types';
import type { BrandSource, RepoRef } from '../contracts';
import { m } from '../i18n';
import { HttpError } from '../util';

const CLONE_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 30_000;
/** gh's exit code when it has no login. */
const GH_AUTH_REQUIRED = 4;
/** glab has no dedicated exit code: what it prints without a login. */
const GLAB_AUTH_REQUIRED = /401|unauthori[sz]ed|auth login|not authenticated|no token/i;

/**
 * The repository in what people paste: owner/name (GitHub), https://github.com/owner/name[.git][/...],
 * git@github.com:owner/name.git, and the same on gitlab.com, where projects may sit in nested groups.
 */
export function parseRepo(input: string): RepoRef | null {
  const value = input.trim().replace(/\/+$/, '');
  const ssh = /^git@(github|gitlab)\.com:(.+)$/.exec(value);
  const web = /^(?:https:\/\/)?(?:www\.)?(github|gitlab)\.com\/(.+)$/i.exec(value);
  const bare = /^[^/\s:@]+\/[^/\s:@]+$/.test(value);
  const [host, rest] = ssh ? [ssh[1], ssh[2]] : web ? [web[1].toLowerCase(), web[2]] : bare ? ['github', value] : [];
  if (!rest) return null;
  const parts = rest.split('/');
  if (host === 'github') {
    // Anything after owner/name (tree/main/..., issues...) is ignored.
    const [owner = '', name = ''] = parts;
    const repo = name.replace(/\.git$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
    return { host: 'github', fullName: `${owner}/${repo}`, ssh: Boolean(ssh) };
  }
  // The project path ends where its pages start (/-/tree/main, /-/issues...).
  const end = parts.indexOf('-');
  const segments = end === -1 ? parts : parts.slice(0, end);
  segments.push(segments.pop()!.replace(/\.git$/, ''));
  if (segments.length < 2 || segments.length > 20) return null;
  if (!segments.every((segment) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(segment))) return null;
  return { host: 'gitlab', fullName: segments.join('/'), ssh: Boolean(ssh) };
}

interface Run {
  stdout: string;
  stderr: string;
}

class RunError extends Error {
  constructor(
    readonly code: number | string | null,
    readonly stderr: string,
  ) {
    super(stderr.trim().split('\n').at(-1) || `code ${code}`);
  }
}

/** Never wait for a password or passphrase: no terminal prompt, SSH in batch mode (unless the user set their own). */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GLAB_NO_PROMPT: '1',
    // Older glab (1.36) only reads this one; newer ones warn that it is deprecated.
    NO_PROMPT: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
}

function run(file: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: gitEnv(), timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        // A number when the command exited with an error, a string (ENOENT...) when it could not start.
        reject(new RunError((error as { code?: number | string }).code ?? null, stderr || error.message));
      },
    );
  });
}

/**
 * A shallow copy through the host's CLI, else plain git with this machine's own access (SSH keys, keychain) when the CLI
 * is missing or has no login. Claude reads the files, not the history: .git goes.
 */
async function cloneRepo(
  via: { cli: { bin: string; loggedOut: (e: RunError) => boolean }; git: string; host: string },
  repo: RepoRef,
  dest: string,
  signal: AbortSignal,
): Promise<void> {
  const shallow = ['--depth', '1', '--single-branch', '--no-tags'];
  try {
    try {
      await run(via.cli.bin, ['repo', 'clone', repo.fullName, dest, '--', ...shallow], { timeoutMs: CLONE_TIMEOUT_MS, signal });
    } catch (e) {
      if (!(e instanceof RunError) || (e.code !== 'ENOENT' && !via.cli.loggedOut(e))) throw e;
      await fs.rm(dest, { recursive: true, force: true });
      const url = repo.ssh ? `git@${via.host}:${repo.fullName}.git` : `https://${via.host}/${repo.fullName}.git`;
      await run(via.git, ['clone', ...shallow, url, dest], { timeoutMs: CLONE_TIMEOUT_MS, signal });
    }
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true });
    if (signal.aborted) throw e;
    throw new HttpError(502, m().media.brands.source.copyFailed(repo.fullName, (e as Error).message));
  }
  await fs.rm(path.join(dest, '.git'), { recursive: true, force: true });
}

interface GhRepo {
  full_name: string;
  description: string | null;
  private: boolean;
  pushed_at: string | null;
  html_url: string;
  homepage: string | null;
}

export class GitHubSource implements BrandSource {
  constructor(private readonly bins: { gh: string; git: string } = { gh: 'gh', git: 'git' }) {}

  async account(): Promise<GitAccount> {
    try {
      const user = await run(this.bins.gh, ['api', 'user', '--jq', '.login'], { timeoutMs: LIST_TIMEOUT_MS });
      return { available: true, account: user.stdout.trim() };
    } catch (e) {
      return ghUnavailable(e);
    }
  }

  async repos(): Promise<RepoListing> {
    try {
      const [user, list] = await Promise.all([
        run(this.bins.gh, ['api', 'user', '--jq', '.login'], { timeoutMs: LIST_TIMEOUT_MS }),
        run(this.bins.gh, ['api', 'user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member'], {
          timeoutMs: LIST_TIMEOUT_MS,
        }),
      ]);
      const repos = (JSON.parse(list.stdout) as GhRepo[]).map((r): RepoSummary => ({
        fullName: r.full_name,
        description: r.description || null,
        private: r.private,
        pushedAt: r.pushed_at ?? '',
        url: r.html_url,
        homepage: r.homepage || null,
      }));
      return { available: true, account: user.stdout.trim(), repos };
    } catch (e) {
      return ghUnavailable(e);
    }
  }

  fetch(repo: RepoRef, dest: string, signal: AbortSignal): Promise<void> {
    const cli = { bin: this.bins.gh, loggedOut: (e: RunError) => e.code === GH_AUTH_REQUIRED };
    return cloneRepo({ cli, git: this.bins.git, host: 'github.com' }, repo, dest, signal);
  }
}

function ghUnavailable(e: unknown): Extract<GitAccount, { available: false }> {
  if (e instanceof RunError && e.code === 'ENOENT') return { available: false, reason: 'missing' };
  if (e instanceof RunError && e.code === GH_AUTH_REQUIRED) return { available: false, reason: 'logged-out' };
  return { available: false, reason: 'error', detail: (e as Error).message };
}

interface GlabProject {
  path_with_namespace: string;
  description: string | null;
  visibility: 'private' | 'internal' | 'public';
  last_activity_at: string | null;
  web_url: string;
}

/** gitlab.com only: `--hostname` keeps glab from guessing the host from the remotes of the folder it runs in. */
export class GitLabSource implements BrandSource {
  constructor(private readonly bins: { glab: string; git: string } = { glab: 'glab', git: 'git' }) {}

  async account(): Promise<GitAccount> {
    try {
      const user = await this.api('user');
      return { available: true, account: (JSON.parse(user.stdout) as { username: string }).username };
    } catch (e) {
      return glabUnavailable(e);
    }
  }

  async repos(): Promise<RepoListing> {
    try {
      const [user, list] = await Promise.all([
        this.api('user'),
        this.api('projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&per_page=100'),
      ]);
      const repos = (JSON.parse(list.stdout) as GlabProject[]).map((p): RepoSummary => ({
        fullName: p.path_with_namespace,
        description: p.description || null,
        private: p.visibility !== 'public',
        pushedAt: p.last_activity_at ?? '',
        url: p.web_url,
        homepage: null,
      }));
      return { available: true, account: (JSON.parse(user.stdout) as { username: string }).username, repos };
    } catch (e) {
      return glabUnavailable(e);
    }
  }

  fetch(repo: RepoRef, dest: string, signal: AbortSignal): Promise<void> {
    const cli = { bin: this.bins.glab, loggedOut: (e: RunError) => GLAB_AUTH_REQUIRED.test(e.stderr) };
    return cloneRepo({ cli, git: this.bins.git, host: 'gitlab.com' }, repo, dest, signal);
  }

  private async api(endpoint: string): Promise<Run> {
    const result = await run(this.bins.glab, ['api', '--hostname', 'gitlab.com', endpoint], { timeoutMs: LIST_TIMEOUT_MS });
    // glab 1.36 (Ubuntu 24.04's) exits 0 on an HTTP error, the error body on stdout: only stderr tells.
    if (/\(HTTP \d{3}\)/.test(result.stderr)) throw new RunError(1, result.stderr);
    return result;
  }
}

function glabUnavailable(e: unknown): Extract<GitAccount, { available: false }> {
  if (e instanceof RunError && e.code === 'ENOENT') return { available: false, reason: 'missing' };
  if (e instanceof RunError && GLAB_AUTH_REQUIRED.test(e.stderr)) return { available: false, reason: 'logged-out' };
  return { available: false, reason: 'error', detail: (e as Error).message };
}
