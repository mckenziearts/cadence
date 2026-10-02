// Template library: metadata, campaign consistency, source rules, shared blocks, and a render of every scene template
// for every brand × declared format × several times, the way the frame renders it (contexts + createMusic).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandContext, SceneContext, createMusic, type SceneProps } from 'cadence';
import type { CadenceConfig } from '../../server/contracts';
import { FileTemplateStore } from '../../server/store/templates';
import type { BrandKit } from '../../src/shared/brandKit';
import { FORMATS, ID_PATTERN, type FormatId, type MusicGridData } from '../../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TEMPLATES = path.join(ROOT, 'templates');
const BRANDS = path.join(ROOT, 'brands');
const store = new FileTemplateStore({ templatesDir: TEMPLATES } as CadenceConfig);

const sceneIds = fs
  .readdirSync(path.join(TEMPLATES, 'scenes'))
  .filter((id) => fs.existsSync(path.join(TEMPLATES, 'scenes', id, 'template.json')));
const campaignIds = fs
  .readdirSync(path.join(TEMPLATES, 'projects'))
  .filter((id) => fs.existsSync(path.join(TEMPLATES, 'projects', id, 'template.json')));

/** Expected length of each campaign, seconds (from its description). */
const CAMPAIGN_LENGTH: Record<string, [number, number]> = {
  'teaser-produit': [44, 48],
  'lancement-fonctionnalite': [18, 22],
  'reseaux-sociaux-vertical': [13, 17],
  nouveautes: [28, 32],
};

const BASE_MARK = '// Shared by every template';
const CARD_MARK = '// Shared by the teaser templates';
const source = (id: string) => fs.readFileSync(path.join(TEMPLATES, 'scenes', id, 'scene.tsx'), 'utf8');

test('the library holds the expected templates', () => {
  for (const id of [
    'wireframe-glow',
    'exploded-anatomy',
    'variant-pills',
    'surface-grid',
    'zoom-annotate',
    'cursor-demo',
    'full-bleed',
    'logo-build',
  ]) {
    assert.ok(sceneIds.includes(id), `scene template ${id}`);
  }
  assert.ok(sceneIds.length >= 15, `${sceneIds.length} scene templates`);
  for (const id of Object.keys(CAMPAIGN_LENGTH)) assert.ok(campaignIds.includes(id), `campaign template ${id}`);
});

describe('scene templates', () => {
  for (const id of sceneIds) {
    test(`${id}: template.json is valid and documents its first and last frame`, async () => {
      assert.match(id, ID_PATTERN);
      const { meta, code } = await store.sceneTemplate(id);
      assert.equal(meta.id, id);
      assert.ok(meta.name.trim() && meta.description.length > 60, 'name and description');
      assert.match(meta.description, /Commence/, 'the description says how the scene starts');
      assert.match(meta.description, /finit|fin de vidéo/i, 'the description says how the scene ends');
      assert.ok(meta.bars >= 1 && meta.bars <= 16, 'bars');
      assert.ok(meta.formats.length > 0);
      assert.ok(meta.customize.length > 0 && meta.tags.length > 0);
      assert.ok(code.includes('export default function'), 'default export');
    });

    test(`${id}: scene.tsx follows the scene contract`, () => {
      const code = source(id);
      const imports = [...code.matchAll(/^(?:import[^;]*?|\}) from '([^']+)';$/gms)].map((m) => m[1]);
      assert.deepEqual(
        imports.filter((spec) => spec !== 'react' && spec !== 'cadence'),
        [],
        'only react and cadence are imported',
      );
      for (const [pattern, why] of [
        [/Math\.random|Date\.now|performance\.now/, 'no clock or randomness'],
        [/setTimeout|setInterval|requestAnimationFrame/, 'no timers'],
        [/\buse(State|Effect|LayoutEffect|Reducer|Ref)\b/, 'no state or effects'],
        [/\bfetch\(|XMLHttpRequest|<video/, 'no network or video'],
        [/\b(transition|animation)\s*:/, 'no CSS transitions or animations'],
        [/[\u00a0\u202f]/, 'no invisible no-break spaces in the source (use \\u00a0 / \\u202f)'],
      ] as const) {
        assert.doesNotMatch(code, pattern, why);
      }
      assert.match(code, /^const TIMING = /m, 'editable TIMING constant');
      assert.ok(code.includes(BASE_MARK), 'ends with the shared base block');
    });
  }

  test('shared blocks are identical in every template (invisible cuts depend on it)', () => {
    const tail = (code: string, mark: string, stop?: string) => {
      const start = code.indexOf(mark);
      const end = stop && code.indexOf(stop) > start ? code.indexOf(stop) : code.length;
      return code.slice(start, end).trimEnd();
    };
    const codes = sceneIds.map((id) => ({ id, code: source(id) }));
    const bases = new Set(codes.map(({ code }) => tail(code, BASE_MARK, CARD_MARK)));
    assert.equal(bases.size, 1, 'one base block');
    const teaser = codes.filter(({ code }) => code.includes(CARD_MARK));
    assert.ok(teaser.length >= 6, 'the teaser templates share the hero card');
    assert.equal(new Set(teaser.map(({ code }) => tail(code, CARD_MARK))).size, 1, 'one hero-card block');
  });
});

describe('campaign templates', () => {
  for (const id of campaignIds) {
    test(`${id}: valid, uses existing scene templates in formats they support`, async () => {
      const campaign = await store.projectTemplate(id);
      assert.ok(campaign.artDirection && campaign.artDirection.length > 400, 'art-direction.md');
      assert.match(campaign.artDirection ?? '', /^## /m, 'appended under the brand art direction');
      for (const scene of campaign.scenes) {
        const { meta } = await store.sceneTemplate(scene.template);
        for (const format of campaign.formats)
          assert.ok(meta.formats.includes(format), `${scene.template} lays out in ${format}`);
      }
      const seconds = campaign.scenes.reduce((sum, s) => sum + (s.bars * 240) / campaign.bpm, 0);
      const [min, max] = CAMPAIGN_LENGTH[id] ?? [1, 120];
      assert.ok(seconds >= min && seconds <= max, `${seconds.toFixed(1)} s within ${min}-${max} s`);
    });
  }

  test("the teaser follows Caleb's structure at 145 BPM", async () => {
    const teaser = await store.projectTemplate('teaser-produit');
    assert.equal(teaser.bpm, 145);
    assert.deepEqual(
      teaser.scenes.map((s) => [s.template, s.bars]),
      [
        ['wireframe-glow', 4],
        ['exploded-anatomy', 2],
        ['variant-pills', 2],
        ['surface-grid', 3],
        ['zoom-annotate', 6],
        ['cursor-demo', 4],
        ['full-bleed', 3],
        ['logo-build', 4],
      ],
    );
    assert.deepEqual(teaser.formats, ['16:9', '9:16']);
  });

  test('art directions leave tempo and seconds to the music context', async () => {
    for (const id of campaignIds) {
      const { artDirection } = await store.projectTemplate(id);
      assert.doesNotMatch(artDirection ?? '', /\bBPM\b|1 mesure\s*[=≈]/, id);
    }
  });

  test("the teaser asks for the product's real card styles instead of the example ones", async () => {
    assert.match((await store.projectTemplate('teaser-produit')).artDirection ?? '', /vraies variantes/);
    for (const id of ['variant-pills', 'surface-grid']) {
      assert.match((await store.sceneTemplate(id)).meta.customize.join(' '), /vraies variantes/, id);
    }
  });
});

// Rendering

/** A music grid with a track: 128 BPM, first beat 0.1 s into the scene, downbeats every 4 beats. */
function trackGrid(): MusicGridData {
  const beats = Array.from({ length: 64 }, (_, i) => 0.1 + (i * 60) / 128);
  return {
    bpm: 128,
    beatsPerBar: 4,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    phrases: beats.filter((_, i) => i % 16 === 0),
    sections: [{ start: 0, end: 30, label: 'A', energy: 0.6 }],
    accents: [{ t: 1.2, strength: 0.8 }],
    waveform: [],
    duration: 30,
    confidence: 0.9,
  };
}

function render(
  Scene: ComponentType<SceneProps>,
  brand: BrandKit,
  format: FormatId,
  t: number,
  duration: number,
  grid: MusicGridData | null,
) {
  const spec = FORMATS[format];
  const props: SceneProps = {
    t,
    duration,
    width: spec.width,
    height: spec.height,
    format,
    orientation: spec.orientation,
    fps: 60,
    music: createMusic({ grid, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: duration }),
    voiceOver: { text: '', lines: [] },
    scene: { id: 'scene', name: 'Scène', index: 0, count: 1, start: 0 },
    brand,
  };
  return renderToStaticMarkup(
    <BrandContext.Provider value={brand}>
      <SceneContext.Provider value={props}>
        <Scene {...props} />
      </SceneContext.Provider>
    </BrandContext.Provider>,
  );
}

const brandIds = fs.readdirSync(BRANDS).filter((id) => fs.existsSync(path.join(BRANDS, id, 'index.tsx')));

describe('every scene template renders for every brand, format and time', () => {
  for (const brandId of brandIds) {
    test(`brand ${brandId}`, async (t) => {
      let brand: BrandKit;
      try {
        brand = (await import(path.join(BRANDS, brandId, 'index.tsx'))).default as BrandKit;
        assert.ok(brand?.ui?.Card);
      } catch (e) {
        // A brand being built elsewhere may not load yet: its own tests (tests/brands) report it.
        t.skip(`brand kit does not load: ${(e as Error).message.split('\n')[0]}`);
        return;
      }
      // React reports its warnings (a list item without a key...) through console.error.
      const warnings = t.mock.method(console, 'error', () => undefined);
      for (const id of sceneIds) {
        const { meta } = await store.sceneTemplate(id);
        const Scene = (await import(path.join(TEMPLATES, 'scenes', id, 'scene.tsx'))).default as ComponentType<SceneProps>;
        const duration = (meta.bars * 240) / 120;
        for (const format of meta.formats) {
          for (const at of [0, 0.2, 0.45, 0.7, 1]) {
            const time = Math.round(at * duration * 1000) / 1000;
            const label = `${id}, ${format}, t=${time}`;
            let html = '';
            assert.doesNotThrow(() => (html = render(Scene, brand, format, time, duration, null)), label);
            assert.ok(html.length > 50, `${label}: renders something`);
            assert.equal(render(Scene, brand, format, time, duration, null), html, `${label}: same props, same markup`);
            assert.doesNotMatch(html, /(src|href)="https?:|url\(\s*['"]?https?:/, `${label}: no external URL`);
          }
        }
        // Squeezed and stretched durations, and a real track grid, must not break the timelines.
        for (const [duration2, grid] of [
          [0.5, null],
          [duration * 2.5, null],
          [duration, trackGrid()],
        ] as const) {
          for (const at of [0, 0.5, 1]) {
            assert.doesNotThrow(
              () => render(Scene, brand, meta.formats[0], at * duration2, duration2, grid),
              `${id}, ${duration2} s, t=${at}`,
            );
          }
        }
      }
      assert.deepEqual(
        warnings.mock.calls.map((call) => String(call.arguments[0])),
        [],
      );
    });
  }
});

test('wireframe-glow keeps its canvas-wide guides out of <Glow> (a filter over them costs ~1 s per frame in 3D)', async () => {
  const brand = (await import(path.join(BRANDS, 'cadence', 'index.tsx'))).default as BrandKit;
  const Scene = (await import(path.join(TEMPLATES, 'scenes', 'wireframe-glow', 'scene.tsx')))
    .default as ComponentType<SceneProps>;
  const html = render(Scene, brand, '16:9', 1.5, 8, null);
  const glow = html.indexOf(' filter="url(#');
  assert.ok(glow > 0 && html.includes('H3840'), 'the guides and the plan are drawing');
  for (const [, d] of html.slice(glow, html.indexOf('</svg>', glow)).matchAll(/ d="([^"]+)"/g)) {
    for (const n of d.match(/-?\d+(?:\.\d+)?/g) ?? []) assert.ok(+n >= 0 && +n <= 1920, `inside <Glow>: ${d}`);
  }
});

test('logo-build thumps on the bars of a track, never in a silent video', async () => {
  const brand = (await import(path.join(BRANDS, 'cadence', 'index.tsx'))).default as BrandKit;
  const Scene = (await import(path.join(TEMPLATES, 'scenes', 'logo-build', 'scene.tsx'))).default as ComponentType<SceneProps>;
  const thump = /transform-origin:960px 520px;transform:scale\(/;
  // On a downbeat after the lockup has landed: bar 3 of the steady 120 BPM grid, bar 3 of the track.
  assert.doesNotMatch(render(Scene, brand, '16:9', 6, 8, null), thump);
  assert.match(render(Scene, brand, '16:9', 0.1 + (12 * 60) / 128, 8, trackGrid()), thump);
});
