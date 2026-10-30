import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { UnapprovedHost } from '../../server/capture/capture';
import { LOCAL, STRICT } from '../../server/capture/policy';
import type { CaptureService } from '../../server/contracts';
import { FileAssetStore } from '../../server/store/assets';
import { FileProjectStore } from '../../server/store/projects';
import { makeRoot, rejectsWithStatus, type TestRoot } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MiB = 1024 * 1024;
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg introuvable';
const LOTTIE = { v: '5.12.2', fr: 30, ip: 0, op: 60, w: 512, h: 512, layers: [] };

/** A body that never ends, in 1 MiB chunks: an upload reads it only up to its limit. */
let pulled = 0;
function* endless(): Generator<Uint8Array> {
  const chunk = Buffer.alloc(MiB, 1);
  for (pulled = 0; ; pulled++) yield chunk;
}

let t: TestRoot;
let assets: FileAssetStore;
let dir: string;
let shots: { url: string; opts: Record<string, unknown> }[];
let captureError: Error | null;

beforeEach(async () => {
  t = await makeRoot();
  const store = new FileProjectStore(t.config);
  dir = (await store.create({ name: 'Médias', brand: null, formats: ['16:9'], fps: 60 })).dir;
  shots = [];
  captureError = null;
  const capture = {
    async screenshotUrl(url: string, opts: Record<string, unknown>) {
      if (captureError) throw captureError;
      shots.push({ url, opts });
      return PNG;
    },
  } as unknown as CaptureService;
  assets = new FileAssetStore(store, capture, 'ffmpeg');
});

afterEach(() => t.cleanup());

test('upload sanitizes names, never overwrites, and checks type and size', async () => {
  const first = await assets.upload('medias', { name: 'Mon Logo (final).PNG', body: [PNG] });
  assert.deepEqual(first, {
    path: 'mon-logo-final.png',
    url: '/api/projects/medias/assets/file?path=mon-logo-final.png',
    size: PNG.length,
    kind: 'image',
    isReference: false,
  });
  assert.equal((await assets.upload('medias', { name: 'mon logo final.png', body: [PNG] })).path, 'mon-logo-final-2.png');
  const escaped = await assets.upload('medias', { name: '../../../evil.svg', body: [Buffer.from('<svg/>')] });
  assert.equal(escaped.path, 'evil.svg');
  assert.equal(escaped.kind, 'svg');
  assert.equal((await assets.upload('medias', { name: 'C:\\fonts\\Rota Bold.woff2', body: [PNG] })).kind, 'font');
  await rejectsWithStatus(assets.upload('medias', { name: 'script.js', body: [PNG] }), 415);
  await rejectsWithStatus(assets.upload('medias', { name: 'vide.png', body: [Buffer.alloc(0)] }), 400);
  await rejectsWithStatus(assets.upload('medias', { name: 'gros.png', body: endless() }), 413);
  await rejectsWithStatus(assets.upload('absent', { name: 'a.png', body: [PNG] }), 404);
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets', 'mon-logo-final.png')), PNG);
});

test('uploads of the same name at once each get their own file', async () => {
  const bodies = [Buffer.from('un'), Buffer.from('deux'), Buffer.from('trois')];
  async function* late(chunk: Buffer) {
    await new Promise((resolve) => setImmediate(resolve));
    yield chunk;
  }
  const uploaded = await Promise.all([
    assets.upload('medias', { name: 'Logo.png', body: [bodies[0]] }),
    assets.upload('medias', { name: 'Logo.png', body: late(bodies[1]) }),
    assets.upload('medias', { name: 'logo.PNG', body: [bodies[2]] }),
  ]);
  assert.deepEqual(uploaded.map((a) => a.path).sort(), ['logo-2.png', 'logo-3.png', 'logo.png']);
  for (const [i, asset] of uploaded.entries()) {
    assert.deepEqual(await fs.readFile(path.join(dir, 'assets', asset.path)), bodies[i]);
  }
  assert.deepEqual((await fs.readdir(path.join(dir, 'assets'))).sort(), ['logo-2.png', 'logo-3.png', 'logo.png', 'refs']);
});

test('list, resolve, remove (to the project trash)', async () => {
  await assets.upload('medias', { name: 'photo.jpg', body: [PNG] });
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

test('captureReference: http(s) only, named refs/<name>-<device>.png, under the policy it is given', async () => {
  const local = await assets.captureReference(
    'medias',
    { url: 'http://localhost:3000/tableau-de-bord', device: 'desktop' },
    LOCAL,
  );
  assert.equal(local.path, 'refs/localhost-3000-tableau-de-bord-desktop.png');
  assert.equal(local.isReference, true);
  assert.deepEqual(shots[0], {
    url: 'http://localhost:3000/tableau-de-bord',
    opts: { device: 'desktop', fullPage: undefined, policy: LOCAL },
  });
  const named = await assets.captureReference(
    'medias',
    { url: 'https://orbit.example', device: 'mobile', fullPage: true, name: 'Accueil Orbit' },
    STRICT,
  );
  assert.equal(named.path, 'refs/accueil-orbit-mobile.png');
  assert.deepEqual(shots[1].opts, { device: 'mobile', fullPage: true, policy: STRICT });
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets', 'refs', 'accueil-orbit-mobile.png')), PNG);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'pas une url']) {
    await rejectsWithStatus(assets.captureReference('medias', { url, device: 'desktop' }, STRICT), 400);
  }
  await rejectsWithStatus(assets.captureReference('medias', { url: 'https://x.test', device: 'tablet' as never }, STRICT), 400);
  captureError = new Error('net::ERR_NAME_NOT_RESOLVED');
  await rejectsWithStatus(
    assets.captureReference('medias', { url: 'https://x.test', device: 'desktop' }, STRICT),
    502,
    /ERR_NAME_NOT_RESOLVED/,
  );
  // The MCP tool asks the person about the host it names.
  const unapproved = new UnapprovedHost('x.test');
  captureError = unapproved;
  await assert.rejects(
    assets.captureReference('medias', { url: 'https://x.test', device: 'desktop' }, STRICT),
    (e) => e === unapproved,
  );
});

test('captureReference: the query names the file too, and capturing again keeps the previous capture in the trash', async () => {
  const capture = (url: string) => assets.captureReference('medias', { url, device: 'desktop' }, STRICT);
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

test('videos and GIFs are kept once ffmpeg reads them; otherwise 422 and nothing stays in assets/', { skip }, async () => {
  const work = await fs.mkdtemp(path.join(t.root, 'clips-'));
  const make = (name: string, ...args: string[]) => {
    const file = path.join(work, name);
    const res = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=10:duration=1',
      ...args,
      file,
    ]);
    assert.equal(res.status, 0, res.stderr.toString());
    return fs.readFile(file);
  };
  const mp4 = await make('a.mp4', '-pix_fmt', 'yuv420p');
  const chunks = [mp4.subarray(0, 100), mp4.subarray(100)];
  const clip = await assets.upload('medias', { name: 'Mon Clip.MP4', body: chunks });
  assert.deepEqual([clip.path, clip.size], ['mon-clip.mp4', mp4.length]);
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets', 'mon-clip.mp4')), mp4);
  assert.equal((await assets.upload('medias', { name: 'iphone.mov', body: [mp4] })).path, 'iphone.mov');
  assert.equal((await assets.upload('medias', { name: 'export.m4v', body: [mp4] })).path, 'export.m4v');
  assert.equal(
    (await assets.upload('medias', { name: 'web.webm', body: [await make('b.webm', '-c:v', 'libvpx')] })).path,
    'web.webm',
  );
  assert.equal((await assets.upload('medias', { name: 'loader.gif', body: [await make('c.gif')] })).path, 'loader.gif');
  // GIF87a, one pixel, no Graphic Control Extension: ffmpeg states no duration and no frame rate.
  const pixel = Buffer.from('47494638376101000100800000ffffff0000002c00000000010001000002024401003b', 'hex');
  assert.equal(pixel.length, 35);
  assert.equal((await assets.upload('medias', { name: 'pixel.gif', body: [pixel] })).path, 'pixel.gif');

  await rejectsWithStatus(
    assets.upload('medias', { name: 'Faux Clip.mp4', body: [Buffer.from('#EXTM3U\n#EXTINF:1,\nhttp://x.test/a.ts\n')] }),
    422,
    /Faux Clip\.mp4/,
  );
  await rejectsWithStatus(assets.upload('medias', { name: 'web.webm', body: [mp4] }), 422);
  await rejectsWithStatus(assets.upload('medias', { name: 'image.gif', body: [PNG] }), 422);
  assert.deepEqual((await fs.readdir(path.join(dir, 'assets'))).sort(), [
    'export.m4v',
    'iphone.mov',
    'loader.gif',
    'mon-clip.mp4',
    'pixel.gif',
    'refs',
    'web.webm',
  ]);
});

test('a webm written to a pipe states no duration: 422 saying how to rewrite it', { skip }, async () => {
  const lavfi = ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1', '-c:v', 'libvpx', '-f', 'webm', '-'];
  const res = spawnSync('ffmpeg', ['-v', 'error', ...lavfi]);
  assert.equal(res.status, 0, res.stderr.toString());
  await rejectsWithStatus(assets.upload('medias', { name: 'stream.webm', body: [res.stdout] }), 422, /stream\.webm.*durée/);
  assert.deepEqual(await fs.readdir(path.join(dir, 'assets')), ['refs']);
});

test('an ffmpeg that cannot start fails the upload, naming it, and nothing stays in assets/', async () => {
  const absent = path.join(t.root, 'absent');
  const missing = new FileAssetStore(new FileProjectStore(t.config), {} as CaptureService, absent);
  await assert.rejects(
    missing.upload('medias', { name: 'clip.mp4', body: [Buffer.from('not read')] }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, undefined);
      assert.ok(e.message.includes(`ffmpeg (${absent})`), e.message);
      return true;
    },
  );
  assert.deepEqual(await fs.readdir(path.join(dir, 'assets')), ['refs']);
});

test('an ffmpeg that never ends is killed after 10 s: 422 and nothing stays in assets/', { timeout: 20_000 }, async () => {
  const bin = path.join(t.root, 'ffmpeg');
  await fs.writeFile(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const stuck = new FileAssetStore(new FileProjectStore(t.config), {} as CaptureService, bin);
  const start = Date.now();
  await rejectsWithStatus(stuck.upload('medias', { name: 'a.mp4', body: [Buffer.from('not read')] }), 422, /a\.mp4/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 9_000 && elapsed < 12_000, `killed after ${elapsed} ms`);
  assert.deepEqual(await fs.readdir(path.join(dir, 'assets')), ['refs']);
});

test('limits, counted as the body streams: 500 MiB for videos, 10 MiB for Lottie, 50 MB for the rest', async () => {
  await rejectsWithStatus(assets.upload('medias', { name: 'anim.json', body: endless() }), 413, /10/);
  assert.equal(pulled, 10);
  await rejectsWithStatus(assets.upload('medias', { name: 'gros.png', body: endless() }), 413, /50/);
  assert.equal(pulled, 50);
  await rejectsWithStatus(assets.upload('medias', { name: 'long.mp4', body: endless() }), 413, /500/);
  assert.equal(pulled, 500);
  assert.deepEqual(await fs.readdir(path.join(dir, 'assets')), ['refs']);
});

test('an upload goes to disk as it streams, under a hidden name list() skips until it is checked', async () => {
  // Another upload, received and now being probed: a whole file under its hidden name.
  await fs.writeFile(path.join(dir, 'assets', '.upload-probed.mp4'), PNG);
  const onDisk: number[] = [];
  async function* body() {
    yield PNG;
    const names = (await fs.readdir(path.join(dir, 'assets'))).filter((n) => n.startsWith('.upload-') && n.endsWith('.tmp'));
    for (const name of names) onDisk.push((await fs.stat(path.join(dir, 'assets', name))).size);
    assert.deepEqual(await assets.list('medias'), []);
    yield PNG;
  }
  assert.equal((await assets.upload('medias', { name: 'a.png', body: body() })).size, 2 * PNG.length);
  assert.deepEqual(onDisk, [PNG.length]);
  assert.deepEqual(
    (await assets.list('medias')).map((a) => a.path),
    ['a.png'],
  );
});

test('a project keeps 1536 MiB of assets at most, so its export fits the 2048 MB import', async () => {
  // Sparse: the size list() reads without writing 1.5 GiB.
  const clip = path.join(dir, 'assets', 'clip.mp4');
  await fs.writeFile(clip, '');
  await fs.truncate(clip, 1536 * MiB - 2 * PNG.length);
  assert.equal((await assets.upload('medias', { name: 'a.png', body: [PNG] })).path, 'a.png');
  await rejectsWithStatus(assets.upload('medias', { name: 'b.png', body: [PNG, PNG] }), 413, /b\.png.*1536/);
  await rejectsWithStatus(assets.upload('medias', { name: 'c.png', body: endless() }), 413, /1536/);
  assert.equal(pulled, 0);
  assert.deepEqual((await fs.readdir(path.join(dir, 'assets'))).sort(), ['a.png', 'clip.mp4', 'refs']);
  // Room for one more PNG: of two uploads streaming side by side, the second to take its name is refused.
  const both = await Promise.allSettled([
    assets.upload('medias', { name: 'd.png', body: [PNG] }),
    assets.upload('medias', { name: 'e.png', body: [PNG] }),
  ]);
  const refused = both.filter((r) => r.status === 'rejected');
  assert.equal(refused.length, 1);
  assert.equal((refused[0].reason as { status: number }).status, 413);
  assert.equal((await fs.readdir(path.join(dir, 'assets'))).length, 4);
});

test('.json is accepted only as a Lottie animation whose images are embedded', async () => {
  const upload = (value: unknown, name = 'anim.json') =>
    assets.upload('medias', { name, body: [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))] });
  const embedded = {
    ...LOTTIE,
    assets: [
      { id: 'img_0', w: 10, h: 10, u: '', p: 'data:image/png;base64,iVBORw0KGgo=', e: 1 },
      { id: 'comp_0', layers: [] },
    ],
  };
  assert.equal((await upload(LOTTIE, 'Intro Logo.json')).path, 'intro-logo.json');
  assert.equal((await upload(embedded)).path, 'anim.json');

  for (const key of ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers']) {
    await rejectsWithStatus(upload({ ...LOTTIE, [key]: undefined }), 422, /Lottie/);
  }
  await rejectsWithStatus(upload({ ...LOTTIE, fr: '30' }), 422, /Lottie/);
  await rejectsWithStatus(upload({ ...LOTTIE, layers: {} }), 422, /Lottie/);
  await rejectsWithStatus(upload({ ...LOTTIE, assets: {} }), 422, /Lottie/);
  await rejectsWithStatus(upload([LOTTIE]), 422, /Lottie/);
  await rejectsWithStatus(upload('null'), 422, /Lottie/);
  await rejectsWithStatus(upload({ ...LOTTIE, assets: [null] }), 422, /Lottie/);
  await rejectsWithStatus(upload('{"v": "5.12.2",'), 422, /Lottie/);
  await rejectsWithStatus(upload({ ...LOTTIE, assets: [{ id: 'img_0', u: 'images/', p: 'img_0.png' }] }), 422, /img_0\.png/);
  await rejectsWithStatus(upload({ ...LOTTIE, assets: [{ id: 'img_0', u: '', p: 'https://x.test/a.png' }] }), 422, /x\.test/);
  // lottie-web keeps p as is only with e: 1 or an empty u; otherwise it fetches u + p.
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
  await rejectsWithStatus(
    upload({ ...LOTTIE, assets: [{ id: 'img_0', u: 'https://cdn.test/', p: dataUri, e: 0 }] }),
    422,
    /cdn\.test/,
  );
  await rejectsWithStatus(upload({ ...LOTTIE, assets: [{ id: 'img_0', u: 'https://cdn.test/', p: dataUri }] }), 422, /cdn\.test/);
  await rejectsWithStatus(upload({ ...LOTTIE, assets: [{ id: 'img_0', u: '', p: 5 }] }), 422, /\(5\)/);
  assert.equal((await upload({ ...LOTTIE, assets: [{ id: 'img_0', u: 'images/', p: dataUri, e: 1 }] }, 'e.json')).path, 'e.json');
  assert.equal((await upload({ ...LOTTIE, assets: [{ id: 'img_0', u: '', p: dataUri }] }, 'no-e.json')).path, 'no-e.json');
  const font = { fName: 'Inter', fFamily: 'Inter', fStyle: 'Regular', ascent: 72 };
  assert.equal((await upload({ ...LOTTIE, fonts: { list: [{ ...font, fPath: '' }] } }, 'font.json')).path, 'font.json');
  await rejectsWithStatus(
    upload({ ...LOTTIE, fonts: { list: [{ ...font, fOrigin: 'g', fPath: 'https://fonts.test/css?family=Inter' }] } }),
    422,
    /fonts\.test/,
  );
  await rejectsWithStatus(upload({ ...LOTTIE, fonts: { list: { length: 1, 0: { ...font, fPath: 'x' } } } }), 422, /Lottie/);
  assert.deepEqual((await fs.readdir(path.join(dir, 'assets'))).sort(), [
    'anim.json',
    'e.json',
    'font.json',
    'intro-logo.json',
    'no-e.json',
    'refs',
  ]);
});

test('assets/ swapped for a link: the upload is refused and nothing lands where the link leads', async () => {
  const outside = await fs.mkdtemp(path.join(t.root, 'outside-'));
  await fs.rm(path.join(dir, 'assets'), { recursive: true });
  await fs.symlink(outside, path.join(dir, 'assets'));
  await assert.rejects(assets.upload('medias', { name: 'logo.png', body: [PNG] }));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('assets/ swapped for a link while ffmpeg reads the clip: the checked file never moves through it', async () => {
  const outside = await fs.mkdtemp(path.join(t.root, 'outside-'));
  const base = path.join(dir, 'assets');
  const gif = `Input #0, gif, from 'a.gif':\n  Duration: 00:00:01.00, start: 0.000000, bitrate: 88 kb/s\n  Stream #0:0: Video: gif, bgra, 100x80, 10 fps, 10 tbr, 100 tbn\n`;
  await fs.writeFile(path.join(t.root, 'stderr.txt'), gif);
  const bin = path.join(t.root, 'ffmpeg');
  const swap = `/bin/mv "${base}" "${outside}/assets" && /bin/ln -s "${outside}/assets" "${base}"`;
  await fs.writeFile(bin, `#!/bin/sh\n${swap}\n/bin/cat "${t.root}/stderr.txt" >&2\nexit 1\n`, { mode: 0o755 });
  const swapping = new FileAssetStore(new FileProjectStore(t.config), {} as CaptureService, bin);
  await assert.rejects(swapping.upload('medias', { name: 'loader.gif', body: [Buffer.from('GIF89a')] }));
  assert.ok((await fs.lstat(base)).isSymbolicLink(), 'the fake ffmpeg swapped assets/');
  assert.deepEqual(
    (await fs.readdir(path.join(outside, 'assets'))).filter((n) => !n.startsWith('.')),
    ['refs'],
  );
});
