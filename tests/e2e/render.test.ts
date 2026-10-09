// FfmpegRenderService against the frame harness: MP4 length, frame count, colors, soundtrack, voice-over, sound effects,
// cancel, files.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lutimes, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { FfmpegRenderService } from '../../server/capture/render';
import type { ProjectStore } from '../../server/contracts';
import { HttpError } from '../../server/util';
import { writeWav } from '../../server/voiceover/wav';
import type { ProjectFile, ProjectState, RenderJob, ServerEvent } from '../../src/shared/types';
import {
  FixtureMusicService,
  FixtureVoiceOverService,
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
let voiceOver: FixtureVoiceOverService;
let renders: FfmpegRenderService;
let id: string;

before(async () => {
  h = await startHarness('render');
  hub = new RecordingHub();
  music = new FixtureMusicService();
  voiceOver = new FixtureVoiceOverService();
  renders = new FfmpegRenderService({ config: h.config, store: h.store, music, voiceOver, hub });
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

/** Loudness of the audio between two times, in dB (RMS). */
async function rmsDb(file: string, from: number, to: number): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-ss',
    String(from),
    '-t',
    String(to - from),
    '-i',
    file,
    '-af',
    'astats',
    '-f',
    'null',
    '-',
  ]);
  const value = /RMS level dB: (\S+)/.exec(stderr)?.[1] ?? '-inf';
  return value === '-inf' ? -Infinity : Number(value);
}

/** Highest sample of the audio, in dBFS. */
async function peakDb(file: string): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'astats', '-f', 'null', '-']);
  return Number([...stderr.matchAll(/Peak level dB: (\S+)/g)].at(-1)?.[1]);
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

/** Adds `export const sounds = () => <cues>` to scenes; the returned function puts their code back. */
async function withSounds(cues: Record<string, string>): Promise<() => Promise<void>> {
  const saved = await Promise.all(
    Object.entries(cues).map(async ([sceneId, list]) => {
      const file = h.store.sceneFile(id, sceneId);
      const code = await readFile(file, 'utf8');
      await writeFile(file, `export const sounds = () => ${list};\n${code}`);
      return [file, code] as const;
    }),
  );
  return async () => {
    await Promise.all(saved.map(([file, code]) => writeFile(file, code)));
  };
}

/** A render service whose store reads go through `onRead` (read 1: start(), read 2: the job itself). */
function renderingWith(onRead: (read: number, project: ProjectState) => Promise<ProjectState>): FfmpegRenderService {
  let reads = 0;
  const store: ProjectStore = Object.assign(Object.create(h.store) as FixtureProjectStore, {
    get: async (projectId: string) => onRead(++reads, await h.store.get(projectId)),
  });
  return new FfmpegRenderService({ config: h.config, store, music, voiceOver, hub });
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

  it('mixes the voice-over, alone or over the music, which ducks while the voice speaks', async () => {
    const dir = path.join(h.store.dir(id), 'voice-test');
    await mkdir(dir, { recursive: true });
    const tone = path.join(dir, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '44100', tone]);
    // The voice speaks from 1.0 to 1.5 s of a 3 s video.
    const voice = path.join(dir, 'voice.wav');
    const speech = new Int16Array(22050 * 2);
    speech.fill(6000, Math.round(22050 * 1.0), Math.round(22050 * 1.5));
    await writeFile(voice, writeWav({ sampleRate: 22050, samples: speech }));
    const silent = path.join(dir, 'silent.wav');
    await writeFile(silent, writeWav({ sampleRate: 22050, samples: new Int16Array(22050 * 2) }));
    const lines = [{ sceneId: 'b', text: 'Bonjour.', start: 1, end: 1.5, speaker: null, words: [], level: [] }];
    const projectFile = path.join(h.store.dir(id), 'project.json');
    const before = await readFile(projectFile, 'utf8');
    await setDuration('b', 2.5);
    try {
      voiceOver.tracks.set(id, { file: voice, lines, musicLevel: 0.3 });
      const alone = (await renderOne({ formats: ['16:9'], quality: 'draft' })).file;
      const stream = (await probe(alone)).streams.find((s) => s.codec_type === 'audio');
      assert.deepEqual([stream?.codec_name, stream?.sample_rate], ['aac', '48000']);
      assert.ok((await rmsDb(alone, 1.1, 1.4)) > -30, 'the voice is heard');
      assert.ok((await rmsDb(alone, 0.2, 0.6)) < -60, 'and only the voice');

      // A silent voice: what is left is the music, 0.3 of its level (-10.5 dB) while the voice speaks.
      const project = JSON.parse(await readFile(projectFile, 'utf8')) as ProjectFile;
      project.music = { file: 'voice-test/tone.wav', start: 0, volume: 1 };
      await writeFile(projectFile, JSON.stringify(project, null, 2));
      music.audio.set(id, tone);
      voiceOver.tracks.set(id, { file: silent, lines, musicLevel: 0.3 });
      const mixed = (await renderOne({ formats: ['16:9'], quality: 'draft' })).file;
      const full = await rmsDb(mixed, 0.2, 0.6);
      const ducked = await rmsDb(mixed, 1.1, 1.4);
      assert.ok(Math.abs(ducked - full + 10.46) < 1, `${full} dB, then ${ducked} dB under the voice`);
      assert.ok(Math.abs((await rmsDb(mixed, 1.9, 2.2)) - full) < 1, 'back up after the voice');
    } finally {
      voiceOver.tracks.delete(id);
      music.audio.delete(id);
      await writeFile(projectFile, before);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('waits for the voice-over before the pages load the project, so the scenes get its sentence times', async () => {
    // Scene a turns green once its props carry a sentence. The sentences reach the project state when sync() ends, as
    // when Piper is still speaking as the export starts.
    const sceneFile = h.store.sceneFile(id, 'a');
    const code = await readFile(sceneFile, 'utf8');
    await writeFile(
      sceneFile,
      `import type { SceneProps } from 'cadence';

export default function A({ voiceOver }: SceneProps) {
  return <div style={{ position: 'absolute', inset: 0, background: voiceOver.lines.length ? '#00ff00' : '#ff0000' }} />;
}
`,
    );
    const speaking = Object.assign(new FixtureVoiceOverService(), {
      sync: async (projectId: string) => {
        h.store.voiceOverLines.set(projectId, [
          { sceneId: 'a', text: 'Bonjour.', start: 0.1, end: 0.4, speaker: null, words: [], level: [] },
        ]);
      },
    });
    try {
      const service = new FfmpegRenderService({ config: h.config, store: h.store, music, voiceOver: speaking, hub });
      const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' }, service);
      assert.ok(near(pixel(await frameAt(file, 0.2), 1500, 800), [0, 255, 0], 6), 'green: scene a has its sentence');
    } finally {
      h.store.voiceOverLines.delete(id);
      await writeFile(sceneFile, code);
    }
  });

  it('burns the captions into the MP4 when the project has them on', async () => {
    const projectFile = path.join(h.store.dir(id), 'project.json');
    const saved = await readFile(projectFile, 'utf8');
    await writeFile(projectFile, JSON.stringify({ ...(JSON.parse(saved) as ProjectFile), captions: true }, null, 2));
    h.store.voiceOverLines.set(id, [
      { sceneId: 'a', text: 'Bonjour tout le monde.', start: 0.1, end: 0.4, speaker: null, words: [], level: [] },
    ]);
    try {
      const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' });
      // Across the middle of the caption box, which ends at the bottom of the safe area (1008 px): its dark background
      // shows between the words over the red scene.
      const row = async (t: number) => {
        const frame = await frameAt(file, t);
        return Array.from({ length: 41 }, (_, i) => pixel(frame, 760 + i * 10, 975));
      };
      assert.ok(
        (await row(0.2)).some((p) => near(p, [71, 0, 0], 20)),
        'the caption box while the sentence is said',
      );
      assert.ok(
        (await row(0.45)).every((p) => near(p, [255, 0, 0], 6)),
        'only red once it ends',
      );
    } finally {
      h.store.voiceOverLines.delete(id);
      await writeFile(projectFile, saved);
    }
  });

  it('limits a full-scale voice alone, and gives a range without any sentence no voice at all', async () => {
    const dir = path.join(h.store.dir(id), 'voice-test');
    await mkdir(dir, { recursive: true });
    const voice = path.join(dir, 'loud.wav');
    const speech = Int16Array.from({ length: 22050 }, (_, i) => Math.round(32767 * Math.sin((2 * Math.PI * 440 * i) / 22050)));
    await writeFile(voice, writeWav({ sampleRate: 22050, samples: speech }));
    try {
      voiceOver.tracks.set(id, {
        file: voice,
        lines: [{ sceneId: 'a', text: 'Bonjour.', start: 0.1, end: 0.4, speaker: null, words: [], level: [] }],
        musicLevel: 0.3,
      });
      const alone = (await renderOne({ formats: ['16:9'], quality: 'draft' })).file;
      const peak = await peakDb(alone);
      // ffmpeg 8.1: -0.33 dBFS with the limiter (0.95 is -0.45, AAC adds about 0.1 dB), 0 to +0.08 without it. The
      // threshold sits between the two, so another AAC encoder has room.
      assert.ok(peak <= -0.15, `peak ${peak} dBFS`);

      // The track still sounds after 0.5 s, but no sentence falls there: the range gets no voice input.
      const range = (await renderOne({ formats: ['16:9'], quality: 'draft', range: { from: 0.5, to: 1 } })).file;
      assert.equal(
        (await probe(range)).streams.some((s) => s.codec_type === 'audio'),
        false,
      );
    } finally {
      voiceOver.tracks.delete(id);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plays the sounds the scenes declare at their times, and gives a range without any cue no sounds at all', async () => {
    // A pop at 0.1 s in scene a (heard until about 0.35 s) and a click at 0.3 s of scene b, 0.8 s in the video.
    const restore = await withSounds({ a: "[{ at: 0.1, sound: 'pop' }]", b: "[{ at: 0.3, sound: 'click', gain: 0.8 }]" });
    try {
      const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' });
      const stream = (await probe(file)).streams.find((s) => s.codec_type === 'audio');
      assert.deepEqual([stream?.codec_name, stream?.sample_rate], ['aac', '48000']);
      const [pop, between, click] = await Promise.all([rmsDb(file, 0.08, 0.2), rmsDb(file, 0.45, 0.7), rmsDb(file, 0.78, 0.86)]);
      // ffmpeg 8.1: the click measures -36.4 dB, lowered by the fade-out it falls under; the gap between them is digital
      // silence (-inf), so -50 dB still tells a sound from none.
      assert.ok(pop > -50, `pop ${pop} dB`);
      assert.ok(click > -50, `click ${click} dB`);
      assert.ok(between < -60, `silence between them, ${between} dB`);
      assert.deepEqual(await readdir(path.join(h.store.dir(id), '.cadence', 'sounds')), [], 'the track is not kept');

      const range = (await renderOne({ formats: ['16:9'], quality: 'draft', range: { from: 0.4, to: 0.7 } })).file;
      assert.equal(
        (await probe(range)).streams.some((s) => s.codec_type === 'audio'),
        false,
      );
    } finally {
      await restore();
    }
  });

  it('fails the render with the message of the frame when a scene declares an invalid cue', async () => {
    // Scene a's cue still gets a track written: the failed render removes it too.
    const restore = await withSounds({ a: "[{ at: 0.1, sound: 'pop' }]", b: "[{ at: 0.1, sound: 'boing' }]" });
    try {
      const [queued] = await renders.start(id, { formats: ['16:9'], quality: 'draft' });
      const job = await renders.wait(queued.id);
      assert.equal(job.status, 'error');
      assert.match(job.error!, /Erreur dans sounds\(\) \u00b7 scenes\/b\.tsx\nson 0 : son inconnu "boing"/);
      assert.deepEqual(await readdir(path.join(h.store.dir(id), '.cadence', 'sounds')), []);
    } finally {
      await restore();
    }
  });

  it('keeps sounds over the music, the voice or both under the limiter ceiling', async () => {
    const dir = path.join(h.store.dir(id), 'sounds-test');
    await mkdir(dir, { recursive: true });
    const tone = path.join(dir, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '44100', tone]);
    const voice = path.join(dir, 'loud.wav');
    const speech = Int16Array.from({ length: 22050 }, (_, i) => Math.round(32767 * Math.sin((2 * Math.PI * 440 * i) / 22050)));
    await writeFile(voice, writeWav({ sampleRate: 22050, samples: speech }));
    const projectFile = path.join(h.store.dir(id), 'project.json');
    const saved = await readFile(projectFile, 'utf8');
    const restore = await withSounds({ a: "[{ at: 0.2, sound: 'impact' }, { at: 0.25, sound: 'impact' }]" });
    try {
      for (const mix of [['music'], ['voice'], ['music', 'voice']]) {
        const project = JSON.parse(saved) as ProjectFile;
        project.music = mix.includes('music') ? { file: 'sounds-test/tone.wav', start: 0, volume: 1 } : null;
        await writeFile(projectFile, JSON.stringify(project, null, 2));
        if (mix.includes('music')) music.audio.set(id, tone);
        else music.audio.delete(id);
        if (mix.includes('voice')) {
          voiceOver.tracks.set(id, {
            file: voice,
            lines: [{ sceneId: 'a', text: 'Bonjour.', start: 0.1, end: 0.4, speaker: null, words: [], level: [] }],
            musicLevel: 0.3,
          });
        } else voiceOver.tracks.delete(id);
        const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' });
        const peak = await peakDb(file);
        // ffmpeg 8.1, with the limiter then without it: music + sounds -0.283 / +0.75 dBFS, voice + sounds -0.190 / +4.44,
        // music + voice + sounds -0.236 / +3.98. AAC adds up to 0.26 dB over the limiter's -0.45: 0 dBFS is the line.
        assert.ok(peak < 0, `${mix.join(' + ')} + sounds: peak ${peak} dBFS`);
      }
    } finally {
      voiceOver.tracks.delete(id);
      music.audio.delete(id);
      await writeFile(projectFile, saved);
      await restore();
      await rm(dir, { recursive: true, force: true });
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

  it('removes the sounds track and temporary file a killed render left, never a live one', async () => {
    const dir = path.join(h.store.dir(id), '.cadence', 'sounds');
    await mkdir(dir, { recursive: true });
    const killed = ['0f6e3a52-58c4-4b8e-9d0b-6f1f4c2a7e11.wav', '0f6e3a52-58c4-4b8e-9d0b-6f1f4c2a7e11.wav.123.0a1b2c3d.tmp'];
    const live = '5b2d9c40-1e7a-4f3b-8c6d-2a9e8f7b3c55.wav';
    for (const name of [...killed, live]) await writeFile(path.join(dir, name), 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    for (const name of killed) await utimes(path.join(dir, name), twoHoursAgo, twoHoursAgo);
    await renders.files(id);
    assert.deepEqual(await readdir(dir), [live]);
    await rm(path.join(dir, live));
  });

  it('leaves the links, folders and files no render wrote, however old, and still lists the videos', async () => {
    const project = h.store.dir(id);
    const sounds = path.join(project, '.cadence', 'sounds');
    const elsewhere = path.join(project, 'sweep-test');
    await mkdir(sounds, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    const foreign = path.join(elsewhere, 'kept.wav');
    await writeFile(foreign, 'x');
    const kept = {
      file: path.join(sounds, 'notes.wav'),
      folder: path.join(sounds, '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f.wav'),
      link: path.join(sounds, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.wav'),
      part: path.join(project, 'renders', 'folder-16x9.mp4.part'),
    };
    await writeFile(kept.file, 'x');
    await mkdir(kept.folder);
    await mkdir(kept.part, { recursive: true });
    await symlink(foreign, kept.link);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    for (const file of [foreign, kept.file, kept.folder, kept.part]) await utimes(file, twoHoursAgo, twoHoursAgo);
    await lutimes(kept.link, twoHoursAgo, twoHoursAgo);
    try {
      await renders.files(id);
      assert.deepEqual((await readdir(sounds)).sort(), [kept.folder, kept.link, kept.file].map((f) => path.basename(f)).sort());
      assert.ok((await readdir(path.join(project, 'renders'))).includes('folder-16x9.mp4.part'));
      assert.deepEqual(await readdir(elsewhere), ['kept.wav']);
    } finally {
      for (const file of [...Object.values(kept), elsewhere]) await rm(file, { recursive: true, force: true });
    }
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
