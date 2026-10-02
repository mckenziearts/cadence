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
    // the editor's main thread. Both servers still listen on 127.0.0.1 only.
    frameOrigin: `http://localhost:${framePort}`,
    mcpUrl: `${editorOrigin}/mcp`,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    claudePath: env.CLAUDE_PATH || 'claude',
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
