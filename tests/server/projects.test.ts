import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore, parseSceneVoiceOver } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import {
  HttpError,
  listInside,
  readFileNoFollow,
  removeFileInside,
  removeTreeInside,
  shortHash,
  writeFileAtomic,
  writeFileInside,
} from '../../server/util';
import type { SceneVoiceOver, VoiceOverSettings } from '../../src/shared/types';
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

test('a write that changes nothing leaves project.json as it was, updatedAt included', async (ctx) => {
  const p = await store.create({ ...base, name: 'Pareil' });
  const file = path.join(store.dir(p.id), 'project.json');
  const written = await fs.readFile(file, 'utf8');
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
  await store.update(p.id, { name: p.name, tempo: p.tempo });
  await store.updateScene(p.id, p.scenes[0].id, { duration: p.scenes[0].duration });
  await store.reorderScenes(
    p.id,
    p.scenes.map((s) => s.id),
  );
  assert.equal(await fs.readFile(file, 'utf8'), written);
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

describe('speakers and script lines', () => {
  const piper = { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 };
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium', color: '#ff2e88' };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-tom-medium' };
  const refused = (e: unknown) => e instanceof HttpError && e.status === 400;
  const fileOf = async (dir: string) => JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));

  test('speakers are written with the voice settings, and an empty list writes no key', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    const settings = { ...piper, speakers: [camille, leo] };
    assert.deepEqual((await store.update(p.id, { voiceOver: settings })).voiceOver, settings);
    assert.deepEqual((await fileOf(p.dir)).voiceOver, settings);
    await store.update(p.id, { voiceOver: { ...piper, speakers: [] } });
    assert.deepEqual((await fileOf(p.dir)).voiceOver, piper);
  });

  test('script lines: their speakers exist, the text is derived from them, a scene without lines writes none', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [camille, leo] } });
    const lines = [
      { id: 'salut-leo', speaker: 'camille', text: ' Salut Léo. ', gesture: 'wave' },
      { id: 'salut', speaker: 'leo', text: 'Salut !' },
    ];
    // Lines carry the text: a stale `text` next to them (a version written with lines) is replaced.
    const said = await store.updateScene(p.id, 'titre', { voiceOver: { text: 'Une ancienne version.', at: 0.5, lines } });
    const expected = {
      text: 'Salut Léo.\nSalut !',
      at: 0.5,
      lines: [{ id: 'salut-leo', speaker: 'camille', text: 'Salut Léo.', gesture: 'wave' }, lines[1]],
    };
    assert.deepEqual(said.scenes[0].voiceOver, expected);
    assert.deepEqual((await fileOf(p.dir)).scenes[0].voiceOver, expected);
    assert.deepEqual(parseSceneVoiceOver((await fileOf(p.dir)).scenes[0].voiceOver), expected, 'a written voice-over reads back');

    const scene = (voiceOver: unknown) => store.updateScene(p.id, 'titre', { voiceOver: voiceOver as SceneVoiceOver });
    const line = (text: string, extra: object = {}) => ({ speaker: 'leo', text, ...extra });
    await assert.rejects(scene({ at: 0, lines: [{ speaker: 'nina', text: 'Bonjour.' }] }), /nina/);
    await assert.rejects(scene({ at: 0, lines: [line('Oui.'), { speaker: 'nina', text: 'Non.' }] }), /nina/, 'a later line');
    await assert.rejects(scene({ at: 0, lines: [line('  ')] }), refused, 'a blank line');
    await assert.rejects(scene({ at: 0, lines: [] }), refused, 'no line');
    await assert.rejects(scene({ at: 0 }), refused, 'neither text nor lines');
    await assert.rejects(scene({ at: 0, lines: [line('Oui.', { gesture: 'x'.repeat(65) })] }), refused, 'a long gesture');
    await assert.rejects(scene({ at: 0, lines: [line('a'.repeat(1000)), line('b'.repeat(1000))] }), refused, '2001 joined');
    await scene({ at: 0, lines: [line('a'.repeat(1000)), line('b'.repeat(999), { gesture: 'x'.repeat(64) })] });
    assert.equal((await fileOf(p.dir)).scenes[0].voiceOver.text.length, 2000);

    await scene({ text: 'Bonjour.', at: 1 });
    assert.deepEqual((await fileOf(p.dir)).scenes[0].voiceOver, { text: 'Bonjour.', at: 1 }, 'no lines key');
  });

  test('a line keeps its id across its edits; one sent without an id gets one from its speaker and text, never one taken', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [leo, camille] } });
    const scene = async (lines: object[]) =>
      (await store.updateScene(p.id, 'titre', { voiceOver: { lines, at: 0 } as SceneVoiceOver })).scenes[0].voiceOver!.lines!;
    const ids = (lines: { id: string }[]) => lines.map((l) => l.id);
    const oui = { speaker: 'leo', text: 'Oui.' };
    const non = { speaker: 'leo', text: 'Non.' };
    const [one, two, three] = await scene([oui, non, oui]);
    assert.equal(new Set([one.id, two.id, three.id]).size, 3, 'two equal texts get two ids');
    assert.deepEqual((await fileOf(p.dir)).scenes[0].voiceOver.lines[0], { id: one.id, ...oui }, 'written first in project.json');
    assert.deepEqual(ids(await scene([oui, non, oui])), [one.id, two.id, three.id], 'the same lines sent again get the same ids');
    assert.deepEqual(
      parseSceneVoiceOver({ text: '', at: 0, lines: [oui] })?.lines,
      [{ id: one.id, ...oui }],
      'a hand-written line without an id reads with the same one every time',
    );

    const edited = await scene([two, { ...one, text: 'Oui, bien sûr.' }]);
    assert.deepEqual(ids(edited), [two.id, one.id], 'a line keeps its id when its text changes and when it moves');
    // The new line's text gives the id the edited line still holds.
    const added = await scene([...edited, oui]);
    assert.deepEqual(ids(added).slice(0, 2), [two.id, one.id]);
    assert.equal(new Set(ids(added)).size, 3);
    const before = await scene([oui, ...edited]);
    assert.deepEqual(ids(before).slice(1), [two.id, one.id], 'nor does a new line before it');
    assert.equal(new Set(ids(before)).size, 3);

    const bonjour = (speaker: string) => ({ speaker, text: 'Bonjour.' });
    const [byLeo, byCamille] = await scene([bonjour('leo'), bonjour('camille')]);
    assert.deepEqual(
      ids(await scene([bonjour('camille'), bonjour('leo')])),
      [byCamille.id, byLeo.id],
      'the same text said by two speakers: each line keeps its id when the agent swaps them',
    );
    const twice = await scene([
      { ...oui, id: 'x' },
      { ...non, id: 'x' },
    ]);
    assert.equal(twice[0].id, 'x', 'the first line keeps an id sent twice');
    assert.notEqual(twice[1].id, 'x');
    assert.deepEqual(ids(await scene([{ ...oui, id: 'Pas un id' }])), [one.id], 'an id that is not one counts as none');
  });

  test('a hand-written project.json reads with an id on each line, also when the one it holds is not an id', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [leo] } });
    const oui = { speaker: 'leo', text: 'Oui.' };
    const saved = await store.updateScene(p.id, 'titre', { voiceOver: { lines: [oui], at: 0 } });
    const said = saved.scenes[0].voiceOver!.lines!;
    const raw = await fileOf(p.dir);
    for (const line of [oui, { ...oui, id: 'Pas un id' }, { ...oui, id: 'x'.repeat(65) }, { ...oui, id: 7 }]) {
      const scene = { ...raw.scenes[0], voiceOver: { ...raw.scenes[0].voiceOver, lines: [line] } };
      await fs.writeFile(path.join(p.dir, 'project.json'), JSON.stringify({ ...raw, scenes: [scene] }));
      assert.deepEqual((await store.get(p.id)).scenes[0].voiceOver?.lines, said, JSON.stringify(line));
    }
  });

  test('a speaker that lines still use cannot be removed, nor its voice moved to another engine', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [camille, leo] } });
    await store.updateScene(p.id, 'titre', { voiceOver: { at: 0, lines: [{ speaker: 'leo', text: 'Salut !' }] } });
    const settings = (voiceOver: unknown) => store.update(p.id, { voiceOver: voiceOver as VoiceOverSettings });

    await assert.rejects(
      settings({ ...piper, speakers: [camille] }),
      (e: HttpError) => refused(e) && /leo/.test(e.message) && /Titre/.test(e.message),
    );
    await assert.rejects(settings(null), /Titre/, 'back to the default voice drops every speaker');
    await assert.rejects(settings(piper), /Titre/);
    assert.deepEqual((await fileOf(p.dir)).voiceOver.speakers, [camille, leo], 'nothing written');

    const eleven = { engine: 'elevenlabs', voice: 'JBFqnCBsd6RMkjVDRZzb', model: 'eleven_v3', speed: 1, musicLevel: 0.3 };
    await assert.rejects(settings({ ...eleven, speakers: [camille, leo] }), refused, 'Piper voices under ElevenLabs');
    const remapped = [
      { ...camille, voice: 'cgSgspJ2msm6clMCkdW9' },
      { ...leo, voice: 'JBFqnCBsd6RMkjVDRZzb' },
    ];
    assert.deepEqual((await settings({ ...eleven, speakers: remapped })).voiceOver.speakers, remapped);

    await store.updateScene(p.id, 'titre', { voiceOver: { text: 'Plus de dialogue.', at: 0 } });
    assert.deepEqual((await settings({ ...eleven, speakers: remapped.slice(0, 1) })).voiceOver.speakers, remapped.slice(0, 1));

    await settings({ ...eleven, speakers: remapped });
    const later = await store.createScene(p.id, { name: 'Réponse' });
    await store.updateScene(p.id, later.id, { voiceOver: { lines: [{ speaker: 'leo', text: 'Salut !' }], at: 0 } });
    await assert.rejects(settings({ ...eleven, speakers: remapped.slice(0, 1) }), /Réponse/, 'a scene after the first');
  });

  test('a speaker already missing from a hand-edited project.json blocks no settings change, only a removal is refused', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [camille, leo] } });
    const file = await fileOf(p.dir);
    const lines = [
      { id: 'bonjour', speaker: 'nina', text: 'Bonjour.' },
      { id: 'salut', speaker: 'leo', text: 'Salut !' },
    ];
    file.scenes[0].voiceOver = { text: 'Bonjour.\nSalut !', at: 0, lines };
    await fs.writeFile(path.join(p.dir, 'project.json'), JSON.stringify(file));

    const faster = await store.update(p.id, { voiceOver: { ...piper, speed: 1.2, speakers: [camille, leo] } });
    assert.equal(faster.voiceOver?.speed, 1.2);
    await assert.rejects(
      store.update(p.id, { voiceOver: { ...piper, speakers: [camille] } }),
      (e: HttpError) => refused(e) && /"leo"/.test(e.message),
    );
    assert.deepEqual((await fileOf(p.dir)).scenes[0].voiceOver.lines, lines, 'the hand-edited lines stay as they are');
  });

  test('the start of a scene with lines is rounded to the millisecond, in the scene and in project.json', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [leo] } });
    const said = await store.updateScene(p.id, 'titre', {
      voiceOver: { lines: [{ speaker: 'leo', text: 'Salut !' }], at: 0.5004 },
    });
    assert.equal(said.scenes[0].voiceOver?.at, 0.5);
    assert.equal((await fileOf(p.dir)).scenes[0].voiceOver.at, 0.5);
  });

  test('a speaker removed while a scene gives it a line: one of the two writes is refused, under the project lock', async () => {
    const p = await store.create({ ...base, name: 'Dialogue' });
    await store.update(p.id, { voiceOver: { ...piper, speakers: [camille, leo] } });
    const [line, removal] = await Promise.allSettled([
      store.updateScene(p.id, 'titre', { voiceOver: { at: 0, lines: [{ speaker: 'leo', text: 'Salut !' }] } }),
      store.update(p.id, { voiceOver: { ...piper, speakers: [camille] } }),
    ]);
    assert.equal([line, removal].filter((r) => r.status === 'fulfilled').length, 1);
    const file = await fileOf(p.dir);
    const ids = (file.voiceOver.speakers as { id: string }[]).map((s) => s.id);
    for (const l of file.scenes[0].voiceOver?.lines ?? []) assert.ok(ids.includes(l.speaker), l.speaker);
  });

  test('a 0.8.0 project without speakers, read then saved, keeps its project.json byte for byte', async (ctx) => {
    const fixture = JSON.parse(
      await fs.readFile(path.join(import.meta.dirname, '../fixtures/projects/voice-over-0.8.0/project.json'), 'utf8'),
    );
    const dir = path.join(t.config.projectsDir, 'voix');
    await fs.mkdir(path.join(dir, 'scenes'), { recursive: true });
    for (const s of fixture.scenes) await fs.writeFile(path.join(dir, 'scenes', `${s.id}.tsx`), 'export default () => null;\n');
    // As 0.8.0 wrote it.
    const written = `${JSON.stringify(fixture, null, 2)}\n`;
    await fs.writeFile(path.join(dir, 'project.json'), written);

    ctx.mock.timers.enable({ apis: ['Date'], now: Date.parse(fixture.updatedAt) });
    const p = await store.get('voix');
    await store.update('voix', { voiceOver: p.voiceOver, captions: true });
    for (const s of p.scenes) await store.updateScene('voix', s.id, { name: s.name, voiceOver: s.voiceOver ?? null });
    // A write that changes nothing is skipped: an edit and its revert make the writer run.
    await store.updateScene('voix', 'titre', { duration: 5 });
    await store.updateScene('voix', 'titre', { duration: 4 });
    assert.equal(await fs.readFile(path.join(dir, 'project.json'), 'utf8'), written);
  });
});

describe('templates with components and voices', () => {
  const MOUTH = 'export function Mouth() {\n  return null;\n}\n';
  const VOICE_OVER = {
    voice: 'fr_FR-siwis-medium',
    speakers: [
      { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium' },
      { id: 'sami', name: 'Sami', voice: 'fr_FR-upmc-medium' },
    ],
  };
  const write = async (rel: string, content: string | object) => {
    const file = path.join(t.config.templatesDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  };

  beforeEach(async () => {
    await write('scenes/dialogue/template.json', { name: 'Dialogue', category: 'feature', bars: 2, formats: ['16:9'] });
    await write('scenes/dialogue/scene.tsx', SCENE_TEMPLATE_CODE);
    await write('scenes/dialogue/components/Mouth.tsx', MOUTH);
    await write('scenes/dialogue/components/layout.ts', 'export const LAYOUT = {};\n');
    await write('projects/duo/template.json', {
      name: 'Duo',
      fps: 30,
      formats: ['16:9'],
      bpm: 120,
      scenes: [
        { template: 'dialogue', name: 'Question', bars: 2 },
        { template: 'logo-reveal', name: 'Logo', bars: 2 },
        { template: 'dialogue', name: 'Réponse', bars: 2 },
      ],
      voiceOver: VOICE_OVER,
    });
  });

  test('create() copies the components and starts with the campaign voices, over the default voice', async () => {
    const p = await store.create({
      ...base,
      name: 'Duo',
      template: 'duo',
      voiceOver: { engine: 'elevenlabs', voice: 'JBFqnCBsd6RMkjVDRZzb', model: 'eleven_multilingual_v2' },
    });
    assert.deepEqual((await fs.readdir(path.join(p.dir, 'components'))).sort(), ['Mouth.tsx', 'layout.ts']);
    assert.equal(await fs.readFile(path.join(p.dir, 'components', 'Mouth.tsx'), 'utf8'), MOUTH);
    assert.deepEqual(p.voiceOver, { ...VOICE_OVER, speed: 1, musicLevel: 0.3 });
    const file = JSON.parse(await fs.readFile(path.join(p.dir, 'project.json'), 'utf8'));
    assert.deepEqual(file.voiceOver.speakers, VOICE_OVER.speakers);
  });

  test('a campaign without voiceOver or components writes neither', async () => {
    const p = await store.create({ ...base, name: 'Teaser', template: 'launch' });
    assert.deepEqual(await fs.readdir(path.join(p.dir, 'components')), []);
    const file = JSON.parse(await fs.readFile(path.join(p.dir, 'project.json'), 'utf8'));
    assert.equal('voiceOver' in file, false);
    assert.equal('captions' in file, false);
    assert.equal(p.captions, false);
  });

  test('a campaign with captions starts with them on, and refuses a captions value that is not a boolean', async () => {
    const duo = JSON.parse(await fs.readFile(path.join(t.config.templatesDir, 'projects/duo/template.json'), 'utf8'));
    await write('projects/duo/template.json', { ...duo, captions: true });
    const p = await store.create({ ...base, name: 'Duo', template: 'duo' });
    assert.equal(p.captions, true);
    const file = JSON.parse(await fs.readFile(path.join(p.dir, 'project.json'), 'utf8'));
    assert.equal(file.captions, true);

    await write('projects/duo/template.json', { ...duo, captions: 'yes' });
    await rejectsWithStatus(store.create({ ...base, name: 'Duo bis', template: 'duo' }), 500, /captions/);
  });

  test('a campaign without voiceOver starts with the default voice it is given', async () => {
    const voice = { engine: 'elevenlabs', voice: 'JBFqnCBsd6RMkjVDRZzb', model: 'eleven_multilingual_v2' } as const;
    const p = await store.create({ ...base, name: 'Teaser', template: 'launch', voiceOver: voice });
    assert.deepEqual(p.voiceOver, { ...voice, speed: 1, musicLevel: 0.3 });
    const file = JSON.parse(await fs.readFile(path.join(p.dir, 'project.json'), 'utf8'));
    assert.deepEqual(file.voiceOver, { ...voice, speed: 1, musicLevel: 0.3 });
  });

  test('createScene() copies missing components and never overwrites one already in the project', async () => {
    const p = await store.create({ ...base, name: 'Scènes' });
    const first = await store.createScene(p.id, { name: 'Question', template: 'dialogue' });
    assert.equal(first.template, 'dialogue');
    assert.equal(await fs.readFile(path.join(p.dir, 'components', 'Mouth.tsx'), 'utf8'), MOUTH);

    const edited = 'export function Mouth() {\n  return "edited";\n}\n';
    await fs.writeFile(path.join(p.dir, 'components', 'Mouth.tsx'), edited);
    await fs.rm(path.join(p.dir, 'components', 'layout.ts'));
    const second = await store.createScene(p.id, { name: 'Réponse', template: 'dialogue' });
    assert.equal(second.id, 'reponse');
    assert.equal(await fs.readFile(path.join(p.dir, 'components', 'Mouth.tsx'), 'utf8'), edited, "the person's file is kept");
    assert.equal(await fs.readFile(path.join(p.dir, 'components', 'layout.ts'), 'utf8'), 'export const LAYOUT = {};\n');
  });

  test('two scene templates bringing the same component name: the first one is kept', async () => {
    await write('scenes/monologue/template.json', { name: 'Monologue', category: 'feature', bars: 2, formats: ['16:9'] });
    await write('scenes/monologue/scene.tsx', SCENE_TEMPLATE_CODE);
    await write('scenes/monologue/components/Mouth.tsx', 'export function Mouth() {\n  return "monologue";\n}\n');
    await write('projects/solo/template.json', {
      name: 'Solo',
      fps: 30,
      formats: ['16:9'],
      bpm: 120,
      scenes: [
        { template: 'dialogue', name: 'Question', bars: 2 },
        { template: 'monologue', name: 'Réponse', bars: 2 },
      ],
    });
    const p = await store.create({ ...base, name: 'Solo', template: 'solo' });
    assert.equal(await fs.readFile(path.join(p.dir, 'components', 'Mouth.tsx'), 'utf8'), MOUTH);
  });

  for (const folder of ['components', 'scenes']) {
    test(`a symlinked ${folder}/ folder is refused and nothing is written outside the project`, async () => {
      const p = await store.create({ ...base, name: 'Lien' });
      const outside = path.join(t.root, 'outside');
      await fs.mkdir(outside);
      await fs.rm(path.join(p.dir, folder), { recursive: true });
      await fs.symlink(outside, path.join(p.dir, folder));

      await rejectsWithStatus(store.createScene(p.id, { name: 'Question', template: 'dialogue' }), 409);
      assert.deepEqual(await fs.readdir(outside), []);
      assert.deepEqual(
        (await store.get(p.id)).scenes.map((s) => s.id),
        ['titre'],
      );
      if (folder === 'components') assert.deepEqual(await fs.readdir(path.join(p.dir, 'scenes')), ['titre.tsx']);
      else assert.deepEqual(await fs.readdir(path.join(p.dir, 'components')), []);
    });

    test(`a ${folder}/ folder swapped for a link right after its check gets nothing written through it`, async (ctx) => {
      const p = await store.create({ ...base, name: 'Course' });
      const swapped = path.join(p.dir, folder);
      const outside = path.join(t.root, 'outside');
      const [held, heldLink] = [path.join(t.root, 'held'), path.join(t.root, 'held-link')];
      await fs.mkdir(outside);
      await fs.symlink(outside, heldLink);
      // Each check sees the real folder, which a link replaces as soon as the check is done.
      let linked = false;
      const realpath = fs.realpath;
      ctx.mock.method(fs, 'realpath', async (file: string) => {
        if (file !== swapped) return realpath(file);
        if (linked) {
          await fs.rename(swapped, heldLink);
          await fs.rename(held, swapped);
        }
        const real = await realpath(file);
        await fs.rename(swapped, held);
        await fs.rename(heldLink, swapped);
        linked = true;
        return real;
      });
      const input = folder === 'components' ? { name: 'Question', template: 'dialogue' } : { name: 'Question' };
      await assert.rejects(store.createScene(p.id, input), REFUSED);
      assert.ok(linked);
      assert.deepEqual(await fs.readdir(outside), []);
    });
  }

  test('deleting a scene moves nothing out of another project its scenes/ folder links to', async () => {
    const other = await store.create({ ...base, name: 'Autre' });
    const p = await store.create({ ...base, name: 'Lien' });
    await store.createScene(p.id, { name: 'Deux' });
    await fs.rm(path.join(p.dir, 'scenes'), { recursive: true });
    await fs.symlink(path.join(other.dir, 'scenes'), path.join(p.dir, 'scenes'));
    await store.deleteScene(p.id, 'titre');
    assert.deepEqual(await fs.readdir(path.join(other.dir, 'scenes')), ['titre.tsx']);
    assert.deepEqual(await fs.readdir(path.join(p.dir, '.cadence', 'trash')).catch(() => []), []);
  });

  test('deleting a scene removes its file and keeps its exact code in the trash', async () => {
    const p = await store.create({ ...base, name: 'Corbeille' });
    await store.createScene(p.id, { name: 'Deux' });
    const file = store.sceneFile(p.id, 'titre');
    const code = await fs.readFile(file, 'utf8');
    await store.deleteScene(p.id, 'titre');
    await assert.rejects(fs.lstat(file));
    const trash = path.join(p.dir, '.cadence', 'trash');
    const [kept, ...rest] = await fs.readdir(trash);
    assert.match(kept, /^titre-\d+\.tsx$/);
    assert.deepEqual(rest, []);
    assert.equal(await fs.readFile(path.join(trash, kept), 'utf8'), code);
  });

  test('deleting a scene removes nothing through a scenes/ folder swapped for a link after its code is read', async (ctx) => {
    const other = await store.create({ ...base, name: 'Autre' });
    const p = await store.create({ ...base, name: 'Lien' });
    await store.createScene(p.id, { name: 'Deux' });
    const scenes = path.join(p.dir, 'scenes');
    const open = fs.open;
    let swapped = false;
    ctx.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (!swapped && String(args[0]).endsWith('titre.tsx')) {
        swapped = true;
        await fs.rename(scenes, path.join(t.root, 'held'));
        await fs.symlink(path.join(other.dir, 'scenes'), scenes);
      }
      return handle;
    });
    await store.deleteScene(p.id, 'titre');
    assert.ok(swapped);
    assert.deepEqual(await fs.readdir(path.join(other.dir, 'scenes')), ['titre.tsx']);
    assert.deepEqual(
      (await store.get(p.id)).scenes.map((s) => s.id),
      ['deux'],
    );
  });

  test('a scene a restore lists again before its file is trashed keeps its file', async () => {
    const p = await store.create({ ...base, name: 'Retour' });
    await store.createScene(p.id, { name: 'Deux' });
    const json = path.join(p.dir, 'project.json');
    const listed = await fs.readFile(json, 'utf8');
    // Between the project.json write and the move to the trash, as a restore taking the lock there would.
    store.events.once('changed', () => writeFileSync(json, listed));
    await store.deleteScene(p.id, 'titre');
    assert.deepEqual(
      (await store.get(p.id)).scenes.map((s) => [s.id, s.codeVersion !== 'missing']),
      [
        ['titre', true],
        ['deux', true],
      ],
    );
    assert.deepEqual(await fs.readdir(path.join(p.dir, '.cadence', 'trash')).catch(() => []), []);
  });
});

test('a file an agent can write is never read through a symlink it put there', async () => {
  const p = await store.create({ ...base, name: 'Lien' });
  const secret = path.join(t.root, '.cadence', 'accounts.json');
  await fs.mkdir(path.dirname(secret), { recursive: true });
  await fs.writeFile(secret, 'TOPSECRET');
  const swap = async (file: string) => {
    await fs.rm(file, { force: true });
    await fs.symlink(secret, file);
  };

  await swap(path.join(p.dir, 'art-direction.md'));
  assert.equal(await store.readArtDirection(p.id), '');

  await swap(store.sceneFile(p.id, 'titre'));
  await rejectsWithStatus(store.duplicateScene(p.id, 'titre'), 404);
  assert.equal((await store.get(p.id)).scenes[0].codeVersion, 'missing');

  const brand = path.join(t.config.brandsDir, 'cadence');
  await swap(path.join(brand, 'KIT.md'));
  await swap(path.join(brand, 'art-direction.md'));
  assert.ok(!(await new FileBrandStore(t.config).describe(null)).includes('TOPSECRET'));
  assert.ok(!(await store.readArtDirection((await store.create({ ...base, name: 'Copie' })).id)).includes('TOPSECRET'));
  // A brand.json the store would accept: following the link would describe that brand instead of failing.
  const json = JSON.parse(await fs.readFile(path.join(brand, 'brand.json'), 'utf8'));
  const lookalike = path.join(t.root, '.cadence', 'lookalike.json');
  await fs.writeFile(lookalike, JSON.stringify({ ...json, name: 'TOPSECRET' }));
  await fs.rm(path.join(brand, 'brand.json'));
  await fs.symlink(lookalike, path.join(brand, 'brand.json'));
  await rejectsWithStatus(new FileBrandStore(t.config).describe(null), 500, /^(?![\s\S]*TOPSECRET)/);
});

test('the code hash never reads through a scenes/ folder linked out of the project', async () => {
  const p = await store.create({ ...base, name: 'Lien' });
  await store.syncCode(p.id);
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'titre.tsx'), 'one');
  await fs.rm(path.join(p.dir, 'scenes'), { recursive: true });
  await fs.symlink(outside, path.join(p.dir, 'scenes'));
  assert.equal(await store.syncCode(p.id), true, 'its own scene is gone');
  await fs.writeFile(path.join(outside, 'titre.tsx'), 'two');
  assert.equal(await store.syncCode(p.id), false);
});

test("a brand's assets folder swapped for a link lists nothing of it in the brand description", async () => {
  const brands = new FileBrandStore(t.config);
  const assets = path.join(t.config.brandsDir, 'cadence', 'assets');
  assert.match(await brands.describe(null), /assets\/logo-mark\.svg/);
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'SECRETNAME.txt'), '');
  await fs.rm(assets, { recursive: true });
  await fs.symlink(outside, assets);
  assert.doesNotMatch(await brands.describe(null), /SECRETNAME/);
});

/**
 * The kernel refuses a link on the way inside the open: ELOOP, or ENOTDIR for a folder Linux opens with O_DIRECTORY. The
 * macOS shell walk reports the folder outside.
 */
const REFUSED = /ELOOP|ENOTDIR|outside/;

/** A project folder whose components/a links to a folder outside it, holding a secret. */
async function linkedOut() {
  const project = path.join(t.root, 'p');
  const outside = path.join(t.root, 'outside');
  await fs.mkdir(path.join(project, 'components', 'b'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'x.ts'), 'TOPSECRET');
  await fs.writeFile(path.join(project, 'components', 'b', 'y.ts'), 'inside');
  await fs.symlink(outside, path.join(project, 'components', 'a'));
  return { project, outside, link: path.join(project, 'components', 'a') };
}

/** A project folder whose components/a links to its own .cadence/chats, which an agent turn may not write. */
async function linkedInward() {
  const project = path.join(t.root, 'p');
  const inner = path.join(project, '.cadence', 'chats');
  await fs.mkdir(inner, { recursive: true });
  await fs.mkdir(path.join(project, 'components'));
  await fs.writeFile(path.join(inner, 'chat.json'), 'CHAT');
  await fs.symlink(inner, path.join(project, 'components', 'a'));
  return { project, inner, link: path.join(project, 'components', 'a') };
}

/**
 * scenes/sub holds x.ts; a link to a folder outside, holding a secret where x.ts would be, waits beside the project to
 * take the place of `swapped` (scenes/sub or scenes).
 */
async function swappable(swapped = 'scenes/sub') {
  const project = path.join(t.root, 'p');
  const folder = path.join(project, swapped);
  const outside = path.join(t.root, 'outside');
  const file = path.join(project, 'scenes', 'sub', 'x.ts');
  const secret = path.join(outside, path.relative(folder, file));
  const [heldFolder, heldLink] = [path.join(t.root, 'held-folder'), path.join(t.root, 'held-link')];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(secret), { recursive: true });
  await fs.writeFile(file, 'inside');
  await fs.writeFile(secret, 'TOPSECRET');
  await fs.symlink(outside, heldLink);
  const toLink = async () => {
    await fs.rename(folder, heldFolder);
    await fs.rename(heldLink, folder);
  };
  const toFolder = async () => {
    await fs.rename(folder, heldLink);
    await fs.rename(heldFolder, folder);
  };
  const listing = await fs.readdir(outside, { recursive: true });
  const outsideUntouched = async () => {
    assert.deepEqual(await fs.readdir(outside, { recursive: true }), listing);
    assert.equal(await fs.readFile(secret, 'utf8'), 'TOPSECRET');
  };
  return { project, file, folder, heldFolder, toLink, toFolder, outsideUntouched };
}

/** fs.open with the folder swapped for a link during the open only. */
function swapDuringOpen(ctx: TestContext, { toLink, toFolder }: { toLink: () => Promise<void>; toFolder: () => Promise<void> }) {
  const open = fs.open;
  const state = { swapped: false };
  ctx.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    await toLink();
    try {
      return await open(...args);
    } finally {
      await toFolder();
      state.swapped = true;
    }
  });
  return state;
}

describe('readFileNoFollow', () => {
  test('reads a nested file inside its root', async () => {
    const { project } = await linkedOut();
    assert.equal(await readFileNoFollow(project, path.join(project, 'components', 'b', 'y.ts'), 'utf8'), 'inside');
  });

  test('refuses a file reached through a folder that links out of its root', async () => {
    const { project, link } = await linkedOut();
    await assert.rejects(readFileNoFollow(project, path.join(link, 'x.ts'), 'utf8'), REFUSED);
  });

  for (const swapped of ['scenes/sub', 'scenes']) {
    test(`refuses a file whose ${swapped} folder is a link out of its root during the open only`, async (ctx) => {
      const setup = await swappable(swapped);
      const state = swapDuringOpen(ctx, setup);
      const read = await readFileNoFollow(setup.project, setup.file, 'utf8').catch((e: Error) => e);
      assert.ok(read instanceof Error, `read ${read}`);
      assert.match(read.message, REFUSED);
      assert.ok(state.swapped, 'the folder was a link during the open');
    });
  }

  test('never refuses a file an atomic write replaces during the read', async (ctx) => {
    const { project, file } = await swappable();
    const open = fs.open;
    ctx.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      // On Linux the folders on the way are opened first.
      if (String(args[0]).endsWith(path.basename(file))) await writeFileAtomic(file, 'rewritten');
      return handle;
    });
    assert.equal(await readFileNoFollow(project, file, 'utf8'), 'inside');
  });

  test('refuses a file that is itself a link, even to a file inside its root', async () => {
    const { project } = await linkedOut();
    await fs.symlink(path.join(project, 'components', 'b', 'y.ts'), path.join(project, 'components', 'b', 'z.ts'));
    await assert.rejects(readFileNoFollow(project, path.join(project, 'components', 'b', 'z.ts'), 'utf8'), REFUSED);
  });

  test('refuses a file reached through a link to another folder inside its root', async () => {
    const { project, link } = await linkedInward();
    await assert.rejects(readFileNoFollow(project, path.join(link, 'chat.json'), 'utf8'), REFUSED);
  });

  test('refuses a file named outside its root even when it resolves inside', async () => {
    const { project } = await swappable();
    await fs.symlink(path.join(project, 'scenes', 'sub'), path.join(t.root, 'alias'));
    await assert.rejects(readFileNoFollow(project, path.join(t.root, 'alias', 'x.ts'), 'utf8'), /outside/);
  });

  test('refuses a FIFO at once instead of waiting for a writer', { timeout: 2_000 }, async (ctx) => {
    // Its own folder: afterEach removes t.root before this test's after hook could release a blocked open.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-fifo-'));
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    // A regression blocks a libuv thread on the open: a writer releases it, so the run fails instead of hanging.
    ctx.after(async () => {
      await fs.open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then(
        (handle) => handle.close(),
        () => undefined,
      );
      await fs.rm(dir, { recursive: true, force: true });
    });
    await assert.rejects(readFileNoFollow(dir, fifo), /not a regular file/);
  });
});

describe('writeFileInside', () => {
  test('writes through plain folders and creates the missing ones', async () => {
    const project = path.join(t.root, 'p');
    await fs.mkdir(path.join(project, 'components'), { recursive: true });
    const file = path.join(project, 'components', 'a', 'b', 'x.ts');
    await writeFileInside(project, file, 'written');
    assert.equal(await fs.readFile(file, 'utf8'), 'written');
    await writeFileInside(project, file, 'again');
    assert.equal(await fs.readFile(file, 'utf8'), 'again');
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['x.ts'], 'no temporary file left');
  });

  test('refuses a folder that is a link out of its root, creating nothing through it', async () => {
    const { project, outside, link } = await linkedOut();
    await assert.rejects(writeFileInside(project, path.join(link, 'x.ts'), 'written'), REFUSED);
    await assert.rejects(writeFileInside(project, path.join(link, 'deep', 'x.ts'), 'written'), REFUSED);
    assert.deepEqual(await fs.readdir(outside), ['x.ts']);
    assert.equal(await fs.readFile(path.join(outside, 'x.ts'), 'utf8'), 'TOPSECRET');
  });

  test('writes nothing into another folder of its root through a link to it', async () => {
    const { project, inner, link } = await linkedInward();
    await assert.rejects(writeFileInside(project, path.join(link, 'chat.json'), 'written'), REFUSED);
    await assert.rejects(writeFileInside(project, path.join(link, 'deep', 'x.ts'), 'written'), REFUSED);
    assert.deepEqual(await fs.readdir(inner), ['chat.json']);
    assert.equal(await fs.readFile(path.join(inner, 'chat.json'), 'utf8'), 'CHAT');
  });

  test('refuses a file named outside its root', async () => {
    const project = path.join(t.root, 'p');
    await fs.mkdir(project);
    await assert.rejects(writeFileInside(project, path.join(t.root, 'x.ts'), 'written'), /outside/);
    await assert.rejects(fs.access(path.join(t.root, 'x.ts')));
  });

  test('refuses a name that is a folder, writing nothing into it and leaving no temporary file beside it', async () => {
    const project = path.join(t.root, 'p');
    const dir = path.join(project, 'components', 'd');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'keep'), 'kept');
    // The rename fails, after the temporary file was written: the cleanup is what this checks.
    await assert.rejects(writeFileInside(project, dir, 'written'), /mv failed|EISDIR/);
    assert.deepEqual(await fs.readdir(dir), ['keep']);
    assert.deepEqual(await fs.readdir(path.dirname(dir)), ['d']);
  });

  test('takes names with spaces, a leading dash, quotes, newlines and shell characters as plain names', async () => {
    const project = path.join(t.root, 'p');
    await fs.mkdir(project);
    for (const rel of ['a b/-n/*[x]?$(touch p).ts', '-rf/c\'d/"e"/`touch q`;f.ts', 'g\nh/ i \n.ts', 'j\n/k\n']) {
      const file = path.join(project, rel);
      await writeFileInside(project, file, rel);
      assert.equal(await readFileNoFollow(project, file, 'utf8'), rel);
      await removeFileInside(project, file);
      await assert.rejects(fs.lstat(file));
    }
    for (const entry of await fs.readdir(project, { recursive: true, withFileTypes: true })) {
      assert.ok(entry.isDirectory(), `${entry.name} left in the root`);
    }
  });

  for (const swapped of ['scenes/sub', 'scenes']) {
    test(`writes nothing outside when ${swapped} is a link out of its root while the temporary file opens`, async (ctx) => {
      const setup = await swappable(swapped);
      const state = swapDuringOpen(ctx, setup);
      await assert.rejects(writeFileInside(setup.project, setup.file, 'written'), REFUSED);
      assert.ok(state.swapped);
      await setup.outsideUntouched();
    });

    test(`writes nothing outside when ${swapped} becomes a link once the temporary file is open`, async (ctx) => {
      const setup = await swappable(swapped);
      const open = fs.open;
      let swappedAfter = false;
      ctx.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (!swappedAfter && Number(args[1]) & constants.O_CREAT) {
          swappedAfter = true;
          await setup.toLink();
        }
        return handle;
      });
      await assert.rejects(writeFileInside(setup.project, setup.file, 'written'), REFUSED);
      assert.ok(swappedAfter, 'the folder became a link before the rename');
      await setup.outsideUntouched();
      assert.equal(await fs.readFile(path.join(setup.heldFolder, path.relative(setup.folder, setup.file)), 'utf8'), 'inside');
    });
  }
});

describe('removeFileInside', () => {
  test('removes a file inside its root; a missing file or folder is no error', async () => {
    const { project, file } = await swappable();
    await fs.writeFile(path.join(project, 'top.md'), 'top');
    await removeFileInside(project, file);
    await removeFileInside(project, path.join(project, 'top.md'));
    assert.deepEqual(await fs.readdir(path.dirname(file)), []);
    await assert.rejects(fs.access(path.join(project, 'top.md')));
    await removeFileInside(project, file);
    await removeFileInside(project, path.join(project, 'gone', 'x.ts'));
  });

  test('removes nothing through a folder that is a link out of its root', async () => {
    const { project, outside, link } = await linkedOut();
    await assert.rejects(removeFileInside(project, path.join(link, 'x.ts')), REFUSED);
    assert.equal(await fs.readFile(path.join(outside, 'x.ts'), 'utf8'), 'TOPSECRET');
  });

  test('removes nothing through a link to another folder inside its root', async () => {
    const { project, inner, link } = await linkedInward();
    await assert.rejects(removeFileInside(project, path.join(link, 'chat.json')), REFUSED);
    assert.equal(await fs.readFile(path.join(inner, 'chat.json'), 'utf8'), 'CHAT');
  });

  test('removes nothing through a link to a sibling folder whose name only adds a trailing newline', async () => {
    const project = path.join(t.root, 'p');
    const sibling = path.join(project, 'components', 'b\n');
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'x.ts'), 'kept');
    await fs.symlink(sibling, path.join(project, 'components', 'b'));
    await assert.rejects(removeFileInside(project, path.join(project, 'components', 'b', 'x.ts')), REFUSED);
    assert.equal(await fs.readFile(path.join(sibling, 'x.ts'), 'utf8'), 'kept');
  });

  test('unlinks a file that is a link without touching its target; a missing root is no error', async () => {
    const { project, outside } = await linkedOut();
    const link = path.join(project, 'components', 'b', 'z.ts');
    await fs.symlink(path.join(outside, 'x.ts'), link);
    await removeFileInside(project, link);
    await assert.rejects(fs.lstat(link));
    assert.equal(await fs.readFile(path.join(outside, 'x.ts'), 'utf8'), 'TOPSECRET');
    await removeFileInside(path.join(t.root, 'gone'), path.join(t.root, 'gone', 'scenes', 'x.ts'));
  });
});

describe('listInside', () => {
  test('lists a folder inside its root', async () => {
    const { project } = await linkedOut();
    assert.deepEqual(await listInside(project, path.join(project, 'components', 'b')), ['y.ts']);
  });

  test('refuses a folder that is a link, out of its root or to another folder inside it', async () => {
    const out = await linkedOut();
    await assert.rejects(listInside(out.project, out.link), REFUSED);
    await fs.rm(out.project, { recursive: true });
    const inward = await linkedInward();
    await assert.rejects(listInside(inward.project, inward.link), REFUSED);
  });

  test('refuses a folder named outside its root', async () => {
    const { project } = await linkedOut();
    await assert.rejects(listInside(project, t.root), /outside/);
  });

  test('lists names with newlines, a leading dash and dotfiles as fs.readdir does, and an empty folder as empty', async () => {
    const project = path.join(t.root, 'p');
    const dir = path.join(project, 'assets');
    await fs.mkdir(path.join(dir, 'sub\n'), { recursive: true });
    await fs.mkdir(path.join(project, 'empty'));
    for (const name of ['-n', '.hidden', 'a\nb', 'c d', 'e\n']) await fs.writeFile(path.join(dir, name), '');
    assert.deepEqual((await listInside(project, dir)).sort(), (await fs.readdir(dir)).sort());
    assert.deepEqual(await listInside(project, path.join(project, 'empty')), []);
  });
});

test('writes, reads, lists and removes through a root reached by a link', async () => {
  const project = path.join(t.root, 'p');
  await fs.mkdir(path.join(project, 'scenes'), { recursive: true });
  const root = path.join(t.root, 'via');
  await fs.symlink(project, root);
  const file = path.join(root, 'scenes', 'x.ts');
  await writeFileInside(root, file, 'written');
  assert.equal(await readFileNoFollow(root, file, 'utf8'), 'written');
  assert.deepEqual(await listInside(root, path.join(root, 'scenes')), ['x.ts']);
  await removeFileInside(root, file);
  assert.deepEqual(await fs.readdir(path.join(project, 'scenes')), []);
});

describe('removeTreeInside', () => {
  test('removes a tree, unlinks the links in it without following them, and takes a missing folder as done', async () => {
    const { project, outside } = await linkedOut();
    await removeTreeInside(project);
    await assert.rejects(fs.access(project));
    assert.equal(await fs.readFile(path.join(outside, 'x.ts'), 'utf8'), 'TOPSECRET');
    await removeTreeInside(project);
  });
});
