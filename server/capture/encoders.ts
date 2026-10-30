// Which render outputs the ffmpeg in use can make, from its `-encoders` list.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { RENDER_OUTPUTS, type OutputSupport, type RenderOutput } from '../../src/shared/types';
import { m } from '../i18n';

const run = promisify(execFile);

/** An output needs one encoder of each group: WebM takes libopus or, without it, ffmpeg's own opus. */
const NEEDS: Record<RenderOutput, string[][]> = {
  mp4: [['libx264'], ['aac']],
  webm: [['libvpx-vp9'], ['libopus', 'opus']],
  mov: [['prores_ks'], ['pcm_s16le']],
  gif: [['gif']],
  png: [['png']],
  'png-sequence': [['png']],
};

const read = new Map<string, { build: string; encoders: Promise<Set<string>> }>();

/** The file `bin` runs (looked up on PATH for a bare name) with its size and mtime, or '' when there is none. */
async function buildOf(bin: string): Promise<string> {
  const files = bin.includes(path.sep)
    ? [bin]
    : (process.env.PATH ?? '').split(path.delimiter).flatMap((dir) => (dir ? [path.join(dir, bin)] : []));
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat) return `${file}:${stat.size}:${stat.mtimeMs}`;
  }
  return '';
}

/**
 * The encoders of the ffmpeg at `bin`, read once per build: a build replaced at the same path is read again. A failed
 * read is not kept, so an ffmpeg installed while Cadence runs is found at the next call.
 */
export async function ffmpegEncoders(bin: string): Promise<Set<string>> {
  const build = await buildOf(bin);
  let entry = read.get(bin);
  if (entry?.build !== build) {
    const encoders = run(bin, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024 }).then(({ stdout }) =>
      parseEncoders(stdout),
    );
    entry = { build, encoders };
    read.set(bin, entry);
    encoders.catch(() => read.delete(bin));
  }
  return entry.encoders;
}

/** Encoder names listed after the legend's `------` line, e.g. ` V....D libx264  libx264 H.264 ...`. */
export function parseEncoders(stdout: string): Set<string> {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('------'));
  if (start < 0) return new Set();
  return new Set(lines.slice(start + 1).flatMap((line) => /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)?.[1] ?? []));
}

/** The first encoder of each group `output` needs and `encoders` lacks. */
export function missingEncoders(output: RenderOutput, encoders: Set<string>): string[] {
  return NEEDS[output].filter((group) => !group.some((name) => encoders.has(name))).map((group) => group[0]);
}

export async function outputSupport(bin: string): Promise<Record<RenderOutput, OutputSupport>> {
  const encoders = await ffmpegEncoders(bin).catch(() => null);
  const support = (output: RenderOutput): OutputSupport => {
    if (!encoders) return { available: false, reason: m().media.doctor.ffmpegMissing(bin) };
    const missing = missingEncoders(output, encoders);
    return missing.length ? { available: false, reason: m().media.render.missingEncoders(missing) } : { available: true };
  };
  return Object.fromEntries(RENDER_OUTPUTS.map((output) => [output, support(output)])) as Record<RenderOutput, OutputSupport>;
}
