import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { type FfmpegRun, JpegSplitter, LocalClipService } from '../../server/clips/service';
import type { Hub } from '../../server/contracts';
import { FileAssetStore } from '../../server/store/assets';
import { m } from '../../server/i18n';
import { FileProjectStore } from '../../server/store/projects';
import type { ClipState, ServerEvent } from '../../src/shared/types';
import { hasFfmpeg } from '../music/synth';
import { makeRoot } from './helpers';

/** A JPEG ffmpeg could print: SOI, SOF0 with the size, SOS, entropy data with a stuffed 0xFF00 and an RST marker, EOI. */
function jpeg(width = 320, height = 240, body = Buffer.from([1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4, 0xff, 0xff, 0x00])): Buffer {
  const sof = [0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0];
  const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0xaa, 0xbb, ...sof, ...sos]),
    body,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function probeText({ fps = 30, duration = '00:00:02.00', audio = true, size = '320x240' } = {}): string {
  return [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/dev/fd/3':",
    `  Duration: ${duration}, start: 0.000000, bitrate: 151 kb/s`,
    `  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), ${size}, 100 kb/s, ${fps} fps, ${fps} tbr, 15360 tbn (default)`,
    ...(audio ? ['  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, mono, fltp, 69 kb/s (default)'] : []),
    '',
  ].join('\n');
}

interface Run extends FfmpegRun {
  args: string[];
  input: FileHandle;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  finish(code: number | null): void;
}

/** ffmpeg stand-in: answers each probe with `probing` (`probe` on stderr), and each extraction with `extract` (three frames). */
function fakeFfmpeg() {
  const runs: Run[] = [];
  const fake = {
    runs,
    probe: probeText(),
    probing: async (run: Run) => {
      run.stderr.write(fake.probe);
      run.finish(1);
    },
    extract: async (run: Run) => {
      const frames = Buffer.concat([jpeg(), jpeg(), jpeg()]);
      // The last frame arrives in two chunks.
      run.stdout.write(frames.subarray(0, frames.length - 5));
      run.stdout.write(frames.subarray(frames.length - 5));
      run.finish(0);
    },
    extracts: () => runs.filter((run) => run.args.at(-1) === 'pipe:1'),
    running: () => fake.extracts().filter((run) => !run.stdout.writableEnded).length,
    run: (args: string[], input: FileHandle): FfmpegRun => {
      let settle: (code: number | null) => void = () => undefined;
      const run: Run = {
        args,
        input,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        exit: new Promise((resolve) => (settle = resolve)),
        kill: () => {
          run.killed = true;
          run.finish(null);
        },
        finish: (code) => {
          if (run.stdout.writableEnded) return;
          run.stdout.end();
          run.stderr.end();
          settle(code);
        },
      };
      runs.push(run);
      void (args.at(-1) === 'pipe:1' ? fake.extract(run) : fake.probing(run));
      return run;
    },
  };
  return fake;
}

/** Resolves once `fn` holds; fails after 5 s. setImmediate: some tests mock setTimeout. */
async function until(fn: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await fn())) {
    if (Date.now() > deadline) assert.fail('condition never held');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function gate(): { wait: Promise<void>; open(): void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** clips/<key>/ as another server sharing projects/ leaves it once done. */
async function preparedElsewhere(dir: string, key: string): Promise<void> {
  const folder = path.join(dir, 'clips', key);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '000001.jpg'), jpeg());
  const info = { fps: 30, frames: 1, width: 320, height: 240, duration: 2, audio: true };
  await fs.writeFile(path.join(folder, 'clip.json'), JSON.stringify(info));
}

type Statfs = { bavail: number; bsize: number; files: number; ffree: number };
const roomy: Statfs = { bavail: 1e9, bsize: 4096, files: 1e7, ffree: 1e7 };

async function setup(t: TestContext, budget?: { frames: number; bytes: number }, statfs?: (dir: string) => Promise<Statfs>) {
  const fake = fakeFfmpeg();
  const root = await makeRoot();
  t.after(root.cleanup);
  const store = new FileProjectStore(root.config);
  const events: ServerEvent[] = [];
  const hub: Hub = { send: (e) => void events.push(e), handleSse: () => undefined };
  const clips = new LocalClipService({
    config: root.config,
    store,
    hub,
    ffmpeg: fake.run,
    budget,
    statfs: statfs ?? (async () => roomy),
  });
  store.setClipsProvider((id) => clips.sync(id));
  const create = async (name: string) => (await store.create({ name, brand: null, formats: ['16:9'], fps: 60 })).id;
  const id = await create('Clips');
  const dir = store.dir(id);
  const put = async (rel: string, content = 'video', projectDir = dir) => {
    const file = path.join(projectDir, 'assets', rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const ls = async (rel = 'clips') => (await fs.readdir(path.join(dir, rel)).catch(() => [] as string[])).sort();
  const ready = (state: ClipState | undefined) => {
    assert.ok(state?.status === 'ready', JSON.stringify(state));
    return state;
  };
  return { root, store, clips, hub, events, fake, id, dir, put, ls, create, ready };
}

describe('JpegSplitter', () => {
  const frames = [jpeg(320, 240), jpeg(16, 8, Buffer.from([0xff, 0x00, 0xff, 0xd7, 9])), jpeg(2, 2, Buffer.alloc(0))];
  const stream = Buffer.concat(frames);

  test('splits several frames that arrive in one chunk', () => {
    assert.deepEqual(new JpegSplitter().push(stream), frames);
  });

  test('joins a frame whose bytes arrive one at a time, through stuffed bytes and RST markers', () => {
    const splitter = new JpegSplitter();
    const out: Buffer[] = [];
    for (const byte of stream) out.push(...splitter.push(Buffer.from([byte])));
    assert.deepEqual(out, frames);
  });

  test('keeps a stuffed 0xFF00 and an RST marker inside the frame', () => {
    const frame = jpeg(4, 4, Buffer.from([0xff, 0x00, 0xff, 0xd6, 0xff, 0x00]));
    assert.deepEqual(new JpegSplitter().push(Buffer.concat([frame, frame])), [frame, frame]);
  });

  test('refuses bytes that are not a JPEG stream', () => {
    assert.throws(() => new JpegSplitter().push(Buffer.from('not a jpeg')));
  });
});

describe('clip frame cache', () => {
  test('extracts a video into clips/<key>/ with clip.json, and ProjectState.clips reports it ready', async (t) => {
    const s = await setup(t);
    await s.put('intro.mp4');
    assert.deepEqual((await s.store.get(s.id)).clips, { 'intro.mp4': { status: 'preparing' } });
    await s.clips.whenIdle(s.id);

    const state = s.ready((await s.store.get(s.id)).clips['intro.mp4']);
    assert.match(state.key, /^intro-[0-9a-f]{12}$/);
    assert.deepEqual(state, {
      status: 'ready',
      key: state.key,
      fps: 30,
      frames: 3,
      width: 320,
      height: 240,
      duration: 0.1,
      audio: true,
    });
    assert.deepEqual(await s.ls(), [state.key]);
    assert.deepEqual(await s.ls(`clips/${state.key}`), ['000001.jpg', '000002.jpg', '000003.jpg', 'clip.json']);
    assert.deepEqual(await fs.readFile(path.join(s.dir, 'clips', state.key, '000003.jpg')), jpeg());
    const info = JSON.parse(await fs.readFile(path.join(s.dir, 'clips', state.key, 'clip.json'), 'utf8'));
    assert.deepEqual(info, { fps: 30, frames: 3, width: 320, height: 240, duration: 0.1, audio: true });

    const [probe, extract] = s.fake.runs.map((run) => run.args);
    assert.deepEqual(probe, ['-hide_banner', '-protocol_whitelist', 'file', '-f', 'mov', '-i', '/dev/fd/3']);
    assert.deepEqual(extract, [
      ...probe,
      '-an',
      '-vf',
      "fps=30,scale=w='min(iw,3840)':h='min(ih,3840)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-q:v',
      '3',
      'pipe:1',
    ]);
  });

  test('frames go to <key>.<id>.part and clip.json comes last, then the folder takes its name', async (t) => {
    const s = await setup(t);
    const hold = gate();
    s.fake.extract = async (run) => {
      run.stdout.write(Buffer.concat([jpeg(), jpeg()]));
      await hold.wait;
      run.finish(0);
    };
    await s.put('intro.mp4');
    await s.clips.sync(s.id);
    await until(async () => (await s.ls(`clips/${(await s.ls())[0]}`)).join() === '000001.jpg,000002.jpg');
    const [part] = await s.ls();
    assert.match(part, /^intro-[0-9a-f]{12}\.[0-9a-f]{8}\.part$/);
    assert.deepEqual(await s.ls(`clips/${part}`), ['000001.jpg', '000002.jpg']);
    hold.open();
    await s.clips.whenIdle(s.id);
    assert.deepEqual(await s.ls(), [part.split('.')[0]]);
  });

  test('an extraction another server sharing projects/ finished first keeps that folder and drops its own .part', async (t) => {
    const s = await setup(t);
    const hold = gate();
    s.fake.extract = async (run) => {
      run.stdout.write(jpeg(100, 50));
      await hold.wait;
      run.finish(0);
    };
    await s.put('intro.mp4');
    await s.clips.sync(s.id);
    await until(async () => (await s.ls()).length === 1);
    const key = (await s.ls())[0].split('.')[0];
    await preparedElsewhere(s.dir, key);
    hold.open();
    await s.clips.whenIdle(s.id);
    assert.deepEqual(await s.ls(), [key]);
    assert.deepEqual(await fs.readFile(path.join(s.dir, 'clips', key, '000001.jpg')), jpeg());
    assert.equal(s.ready((await s.store.get(s.id)).clips['intro.mp4']).width, 320);
  });

  test('frames another server prepared beat a failure here', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    const hold = gate();
    s.fake.extract = async (run) => {
      run.stdout.write(jpeg());
      await hold.wait;
      run.finish(1);
    };
    await s.put('intro.mp4');
    await s.clips.sync(s.id);
    await until(async () => (await s.ls()).length === 1);
    const key = (await s.ls())[0].split('.')[0];
    hold.open();
    await s.clips.whenIdle(s.id);
    assert.equal((await s.store.get(s.id)).clips['intro.mp4']?.status, 'error');
    await preparedElsewhere(s.dir, key);
    assert.equal(s.ready((await s.store.get(s.id)).clips['intro.mp4']).key, key);
    assert.equal(s.fake.extracts().length, 1);
  });

  test('caps the frame rate at 60 and takes the output size from the frames', async (t) => {
    const s = await setup(t);
    s.fake.probe = probeText({ fps: 120, size: '7680x4320', audio: false });
    s.fake.extract = async (run) => {
      run.stdout.write(jpeg(3840, 2160));
      run.finish(0);
    };
    await s.put('wide.mov');
    await s.clips.whenIdle(s.id);
    assert.equal(
      s.fake.extracts()[0].args[s.fake.extracts()[0].args.indexOf('-vf') + 1],
      "fps=60,scale=w='min(iw,3840)':h='min(ih,3840)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    );
    const state = s.ready((await s.store.get(s.id)).clips['wide.mov']);
    assert.deepEqual([state.fps, state.width, state.height, state.audio], [60, 3840, 2160, false]);
  });

  test('a GIF in a subfolder is prepared with the gif demuxer and lasts frames / fps, timed or not', async (t) => {
    const s = await setup(t);
    s.fake.probe = probeText({ fps: 10, duration: 'N/A', audio: false, size: '100x80' });
    s.fake.extract = async (run) => {
      run.stdout.write(Buffer.concat([jpeg(100, 80), jpeg(100, 80), jpeg(100, 80), jpeg(100, 80), jpeg(100, 80)]));
      run.finish(0);
    };
    await s.put('refs/loop.gif');
    await s.put('logo.png', 'png');
    await s.clips.whenIdle(s.id);
    const { clips } = await s.store.get(s.id);
    assert.deepEqual(Object.keys(clips), ['refs/loop.gif']);
    const state = s.ready(clips['refs/loop.gif']);
    assert.deepEqual([state.fps, state.frames, state.duration], [10, 5, 0.5]);
    assert.equal(s.fake.runs[0].args[s.fake.runs[0].args.indexOf('-f') + 1], 'gif');
  });

  test('a second request for the same asset joins the running extraction', async (t) => {
    const s = await setup(t);
    await s.put('intro.mp4');
    await Promise.all([s.clips.sync(s.id), s.clips.sync(s.id), s.store.get(s.id), s.clips.whenIdle(s.id)]);
    await s.clips.whenIdle(s.id);
    assert.equal(s.fake.extracts().length, 1);
  });

  test('one ffmpeg runs at a time, across projects', async (t) => {
    const s = await setup(t);
    const hold = gate();
    let most = 0;
    s.fake.extract = async (run) => {
      most = Math.max(most, s.fake.running());
      run.stdout.write(jpeg());
      await hold.wait;
      run.finish(0);
    };
    const other = await s.create('Autre');
    await s.put('a.mp4');
    await s.put('b.webm', 'video', s.store.dir(other));
    await Promise.all([s.clips.sync(s.id), s.clips.sync(other)]);
    await until(() => s.fake.extracts().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(s.fake.extracts().length, 1);
    hold.open();
    await Promise.all([s.clips.whenIdle(s.id), s.clips.whenIdle(other)]);
    assert.equal(s.fake.extracts().length, 2);
    assert.equal(most, 1);
    const demuxers = s.fake.extracts().map(({ args }) => args[args.indexOf('-f') + 1]);
    assert.deepEqual(demuxers.sort(), ['matroska', 'mov']);
  });

  test('sends project-changed when a clip starts preparing and when it is ready, never per frame', async (t) => {
    const s = await setup(t);
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    const changed = s.events.filter((e) => e.type === 'project-changed' && e.projectId === s.id);
    assert.equal(changed.length, 2);
  });

  test('start() prepares the assets of every project, and assets-changed prepares new ones', async (t) => {
    const s = await setup(t);
    const other = await s.create('Autre');
    await s.put('a.mp4');
    await s.put('b.mp4', 'video', s.store.dir(other));
    s.clips.start();
    await until(() => s.fake.extracts().length === 2);
    await s.clips.whenIdle(s.id);
    await s.put('c.mp4');
    s.store.events.emit('assets-changed', s.id);
    await until(() => s.fake.extracts().length === 3);
    await s.clips.whenIdle(s.id);
    assert.equal(Object.keys((await s.store.get(s.id)).clips).length, 2);
  });

  test('an upload prepares the new clip', async (t) => {
    const s = await setup(t);
    const ffmpeg = path.join(s.root.root, 'fake-ffmpeg.sh');
    await fs.writeFile(ffmpeg, `#!/bin/sh\nprintf '%s' "${probeText().replaceAll("'", '')}" >&2\nexit 1\n`, { mode: 0o755 });
    const assets = new FileAssetStore(s.store, null as never, ffmpeg);
    s.clips.start();
    await assets.upload(s.id, { name: 'Intro.mp4', body: [Buffer.from('video')] });
    await until(() => s.fake.extracts().length === 1);
    await s.clips.whenIdle(s.id);
    assert.equal((await s.store.get(s.id)).clips['intro.mp4']?.status, 'ready');
  });

  test('a replaced asset gets a new key and its old folder is removed; a deleted one loses its folder', async (t) => {
    const s = await setup(t);
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    const first = s.ready((await s.store.get(s.id)).clips['intro.mp4']).key;
    await s.put('intro.mp4', 'another video');
    await s.clips.whenIdle(s.id);
    const second = s.ready((await s.store.get(s.id)).clips['intro.mp4']).key;
    assert.notEqual(second, first);
    assert.deepEqual(await s.ls(), [second]);

    await fs.rm(path.join(s.dir, 'assets', 'intro.mp4'));
    assert.deepEqual((await s.store.get(s.id)).clips, {});
    assert.deepEqual(await s.ls(), []);
  });

  test('an asset replaced during its extraction is prepared again and the stale result dropped', async (t) => {
    const s = await setup(t);
    const hold = gate();
    s.fake.extract = async (run) => {
      run.stdout.write(jpeg());
      if (s.fake.extracts().length === 1) await hold.wait;
      run.finish(0);
    };
    await s.put('intro.mp4');
    await s.clips.sync(s.id);
    await until(() => s.fake.extracts().length === 1);
    await s.put('intro.mp4', 'another video');
    hold.open();
    await s.clips.whenIdle(s.id);
    assert.equal(s.fake.extracts().length, 2);
    const left = await s.ls();
    const { key } = s.ready((await s.store.get(s.id)).clips['intro.mp4']);
    assert.deepEqual(left, [key]);
  });

  test('a .part with no new frame for 2 min and folders of gone assets are removed, other names are left', async (t) => {
    const s = await setup(t);
    const part = async (name: string, age: number) => {
      const folder = path.join(s.dir, 'clips', name);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, '000001.jpg'), jpeg());
      const time = new Date(Date.now() - age);
      await fs.utimes(folder, time, time);
    };
    await part('intro-0123456789ab.0123abcd.part', 121_000);
    // Another server sharing projects/ is still writing this one.
    await part('intro-0123456789ab.89abcdef.part', 100_000);
    await fs.mkdir(path.join(s.dir, 'clips', 'gone-0123456789ab'));
    await fs.mkdir(path.join(s.dir, 'clips', 'notes'));
    s.clips.start();
    await until(async () => (await s.ls()).length === 2);
    assert.deepEqual(await s.ls(), ['intro-0123456789ab.89abcdef.part', 'notes']);
    await part('intro-0123456789ab.89abcdef.part', 121_000);
    await s.clips.sync(s.id);
    assert.deepEqual(await s.ls(), ['notes']);
  });

  test('an assets folder that is a link is not listed: what it leads to is never prepared', async (t) => {
    const s = await setup(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, 'intro.mp4'), 'video');
    await fs.rm(path.join(s.dir, 'assets'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(s.dir, 'assets'));
    assert.deepEqual((await s.store.get(s.id)).clips, {});
    await s.clips.whenIdle(s.id);
    assert.equal(s.fake.runs.length, 0);
  });

  test('a failed extraction reports the last ffmpeg line, leaves no .part and is not retried on the same file', async (t) => {
    const s = await setup(t);
    const warn = t.mock.method(console, 'warn', () => undefined);
    s.fake.extract = async (run) => {
      run.stdout.write(jpeg());
      run.stderr.write('frame=    1\n/dev/fd/3: Invalid data found when processing input\n\n');
      run.finish(1);
    };
    await s.put('broken.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['broken.mp4'], {
      status: 'error',
      error: '/dev/fd/3: Invalid data found when processing input',
    });
    assert.deepEqual(await s.ls(), []);
    assert.equal(warn.mock.callCount(), 1);
    await s.clips.whenIdle(s.id);
    await s.store.get(s.id);
    assert.equal(s.fake.extracts().length, 1);
  });

  test('a file ffmpeg cannot probe is an error', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    s.fake.probe = 'garbage\n';
    await s.put('fake.mp4');
    await s.clips.whenIdle(s.id);
    assert.equal((await s.store.get(s.id)).clips['fake.mp4']?.status, 'error');
    assert.equal(s.fake.extracts().length, 0);
  });

  test('an extraction with no frame for 60 s is stopped and reported', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    s.fake.extract = async () => undefined;
    await s.put('slow.mp4');
    await s.clips.sync(s.id);
    await until(() => s.fake.extracts().length === 1);
    t.mock.timers.tick(59_000);
    assert.equal(s.fake.extracts()[0].killed, false);
    t.mock.timers.tick(1_000);
    assert.equal(s.fake.extracts()[0].killed, true);
    await s.clips.whenIdle(s.id);
    const state = (await s.store.get(s.id)).clips['slow.mp4'];
    assert.deepEqual(state, { status: 'error', error: m().media.clips.stalled('slow.mp4', 60) });
  });

  test('a probe that prints nothing for 60 s is stopped and reported, and the next clip is still prepared', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const probing = s.fake.probing;
    s.fake.probing = async () => undefined;
    await s.put('slow.mp4');
    await s.clips.sync(s.id);
    await until(() => s.fake.runs.length === 1);
    const [probe] = s.fake.runs;
    t.mock.timers.tick(59_000);
    assert.equal(probe.killed, false);
    t.mock.timers.tick(1_000);
    assert.equal(probe.killed, true);
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['slow.mp4'], {
      status: 'error',
      error: m().media.clips.stalled('slow.mp4', 60),
    });
    assert.equal(s.fake.extracts().length, 0);
    s.fake.probing = probing;
    await s.put('next.mp4');
    await s.clips.whenIdle(s.id);
    s.ready((await s.store.get(s.id)).clips['next.mp4']);
  });

  test('a clips folder that is a link leading outside the project is never written or emptied', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(path.join(outside, 'gone-0123456789ab'));
    await fs.symlink(outside, path.join(s.dir, 'clips'));
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual(await fs.readdir(outside), ['gone-0123456789ab']);
    assert.equal((await s.store.get(s.id)).clips['intro.mp4']?.status, 'error');
  });

  test('a clips folder swapped for a link during an extraction gets no more frames', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const hold = gate();
    s.fake.extract = async (run) => {
      run.stdout.write(jpeg());
      await hold.wait;
      run.stdout.write(jpeg());
      run.finish(0);
    };
    await s.put('intro.mp4');
    await s.clips.sync(s.id);
    await until(async () => (await s.ls(`clips/${(await s.ls())[0]}`)).join() === '000001.jpg');
    await fs.rename(path.join(s.dir, 'clips'), path.join(s.dir, 'moved'));
    await fs.symlink(outside, path.join(s.dir, 'clips'));
    hold.open();
    await s.clips.whenIdle(s.id);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal((await s.store.get(s.id)).clips['intro.mp4']?.status, 'error');
  });

  test('an asset swapped for a link between the probe and the extraction is never opened through the link', async (t) => {
    const s = await setup(t);
    const warn = t.mock.method(console, 'warn', () => undefined);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const secret = path.join(outside, 'secret.mp4');
    await fs.writeFile(secret, 'TOPSECRET');
    const asset = path.join(s.dir, 'assets', 'intro.mp4');
    const read: string[] = [];
    s.fake.probing = async (run) => {
      read.push(await run.input.readFile('utf8'));
      await fs.rm(asset);
      await fs.symlink(secret, asset);
      run.stderr.write(probeText());
      run.finish(1);
    };
    const extract = s.fake.extract;
    s.fake.extract = async (run) => {
      read.push(await run.input.readFile('utf8'));
      await extract(run);
    };
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual(read, ['video']);
    assert.equal(warn.mock.callCount(), 1);
    assert.ok(String(warn.mock.calls[0].arguments[0]).startsWith(m().media.clips.notPrepared('intro.mp4', '')));
    assert.equal(await fs.readFile(secret, 'utf8'), 'TOPSECRET');
    assert.deepEqual(await s.ls(), []);
  });

  test('an extraction that prints a frame every 50 s runs past 60 s, and stops 60 s after its last frame', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    s.fake.extract = async () => undefined;
    await s.put('slow.mp4');
    await s.clips.sync(s.id);
    await until(() => s.fake.extracts().length === 1);
    const [run] = s.fake.extracts();
    const frame = jpeg();
    run.stdout.write(frame.subarray(0, 2));
    for (let i = 1; i <= 3; i++) {
      run.stdout.write(frame.subarray(2));
      await until(async () => (await s.ls(`clips/${(await s.ls())[0]}`)).length === i);
      // The start of the next frame stays unread until the loop is back from writing this one, its timer armed again.
      run.stdout.write(frame.subarray(0, 2));
      await until(() => run.stdout.readableLength === 0);
      t.mock.timers.tick(i < 3 ? 50_000 : 59_000);
      assert.equal(run.killed, false, `frame ${i}`);
    }
    t.mock.timers.tick(1_000);
    assert.equal(run.killed, true);
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['slow.mp4'], {
      status: 'error',
      error: m().media.clips.stalled('slow.mp4', 60),
    });
  });

  test('ffmpeg printing bytes that are not JPEG is killed, the clip is an error and the next clip is still prepared', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    const extract = s.fake.extract;
    // The first extraction only ends when it is killed.
    s.fake.extract = async (run) => {
      if (s.fake.extracts().length > 1) return extract(run);
      run.stdout.write('not a jpeg');
    };
    await s.put('a.mp4');
    await s.put('b.mp4');
    await until(async () => (await s.clips.sync(s.id))['b.mp4']?.status === 'ready');
    assert.equal(s.fake.extracts()[0].killed, true);
    assert.deepEqual((await s.clips.sync(s.id))['a.mp4'], { status: 'error', error: m().media.clips.notJpeg });
  });

  test('a failed asset is prepared again once the file is replaced', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    const extract = s.fake.extract;
    s.fake.extract = async (run) => (s.fake.extracts().length === 1 ? run.finish(1) : extract(run));
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    assert.equal((await s.store.get(s.id)).clips['intro.mp4']?.status, 'error');
    await s.put('intro.mp4', 'another video');
    await s.clips.whenIdle(s.id);
    s.ready((await s.store.get(s.id)).clips['intro.mp4']);
    assert.equal(s.fake.extracts().length, 2);
  });

  test('a file that changed again before its turn is extracted once, under its latest key', async (t) => {
    const s = await setup(t);
    const hold = gate();
    const extract = s.fake.extract;
    s.fake.extract = async (run) => {
      if (s.fake.extracts().length === 1) await hold.wait;
      await extract(run);
    };
    await s.put('a.mp4');
    await s.clips.sync(s.id);
    await until(() => s.fake.extracts().length === 1);
    await s.put('intro.mp4', 'vid');
    await s.clips.sync(s.id);
    await s.put('intro.mp4', 'video, copied in full');
    await s.clips.sync(s.id);
    hold.open();
    await s.clips.whenIdle(s.id);
    assert.equal(s.fake.runs.length, 4);
    const { clips } = await s.store.get(s.id);
    assert.deepEqual(await s.ls(), [s.ready(clips['a.mp4']).key, s.ready(clips['intro.mp4']).key].sort());
  });

  test('a clips/<key> folder whose clip.json is missing or invalid is extracted again and replaced', async (t) => {
    const s = await setup(t);
    const rels = ['a.mp4', 'b.mp4', 'c.mp4'];
    for (const rel of rels) await s.put(rel);
    await s.clips.whenIdle(s.id);
    const { clips } = await s.store.get(s.id);
    const folder = (rel: string) => path.join(s.dir, 'clips', s.ready(clips[rel]).key);
    const info = { fps: 30, frames: 3, width: 320, height: 240, duration: 0.1, audio: true };
    await fs.writeFile(path.join(folder('a.mp4'), 'clip.json'), JSON.stringify({ ...info, audio: undefined }));
    await fs.writeFile(path.join(folder('b.mp4'), 'clip.json'), JSON.stringify({ ...info, fps: '30' }));
    await fs.rm(path.join(folder('c.mp4'), 'clip.json'));
    for (const rel of rels) await fs.writeFile(path.join(folder(rel), 'stale.jpg'), 'stale');
    await s.clips.whenIdle(s.id);
    assert.equal(s.fake.extracts().length, 6);
    const again = (await s.store.get(s.id)).clips;
    for (const rel of rels) {
      assert.equal(s.ready(again[rel]).key, s.ready(clips[rel]).key, rel);
      assert.deepEqual((await fs.readdir(folder(rel))).sort(), ['000001.jpg', '000002.jpg', '000003.jpg', 'clip.json'], rel);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder(rel), 'clip.json'), 'utf8')), info, rel);
    }
  });

  test('a file replaced with the same size but a new mtime gets a new key', async (t) => {
    const s = await setup(t);
    const file = path.join(s.dir, 'assets', 'intro.mp4');
    const keyAt = async (content: string, time: Date) => {
      await s.put('intro.mp4', content);
      await fs.utimes(file, time, time);
      await s.clips.whenIdle(s.id);
      return s.ready((await s.store.get(s.id)).clips['intro.mp4']).key;
    };
    const first = await keyAt('video', new Date('2026-01-01T10:00:00Z'));
    const second = await keyAt('VIDEO', new Date('2026-01-02T10:00:00Z'));
    assert.notEqual(second, first);
    assert.deepEqual(await s.ls(), [second]);
    assert.equal(s.fake.extracts().length, 2);
  });

  test('a video longer than the budget is refused before any frame is written', async (t) => {
    // The probe says 2 s at 30 fps: 60 frames.
    const s = await setup(t, { frames: 59, bytes: 1024 ** 3 });
    t.mock.method(console, 'warn', () => undefined);
    await s.put('long.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['long.mp4'], {
      status: 'error',
      error: m().media.clips.tooLong('long.mp4', 0),
    });
    assert.equal(s.fake.extracts().length, 0);
    assert.deepEqual(await s.ls(), []);
  });

  test('the refusal gives the minutes the frame budget holds at the clip frame rate', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    // 36 000 frames at 30 fps: 20 minutes, and this one lasts a second more.
    s.fake.probe = probeText({ fps: 30, duration: '00:20:01.00' });
    await s.put('long.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['long.mp4'], {
      status: 'error',
      error: m().media.clips.tooLong('long.mp4', 20),
    });
    assert.equal(s.fake.extracts().length, 0);
  });

  async function pastBudget(t: TestContext, budget: { frames: number; bytes: number }): Promise<void> {
    const s = await setup(t, budget);
    t.mock.method(console, 'warn', () => undefined);
    // A probe that states 1.5 frames, then three frames and an extraction that only ends when it is killed.
    s.fake.probe = probeText({ duration: '00:00:00.05' });
    s.fake.extract = async (run) => void run.stdout.write(Buffer.concat([jpeg(), jpeg(), jpeg()]));
    await s.put('long.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['long.mp4'], {
      status: 'error',
      error: m().media.clips.tooLong('long.mp4', 0),
    });
    assert.equal(s.fake.extracts()[0].killed, true);
    assert.deepEqual(await s.ls(), []);
  }

  test('an extraction past the frame budget is stopped, the clip is an error and no .part is left', { timeout: 5000 }, (t) =>
    pastBudget(t, { frames: 2, bytes: 1024 ** 3 }),
  );

  test('an extraction past the byte budget is stopped, the clip is an error and no .part is left', { timeout: 5000 }, (t) =>
    pastBudget(t, { frames: 1000, bytes: 2 * jpeg().length }),
  );

  test('a disk with less than 2 GiB free stops the extraction on its first frame, and the next clip is prepared once there is room', async (t) => {
    let free = 100;
    const s = await setup(t, undefined, async () => ({ ...roomy, bavail: free }));
    t.mock.method(console, 'warn', () => undefined);
    await s.put('full.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['full.mp4'], {
      status: 'error',
      error: m().media.clips.diskFull('full.mp4'),
    });
    assert.deepEqual(await s.ls(), []);
    free = (2 * 1024 ** 3) / 4096;
    await s.put('next.mp4');
    await s.clips.whenIdle(s.id);
    s.ready((await s.store.get(s.id)).clips['next.mp4']);
  });

  test('a disk with less than 100 000 free files stops the extraction', async (t) => {
    const s = await setup(t, undefined, async () => ({ ...roomy, files: 1e6, ffree: 99_999 }));
    t.mock.method(console, 'warn', () => undefined);
    await s.put('full.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['full.mp4'], {
      status: 'error',
      error: m().media.clips.diskFull('full.mp4'),
    });
    assert.deepEqual(await s.ls(), []);
  });

  test('a filesystem that reports no file count (btrfs, some network ones) is not refused on files', async (t) => {
    const s = await setup(t, undefined, async () => ({ ...roomy, files: 0, ffree: 0 }));
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    s.ready((await s.store.get(s.id)).clips['intro.mp4']);
  });

  test('the disk is checked again every 250 frames: one that fills up stops the extraction at frame 251', async (t) => {
    const written: number[] = [];
    const s = await setup(t, undefined, async () => {
      const [part] = await s.ls();
      written.push(part ? (await s.ls(`clips/${part}`)).length : 0);
      return written.length > 1 ? { ...roomy, bavail: 100 } : roomy;
    });
    t.mock.method(console, 'warn', () => undefined);
    s.fake.extract = async (run) => {
      run.stdout.write(Buffer.concat(Array.from({ length: 300 }, () => jpeg(2, 2, Buffer.alloc(0)))));
      run.finish(0);
    };
    await s.put('full.mp4');
    await s.clips.whenIdle(s.id);
    assert.deepEqual((await s.store.get(s.id)).clips['full.mp4'], {
      status: 'error',
      error: m().media.clips.diskFull('full.mp4'),
    });
    assert.deepEqual(written, [0, 250]);
    assert.deepEqual(await s.ls(), []);
  });

  test('a clips/<key> that is a link to a folder holding a valid clip.json is not reported ready', async (t) => {
    const s = await setup(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await s.put('intro.mp4');
    await s.clips.whenIdle(s.id);
    const { key } = s.ready((await s.store.get(s.id)).clips['intro.mp4']);
    const real = path.join(outside, key);
    await fs.rename(path.join(s.dir, 'clips', key), real);
    await fs.symlink(real, path.join(s.dir, 'clips', key));
    assert.deepEqual((await s.clips.sync(s.id))['intro.mp4'], { status: 'preparing' });
    await s.clips.whenIdle(s.id);
    assert.ok((await fs.lstat(path.join(s.dir, 'clips', key))).isDirectory());
    assert.deepEqual((await fs.readdir(real)).sort(), ['000001.jpg', '000002.jpg', '000003.jpg', 'clip.json']);
  });

  test('a video under assets/ that is a link, or in a linked subfolder, is not listed', async (t) => {
    const s = await setup(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(path.join(outside, 'refs'));
    await fs.writeFile(path.join(outside, 'intro.mp4'), 'video');
    await fs.writeFile(path.join(outside, 'refs', 'loop.gif'), 'gif');
    await s.put('real.mp4');
    await fs.symlink(path.join(outside, 'intro.mp4'), path.join(s.dir, 'assets', 'link.mp4'));
    await fs.symlink(path.join(outside, 'refs'), path.join(s.dir, 'assets', 'linked'));
    await s.clips.whenIdle(s.id);
    assert.deepEqual(Object.keys((await s.store.get(s.id)).clips), ['real.mp4']);
    assert.equal(s.fake.runs.length, 2);
  });

  test(
    'the real ffmpeg extracts a lavfi video and a GIF given as fd 3',
    { skip: !hasFfmpeg && 'ffmpeg introuvable', timeout: 60_000 },
    async (t) => {
      const s = await setup(t);
      const lavfi = (source: string, rel: string, ...args: string[]) =>
        promisify(execFile)('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          source,
          ...args,
          path.join(s.dir, 'assets', rel),
        ]);
      await fs.mkdir(path.join(s.dir, 'assets', 'loops'), { recursive: true });
      await lavfi('testsrc2=size=320x240:rate=30:duration=1', 'clip.mp4', '-pix_fmt', 'yuv420p');
      await lavfi('testsrc=size=200x100:rate=10:duration=1', 'loops/spin.gif');
      await lavfi('color=c=red:s=64x4000:r=10:d=0.2', 'tall.mp4', '-pix_fmt', 'yuv420p');
      const clips = new LocalClipService({ config: { ...s.root.config, ffmpegPath: 'ffmpeg' }, store: s.store, hub: s.hub });
      await clips.whenIdle(s.id);
      const states = await clips.sync(s.id);
      const expected = {
        'clip.mp4': { fps: 30, frames: 30, width: 320, height: 240, duration: 1, audio: false },
        'loops/spin.gif': { fps: 10, frames: 10, width: 200, height: 100, duration: 1, audio: false },
      };
      for (const [rel, want] of Object.entries(expected)) {
        const { key, fps, frames, width, height, duration, audio } = s.ready(states[rel]);
        assert.deepEqual({ fps, frames, width, height, duration, audio }, want, rel);
        const folder = path.join(s.dir, 'clips', key);
        const jpgs = (await fs.readdir(folder)).filter((name) => name.endsWith('.jpg'));
        assert.equal(jpgs.length, frames, rel);
        for (const name of [jpgs[0], jpgs.at(-1) ?? '']) {
          const bytes = await fs.readFile(path.join(folder, name));
          assert.deepEqual([...bytes.subarray(0, 2), ...bytes.subarray(-2)], [0xff, 0xd8, 0xff, 0xd9], `${rel} ${name}`);
        }
      }
      // 64 x 4000 bounded on its height: 61.44 px wide, which ffmpeg versions round to an even width either way.
      const { width, height } = s.ready(states['tall.mp4']);
      assert.equal(height, 3840);
      assert.equal(width % 2, 0);
      assert.ok(Math.abs(width - (64 * 3840) / 4000) <= 2, String(width));
    },
  );

  test('a missing ffmpeg binary marks the clip as an error with the start message', async (t) => {
    const s = await setup(t);
    t.mock.method(console, 'warn', () => undefined);
    const bin = path.join(s.root.root, 'missing-ffmpeg');
    const clips = new LocalClipService({ config: { ...s.root.config, ffmpegPath: bin }, store: s.store, hub: s.hub });
    await s.put('intro.mp4');
    await clips.whenIdle(s.id);
    assert.deepEqual((await clips.sync(s.id))['intro.mp4'], {
      status: 'error',
      error: m().media.ffmpegStart(bin, `spawn ${bin} ENOENT`),
    });
  });
});
