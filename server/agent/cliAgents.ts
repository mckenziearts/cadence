import { execFile } from 'node:child_process';
import type { AgentStatus } from '../../src/shared/types';
import type { CadenceConfig } from '../contracts';
import { m } from '../i18n';

// Grok and Gemini ship no documented `login status` command, so Cadence can only tell installed from not installed.
// "Installed" is reported as not-yet-connected (a connect prompt), never a claimed login, so a card never shows a login
// Cadence could not verify. The install/connect modal carries the real steps.
export function grokStatus(config: CadenceConfig): Promise<AgentStatus> {
  return installed(config.grokPath, 'Grok', m().agent.grok);
}

export function geminiStatus(config: CadenceConfig): Promise<AgentStatus> {
  return installed(config.geminiPath, 'Gemini', m().agent.gemini);
}

type Texts = { notFound: (bin: string, error: string) => string; installed: string };

async function installed(bin: string, label: string, t: Texts): Promise<AgentStatus> {
  try {
    const out = await exec(bin, ['--version']);
    // Present but `--version` failed is still installed (unknown flag); only a spawn failure means missing.
    const version = out.code === 0 ? (out.stdout.trim().split(/\s+/).pop() ?? '') : undefined;
    return { ok: false, label, version, reason: 'logged-out', detail: t.installed };
  } catch (e) {
    return { ok: false, label, reason: 'missing', detail: t.notFound(bin, (e as Error).message) };
  }
}

function exec(file: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: String(stdout), code: error ? Number(error.code) : 0 });
    });
  });
}
