// Small helpers shared by every server module. Keep this file dependency-free (messages aside).
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ID_PATTERN } from '../src/shared/types';
import { language, m } from './i18n';

const execFileAsync = promisify(execFile);

/**
 * Write through a temp file + rename so readers never see a half-written file. `mkdir: false` writes only into a folder
 * that is still there (ENOENT otherwise): a cache never brings a deleted project back.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  mode?: number,
  { mkdir = true }: { mkdir?: boolean } = {},
): Promise<void> {
  if (mkdir) await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpFile(file);
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

/** `fallback` only when the file does not exist: an unreadable file is an error, never something the next write replaces. */
export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new HttpError(500, m().api.unreadableFile(file, (e as Error).message));
  }
}

export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read a file an agent turn can write without following a symlink: its sandbox lets it swap the file, or a folder on the
 * way, for a link to one it may not read, such as accounts.json, and the server would carry that content back into a
 * prompt or a version. A link anywhere below `root` is refused (ELOOP or ENOTDIR).
 */
export async function readFileNoFollow(root: string, file: string): Promise<Buffer>;
export async function readFileNoFollow(root: string, file: string, encoding: 'utf8'): Promise<string>;
export async function readFileNoFollow(root: string, file: string, encoding?: 'utf8'): Promise<Buffer | string> {
  // O_NONBLOCK: a FIFO would otherwise hold a libuv thread until a writer comes; it changes nothing for a regular file.
  const handle = await openInside(root, file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${file} is not a regular file`);
    return await handle.readFile(encoding ?? null);
  } finally {
    await handle.close();
  }
}

/** writeFileAtomic for a folder an agent turn can write: a folder it swaps for a link never sends the write elsewhere. */
export async function writeFileInside(root: string, file: string, data: string | Buffer, mode?: number): Promise<void> {
  const tmp = tmpFile(file);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await openInside(root, tmp, flags, mode).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
    await inParentInside(root, file, { mkdir: true });
    return openInside(root, tmp, flags, mode);
  });
  try {
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await inParentInside(root, file, { renameFrom: path.basename(tmp) });
  } catch (e) {
    // Where the walk still reaches it, beside a name that is a folder say; not in a folder a swap moved away.
    await removeFileInside(root, tmp).catch(() => undefined);
    throw e;
  }
}

/** fs.rm(file, { force: true }) for a folder an agent turn can write, never through a link on the way. */
export async function removeFileInside(root: string, file: string): Promise<void> {
  await inParentInside(root, file, { unlink: true });
}

/** fs.readdir for a folder an agent turn can write: refused when it, or a folder on the way, is a link. */
export async function listInside(root: string, dir: string): Promise<string[]> {
  if (!isInside(root, dir)) throw outsideError(root, dir);
  const names = path.relative(root, dir).split(path.sep);
  if (process.platform === 'darwin') {
    // find prints "./<name>" and a NUL after each.
    return (await walk(root, dir, 'ls', names))
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(2));
  }
  const folder = await openFolderInside(root, names);
  try {
    return await fs.readdir(procPath(folder));
  } finally {
    await folder.close();
  }
}

/**
 * fs.rm(dir, { recursive: true, force: true }) for a folder an agent turn can write. rm walks the tree with fts, which
 * checks each folder it enters is the one it listed: a folder swapped for a link is never followed.
 */
export async function removeTreeInside(dir: string): Promise<void> {
  await execFileAsync('/bin/rm', ['-rf', '--', dir], { env: {} });
}

/** macOS 11+, absent from fs.constants: the open fails (ELOOP) on a link anywhere in the path. */
const O_NOFOLLOW_ANY = 0x20000000;

/**
 * Open `file` with no link followed between `root` and it, checked by the kernel in the open: a check made by path before
 * or after can always be raced. Only darwin and linux run Cadence.
 */
async function openInside(root: string, file: string, flags: number, mode?: number): Promise<FileHandle> {
  if (!isInside(root, file)) throw outsideError(root, file);
  if (process.platform === 'darwin') {
    // A root reached through a link is legitimate: nothing an agent writes is above it.
    const target = path.join(await fs.realpath(root), path.relative(root, file));
    // The kernel refuses O_NOFOLLOW with O_NOFOLLOW_ANY (EINVAL), which covers the last name too.
    return fs.open(target, (flags & ~constants.O_NOFOLLOW) | O_NOFOLLOW_ANY, mode);
  }
  const { folder, name } = await openParentInside(root, file);
  try {
    return await fs.open(`${procPath(folder)}/${name}`, flags, mode);
  } finally {
    await folder.close();
  }
}

type FolderOp = { mkdir: true } | { renameFrom: string } | { unlink: true };

/**
 * Create the folders of `file`, rename a sibling onto it or unlink it, without following a link between `root` and it.
 * Node has no renameat or unlinkat. On Linux the folder is opened and named through /proc; on macOS a shell walks down
 * with `cd -P`, checks the real working folder at each step, then acts by name from that folder: a swap can move it, never
 * redirect it. The rename is perl's plain rename(2): mv would move the file into a folder found under the target name.
 */
async function inParentInside(root: string, file: string, op: FolderOp): Promise<void> {
  if (!isInside(root, file)) throw outsideError(root, file);
  const names = path.relative(root, file).split(path.sep);
  const name = names.pop()!;
  if (process.platform === 'darwin') {
    const [what, ...args] = 'mkdir' in op ? ['mkdir'] : 'unlink' in op ? ['rm', name] : ['mv', op.renameFrom, name];
    await walk(root, file, what, names, args);
    return;
  }
  const parent = await openParentInside(root, file, 'mkdir' in op).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' && 'unlink' in op) return null;
    throw e;
  });
  if (!parent) return;
  try {
    const at = procPath(parent.folder);
    if ('renameFrom' in op) await fs.rename(`${at}/${op.renameFrom}`, `${at}/${name}`);
    if ('unlink' in op)
      await fs.unlink(`${at}/${name}`).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
  } finally {
    await parent.folder.close();
  }
}

/** macOS: IN_FOLDER's output; a folder on the way that is not the one its name gives is refused as outside. */
async function walk(root: string, file: string, what: string, folders: string[], args: string[] = []): Promise<string> {
  const run = execFileAsync('/bin/sh', ['-c', IN_FOLDER, 'sh', what, root, folders.join('/'), ...args], { env: {} });
  const { stdout } = await run.catch((e: { code?: unknown }) => {
    throw e.code === 3 ? outsideError(root, file) : new Error(`${file}: ${what} failed (${String(e.code)})`);
  });
  return stdout;
}

/**
 * $1 mkdir, rm, mv or ls; $2 the root; $3 the folders below it, joined by "/"; then rm's name or mv's two names. Exits 3
 * when a folder on the way is not the physical one its name gives, 0 for an rm whose folder is missing. /bin/pwd is
 * getcwd: the builtin resolves the path string again, which a swap passes. ls lists the last folder itself.
 */
const IN_FOLDER = `
what=$1 root=$2 folders=$3
shift 3
# $(...) drops the trailing newlines a folder name can end with: the dot keeps them.
real() { r=$(/bin/pwd -P && echo .) || exit 1; r=\${r%.}; r=\${r%?}; }
if [ "$what" = rm ] && [ ! -d "$root" ]; then exit 0; fi
cd -P -- "$root" || exit 1
real
here=$r
set -f
IFS=/
for folder in $folders; do
  if [ "$what" = mkdir ]; then /bin/mkdir -- "./$folder" 2>/dev/null; fi
  if [ "$what" = rm ] && [ ! -e "./$folder" ] && [ ! -L "./$folder" ]; then exit 0; fi
  cd -P -- "./$folder" || exit 1
  here=$here/$folder
  real
  [ "$r" = "$here" ] || exit 3
done
case $what in
  rm) exec /bin/rm -f -- "./$1" ;;
  mv) exec /usr/bin/perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "./$1" "./$2" ;;
  ls) exec /usr/bin/find . -mindepth 1 -maxdepth 1 -print0 ;;
esac
`;

/** Linux: the folder of `file`, opened from `root` one name at a time through /proc with no link followed. */
async function openParentInside(root: string, file: string, mkdir = false): Promise<{ folder: FileHandle; name: string }> {
  const names = path.relative(root, file).split(path.sep);
  const name = names.pop()!;
  return { folder: await openFolderInside(root, names, mkdir), name };
}

/** Linux: `root`, then each of `names` below it opened through the one before, never through a link. */
async function openFolderInside(root: string, names: string[], mkdir = false): Promise<FileHandle> {
  // A root reached through a link is legitimate: nothing an agent writes is above it.
  let folder = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const sub of names) {
      const at = `${procPath(folder)}/${sub}`;
      if (mkdir)
        await fs.mkdir(at).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        });
      const next = await fs.open(at, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await folder.close();
      folder = next;
    }
  } catch (e) {
    await folder.close();
    throw e;
  }
  return folder;
}

/** The magic link is the opened folder itself, wherever it is now: no rename or link can redirect what goes through it. */
function procPath(folder: FileHandle): string {
  // Without /proc every name through it is missing, and a removal would pass for done.
  if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) throw new Error(`no /proc/self/fd on ${process.platform}`);
  return `/proc/self/fd/${folder.fd}`;
}

function outsideError(root: string, file: string): Error {
  return new Error(`${file} is outside ${root}`);
}

const tmpFile = (file: string) => `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

/**
 * PATH without its empty and relative entries. A child spawned in a folder an agent can write looks its command up in
 * that folder through them ("PATH=$PATH:" or "."), and would run a binary a turn planted there, outside any sandbox.
 */
export function absolutePath(value: string): string {
  return value
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .join(path.delimiter);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `rel` under `base`; throws if the result escapes `base` (path traversal). */
export function resolveInside(base: string, rel: string): string {
  const resolved = path.resolve(base, rel);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, m().api.util.invalidPath(rel));
  }
  return resolved;
}

export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The real path of `file`, or of its closest existing folder followed by the rest. A request URL or a stylesheet can
 * name thousands of missing folders, one lookup each: past 32 this throws.
 */
export async function realPath(file: string): Promise<string> {
  const rest: string[] = [];
  for (let dir = file; ; dir = path.dirname(dir)) {
    const real = await fs.realpath(dir).catch(() => null);
    if (real) return path.join(real, ...rest);
    if (path.dirname(dir) === dir) return path.join(dir, ...rest);
    if (rest.length === 32) throw new Error(`${file}: too many missing folders`);
    rest.unshift(path.basename(dir));
  }
}

// Tailwind loads and runs a JS/TS module in this process when it compiles a CSS file that carries `@plugin` or
// `@config`. Scenes, components, brands and templates are written by the agent and never need either, so Cadence
// refuses both before Tailwind sees the CSS.
const CSS_CODE_EXEC = /@(?:plugin|config)[^\w-]/;
const CSS_CODE_EXEC_AT_END = /@(?:plugin|config)(?![\w-])/;
const [TEXT, ESCAPE, SLASH, COMMENT, STAR, COMMENT_ESCAPE, STRING, STRING_ESCAPE] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Whether Tailwind would run code compiling a text fed piece by piece (a stream of any size). Tailwind drops comments,
 * even one inside the directive's name, so the directive is looked for once comments are gone, and in the raw text too
 * (refusing a commented-out one is safe). As in Tailwind's parser, a `/*` inside a string or after a backslash opens
 * no comment, and a backslash in a comment escapes the next character, so an escaped star never closes it. A twin
 * scan reads comments without that escape: should Tailwind's rule ever change, a directive either rule reveals is
 * refused. Every character that matters is ASCII, so bytes can be fed as latin1.
 */
export class CssCodeScan {
  private readonly twin: CssCodeScan | null;
  private state = TEXT;
  private quote = 0;
  private rawTail = '';
  private textTail = '';
  private found = false;

  constructor(private readonly commentEscapes = true) {
    this.twin = commentEscapes ? new CssCodeScan(false) : null;
  }

  /** Feeds the next piece and answers its text with comments removed. */
  push(piece: string): string {
    this.twin?.push(piece);
    let state = this.state;
    let text = '';
    let run = -1;
    for (let i = 0; i < piece.length; i++) {
      const c = piece.charCodeAt(i);
      let visible = true;
      switch (state) {
        case SLASH:
          if (c === 0x2a) {
            state = COMMENT;
            visible = false;
            break;
          }
          text += '/';
          state = TEXT;
        // falls through: the character after a lone slash is plain text
        case TEXT:
          if (c === 0x5c) state = ESCAPE;
          else if (c === 0x2f) [state, visible] = [SLASH, false];
          else if (c === 0x22 || c === 0x27) [state, this.quote] = [STRING, c];
          break;
        case ESCAPE:
          state = TEXT;
          break;
        case COMMENT:
        case STAR:
          visible = false;
          if (state === STAR && c === 0x2f) state = TEXT;
          else if (c === 0x5c && this.commentEscapes) state = COMMENT_ESCAPE;
          else state = c === 0x2a ? STAR : COMMENT;
          break;
        case COMMENT_ESCAPE:
          visible = false;
          state = COMMENT;
          break;
        case STRING:
          if (c === 0x5c) state = STRING_ESCAPE;
          else if (c === this.quote) state = TEXT;
          break;
        case STRING_ESCAPE:
          state = STRING;
      }
      if (visible && run < 0) run = i;
      else if (!visible && run >= 0) {
        text += piece.slice(run, i);
        run = -1;
      }
    }
    if (run >= 0) text += piece.slice(run);
    this.state = state;
    const raw = this.rawTail + piece;
    const seen = this.textTail + text;
    this.found ||= CSS_CODE_EXEC.test(raw) || CSS_CODE_EXEC.test(seen);
    // A directive is 7 characters: the tails keep one that a cut leaves without the character after it.
    this.rawTail = raw.slice(-7);
    this.textTail = seen.slice(-7);
    return text;
  }

  /** Whether the whole text runs code. */
  end(): boolean {
    const text = this.textTail + (this.state === SLASH ? '/' : '');
    if (this.twin?.end()) return true;
    return this.found || CSS_CODE_EXEC_AT_END.test(this.rawTail) || CSS_CODE_EXEC_AT_END.test(text);
  }
}

export function cssRunsCode(css: string): boolean {
  const scan = new CssCodeScan();
  scan.push(css);
  return scan.end();
}

/**
 * A file name as a case-insensitive disk compares it: APFS takes `Node_Modules` and even `node_module\u017f` (long s)
 * for `node_modules`, so the name is upper- then lower-cased, which folds both.
 */
export function foldName(name: string): string {
  return name.normalize('NFD').toUpperCase().toLowerCase();
}

/** A frame the agent looked at, as saved under `.cadence/frames`: JPEG normally, PNG from the MCP tool. */
export const AGENT_FRAME_NAME = /^[\w.-]+\.(jpe?g|png)$/;

/** A `node_modules` folder or a `package.json`, through which Tailwind's fallback resolver reaches a file of any kind. */
export function isResolverInput(name: string): boolean {
  const folded = foldName(name);
  return folded === 'node_modules' || folded === 'package.json';
}

/** "Mon super Projet !" becomes "mon-super-projet" (ASCII, kebab-case, max 64 chars, valid ID_PATTERN). */
export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return ID_PATTERN.test(slug) ? slug : fallback;
}

/** First id of `base`, `base-2`, `base-3`... not in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!set.has(candidate)) return candidate;
  }
}

/** `what` names the id in the error message: pass one of m().api.ids. */
export function assertId(id: string, what = m().api.ids.id): string {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, m().api.util.invalidId(what, id));
  return id;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function shortHash(data: string | Buffer): string {
  return sha256(data).slice(0, 12);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Round seconds to the millisecond. */
export function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** Error carrying an HTTP status; the API layer maps it to a JSON `{ error }` response. User-facing message, made with m(). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Runs async sections one at a time per key. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Push-based async iterator (producer pushes, consumer awaits). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Seconds in messages: "1 min 02,50 s" in French, "1 min 02.50 s" in English. */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  const rest = (s - minutes * 60).toFixed(2);
  const text = language() === 'fr' ? rest.replace('.', ',') : rest;
  return minutes > 0 ? `${minutes} min ${text.padStart(5, '0')} s` : `${text} s`;
}
