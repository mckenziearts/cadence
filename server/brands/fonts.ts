// A Google font vendored into a brand's fonts/ folder: frames and the kit page only load fonts from their own origin,
// and a brand built from a repository rarely uses one of the @fontsource packages Cadence ships.
import fs from 'node:fs/promises';
import path from 'node:path';
import { m } from '../i18n';
import { HttpError, shortHash, slugify } from '../util';

const CSS_API = 'https://fonts.googleapis.com/css2';
const FILES = 'https://fonts.gstatic.com/';
/** Google sends woff2 only to browsers it knows. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** French and English text. Fonts without them (CJK...) keep every subset. */
const SUBSETS = new Set(['latin', 'latin-ext']);

interface Face {
  subset: string;
  style: string;
  weight: string;
  url: string;
  range: string | null;
}

/**
 * Download `family` from Google Fonts into `<brandDir>/fonts/` and return the @font-face rules to put in theme.css.
 * Weights the family lacks make Google refuse the request: then only its regular face is taken.
 */
export async function vendorGoogleFont(
  brandDir: string,
  family: string,
  opts: { weights: number[]; italic: boolean },
): Promise<{ css: string; files: string[]; weights: string[] }> {
  const name = family.trim();
  if (!/^[\p{L}\p{N} ]{1,60}$/u.test(name)) throw new HttpError(400, m().media.brands.fonts.invalidName(family));
  const weights = [...new Set(opts.weights)].filter((w) => w >= 100 && w <= 900).sort((a, b) => a - b);
  const axes = opts.italic
    ? `:ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(';')}`
    : `:wght@${weights.join(';')}`;
  const query = (spec: string) => `${CSS_API}?family=${encodeURIComponent(name).replace(/%20/g, '+')}${spec}&display=swap`;
  let css = weights.length ? await fetchText(query(axes)) : null;
  css ??= await fetchText(query(''));
  if (css === null) throw new HttpError(404, m().media.brands.fonts.unknown(name));

  const faces: Face[] = [];
  for (const [, subset, block] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g)) {
    const url = /src:\s*url\((https:[^)]+)\)/.exec(block)?.[1];
    if (!url?.startsWith(FILES)) continue;
    faces.push({
      subset,
      style: /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal',
      weight: /font-weight:\s*([\d ]+)/.exec(block)?.[1].trim() ?? '400',
      url,
      range: /unicode-range:\s*([^;]+);/.exec(block)?.[1].trim() ?? null,
    });
  }
  const kept = faces.some((f) => SUBSETS.has(f.subset)) ? faces.filter((f) => SUBSETS.has(f.subset)) : faces;
  if (!kept.length) throw new HttpError(502, m().media.brands.fonts.noFile(name));

  const dir = path.join(brandDir, 'fonts');
  await fs.mkdir(dir, { recursive: true });
  const files = new Map<string, string>();
  for (const face of kept) {
    if (files.has(face.url)) continue;
    const file = `${slugify(name, 'police')}-${shortHash(face.url)}.woff2`;
    const res = await fetch(face.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new HttpError(502, m().media.brands.fonts.refused(name, res.status));
    await fs.writeFile(path.join(dir, file), Buffer.from(await res.arrayBuffer()));
    files.set(face.url, file);
  }
  const rules = kept.map((face) =>
    [
      '@font-face {',
      `  font-family: '${name}';`,
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weight};`,
      `  src: url('./fonts/${files.get(face.url)}') format('woff2');`,
      ...(face.range ? [`  unicode-range: ${face.range};`] : []),
      '}',
    ].join('\n'),
  );
  return {
    css: rules.join('\n'),
    files: [...files.values()].map((file) => `fonts/${file}`),
    weights: [...new Set(kept.map((f) => `${f.style === 'italic' ? 'italic ' : ''}${f.weight}`))],
  };
}

/** The stylesheet, or null when Google refuses the request (unknown family or weights). */
async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, m().media.brands.fonts.down(res.status));
  return res.text();
}
