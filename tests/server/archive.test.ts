// Project archives: which paths travel, and what an export holds (read back with the tar reader).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline, type Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, test } from 'node:test';
import { createGunzip } from 'node:zlib';
import { ProjectArchiver, exportableBrandPath, exportableProjectPath } from '../../server/archive/projects';
import { readTar } from '../../server/archive/tar';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import { makeRoot, rejectsWithStatus, type TestRoot } from './helpers';

const MiB = 1024 * 1024;

let t: TestRoot;
let store: FileProjectStore;
let archiver: ProjectArchiver;

beforeEach(async () => {
  t = await makeRoot();
  await fs.writeFile(path.join(t.root, 'package.json'), JSON.stringify({ name: 'cadence', version: '9.9.9' }));
  const brands = new FileBrandStore(t.config);
  store = new FileProjectStore(t.config, { templates: new FileTemplateStore(t.config), brands });
  archiver = new ProjectArchiver({ config: t.config, store, brands });
  await store.create({ name: 'Promo Orbit', brand: 'orbit', formats: ['16:9'], fps: 30 });
  await store.create({ name: 'Rappel Orbit', brand: 'orbit', formats: ['16:9'], fps: 30 });
  await store.create({ name: 'Neutre', brand: 'cadence', formats: ['16:9'], fps: 30 });
  await store.create({ name: 'Libre', brand: null, formats: ['16:9'], fps: 30 });
});

afterEach(() => t.cleanup());

async function write(rel: string, content = rel): Promise<void> {
  const file = path.join(t.root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Every file of the archive, in order; rejects with the export's error (`pipe` would leave the reader waiting). */
async function entries(archive: Readable): Promise<[string, Buffer][]> {
  const out: [string, Buffer][] = [];
  await readTar(
    pipeline(archive, createGunzip(), () => undefined),
    {
      maxBytes: 64 * MiB,
      maxEntries: 10_000,
      maxBuffered: MiB,
      onFile: async (file) => void out.push([file.path, await buffer(file.stream)]),
    },
  );
  return out;
}

test('project paths: renders, tsconfig.json, dotfiles and most of .cadence are left out; chats, versions and voice-over go', () => {
  const dropped = [
    'renders/a.mp4',
    'tsconfig.json',
    '.cadence/thumbs/x.jpg',
    '.cadence/frames/a.jpg',
    '.cadence/seams.json',
    '.cadence/sounds/a.wav',
    '.cadence/trash/a.tsx',
    '.cadence/publications.json',
    '.cadence/chats/.DS_Store',
    '.DS_Store',
    'scenes/.DS_Store',
    'node_modules/x/index.js',
    'scenes/node_modules/x.js',
  ];
  const kept = [
    'project.json',
    'scenes/intro.tsx',
    'components/tsconfig.json',
    'assets/renders/a.png',
    '.cadence/chats/project.json',
    '.cadence/versions/index.json',
    '.cadence/voice-over/track.wav',
    'music/a.mp3.analysis.json',
  ];
  for (const rel of dropped) assert.equal(exportableProjectPath(rel), false, rel);
  for (const rel of kept) assert.equal(exportableProjectPath(rel), true, rel);
});

test('brand paths: everything but node_modules, dotfiles and the build marker', () => {
  for (const rel of ['node_modules/x/index.js', '.building', '.git/HEAD', 'assets/.DS_Store'])
    assert.equal(exportableBrandPath(rel), false, rel);
  for (const rel of ['brand.json', 'theme.css', 'assets/logo-mark.svg', 'KIT.md', 'renders/a.png'])
    assert.equal(exportableBrandPath(rel), true, rel);
});

test('one project: manifest first, then its kept files, then its brand; links and special files left out', async () => {
  const project = 'projects/promo-orbit';
  for (const rel of [
    'renders/a.mp4',
    'tsconfig.json',
    '.cadence/thumbs/x.jpg',
    '.cadence/publications.json',
    '.DS_Store',
    'scenes/.DS_Store',
    '.cadence/chats/project.json',
    '.cadence/versions/index.json',
    '.cadence/voice-over/track.wav',
    'music/a.mp3.analysis.json',
    'node_modules/x/index.js',
  ])
    await write(`${project}/${rel}`);
  await write('brands/orbit/theme.css', ':root { --x: 1; }');
  await write('brands/orbit/node_modules/font/index.css');
  await write('brands/orbit/.git/HEAD');
  await write('outside/secret.txt', 'secret');
  await fs.symlink(path.join(t.root, 'outside/secret.txt'), path.join(t.root, project, 'scenes/link.tsx'));
  await fs.symlink(path.join(t.root, 'outside'), path.join(t.root, project, 'linked'));
  execFileSync('mkfifo', [path.join(t.root, project, 'scenes/pipe.tsx')]);

  const files = await entries(await archiver.export(['promo-orbit']));
  const paths = files.map(([rel]) => rel);

  assert.equal(paths[0], 'manifest.json');
  assert.deepEqual(JSON.parse(files[0][1].toString()), {
    format: 1,
    createdWith: '9.9.9',
    projects: ['promo-orbit'],
    brands: ['orbit'],
  });
  const lastProject = paths.findLastIndex((rel) => rel.startsWith(`${project}/`));
  const firstBrand = paths.findIndex((rel) => rel.startsWith('brands/'));
  assert.ok(lastProject < firstBrand, 'project files come before brand files');
  for (const rel of [
    'project.json',
    '.cadence/chats/project.json',
    '.cadence/versions/index.json',
    '.cadence/voice-over/track.wav',
    'music/a.mp3.analysis.json',
  ])
    assert.ok(paths.includes(`${project}/${rel}`), rel);
  for (const rel of [
    'renders/a.mp4',
    'tsconfig.json',
    '.cadence/thumbs/x.jpg',
    '.cadence/publications.json',
    '.DS_Store',
    'scenes/.DS_Store',
    'node_modules/x/index.js',
    'scenes/link.tsx',
    'scenes/pipe.tsx',
    'linked/secret.txt',
  ])
    assert.ok(!paths.includes(`${project}/${rel}`), rel);
  assert.ok(!paths.some((rel) => rel.includes('secret')), 'nothing read through a link');
  assert.deepEqual(paths.filter((rel) => rel.startsWith('brands/')).sort(), [
    'brands/orbit/brand.json',
    'brands/orbit/theme.css',
  ]);
  const byPath = new Map(files);
  for (const rel of [`${project}/project.json`, 'brands/orbit/theme.css'])
    assert.deepEqual(byPath.get(rel), await fs.readFile(path.join(t.root, rel)), rel);
});

test('every project: each brand once, never cadence, nothing for a project without a brand', async () => {
  const files = await entries(await archiver.export());
  const paths = files.map(([rel]) => rel);
  assert.equal(paths[0], 'manifest.json');
  const manifest = JSON.parse(files[0][1].toString());
  assert.deepEqual(manifest.projects.sort(), ['libre', 'neutre', 'promo-orbit', 'rappel-orbit']);
  assert.deepEqual(manifest.brands, ['orbit']);
  for (const id of manifest.projects) assert.ok(paths.includes(`projects/${id}/project.json`), id);
  assert.equal(paths.filter((rel) => rel === 'brands/orbit/brand.json').length, 1);
  assert.ok(!paths.some((rel) => rel.startsWith('brands/cadence/')));
  assert.equal(new Set(paths).size, paths.length, 'no entry twice');
});

test('an unknown project is a 404, a brand missing on this machine a 409 naming it, both before any byte', async () => {
  await rejectsWithStatus(archiver.export(['nope']), 404, /nope/);
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });
  await rejectsWithStatus(archiver.export(['promo-orbit']), 409, /orbit/);
  await rejectsWithStatus(archiver.export(), 409, /orbit/);
  await entries(await archiver.export(['neutre']));
});

test('a file that cannot be read mid-stream ends the download with the error instead of hanging', { timeout: 5000 }, async () => {
  const locked = path.join(t.root, 'projects/promo-orbit/scenes/locked.tsx');
  await write('projects/promo-orbit/scenes/locked.tsx');
  await fs.chmod(locked, 0);
  try {
    // export() resolves, so the route has already sent its 200: the error can only end the stream.
    await assert.rejects(entries(await archiver.export(['promo-orbit'])), { code: 'EACCES' });
  } finally {
    await fs.chmod(locked, 0o644);
  }
});

test('a project whose project.json cannot be read is refused by name, alone or with every project, never left out', async () => {
  await fs.writeFile(path.join(store.dir('libre'), 'project.json'), '{not json');
  await rejectsWithStatus(archiver.export(['libre']), 409, /libre/);
  await rejectsWithStatus(archiver.export(), 409, /libre/);
  await entries(await archiver.export(['neutre']));
});

test('a folder with no project.json, such as an import being staged, neither blocks every-project export nor travels', async () => {
  await write('projects/.import/0b9c2f4e/libre/project.json', '{}');
  await write('projects/brouillon/notes.txt');
  await fs.mkdir(path.join(t.root, 'projects/vide'));
  const files = await entries(await archiver.export());
  assert.deepEqual(JSON.parse(files[0][1].toString()).projects, ['libre', 'neutre', 'promo-orbit', 'rappel-orbit']);
  assert.ok(!files.some(([rel]) => /^projects\/(\.import|brouillon|vide)\//.test(rel)));
  await rejectsWithStatus(archiver.export(['brouillon']), 404, /brouillon/);
});

test('left-out folders are never walked: one that cannot be read does not stop the export', async () => {
  const pruned = ['projects/promo-orbit/node_modules', 'projects/promo-orbit/.cadence/frames', 'brands/orbit/.git'];
  for (const dir of pruned) {
    await write(`${dir}/x`);
    await fs.chmod(path.join(t.root, dir), 0);
  }
  try {
    const paths = (await entries(await archiver.export(['promo-orbit']))).map(([rel]) => rel);
    assert.ok(paths.includes('projects/promo-orbit/project.json'));
    assert.ok(paths.includes('brands/orbit/brand.json'));
  } finally {
    for (const dir of pruned) await fs.chmod(path.join(t.root, dir), 0o755);
  }
});

test('a brand whose folder is a symlink is refused before any byte, never walked', async () => {
  await write('outside/orbit/brand.json', '{}');
  await write('outside/orbit/secret.txt', 'secret');
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });
  await fs.symlink(path.join(t.root, 'outside/orbit'), path.join(t.root, 'brands/orbit'));
  await rejectsWithStatus(archiver.export(['promo-orbit']), 409, /orbit/);
  await rejectsWithStatus(archiver.export(), 409, /orbit/);
});

test('a project whose folder is a symlink is not exported', async () => {
  await fs.symlink(store.dir('neutre'), path.join(t.root, 'projects/alias'));
  await rejectsWithStatus(archiver.export(['alias']), 404, /alias/);
  const files = await entries(await archiver.export());
  assert.ok(!JSON.parse(files[0][1].toString()).projects.includes('alias'));
  assert.ok(!files.some(([rel]) => rel.startsWith('projects/alias/')));
});
