// Small helpers shared by every server module. Keep this file dependency-free (messages aside).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_PATTERN } from '../src/shared/types';
import { language, m } from './i18n';

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
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
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

// Tailwind loads and runs a JS/TS module in this process when it compiles a CSS file that carries `@plugin` or
// `@config`. Scenes, components, brands and templates are written by the agent and never need either, so Cadence
// refuses both before Tailwind sees the CSS. Matched on raw text (not after stripping comments): rejecting a
// commented-out directive is safe, missing a real one is not.
export const CSS_CODE_EXEC = /@(?:plugin|config)(?![\w-])/;

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
