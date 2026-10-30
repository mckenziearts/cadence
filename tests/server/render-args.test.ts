// Render outputs: the request defaults, the encoders an ffmpeg build offers, the MP4 arguments kept byte for byte and
// those of WebM, ProRes, GIF, still PNG and PNG sequence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { outputSupport, parseEncoders } from '../../server/capture/encoders';
import { captureWindow, ffmpegArgs, gifArgs, normalizeRequest } from '../../server/capture/render';
import { setLanguage } from '../../server/i18n';
import { HttpError } from '../../server/util';
import type { ProjectState, RenderRequest } from '../../src/shared/types';
import { ENCODERS_FULL, ENCODERS_NO_VPX, fakeFfmpeg } from './helpers';

let dir: string;

beforeEach(async () => {
  setLanguage('en');
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-render-args-'));
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const base = {
  fps: 30,
  width: 1080,
  height: 1350,
  supersample: true,
  crf: 10,
  preset: 'slow',
  duration: 4.5,
  output: '/r/demo.mp4.part',
};
const music = { file: '/m/a.mp3', start: 2, volume: 0.7 };
const SCALE =
  'scale=1080:1350:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
const INPUT = [
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'image2pipe',
  '-framerate',
  '30',
  '-c:v',
  'mjpeg',
  '-i',
  'pipe:0',
];
const H264 = (preset: string, crf: string) => [
  '-c:v',
  'libx264',
  '-preset',
  preset,
  '-crf',
  crf,
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
  '-r',
  '30',
];
const TAIL = ['-t', '4.500000', '-movflags', '+faststart', '-f', 'mp4', '/r/demo.mp4.part'];

test('mp4 arguments without audio are the ones of 0.14.0', () => {
  assert.deepEqual(ffmpegArgs({ ...base, audio: null, voice: null, sounds: null }), [
    ...INPUT,
    '-map',
    '0:v:0',
    '-vf',
    `crop=2160:2700:0:0,${SCALE}`,
    ...H264('slow', '10'),
    ...TAIL,
  ]);
});

test('mp4 arguments with the music alone are the ones of 0.14.0', () => {
  const args = ffmpegArgs({ ...base, supersample: false, crf: 23, preset: 'veryfast', audio: music, voice: null, sounds: null });
  assert.deepEqual(args, [
    ...INPUT,
    '-ss',
    '2.000',
    '-i',
    '/m/a.mp3',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0?',
    '-vf',
    `crop=1080:1350:0:0,${SCALE}`,
    ...H264('veryfast', '23'),
    '-af',
    'aresample=192000,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,volume=0.7,afade=t=out:st=3.900:d=0.600',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    ...TAIL,
  ]);
});

test('mp4 arguments with music, voice-over and sounds are the ones of 0.14.0', () => {
  const voice = { file: '/v/t.wav', start: 1, intervals: [[0.5, 2]] as [number, number][], musicLevel: 0.25 };
  assert.deepEqual(ffmpegArgs({ ...base, audio: music, voice, sounds: '/s/x.wav' }), [
    ...INPUT,
    '-ss',
    '2.000',
    '-i',
    '/m/a.mp3',
    '-ss',
    '1.000',
    '-i',
    '/v/t.wav',
    '-i',
    '/s/x.wav',
    '-map',
    '0:v:0',
    '-vf',
    `crop=2160:2700:0:0,${SCALE}`,
    ...H264('slow', '10'),
    '-filter_complex',
    "[1:a]aresample=192000,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,volume=0.7,volume='1-0.750*clip(min((t-0.250)/0.25,(2.250-t)/0.25),0,1)':eval=frame[music];[2:a]aresample=48000[voice];[3:a]aresample=48000[sounds];[music][voice][sounds]amix=inputs=3:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled,afade=t=out:st=3.900:d=0.600[audio]",
    '-map',
    '[audio]',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    ...TAIL,
  ]);
});

const project = { fps: 60, scenes: [{}] } as ProjectState;

test('a request without output or transparent normalizes as before, as an opaque MP4', () => {
  const req: RenderRequest = { formats: ['16:9', '16:9', '9:16'], quality: 'draft' };
  assert.deepEqual(normalizeRequest(project, req), {
    formats: ['16:9', '9:16'],
    fps: 60,
    scale: 1,
    quality: 'draft',
    supersample: false,
    output: 'mp4',
    transparent: false,
  });
  const ranged: RenderRequest = { ...req, output: 'mp4', transparent: false, range: { from: 1, to: 2 } };
  assert.deepEqual(normalizeRequest(project, ranged).range, { from: 1, to: 2 });
});

test('an output this version cannot render is refused, and so is transparency on an MP4', () => {
  const req: RenderRequest = { formats: ['16:9'], quality: 'draft' };
  assert.throws(
    () => normalizeRequest(project, { ...req, output: 'avi' as never }),
    (e) => e instanceof HttpError && e.status === 400 && e.message === 'Invalid render output: avi',
  );
  assert.throws(
    () => normalizeRequest(project, { ...req, transparent: true }),
    (e) => e instanceof HttpError && e.status === 422 && e.message === 'mp4 has no transparency',
  );
});

test('transparency is accepted on WebM, ProRes, still PNG and PNG sequence, refused on GIF', () => {
  const req: RenderRequest = { formats: ['16:9'], quality: 'draft', transparent: true };
  for (const output of ['webm', 'mov', 'png', 'png-sequence'] as const) {
    assert.deepEqual(normalizeRequest(project, { ...req, output }).output, output);
    assert.equal(normalizeRequest(project, { ...req, output }).transparent, true, output);
  }
  assert.equal(normalizeRequest(project, { ...req, output: 'gif', transparent: false }).output, 'gif');
  assert.throws(
    () => normalizeRequest(project, { ...req, output: 'gif' }),
    (e) => e instanceof HttpError && e.status === 422 && e.message === 'gif has no transparency',
  );
});

const opaque = { audio: null, voice: null, sounds: null };
/** The `-vf` chain from a JPEG (opaque) or a PNG (transparent) screenshot, at twice the size when supersampling. */
const chain = (o: { png: boolean; pixels: string; k?: number }) => {
  const resize = `crop=${1080 * (o.k ?? 2)}:${1350 * (o.k ?? 2)}:0:0,scale=1080:1350:flags=lanczos+accurate_rnd+full_chroma_int`;
  // A PNG with alpha is resized premultiplied, so the transparent pixels' black never darkens the edges.
  const colors = o.png
    ? `format=rgba,premultiply=inplace=1,${resize},unpremultiply=inplace=1,scale=out_color_matrix=bt709:out_range=tv`
    : `${resize}:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv`;
  return `${colors},format=${o.pixels},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;
};
const PNG_INPUT = INPUT.map((arg) => (arg === 'mjpeg' ? 'png' : arg));
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-b:v',
  '0',
  '-crf',
  '31',
  '-deadline',
  'good',
  '-cpu-used',
  '2',
  '-row-mt',
  '1',
  ...TAGS,
  '-r',
  '30',
];
const MUSIC_AF = 'aresample=192000,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,volume=0.7,afade=t=out:st=3.900:d=0.600';

test('webm: VP9 at constant quality and the speed of the preset, yuv420p from JPEG or yuva420p from PNG when transparent', () => {
  const webm = { ...base, crf: 31, preset: '2', output: '/r/demo.webm.part', kind: 'webm' as const };
  const tail = ['-t', '4.500000', '-f', 'webm', '/r/demo.webm.part'];
  assert.deepEqual(ffmpegArgs({ ...webm, ...opaque }), [
    ...INPUT,
    '-map',
    '0:v:0',
    '-vf',
    chain({ png: false, pixels: 'yuv420p' }),
    ...VP9,
    ...tail,
  ]);
  assert.deepEqual(ffmpegArgs({ ...webm, ...opaque, transparent: true }), [
    ...PNG_INPUT,
    '-map',
    '0:v:0',
    '-vf',
    chain({ png: true, pixels: 'yuva420p' }),
    ...VP9,
    ...tail,
  ]);
});

test("webm audio is libopus, or ffmpeg's own opus as an experimental encoder when the build has no libopus", () => {
  const webm = { ...base, crf: 31, kind: 'webm' as const, audio: music, voice: null, sounds: null };
  const audio = (args: string[]) => args.slice(args.indexOf('-af'), args.indexOf('-t'));
  assert.deepEqual(audio(ffmpegArgs({ ...webm, libopus: true })), ['-af', MUSIC_AF, '-c:a', 'libopus', '-b:a', '192k']);
  assert.deepEqual(audio(ffmpegArgs({ ...webm, libopus: false })), [
    '-af',
    MUSIC_AF,
    '-c:a',
    'opus',
    '-strict',
    '-2',
    '-b:a',
    '192k',
  ]);
});

test('mov: ProRes 4444 yuva444p10le when transparent, ProRes 422 HQ (profile 3) yuv422p10le otherwise, PCM audio', () => {
  const mov = { ...base, output: '/r/demo.mov.part', kind: 'mov' as const, audio: music, voice: null, sounds: null };
  const rest = (pixels: string, profile: string) => [
    '-map',
    '1:a:0?',
    '-vf',
    chain({ png: pixels.startsWith('yuva'), pixels }),
    '-c:v',
    'prores_ks',
    '-profile:v',
    profile,
    ...TAGS,
    '-r',
    '30',
    '-af',
    MUSIC_AF,
    '-c:a',
    'pcm_s16le',
    '-t',
    '4.500000',
    '-f',
    'mov',
    '/r/demo.mov.part',
  ];
  const withMusic = ['-ss', '2.000', '-i', '/m/a.mp3', '-map', '0:v:0'];
  assert.deepEqual(ffmpegArgs(mov), [...INPUT, ...withMusic, ...rest('yuv422p10le', '3')]);
  assert.deepEqual(ffmpegArgs({ ...mov, transparent: true }), [...PNG_INPUT, ...withMusic, ...rest('yuva444p10le', '4444')]);
});

test('gif: lossless frames first, without audio even with music, voice and sounds', () => {
  const voice = { file: '/v/t.wav', start: 1, intervals: [[0.5, 2]] as [number, number][], musicLevel: 0.25 };
  const args = ffmpegArgs({ ...base, output: '/r/demo.gif.frames.part', kind: 'gif', audio: music, voice, sounds: '/s/x.wav' });
  assert.deepEqual(args, [
    ...INPUT,
    '-map',
    '0:v:0',
    '-vf',
    'crop=2160:2700:0:0,scale=1080:1350:flags=lanczos+accurate_rnd+full_chroma_int',
    '-c:v',
    'ffv1',
    '-r',
    '30',
    '-t',
    '4.500000',
    '-f',
    'matroska',
    '/r/demo.gif.frames.part',
  ]);
});

test('gif: one palette per video from the frame differences, read from the frames file rather than kept in memory', () => {
  assert.deepEqual(gifArgs('/r/demo.gif.frames.part', '/r/demo.gif.part'), [
    ...['-y', '-hide_banner', '-loglevel', 'error', '-i', '/r/demo.gif.frames.part', '-i', '/r/demo.gif.frames.part'],
    '-filter_complex',
    '[0:v]tpad=stop=1:color=black,tpad=stop=1:color=white,palettegen=stats_mode=diff[p];[1:v][p]paletteuse',
    ...['-c:v', 'gif', '-f', 'gif', '/r/demo.gif.part'],
  ]);
});

test('gif: above 50 fps every second or third frame is kept, so no frame delay falls under 2 hundredths', () => {
  const rate = (fps: number, kind: 'gif' | 'mp4' = 'gif') => {
    const args = ffmpegArgs({ ...base, ...opaque, fps, kind });
    return args[args.indexOf('-r') + 1];
  };
  assert.deepEqual(
    [24, 30, 50, 60, 100, 120, 51].map((fps) => rate(fps)),
    ['24', '30', '50', '30', '50', '40', '51/2'],
  );
  assert.equal(rate(60, 'mp4'), '60');
});

test('png: one frame in RGB from a PNG screenshot, or RGBA resized premultiplied when transparent, without audio', () => {
  const png = { ...base, output: '/r/demo.png.part', kind: 'png' as const, audio: music, voice: null, sounds: '/s/x.wav' };
  const resize = 'crop=2160:2700:0:0,scale=1080:1350:flags=lanczos+accurate_rnd+full_chroma_int';
  const rest = [
    '-c:v',
    'png',
    '-r',
    '30',
    '-t',
    '4.500000',
    '-frames:v',
    '1',
    '-update',
    '1',
    '-f',
    'image2',
    '/r/demo.png.part',
  ];
  assert.deepEqual(ffmpegArgs(png), [...PNG_INPUT, '-map', '0:v:0', '-vf', `${resize},format=rgb24`, ...rest]);
  assert.deepEqual(ffmpegArgs({ ...png, transparent: true }), [
    ...PNG_INPUT,
    '-map',
    '0:v:0',
    '-vf',
    `format=rgba,premultiply=inplace=1,${resize},unpremultiply=inplace=1,format=rgba`,
    ...rest,
  ]);
});

test('png-sequence: numbered PNG frames from 000001.png into the folder, without audio', () => {
  const sequence = { ...base, ...opaque, output: '/r/demo.part', kind: 'png-sequence' as const, supersample: false };
  assert.deepEqual(ffmpegArgs({ ...sequence, audio: music }), [
    ...PNG_INPUT,
    '-map',
    '0:v:0',
    '-vf',
    'crop=1080:1350:0:0,scale=1080:1350:flags=lanczos+accurate_rnd+full_chroma_int,format=rgb24',
    ...['-c:v', 'png', '-r', '30', '-t', '4.500000', '-f', 'image2', '/r/demo.part/%06d.png'],
  ]);
  const vf = (args: string[]) => args[args.indexOf('-vf') + 1];
  assert.equal(
    vf(ffmpegArgs({ ...sequence, transparent: true })),
    vf(ffmpegArgs({ ...sequence, kind: 'png', transparent: true })),
  );
  assert.equal(ffmpegArgs({ ...sequence, output: '/r/50%d off/demo.part' }).at(-1), '/r/50%%d off/demo.part/%06d.png');
});

test('every output crops to the canvas then scales down to the output size, twice the size when supersampling', () => {
  for (const kind of ['mp4', 'webm', 'mov', 'gif', 'png', 'png-sequence'] as const) {
    for (const supersample of [false, true]) {
      const args = ffmpegArgs({ ...base, ...opaque, kind, supersample });
      const vf = args[args.indexOf('-vf') + 1];
      const k = supersample ? 2 : 1;
      assert.ok(vf.startsWith(`crop=${1080 * k}:${1350 * k}:0:0,scale=1080:1350:flags=lanczos`), `${kind} ${supersample}: ${vf}`);
    }
  }
});

test('the encoders list is read from the lines after the legend', () => {
  const encoders = parseEncoders(ENCODERS_FULL);
  assert.ok(encoders.has('libx264') && encoders.has('libvpx-vp9') && encoders.has('opus') && encoders.has('prores_ks'));
  assert.ok(!encoders.has('='), 'legend lines are not encoders');
  assert.ok(!parseEncoders(ENCODERS_NO_VPX).has('libvpx-vp9'));
  assert.deepEqual([...parseEncoders('no list')], []);
});

test('a build with libvpx offers every output', async () => {
  const bin = await fakeFfmpeg(path.join(dir, 'ffmpeg'), ENCODERS_FULL);
  const support = await outputSupport(bin);
  assert.deepEqual(Object.keys(support), ['mp4', 'webm', 'mov', 'gif', 'png', 'png-sequence']);
  for (const output of Object.values(support)) assert.deepEqual(output, { available: true });
});

test('a build without libvpx offers everything but WebM, and says why', async () => {
  const support = await outputSupport(await fakeFfmpeg(path.join(dir, 'ffmpeg'), ENCODERS_NO_VPX));
  assert.deepEqual(support.webm, { available: false, reason: 'The ffmpeg in use has no libvpx-vp9 encoder' });
  for (const output of ['mp4', 'mov', 'gif', 'png', 'png-sequence'] as const) assert.equal(support[output].available, true);
});

test('WebM takes the native opus encoder when libopus is missing', async () => {
  const encoders = ENCODERS_FULL.replace(/^.*libopus .*\n/m, '');
  assert.equal((await outputSupport(await fakeFfmpeg(path.join(dir, 'ffmpeg'), encoders))).webm.available, true);
  const neither = encoders.replace(/^.* opus .*\n/m, '');
  assert.deepEqual((await outputSupport(await fakeFfmpeg(path.join(dir, 'other'), neither))).webm, {
    available: false,
    reason: 'The ffmpeg in use has no libopus encoder',
  });
});

test('a build without libx264 or aac offers no MP4, naming both', async () => {
  const encoders = ENCODERS_FULL.replace(/^.* (libx264|aac) .*\n/gm, '');
  const support = await outputSupport(await fakeFfmpeg(path.join(dir, 'ffmpeg'), encoders));
  assert.deepEqual(support.mp4, { available: false, reason: 'The ffmpeg in use has no libx264 or aac encoder' });
});

test('-encoders runs once per ffmpeg path', async () => {
  const one = await fakeFfmpeg(path.join(dir, 'one'), ENCODERS_FULL);
  const two = await fakeFfmpeg(path.join(dir, 'two'), ENCODERS_NO_VPX);
  await Promise.all([outputSupport(one), outputSupport(one), outputSupport(two)]);
  await outputSupport(one);
  setLanguage('fr');
  assert.deepEqual((await outputSupport(two)).webm, {
    available: false,
    reason: 'Le ffmpeg utilisé n’a pas d’encodeur libvpx-vp9',
  });
  assert.equal(await fs.readFile(`${one}.calls`, 'utf8'), 'run\n');
  assert.equal(await fs.readFile(`${two}.calls`, 'utf8'), 'run\n');
});

test('a missing ffmpeg offers nothing, and is looked for again once installed', async () => {
  const bin = path.join(dir, 'later');
  const missing = await outputSupport(bin);
  assert.deepEqual(missing.mp4, { available: false, reason: `ffmpeg not found (${bin})` });
  assert.equal(missing.png.available, false);
  await fakeFfmpeg(bin, ENCODERS_FULL);
  assert.equal((await outputSupport(bin)).mp4.available, true);
});

test('reads the encoders again when the build at the same path is replaced', async () => {
  const bin = await fakeFfmpeg(path.join(dir, 'ffmpeg'), ENCODERS_FULL.replace(/^.* (libx264|aac) .*\n/gm, ''));
  assert.equal((await outputSupport(bin)).mp4.available, false);
  await fakeFfmpeg(bin, ENCODERS_FULL);
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(bin, later, later);
  assert.equal((await outputSupport(bin)).mp4.available, true);
  assert.equal(await fs.readFile(`${bin}.calls`, 'utf8'), 'run\nrun\n');
});

test('a bare ffmpeg name is looked up on PATH, so replacing that build is noticed too', async (t) => {
  const bin = await fakeFfmpeg(path.join(dir, 'cadence-test-ffmpeg'), ENCODERS_FULL.replace(/^.* (libx264|aac) .*\n/gm, ''));
  const PATH = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${PATH}`;
  t.after(() => void (process.env.PATH = PATH));
  assert.equal((await outputSupport('cadence-test-ffmpeg')).mp4.available, false);
  await fakeFfmpeg(bin, ENCODERS_FULL);
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(bin, later, later);
  assert.equal((await outputSupport('cadence-test-ffmpeg')).mp4.available, true);
});

test('PNG frames (transparent) capture ahead of ffmpeg within 256 MB at 1.7 bytes a pixel, JPEG ones 16 per page', () => {
  assert.deepEqual(captureWindow(4, false, 7680 * 4320), { frames: 64, block: 8 });
  // A 1080p PNG weighs at most about 3.5 MB: the full window.
  assert.deepEqual(captureWindow(4, true, 1920 * 1080), { frames: 64, block: 8 });
  // 4K: 14 MB a frame, 18 of them, so 4 pages take blocks of 4 and stay inside the window.
  assert.deepEqual(captureWindow(4, true, 3840 * 2160), { frames: 18, block: 4 });
  // Scale 2 supersampled: a 7680 x 4320 capture of up to 56 MB, 4 frames, one per page.
  assert.deepEqual(captureWindow(4, true, 7680 * 4320), { frames: 4, block: 1 });
  // Never fewer than one frame per page.
  assert.deepEqual(captureWindow(4, true, 15360 * 8640), { frames: 4, block: 1 });
});
