// FfmpegRenderService against the frame harness: MP4 length, frame count, colors, soundtrack, cancel, files.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { FfmpegRenderService } from '../../server/capture/render';
import type { ProjectStore } from '../../server/contracts';
import { HttpError } from '../../server/util';
import type { ProjectFile, ProjectState, RenderJob, ServerEvent } from '../../src/shared/types';
import {
  FixtureMusicService,
  near,
  pixel,
  RecordingHub,
  startHarness,
  type FixtureProjectStore,
  type Harness,
} from './helpers/harness';

const run = promisify(execFile);

let h: Harness;
let hub: RecordingHub;
let music: FixtureMusicService;
let renders: FfmpegRenderService;
let id: string;

before(async () => {
  h = await startHarness('render');
  hub = new RecordingHub();
  music = new FixtureMusicService();
  renders = new FfmpegRenderService({ config: h.config, store: h.store, music, hub });
  id = await h.project('render');
});

after(async () => {
  await h?.close();
});

interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    color_space?: string;
    color_transfer?: string;
    color_primaries?: string;
    nb_read_frames?: string;
    sample_rate?: string;
    duration?: string;
  }[];
  format: { duration: string };
}

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout) as Probe;
}

/** One decoded frame of the video as PNG. */
async function frameAt(file: string, t: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
    {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout;
}

async function renderOne(
  request: Parameters<FfmpegRenderService['start']>[1],
  service = renders,
): Promise<{ job: RenderJob; file: string }> {
  const [queued] = await service.start(id, request);
  const job = await service.wait(queued.id);
  assert.equal(job.status, 'done', job.error ?? job.status);
  return { job, file: service.resolveFile(id, job.file!) };
}

async function setDuration(sceneId: string, duration: number): Promise<void> {
  const file = path.join(h.store.dir(id), 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
  project.scenes.find((s) => s.id === sceneId)!.duration = duration;
  await writeFile(file, JSON.stringify(project, null, 2));
}

/** A render service whose store reads go through `onRead` (read 1: start(), read 2: the job itself). */
function renderingWith(onRead: (read: number, project: ProjectState) => Promise<ProjectState>): FfmpegRenderService {
  let reads = 0;
  const store: ProjectStore = Object.assign(Object.create(h.store) as FixtureProjectStore, {
    get: async (projectId: string) => onRead(++reads, await h.store.get(projectId)),
  });
  return new FfmpegRenderService({ config: h.config, store, music, hub });
}

describe('FfmpegRenderService', () => {
  it('renders 1.0 s at 30 fps into an H.264 BT.709 MP4 with exactly 30 frames and true colors', async () => {
    const { job, file } = await renderOne({ formats: ['16:9'], quality: 'draft' });
    assert.equal(job.framesTotal, 30);
    assert.equal(job.framesDone, 30);
    assert.equal(job.progress, 1);
    assert.match(job.file!, new RegExp(`^${id}-16x9-\\d{8}-\\d{6}\\.mp4$`));
    assert.equal(job.url, `/api/projects/${id}/renders/${job.file}`);

    const info = await probe(file);
    const video = info.streams.find((s) => s.codec_type === 'video')!;
    assert.deepEqual(
      [video.codec_name, video.width, video.height, video.pix_fmt, video.color_space],
      ['h264', 1920, 1080, 'yuv420p', 'bt709'],
    );
    assert.deepEqual([video.color_transfer, video.color_primaries], ['bt709', 'bt709'], 'tagged, not left unknown');
    assert.equal(video.nb_read_frames, '30');
    assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.05, info.format.duration);
    assert.equal(
      info.streams.some((s) => s.codec_type === 'audio'),
      false,
    );

    // Scene a (red, white box) until 0.5 s, then scene b (blue).
    assert.ok(near(pixel(await frameAt(file, 0.2), 1500, 800), [255, 0, 0], 6), 'red');
    assert.ok(near(pixel(await frameAt(file, 0.8), 1500, 800), [0, 0, 255], 6), 'blue');

    const events = hub.events.filter(
      (e): e is Extract<ServerEvent, { type: 'render' }> => e.type === 'render' && e.job.id === job.id,
    );
    assert.deepEqual([...new Set(events.map((e) => e.job.status))], ['queued', 'rendering', 'encoding', 'done']);
    const files = await renders.files(id);
    assert.equal(files[0].name, job.file);
    assert.equal(files[0].format, '16:9');
    assert.ok(files[0].size > 1000);
  });

  it('mixes the soundtrack from music.start, cut to the video length', async () => {
    const musicDir = path.join(h.store.dir(id), 'music');
    await mkdir(musicDir, { recursive: true });
    const track = path.join(musicDir, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '44100', track]);
    const projectFile = path.join(h.store.dir(id), 'project.json');
    const project = JSON.parse(await readFile(projectFile, 'utf8')) as ProjectFile;
    project.music = { file: 'music/tone.wav', start: 0.5, volume: 0.8 };
    await writeFile(projectFile, JSON.stringify(project, null, 2));
    music.audio.set(id, track);
    try {
      const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' });
      const info = await probe(file);
      const audio = info.streams.find((s) => s.codec_type === 'audio');
      assert.ok(audio, 'audio stream');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.sample_rate, '48000');
      assert.equal(info.streams.find((s) => s.codec_type === 'video')!.nb_read_frames, '30');
      assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.08, info.format.duration);
    } finally {
      project.music = null;
      await writeFile(projectFile, JSON.stringify(project, null, 2));
      music.audio.delete(id);
    }
  });

  it('renders other formats, scales and ranges with even dimensions, cropped rather than stretched', async () => {
    // 1350 × 0.5 = 675 rows: the video keeps 674 of them (twice that when supersampling), never resampled to 676.
    for (const supersample of [false, true]) {
      const { job, file } = await renderOne({
        formats: ['4:5'],
        quality: 'draft',
        scale: 0.5,
        supersample,
        range: { from: 0.4, to: 1 },
      });
      assert.deepEqual([job.width, job.height, job.framesTotal], [540, 674, 18]);
      const video = (await probe(file)).streams.find((s) => s.codec_type === 'video')!;
      assert.deepEqual([video.width, video.height, video.nb_read_frames], [540, 674, '18']);
      // The range starts in scene a, whose white box has slid to x ≈ 470-670 (canvas px): 235-335 at 0.5×.
      const start = await frameAt(file, 0.05);
      assert.ok(near(pixel(start, 290, 100), [255, 255, 255], 6), `box, supersample ${supersample}`);
      assert.ok(near(pixel(start, 100, 100), [255, 0, 0], 6), `red, supersample ${supersample}`);
      assert.ok(near(pixel(await frameAt(file, 0.3), 270, 600), [0, 0, 255], 6), `then scene b, supersample ${supersample}`);
    }
  });

  it('sizes the video from what its pages show when an edit lands as the job starts', async () => {
    // Scene b gets longer (a PATCH right after POST /renders) once the job has read the project, before its pages load it.
    const late = renderingWith(async (read, project) => {
      if (read === 2) await setDuration('b', 1);
      return project;
    });
    try {
      const { job, file } = await renderOne({ formats: ['16:9'], quality: 'draft' }, late);
      assert.equal(job.framesTotal, 45);
      assert.equal((await probe(file)).streams.find((s) => s.codec_type === 'video')!.nb_read_frames, '45');
      assert.ok(near(pixel(await frameAt(file, 1.3), 1500, 800), [0, 0, 255], 6), 'scene b to the end');
    } finally {
      await setDuration('b', 0.5);
    }

    // Pages and store that still disagree after a reload: a clear error, no video.
    const racing = renderingWith(async (read, project) => {
      if (read === 2) await setDuration('b', 1);
      return read === 3 ? { ...project, duration: 9 } : project;
    });
    try {
      const [queued] = await racing.start(id, { formats: ['16:9'], quality: 'draft' });
      const job = await racing.wait(queued.id);
      assert.equal(job.status, 'error');
      assert.equal(job.error, 'Le projet a changé pendant le lancement du rendu : relancez l’export.');
    } finally {
      await setDuration('b', 0.5);
    }
  });

  it('cancels a running render and removes the partial file', async () => {
    const [queued] = await renders.start(id, { formats: ['16:9'], quality: 'draft', fps: 120 });
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const job = renders.jobs(id).find((j) => j.id === queued.id)!;
        if (job.framesDone > 0 || job.status !== 'queued') {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    renders.cancel(queued.id);
    const job = await renders.wait(queued.id);
    assert.equal(job.status, 'cancelled');
    assert.ok(job.framesDone < job.framesTotal);
    const leftovers = (await readdir(path.join(h.store.dir(id), 'renders'))).filter((n) => n.endsWith('.part'));
    assert.deepEqual(leftovers, []);
    assert.equal(
      (await renders.files(id)).some((f) => f.name === job.file),
      false,
    );
  });

  it('removes the partial file a killed render left, never a live one', async () => {
    const dir = path.join(h.store.dir(id), 'renders');
    await mkdir(dir, { recursive: true });
    const [old, live] = [path.join(dir, 'killed-16x9.mp4.part'), path.join(dir, 'live-16x9.mp4.part')];
    await writeFile(old, 'x');
    await writeFile(live, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await renders.files(id);
    const parts = (await readdir(dir)).filter((n) => n.endsWith('.part'));
    assert.deepEqual(parts, ['live-16x9.mp4.part']);
    await rm(live);
  });

  it('moves a deleted video to the project trash, once', async () => {
    const dir = path.join(h.store.dir(id), 'renders');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'gone-16x9.mp4'), 'x');
    await renders.remove(id, 'gone-16x9.mp4');
    assert.equal(
      (await renders.files(id)).some((f) => f.name === 'gone-16x9.mp4'),
      false,
    );
    const trash = await readdir(path.join(h.store.dir(id), '.cadence', 'trash'));
    assert.ok(trash.some((name) => name.endsWith('-gone-16x9.mp4')));
    await assert.rejects(renders.remove(id, 'gone-16x9.mp4'), { status: 404 });
    await assert.rejects(renders.remove(id, '../project.json'), { status: 400 });
  });

  it('cancels queued jobs and validates requests and file names', async () => {
    const jobs = await renders.start(id, { formats: ['16:9', '1:1'], quality: 'draft' });
    renders.cancel(jobs[1].id);
    assert.equal((await renders.wait(jobs[1].id)).status, 'cancelled');
    assert.equal((await renders.wait(jobs[0].id)).status, 'done');

    const bad = (e: unknown) => e instanceof HttpError && e.status === 400;
    await assert.rejects(renders.start(id, { formats: [], quality: 'draft' }), bad);
    await assert.rejects(renders.start(id, { formats: ['3:2' as never], quality: 'draft' }), bad);
    await assert.rejects(renders.start(id, { formats: ['16:9'], quality: 'ultra' as never }), bad);
    await assert.rejects(renders.start(id, { formats: ['16:9'], quality: 'draft', scale: 3 }), bad);
    await assert.rejects(renders.start(id, { formats: ['16:9'], quality: 'draft', range: { from: 1, to: 0.5 } }), bad);
    assert.throws(
      () => renders.cancel('nope'),
      (e) => e instanceof HttpError && e.status === 404,
    );
    assert.throws(() => renders.resolveFile(id, '../project.json'), bad);
    assert.throws(() => renders.resolveFile(id, '..mp4'), bad);
    assert.equal(renders.resolveFile(id, 'a.mp4'), path.join(h.store.dir(id), 'renders', 'a.mp4'));
  });
});
