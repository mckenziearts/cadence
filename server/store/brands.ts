import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ID_PATTERN, type BrandFile, type BrandSummary } from '../../src/shared/types';
import type { BrandStore, CadenceConfig } from '../contracts';
import { m } from '../i18n';
import { HttpError, assertId, pathExists } from '../util';

/** Brand used when a project has none (`brand: null`). */
export const DEFAULT_BRAND = 'cadence';
/** In a brand folder Claude is still building (server/brands/build.ts): the brand is not listed yet. */
export const BUILDING_MARKER = '.building';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: () => m().api.brands.hex });

const brandSchema = z.object({
  name: z.string().min(1),
  tagline: z.string(),
  url: z.string(),
  language: z.enum(['fr', 'en']),
  colors: z.object({
    background: hex,
    surface: hex,
    ink: hex,
    muted: hex,
    line: hex,
    primary: hex,
    primaryInk: hex,
    accent: hex,
    success: hex,
    warning: hex,
    danger: hex,
  }),
  fonts: z.object({ display: z.string(), body: z.string(), mono: z.string(), preload: z.array(z.string()) }),
  radius: z.object({ sm: z.number(), md: z.number(), lg: z.number(), xl: z.number() }),
  logo: z.object({ mark: z.string().min(1), full: z.string().min(1) }),
  voice: z.string(),
});

/** Agent-facing summary of src/shared/brandKit.ts: the same kit API exists for every brand. */
const KIT_SUMMARY = `## Kit (identical API for every brand)

\`const { ui, Logo, colors, fonts, radius, extras, copy } = useBrand();\` (also \`props.brand\`). Kit components are
presentational: they accept \`style\` and \`className\` (merged last) and expose every visual state as a prop, so
animate states from \`t\`, never from React state.

- \`<Logo variant="mark" | "full" height={48} color?>\`: mark = symbol only, full = symbol + wordmark; \`color\` forces one color.
- \`<ui.Card variant="default|muted|outline|elevated" padding?>\` with \`<ui.CardHeader>\`, \`<ui.CardBody>\`, \`<ui.CardFooter>\`.
- \`<ui.Button variant="primary|secondary|ghost|danger" size="sm|md|lg" pressed? hovered? icon?>\`
- \`<ui.Input label? value? placeholder? focused? caret? hint? invalid? multiline?>\`: typed text = \`value\` + \`caret\`.
- \`<ui.Badge tone="neutral|primary|success|warning|danger">\`
- \`<ui.Avatar name src? size?>\`: initials when there is no \`src\`.
- \`<ui.Stat label value delta? trend="up|down|neutral">\`
- \`<ui.Toggle on label?>\`
- \`<ui.Tabs items active>\`: a fractional \`active\` slides the indicator between tabs.
- \`<ui.ListItem title subtitle? leading? trailing? selected?>\`
- \`extras.<Name>\` = \`{ component, description }\`: brand-specific showcase components, also named exports of \`@brands/<id>\`.
- \`copy.taglines\`, \`copy.features\`: real product copy to reuse.

Colors and fonts are also Tailwind theme tokens in every frame (\`bg-primary\`, \`bg-surface\`, \`text-ink\`,
\`font-display\`, \`font-body\`, \`font-mono\`…).`;

/** Brand presets in brands/<id>/ (brand.json validated on read). */
export class FileBrandStore implements BrandStore {
  constructor(private config: CadenceConfig) {}

  dir(id: string): string {
    return path.join(this.config.brandsDir, assertId(id, m().api.ids.brand));
  }

  async exists(id: string): Promise<boolean> {
    return ID_PATTERN.test(id) && pathExists(path.join(this.config.brandsDir, id, 'brand.json'));
  }

  async get(id: string): Promise<BrandFile> {
    const file = path.join(this.dir(id), 'brand.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, m().api.brands.notFound(id));
      throw new HttpError(500, m().api.unreadableFile(`brands/${id}/brand.json`, (e as Error).message));
    }
    const parsed = brandSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ');
      throw new HttpError(500, m().api.invalidFile(`brands/${id}/brand.json`, issues));
    }
    // The folder name is the brand's identity, whatever brand.json says.
    return { id, ...parsed.data };
  }

  async list(): Promise<BrandSummary[]> {
    const entries = await fs.readdir(this.config.brandsDir, { withFileTypes: true }).catch(() => []);
    const out: BrandSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !(await this.exists(entry.name))) continue;
      if (await pathExists(path.join(this.dir(entry.name), BUILDING_MARKER))) continue;
      try {
        const brand = await this.get(entry.name);
        const { primary, background, ink, accent } = brand.colors;
        out.push({
          id: brand.id,
          name: brand.name,
          tagline: brand.tagline,
          colors: { primary, background, ink, accent },
          logoUrl: `/api/brands/${brand.id}/logo?variant=mark`,
        });
      } catch (e) {
        console.warn(m().api.brands.skipped((e as Error).message));
      }
    }
    const rank = (b: BrandSummary) => (b.id === DEFAULT_BRAND ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr'));
  }

  async remove(id: string): Promise<void> {
    if (await pathExists(path.join(this.dir(id), BUILDING_MARKER))) {
      throw new HttpError(409, m().api.brands.building);
    }
    if (!(await this.exists(id))) throw new HttpError(404, m().api.brands.notFound(id));
    const trash = path.join(this.config.stateDir, 'trash', 'brands');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(this.dir(id), path.join(trash, `${id}-${Date.now()}`));
  }

  async describe(id: string | null): Promise<string> {
    const brandId = id ?? DEFAULT_BRAND;
    const brand = await this.get(brandId);
    const dir = this.dir(brandId);
    const kitNotes = await fs.readFile(path.join(dir, 'KIT.md'), 'utf8').catch(() => null);
    const assets = await fs.readdir(path.join(dir, 'assets')).catch(() => [] as string[]);
    const language = brand.language === 'fr' ? 'French' : 'English';
    const lines = [
      `# Brand: ${brand.name} (\`${brand.id}\`)`,
      '',
      `${brand.tagline}${brand.url ? ` · ${brand.url}` : ''}`,
      '',
      `- Language of all on-screen copy: ${language}.`,
      `- Voice: ${brand.voice}`,
      '',
      '## Tokens (`brand.colors`, `brand.fonts`, `brand.radius`)',
      '',
      ...Object.entries(brand.colors).map(([name, value]) => `- \`colors.${name}\`: ${value}`),
      `- \`fonts.display\`: ${brand.fonts.display}`,
      `- \`fonts.body\`: ${brand.fonts.body}`,
      `- \`fonts.mono\`: ${brand.fonts.mono}`,
      `- \`radius\`: sm ${brand.radius.sm} px · md ${brand.radius.md} px · lg ${brand.radius.lg} px · xl ${brand.radius.xl} px`,
      '',
      KIT_SUMMARY,
    ];
    const files = assets.filter((name) => !name.startsWith('.'));
    if (files.length) {
      lines.push('', '## Brand assets', '', ...files.map((name) => `- \`@brands/${brand.id}/assets/${name}\``));
    }
    if (kitNotes?.trim()) lines.push('', `## Kit notes (brands/${brand.id}/KIT.md)`, '', kitNotes.trim());
    return `${lines.join('\n')}\n`;
  }
}
