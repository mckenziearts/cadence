// Tools of a brand build (scope 'brand'). The turn's file tools write brands/<id>/ and read the cloned repository; these
// copy the product's binary files out of the clone, vendor a Google font, show the kit sheet and check the brand.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { checkBrand } from '../brands/check';
import { vendorGoogleFont } from '../brands/fonts';
import type { McpScope } from '../contracts';
import { HttpError, isInside, resolveInside } from '../util';
import type { McpDeps, ToolRegistrar } from './tools';

export const BRAND_TOOLS = ['copy_from_repo', 'add_google_font', 'preview_brand', 'check_brand'];
const COPYABLE = /\.(svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf)$/i;
const MAX_COPY_BYTES = 5 * 1024 * 1024;

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

export function registerBrandTools(tool: ToolRegistrar, scope: Extract<McpScope, { kind: 'brand' }>, deps: McpDeps): void {
  const brandDir = deps.brands.dir(scope.brandId);
  const problemsText = (problems: string[]) =>
    problems.length ? `${problems.length} problem(s):\n- ${problems.join('\n- ')}` : 'No problem: the brand is complete.';

  tool(
    'copy_from_repo',
    'Copy a binary file of the product (logo, image or font: svg, png, jpg, webp, gif, avif, ico, woff2, woff, ttf, otf; 5 MB at most) from the cloned repository into the brand folder. For text files, read them and write what the brand needs instead.',
    {
      from: z.string().describe('Path inside the repository, e.g. public/images/logo.svg'),
      to: z.string().describe('Path inside the brand folder, e.g. assets/logo-mark.svg or fonts/rota-regular.woff2'),
    },
    async ({ from, to }) => {
      const source = resolveInside(scope.repoDir, from);
      const target = resolveInside(brandDir, to);
      if (!COPYABLE.test(source) || !COPYABLE.test(target)) {
        throw new HttpError(400, `Only logos, images and fonts can be copied (${from} to ${to})`);
      }
      // The clone has no symbolic links left, but a file must still resolve inside it.
      const real = await fs.realpath(source).catch(() => null);
      if (!real || !isInside(await fs.realpath(scope.repoDir), real)) throw new HttpError(404, `Not in the repository: ${from}`);
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new HttpError(400, `Not a file: ${from}`);
      if (stat.size > MAX_COPY_BYTES) throw new HttpError(413, `${from} is over 5 MB`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(real, target);
      return text(`Copied ${from} to ${path.relative(brandDir, target)} (${Math.ceil(stat.size / 1024)} KB).`);
    },
  );

  tool(
    'add_google_font',
    'Download a Google Fonts family into the fonts/ folder of the brand and get the @font-face rules to paste into theme.css, after its @import lines. Use it when the product font is neither an installed @fontsource package nor a font file of the repository.',
    {
      family: z.string().describe('Exact Google Fonts family name, e.g. "Plus Jakarta Sans"'),
      weights: z.array(z.number().int().min(100).max(900)).max(9).optional().describe('Default: 400, 500, 600, 700'),
      italic: z.boolean().optional().describe('Also the italic faces'),
    },
    async (args) => {
      const font = await vendorGoogleFont(brandDir, args.family, {
        weights: args.weights ?? [400, 500, 600, 700],
        italic: args.italic ?? false,
      });
      return text(
        `Saved ${font.files.join(', ')} (faces: ${font.weights.join(', ')}). Paste these rules into theme.css:\n\n${font.css}`,
      );
    },
  );

  tool(
    'preview_brand',
    'Render the kit sheet of the brand being built (logos, colors, fonts, every UI component with sample props, extras) in the sandboxed frame page, and look at it. Problems met while rendering are listed under the image.',
    {},
    async () => {
      const { image, problems } = await deps.capture.kitSheet(scope.brandId, { scale: 0.5 });
      return {
        content: [
          { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text', text: problems.length ? problemsText(problems) : 'Rendered without errors.' },
        ],
      };
    },
    true,
  );

  tool(
    'check_brand',
    'Check the brand folder the way Cadence will before listing the brand: brand.json, theme.css, fonts, logos, notes, then the kit rendered in the sandboxed page. Fix what it reports and call it again until there is no problem.',
    {},
    async () => {
      const problems = await checkBrand({
        dir: brandDir,
        root: deps.config.root,
        capture: deps.capture,
        diagnose: deps.diagnose,
      });
      return text(problemsText(problems));
    },
    true,
  );
}
