import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { brandProblems } from '../../server/brands/check';
import type { BrandKit, BrandKitUi } from '../../src/shared/brandKit';
import { uiSamples } from '../../src/shared/kitSamples';
import { LANGUAGES, type BrandFile } from '../../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BRANDS_DIR = path.join(ROOT, 'brands');
// cadence ships; the others are each person's content and stay on their machine (brands/ is gitignored), checked the
// same way. A brand still being built (`.building`) is left to its build.
const BRANDS = fs
  .readdirSync(BRANDS_DIR)
  .filter(
    (id) => fs.existsSync(path.join(BRANDS_DIR, id, 'brand.json')) && !fs.existsSync(path.join(BRANDS_DIR, id, '.building')),
  );
const UI_KEYS: (keyof BrandKitUi)[] = [
  'Card',
  'CardHeader',
  'CardBody',
  'CardFooter',
  'Button',
  'Input',
  'Badge',
  'Avatar',
  'Stat',
  'Toggle',
  'Tabs',
  'ListItem',
];

function render(element: ReactElement): string {
  const first = renderToStaticMarkup(element);
  assert.equal(renderToStaticMarkup(element), first, 'same props must give the same markup');
  assert.ok(first.length > 0);
  assert.doesNotMatch(first, /(src|href)="https?:|url\(\s*['"]?https?:/, 'no external URLs');
  assert.doesNotMatch(first, /style="[^"]*(transition|animation)/, 'no CSS transitions or animations');
  return first;
}

/** Every extra also renders with its animated states and edge cases (props an extra doesn't know are ignored). */
const STATES = { progress: 0.5, pressed: true, hovered: true, caret: true, highlight: 0.5, selected: true };
const EXTRA_CASES: Record<string, Record<string, unknown>[]> = {
  ProfileCard: [{ focus: 'bio', pressed: 'save', variant: 'default' }],
  PromptCard: [{ chars: 12, explode: 0.6 }],
  MediaCard: [{ bleed: 0.4, sun: 0.1 }],
};

test('the brand Cadence ships is present', () => {
  assert.ok(BRANDS.includes('cadence'), 'brands/cadence missing');
});

for (const id of BRANDS) {
  const dir = path.join(BRANDS_DIR, id);

  describe(`brand ${id}`, () => {
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8')) as BrandFile;

    test('passes the brand folder checks (brand.json, theme.css, fonts, logos, notes)', async () => {
      assert.deepEqual(await brandProblems(dir, ROOT), []);
    });

    test('index.tsx default export satisfies BrandKit and renders deterministically', async () => {
      const kit = (await import(path.join(dir, 'index.tsx'))).default as BrandKit;
      for (const key of ['id', 'name', 'tagline', 'url', 'language', 'voice'] as const) assert.equal(kit[key], file[key], key);
      assert.deepEqual(kit.colors, file.colors);
      assert.deepEqual(kit.fonts, file.fonts);
      assert.deepEqual(kit.radius, file.radius);
      for (const key of UI_KEYS) assert.equal(typeof kit.ui[key], 'function', `ui.${key}`);

      for (const language of LANGUAGES) {
        for (const [name, element] of uiSamples(kit.ui, language)) {
          assert.doesNotThrow(() => render(element), `${name} (${language})`);
        }
      }
      const Button = kit.ui.Button;
      const merged = render(
        <Button className="scene-class" style={{ left: 7, color: 'rgb(1, 2, 3)' }}>
          OK
        </Button>,
      );
      assert.match(merged, /class="scene-class"/);
      assert.match(merged, /left:7px/);
      assert.match(merged, /color:rgb\(1, 2, 3\)/, 'style is merged last');

      const Logo = kit.Logo;
      for (const variant of ['mark', 'full'] as const) {
        const svg = render(<Logo variant={variant} height={80} />);
        assert.match(svg, /height="80"/);
        assert.match(render(<Logo variant={variant} height={40} color="#ffffff" />), /#ffffff/i);
      }

      const extras = Object.entries(kit.extras);
      assert.ok(extras.length >= 2 && extras.length <= 6, 'two to six extras');
      for (const [name, extra] of extras) {
        assert.equal(typeof extra.component, 'function', name);
        assert.ok(extra.description.length > 20, `${name} description`);
        const Extra = extra.component;
        assert.doesNotThrow(() => render(<Extra />), name);
        assert.doesNotThrow(() => render(<Extra {...STATES} />), `${name} states`);
        for (const props of EXTRA_CASES[name] ?? [])
          assert.doesNotThrow(() => render(<Extra {...props} />), `${name} ${JSON.stringify(props)}`);
        assert.match(render(<Extra className="scene-class" style={{ top: 3 }} />), /top:3px/, `${name} merges style`);
      }

      assert.ok(kit.copy.taglines.length > 0 && kit.copy.taglines.every((line) => line.trim().length > 0));
      assert.ok(kit.copy.features.length > 0);
      for (const feature of kit.copy.features) assert.ok(feature.title.trim() && feature.body.trim());
    });
  });
}

test('the brand checks report what a broken brand gets wrong', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-brand-')), 'acme');
  fs.cpSync(path.join(BRANDS_DIR, 'cadence'), dir, { recursive: true });
  try {
    assert.match((await brandProblems(dir, ROOT)).join('\n'), /id « cadence » au lieu de « acme »/);
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8')) as BrandFile;
    file.id = 'acme';
    file.colors.accent = '#FF0000';
    file.fonts.preload.push("400 32px 'Nowhere Sans'");
    fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(file));
    fs.appendFileSync(path.join(dir, 'theme.css'), "\n@import '@fontsource/nowhere-sans';\n");
    fs.writeFileSync(path.join(dir, 'KIT.md'), 'Trop court.');
    fs.writeFileSync(path.join(dir, file.logo.mark), '<svg viewBox="0 0 10 10"><image href="https://x.test/a.png"/></svg>');
    const problems = (await brandProblems(dir, ROOT)).join('\n');
    for (const expected of [
      /colors\.accent doit être un hex #rrggbb en minuscules/,
      /la police préchargée Nowhere Sans n’est dans aucune pile/,
      /--color-accent doit valoir #FF0000/,
      /@fontsource\/nowhere-sans n’est pas installé/,
      /KIT\.md doit être rédigé/,
      /logo\.mark doit se suffire à lui-même/,
      /nomme la police « Nowhere Sans », que theme\.css ne charge jamais/,
    ]) {
      assert.match(problems, expected);
    }
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
