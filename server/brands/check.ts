// What a brand folder must hold to work in every scene (brand.json, theme.css, fonts, logos, notes), checked without
// running its code: the brand tests and the brand builder share these checks. The kit's components only run in the
// sandboxed kit page (kit.html), never in the server.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrandColors, BrandFile } from '../../src/shared/types';
import type { CaptureService } from '../contracts';
import { m } from '../i18n';
import { CSS_CODE_EXEC } from '../util';

export const COLOR_KEYS: (keyof BrandColors)[] = [
  'background',
  'surface',
  'ink',
  'muted',
  'line',
  'primary',
  'primaryInk',
  'accent',
  'success',
  'warning',
  'danger',
];
const HEX = /^#[0-9a-f]{6}$/;
const PRELOAD = /^(?:italic )?\d{3} \d+px '([^']+)'$/;
/** CSS generic families and keywords: never loaded by a theme. Quoted names in a stack are web fonts and must be. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  'inherit',
  'initial',
]);
const FONT_TOKENS = ['display', 'body', 'mono'] as const;
const RADII = ['sm', 'md', 'lg', 'xl'] as const;

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const firstFamily = (stack: string) =>
  stack
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '');
const read = (file: string) => fs.readFile(file, 'utf8').catch(() => null);

/**
 * Problems of the brand folder `dir` (empty when it is complete), in the interface language: the user and the brand
 * builder read them. `root` is the Cadence folder, whose node_modules provide the @fontsource packages.
 */
export async function brandProblems(dir: string, root: string): Promise<string[]> {
  const t = m().media.brands.check;
  const problems: string[] = [];
  const id = path.basename(dir);
  const raw = await read(path.join(dir, 'brand.json'));
  if (raw === null) return [t.missing('brand.json')];
  let file: BrandFile;
  try {
    file = JSON.parse(raw) as BrandFile;
  } catch (e) {
    return [t.invalidJson((e as Error).message)];
  }

  if (file.id !== id) problems.push(t.wrongId(file.id, id));
  for (const key of ['name', 'tagline', 'voice'] as const) {
    if (typeof file[key] !== 'string' || !file[key].trim()) problems.push(t.empty(key));
  }
  if (typeof file.url !== 'string') problems.push(t.url);
  if (file.language !== 'fr' && file.language !== 'en') problems.push(t.language);

  const colors = file.colors ?? ({} as BrandColors);
  const extra = Object.keys(colors).filter((key) => !COLOR_KEYS.includes(key as keyof BrandColors));
  if (extra.length) problems.push(t.unknownColors(extra.join(', '), COLOR_KEYS.join(', ')));
  for (const key of COLOR_KEYS) {
    if (!HEX.test(colors[key] ?? '')) problems.push(t.hex(key));
  }

  const fonts = file.fonts ?? { display: '', body: '', mono: '', preload: [] };
  for (const key of FONT_TOKENS) if (!fonts[key]) problems.push(t.empty(`fonts.${key}`));
  const families = new Set(FONT_TOKENS.flatMap((key) => (fonts[key] ?? '').split(',').map(firstFamily)));
  if (!fonts.preload?.length) problems.push(t.empty('fonts.preload'));
  for (const face of fonts.preload ?? []) {
    const match = PRELOAD.exec(face);
    if (!match) problems.push(t.preload(face));
    else if (!families.has(match[1])) problems.push(t.preloadUnused(match[1]));
  }

  const radius = file.radius ?? { sm: -1, md: -1, lg: -1, xl: -1 };
  if (RADII.some((key) => !(radius[key] >= 0))) problems.push(t.radius);
  else if (!(radius.sm <= radius.md && radius.md <= radius.lg && radius.lg <= radius.xl)) problems.push(t.radiusOrder);

  for (const key of ['mark', 'full'] as const) {
    const logo = path.resolve(dir, file.logo?.[key] ?? '');
    if (!logo.startsWith(dir + path.sep)) {
      problems.push(t.logoOutside(key));
      continue;
    }
    const svg = await read(logo);
    if (svg === null) problems.push(t.logoMissing(key, file.logo[key]));
    else if (!/^<svg[^>]*viewBox="[\d. ]+"/.test(svg)) problems.push(t.logoSvg(key));
    else if (/<script|href="https?:|<image/i.test(svg)) problems.push(t.logoExternal(key));
  }

  const css = await read(path.join(dir, 'theme.css'));
  if (css === null) problems.push(t.missing('theme.css'));
  else problems.push(...(await themeProblems(dir, root, css, file)));

  // theme.css is the compiled entry, but it can @import other CSS in the folder: scan them all, not just the entry.
  for (const rel of (await fs.readdir(dir, { recursive: true, encoding: 'utf8' })).filter((f) => f.endsWith('.css'))) {
    if (CSS_CODE_EXEC.test((await read(path.join(dir, rel))) ?? '')) problems.push(t.cssCodeExec(rel));
  }

  for (const note of ['art-direction.md', 'KIT.md']) {
    const text = await read(path.join(dir, note));
    if (text === null || text.length <= 400) problems.push(t.note(note));
  }
  return problems;
}

/**
 * Everything Cadence checks before listing a built brand: the folder checks, then the kit rendered in the sandboxed kit
 * page. A kit that does not load gets Vite's compile error, which says more than the browser.
 */
export async function checkBrand(opts: {
  dir: string;
  root: string;
  capture: Pick<CaptureService, 'kitSheet'>;
  diagnose: (file: string) => Promise<string | null>;
}): Promise<string[]> {
  const problems = await brandProblems(opts.dir, opts.root);
  const sheet = await opts.capture
    .kitSheet(path.basename(opts.dir))
    .catch((e: Error) => ({ problems: [m().media.brands.check.kitSheet(e.message)], loaded: true }));
  if (!sheet.loaded) {
    const error = await opts.diagnose(path.join(opts.dir, 'index.tsx'));
    if (error) problems.push(m().media.brands.check.compile(error));
  }
  return [...problems, ...sheet.problems];
}

async function themeProblems(dir: string, root: string, css: string, file: BrandFile): Promise<string[]> {
  const t = m().media.brands.check;
  const problems: string[] = [];
  const require = createRequire(path.join(root, 'package.json'));
  const tailwind = "@import 'tailwindcss' source(none);";
  if (!css.includes(tailwind)) problems.push(t.themeLine(tailwind));
  for (const source of ['../../projects', '../../templates', '.']) {
    if (!css.includes(`@source '${source}';`)) problems.push(t.themeLine(`@source '${source}';`));
  }
  const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  for (const key of COLOR_KEYS) {
    if (token(`color-${kebab(key)}`) !== file.colors?.[key]) {
      problems.push(t.themeColor(`--color-${kebab(key)}`, file.colors?.[key]));
    }
  }
  for (const key of FONT_TOKENS) {
    if (token(`font-${key}`) !== file.fonts?.[key]) problems.push(t.themeFont(`--font-${key}`));
  }
  for (const key of RADII) {
    if (token(`radius-${key}`) !== `${file.radius?.[key]}px`) {
      problems.push(t.themeRadius(`--radius-${key}`, `${file.radius?.[key]}px`));
    }
  }

  // Families each loaded face declares: the @fontsource stylesheets, then the folder's own @font-face blocks.
  const loaded = new Set<string>();
  const faces = (source: string) => {
    for (const [, name] of source.matchAll(/font-family:\s*['"]([^'"]+)['"]/g)) loaded.add(name);
  };
  for (const [, spec] of css.matchAll(/@import '(@fontsource[^']+)';/g)) {
    let resolved: string;
    try {
      resolved = require.resolve(spec);
    } catch {
      problems.push(t.notInstalled(spec));
      continue;
    }
    faces(await fs.readFile(resolved, 'utf8'));
  }
  for (const [, rel] of css.matchAll(/url\('(\.\/fonts\/[^']+)'\)/g)) {
    if ((await read(path.join(dir, rel))) === null) problems.push(t.themeFile(rel));
  }
  for (const [, block] of css.matchAll(/@font-face\s*{([^}]*)}/g)) faces(block);

  // Families the brand names anywhere: brand.json stacks and preloads, theme tokens, fontFamily literals in its code.
  const named = new Map<string, string>();
  const stack = (value: string, where: string) => {
    for (const part of value.split(',')) {
      const name = part.trim();
      if (/^['"]/.test(name)) named.set(name.slice(1, -1), where);
      else if (name && !GENERIC_FAMILIES.has(name) && /\s/.test(name)) named.set(name, where);
    }
  };
  for (const key of FONT_TOKENS) stack(file.fonts?.[key] ?? '', `brand.json fonts.${key}`);
  for (const face of file.fonts?.preload ?? []) {
    const name = /'([^']+)'/.exec(face)?.[1];
    if (name) named.set(name, 'brand.json fonts.preload');
  }
  for (const [, name, value] of css.matchAll(/--(font-[\w-]+):\s*([^;]+);/g)) {
    if (!name.endsWith('feature-settings')) stack(value, `theme.css --${name}`);
  }
  const sources = (await fs.readdir(dir, { recursive: true, encoding: 'utf8' })).filter((f) => /\.(tsx?|svg)$/.test(f));
  for (const rel of sources) {
    const source = await fs.readFile(path.join(dir, rel), 'utf8');
    for (const [, value] of source.matchAll(/font-?[Ff]amily[=:]\s*\{?\s*["'`]([^"'`]+)["'`]/g)) stack(value, rel);
  }
  for (const [name, where] of named) {
    if (!loaded.has(name)) problems.push(t.fontNotLoaded(where, name));
  }
  return problems;
}
