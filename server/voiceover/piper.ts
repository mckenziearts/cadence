// Piper (https://github.com/OHF-Voice/piper1-gpl, GPL-3.0) speaks the voice-overs. Each user installs it
// (`pipx install piper-tts`); Cadence only runs it as a separate program, never ships it.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SpeechEngine } from '../contracts';
import { m } from '../i18n';
import { HttpError, randomToken } from '../util';

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

export class PiperEngine implements SpeechEngine {
  constructor(private readonly bin: string) {}

  async check(): Promise<{ ok: boolean; error?: string }> {
    try {
      await run(this.bin, ['--help'], { timeout: 30_000 });
      return { ok: true };
    } catch {
      return { ok: false, error: m().media.voiceOver.piperMissing(this.bin) };
    }
  }

  async speak(input: { model: string; sentences: string[]; lengthScale: number; files: string[] }): Promise<void> {
    const { model, sentences, lengthScale, files } = input;
    // Next to the targets, so that each WAV is renamed into place, never copied.
    const out = path.join(path.dirname(files[0]), `.piper-${randomToken(6)}`);
    await fs.mkdir(out, { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.bin, ['-m', model, '-d', out, '--length-scale', String(lengthScale)], {
          stdio: ['pipe', 'ignore', 'pipe'],
          timeout: TIMEOUT_MS,
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
        child.on('error', (e) => reject(new HttpError(500, m().media.voiceOver.piperStart(this.bin, e.message))));
        child.on('close', (code) => {
          if (code === 0) return resolve();
          const detail =
            stderr
              .trim()
              .split('\n')
              .filter((line) => !line.startsWith('INFO:'))
              .at(-1) ?? '';
          reject(new HttpError(500, m().media.voiceOver.piperFailed(code ?? -1, detail)));
        });
        child.stdin.on('error', () => undefined); // EPIPE when Piper dies before reading: its exit code tells what happened
        // One sentence per line: Piper writes one WAV per line.
        child.stdin.end(`${sentences.join('\n')}\n`);
      });
      // Piper names each line's WAV after a monotonic clock, so their numeric order is the order of the lines.
      const names = (await fs.readdir(out))
        .filter((name) => /^\d+\.wav$/.test(name))
        .sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
      if (names.length !== sentences.length)
        throw new HttpError(500, m().media.voiceOver.piperCount(sentences.length, names.length));
      for (const [i, name] of names.entries()) await fs.rename(path.join(out, name), files[i]);
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  }
}
