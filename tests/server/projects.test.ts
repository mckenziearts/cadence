import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import { shortHash } from '../../server/util';
import { makeRoot, nextEvent, rejectsWithStatus, SCENE_TEMPLATE_CODE, type TestRoot } from './helpers';

let t: TestRoot;
let store: FileProjectStore;

beforeEach(async () => {
  t = await makeRoot();
  store = new FileProjectStore(t.config, { templates: new FileTemplateStore(t.config), brands: new FileBrandStore(t.config) });
});

afterEach(async () => {
  store.close();
  await t.cleanup();
});

const base = { brand: null, formats: ['16:9' as const], fps: 60 };

describe('create', () => {
  test('without template: one branded title scene, folders and art direction from the brand', async () => {
    const p = await store.create({ ...base, name: 'Lancement Été 2026' });
    assert.equal(p.id, 'lancement-ete-2026');
    assert.equal(p.dir, path.join(t.config.projectsDir, 'lancement-ete-2026'));
    assert.equal(p.tempo, 120);
    assert.equal(p.scenes.length, 1);
    const [scene] = p.scenes;
    assert.equal(scene.id, 'titre');
    assert.equal(scene.duration, 4);
    assert.equal(scene.start, 0);
    assert.equal(scene.url, `/@fs${scene.file}`);
    const code = await fs.readFile(scene.file, 'utf8');
    assert.equal(scene.codeVersion, shortHash(code));
    for (const part of ['useBrand()', 'useFormat()', '"Lancement Été 2026"', "from 'cadence'"])
      assert.ok(code.includes(part), part);
    assert.doesNotMatch(code, /useState|useEffect|Date\.now|Math\.random/);
    assert.ok((await fs.stat(path.join(p.dir, 'components'))).isDirectory());
    assert.ok((await fs.stat(path.join(p.dir, 'assets', 'refs'))).isDirectory());
    assert.match(await store.readArtDirection(p.id), /Direction Cadence/);
    const file = JSON.parse(await fs.readFile(path.join(p.dir, 'project.json'), 'utf8'));
    assert.equal(file.version, 1);
    assert.deepEqual(file.formats, ['16:9']);
    assert.equal(p.codeGeneration, 0);
    assert.equal(p.musicUrl, null);
    assert.equal(p.musicGrid, null);
  });

  test('from a campaign template: scenes in order, durations from bars at the template tempo', async () => {
    const p = await store.create({ ...base, name: 'Teaser', formats: ['9:16', '16:9'], fps: 30, template: 'launch' });
    assert.equal(p.tempo, 100);
    assert.deepEqual(
      p.scenes.map((s) => [s.id, s.duration, s.start, s.template]),
      [
        ['logo', 9.6, 0, 'logo-reveal'],
        ['fonctionnalite', 4.8, 9.6, 'feature-card'],
        ['fonctionnalite-2', 4.8, 14.4, 'feature-card'],
      ],
    );
    assert.equal(p.duration, 19.2);
    assert.equal(await fs.readFile(p.scenes[0].file, 'utf8'), SCENE_TEMPLATE_CODE);
    const art = await store.readArtDirection(p.id);
    assert.match(art, /^# Direction Cadence[\s\S]*## Campagne/, "the brand's art direction, then the campaign's");
  });

  test('validation and conflicts', async () => {
    await rejectsWithStatus(store.create({ ...base, name: 'X', brand: 'inconnue' }), 400, /Marque inconnue/);
    await rejectsWithStatus(store.create({ ...base, name: 'X', formats: [] }), 400);
    await rejectsWithStatus(store.create({ ...base, name: 'X', formats: ['3:2' as never] }), 400, /Format inconnu/);
    await rejectsWithStatus(store.create({ ...base, name: 'X', fps: 25 }), 400, /24, 30 ou 60/);
    await rejectsWithStatus(store.create({ ...base, name: '   ' }), 400, /obligatoire/);
    await rejectsWithStatus(store.create({ ...base, name: 'X', template: 'nope' }), 404);
    assert.deepEqual(await fs.readdir(t.config.projectsDir), [], 'a failed create leaves nothing behind');
    await store.create({ ...base, name: 'Démo', id: 'demo' });
    await rejectsWithStatus(store.create({ ...base, name: 'Autre', id: 'demo' }), 409);
    const second = await store.create({ ...base, name: 'Démo' });
    assert.equal(second.id, 'demo-2');
  });
});

test('generic art direction when the brand has none', async () => {
  const p = await store.create({ ...base, name: 'W', brand: 'orbit' });
  assert.match(await store.readArtDirection(p.id), /^# Direction artistique/);
});

describe('project.json validation', () => {
  test('normalizes durations, tempo and formats; rejects bad ids', async () => {
    const dir = path.join(t.config.projectsDir, 'brut');
    await fs.mkdir(path.join(dir, 'scenes'), { recursive: true });
    const raw = {
      name: 'Brut',
      brand: null,
      fps: 30,
      formats: [],
      scenes: [
        { id: 'a', name: 'A', duration: 1.23456 },
        { id: 'b', duration: 0.01 },
      ],
    };
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(raw));
    const p = await store.get('brut');
    assert.deepEqual(
      p.scenes.map((s) => [s.id, s.name, s.duration, s.codeVersion]),
      [
        ['a', 'A', 1.235, 'missing'],
        ['b', 'b', 0.1, 'missing'],
      ],
    );
    assert.equal(p.tempo, 120);
    assert.deepEqual(p.formats, ['16:9']);
    assert.ok(p.createdAt && p.updatedAt);

    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...raw, scenes: [{ id: '../x', duration: 1 }] }));
    await rejectsWithStatus(store.get('brut'), 500, /project\.json invalide/);
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...raw, fps: 25 }));
    await rejectsWithStatus(store.get('brut'), 500);
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...raw, formats: ['2:1'] }));
    await rejectsWithStatus(store.get('brut'), 500);
    assert.deepEqual(await store.list(), [], 'invalid projects are skipped by list()');
    await rejectsWithStatus(store.get('absent'), 404);
    await rejectsWithStatus(store.get('../etc'), 400);
  });
});

describe('scenes', () => {
  test('create (after, template, code, blank), update, duplicate, reorder, durations, delete', async () => {
    const p = await store.create({ ...base, name: 'Scènes' });
    const id = p.id;
    const fromTemplate = await store.createScene(id, { name: 'Logo animé', template: 'logo-reveal' });
    assert.equal(fromTemplate.id, 'logo-anime');
    assert.equal(fromTemplate.duration, 8, '4 bars at 120 BPM');
    assert.equal(fromTemplate.template, 'logo-reveal');
    const first = await store.createScene(id, {
      name: 'Ouverture',
      after: null,
      code: 'export default () => null;\n',
      duration: 1.23449,
    });
    assert.equal(first.index, 2);
    assert.equal(first.duration, 1.234);
    const inserted = await store.createScene(id, { name: 'Milieu', after: 'titre' });
    assert.equal(inserted.index, 1);
    assert.equal(inserted.duration, 3);
    assert.match(await fs.readFile(inserted.file, 'utf8'), /"Milieu"/);
    await rejectsWithStatus(store.createScene(id, { name: 'X', after: 'absente' }), 404);

    // A stray file in scenes/ is never overwritten.
    await fs.writeFile(path.join(p.dir, 'scenes', 'orpheline.tsx'), 'keep me');
    const next = await store.createScene(id, { name: 'Orpheline' });
    assert.equal(next.id, 'orpheline-2');
    assert.equal(await fs.readFile(path.join(p.dir, 'scenes', 'orpheline.tsx'), 'utf8'), 'keep me');

    let state = await store.updateScene(id, 'milieu', { name: 'Centre', duration: 2.5 });
    assert.deepEqual(
      state.scenes.map((s) => s.id),
      ['titre', 'milieu', 'logo-anime', 'ouverture', 'orpheline-2'],
    );
    assert.equal(state.scenes[1].name, 'Centre');
    assert.equal(state.scenes[2].start, 6.5);
    await rejectsWithStatus(store.updateScene(id, 'milieu', { duration: -1 }), 400);
    await rejectsWithStatus(store.updateScene(id, 'nope', { name: 'x' }), 404);

    const copy = await store.duplicateScene(id, 'milieu');
    assert.equal(copy.id, 'centre-copie');
    assert.equal(copy.index, 2);
    assert.equal(await fs.readFile(copy.file, 'utf8'), await fs.readFile(store.sceneFile(id, 'milieu'), 'utf8'));

    state = await store.reorderScenes(id, ['ouverture', 'titre', 'milieu', 'centre-copie', 'logo-anime', 'orpheline-2']);
    assert.equal(state.scenes[0].id, 'ouverture');
    await rejectsWithStatus(store.reorderScenes(id, ['titre']), 400);
    await rejectsWithStatus(
      store.reorderScenes(id, ['ouverture', 'titre', 'titre', 'centre-copie', 'logo-anime', 'orpheline-2']),
      400,
    );

    state = await store.setDurations(id, { titre: 1, ouverture: 0.05 });
    assert.equal(state.scenes.find((s) => s.id === 'ouverture')!.duration, 0.1);
    await rejectsWithStatus(store.setDurations(id, { nope: 1 }), 404);

    state = await store.deleteScene(id, 'milieu');
    assert.ok(!state.scenes.some((s) => s.id === 'milieu'));
    const trash = await fs.readdir(path.join(p.dir, '.cadence', 'trash'));
    assert.equal(trash.length, 1);
    assert.match(trash[0], /^milieu-\d+\.tsx$/);
  });

  test('a project keeps at least one scene', async () => {
    const p = await store.create({ ...base, name: 'Seul' });
    await rejectsWithStatus(store.deleteScene(p.id, 'titre'), 400);
  });

  test("a new scene never takes a deleted scene's id: its chat and its history stay with the old one", async () => {
    const p = await store.create({ ...base, name: 'Reprise' });
    await store.createScene(p.id, { name: 'Intro' });
    await store.deleteScene(p.id, 'intro');
    assert.equal((await store.createScene(p.id, { name: 'Intro' })).id, 'intro-2', 'the trashed file keeps the id');
    const chats = path.join(p.dir, '.cadence', 'chats');
    await fs.mkdir(path.join(chats, 'archive'), { recursive: true });
    await fs.writeFile(path.join(chats, 'scene-outro.json'), '{}');
    await fs.writeFile(path.join(chats, 'archive', 'scene-fin-2026-09-30T00-00-00-000Z.json'), '{}');
    assert.equal((await store.createScene(p.id, { name: 'Outro' })).id, 'outro-2', 'so does its chat');
    assert.equal((await store.createScene(p.id, { name: 'Fin' })).id, 'fin', 'an archived chat does not');
  });
});

test('update, art direction, remove to .trash', async () => {
  const p = await store.create({ ...base, name: 'Maj' });
  const listChanged = nextEvent(store.events, 'list-changed', 1000);
  const updated = await store.update(p.id, { name: 'Mise à jour', formats: ['1:1', '1:1', '4:5'], fps: 24, tempo: 128 });
  await listChanged;
  assert.equal(updated.name, 'Mise à jour');
  assert.deepEqual(updated.formats, ['1:1', '4:5']);
  assert.equal(updated.tempo, 128);
  await rejectsWithStatus(store.update(p.id, { tempo: 10 }), 400);
  await rejectsWithStatus(store.update(p.id, { brand: 'inconnue' }), 400);
  await rejectsWithStatus(store.update(p.id, { captions: 'yes' as never }), 400, /Sous-titres invalides/);

  await store.writeArtDirection(p.id, '# Nouveau\n');
  assert.equal(await store.readArtDirection(p.id), '# Nouveau\n');

  await store.remove(p.id);
  assert.equal(await store.exists(p.id), false);
  const trashed = await fs.readdir(path.join(t.config.projectsDir, '.trash'));
  assert.match(trashed[0], /^maj-\d+$/);
  assert.deepEqual(await store.list(), []);
  await rejectsWithStatus(store.remove(p.id), 404);
});

test('music settings are validated and exposed with a stream URL and the provider grid', async () => {
  const p = await store.create({ ...base, name: 'Son' });
  await rejectsWithStatus(store.setMusic(p.id, { file: '../x.mp3', start: 0, volume: 1 }), 400);
  await rejectsWithStatus(store.setMusic(p.id, { file: 'music/a.mp3', start: 0, volume: 3 }), 400);
  let nested: unknown = 'unset';
  store.setMusicGridProvider(async (id) => {
    // The music service reads the project through get(): it must not recurse forever.
    nested = (await store.get(id)).musicGrid;
    return {
      bpm: 128,
      beatsPerBar: 4,
      beats: [0],
      downbeats: [0],
      phrases: [0],
      sections: [],
      accents: [],
      waveform: [],
      duration: 10,
      confidence: 1,
    };
  });
  const state = await store.setMusic(p.id, { file: 'music/a b.mp3', start: 1.23456, volume: 0.5 });
  assert.equal(state.music!.start, 1.235);
  assert.equal(state.musicUrl, `/api/projects/son/music/audio?file=${encodeURIComponent('music/a b.mp3')}`);
  assert.equal(state.musicGrid!.bpm, 128);
  assert.equal(nested, null);
  assert.equal((await store.setMusic(p.id, null)).musicUrl, null);
});

test('withLock is re-entrant, so store methods can run inside a critical section', async () => {
  const p = await store.create({ ...base, name: 'Verrou' });
  const state = await store.withLock(p.id, () => store.updateScene(p.id, 'titre', { duration: 2 }));
  assert.equal(state.scenes[0].duration, 2);
});

describe('code generations', () => {
  test('syncCode bumps the generation once per real change and invalidates project + brand dirs', async () => {
    const invalidated: string[][] = [];
    store.setModuleInvalidator((dirs) => invalidated.push(dirs));
    const p = await store.create({ ...base, name: 'Code' });
    assert.equal(await store.syncCode(p.id), false, 'nothing changed since the state was handed out');

    const event = nextEvent(store.events, 'code-changed', 1000);
    await fs.writeFile(store.sceneFile(p.id, 'titre'), 'export default () => null;\n');
    assert.equal(await store.syncCode(p.id), true);
    assert.deepEqual(await event, [p.id, 1]);
    assert.deepEqual(invalidated, [[p.dir, path.join(t.config.brandsDir, 'cadence')]]);
    assert.equal(store.generation(p.id), 1);
    assert.equal((await store.get(p.id)).codeGeneration, 1);

    // Same bytes rewritten: no reload.
    await fs.writeFile(store.sceneFile(p.id, 'titre'), 'export default () => null;\n');
    assert.equal(await store.syncCode(p.id), false);
    // Scratch files do not count.
    await fs.writeFile(path.join(p.dir, 'scenes', 'x.tsx.123.tmp'), 'tmp');
    assert.equal(await store.syncCode(p.id), false);

    await fs.writeFile(path.join(t.config.brandsDir, 'cadence', 'theme.css'), ':root{}');
    assert.equal(await store.syncCode(p.id), true);
    await fs.mkdir(path.join(p.dir, 'components'), { recursive: true });
    await fs.writeFile(path.join(p.dir, 'components', 'tokens.ts'), 'export const X = 1;');
    assert.equal(await store.syncCode(p.id), true);
    assert.equal(store.generation(p.id), 3);

    const updated = await store.update(p.id, { brand: 'orbit' });
    assert.equal(updated.codeGeneration, 4, 'a new brand means new kit modules');
  });

  test("watch() turns a watcher's file events into project events", async () => {
    const p = await store.create({ ...base, name: 'Surveillé' });
    await store.get(p.id);
    // In the app, Vite's watcher: here each file is written, then reported the way chokidar does.
    const files = new EventEmitter();
    store.watch(files);
    const write = async (file: string, text: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
      files.emit('all', 'change', file);
    };

    let event = nextEvent(store.events, 'code-changed', 4000, (id) => id === p.id);
    await write(store.sceneFile(p.id, 'titre'), 'export default () => null; // v2\n');
    assert.deepEqual(await event, [p.id, 1]);

    event = nextEvent(store.events, 'changed', 4000, (id) => id === p.id);
    await write(path.join(p.dir, 'art-direction.md'), '# Changé\n');
    await event;

    event = nextEvent(store.events, 'assets-changed', 4000, (id) => id === p.id);
    await write(path.join(p.dir, 'assets', 'logo.svg'), '<svg/>');
    await event;

    event = nextEvent(store.events, 'code-changed', 4000, (id) => id === p.id);
    await write(path.join(t.config.brandsDir, 'cadence', 'KIT.md'), 'Nouvelles notes');
    assert.deepEqual(await event, [p.id, 2]);

    event = nextEvent(store.events, 'list-changed', 4000);
    await fs.mkdir(path.join(t.config.projectsDir, 'nouveau'));
    files.emit('all', 'addDir', path.join(t.config.projectsDir, 'nouveau'));
    await event;

    store.close();
    assert.equal(files.listenerCount('all'), 0, 'close() stops listening');
  });
});
