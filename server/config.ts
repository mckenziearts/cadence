import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORTS, type Effort } from '../src/shared/types';
import type { CadenceConfig } from './contracts';
import { m } from './i18n';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';

/** Configuration from the environment, then `overrides` (undefined values are ignored). Origins follow the ports. */
export function loadConfig(overrides: Partial<CadenceConfig> = {}): CadenceConfig {
  const env = process.env;
  const given = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) as Partial<CadenceConfig>;
  const root = path.resolve(given.root ?? ROOT);
  const editorPort = given.editorPort ?? parsePort('CADENCE_PORT', env.CADENCE_PORT, 5310);
  const framePort = given.framePort ?? parsePort('CADENCE_FRAME_PORT', env.CADENCE_FRAME_PORT, 5311);
  const editorOrigin = `http://${HOST}:${editorPort}`;
  captureLocale(); // a bad CADENCE_LOCALE fails at start, not at the first capture
  return {
    projectsDir: path.join(root, 'projects'),
    brandsDir: path.join(root, 'brands'),
    templatesDir: path.join(root, 'templates'),
    stateDir: path.join(root, '.cadence'),
    host: HOST,
    editorPort,
    framePort,
    editorOrigin,
    // The same loopback under another name: another site for Chrome, which then runs the preview in its own process, off
    // the editor's main thread. Both servers still listen on the loopback only (127.0.0.1 and ::1).
    frameOrigin: `http://localhost:${framePort}`,
    mcpUrl: `${editorOrigin}/mcp`,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    claudePath: binPath(env.CLAUDE_PATH, 'claude'),
    codexPath: binPath(env.CODEX_PATH, 'codex'),
    grokPath: env.GROK_PATH || 'grok',
    geminiPath: env.GEMINI_PATH || 'gemini',
    piperPath: env.PIPER_PATH || 'piper',
    defaultModel: env.CADENCE_MODEL || 'claude-opus-5-5',
    defaultEffort: parseEffort(env.CADENCE_EFFORT),
    useApiKey: /^(1|true|yes|oui)$/i.test(env.CADENCE_USE_API_KEY ?? ''),
    agentLog: env.CADENCE_AGENT_LOG ? path.resolve(env.CADENCE_AGENT_LOG) : null,
    ...given,
    root,
  };
}

/**
 * Locale of the capture pages (thumbnails, agent frames, seams, MP4): what `toLocaleString()` and `Intl` use without an
 * explicit locale. Env CADENCE_LOCALE, default fr-FR. Kept out of CadenceConfig, a shared contract.
 */
export function captureLocale(): string {
  const value = process.env.CADENCE_LOCALE;
  if (!value) return 'fr-FR';
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    throw new Error(m().media.config.locale(value));
  }
}

/**
 * Chromium's own sandbox around the pages that run brand and scene code, which Playwright turns off unless asked. On
 * unless CADENCE_CHROMIUM_SANDBOX=0: a container, or a Linux host without unprivileged user namespaces.
 */
export function chromiumSandbox(): boolean {
  return process.env.CADENCE_CHROMIUM_SANDBOX !== '0';
}

/** Playwright's launch error when the sandbox cannot start (no unprivileged user namespaces). */
export const CHROMIUM_SANDBOX_FAILED = /Chromium sandboxing failed/i;

/**
 * A relative path to an agent CLI, resolved now: spawn would resolve it against the turn's folder, which the agent can
 * write. A bare name stays a PATH lookup.
 */
function binPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return value.includes('/') || value.includes(path.sep) ? path.resolve(value) : value;
}

function parsePort(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(m().media.config.port(name, value));
  return port;
}

function parseEffort(value: string | undefined): Effort {
  if (!value) return 'medium';
  if (!EFFORTS.includes(value as Effort)) throw new Error(m().media.config.effort(value, EFFORTS.join(', ')));
  return value as Effort;
}
