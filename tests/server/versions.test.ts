import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { FileProjectStore } from '../../server/store/projects';
import { FileVersionStore } from '../../server/store/versions';
import { sha256 } from '../../server/util';
import { makeRoot, nextEvent, rejectsWithStatus, type TestRoot } from './helpers';

let t: TestRoot;
let store: FileProjectStore;
let versions: FileVersionStore;
let dir: string;
const id = 'film';

beforeEach(async () => {
  t = await makeRoot();
  store = new FileProjectStore(t.config);
  versions = new FileVersionStore(store);
  dir = (await store.create({ name: 'Film', brand: null, formats: ['16:9'], fps: 60 })).dir;
  await store.createScene(id, { name: 'Deux', code: 'export default () => "deux v1";\n', duration: 2 });
});

afterEach(() => t.cleanup());

const read = (rel: string) => fs.readFile(path.join(dir, rel), 'utf8');
const write = async (rel: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
};
const baseline = () => versions.snapshot(id, { label: 'Point de départ', source: 'baseline' });

test('baseline records every tracked file and scene, content-addressed', async () => {
  await write('components/tokens.ts', 'export const X = 1;\n');
  const event = nextEvent(store.events, 'versions-changed', 1000);
  const v1 = await baseline();
  assert.deepEqual(await event, [id]);
  assert.ok(v1);
  assert.equal(v1.id, 'v0001');
  assert.equal(v1.source, 'baseline');
  assert.deepEqual(v1.files, ['art-direction.md', 'components/tokens.ts', 'project.json', 'scenes/deux.tsx', 'scenes/titre.tsx']);
  assert.deepEqual(v1.scenes, ['deux', 'titre']);
  const object = path.join(dir, '.cadence', 'versions', 'objects', sha256(await read('scenes/deux.tsx')));
  assert.equal(await fs.readFile(object, 'utf8'), 'export default () => "deux v1";\n');
  assert.deepEqual(await versions.list(id), [v1]);
});

test('snapshot returns null when nothing changed', async () => {
  await baseline();
  assert.equal(await versions.snapshot(id, { label: 'Rien', source: 'manual' }), null);
  assert.equal((await versions.list(id)).length, 1);
});

test('agent snapshots record what changed; list is newest first and filters by scene', async () => {
  await baseline();
  await write('scenes/deux.tsx', 'export default () => "deux v2";\n');
  const v2 = await versions.snapshot(id, {
    label: 'Rends le titre plus grand',
    source: 'agent',
    chatKey: 'scene:deux',
    costUsd: 0.42,
  });
  assert.deepEqual(
    { ...v2, createdAt: undefined },
    {
      id: 'v0002',
      createdAt: undefined,
      label: 'Rends le titre plus grand',
      source: 'agent',
      chatKey: 'scene:deux',
      scenes: ['deux'],
      files: ['scenes/deux.tsx'],
      costUsd: 0.42,
    },
  );
  await store.updateScene(id, 'titre', { duration: 5 });
  const v3 = await versions.snapshot(id, { label: 'Durée', source: 'manual' });
  assert.deepEqual(v3!.files, ['project.json']);
  assert.deepEqual(v3!.scenes, ['titre']);
  assert.deepEqual(
    (await versions.list(id)).map((v) => v.id),
    ['v0003', 'v0002', 'v0001'],
  );
  assert.deepEqual(
    (await versions.list(id, { sceneId: 'deux' })).map((v) => v.id),
    ['v0002', 'v0001'],
  );
});

test('text files over 2 MB and binary files are not tracked', async () => {
  await write('components/big.json', 'x'.repeat(2 * 1024 * 1024));
  await fs.writeFile(path.join(dir, 'components', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const v1 = await baseline();
  assert.ok(!v1!.files.includes('components/big.json'));
  assert.ok(!v1!.files.includes('components/image.png'));
});

test('whole restore: files back, deleted files restored, new files removed, recorded as a new version', async () => {
  await write('components/keep.ts', 'export const KEEP = 1;\n');
  await baseline();
  const original = await read('project.json');
  await write('scenes/titre.tsx', 'export default () => "titre v2";\n');
  await fs.rm(path.join(dir, 'components', 'keep.ts'));
  await write('components/extra.ts', 'export const EXTRA = 2;\n');
  await store.updateScene(id, 'deux', { duration: 7 });
  const v2 = await versions.snapshot(id, { label: 'Tour 2', source: 'agent' });

  const generation = store.generation(id);
  const restored = await versions.restore(id, 'v0001');
  assert.equal(restored.id, 'v0003');
  assert.equal(restored.source, 'restore');
  assert.equal(restored.label, 'Restauration de v0001');
  assert.deepEqual(restored.files, v2!.files);
  assert.equal(await read('project.json'), original);
  assert.equal(await read('components/keep.ts'), 'export const KEEP = 1;\n');
  await assert.rejects(fs.access(path.join(dir, 'components', 'extra.ts')));
  assert.equal((await store.get(id)).scenes.find((s) => s.id === 'deux')!.duration, 2);
  assert.ok(store.generation(id) > generation, 'frames reload the restored code');
  // Nothing was lost: the removed file is still in v0002.
  assert.equal(await versions.read(id, 'v0002', 'components/extra.ts'), 'export const EXTRA = 2;\n');
  assert.equal(
    await versions.snapshot(id, { label: 'Après', source: 'manual' }),
    null,
    'the restore version is the current state',
  );
});

test('restoring after unsaved edits first keeps them as an "external" version', async () => {
  await baseline();
  await write('scenes/titre.tsx', 'export default () => "edited in my editor";\n');
  const restored = await versions.restore(id, 'v0001');
  const list = await versions.list(id);
  assert.deepEqual(
    list.map((v) => [v.id, v.source]),
    [
      ['v0003', 'restore'],
      ['v0002', 'external'],
      ['v0001', 'baseline'],
    ],
  );
  assert.equal(restored.id, 'v0003');
  assert.equal(list[1].label, 'Modifications non enregistrées');
  assert.equal(await versions.read(id, 'v0002', 'scenes/titre.tsx'), 'export default () => "edited in my editor";\n');
  assert.notEqual(await read('scenes/titre.tsx'), 'export default () => "edited in my editor";\n');
});

test('scene restore: only that scene file and its duration', async () => {
  await baseline();
  await write('scenes/titre.tsx', 'export default () => "titre v2";\n');
  await write('scenes/deux.tsx', 'export default () => "deux v2";\n');
  await store.setDurations(id, { titre: 9, deux: 8 });
  await write('art-direction.md', '# Nouvelle direction\n');
  await versions.snapshot(id, { label: 'Tout change', source: 'agent' });

  const restored = await versions.restore(id, 'v0001', { sceneId: 'deux' });
  assert.equal(restored.source, 'restore');
  assert.equal(restored.label, 'Restauration de « Deux » (v0001)');
  assert.deepEqual(restored.scenes, ['deux']);
  assert.equal(await read('scenes/deux.tsx'), 'export default () => "deux v1";\n');
  assert.equal(await read('scenes/titre.tsx'), 'export default () => "titre v2";\n');
  assert.equal(await read('art-direction.md'), '# Nouvelle direction\n');
  const state = await store.get(id);
  assert.deepEqual(
    state.scenes.map((s) => [s.id, s.duration]),
    [
      ['titre', 9],
      ['deux', 2],
    ],
  );
});

test('scene restore brings back the voice-over of that version, or removes it when it had none', async () => {
  await store.updateScene(id, 'deux', { voiceOver: { text: 'Bonjour.', at: 0.5 } });
  await baseline();
  await store.updateScene(id, 'deux', { voiceOver: { text: 'Au revoir.', at: 1 } });
  await store.updateScene(id, 'titre', { voiceOver: { text: 'Titre.', at: 0 } });
  await versions.snapshot(id, { label: 'Voix', source: 'manual' });

  await versions.restore(id, 'v0001', { sceneId: 'deux' });
  let scenes = (await store.get(id)).scenes;
  assert.deepEqual(scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Bonjour.', at: 0.5 });
  assert.deepEqual(scenes.find((s) => s.id === 'titre')!.voiceOver, { text: 'Titre.', at: 0 });

  await versions.restore(id, 'v0001', { sceneId: 'titre' });
  scenes = (await store.get(id)).scenes;
  assert.equal(scenes.find((s) => s.id === 'titre')!.voiceOver, undefined);
  assert.deepEqual(scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Bonjour.', at: 0.5 });
});

test('a scene restore keeps the current voice-over when the version cannot say what it was', async () => {
  await store.updateScene(id, 'deux', { voiceOver: { text: 'Bonjour.', at: 0.5 } });
  const valid = await read('project.json');
  const withVoiceOver = async (voiceOver: unknown) => {
    const data = JSON.parse(valid);
    data.scenes.find((s: { id: string }) => s.id === 'deux').voiceOver = voiceOver;
    await write('project.json', JSON.stringify(data));
  };
  // Versions of project.json as an agent may leave it: unreadable, a voice-over the store refuses today, no `at`.
  await write('scenes/deux.tsx', 'export default () => null; // v1\n');
  await write('project.json', '{ broken');
  await versions.snapshot(id, { label: 'Illisible', source: 'manual' });
  await withVoiceOver({ text: 'x'.repeat(2500), at: 0 });
  await versions.snapshot(id, { label: 'Trop long', source: 'manual' });
  await withVoiceOver({ text: 'Sans départ.' });
  await versions.snapshot(id, { label: 'Sans départ', source: 'manual' });
  await write('project.json', valid);
  await write('scenes/deux.tsx', 'export default () => null; // v2\n');

  await versions.restore(id, 'v0001', { sceneId: 'deux' });
  assert.equal(await read('scenes/deux.tsx'), 'export default () => null; // v1\n');
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Bonjour.', at: 0.5 });
  await versions.restore(id, 'v0002', { sceneId: 'deux' });
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Bonjour.', at: 0.5 });
  await versions.restore(id, 'v0003', { sceneId: 'deux' });
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Sans départ.', at: 0 });
});

test("a voice-over-only edit lists the scene in the version and in that scene's history", async () => {
  await baseline();
  await store.updateScene(id, 'deux', { voiceOver: { text: 'Bonjour.', at: 0 } });
  const v2 = await versions.snapshot(id, { label: 'Voix', source: 'manual' });
  assert.deepEqual(v2!.files, ['project.json']);
  assert.deepEqual(v2!.scenes, ['deux']);
  assert.deepEqual(
    (await versions.list(id, { sceneId: 'deux' })).map((v) => v.id),
    ['v0002', 'v0001'],
  );
  assert.deepEqual(
    (await versions.list(id, { sceneId: 'titre' })).map((v) => v.id),
    ['v0001'],
  );
});

test('scene restore errors', async () => {
  await baseline();
  await store.createScene(id, { name: 'Trois' });
  await versions.snapshot(id, { label: 'Trois', source: 'manual' });
  await rejectsWithStatus(versions.restore(id, 'v0001', { sceneId: 'trois' }), 404, /n'existe pas dans la version v0001/);
  await store.deleteScene(id, 'deux');
  await rejectsWithStatus(versions.restore(id, 'v0001', { sceneId: 'deux' }), 409, /restaurez la version entière/);
  await rejectsWithStatus(versions.restore(id, 'v0099'), 404);
  await rejectsWithStatus(versions.restore(id, '../../x'), 404);
  await rejectsWithStatus(versions.list('absent'), 404);
});

test('read() returns a file at a version, or null', async () => {
  await baseline();
  assert.equal(await versions.read(id, 'v0001', 'scenes/deux.tsx'), 'export default () => "deux v1";\n');
  assert.equal(await versions.read(id, 'v0001', 'scenes/absent.tsx'), null);
  assert.equal(await versions.read(id, 'v0001', '../project.json'), null);
  await rejectsWithStatus(versions.read(id, 'v0042', 'project.json'), 404);
});

test('concurrent snapshots and restores are serialized', async () => {
  await baseline();
  const results = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      await write(`components/c${i}.ts`, `export const C = ${i};\n`);
      return versions.snapshot(id, { label: `c${i}`, source: 'manual' });
    }),
  );
  const created = results.filter(Boolean).map((v) => v!.id);
  assert.equal(new Set(created).size, created.length);
  const list = await versions.list(id);
  assert.deepEqual(
    list.map((v) => v.id),
    Array.from({ length: list.length }, (_, i) => `v${String(list.length - i).padStart(4, '0')}`),
  );
  const [restore, snapshot] = await Promise.all([
    versions.restore(id, 'v0001'),
    versions.snapshot(id, { label: 'pendant', source: 'manual' }),
  ]);
  assert.equal(restore.source, 'restore');
  assert.equal(snapshot, null, 'runs after the restore, which already recorded the state');
});

test('an edit racing a restore is never lost', async () => {
  await baseline();
  await write('scenes/titre.tsx', 'export default () => "v2";\n');
  await versions.snapshot(id, { label: 'v2', source: 'manual' });
  await Promise.all([versions.restore(id, 'v0001'), store.updateScene(id, 'titre', { name: 'Renommée' })]);
  const current = (await store.get(id)).scenes[0].name;
  const recorded = await Promise.all((await versions.list(id)).map((v) => versions.read(id, v.id, 'project.json')));
  assert.ok(current === 'Renommée' || recorded.some((json) => json!.includes('"Renommée"')));
});

test('an unreadable index is an error, never an empty history', async () => {
  await baseline();
  await fs.writeFile(path.join(dir, '.cadence', 'versions', 'index.json'), '{ broken');
  await rejectsWithStatus(versions.snapshot(id, { label: 'x', source: 'manual' }), 500, /illisible/);
  assert.equal(await fs.readFile(path.join(dir, '.cadence', 'versions', 'index.json'), 'utf8'), '{ broken');
});
