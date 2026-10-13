// POSIX ustar streams with no dependency. The writer streams files from disk; the reader treats its input as hostile:
// regular files and directories only, safe relative paths, caps checked while streaming, nothing written by itself.
import { once } from 'node:events';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';

export type TarEntry = { path: string; file: string } | { path: string; directory: true };

export interface TarFile {
  path: string;
  size: number;
  /**
   * Must be read to its end or left alone: once `onFile` settles, the rest is discarded. Destroyed when the archive
   * fails inside this entry, so a pipe from it rejects.
   */
  stream: Readable;
  /** The whole content, refused over `maxBuffered`. */
  buffer(): Promise<Buffer>;
}

export interface ReadTarOptions {
  onFile(entry: TarFile): Promise<void>;
  maxBytes: number;
  maxEntries: number;
  maxBuffered: number;
}

const BLOCK = 512;
const MAX_PATH = 1024;
const MAX_PAX = 64 * 1024;
const MAX_SIZE = 8 ** 11 - 1;
const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;
const isZero = (block: Buffer) => block.every((byte) => byte === 0);
const quoted = (value: string) => JSON.stringify(value);

export function writeTar(entries: Iterable<TarEntry> | AsyncIterable<TarEntry>): Readable {
  return Readable.from(generate(entries), { objectMode: false });
}

async function* generate(entries: Iterable<TarEntry> | AsyncIterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    if ('directory' in entry) {
      yield header(`${entry.path}/`, '5', 0, 0o755);
      continue;
    }
    // No symlink is followed: a file swapped for a link after the caller listed it is refused, never read.
    const handle = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`${entry.file} is not a regular file`);
      if (stat.size > MAX_SIZE) throw new Error(`${entry.file} is over ${MAX_SIZE} bytes`);
      yield header(entry.path, '0', stat.size, 0o644);
      let written = 0;
      if (stat.size > 0) {
        for await (const chunk of handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false })) {
          written += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      }
      if (written !== stat.size) throw new Error(`${entry.file} changed while it was archived`);
      yield Buffer.alloc(padding(stat.size));
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(2 * BLOCK);
}

function header(path: string, type: string, size: number, mode: number): Buffer {
  const split = splitName(path);
  if (split) return block(split.name, split.prefix, type, size, mode);
  const record = paxRecord('path', path);
  return Buffer.concat([
    block('PaxHeader', '', 'x', record.length, 0o644),
    record,
    Buffer.alloc(padding(record.length)),
    block(path, '', type, size, mode),
  ]);
}

/** ustar keeps up to 155 bytes of directories in `prefix` and 100 bytes in `name`. */
function splitName(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) > 155) return undefined;
    if (name && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return undefined;
}

/** A pax record counts its own length: "<length> <key>=<value>\n". */
function paxRecord(key: string, value: string): Buffer {
  const base = Buffer.byteLength(` ${key}=${value}\n`);
  let length = base;
  while (String(length).length + base !== length) length = String(length).length + base;
  return Buffer.from(`${length} ${key}=${value}\n`);
}

function block(name: string, prefix: string, type: string, size: number, mode: number): Buffer {
  const out = Buffer.alloc(BLOCK);
  out.write(name, 0, 100);
  out.write(octal(mode, 8), 100);
  out.write(octal(0, 8), 108);
  out.write(octal(0, 8), 116);
  out.write(octal(size, 12), 124);
  out.write(octal(0, 12), 136);
  out.write(type, 156);
  out.write('ustar\x0000', 257);
  out.write(prefix, 345, 155);
  out.fill(' ', 148, 156);
  out.write(octal(checksum(out), 7), 148);
  return out;
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum;
}

function parseOctal(field: Buffer, label: string): number {
  if (field[0] & 0x80) throw new Error(`Archive entry has a base-256 ${label}, which is not supported`);
  const digits = field.toString('latin1').replace(/^[\0 ]+|[\0 ]+$/g, '');
  if (!/^[0-7]+$/.test(digits)) throw new Error(`Archive entry has an invalid ${label}`);
  return parseInt(digits, 8);
}

const text = (field: Buffer) => {
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end === -1 ? field.length : end);
};

function headerPath(block: Buffer): string {
  const name = text(block.subarray(0, 100));
  const prefix = block.toString('latin1', 257, 263) === 'ustar\0' ? text(block.subarray(345, 500)) : '';
  return prefix ? `${prefix}/${name}` : name;
}

function paxPath(data: Buffer): string | undefined {
  let found: string | undefined;
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.toString('latin1', at, space));
    if (space === -1 || !Number.isInteger(length) || length <= space - at || data[at + length - 1] !== 0x0a) {
      throw new Error('Archive has a malformed pax header');
    }
    const record = data.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') found = record.slice(equals + 1);
    at += length;
  }
  return found;
}

function assertSafePath(path: string): void {
  const segments = path.split('/');
  if (
    path.length > MAX_PATH ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Archive entry has an unsafe path: ${quoted(path)}`);
  }
}

export async function readTar(input: AsyncIterable<Buffer>, options: ReadTarOptions): Promise<void> {
  const { onFile, maxBytes, maxEntries, maxBuffered } = options;
  const chunks = input[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  let unpacked = 0;
  const overCap = () => new Error(`Archive is over ${maxBytes} bytes unpacked`);

  const pull = async (): Promise<boolean> => {
    const next = await chunks.next();
    if (next.done) return false;
    unpacked += next.value.length;
    if (unpacked > maxBytes) throw overCap();
    pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
    return true;
  };
  const take = async (length: number): Promise<Buffer> => {
    while (pending.length < length) if (!(await pull())) throw new Error('Archive is truncated');
    const out = pending.subarray(0, length);
    pending = pending.subarray(length);
    return out;
  };
  async function* body(size: number): AsyncGenerator<Buffer> {
    for (let left = size; left > 0;) {
      if (!pending.length && !(await pull())) throw new Error('Archive is truncated');
      const chunk = await take(Math.min(left, pending.length));
      left -= chunk.length;
      yield chunk;
    }
  }

  const emit = async (path: string, size: number): Promise<void> => {
    const stream = new PassThrough();
    let settled = false;
    let failure: { error: unknown } | undefined;
    const buffer = async () => {
      if (size > maxBuffered) throw new Error(`Archive entry ${quoted(path)} is over ${maxBuffered} bytes`);
      return Buffer.concat(await stream.toArray());
    };
    const done = Promise.resolve()
      .then(() => onFile({ path, size, stream, buffer }))
      .then(
        () => void stream.resume(),
        (error: unknown) => void (failure = { error }),
      )
      .finally(() => (settled = true));
    try {
      for await (const chunk of body(size)) {
        if (!settled && !stream.write(chunk)) await Promise.race([once(stream, 'drain'), done]);
        if (failure) throw failure.error;
      }
    } catch (error) {
      // Destroyed without an error: a caller that left the stream alone must not get an unhandled 'error' event.
      stream.destroy();
      await done;
      throw error;
    }
    stream.end();
    await done;
    if (failure) throw failure.error;
  };

  try {
    const seen = new Set<string>();
    let path: string | undefined;
    for (;;) {
      const block = await take(BLOCK);
      if (isZero(block)) {
        if (!isZero(await take(BLOCK))) throw new Error('Archive has a damaged end');
        while (await pull()) pending = Buffer.alloc(0);
        return;
      }
      if (parseOctal(block.subarray(148, 156), 'checksum') !== checksum(block)) {
        throw new Error('Archive has a header checksum mismatch');
      }
      const size = parseOctal(block.subarray(124, 136), 'size');
      if (unpacked - pending.length + size > maxBytes) throw overCap();
      const type = String.fromCharCode(block[156]);
      if (type === 'g') {
        for await (const _ of body(size));
        await take(padding(size));
        continue;
      }
      if (type === 'x') {
        if (size > MAX_PAX) throw new Error(`Archive pax header is over ${MAX_PAX} bytes`);
        path = paxPath((await take(size + padding(size))).subarray(0, size)) ?? path;
        continue;
      }
      let name = path ?? headerPath(block);
      path = undefined;
      if (type === '5' && name.endsWith('/')) name = name.slice(0, -1);
      if (type !== '0' && type !== '\0' && type !== '5') {
        throw new Error(`Archive entry ${quoted(name)} has the unsupported type ${quoted(type)}`);
      }
      if (type === '5' && size) throw new Error(`Archive directory ${quoted(name)} has a size`);
      assertSafePath(name);
      // APFS ignores case and Unicode normalization: two such names would be one file on disk.
      const key = name.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new Error(`Archive has a duplicate entry ${quoted(name)}`);
      seen.add(key);
      if (seen.size > maxEntries) throw new Error(`Archive has more than ${maxEntries} entries`);
      if (type !== '5') await emit(name, size);
      await take(padding(size));
    }
  } finally {
    await chunks.return?.();
  }
}
