import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileVersionStore } from '../../server/store/versions';
import { sha256 } from '../../server/util';
import { makeRoot, nextEvent, rejectsWithStatus, writeCompleteBrand, type TestRoot } from './helpers';

let t: TestRoot;
let store: FileProjectStore;
let versions: FileVersionStore;
let dir: string;
const id = 'film';

beforeEach(async () => {
  t = await makeRoot();
  store = new FileProjectStore(t.config);
  versions = new FileVersionStore(store, new FileBrandStore(t.config));
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
  // Versions of project.json as an agent may leave it: unreadable, a voice-over the store refuses today, no `at`, no text.
  await write('scenes/deux.tsx', 'export default () => null; // v1\n');
  await write('project.json', '{ broken');
  await versions.snapshot(id, { label: 'Illisible', source: 'manual' });
  await withVoiceOver({ text: 'x'.repeat(2500), at: 0 });
  await versions.snapshot(id, { label: 'Trop long', source: 'manual' });
  await withVoiceOver({ text: 'Sans départ.' });
  await versions.snapshot(id, { label: 'Sans départ', source: 'manual' });
  await withVoiceOver({ at: 1 });
  await versions.snapshot(id, { label: 'Sans texte', source: 'manual' });
  await write('project.json', valid);
  await write('scenes/deux.tsx', 'export default () => null; // v2\n');

  await versions.restore(id, 'v0001', { sceneId: 'deux' });
  assert.equal(await read('scenes/deux.tsx'), 'export default () => null; // v1\n');
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Bonjour.', at: 0.5 });
  await versions.restore(id, 'v0002', { sceneId: 'deux' });
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Bonjour.', at: 0.5 });
  await versions.restore(id, 'v0003', { sceneId: 'deux' });
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Sans départ.', at: 0 });
  await versions.restore(id, 'v0004', { sceneId: 'deux' });
  assert.deepEqual((await store.get(id)).scenes.find((s) => s.id === 'deux')!.voiceOver, { text: 'Sans départ.', at: 0 });
});

test("a scene restore keeps the current voice-over when the version's lines name a speaker the project no longer has", async () => {
  const piper = { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-tom-medium' };
  await store.update(id, { voiceOver: { ...piper, speakers: [leo] } });
  await store.updateScene(id, 'deux', { voiceOver: { at: 0, lines: [{ speaker: 'leo', text: 'Salut !' }] } });
  await baseline();
  await write('scenes/deux.tsx', 'export default () => "deux v2";\n');
  await store.updateScene(id, 'deux', { duration: 5, voiceOver: { text: 'Texte.', at: 0 } });
  await store.update(id, { voiceOver: piper });

  const restored = await versions.restore(id, 'v0001', { sceneId: 'deux' });
  assert.equal(restored.source, 'restore');
  assert.equal(await read('scenes/deux.tsx'), 'export default () => "deux v1";\n');
  const scene = (await store.get(id)).scenes.find((s) => s.id === 'deux')!;
  assert.equal(scene.duration, 2);
  assert.deepEqual(scene.voiceOver, { text: 'Texte.', at: 0 });
});

test("a scene restore brings back the version's lines when their speakers are still in the project", async () => {
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-tom-medium' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [leo] } });
  const lines = [{ id: 'salut', speaker: 'leo', text: 'Salut !', gesture: 'wave' }];
  await store.updateScene(id, 'deux', { voiceOver: { lines, at: 0 } });
  await baseline();
  await store.updateScene(id, 'deux', { voiceOver: { text: 'Texte.', at: 0 } });

  const restored = await versions.restore(id, 'v0001', { sceneId: 'deux' });
  assert.ok(restored.scenes.includes('deux'));
  const scene = (await store.get(id)).scenes.find((s) => s.id === 'deux')!;
  assert.deepEqual(scene.voiceOver, { text: 'Salut !', at: 0, lines });
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

test('a restore writes only tracked paths, whatever an imported manifest lists', async () => {
  await baseline();
  const object = 'export const X = 1;\n';
  await write(`.cadence/versions/objects/${sha256(object)}`, object);
  const manifestFile = path.join(dir, '.cadence', 'versions', 'manifests', 'v0001.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, string>;
  const untracked = [
    'package.json',
    'tsconfig.json',
    'renders/a.mp4',
    '.cadence/publications.json',
    'node_modules/x/y.css',
    'components/node_modules/x/y.css',
    'components/Package.json',
    'scenes/.hidden.tsx',
    'scenes/../package.json',
    'scenes/../../outside.ts',
  ];
  for (const rel of [...untracked, 'components/kept.ts']) manifest[rel] = sha256(object);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));

  await versions.restore(id, 'v0001');

  for (const rel of untracked)
    assert.equal(
      await fs.access(path.join(dir, rel)).then(
        () => true,
        () => false,
      ),
      false,
      rel,
    );
  assert.equal(await read('components/kept.ts'), object);
});

test('a version whose brand is not installed here is refused by name, the project and its history left as they were', async () => {
  await baseline();
  await writeCompleteBrand(t.root, 'orbit');
  await store.update(id, { brand: 'orbit' });
  const withOrbit = (await versions.snapshot(id, { label: 'Orbit', source: 'manual' }))!;
  await store.update(id, { brand: null });
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });
  const before = await read('project.json');
  const history = await versions.list(id);

  await rejectsWithStatus(versions.restore(id, withOrbit.id), 400, /Marque inconnue : orbit/);
  assert.equal(await read('project.json'), before);
  assert.deepEqual(await versions.list(id), history);

  await writeCompleteBrand(t.root, 'orbit');
  await versions.restore(id, withOrbit.id);
  assert.equal((await store.get(id)).brand, 'orbit');
});

test('a version id of an imported index that is not v0001-like is never read as a file name', async () => {
  await baseline();
  const indexFile = path.join(dir, '.cadence', 'versions', 'index.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as { id: string }[];
  await write('.cadence/versions/evil.json', '{}');
  await fs.writeFile(indexFile, JSON.stringify([...index, { ...index[0], id: '../evil' }]));
  await rejectsWithStatus(versions.restore(id, '../evil'), 500, /evil/);
  await rejectsWithStatus(versions.snapshot(id, { label: 'x', source: 'manual' }), 500, /evil/);
});

test('an unreadable index is an error, never an empty history', async () => {
  await baseline();
  await fs.writeFile(path.join(dir, '.cadence', 'versions', 'index.json'), '{ broken');
  await rejectsWithStatus(versions.snapshot(id, { label: 'x', source: 'manual' }), 500, /illisible/);
  assert.equal(await fs.readFile(path.join(dir, '.cadence', 'versions', 'index.json'), 'utf8'), '{ broken');
});

test('a snapshot never follows an art-direction.md an agent swapped for a symlink', async () => {
  const secret = path.join(t.root, '.cadence', 'accounts.json');
  await fs.mkdir(path.dirname(secret), { recursive: true });
  await fs.writeFile(secret, 'TOPSECRET');
  await fs.rm(path.join(dir, 'art-direction.md'));
  await fs.symlink(secret, path.join(dir, 'art-direction.md'));
  await baseline();
  const objects = path.join(dir, '.cadence', 'versions', 'objects');
  for (const name of await fs.readdir(objects))
    assert.ok(!(await fs.readFile(path.join(objects, name), 'utf8')).includes('TOPSECRET'), name);
});

test('a snapshot never lists a components folder an agent swapped for a symlink', async () => {
  const state = path.join(t.root, '.cadence');
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'accounts.json'), 'TOPSECRET');
  await fs.rm(path.join(dir, 'components'), { recursive: true, force: true });
  await fs.symlink(state, path.join(dir, 'components'));
  const v1 = await baseline();
  assert.ok(v1);
  assert.ok(!v1.files.some((file) => file.startsWith('components/')), v1.files.join(', '));
  const objects = path.join(dir, '.cadence', 'versions', 'objects');
  for (const name of await fs.readdir(objects))
    assert.ok(!(await fs.readFile(path.join(objects, name), 'utf8')).includes('TOPSECRET'), name);
});

test('a snapshot never versions a file reached through a components folder swapped for a symlink after the listing', async (ctx) => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'x.ts'), 'TOPSECRET');
  await write('components/a/x.ts', 'export const X = 1;\n');
  // The race an agent turn can win: components/a is listed as a folder, then becomes a link out before the read.
  const readdir = fs.readdir;
  ctx.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await readdir(...args);
    if (args[0] === path.join(dir, 'components')) {
      await fs.rm(path.join(dir, 'components', 'a'), { recursive: true });
      await fs.symlink(outside, path.join(dir, 'components', 'a'));
    }
    return entries;
  });
  await assert.rejects(baseline(), /ELOOP|ENOTDIR|outside/);
  const objects = path.join(dir, '.cadence', 'versions', 'objects');
  for (const name of await fs.readdir(objects).catch(() => []))
    assert.ok(!(await fs.readFile(path.join(objects, name), 'utf8')).includes('TOPSECRET'), name);
});

test('a restore never writes through a folder an agent swapped for a link out of the project', async () => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await write('components/sub/x.ts', 'export const X = 1;\n');
  const v1 = await baseline();
  assert.ok(v1);
  await write('art-direction.md', 'changed\n');
  await fs.rm(path.join(dir, 'components', 'sub'), { recursive: true });
  await fs.symlink(outside, path.join(dir, 'components', 'sub'));
  await rejectsWithStatus(versions.restore(id, v1.id), 409, /components\/sub\/x\.ts.*lien symbolique/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await read('art-direction.md'), 'changed\n', 'nothing restored before the refusal');
});

test('a scene restore never writes through a scenes folder an agent swapped for a link out of the project', async () => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const v1 = await baseline();
  assert.ok(v1);
  await fs.rename(path.join(dir, 'scenes'), path.join(t.root, 'held'));
  await fs.symlink(outside, path.join(dir, 'scenes'));
  await rejectsWithStatus(versions.restore(id, v1.id, { sceneId: 'deux' }), 409, /lien symbolique/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a whole restore brings back a components subfolder deleted since that version', async () => {
  await write('components/sub/deep/x.ts', 'export const X = 1;\n');
  const v1 = await baseline();
  assert.ok(v1);
  await fs.rm(path.join(dir, 'components', 'sub'), { recursive: true });
  await versions.restore(id, v1.id);
  assert.equal(await read('components/sub/deep/x.ts'), 'export const X = 1;\n');
});

test('a refused restore adds no version to the history', async () => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await write('components/sub/x.ts', 'export const X = 1;\n');
  const v1 = await baseline();
  assert.ok(v1);
  await write('art-direction.md', 'changed\n');
  await fs.rm(path.join(dir, 'components', 'sub'), { recursive: true });
  await fs.symlink(outside, path.join(dir, 'components', 'sub'));
  await rejectsWithStatus(versions.restore(id, v1.id), 409, /lien symbolique/);
  await fs.rename(path.join(dir, 'scenes'), path.join(t.root, 'held'));
  await fs.symlink(outside, path.join(dir, 'scenes'));
  await rejectsWithStatus(versions.restore(id, v1.id, { sceneId: 'deux' }), 409, /lien symbolique/);
  assert.deepEqual(
    (await versions.list(id)).map((v) => v.id),
    [v1.id],
  );
});

test('a whole restore whose removal goes through a subfolder swapped for a link deletes nothing outside', async (ctx) => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'extra.ts'), 'TOPSECRET');
  const v1 = await baseline();
  assert.ok(v1);
  await write('components/sub/extra.ts', 'export const EXTRA = 1;\n');
  // components/sub becomes a link out once the restore has checked it, before the removal.
  const sub = path.join(dir, 'components', 'sub');
  const lstat = fs.lstat;
  let swapped = false;
  ctx.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const found = await lstat(...args);
    if (!swapped && args[0] === sub) {
      swapped = true;
      await fs.rename(sub, path.join(t.root, 'held'));
      await fs.symlink(outside, sub);
    }
    return found;
  });
  await assert.rejects(versions.restore(id, v1.id), /ELOOP|ENOTDIR|outside/);
  assert.ok(swapped, 'the folder became a link after its check');
  assert.equal(await fs.readFile(path.join(outside, 'extra.ts'), 'utf8'), 'TOPSECRET');
});

/** `folder` becomes a link to `outside` once the restore has checked it, before any write. */
function swapAfterCheck(ctx: TestContext, folder: string, outside: string) {
  const lstat = fs.lstat;
  const state = { swapped: false };
  ctx.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const found = await lstat(...args);
    if (!state.swapped && args[0] === folder) {
      state.swapped = true;
      await fs.rename(folder, path.join(t.root, 'held'));
      await fs.symlink(outside, folder);
    }
    return found;
  });
  return state;
}

test('a whole restore whose write goes through a subfolder swapped for a link after its check writes nothing outside', async (ctx) => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await write('components/sub/x.ts', 'export const X = 1;\n');
  const v1 = await baseline();
  assert.ok(v1);
  await write('components/sub/x.ts', 'export const X = 2;\n');
  const state = swapAfterCheck(ctx, path.join(dir, 'components', 'sub'), outside);
  await assert.rejects(versions.restore(id, v1.id), /ELOOP|ENOTDIR|outside/);
  assert.ok(state.swapped, 'the folder became a link after its check');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a scene restore whose scenes folder becomes a link after its check writes nothing outside', async (ctx) => {
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const v1 = await baseline();
  assert.ok(v1);
  await write('scenes/deux.tsx', 'export default () => "deux v2";\n');
  const state = swapAfterCheck(ctx, path.join(dir, 'scenes'), outside);
  await assert.rejects(versions.restore(id, v1.id, { sceneId: 'deux' }), /ELOOP|ENOTDIR|outside/);
  assert.ok(state.swapped, 'the folder became a link after its check');
  assert.deepEqual(await fs.readdir(outside), []);
});
