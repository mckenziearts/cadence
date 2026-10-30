import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { PNG } from 'pngjs';
import { PixelSeamService } from '../../server/capture/seams';
import type { CaptureService, Hub } from '../../server/contracts';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import type { ServerEvent } from '../../src/shared/types';
import { makeRoot, type TestRoot } from './helpers';

let t: TestRoot;
let store: FileProjectStore;
let shots: [string, number][];
let events: ServerEvent[];
let seams: PixelSeamService;

/** Every scene is a flat colour of its own: any cut compared pixel by pixel differs everywhere. */
function flat(sceneId: string): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  const shade = [...sceneId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 256;
  for (let i = 0; i < png.data.length; i += 4) png.data.set([shade, 255 - shade, 0, 255], i);
  return PNG.sync.write(png);
}

beforeEach(async () => {
  t = await makeRoot();
  store = new FileProjectStore(t.config, { templates: new FileTemplateStore(t.config), brands: new FileBrandStore(t.config) });
  await store.create({ name: 'Démo', brand: null, formats: ['16:9', '9:16'], fps: 30 });
  await store.createScene('demo', { name: 'Milieu', duration: 2 });
  await store.createScene('demo', { name: 'Fin', duration: 2 });
  shots = [];
  events = [];
  const capture = {
    frames: async (_id: string, req: { sceneId: string; times: number[] }) =>
      req.times.map((time) => (shots.push([req.sceneId, time]), { t: time, image: flat(req.sceneId), errors: [] })),
  } as unknown as CaptureService;
  seams = new PixelSeamService({ store, capture, hub: { send: (e: ServerEvent) => void events.push(e) } as Hub });
});

afterEach(() => t.cleanup());

test('a cut with a transition reports it as it plays without capturing either frame, in order with the compared cuts', async () => {
  // Declared 1.5 s, it plays 1 s: half of Milieu (2 s).
  await store.setTransition('demo', 'milieu', { kind: 'fade', duration: 1.5 });
  const fade = { kind: 'fade' as const, duration: 1 };

  const results = await seams.check('demo');
  assert.deepEqual(
    results.map((r) => [r.from, r.to, r.format, r.transition ?? r.diffPercent]),
    [
      ['titre', 'milieu', '16:9', fade],
      ['milieu', 'fin', '16:9', 100],
      ['titre', 'milieu', '9:16', fade],
      ['milieu', 'fin', '9:16', 100],
    ],
  );
  assert.equal(results[0].diffPercent, 0);
  assert.deepEqual(shots, [
    ['milieu', 2],
    ['fin', 0],
    ['milieu', 2],
    ['fin', 0],
  ]);
  assert.deepEqual(events.at(-1), { type: 'seams', projectId: 'demo', results });

  // Scoped to the scene after the transition: both of its cuts, the transition first.
  assert.deepEqual(
    (await seams.check('demo', { sceneId: 'milieu', format: '9:16' })).map((r) => [r.from, r.to, Boolean(r.transition)]),
    [
      ['titre', 'milieu', true],
      ['milieu', 'fin', false],
    ],
  );

  // The seam dialog may draw a transition cut, but the cached status stays the transition.
  const detail = await seams.detail('demo', 'titre', 'milieu', '16:9');
  assert.equal(detail.result.diffPercent, 100);
  const cached = seams.cached('demo').find((r) => r.from === 'titre' && r.to === 'milieu' && r.format === '16:9');
  assert.deepEqual(cached?.transition, fade);

  // Without its transition, the cut is a hard cut again and gets compared.
  await store.setTransition('demo', 'milieu', null);
  shots = [];
  const hard = await seams.check('demo', { format: '16:9' });
  assert.deepEqual(
    hard.map((r) => [r.from, r.to, r.transition, r.diffPercent]),
    [
      ['titre', 'milieu', undefined, 100],
      ['milieu', 'fin', undefined, 100],
    ],
  );
  assert.ok(shots.some(([sceneId]) => sceneId === 'titre'));
});
