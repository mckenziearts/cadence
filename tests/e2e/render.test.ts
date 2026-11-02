// FfmpegRenderService against the frame harness: MP4 length, frame count, colors, soundtrack, voice-over, sound effects,
// cancel, files; transparent ProRes and WebM, GIF, still PNG and PNG sequence.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, lutimes, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { outputSupport } from '../../server/capture/encoders';
import { FfmpegRenderService } from '../../server/capture/render';
import type { CadenceConfig, ProjectStore } from '../../server/contracts';
import { createFrameHandler } from '../../server/frames/frameServer';
import { HttpError } from '../../server/util';
import { writeWav } from '../../server/voiceover/wav';
import type { ProjectFile, ProjectState, RenderJob, ServerEvent } from '../../src/shared/types';
import {
  FixtureClipService,
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
const clips = new FixtureClipService();
let music: FixtureMusicService;
let voiceOver: FixtureVoiceOverService;
let renders: FfmpegRenderService;
let id: string;

before(async () => {
  h = await startHarness('render');
  hub = new RecordingHub();
  music = new FixtureMusicService();
  voiceOver = new FixtureVoiceOverService();
  renders = new FfmpegRenderService({ config: h.config, store: h.store, music, clips, voiceOver, hub });
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

/** One pixel of a decoded frame with its alpha; `decoder` forces one (ffmpeg's own VP9 decoder drops the alpha). */
async function rgbaAt(file: string, t: number, x: number, y: number, decoder?: string): Promise<number[]> {
  const { stdout } = await run(
    'ffmpeg',
    [
      ...['-v', 'error', '-ss', String(t), ...(decoder ? ['-c:v', decoder] : []), '-i', file],
      ...['-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'image2pipe', '-c:v', 'png', '-'],
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const image = PNG.sync.read(stdout);
  const i = (image.width * y + x) * 4;
  return [...image.data.subarray(i, i + 4)];
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

/** Gives scenes a and b `code`; the returned function puts their code back. */
async function withScenes(code: string): Promise<() => Promise<void>> {
  const files = ['a', 'b'].map((sceneId) => h.store.sceneFile(id, sceneId));
  const saved = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  await Promise.all(files.map((file) => writeFile(file, code)));
  return async () => {
    await Promise.all(files.map((file, i) => writeFile(file, saved[i])));
  };
}

/** A render service whose store reads go through `onRead` (read 1: start(), read 2: the job itself). */
function renderingWith(
  onRead: (read: number, project: ProjectState) => Promise<ProjectState>,
  musicService: FixtureMusicService = music,
): FfmpegRenderService {
  let reads = 0;
  const store: ProjectStore = Object.assign(Object.create(h.store) as FixtureProjectStore, {
    get: async (projectId: string) => onRead(++reads, await h.store.get(projectId)),
  });
  return new FfmpegRenderService({ config: h.config, store, music: musicService, clips, voiceOver, hub });
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
      const service = new FfmpegRenderService({ config: h.config, store: h.store, music, clips, voiceOver: speaking, hub });
      const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' }, service);
      assert.ok(near(pixel(await frameAt(file, 0.2), 1500, 800), [0, 255, 0], 6), 'green: scene a has its sentence');
    } finally {
      h.store.voiceOverLines.delete(id);
      await writeFile(sceneFile, code);
    }
  });

  it('waits for the music analysis before the pages load the project, and fails with the frame text when it failed', async () => {
    // Scene a turns green on a loud spectrum. The spectrum reaches the project state only when analysis() ends, as when
    // the analyzer still runs as the export starts.
    const dir = h.store.dir(id);
    const projectFile = path.join(dir, 'project.json');
    const sceneFile = h.store.sceneFile(id, 'a');
    const [savedProject, code] = await Promise.all([readFile(projectFile, 'utf8'), readFile(sceneFile, 'utf8')]);
    await writeFile(
      sceneFile,
      `import type { SceneProps } from 'cadence';

export default function A({ t, music }: SceneProps) {
  return <div style={{ position: 'absolute', inset: 0, background: music.spectrum(t, 1)[0] > 0.5 ? '#00ff00' : '#ff0000' }} />;
}
`,
    );
    await mkdir(path.join(dir, 'music'), { recursive: true });
    const track = path.join(dir, 'music', 'tone.wav');
    // -y: the soundtrack test leaves this file behind, and ffmpeg would wait on stdin to overwrite it.
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '44100', track]);
    const spectrum = new Uint8Array(4 * 25 * 24).fill(255);
    await writeFile(`${track}.spectrum.bin`, spectrum);
    const project = JSON.parse(savedProject) as ProjectFile;
    await writeFile(projectFile, JSON.stringify({ ...project, music: { file: 'music/tone.wav', start: 0, volume: 1 } }));
    const grid = {
      bpm: 120,
      beatsPerBar: 4,
      beats: [0, 0.5, 1],
      downbeats: [0],
      phrases: [0],
      sections: [],
      accents: [],
      waveform: [],
      duration: 4,
      confidence: 1,
    };
    const analysing = Object.assign(new FixtureMusicService(), {
      analysis: async (projectId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        h.store.analysedMusic.set(projectId, {
          grid,
          spectrum: { bands: 24, rate: 25, file: 'music/tone.wav.spectrum.bin', size: spectrum.length },
        });
        return null;
      },
    });
    const failing = Object.assign(new FixtureMusicService(), {
      analysis: async () => {
        throw new HttpError(422, 'analysis failed');
      },
    });
    analysing.audio.set(id, track);
    failing.audio.set(id, track);
    try {
      let spectrumAtStart: unknown = null;
      const waiting = renderingWith(async (read, state) => {
        if (read === 2) spectrumAtStart = state.music?.spectrum ?? null;
        return state;
      }, analysing);
      const { file } = await renderOne({ formats: ['16:9'], quality: 'draft' }, waiting);
      assert.ok(spectrumAtStart, 'the job reads the project once the analysis has ended');
      assert.ok(near(pixel(await frameAt(file, 0.2), 1500, 800), [0, 255, 0], 6), 'green: scene a has its spectrum');

      h.store.analysedMusic.delete(id);
      const failed = new FfmpegRenderService({ config: h.config, store: h.store, music: failing, clips, voiceOver, hub });
      const [queued] = await failed.start(id, { formats: ['16:9'], quality: 'draft' });
      const job = await failed.wait(queued.id);
      assert.equal(job.status, 'error');
      assert.match(job.error!, /music\.spectrum\(\) n’est pas encore disponible/);
    } finally {
      h.store.analysedMusic.delete(id);
      await writeFile(projectFile, savedProject);
      await writeFile(sceneFile, code);
      await rm(path.join(dir, 'music'), { recursive: true, force: true });
    }
  });

  it('cancels a render still waiting for the music analysis, without opening a page', { timeout: 10_000 }, async () => {
    let asked!: () => void;
    const analysing = new Promise<void>((resolve) => (asked = resolve));
    const stuck = Object.assign(new FixtureMusicService(), {
      analysis: () => {
        asked();
        return new Promise<never>(() => {});
      },
    });
    let launched = false;
    const service = new FfmpegRenderService({
      config: h.config,
      store: h.store,
      music: stuck,
      clips,
      voiceOver,
      hub,
      browserServer: async () => {
        launched = true;
        throw new Error('no browser while the analysis runs');
      },
    });
    const [queued] = await service.start(id, { formats: ['16:9'], quality: 'draft' });
    await analysing;
    service.cancel(queued.id);
    assert.equal((await service.wait(queued.id)).status, 'cancelled');
    assert.equal(launched, false);
  });

  it('waits for the clip frames before opening a page, and a cancel does not wait for them', { timeout: 10_000 }, async () => {
    let asked!: (projectId: string) => void;
    const waited = new Promise<string>((resolve) => (asked = resolve));
    const preparing = Object.assign(new FixtureClipService(), {
      whenIdle: (projectId: string) => {
        asked(projectId);
        return new Promise<never>(() => {});
      },
    });
    let launched = false;
    const service = new FfmpegRenderService({
      config: h.config,
      store: h.store,
      music,
      clips: preparing,
      voiceOver,
      hub,
      browserServer: async () => {
        launched = true;
        throw new Error('no browser while clip frames are extracted');
      },
    });
    const [queued] = await service.start(id, { formats: ['16:9'], quality: 'draft' });
    assert.equal(await waited, id);
    service.cancel(queued.id);
    assert.equal((await service.wait(queued.id)).status, 'cancelled');
    assert.equal(launched, false);
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

  it('fails the render with the message of the frame when a scene shows a clip the project does not have', async () => {
    const restore = await withScenes(
      `import { Clip } from 'cadence';\nexport default function Scene({ t }) {\n  return <Clip src="loops/none.gif" time={t} />;\n}\n`,
    );
    try {
      const [queued] = await renders.start(id, { formats: ['16:9'], quality: 'draft' });
      const job = await renders.wait(queued.id);
      assert.equal(job.status, 'error');
      assert.match(job.error!, /<Clip> : assets\/loops\/none\.gif n\u2019est ni une vid\u00e9o ni un GIF de ce projet/);
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

  it('renders a transparent ProRes 4444 and VP9 WebM without the brand background, in true colors', async (t) => {
    // One red square in the middle of the 16:9 canvas (861-1060 × 440-640), on nothing: 430-530 × 220-320 at 0.5×, its
    // left column half covered. A mid-tone square (200-400 × 200-400, 100-200 at 0.5×) catches a tv/pc range error that
    // saturated red hides: #3366cc read back as pc range is about 41,99,213.
    const restore = await withScenes(
      `export default () => <>\n` +
        `  <div style={{ position: 'absolute', left: 861, top: 440, width: 199, height: 200, background: '#ff0000' }} />\n` +
        `  <div style={{ position: 'absolute', left: 200, top: 200, width: 200, height: 200, background: '#3366cc' }} />\n` +
        `</>;\n`,
    );
    try {
      const request = {
        formats: ['16:9' as const],
        quality: 'draft' as const,
        scale: 0.5 as const,
        supersample: true,
        transparent: true,
      };
      const { job, file } = await renderOne({ ...request, output: 'mov' });
      assert.match(job.file!, /\.mov$/);
      const video = (await probe(file)).streams.find((s) => s.codec_type === 'video')!;
      assert.deepEqual([video.codec_name, video.width, video.height, video.pix_fmt], ['prores', 960, 540, 'yuva444p12le']);
      assert.equal(video.nb_read_frames, '30');
      assert.equal((await rgbaAt(file, 0.2, 5, 5))[3], 0, 'corner: transparent');
      assert.ok(near(await rgbaAt(file, 0.2, 480, 270), [255, 0, 0, 255], 6), 'centre: opaque red');
      assert.ok(near(await rgbaAt(file, 0.2, 150, 150), [51, 102, 204, 255], 6), 'mid tone in tv range');
      // Resized premultiplied: the half-covered edge is red at half alpha, not darkened by the transparent black beside it.
      const edge = await rgbaAt(file, 0.2, 430, 270);
      assert.ok(edge[3] > 64 && edge[3] < 192 && near(edge.slice(0, 3), [255, 0, 0], 12), `edge: half-transparent red, ${edge}`);

      // The CDP screenshot comes in device pixels: at a device pixel ratio of 0.5 or 2 the crop must still frame the canvas.
      for (const [scale, supersample] of [
        [0.5, false],
        [1, true],
      ] as const) {
        const k = scale * 2;
        const other = await renderOne({ ...request, scale, supersample, output: 'mov' });
        const stream = (await probe(other.file)).streams.find((s) => s.codec_type === 'video')!;
        const ratio = `ratio ${scale * (supersample ? 2 : 1)}`;
        assert.deepEqual([stream.width, stream.height], [960 * k, 540 * k], ratio);
        assert.equal((await rgbaAt(other.file, 0.2, 5, 5))[3], 0, `${ratio} corner: transparent`);
        const centre = await rgbaAt(other.file, 0.2, 480 * k, 270 * k);
        assert.ok(near(centre, [255, 0, 0, 255], 6), `${ratio} centre: opaque red, ${centre}`);
        const mid = await rgbaAt(other.file, 0.2, 150 * k, 150 * k);
        assert.ok(near(mid, [51, 102, 204, 255], 6), `${ratio} mid tone, ${mid}`);
      }

      if (!(await outputSupport(h.config.ffmpegPath)).webm.available) return t.skip('the local ffmpeg has no libvpx-vp9');
      const webm = await renderOne({ ...request, output: 'webm' });
      assert.match(webm.job.file!, /\.webm$/);
      assert.equal((await rgbaAt(webm.file, 0.2, 5, 5, 'libvpx-vp9'))[3], 0, 'webm corner: transparent');
      assert.ok(near(await rgbaAt(webm.file, 0.2, 480, 270, 'libvpx-vp9'), [255, 0, 0, 255], 6), 'webm centre: opaque red');
      assert.ok(near(await rgbaAt(webm.file, 0.2, 150, 150, 'libvpx-vp9'), [51, 102, 204, 255], 6), 'webm mid tone in tv range');
    } finally {
      await restore();
    }
  });

  it("renders a ProRes with PCM audio and a WebM with opus, ffmpeg's own when the build has no libopus", async (t) => {
    const musicDir = path.join(h.store.dir(id), 'music');
    await mkdir(musicDir, { recursive: true });
    const track = path.join(musicDir, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '44100', track]);
    const projectFile = path.join(h.store.dir(id), 'project.json');
    const project = JSON.parse(await readFile(projectFile, 'utf8')) as ProjectFile;
    project.music = { file: 'music/tone.wav', start: 0, volume: 1 };
    await writeFile(projectFile, JSON.stringify(project, null, 2));
    music.audio.set(id, track);
    const request = { formats: ['16:9' as const], quality: 'draft' as const, scale: 0.5 as const };
    const audioOf = async (file: string) => {
      const audio = (await probe(file)).streams.filter((s) => s.codec_type === 'audio');
      return audio.map((s) => [s.codec_name, s.sample_rate]);
    };
    try {
      assert.deepEqual(await audioOf((await renderOne({ ...request, output: 'mov' })).file), [['pcm_s16le', '48000']]);

      if (!(await outputSupport(h.config.ffmpegPath)).webm.available) return t.skip('the local ffmpeg has no libvpx-vp9');
      assert.deepEqual(await audioOf((await renderOne({ ...request, output: 'webm' })).file), [['opus', '48000']]);

      // The same ffmpeg, but its encoders list leaves libopus out.
      const wrapper = path.join(h.store.dir(id), 'ffmpeg-no-libopus');
      await writeFile(
        wrapper,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$0.log"
case "$*" in
  *-encoders*) "${h.config.ffmpegPath}" "$@" | grep -v ' libopus ' ;;
  *) exec "${h.config.ffmpegPath}" "$@" ;;
esac
`,
        { mode: 0o755 },
      );
      const native = new FfmpegRenderService({
        config: { ...h.config, ffmpegPath: wrapper },
        store: h.store,
        music,
        clips,
        voiceOver,
        hub,
      });
      assert.deepEqual(await audioOf((await renderOne({ ...request, output: 'webm' }, native)).file), [['opus', '48000']]);
      assert.match(await readFile(`${wrapper}.log`, 'utf8'), / -c:a opus -strict -2 /);
    } finally {
      project.music = null;
      await writeFile(projectFile, JSON.stringify(project, null, 2));
      music.audio.delete(id);
    }
  });

  it('renders a GIF with every frame and true colors, supersampled', async () => {
    const { job, file } = await renderOne({ formats: ['16:9'], quality: 'draft', scale: 0.5, supersample: true, output: 'gif' });
    assert.match(job.file!, /\.gif$/);
    const info = await probe(file);
    assert.deepEqual(
      info.streams.map((s) => [s.codec_type, s.codec_name, s.width, s.height, s.nb_read_frames]),
      [['video', 'gif', 960, 540, '30']],
    );
    assert.ok(near(pixel(await frameAt(file, 0.2), 750, 400), [255, 0, 0], 6), 'red');
    assert.ok(near(pixel(await frameAt(file, 0.8), 750, 400), [0, 0, 255], 6), 'blue');
    const partial = (await readdir(path.join(h.store.dir(id), 'renders'))).filter((n) => n.endsWith('.part'));
    assert.deepEqual(partial, [], 'the frames file is gone too');
  });

  it('reports a failed GIF palette pass with what ffmpeg said, and leaves no file behind', async () => {
    // The real ffmpeg, except for the second pass.
    const wrapper = path.join(h.store.dir(id), 'ffmpeg-no-palette');
    await writeFile(
      wrapper,
      `#!/bin/sh
case "$*" in
  *paletteuse*) echo boom >&2; exit 3 ;;
  *) exec "${h.config.ffmpegPath}" "$@" ;;
esac
`,
      { mode: 0o755 },
    );
    const failing = new FfmpegRenderService({
      config: { ...h.config, ffmpegPath: wrapper },
      store: h.store,
      music,
      clips,
      voiceOver,
      hub,
    });
    const rendersDir = path.join(h.store.dir(id), 'renders');
    const existing = await readdir(rendersDir).catch(() => [] as string[]);
    const [queued] = await failing.start(id, { formats: ['16:9'], quality: 'draft', scale: 0.5, output: 'gif' });
    const job = await failing.wait(queued.id);
    assert.equal(job.status, 'error');
    assert.equal(job.error, 'ffmpeg a échoué (code 3) : boom');
    const left = (await readdir(rendersDir)).filter((n) => !existing.includes(n) && /\.(part|gif)$/.test(n));
    assert.deepEqual(left, []);
  });

  it('cancels a GIF during its palette pass, within seconds, and leaves no file behind', { timeout: 30_000 }, async () => {
    // The real ffmpeg, except for the second pass, which says it started and then hangs.
    const wrapper = path.join(h.store.dir(id), 'ffmpeg-slow-palette');
    const started = `${wrapper}.started`;
    await writeFile(
      wrapper,
      `#!/bin/sh
case "$*" in
  *paletteuse*) touch "${started}"; exec sleep 30 ;;
  *) exec "${h.config.ffmpegPath}" "$@" ;;
esac
`,
      { mode: 0o755 },
    );
    const slow = new FfmpegRenderService({
      config: { ...h.config, ffmpegPath: wrapper },
      store: h.store,
      music,
      clips,
      voiceOver,
      hub,
    });
    const rendersDir = path.join(h.store.dir(id), 'renders');
    const existing = await readdir(rendersDir).catch(() => [] as string[]);
    const [queued] = await slow.start(id, { formats: ['16:9'], quality: 'draft', scale: 0.5, output: 'gif' });
    while (
      !(await readFile(started).then(
        () => true,
        () => false,
      ))
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(slow.jobs(id).find((j) => j.id === queued.id)!.status, 'encoding');
    const cancelledAt = Date.now();
    slow.cancel(queued.id);
    const job = await slow.wait(queued.id);
    assert.equal(job.status, 'cancelled');
    assert.ok(Date.now() - cancelledAt < 5_000, 'ffmpeg is killed, not waited for');
    const left = (await readdir(rendersDir)).filter((n) => !existing.includes(n) && /\.(part|gif)$/.test(n));
    assert.deepEqual(left, []);
  });

  it('renders one PNG frame at the range start, or at 0 without a range, supersampled, in true colors', async () => {
    const request = { formats: ['16:9' as const], quality: 'draft' as const, scale: 0.5 as const, supersample: true };
    const [queued] = await renders.start(id, { ...request, output: 'png' });
    assert.equal(queued.framesTotal, 1);
    const job = await renders.wait(queued.id);
    assert.equal(job.status, 'done', job.error ?? job.status);
    assert.match(job.file!, /\.png$/);
    const first = await readFile(renders.resolveFile(id, job.file!));
    const image = PNG.sync.read(first);
    assert.deepEqual([image.width, image.height, job.framesTotal], [960, 540, 1]);
    assert.ok(near(pixel(first, 750, 400), [255, 0, 0], 6), 'scene a at 0');
    const across = await renderOne({ ...request, output: 'png', range: { from: 0.4, to: 0.9 } });
    assert.ok(near(pixel(await readFile(across.file), 750, 400), [255, 0, 0], 6), 'scene a at 0.4, not scene b at 0.9');
    const later = await renderOne({ ...request, output: 'png', range: { from: 0.8, to: 0.9 } });
    assert.ok(near(pixel(await readFile(later.file), 750, 400), [0, 0, 255], 6), 'scene b at 0.8');
    for (const range of [
      { from: 0.8, to: 0.81 },
      { from: 3, to: 4 },
    ]) {
      const short = await renderOne({ ...request, output: 'png', range });
      assert.equal(short.job.framesTotal, 1);
      assert.ok(near(pixel(await readFile(short.file), 750, 400), [0, 0, 255], 6), `scene b from ${range.from}`);
    }
    const partial = (await readdir(path.join(h.store.dir(id), 'renders'))).filter((n) => n.endsWith('.part'));
    assert.deepEqual(partial, []);
  });

  it('renders a transparent PNG frame with its alpha and the RGB of the page', async () => {
    const restore = await withScenes(
      `export default () => <>\n` +
        `  <div style={{ position: 'absolute', left: 861, top: 440, width: 199, height: 200, background: '#ff0000' }} />\n` +
        `  <div style={{ position: 'absolute', left: 200, top: 200, width: 200, height: 200, background: '#3366cc' }} />\n` +
        `</>;\n`,
    );
    try {
      const request = { formats: ['16:9' as const], quality: 'draft' as const, scale: 0.5 as const, supersample: true };
      const { file } = await renderOne({ ...request, output: 'png', transparent: true });
      const image = PNG.sync.read(await readFile(file));
      const rgba = (x: number, y: number) => [...image.data.subarray((image.width * y + x) * 4, (image.width * y + x) * 4 + 4)];
      assert.equal(rgba(5, 5)[3], 0, 'corner: transparent');
      assert.ok(near(rgba(480, 270), [255, 0, 0, 255], 2), `centre: opaque red, ${rgba(480, 270)}`);
      assert.ok(near(rgba(150, 150), [51, 102, 204, 255], 2), `mid tone unchanged, ${rgba(150, 150)}`);
    } finally {
      await restore();
    }
  });

  it('captures an opaque PNG losslessly: a 1 px red line on blue keeps its exact pixels', async () => {
    const restore = await withScenes(
      `export default () => <div style={{ position: 'absolute', inset: 0, background: '#0000ff' }}>\n` +
        `  <div style={{ position: 'absolute', left: 1001, top: 0, width: 1, height: 1080, background: '#ff0000' }} />\n` +
        `</div>;\n`,
    );
    try {
      for (const output of ['png', 'png-sequence'] as const) {
        const { file } = await renderOne({ formats: ['16:9'], quality: 'draft', range: { from: 0, to: 1 / 30 }, output });
        const frame = await readFile(output === 'png' ? file : path.join(file, '000001.png'));
        assert.deepEqual(
          [999, 1000, 1001, 1002].map((x) => pixel(frame, x, 540)),
          [
            [0, 0, 255],
            [0, 0, 255],
            [255, 0, 0],
            [0, 0, 255],
          ],
          output,
        );
      }
    } finally {
      await restore();
    }
  });

  it('renders a PNG sequence folder with one numbered frame per frame, listed with its size and frames, then trashed', async () => {
    const { job, file } = await renderOne({
      formats: ['16:9'],
      quality: 'draft',
      scale: 0.5,
      range: { from: 0.4, to: 1 },
      output: 'png-sequence',
    });
    assert.match(job.file!, /^[\w-]+$/);
    assert.ok((await lstat(file)).isDirectory());
    const frames = (await readdir(file)).sort();
    assert.equal(job.framesTotal, 18);
    assert.deepEqual(
      frames,
      Array.from({ length: job.framesTotal }, (_, i) => `${String(i + 1).padStart(6, '0')}.png`),
    );
    const first = await readFile(path.join(file, frames[0]));
    assert.deepEqual([PNG.sync.read(first).width, PNG.sync.read(first).height], [960, 540]);
    assert.ok(near(pixel(first, 750, 400), [255, 0, 0], 6), 'scene a first');
    assert.ok(near(pixel(await readFile(path.join(file, frames.at(-1)!)), 750, 400), [0, 0, 255], 6), 'scene b last');
    const rendersDir = path.join(h.store.dir(id), 'renders');
    assert.deepEqual(
      (await readdir(rendersDir)).filter((n) => n.endsWith('.part')),
      [],
    );

    const sizes = await Promise.all(frames.map(async (name) => (await lstat(path.join(file, name))).size));
    const listed = (await renders.files(id)).find((f) => f.name === job.file)!;
    assert.deepEqual(
      [listed.output, listed.frames, listed.size, listed.format],
      ['png-sequence', 18, sizes.reduce((a, b) => a + b, 0), '16:9'],
    );
    await renders.remove(id, job.file!);
    assert.equal(
      (await renders.files(id)).some((f) => f.name === job.file),
      false,
    );
    const trash = path.join(h.store.dir(id), '.cadence', 'trash');
    const trashed = (await readdir(trash)).find((name) => name.endsWith(`-${job.file}`))!;
    assert.equal((await readdir(path.join(trash, trashed))).length, 18);
  });

  it(
    'removes the partial folder of a PNG sequence when ffmpeg fails or the render is cancelled',
    { timeout: 60_000 },
    async () => {
      // The real ffmpeg writes every frame, then says it failed.
      const wrapper = path.join(h.store.dir(id), 'ffmpeg-failing-sequence');
      await writeFile(
        wrapper,
        `#!/bin/sh
case "$*" in
  *%06d.png*) "${h.config.ffmpegPath}" "$@"; echo boom >&2; exit 3 ;;
  *) exec "${h.config.ffmpegPath}" "$@" ;;
esac
`,
        { mode: 0o755 },
      );
      const failing = new FfmpegRenderService({
        config: { ...h.config, ffmpegPath: wrapper },
        store: h.store,
        music,
        clips,
        voiceOver,
        hub,
      });
      const rendersDir = path.join(h.store.dir(id), 'renders');
      const existing = await readdir(rendersDir).catch(() => [] as string[]);
      const request = {
        formats: ['16:9' as const],
        quality: 'draft' as const,
        scale: 0.5 as const,
        output: 'png-sequence' as const,
      };
      const [queued] = await failing.start(id, request);
      const job = await failing.wait(queued.id);
      assert.equal(job.status, 'error');
      assert.equal(job.error, 'ffmpeg a échoué (code 3) : boom');
      assert.deepEqual(
        (await readdir(rendersDir)).filter((n) => !existing.includes(n)),
        [],
      );

      const [running] = await renders.start(id, { ...request, fps: 120 });
      while (renders.jobs(id).find((j) => j.id === running.id)!.framesDone < 2) await new Promise((r) => setTimeout(r, 20));
      const folders = (await readdir(rendersDir)).filter((n) => !existing.includes(n));
      assert.equal(folders.length, 1);
      assert.match(folders[0], /\.part$/);
      renders.cancel(running.id);
      const cancelled = await renders.wait(running.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.framesDone < cancelled.framesTotal);
      assert.deepEqual(
        (await readdir(rendersDir)).filter((n) => !existing.includes(n)),
        [],
      );
    },
  );

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

  it('settles a finished render only once its Chromium host has ended and its temporary files are gone', async () => {
    const restore = await withSounds({ a: "[{ at: 0.1, sound: 'pop' }]" });
    try {
      await renderOne({ formats: ['16:9'], quality: 'draft' });
      const { stdout } = await run('pgrep', ['-P', String(process.pid), '-f', 'chromium-server.mjs']).catch(() => ({
        stdout: '',
      }));
      assert.equal(stdout, '');
      const partial = (await readdir(path.join(h.store.dir(id), 'renders'))).filter((n) => n.endsWith('.part'));
      assert.deepEqual(partial, []);
      assert.deepEqual(await readdir(path.join(h.store.dir(id), '.cadence', 'sounds')), []);
    } finally {
      await restore();
    }
  });

  it('fails the render whose page logs more than a string can hold, ends its Chromium, then renders again', async () => {
    const file = h.store.sceneFile(id, 'b');
    const code = await readFile(file, 'utf8');
    await writeFile(
      file,
      `export default function Loud() {\n  const big = 'x'.repeat(300_000_000);\n  console.log(big, big);\n  return null;\n}\n`,
    );
    try {
      const [queued] = await renders.start(id, { formats: ['16:9'], quality: 'draft' });
      const job = await renders.wait(queued.id);
      assert.equal(job.status, 'error');
      // The Chromium host process ended (Playwright's own message), the render did not wait for a timeout.
      assert.match(job.error!, /has been closed/);
      const leftovers = (await readdir(path.join(h.store.dir(id), 'renders'))).filter((n) => n.endsWith('.part'));
      assert.deepEqual(leftovers, []);
      const { stdout } = await run('pgrep', ['-P', String(process.pid), '-f', 'chromium-server.mjs']).catch(() => ({
        stdout: '',
      }));
      assert.equal(stdout, '');
    } finally {
      await writeFile(file, code);
    }
    await renderOne({ formats: ['16:9'], quality: 'draft' });
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

  it('removes the partial file or PNG sequence folder a killed render left, never a live one or a link', async () => {
    const dir = path.join(h.store.dir(id), 'renders');
    await mkdir(dir, { recursive: true });
    const [old, live] = [path.join(dir, 'killed-16x9.mp4.part'), path.join(dir, 'live-16x9.mp4.part')];
    const [oldSequence, liveSequence] = [path.join(dir, 'killed-16x9.part'), path.join(dir, 'live-16x9.part')];
    const link = path.join(dir, 'linked-16x9.part');
    await writeFile(old, 'x');
    await writeFile(live, 'x');
    for (const folder of [oldSequence, liveSequence]) {
      await mkdir(folder);
      await writeFile(path.join(folder, '000001.png'), 'x');
    }
    await symlink(liveSequence, link);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    for (const file of [old, path.join(oldSequence, '000001.png'), oldSequence]) await utimes(file, twoHoursAgo, twoHoursAgo);
    await lutimes(link, twoHoursAgo, twoHoursAgo);
    try {
      await renders.files(id);
      const parts = (await readdir(dir)).filter((n) => n.endsWith('.part')).sort();
      assert.deepEqual(parts, ['linked-16x9.part', 'live-16x9.mp4.part', 'live-16x9.part']);
      assert.deepEqual(await readdir(liveSequence), ['000001.png']);
    } finally {
      for (const file of [old, live, oldSequence, liveSequence, link]) await rm(file, { recursive: true, force: true });
    }
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

describe('FfmpegRenderService on a frame origin with a request secret', () => {
  const SECRET = 'render-request-secret-0123456789abcdef';
  let server: http.Server;
  let config: CadenceConfig;

  before(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const framePort = (server.address() as AddressInfo).port;
    config = { ...h.config, framePort, frameOrigin: `http://localhost:${framePort}`, requestSecret: SECRET };
    server.on('request', createFrameHandler({ config, vite: h.vite, store: h.store, brands: h.brands }));
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('renders with the secret its pages send, and fails without it', async () => {
    const { job } = await renderOne(
      { formats: ['16:9'], quality: 'draft' },
      new FfmpegRenderService({ config, store: h.store, music, clips, voiceOver, hub }),
    );
    assert.deepEqual([job.framesTotal, job.framesDone], [30, 30]);

    const without = new FfmpegRenderService({
      config: { ...config, requestSecret: undefined },
      store: h.store,
      music,
      clips,
      voiceOver,
      hub,
    });
    const [queued] = await without.start(id, { formats: ['16:9'], quality: 'draft' });
    assert.equal((await without.wait(queued.id)).status, 'error');
  });
});
