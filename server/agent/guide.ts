// Adapted from saeedvaziry/caleb-video-editor (MIT)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CadenceConfig } from '../contracts';
import { writeFileAtomic } from '../util';

// The guide is prose full of inline code: it lives in guide.md; scope sections follow `<!-- scope: <name> -->` lines.
const GUIDE_MD = fileURLToPath(new URL('./guide.md', import.meta.url));
const API_MD = fileURLToPath(new URL('../../src/runtime/API.md', import.meta.url));
const BRAND_GUIDE_MD = fileURLToPath(new URL('./brand-guide.md', import.meta.url));
const MANAGED = '<!-- cadence:managed-guide';
const MANAGED_LINE = `${MANAGED} — Cadence rewrites this file when it starts; delete this line to keep your own edits. -->`;

function runtimeApi(): string {
  try {
    return fs.readFileSync(API_MD, 'utf8').trim();
  } catch {
    return '# `cadence` runtime\n\nsrc/runtime/API.md is missing: read `src/runtime/index.ts` in the runtime folder for the exports.';
  }
}

function guide(scope: 'scene' | 'project' | 'terminal'): string {
  const [body, ...parts] = fs.readFileSync(GUIDE_MD, 'utf8').split(/^<!-- scope: (\w+) -->\n/m);
  const scopes = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) scopes.set(parts[i], parts[i + 1].trim());
  // Replacer functions: API.md contains `$` sequences that a replacement string would interpret.
  return body
    .replace('{{SCOPE}}', () => scopes.get(scope) ?? '')
    .replace('{{RUNTIME_API}}', () => runtimeApi())
    .trim();
}

/** Static system prompt of the in-app agent (appended to Claude Code's own); API.md is read at call time. */
export function buildSystemPrompt(opts: { scope: 'scene' | 'project' }): string {
  return guide(opts.scope);
}

export type BrandGuideVars = Record<
  'REPO_DIR' | 'REPO' | 'BRAND_DIR' | 'BRAND_ID' | 'BRAND_NAME' | 'BRANDS_DIR' | 'SHARED_DIR' | 'FONTSOURCE' | 'LANGUAGE',
  string
>;

/** System prompt of a brand build: brand-guide.md with the build's folders and names. */
export function buildBrandGuide(vars: BrandGuideVars): string {
  const text = fs.readFileSync(BRAND_GUIDE_MD, 'utf8');
  return text.replace(/{{(\w+)}}/g, (match, key: string) => (key in vars ? vars[key as keyof BrandGuideVars] : match)).trim();
}

/** projects/CLAUDE.md: the same guide for Claude Code sessions started in a terminal (MCP tools with a projectId). */
export async function writeProjectsGuide(config: CadenceConfig): Promise<void> {
  const file = path.join(config.projectsDir, 'CLAUDE.md');
  const content = `${MANAGED_LINE}\n\n${guide('terminal')}\n`;
  let current: string | null = null;
  try {
    current = await fs.promises.readFile(file, 'utf8');
  } catch {
    // absent: write it
  }
  if (current === content) return;
  if (current !== null && !current.includes(MANAGED)) return; // the user took it over
  await writeFileAtomic(file, content);
}
