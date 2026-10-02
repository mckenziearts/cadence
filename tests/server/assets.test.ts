import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { CaptureService } from '../../server/contracts';
import { FileAssetStore } from '../../server/store/assets';
import { FileProjectStore } from '../../server/store/projects';
import { makeRoot, rejectsWithStatus, type TestRoot } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let t: TestRoot;
let assets: FileAssetStore;
let dir: string;
let shots: { url: string; opts: unknown }[];
let captureError: Error | null;

beforeEach(async () => {
  t = await makeRoot();
  const store = new FileProjectStore(t.config);
  dir = (await store.create({ name: 'Médias', brand: null, formats: ['16:9'], fps: 60 })).dir;
  shots = [];
  captureError = null;
  const capture = {
    async screenshotUrl(url: string, opts: unknown) {
      if (captureError) throw captureError;
      shots.push({ url, opts });
      return PNG;
    },
  } as unknown as CaptureService;
  assets = new FileAssetStore(store, capture);
});

afterEach(() => t.cleanup());

test('upload sanitizes names, never overwrites, and checks type and size', async () => {
  const first = await assets.upload('medias', { name: 'Mon Logo (final).PNG', data: PNG });
  assert.deepEqual(first, {
    path: 'mon-logo-final.png',
    url: '/api/projects/medias/assets/file?path=mon-logo-final.png',
    size: PNG.length,
    kind: 'image',
    isReference: false,
  });
  assert.equal((await assets.upload('medias', { name: 'mon logo final.png', data: PNG })).path, 'mon-logo-final-2.png');
  const escaped = await assets.upload('medias', { name: '../../../evil.svg', data: Buffer.from('<svg/>') });
  assert.equal(escaped.path, 'evil.svg');
  assert.equal(escaped.kind, 'svg');
  assert.equal((await assets.upload('medias', { name: 'C:\\fonts\\Rota Bold.woff2', data: PNG })).kind, 'font');
  await rejectsWithStatus(assets.upload('medias', { name: 'script.js', data: PNG }), 415);
  await rejectsWithStatus(assets.upload('medias', { name: 'vide.png', data: Buffer.alloc(0) }), 400);
  await rejectsWithStatus(assets.upload('medias', { name: 'gros.png', data: Buffer.alloc(50 * 1024 * 1024 + 1) }), 413);
  await rejectsWithStatus(assets.upload('absent', { name: 'a.png', data: PNG }), 404);
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets', 'mon-logo-final.png')), PNG);
});

test('list, resolve, remove (to the project trash)', async () => {
  await assets.upload('medias', { name: 'photo.jpg', data: PNG });
  await fs.writeFile(path.join(dir, 'assets', 'refs', 'site-desktop.png'), PNG);
  await fs.writeFile(path.join(dir, 'assets', '.DS_Store'), 'x');
  assert.deepEqual(
    (await assets.list('medias')).map((a) => [a.path, a.kind, a.isReference]),
    [
      ['photo.jpg', 'image', false],
      ['refs/site-desktop.png', 'image', true],
    ],
  );
  assert.equal(assets.resolve('medias', 'refs/site-desktop.png'), path.join(dir, 'assets', 'refs', 'site-desktop.png'));
  assert.throws(() => assets.resolve('medias', '../project.json'), /Chemin invalide/);
  await rejectsWithStatus(assets.remove('medias', '../project.json'), 400);
  await rejectsWithStatus(assets.remove('medias', 'absent.png'), 404);
  await assets.remove('medias', 'photo.jpg');
  assert.deepEqual(
    (await assets.list('medias')).map((a) => a.path),
    ['refs/site-desktop.png'],
  );
  const trash = await fs.readdir(path.join(dir, '.cadence', 'trash'));
  assert.match(trash[0], /^\d+-photo\.jpg$/);
});

test('captureReference: http(s) only (localhost allowed), named refs/<name>-<device>.png', async () => {
  const local = await assets.captureReference('medias', { url: 'http://localhost:3000/tableau-de-bord', device: 'desktop' });
  assert.equal(local.path, 'refs/localhost-3000-tableau-de-bord-desktop.png');
  assert.equal(local.isReference, true);
  assert.deepEqual(shots[0], { url: 'http://localhost:3000/tableau-de-bord', opts: { device: 'desktop', fullPage: undefined } });
  const named = await assets.captureReference('medias', {
    url: 'https://orbit.example',
    device: 'mobile',
    fullPage: true,
    name: 'Accueil Orbit',
  });
  assert.equal(named.path, 'refs/accueil-orbit-mobile.png');
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets', 'refs', 'accueil-orbit-mobile.png')), PNG);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'pas une url']) {
    await rejectsWithStatus(assets.captureReference('medias', { url, device: 'desktop' }), 400);
  }
  await rejectsWithStatus(assets.captureReference('medias', { url: 'https://x.test', device: 'tablet' as never }), 400);
  captureError = new Error('net::ERR_NAME_NOT_RESOLVED');
  await rejectsWithStatus(
    assets.captureReference('medias', { url: 'https://x.test', device: 'desktop' }),
    502,
    /ERR_NAME_NOT_RESOLVED/,
  );
});

test('captureReference: the query names the file too, and capturing again keeps the previous capture in the trash', async () => {
  const capture = (url: string) => assets.captureReference('medias', { url, device: 'desktop' });
  const week = await capture('https://ledger.app/app/dashboard?period=week');
  const month = await capture('https://ledger.app/app/dashboard?period=month');
  assert.equal(week.path, 'refs/ledger-app-app-dashboard-period-week-desktop.png');
  assert.equal(month.path, 'refs/ledger-app-app-dashboard-period-month-desktop.png');

  await fs.writeFile(path.join(dir, 'assets', week.path), 'earlier capture');
  await capture('https://ledger.app/app/dashboard?period=week');
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets', week.path)), PNG);
  const [trashed, ...others] = await fs.readdir(path.join(dir, '.cadence', 'trash'));
  assert.deepEqual(others, []);
  assert.match(trashed, /^\d+-ledger-app-app-dashboard-period-week-desktop\.png$/);
  assert.equal(await fs.readFile(path.join(dir, '.cadence', 'trash', trashed), 'utf8'), 'earlier capture');
});
