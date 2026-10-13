// Project archives: which paths travel, what an export holds (read back with the tar reader), and what an import
// installs, reuses or refuses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, test } from 'node:test';
import { createGunzip, gzipSync } from 'node:zlib';
import { ProjectArchiver, exportableBrandPath, exportableProjectPath } from '../../server/archive/projects';
import { readTar, writeTar } from '../../server/archive/tar';
import { brandProblems } from '../../server/brands/check';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { FileTemplateStore } from '../../server/store/templates';
import { startServer } from '../../server/index';
import { m } from '../../server/i18n';
import { assertNoCssCodeExec } from '../../server/frames/vite';
import { HttpError, KeyedMutex, pathExists } from '../../server/util';
import { fileEntry, makeRoot, nextEvent, rawHeader, rejectsWithStatus, writeCompleteBrand, type TestRoot } from './helpers';

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
    'package.json',
    'components/package.json',
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

test('brand paths: everything but node_modules, package.json, dotfiles and the build marker', () => {
  for (const rel of ['node_modules/x/index.js', '.building', '.git/HEAD', 'assets/.DS_Store', 'package.json'])
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

const GiB = 1024 * MiB;

/** sha256 of every file under `dir` by relative path; `keep` filters the paths. */
async function hashes(dir: string, keep: (rel: string) => boolean = () => true): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, file);
    if (keep(rel))
      out[rel] = createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
  }
  return out;
}

const staged = (rel: string) => rel !== '.import' && !rel.startsWith('.import/');
/** Every path under `dir`, folders included: a refusal must not leave even an empty folder behind. */
const paths = async (dir: string) =>
  (await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])).filter(staged).sort();
const disk = async () => ({
  projects: await hashes(t.config.projectsDir, staged),
  brands: await hashes(t.config.brandsDir, staged),
  paths: [await paths(t.config.projectsDir), await paths(t.config.brandsDir)],
});
const stagingLeft = async () => [
  ...(await fs.readdir(path.join(t.config.projectsDir, '.import')).catch(() => [])),
  ...(await fs.readdir(path.join(t.config.brandsDir, '.import')).catch(() => [])),
];

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const importBuffer = (archive: Buffer) => archiver.import(Readable.from([archive]));
const exported = async (ids?: string[]) => buffer(await archiver.export(ids));
const tar = async (files: [string, Buffer | string][]) =>
  buffer(writeTar(files.map(([rel, data]) => ({ path: rel, data: Buffer.from(data) }))));
const gzipTar = async (files: [string, Buffer | string][]) => gzipSync(await tar(files));

test('import round trip: two projects and their shared brand come back byte for byte, the brand installed', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const ids = ['promo-orbit', 'rappel-orbit'];
  await write('projects/promo-orbit/assets/photo.bin', Buffer.alloc(300_000, 3).toString('latin1'));
  // Only files read whole are capped at 10 MiB: music and video go through at any size.
  const media = ['assets/clip.mp4', 'music/track.wav'];
  for (const rel of media) await write(`projects/promo-orbit/${rel}`, 'x'.repeat(11 * MiB));
  const history = [
    '.cadence/chats/project.json',
    '.cadence/versions/index.json',
    '.cadence/voice-over/ece9da11ffb1.wav',
    '.cadence/versions/objects/abc',
  ];
  // Text that only reads like a directive outside a stylesheet, which Tailwind never compiles.
  const quoted = { role: 'assistant', text: 'Build refused: @plugin and @config are not allowed' };
  await write(
    `projects/promo-orbit/${history[0]}`,
    JSON.stringify({ sessionId: '0b9c2f4e-6a1d-4c3b-9e8f-2a7d5c1b3e90', briefHash: null, messages: [quoted] }),
  );
  await write(`projects/promo-orbit/${history[1]}`, '[]');
  await write(`projects/promo-orbit/${history[2]}`, Buffer.from('RIFF\0\0\0\0WAVE').toString('latin1'));
  await write(`projects/promo-orbit/${history[3]}`, '@plugin "./x.mjs";\n');
  await write('projects/promo-orbit/art-direction.md', 'Contact: hello@config.studio\n');
  await write('projects/promo-orbit/.cadence/thumbs/x.jpg');
  const before = Object.fromEntries(
    await Promise.all(ids.map(async (id) => [id, await hashes(store.dir(id), exportableProjectPath)] as const)),
  );
  const brand = await hashes(path.join(t.root, 'brands/orbit'));
  const archive = await exported(ids);
  for (const id of await fs.readdir(t.config.projectsDir)) await fs.rm(path.join(t.config.projectsDir, id), { recursive: true });
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });

  const listed = nextEvent(store.events, 'list-changed');
  const report = await importBuffer(archive);
  await listed;

  assert.deepEqual(report, {
    projects: [
      { from: 'promo-orbit', id: 'promo-orbit', name: 'Promo Orbit' },
      { from: 'rappel-orbit', id: 'rappel-orbit', name: 'Rappel Orbit' },
    ],
    brands: { installed: ['orbit'], reused: [] },
  });
  for (const id of ids) assert.deepEqual(await hashes(store.dir(id)), before[id], id);
  for (const rel of [...media, ...history]) assert.ok(before['promo-orbit'][rel], rel);
  assert.equal(await pathExists(path.join(store.dir('promo-orbit'), '.cadence/thumbs/x.jpg')), false);
  assert.deepEqual(await hashes(path.join(t.root, 'brands/orbit')), brand);
  assert.deepEqual((await store.list()).map((p) => p.id).sort(), ids);
  assert.ok(await pathExists(path.join(store.dir('promo-orbit'), 'assets/refs')), 'the empty folders a project starts with');
  assert.deepEqual(await stagingLeft(), []);
});

test('stylesheets importing their own files and the archive brand by path pass, and leave the frame build working', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  await write('brands/orbit/extras.css', '.extra {}\n');
  await write('projects/promo-orbit/components/local.css', '.local {}\n');
  await write(
    'projects/promo-orbit/components/s.css',
    "@import './local.css';\n@import '../../../brands/orbit/extras.css';\n@import '@brands/orbit/theme.css';\n",
  );
  const archive = await exported(['promo-orbit']);
  for (const id of await fs.readdir(t.config.projectsDir)) await fs.rm(path.join(t.config.projectsDir, id), { recursive: true });
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });

  const report = await importBuffer(archive);

  assert.deepEqual(report.brands.installed, ['orbit']);
  const { projectsDir, brandsDir, templatesDir } = t.config;
  await assertNoCssCodeExec([projectsDir, brandsDir, templatesDir], brandsDir);
});

test('import reuses an installed brand untouched, whatever its content, and gives taken project ids a suffix', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const archive = await exported(['promo-orbit', 'rappel-orbit']);
  await fs.appendFile(path.join(t.root, 'brands/orbit/KIT.md'), '\nChangé ici.\n');
  const brand = await hashes(path.join(t.root, 'brands/orbit'));

  const report = await importBuffer(archive);

  assert.deepEqual(report.brands, { installed: [], reused: ['orbit'] });
  assert.deepEqual(
    report.projects.map((p) => [p.from, p.id]),
    [
      ['promo-orbit', 'promo-orbit-2'],
      ['rappel-orbit', 'rappel-orbit-2'],
    ],
  );
  assert.deepEqual(await hashes(path.join(t.root, 'brands/orbit')), brand);
  assert.deepEqual(
    await hashes(store.dir('promo-orbit-2'), exportableProjectPath),
    await hashes(store.dir('promo-orbit'), exportableProjectPath),
  );
});

test(
  'two imports of one archive at once: the brand installed once and reused once, projects <id> and <id>-2',
  { timeout: 10_000 },
  async (ctx) => {
    await writeCompleteBrand(t.root, 'orbit');
    const before = await hashes(store.dir('promo-orbit'), exportableProjectPath);
    const archive = await exported(['promo-orbit']);
    for (const id of await fs.readdir(t.config.projectsDir))
      await fs.rm(path.join(t.config.projectsDir, id), { recursive: true });
    await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });

    // The first import stops between its claim of brands/orbit (an empty folder) and the move into it; the second one
    // starts then, and the first goes on once the second waits its turn, or has given up.
    const [claimed, release, waiting] = [gate(), gate(), gate()];
    const rename = fs.rename;
    let held = false;
    ctx.mock.method(fs, 'rename', async (from: string, to: string) => {
      if (to === path.join(t.config.brandsDir, 'orbit') && !held) {
        held = true;
        claimed.open();
        await release.opened;
      }
      return rename(from, to);
    });
    const run = KeyedMutex.prototype.run;
    let imports = 0;
    ctx.mock.method(KeyedMutex.prototype, 'run', function (this: KeyedMutex, key: string, fn: () => Promise<unknown>) {
      if (key === 'import' && ++imports === 2) waiting.open();
      return run.call(this, key, fn);
    });
    const first = importBuffer(archive);
    await claimed.opened;
    const second = importBuffer(archive);
    await Promise.race([waiting.opened, second.catch(() => undefined)]);
    release.open();
    const reports = await Promise.all([first, second]);

    assert.deepEqual(
      reports.flatMap((r) => r.brands.installed),
      ['orbit'],
    );
    assert.deepEqual(
      reports.flatMap((r) => r.brands.reused),
      ['orbit'],
    );
    assert.deepEqual(reports.flatMap((r) => r.projects.map((p) => p.id)).sort(), ['promo-orbit', 'promo-orbit-2']);
    for (const id of ['promo-orbit', 'promo-orbit-2']) assert.deepEqual(await hashes(store.dir(id)), before, id);
    assert.deepEqual(await brandProblems(path.join(t.root, 'brands/orbit'), t.root), []);
    assert.deepEqual(await stagingLeft(), []);
  },
);

test('import refusals leave projects/ and brands/ as they were and no staging behind', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const good = await exported(['promo-orbit']);
  const files: [string, Buffer][] = [];
  await readTar(Readable.from([gunzip(good)]), {
    maxBytes: 64 * MiB,
    maxEntries: 1000,
    maxBuffered: MiB,
    onFile: async (file) => void files.push([file.path, await buffer(file.stream)]),
  });
  const manifest = (patch: object) => Buffer.from(JSON.stringify({ ...JSON.parse(files[0][1].toString()), ...patch }));
  const replace = (rel: string, data: Buffer | string) =>
    files.map(([name, content]): [string, Buffer | string] => [name, name === rel ? data : content]);
  const projectJson = JSON.parse(files.find(([rel]) => rel === 'projects/promo-orbit/project.json')![1].toString());
  const withoutBrand = files.filter(([rel]) => !rel.startsWith('brands/'));

  const cases: [string, () => Promise<Buffer>, number, RegExp, (() => Promise<void>)?][] = [
    ['not gzip', async () => Buffer.from('not an archive'), 400, /incorrect header check/],
    ['truncated', async () => good.subarray(0, Math.floor(good.length / 2)), 400, /unexpected end of file/],
    ['path traversal', () => gzipTar([...files, ['projects/promo-orbit/../../evil.txt', 'x']]), 400, /evil\.txt/],
    [
      'symlink entry',
      async () =>
        gzipSync(
          Buffer.concat([
            fileEntry('manifest.json', files[0][1].toString()),
            fileEntry('projects/promo-orbit/link', '', '2'),
            Buffer.alloc(1024),
          ]),
        ),
      400,
      /projects\/promo-orbit\/link/,
    ],
    [
      'css with @plugin',
      () => gzipTar([...files, ['projects/promo-orbit/components/style.css', '@plugin "x";']]),
      400,
      /style\.css/,
    ],
    [
      'css with @plugin hidden by an escaped comment end',
      () => gzipTar([...files, ['projects/promo-orbit/components/style.css', '@plu/* \\*/ x */gin "./p.mjs";']]),
      400,
      /style\.css/,
    ],
    [
      'css with @plugin split by a comment',
      () => gzipTar([...files, ['projects/promo-orbit/components/style.css', '@plu/**/gin "x";']]),
      400,
      /style\.css/,
    ],
    [
      // Tailwind inlines an @import whatever the extension.
      '@plugin in a text file a css imports',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/style.css', "@import './a.txt';"],
          ['projects/promo-orbit/components/a.txt', '@plugin "x";'],
        ]),
      400,
      /components\/style\.css/,
    ],
    [
      // Tailwind reads an imported file as CSS whatever its extension, binary media included.
      '@plugin in a png a css imports',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/style.css', "@import './logo.png';"],
          ['projects/promo-orbit/components/logo.png', Buffer.concat([PNG_HEADER, Buffer.from('@plugin "./x.mjs";')])],
        ]),
      400,
      /components\/style\.css/,
    ],
    [
      'svg with @plugin',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/style.css', "@import '../assets/logo.SVG';"],
          ['projects/promo-orbit/assets/logo.SVG', '<svg>@plugin "x";</svg>'],
        ]),
      400,
      /components\/style\.css/,
    ],
    [
      // Tailwind reads the query as part of the file name: the import would load a file the walk never scans.
      '@plugin in a file a css imports with a query',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/style.css', "@import './evil.css?.png';"],
          ['projects/promo-orbit/components/evil.css', '.a {}'],
          ['projects/promo-orbit/components/evil.css?.png', '@plugin "./x.mjs";'],
        ]),
      400,
      /components\/style\.css/,
    ],
    [
      // A string holding `@import "` must not hide the import after it from the guard.
      '@plugin in a file a css imports after a string holding an import',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/style.css', `.a { content: '@import "'; }\n@import "./evil.png";`],
          ['projects/promo-orbit/components/evil.png', '@plugin "./x.mjs";'],
        ]),
      400,
      /components\/style\.css/,
    ],
    [
      // Not a path for the guard, yet Tailwind opens the file.
      '@plugin in a file a css imports through a file: URL',
      () => gzipTar([...files, ['projects/promo-orbit/components/style.css', '@import "file:///tmp/evil.png";']]),
      400,
      /components\/style\.css/,
    ],
    [
      // The png holds no directive, but the frame build refuses an @import of a file that is not a stylesheet.
      'css importing a clean png by path',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/style.css', "@import './logo.png';"],
          ['projects/promo-orbit/components/logo.png', PNG_HEADER],
        ]),
      400,
      /projects\/promo-orbit\/components\/style\.css/,
    ],
    [
      'scene css importing a path with no extension',
      () => gzipTar([...files, ['projects/promo-orbit/scenes/x.css', "@import './fond';"]]),
      400,
      /scenes\/x\.css/,
    ],
    [
      'brand css importing a clean png by path',
      () =>
        gzipTar([
          ...files,
          ['brands/orbit/extras.css', '@import "./assets/logo.png";'],
          ['brands/orbit/assets/logo.png', PNG_HEADER],
        ]),
      400,
      /brands\/orbit\/extras\.css/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      // The brand would be installed before the project adoption fails on the folders a project starts with.
      'a file named components',
      () => gzipTar([...files, ['projects/promo-orbit/components', 'x']]),
      400,
      /projects\/promo-orbit\/components/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'a file named assets',
      () => gzipTar([...files, ['projects/promo-orbit/assets', 'x']]),
      400,
      /projects\/promo-orbit\/assets/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'project id that is a path',
      () => gzipTar(replace('manifest.json', manifest({ projects: ['../../promo-orbit'] }))),
      400,
      /manifest\.json.*projects/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'brand id that is a path',
      () => gzipTar(replace('manifest.json', manifest({ brands: ['..'] }))),
      400,
      /manifest\.json.*brands/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'duplicate scene ids',
      () =>
        gzipTar(
          replace(
            'projects/promo-orbit/project.json',
            JSON.stringify({ ...projectJson, scenes: [0, 1].map(() => ({ id: 'titre', duration: 3 })) }),
          ),
        ),
      400,
      /promo-orbit.*titre/,
    ],
    [
      'project with none of its files',
      () => gzipTar(files.filter(([rel]) => !rel.startsWith('projects/promo-orbit/'))),
      400,
      /promo-orbit.*project\.json/,
    ],
    [
      'project without its project.json',
      () => gzipTar(files.filter(([rel]) => rel !== 'projects/promo-orbit/project.json')),
      400,
      /promo-orbit.*project\.json/,
    ],
    ['manifest missing', () => gzipTar(files.slice(1)), 400, /manifest\.json/],
    ['empty archive', async () => gzipSync(Buffer.alloc(1024)), 400, /manifest\.json/],
    ['manifest not first', () => gzipTar([files[1], files[0], ...files.slice(2)]), 400, /manifest\.json/],
    ['format 2', () => gzipTar(replace('manifest.json', manifest({ format: 2 }))), 400, /9\.9\.9/],
    ['project.json not JSON', () => gzipTar(replace('projects/promo-orbit/project.json', '{not json')), 400, /promo-orbit/],
    [
      'project.json from a newer version',
      () => gzipTar(replace('projects/promo-orbit/project.json', JSON.stringify({ ...projectJson, version: 2 }))),
      400,
      /promo-orbit.*version/,
    ],
    [
      'a file where the archive put a folder',
      () => gzipTar([...files, ['projects/promo-orbit/assets/a/b.txt', 'x'], ['projects/promo-orbit/assets/a', 'x']]),
      400,
      /projects\/promo-orbit\/assets\/a entre en conflit/,
    ],
    [
      'a folder where the archive put a file',
      () => gzipTar([...files, ['projects/promo-orbit/assets/a', 'x'], ['projects/promo-orbit/assets/a/b.txt', 'x']]),
      400,
      /projects\/promo-orbit\/assets\/a\/b\.txt entre en conflit/,
    ],
    [
      'one path twice',
      () => gzipTar([...files, ['projects/promo-orbit/assets/a.txt', 'x'], ['projects/promo-orbit/assets/a.txt', 'y']]),
      400,
      /duplicate entry "projects\/promo-orbit\/assets\/a\.txt"/,
    ],
    [
      // Read from where the project lands, the import reaches the brand's folder named like a stylesheet.
      'css importing a folder of the archive brand through a path out of the project',
      () =>
        gzipTar([
          ...files,
          ['projects/promo-orbit/components/s.css', "@import '../../../brands/orbit/dir.css';"],
          ['brands/orbit/dir.css/x.txt', 'x'],
        ]),
      400,
      /projects\/promo-orbit\/components\/s\.css/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'unknown format id',
      () => gzipTar(replace('projects/promo-orbit/project.json', JSON.stringify({ ...projectJson, formats: ['3:1'] }))),
      400,
      /promo-orbit.*formats/,
    ],
    [
      'brand in neither place',
      () => gzipTar(withoutBrand.map(([rel, data]) => [rel, rel === 'manifest.json' ? manifest({ brands: [] }) : data])),
      400,
      /orbit/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'staged brand with problems',
      () => gzipTar(replace('brands/orbit/KIT.md', 'Trop court.')),
      400,
      /orbit.*KIT\.md/,
      () => fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true }),
    ],
    [
      'entry outside the listed projects',
      () => gzipTar([...files, ['projects/autre/project.json', '{}']]),
      400,
      /projects\/autre/,
    ],
    ['a file where a folder is', () => gzipTar([...files, ['projects/promo-orbit/scenes/titre.tsx/x', 'x']]), 400, /titre\.tsx/],
    [
      'over the unpacked cap',
      async () => gzipSync(Buffer.concat([rawHeader({ name: 'manifest.json', size: 5 * GiB }), Buffer.alloc(1024)])),
      413,
      /bytes/,
    ],
    [
      // Folders are counted but never staged.
      'over the entries cap',
      async () =>
        gzipSync(
          Buffer.concat([
            fileEntry('manifest.json', files[0][1].toString()),
            ...Array.from({ length: 100_001 }, (_, i) => rawHeader({ name: `projects/promo-orbit/d${i}/`, type: '5' })),
            Buffer.alloc(1024),
          ]),
        ),
      413,
      /entries/,
    ],
    [
      'manifest over the buffered cap',
      () => gzipTar([['manifest.json', Buffer.alloc(11 * MiB, 0x20)], ...files.slice(1)]),
      413,
      /manifest\.json/,
    ],
    [
      'a stylesheet over the buffered cap',
      () => gzipTar([...files, ['projects/promo-orbit/components/style.css', Buffer.alloc(10 * MiB + 1, 0x20)]]),
      413,
      /style\.css/,
    ],
  ];
  for (const [label, make, status, message, arrange] of cases) {
    await arrange?.();
    const before = await disk();
    try {
      await rejectsWithStatus(importBuffer(await make()), status, message);
    } catch (e) {
      throw new Error(`${label}: ${(e as Error).message}`);
    }
    assert.deepEqual(await disk(), before, label);
    assert.deepEqual(await stagingLeft(), [], label);
    if (arrange) await writeCompleteBrand(t.root, 'orbit');
  }
});

test('a directive hidden by an escaped comment end is refused when the upload cuts it in two', { timeout: 10_000 }, async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const entry = 'components/style.css';
  const [head, tail] = ['@plu/* \\', '*/ x */gin "./p.mjs";'];
  const manifest = JSON.stringify({ format: 1, createdWith: '9.9.9', projects: ['promo-orbit'], brands: [] });
  const archive = gzipSync(
    await tar([
      ['manifest.json', manifest],
      [`projects/promo-orbit/${entry}`, head + tail],
      ['projects/promo-orbit/project.json', await fs.readFile(path.join(store.dir('promo-orbit'), 'project.json'))],
    ]),
    // Stored blocks keep the bytes as they are, so the upload can be cut right after `head`.
    { level: 0 },
  );
  const cut = archive.indexOf(head + tail) + head.length;
  assert.ok(cut > head.length);
  const stagedHead = async () => {
    const root = path.join(t.config.projectsDir, '.import');
    for (const uuid of await fs.readdir(root).catch(() => [])) {
      const file = path.join(root, uuid, 'promo-orbit', entry);
      if ((await fs.readFile(file, 'latin1').catch(() => '')) === head) return true;
    }
    return false;
  };
  const body = async function* () {
    yield archive.subarray(0, cut);
    // The rest waits until the first piece is on the disk: the scan has read it alone.
    while (!(await stagedHead())) await new Promise((resolve) => setTimeout(resolve, 5));
    yield archive.subarray(cut);
  };
  const before = await disk();
  // The exact message: a scan that missed the split would still be refused later, by cssCodeOffenders with cssImport.
  await assert.rejects(
    archiver.import(body()),
    (e: HttpError) => e.status === 400 && e.message === m().api.archives.cssCodeExec(`projects/promo-orbit/${entry}`),
  );
  assert.deepEqual(await disk(), before);
  assert.deepEqual(await stagingLeft(), []);
});

test('import skips brands/cadence of an archive and reports cadence as reused', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const files: [string, Buffer][] = [];
  await readTar(Readable.from([gunzip(await exported(['promo-orbit']))]), {
    maxBytes: 64 * MiB,
    maxEntries: 1000,
    maxBuffered: MiB,
    onFile: async (file) => void files.push([file.path, await buffer(file.stream)]),
  });
  const cadence = await hashes(path.join(t.root, 'brands/cadence'));
  const report = await importBuffer(
    await gzipTar([...files, ['brands/cadence/brand.json', '{}'], ['brands/cadence/theme.css', '@plugin "x";']]),
  );
  assert.deepEqual(report.brands, { installed: [], reused: ['cadence', 'orbit'] });
  assert.deepEqual(await hashes(path.join(t.root, 'brands/cadence')), cadence);
});

test('a brand being built on this machine refuses the whole import with a 409, with or without its brand.json', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  // Sorted before orbit: it must not be installed when orbit refuses the import.
  await writeCompleteBrand(t.root, 'astra');
  await store.create({ name: 'Astra', brand: 'astra', formats: ['16:9'], fps: 30 });
  const archive = await exported(['astra', 'promo-orbit']);
  await fs.rm(path.join(t.root, 'brands/astra'), { recursive: true });
  await fs.writeFile(path.join(t.root, 'brands/orbit/.building'), `${process.pid} build\n`);
  for (const step of ['with brand.json', 'without brand.json']) {
    if (step === 'without brand.json') await fs.rm(path.join(t.root, 'brands/orbit/brand.json'));
    const before = await disk();
    await rejectsWithStatus(importBuffer(archive), 409, /orbit/);
    assert.deepEqual(await disk(), before, step);
    assert.deepEqual(await stagingLeft(), [], step);
  }
});

test('refuses before installing any brand when a brand folder of the archive holds files but no brand.json', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  await writeCompleteBrand(t.root, 'astra');
  await store.create({ name: 'Astra', brand: 'astra', formats: ['16:9'], fps: 30 });
  const archive = await exported(['astra', 'promo-orbit']);
  for (const id of ['astra', 'orbit']) await fs.rm(path.join(t.root, 'brands', id), { recursive: true });
  await write('brands/orbit/.DS_Store', 'x');
  const before = await disk();

  await rejectsWithStatus(importBuffer(archive), 409, /brands\/orbit/);

  assert.deepEqual(await disk(), before);
  assert.equal(await pathExists(path.join(t.root, 'brands/astra')), false);
  assert.deepEqual(await stagingLeft(), []);
});

test('a refusal keeps its own status and message: an HttpError from the body, a check of the archive', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const archive = await exported(['promo-orbit']);
  const body = async function* () {
    yield archive.subarray(0, 64);
    throw new HttpError(413, 'over the upload cap');
  };
  await assert.rejects(archiver.import(body()), (e: HttpError) => e.status === 413 && e.message === 'over the upload cap');
  assert.deepEqual(await stagingLeft(), []);

  const files: [string, Buffer][] = [];
  await readTar(Readable.from([gunzip(archive)]), {
    maxBytes: 64 * MiB,
    maxEntries: 1000,
    maxBuffered: MiB,
    onFile: async (file) => void files.push([file.path, await buffer(file.stream)]),
  });
  const entry = 'projects/promo-orbit/components/style.css';
  await assert.rejects(
    importBuffer(await gzipTar([...files, [entry, '@plugin "x";']])),
    (e: HttpError) => e.status === 400 && e.message === m().api.archives.cssCodeExec(entry),
  );
  assert.deepEqual(await stagingLeft(), []);
});

test('a project whose brand is not in the archive but is being built here refuses the import with a 409', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  await fs.writeFile(path.join(t.root, 'brands/orbit/.building'), `${process.pid} build\n`);
  const archive = await gzipTar([
    ['manifest.json', JSON.stringify({ format: 1, createdWith: '9.9.9', projects: ['promo-orbit'], brands: [] })],
    ['projects/promo-orbit/project.json', await fs.readFile(path.join(store.dir('promo-orbit'), 'project.json'))],
  ]);
  const before = await disk();
  await rejectsWithStatus(importBuffer(archive), 409, /orbit/);
  assert.deepEqual(await disk(), before);
  assert.deepEqual(await stagingLeft(), []);
});

test('import leaves out the paths an export never writes, in projects and in brands', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const brand = await hashes(path.join(t.root, 'brands/orbit'));
  const brandFiles = await Promise.all(
    Object.keys(brand).map(async (rel): Promise<[string, Buffer]> => [
      `brands/orbit/${rel}`,
      await fs.readFile(path.join(t.root, 'brands/orbit', rel)),
    ]),
  );
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });
  const dropped = [
    'tsconfig.json',
    'renders/a.mp4',
    'node_modules/x/index.js',
    'components/package.json',
    '.cadence/frames/a',
    '.DS_Store',
  ];
  const archive = await gzipTar([
    ['manifest.json', JSON.stringify({ format: 1, createdWith: '9.9.9', projects: ['promo-orbit'], brands: ['orbit'] })],
    ['projects/promo-orbit/project.json', await fs.readFile(path.join(store.dir('promo-orbit'), 'project.json'))],
    ...dropped.map((rel): [string, string] => [`projects/promo-orbit/${rel}`, rel]),
    ...brandFiles,
    ['brands/orbit/node_modules/x.css', '.x {}'],
    ['brands/orbit/.building', 'x'],
  ]);

  const report = await importBuffer(archive);

  assert.deepEqual(report.brands, { installed: ['orbit'], reused: [] });
  for (const rel of dropped) assert.equal(await pathExists(path.join(store.dir('promo-orbit-2'), rel)), false, rel);
  assert.deepEqual(await hashes(path.join(t.root, 'brands/orbit')), brand);
});

test('a brand installed here is reused when the archive carries none of its files, or when its folder is a link', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const archive = await gzipTar([
    ['manifest.json', JSON.stringify({ format: 1, createdWith: '9.9.9', projects: ['promo-orbit'], brands: ['orbit'] })],
    ['projects/promo-orbit/project.json', await fs.readFile(path.join(store.dir('promo-orbit'), 'project.json'))],
    ['brands/orbit/.building', 'x'],
  ]);
  const full = await exported(['promo-orbit']);
  const brand = await hashes(path.join(t.root, 'brands/orbit'));
  const first = await importBuffer(archive);
  assert.deepEqual(first.brands, { installed: [], reused: ['orbit'] });
  assert.deepEqual(
    first.projects.map((p) => p.id),
    ['promo-orbit-2'],
  );
  assert.deepEqual(await hashes(path.join(t.root, 'brands/orbit')), brand);

  await fs.rename(path.join(t.root, 'brands/orbit'), path.join(t.root, 'outside-orbit'));
  await fs.symlink(path.join(t.root, 'outside-orbit'), path.join(t.root, 'brands/orbit'));
  const second = await importBuffer(full);
  assert.deepEqual(second.brands, { installed: [], reused: ['orbit'] });
  assert.deepEqual(
    second.projects.map((p) => p.id),
    ['promo-orbit-3'],
  );
  assert.ok((await fs.lstat(path.join(t.root, 'brands/orbit'))).isSymbolicLink());
  assert.deepEqual(await hashes(path.join(t.root, 'outside-orbit')), brand);
  assert.deepEqual(await stagingLeft(), []);
});

test('BrandStore.adopt: a folder being built, or one it did not create, is a 409; a brand is reused; a free id is installed', async () => {
  const brands = new FileBrandStore(t.config);
  const staging = path.join(t.config.brandsDir, '.import', 'u1');
  const target = path.join(t.root, 'brands/orbit');
  await writeCompleteBrand(t.root, 'orbit');
  await fs.mkdir(staging, { recursive: true });
  await fs.cp(target, path.join(staging, 'orbit'), { recursive: true });
  const stagedBrand = await hashes(path.join(staging, 'orbit'));
  await fs.appendFile(path.join(target, 'KIT.md'), '\nChangé ici.\n');
  const local = await hashes(target);

  assert.equal(await brands.adopt(path.join(staging, 'orbit'), 'orbit'), 'reused');
  assert.deepEqual(await hashes(target), local);

  await fs.writeFile(path.join(target, '.building'), `${process.pid} build\n`);
  const building = await hashes(target);
  await rejectsWithStatus(brands.adopt(path.join(staging, 'orbit'), 'orbit'), 409, /orbit/);
  assert.deepEqual(await hashes(target), building);
  assert.deepEqual(await hashes(path.join(staging, 'orbit')), stagedBrand);

  // A build that has claimed the folder and written files, but not yet its marker or brand.json.
  await fs.rm(target, { recursive: true });
  await write('brands/orbit/theme.css', ':root {}');
  const claimed = await hashes(target);
  await rejectsWithStatus(brands.adopt(path.join(staging, 'orbit'), 'orbit'), 409, /orbit/);
  assert.deepEqual(await hashes(target), claimed);
  assert.deepEqual(await hashes(path.join(staging, 'orbit')), stagedBrand);

  // A build's reserve() between its mkdir and its marker: the folder is the build's, never replaced.
  await fs.rm(target, { recursive: true });
  await fs.mkdir(target);
  await rejectsWithStatus(brands.adopt(path.join(staging, 'orbit'), 'orbit'), 409, /orbit/);
  assert.deepEqual(await fs.readdir(target), []);
  assert.deepEqual(await hashes(path.join(staging, 'orbit')), stagedBrand);

  await fs.rmdir(target);
  assert.equal(await brands.adopt(path.join(staging, 'orbit'), 'orbit'), 'installed');
  assert.deepEqual(await brandProblems(target, t.root), []);
});

test('ProjectStore.adopt: three adoptions of one id at once each claim their own folder', async () => {
  const staging = path.join(t.config.projectsDir, '.import', 'u1');
  const names = ['Un', 'Deux', 'Trois'];
  for (const [i, name] of names.entries()) {
    await write(path.relative(t.root, path.join(staging, `s${i}`, 'project.json')), JSON.stringify({ name, fps: 30 }));
  }

  const ids = await Promise.all(names.map((_, i) => store.adopt(path.join(staging, `s${i}`), 'x')));

  assert.deepEqual([...ids].sort(), ['x', 'x-2', 'x-3']);
  for (const [i, id] of ids.entries()) {
    assert.equal(JSON.parse(await fs.readFile(path.join(store.dir(id), 'project.json'), 'utf8')).name, names[i], id);
  }
});

test('ProjectStore.adopt releases the folder it claimed when the move fails', async () => {
  const missing = path.join(t.config.projectsDir, '.import', 'missing', 'x');
  await assert.rejects(store.adopt(missing, 'ghost'), { code: 'ENOENT' });
  assert.equal(await pathExists(store.dir('ghost')), false);

  const staged = path.join(t.config.projectsDir, '.import', 'u1', 'ghost');
  await write(path.relative(t.root, path.join(staged, 'project.json')), JSON.stringify({ name: 'Ghost', fps: 30 }));
  assert.equal(await store.adopt(staged, 'ghost'), 'ghost');
});

test('BrandStore.adopt removes the folder it claimed when the move fails', async () => {
  const brands = new FileBrandStore(t.config);
  await assert.rejects(brands.adopt(path.join(t.config.brandsDir, '.import', 'missing', 'astra'), 'astra'), {
    code: 'ENOENT',
  });
  assert.equal(await pathExists(path.join(t.root, 'brands/astra')), false);
});

test('import uses a brand installed here that the archive does not carry', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const brand = await hashes(path.join(t.root, 'brands/orbit'));
  const archive = await gzipTar([
    ['manifest.json', JSON.stringify({ format: 1, createdWith: '9.9.9', projects: ['promo-orbit'], brands: [] })],
    ['projects/promo-orbit/project.json', await fs.readFile(path.join(store.dir('promo-orbit'), 'project.json'))],
  ]);

  const report = await importBuffer(archive);

  assert.deepEqual(report.brands, { installed: [], reused: [] });
  assert.deepEqual(report.projects, [{ from: 'promo-orbit', id: 'promo-orbit-2', name: 'Promo Orbit' }]);
  assert.equal((await store.get('promo-orbit-2')).brand, 'orbit');
  assert.deepEqual(await hashes(path.join(t.root, 'brands/orbit')), brand);
});

test('an id listed twice in the manifest is imported once', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const archive = await exported(['promo-orbit']);
  for (const id of await fs.readdir(t.config.projectsDir)) await fs.rm(path.join(t.config.projectsDir, id), { recursive: true });
  await fs.rm(path.join(t.root, 'brands/orbit'), { recursive: true });
  const files: [string, Buffer][] = [];
  await readTar(Readable.from([gunzip(archive)]), {
    maxBytes: 64 * MiB,
    maxEntries: 1000,
    maxBuffered: MiB,
    onFile: async (file) => void files.push([file.path, await buffer(file.stream)]),
  });
  files[0][1] = Buffer.from(
    JSON.stringify({ format: 1, createdWith: '9.9.9', projects: ['promo-orbit', 'promo-orbit'], brands: ['orbit', 'orbit'] }),
  );

  const report = await importBuffer(await gzipTar(files));

  assert.deepEqual(report.projects, [{ from: 'promo-orbit', id: 'promo-orbit', name: 'Promo Orbit' }]);
  assert.deepEqual(report.brands, { installed: ['orbit'], reused: [] });
  assert.deepEqual(await fs.readdir(t.config.projectsDir), ['.import', 'promo-orbit']);
});

test('a staging folder older than an hour is removed by the next import, a younger one is kept', async () => {
  await writeCompleteBrand(t.root, 'orbit');
  const archive = await exported(['neutre']);
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const root of [t.config.projectsDir, t.config.brandsDir]) {
    await write(path.relative(t.root, path.join(root, '.import/crashed/x/file.txt')));
    await write(path.relative(t.root, path.join(root, '.import/running/x/file.txt')));
    await fs.utimes(path.join(root, '.import/crashed'), old, old);
  }
  await importBuffer(archive);
  for (const root of [t.config.projectsDir, t.config.brandsDir]) {
    assert.deepEqual(await fs.readdir(path.join(root, '.import')), ['running'], root);
  }
});

test('an import waiting over an hour for its turn keeps its staging folders when another import sweeps', async (ctx) => {
  await writeCompleteBrand(t.root, 'orbit');
  const archive = await exported(['promo-orbit']);
  const [staged, release] = [gate(), gate()];
  const run = KeyedMutex.prototype.run;
  let imports = 0;
  ctx.mock.method(KeyedMutex.prototype, 'run', async function (this: KeyedMutex, key: string, fn: () => Promise<unknown>) {
    if (key === 'import' && ++imports === 1) {
      staged.open();
      await release.opened;
    }
    return run.call(this, key, fn);
  });
  const first = importBuffer(archive);
  await staged.opened;
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const root of [t.config.projectsDir, t.config.brandsDir]) {
    for (const name of await fs.readdir(path.join(root, '.import'))) await fs.utimes(path.join(root, '.import', name), old, old);
  }
  await importBuffer(await exported(['neutre']));
  release.open();

  assert.deepEqual(
    (await first).projects.map((p) => p.id),
    ['promo-orbit-2'],
  );
  assert.deepEqual(await stagingLeft(), []);
});

test('starting the server removes a staging folder older than an hour, a younger one is kept', async () => {
  process.env.CADENCE_VITE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../node_modules/.vite-e2e/archive');
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const root of [t.config.projectsDir, t.config.brandsDir]) {
    await write(path.relative(t.root, path.join(root, '.import/crashed/x/file.txt')));
    await write(path.relative(t.root, path.join(root, '.import/running/x/file.txt')));
    await fs.utimes(path.join(root, '.import/crashed'), old, old);
  }
  const provider = {
    id: 'fake',
    label: 'Agent de test',
    status: async () => ({ ok: true, label: 'Agent de test' }),
    async *run() {
      yield { type: 'done' as const, text: '', isError: false, durationMs: 0 };
    },
  };
  const { projectsDir, brandsDir, templatesDir, stateDir } = t.config;
  const server = await startServer({
    projectsDir,
    brandsDir,
    templatesDir,
    stateDir,
    editorPort: 0,
    framePort: 0,
    quiet: true,
    provider,
  });
  await server.close();
  for (const root of [t.config.projectsDir, t.config.brandsDir]) {
    assert.deepEqual(await fs.readdir(path.join(root, '.import')), ['running'], root);
  }
});

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

function gunzip(data: Buffer): Buffer {
  return execFileSync('gunzip', ['-c'], { input: data, maxBuffer: 256 * MiB });
}
