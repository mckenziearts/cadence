import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { m } from '../i18n';
import { HttpError, shortHash } from '../util';

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
};

/** Served files are inert: an uploaded SVG opened directly must not run script on the editor origin. */
const FILE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Stream a file with ETag revalidation and single-range requests (audio/video seeking). */
export async function sendFile(c: Context, file: string, type = contentType(file)): Promise<Response> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new HttpError(404, m().api.fileNotFound(path.basename(file)));
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    ...FILE_HEADERS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  };
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
  const range = parseRange(c.req.header('range'), stat.size);
  if (range === 'unsatisfiable') return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
  const { start, end } = range ?? { start: 0, end: stat.size - 1 };
  headers['Content-Length'] = String(end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  const status = range ? 206 : 200;
  if (c.req.method === 'HEAD' || stat.size === 0) return c.body(null, status, headers);
  return c.body(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, status, headers);
}

/** In-memory image (thumbnails) with a content ETag. */
export function sendImage(c: Context, data: Buffer, type = 'image/jpeg'): Response {
  const etag = `"${shortHash(data)}"`;
  const headers = { ...FILE_HEADERS, 'Content-Type': type, 'Cache-Control': 'private, no-cache', ETag: etag };
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
  return c.body(new Uint8Array(data), 200, headers);
}

/** One "bytes=a-b" range. null = send the whole file (no header, or several ranges, which a server may ignore). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end = size - 1;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
  } else {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), size - 1);
  }
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}

/** PNG or JPEG bytes as a data: URL (seam detail images). */
export function dataUrl(image: Buffer): string {
  const type = image[0] === 0x89 && image[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return `data:${type};base64,${image.toString('base64')}`;
}
