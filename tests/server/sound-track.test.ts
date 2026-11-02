// The sounds track of the MP4: each cue's file placed so its peak lands on `at`, times its gain, summed, clamped, and
// bounded by the render range.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { Page } from 'playwright';
import { RENDER_TIMEOUT_MS } from '../../server/capture/capture';
import { ffmpegArgs, soundCues } from '../../server/capture/render';
import { setLanguage } from '../../server/i18n';
import { soundTrack } from '../../server/sounds/track';
import { readWav, writeWav } from '../../server/voiceover/wav';
import { MAX_SOUND_CUES, MAX_VIDEO_SOUND_CUES, SOUND_PEAKS, type SoundCue } from '../../src/shared/sounds';
import type { ProjectState } from '../../src/shared/types';

const SR = 44100;
/** The fake click: a 441-sample ramp 1, 2, ... 441, so a sample tells which part of the file it comes from. */
const RAMP = Int16Array.from({ length: 441 }, (_, i) => i + 1);

let dir: string;
let library: string;
let cache: string;
let output: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-sound-track-'));
  library = path.join(dir, 'sounds');
  cache = path.join(dir, 'project', '.cadence', 'sounds');
  output = path.join(cache, 'job.wav');
  await fs.mkdir(library);
  await fs.writeFile(path.join(library, 'click.wav'), writeWav({ sampleRate: SR, samples: RAMP }));
  await fs.writeFile(path.join(library, 'pop.wav'), writeWav({ sampleRate: SR, samples: new Int16Array(441).fill(30000) }));
  await fs.writeFile(path.join(library, 'key.wav'), writeWav({ sampleRate: SR, samples: new Int16Array(441).fill(-30000) }));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A click whose file starts `samples` samples after `from`. */
const click = (from: number, samples: number, gain = 1): Required<SoundCue> => ({
  at: from + SOUND_PEAKS.click + samples / SR,
  sound: 'click',
  gain,
});

/** What the fake clip reader was asked for, in samples: [clip, first sample, samples]. */
let reads: [string, number, number][] = [];
/** A clip whose sample n (from its start) is n + 1, so a sample tells which part of the clip it comes from. */
const readClip = async (clip: string, from: number, duration: number) => {
  const first = Math.round(from * SR);
  reads.push([clip, first, Math.round(duration * SR)]);
  return Int16Array.from({ length: Math.round(duration * SR) }, (_, i) => first + i + 1);
};

async function track(cues: Required<SoundCue>[], from: number, duration: number): Promise<Int16Array | null> {
  reads = [];
  const file = await soundTrack({ cues, from, duration, library, file: output, readClip });
  if (!file) return null;
  const pcm = readWav(await fs.readFile(file));
  assert.equal(pcm.sampleRate, SR);
  return pcm.samples;
}

test('places each file so its peak lands on the cue, scaled by its gain, on a track as long as the range', async () => {
  const samples = (await track([click(0, 11025), click(0, 22050, 0.5)], 0, 1))!;
  assert.equal(samples.length, SR);
  assert.deepEqual([samples[11024], samples[11025], samples[11025 + 440], samples[11025 + 441]], [0, 1, 441, 0]);
  assert.deepEqual([samples[22050], samples[22050 + 99], samples[22050 + 440]], [1, 50, 221]);
  assert.equal(
    samples.reduce((n, s) => n + (s === 0 ? 0 : 1), 0),
    2 * 441,
  );
});

test('lands the peak of a real library sound on `at`', async () => {
  const real = path.resolve(import.meta.dirname, '../../src/editor/sounds');
  const file = await soundTrack({
    cues: [{ at: 0.5, sound: 'whoosh', gain: 1 }],
    from: 0,
    duration: 1,
    library: real,
    file: output,
    readClip,
  });
  const { samples } = readWav(await fs.readFile(file!));
  let loudest = 0;
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]) > Math.abs(samples[loudest])) loudest = i;
  assert.ok(Math.abs(loudest - 0.5 * SR) <= 1, `loudest sample at ${loudest}`);
});

test('sums overlapping cues and clamps the sum to 16 bits', async () => {
  const at = SOUND_PEAKS.pop + 0.1;
  const samples = (await track(
    [
      { at, sound: 'pop', gain: 1 },
      { at, sound: 'pop', gain: 1 },
      { at: SOUND_PEAKS.key + 0.5, sound: 'key', gain: 1 },
      { at: SOUND_PEAKS.key + 0.5, sound: 'key', gain: 1 },
    ],
    0,
    1,
  ))!;
  assert.deepEqual([samples[4410], samples[4410 + 440]], [32767, 32767]);
  assert.deepEqual([samples[22050], samples[22050 + 440]], [-32768, -32768]);
});

test('trims a cue that starts before the range and cuts one that runs past its end', async () => {
  // A whoosh-like cue: its file starts 100 samples before the range, the rest of it is heard from the first sample.
  const before = (await track([click(2, -100)], 2, 0.5))!;
  assert.equal(before.length, 22050);
  assert.deepEqual([before[0], before[340], before[341]], [101, 441, 0]);

  const after = (await track([click(2, 22050 - 100)], 2, 0.5))!;
  assert.equal(after.length, 22050);
  assert.deepEqual([after[22050 - 101], after[22050 - 100], after.at(-1)], [0, 1, 100]);
});

test('gives no track when no cue is heard in the range', async () => {
  assert.equal(await track([], 0, 1), null);
  assert.equal(await track([click(2, -441)], 2, 0.5), null, 'ends right before the range');
  assert.equal(await track([click(2, 22050)], 2, 0.5), null, 'starts right after it');
  await assert.rejects(fs.readdir(cache), { code: 'ENOENT' });
});

test('writes the track atomically to the file it is given', async () => {
  assert.equal(await soundTrack({ cues: [click(0, 100)], from: 0, duration: 1, library, file: output, readClip }), output);
  assert.deepEqual(await fs.readdir(cache), ['job.wav']);
  assert.equal(readWav(await fs.readFile(output)).samples[100], 1);
});

test('writes a 16-bit mono WAV whose bytes are its header and its little-endian samples', async () => {
  const file = (await soundTrack({ cues: [click(0, 100, 0.5)], from: 0, duration: 0.01, library, file: output, readClip }))!;
  const samples = Array.from({ length: 441 }, (_, i) => (i < 100 ? 0 : Math.round((i - 99) * 0.5)));
  const expected = Buffer.alloc(44 + 882);
  expected.write('RIFF', 0, 'ascii');
  expected.writeUInt32LE(36 + 882, 4);
  expected.write('WAVEfmt ', 8, 'ascii');
  expected.writeUInt32LE(16, 16);
  expected.writeUInt16LE(1, 20);
  expected.writeUInt16LE(1, 22);
  expected.writeUInt32LE(SR, 24);
  expected.writeUInt32LE(SR * 2, 28);
  expected.writeUInt16LE(2, 32);
  expected.writeUInt16LE(16, 34);
  expected.write('data', 36, 'ascii');
  expected.writeUInt32LE(882, 40);
  samples.forEach((sample, i) => expected.writeInt16LE(sample, 44 + 2 * i));
  assert.deepEqual(await fs.readFile(file), expected);
});

test('fails naming the library file that is missing, without its folder', async () => {
  setLanguage('en');
  await fs.rm(path.join(library, 'pop.wav'));
  await assert.rejects(
    soundTrack({ cues: [{ at: 0.5, sound: 'pop', gain: 1 }], from: 0, duration: 1, library, file: output, readClip }),
    {
      message: 'Sound effect not found: pop.wav',
    },
  );
});

test('refuses a library file at another sample rate, which would play at the wrong speed', async () => {
  setLanguage('en');
  await fs.writeFile(path.join(library, 'click.wav'), writeWav({ sampleRate: 48000, samples: RAMP }));
  await assert.rejects(soundTrack({ cues: [click(0, 100)], from: 0, duration: 1, library, file: output, readClip }), {
    message: 'Sound effect in the wrong format: click.wav (44100 Hz expected)',
  });
});

/** A clip cue heard from `samples` samples after the range start, for `length` samples of the clip from sample `first`. */
const clipCue = (from: number, samples: number, first: number, length: number, gain = 1): Required<SoundCue> => ({
  at: from + samples / SR,
  clip: 'demo/talk.mp4',
  from: first / SR,
  duration: length / SR,
  gain,
});

test('places a clip cue on `at`, from its `from`, for its duration, scaled by its gain', async () => {
  const samples = (await track([clipCue(0, 11025, 4410, 441), clipCue(0, 22050, 100, 200, 0.5)], 0, 1))!;
  assert.deepEqual([samples[11024], samples[11025], samples[11025 + 440], samples[11025 + 441]], [0, 4411, 4851, 0]);
  assert.deepEqual([samples[22049], samples[22050], samples[22050 + 199], samples[22050 + 200]], [0, 51, 150, 0]);
  assert.deepEqual(reads, [['demo/talk.mp4', 100, 4751]]);
});

test('reads parts of one clip less than 30 s apart at once, and farther parts and other clips apart', async () => {
  const other = { ...clipCue(0, 3000, SR, 441), clip: 'demo/other.mp4' };
  // 20 s after the first part: one read; 60 s: a read of its own.
  const cues = [clipCue(0, 2000, 60 * SR, 441), clipCue(0, 1000, 20 * SR, 441), clipCue(0, 0, 0, 441), other];
  const samples = (await track(cues, 0, 1))!;
  assert.deepEqual(reads, [
    ['demo/other.mp4', SR, 441],
    ['demo/talk.mp4', 0, 20 * SR + 441],
    ['demo/talk.mp4', 60 * SR, 441],
  ]);
  // The fake clip's samples wrap at 16 bits like the WAV's.
  const at = (n: number) => Int16Array.of(n + 1)[0];
  assert.deepEqual(
    [samples[0], samples[440], samples[1000], samples[1440], samples[2000], samples[3000], samples[3441]],
    [at(0), at(440), at(20 * SR), at(20 * SR + 440), at(60 * SR), at(SR), 0],
  );
});

test('many cues spread over a long clip never ask more than 600 s per read', async () => {
  // One cue every 29 s of an hour-long clip: each is near the next, but one read for all of them would hold the hour.
  const cues = Array.from({ length: 121 }, (_, k) => clipCue(0, k * 100, 29 * k * SR, 441));
  const asked: number[] = [];
  const counting = async (_clip: string, _from: number, duration: number) => (asked.push(duration), new Int16Array(0));
  await soundTrack({ cues, from: 0, duration: 1, library, file: output, readClip: counting });
  assert.ok(Math.max(...asked) <= 600, `${Math.max(...asked)} s`);
  // 21 cues fit in 600 s, so 6 reads for 121 cues.
  assert.equal(asked.length, 6);
});

test('parts of one clip spanning exactly 600 s share one read; one more sample starts another', async () => {
  // Every 29 s from 0 to 580 s, then 599.5 s: each part is near the next, and 22050 samples are exactly 0.5 s.
  const part = (from: number, samples = 22050): Required<SoundCue> => ({
    at: 0,
    clip: 'demo/talk.mp4',
    from,
    duration: samples / SR,
    gain: 1,
  });
  const near = Array.from({ length: 21 }, (_, k) => part(29 * k));
  for (const [last, reads] of [
    [part(599.5), [600 * SR]],
    [part(599.5, 22051), [580.5 * SR, 22051]],
  ] as const) {
    const asked: number[] = [];
    const counting = async (_clip: string, _from: number, duration: number) => {
      asked.push(Math.round(duration * SR));
      return new Int16Array(0);
    };
    await soundTrack({ cues: [...near, last], from: 0, duration: 1, library, file: output, readClip: counting });
    assert.deepEqual(asked, reads);
  }
});

test('reads only the part of a clip cue the range hears, and sums it with the one-shots', async () => {
  // Starts 100 samples before the range and ends 100 samples after it: the range hears samples 100 to 22149 of the cue.
  const samples = (await track([clipCue(2, -100, 1000, 22250), click(2, 0)], 2, 0.5))!;
  assert.deepEqual(reads, [['demo/talk.mp4', 1100, 22050]]);
  assert.deepEqual(
    [samples[0], samples[1], samples[440], samples[441], samples.at(-1)],
    [1101 + 1, 1102 + 2, 1541 + 441, 1542, 23150],
  );
});

test('reads no clip cue the range does not hear, and an identical part once', async () => {
  const same = [clipCue(0, 100, 0, 441), clipCue(0, 5000, 0, 441, 0.5)];
  // Ends right before the range, starts right after it.
  const unheard = [clipCue(0, -441, 0, 441), clipCue(0, 22050, 0, 441)];
  const samples = (await track([...unheard, ...same], 0, 0.5))!;
  assert.deepEqual(reads, [['demo/talk.mp4', 0, 441]]);
  assert.deepEqual([samples[100], samples[100 + 440], samples[5000], samples[5000 + 440]], [1, 441, 1, 221]);
  assert.equal(await track(unheard, 0, 0.5), null);
  assert.deepEqual(reads, []);
});

test('a clip whose sound ends before its video leaves the rest of the cue to the other sounds', async () => {
  // ffmpeg gives what the file holds: a sound track shorter than the video is read shorter than asked.
  const short = async (clip: string, from: number, duration: number) => (await readClip(clip, from, duration)).subarray(0, 100);
  const file = await soundTrack({
    cues: [clipCue(0, 0, 0, 441), click(0, 0)],
    from: 0,
    duration: 0.5,
    library,
    file: output,
    readClip: short,
  });
  const samples = readWav(await fs.readFile(file!)).samples;
  assert.deepEqual([samples[99], samples[100], samples[200]], [100 + 100, 101, 201]);
});

test('fails with the error of the clip reader, and writes no track', async () => {
  const failing = () => Promise.reject(new Error('Could not read the sound of assets/demo/talk.mp4: broken'));
  await assert.rejects(
    soundTrack({ cues: [clipCue(0, 0, 0, 441)], from: 0, duration: 1, library, file: output, readClip: failing }),
    { message: 'Could not read the sound of assets/demo/talk.mp4: broken' },
  );
  assert.deepEqual(await fs.readdir(cache).catch(() => []), []);
});

/** A render page whose `sounds()` gives `value`, or throws `error`. */
const page = (value: unknown, error?: Error) =>
  ({ evaluate: () => (error ? Promise.reject(error) : Promise.resolve(value)) }) as unknown as Page;
const project = (scenes: number, clips: ProjectState['clips'] = {}) =>
  ({ duration: 2, scenes: Array.from({ length: scenes }, () => ({})), clips }) as ProjectState;

test('caps the cues of the whole video at the per-scene maximum times the number of scenes', async () => {
  setLanguage('en');
  const cues = (n: number) => Array.from({ length: n }, () => ({ at: 1, sound: 'pop' }));
  assert.equal((await soundCues(page(cues(3 * MAX_SOUND_CUES)), project(3))).length, 3 * MAX_SOUND_CUES);
  await assert.rejects(soundCues(page(cues(3 * MAX_SOUND_CUES + 1)), project(3)), {
    message: `Invalid sounds in the video: sounds() returns more than ${3 * MAX_SOUND_CUES} cues`,
  });
});

test('caps the cues of a video of many scenes at a fixed total, which keeps the 32-bit sum from wrapping', async () => {
  setLanguage('en');
  const cues = (n: number) => Array.from({ length: n }, () => ({ at: 1, sound: 'impact' }));
  assert.equal(MAX_VIDEO_SOUND_CUES, 10_000);
  assert.ok(MAX_VIDEO_SOUND_CUES * 32767 < 2 ** 31);
  assert.equal((await soundCues(page(cues(MAX_VIDEO_SOUND_CUES)), project(20))).length, MAX_VIDEO_SOUND_CUES);
  await assert.rejects(soundCues(page(cues(MAX_VIDEO_SOUND_CUES + 1)), project(20)), {
    message: `Invalid sounds in the video: sounds() returns more than ${MAX_VIDEO_SOUND_CUES} cues`,
  });
});

test('checks the clip cues of the video against the clips of the project', async () => {
  setLanguage('en');
  const talk = {
    status: 'ready',
    key: 'talk-0123456789ab',
    fps: 30,
    frames: 90,
    width: 32,
    height: 32,
    duration: 3,
    audio: true,
  } as const;
  const cues = [{ at: 1, clip: 'demo/talk.mp4', from: 0.5, duration: 0.5, gain: 0.8 }];
  assert.deepEqual(await soundCues(page(cues), project(1, { 'demo/talk.mp4': talk })), cues);
  await assert.rejects(soundCues(page(cues), project(1, { 'demo/talk.mp4': { ...talk, audio: false } })), {
    message: 'Invalid sounds in the video: sound cue 0: the video assets/demo/talk.mp4 has no sound',
  });
});

test('fails a render whose sounds() never answers with the timeout message, not a hang', { timeout: 5_000 }, async (t) => {
  setLanguage('en');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = { evaluate: () => new Promise(() => {}) } as unknown as Page;
  const rejection = assert.rejects(soundCues(hung, project(1)), {
    message: `sounds() took more than ${RENDER_TIMEOUT_MS / 1000} s (infinite loop?)`,
  });
  t.mock.timers.tick(RENDER_TIMEOUT_MS);
  await rejection;
});

test('reports a sounds() that throws by the first line of its message, cut to 200 characters', async () => {
  setLanguage('en');
  const error = new Error(
    `page.evaluate: Error: ${'x'.repeat(500)}\n    at sounds (http://127.0.0.1:5311/@fs/Users/me/scene.tsx:3:9)`,
  );
  const rejection = await soundCues(page(null, error), project(1)).then(
    () => assert.fail('no rejection'),
    (e: Error) => e.message,
  );
  assert.equal(rejection, `Invalid sounds in the video: ${error.message.split('\n')[0].slice(0, 200)}`);
});

/** The message a render shows for a `sounds()` that throws `message`. */
const thrown = (message: string) =>
  soundCues(page(null, new Error(message)), project(1)).then(
    () => assert.fail('no rejection'),
    (e: Error) => e.message,
  );

test("reports a sounds() that throws in Playwright's format without its stack", async () => {
  setLanguage('en');
  const message = await thrown(
    'page.evaluate: Error: boom\n    at Object.sounds (http://localhost:5311/@fs/Users/me/projects/demo/scenes/a.tsx:3:9)',
  );
  assert.equal(message, 'Invalid sounds in the video: page.evaluate: Error: boom');
});

test('cuts a thrown message by characters, never through an emoji', async () => {
  setLanguage('en');
  const message = await thrown('\u{1F600}'.repeat(300));
  assert.equal(message, `Invalid sounds in the video: ${'\u{1F600}'.repeat(200)}`);
  assert.doesNotMatch(message, /[\ud800-\udfff]/u, 'no lone surrogate');
});

const base = {
  fps: 30,
  width: 1920,
  height: 1080,
  supersample: false,
  crf: 16,
  preset: 'medium',
  duration: 2,
  output: 'out.mp4',
};
const music = { file: 'music.wav', start: 1.5, volume: 0.8 };
const voice = { file: 'voice.wav', start: 0.5, intervals: [[0.2, 1]] as [number, number][], musicLevel: 0.3 };
const duck = "volume='1-0.700*clip(min((t--0.050)/0.25,(1.250-t)/0.25),0,1)':eval=frame";
const musicChain = 'aresample=192000,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,volume=0.8';
const ending = 'alimiter=limit=0.95:level=disabled,afade=t=out:st=1.400:d=0.600[audio]';

/** The audio inputs of the ffmpeg command line and its audio filter (`-af` or `-filter_complex`). */
function audioArgs(o: { audio?: typeof music; voice?: typeof voice; sounds?: string }) {
  const args = ffmpegArgs({ ...base, audio: o.audio ?? null, voice: o.voice ?? null, sounds: o.sounds ?? null });
  const inputs = args.slice(args.indexOf('pipe:0') + 1, args.indexOf('-map'));
  const flag = ['-af', '-filter_complex'].find((f) => args.includes(f));
  return { inputs, maps: args.filter((_, i) => args[i - 1] === '-map'), ...(flag && { [flag]: args[args.indexOf(flag) + 1] }) };
}

test('mixes the sounds track into every combination of music and voice, as one more amix input', () => {
  assert.deepEqual(audioArgs({ sounds: 'sounds.wav' }), {
    inputs: ['-i', 'sounds.wav'],
    maps: ['0:v:0', '[audio]'],
    '-filter_complex': `[1:a]aresample=48000[sounds];[sounds]${ending}`,
  });
  assert.deepEqual(audioArgs({ audio: music, sounds: 'sounds.wav' }), {
    inputs: ['-ss', '1.500', '-i', 'music.wav', '-i', 'sounds.wav'],
    maps: ['0:v:0', '[audio]'],
    '-filter_complex': `[1:a]${musicChain}[music];[2:a]aresample=48000[sounds];[music][sounds]amix=inputs=2:duration=longest:normalize=0,${ending}`,
  });
  assert.deepEqual(audioArgs({ voice, sounds: 'sounds.wav' }), {
    inputs: ['-ss', '0.500', '-i', 'voice.wav', '-i', 'sounds.wav'],
    maps: ['0:v:0', '[audio]'],
    '-filter_complex': `[1:a]aresample=48000[voice];[2:a]aresample=48000[sounds];[voice][sounds]amix=inputs=2:duration=longest:normalize=0,${ending}`,
  });
  assert.deepEqual(audioArgs({ audio: music, voice, sounds: 'sounds.wav' }), {
    inputs: ['-ss', '1.500', '-i', 'music.wav', '-ss', '0.500', '-i', 'voice.wav', '-i', 'sounds.wav'],
    maps: ['0:v:0', '[audio]'],
    '-filter_complex': `[1:a]${musicChain},${duck}[music];[2:a]aresample=48000[voice];[3:a]aresample=48000[sounds];[music][voice][sounds]amix=inputs=3:duration=longest:normalize=0,${ending}`,
  });
});

test('keeps the music, voice and music with voice graphs of renders without sounds', () => {
  assert.deepEqual(audioArgs({ audio: music }), {
    inputs: ['-ss', '1.500', '-i', 'music.wav'],
    maps: ['0:v:0', '1:a:0?'],
    '-af': `${musicChain},afade=t=out:st=1.400:d=0.600`,
  });
  assert.deepEqual(audioArgs({ voice }), {
    inputs: ['-ss', '0.500', '-i', 'voice.wav'],
    maps: ['0:v:0', '[audio]'],
    '-filter_complex': `[1:a]aresample=48000[voice];[voice]${ending}`,
  });
  assert.deepEqual(audioArgs({ audio: music, voice }), {
    inputs: ['-ss', '1.500', '-i', 'music.wav', '-ss', '0.500', '-i', 'voice.wav'],
    maps: ['0:v:0', '[audio]'],
    '-filter_complex': `[1:a]${musicChain},${duck}[music];[2:a]aresample=48000[voice];[music][voice]amix=inputs=2:duration=longest:normalize=0,${ending}`,
  });
  assert.deepEqual(audioArgs({}), { inputs: [], maps: ['0:v:0'] });
});
