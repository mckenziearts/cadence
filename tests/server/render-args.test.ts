// Render outputs: the request defaults, the encoders an ffmpeg build offers, and the MP4 arguments kept byte for byte.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { outputSupport, parseEncoders } from '../../server/capture/encoders';
import { ffmpegArgs, normalizeRequest } from '../../server/capture/render';
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
  assert.throws(() => normalizeRequest(project, { ...req, output: 'webm' }), { status: 400 });
  assert.throws(
    () => normalizeRequest(project, { ...req, transparent: true }),
    (e) => e instanceof HttpError && e.status === 422 && e.message === 'mp4 has no transparency',
  );
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
