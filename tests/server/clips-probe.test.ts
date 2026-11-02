import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { parseProbe, probeVideo } from '../../server/clips/probe';
import { rejectsWithStatus } from './helpers';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg introuvable';

// Captured from ffmpeg 8.1 on clips made with lavfi.
const FFMPEG8_MP4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/p/assets/a.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf62.12.100
  Duration: 00:00:02.00, start: 0.000000, bitrate: 130 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 45 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      encoder         : Lavc62.28.100 libx264
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
At least one output file must be specified
`;
const FFMPEG8_WEBM = `Input #0, matroska,webm, from '/p/assets/b.webm':
  Metadata:
    ENCODER         : Lavf62.12.100
  Duration: 00:00:01.52, start: 0.000000, bitrate: 42 kb/s
  Stream #0:0: Video: vp9 (Profile 1), gbrp(pc, gbr/unknown/unknown, progressive), 160x90, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 1k tbn
    Metadata:
      ENCODER         : Lavc62.28.100 libvpx-vp9
      DURATION        : 00:00:01.520000000
At least one output file must be specified
`;
const FFMPEG8_GIF = `Input #0, gif, from '/p/assets/c.gif':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 88 kb/s
  Stream #0:0: Video: gif, bgra, 100x80 [SAR 64:64 DAR 5:4], 10 fps, 10 tbr, 100 tbn
At least one output file must be specified
`;
// GIF87a, or GIF89a without a Graphic Control Extension: one image, no delay, so no duration and no fps.
const FFMPEG8_GIF_STILL = `Input #0, gif, from '/p/assets/pixel.gif':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: gif, bgra, 1x1, 100 tbr, 100 tbn
At least one output file must be specified
`;
// A webm written to a pipe (MediaRecorder, ffmpeg -f webm -): the muxer could not seek back to write the duration.
const FFMPEG8_WEBM_STREAMED = `Input #0, matroska,webm, from '/p/assets/stream.webm':
  Metadata:
    ENCODER         : Lavf62.12.100
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: vp8, yuv420p(tv, progressive), 64x48, SAR 1:1 DAR 4:3, 10 fps, 10 tbr, 1k tbn
    Metadata:
      ENCODER         : Lavc62.28.100 libvpx
  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp
At least one output file must be specified
`;
const FFMPEG8_MOV_NTSC = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/p/assets/d.mov':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 27 kb/s
  Stream #0:0[0x1]: Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive), 64x48 [SAR 1:1 DAR 4:3], 18 kb/s, 23.98 fps, 23.98 tbr, 24k tbn (default)
At least one output file must be specified
`;
// ffmpeg 7.1 layout (deeper stream metadata, side data): an iPhone clip, HEVC, rotated, with a timed metadata track.
const FFMPEG7_IPHONE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/p/assets/iphone.mov':
  Metadata:
    major_brand     : qt
    minor_version   : 0
    compatible_brands: qt
    creation_time   : 2025-03-14T09:12:44.000000Z
    com.apple.quicktime.make: Apple
    com.apple.quicktime.model: iPhone 15
  Duration: 00:01:07.43, start: 0.000000, bitrate: 10342 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 10101 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Metadata:
        creation_time   : 2025-03-14T09:12:44.000000Z
        handler_name    : Core Media Video
        vendor_id       : [0][0][0][0]
        encoder         : HEVC
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 186 kb/s (default)
      Metadata:
        creation_time   : 2025-03-14T09:12:44.000000Z
        handler_name    : Core Media Audio
        vendor_id       : [0][0][0][0]
  Stream #0:2[0x3](und): Data: none (mebx / 0x7862656D), 0 kb/s (default)
      Metadata:
        handler_name    : Core Media Metadata
At least one output file must be specified
`;
const FFMPEG7_GIF = `Input #0, gif, from '/p/assets/loader.gif':
  Duration: 00:00:02.40, start: 0.000000, bitrate: 312 kb/s
  Stream #0:0: Video: gif, bgra, 480x270, 12.50 fps, 12.50 tbr, 100 tbn
At least one output file must be specified
`;
const REFUSED = `[in#0 @ 0xc73020000] moov atom not found
[in#0 @ 0xc7301c000] Error opening input: Invalid data found when processing input
Error opening input file /p/assets/hls.mp4.
Error opening input files: Invalid data found when processing input
`;

test('parseProbe: duration, size, fps and audio from ffmpeg 8 stderr', () => {
  assert.deepEqual(parseProbe(FFMPEG8_MP4), { duration: 2, width: 320, height: 240, fps: 30, audio: true });
  assert.deepEqual(parseProbe(FFMPEG8_WEBM), { duration: 1.52, width: 160, height: 90, fps: 25, audio: false });
  assert.deepEqual(parseProbe(FFMPEG8_GIF), { duration: 1, width: 100, height: 80, fps: 10, audio: false });
  assert.deepEqual(parseProbe(FFMPEG8_MOV_NTSC), { duration: 1, width: 64, height: 48, fps: 23.98, audio: false });
});

test('parseProbe: ffmpeg 7 stderr, hours and minutes in the duration, a data track is not audio', () => {
  assert.deepEqual(parseProbe(FFMPEG7_IPHONE), { duration: 67.43, width: 1920, height: 1080, fps: 29.97, audio: true });
  assert.deepEqual(parseProbe(FFMPEG7_GIF), { duration: 2.4, width: 480, height: 270, fps: 12.5, audio: false });
  assert.deepEqual(parseProbe(FFMPEG8_MP4.replace('00:00:02.00', '01:02:03.50'))?.duration, 3723.5);
});

test('parseProbe: with still, an untimed GIF is one image of duration 0; without, it is not a video', () => {
  assert.deepEqual(parseProbe(FFMPEG8_GIF_STILL, { still: true }), { duration: 0, width: 1, height: 1, fps: 100, audio: false });
  assert.equal(parseProbe(FFMPEG8_GIF_STILL), null);
  assert.equal(parseProbe(FFMPEG8_MP4.replace('00:00:02.00', 'N/A')), null);
  assert.equal(parseProbe(REFUSED, { still: true }), null);
  assert.deepEqual(parseProbe(FFMPEG8_GIF, { still: true })?.duration, 1);
});

test('parseProbe: a webm written to a pipe states no duration and is not a video', () => {
  assert.equal(parseProbe(FFMPEG8_WEBM_STREAMED), null);
});

test('parseProbe: no input, no duration, no video stream or no frame rate is not a video', () => {
  assert.equal(parseProbe(REFUSED), null);
  assert.equal(parseProbe(FFMPEG8_MP4.replace('00:00:02.00', 'N/A')), null);
  assert.equal(parseProbe(FFMPEG8_MP4.replace(/^ {2}Stream #0:0.*\n/m, '')), null, 'audio only');
  assert.equal(parseProbe(FFMPEG8_GIF.replace('10 fps, 10 tbr', '1k tbn')), null);
  assert.equal(parseProbe(FFMPEG8_GIF.replace('10 fps, ', ''))?.fps, 10, 'tbr when fps is missing');
});

test('parseProbe: a metadata value of U+2028, a line end that is also a space, is read in linear time', () => {
  const started = Date.now();
  const stderr = `    title           : ${'\u2028'.repeat(100_000)}\n${FFMPEG8_MP4}`;
  assert.deepEqual(parseProbe(stderr), { duration: 2, width: 320, height: 240, fps: 30, audio: true });
  assert.ok(Date.now() - started < 1000, `read in ${Date.now() - started} ms`);
});

test('parseProbe: a metadata value that starts a stream line of endless digits is read in linear time', () => {
  const started = Date.now();
  const stderr = `    title           : x Stream #0:0${'1'.repeat(100_000)}\n${FFMPEG8_MP4}`;
  assert.deepEqual(parseProbe(stderr), { duration: 2, width: 320, height: 240, fps: 30, audio: true });
  assert.ok(Date.now() - started < 1000, `read in ${Date.now() - started} ms`);
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-probe-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

/** A stand-in ffmpeg that records its arguments and answers `stderr`, or hangs. */
async function fakeFfmpeg(script: string): Promise<string> {
  const bin = path.join(dir, 'ffmpeg');
  await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test('probeVideo forces the demuxer from the extension and only the file protocol', async () => {
  await fs.writeFile(path.join(dir, 'stderr.txt'), FFMPEG8_MP4);
  const bin = await fakeFfmpeg(`printf '%s\\n' "$@" > "${dir}/args.txt"; cat "${dir}/stderr.txt" >&2; exit 1`);
  const cases: [string, string][] = [
    ['a.mp4', 'mov'],
    ['a.MOV', 'mov'],
    ['a.m4v', 'mov'],
    ['a.webm', 'matroska'],
    ['a.gif', 'gif'],
  ];
  for (const [name, demuxer] of cases) {
    const file = path.join(dir, name);
    assert.deepEqual(await probeVideo(file, bin), { duration: 2, width: 320, height: 240, fps: 30, audio: true });
    assert.deepEqual((await fs.readFile(path.join(dir, 'args.txt'), 'utf8')).trim().split('\n'), [
      '-hide_banner',
      '-protocol_whitelist',
      'file',
      '-f',
      demuxer,
      '-i',
      file,
    ]);
  }
});

test('probeVideo: unreadable output answers 422, and a hung ffmpeg is killed at the timeout', async () => {
  await fs.writeFile(path.join(dir, 'stderr.txt'), REFUSED);
  const refusing = await fakeFfmpeg(`cat "${dir}/stderr.txt" >&2; exit 1`);
  await rejectsWithStatus(probeVideo(path.join(dir, 'a.mp4'), refusing), 422, /a\.mp4.*ffmpeg/);
  await rejectsWithStatus(probeVideo(path.join(dir, 'a.avi'), path.join(dir, 'absent')), 422, /a\.avi/);
  await fs.writeFile(path.join(dir, 'streamed.txt'), FFMPEG8_WEBM_STREAMED);
  const streamed = await fakeFfmpeg(`cat "${dir}/streamed.txt" >&2; exit 1`);
  await rejectsWithStatus(probeVideo(path.join(dir, 'a.webm'), streamed), 422, /a\.webm.*durée.*-c copy/);
  // The header is printed, then ffmpeg hangs: killed is a failure, whatever it printed first.
  await fs.writeFile(path.join(dir, 'header.txt'), FFMPEG8_MP4);
  const hung = await fakeFfmpeg(`cat "${dir}/header.txt" >&2; exec sleep 30`);
  const started = Date.now();
  await rejectsWithStatus(probeVideo(path.join(dir, 'a.mp4'), hung, { timeoutMs: 200 }), 422, /pas une vidéo/);
  assert.ok(Date.now() - started < 5000, 'killed, not waited for');
});

test('probeVideo: an ffmpeg that prints without end is killed past 1 MiB of output, whatever it printed first', async () => {
  const flooding = await fakeFfmpeg(`cat "${dir}/header.txt" >&2; exec yes '    comment         : padding' >&2`);
  await fs.writeFile(path.join(dir, 'header.txt'), FFMPEG8_MP4);
  const started = Date.now();
  await rejectsWithStatus(probeVideo(path.join(dir, 'a.mp4'), flooding), 422, /pas une vidéo/);
  assert.ok(Date.now() - started < 5000, 'killed at the output limit, not at the timeout');
});

test('probeVideo: past 1 MiB, what an exited ffmpeg started and still prints on its stderr is cut off and refused', async () => {
  await fs.writeFile(path.join(dir, 'header.txt'), FFMPEG8_MP4);
  // The script exits at once, so no signal ends the probe, and nothing ends the printing but the pipe closing.
  const exited = await fakeFfmpeg(`(cat "${dir}/header.txt"; exec yes '    comment         : padding') >&2 & exit 1`);
  await rejectsWithStatus(probeVideo(path.join(dir, 'a.mp4'), exited), 422, /pas une vidéo/);
});

test('probeVideo: an ffmpeg that cannot start is an error naming it, not a 422 on the clip', async () => {
  const absent = path.join(dir, 'absent');
  await assert.rejects(probeVideo(path.join(dir, 'a.mp4'), absent), (e: Error & { status?: number }) => {
    assert.equal(e.status, undefined);
    assert.ok(e.message.includes(`ffmpeg (${absent})`), e.message);
    return true;
  });
});

test('probeVideo with the real ffmpeg: clips read, an HLS or concat text renamed .mp4 is refused', { skip }, async () => {
  const make = (name: string, ...args: string[]) => {
    const res = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, path.join(dir, name)]);
    assert.equal(res.status, 0, res.stderr.toString());
    return path.join(dir, name);
  };
  const lavfi = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1'];
  const mp4 = make('clip.mp4', ...lavfi, '-f', 'lavfi', '-i', 'sine=duration=1', '-pix_fmt', 'yuv420p', '-shortest');
  const probed = await probeVideo(mp4, 'ffmpeg');
  assert.deepEqual(
    { ...probed, duration: Math.round(probed.duration) },
    { duration: 1, width: 320, height: 240, fps: 30, audio: true },
  );
  assert.equal((await probeVideo(make('loop.gif', ...lavfi), 'ffmpeg')).audio, false);
  const segment = make('seg.ts', '-i', mp4, '-c', 'copy');

  const hls = path.join(dir, 'playlist.mp4');
  await fs.writeFile(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n${path.basename(segment)}\n#EXT-X-ENDLIST\n`);
  await rejectsWithStatus(probeVideo(hls, 'ffmpeg'), 422, /pas une vidéo/);
  // With its duration stated, the list probes as a 1 s clip when ffmpeg guesses the format: only the forced demuxer refuses it.
  const concat = path.join(dir, 'list.mp4');
  await fs.writeFile(concat, `ffconcat version 1.0\nfile '${path.basename(mp4)}'\nduration 1\n`);
  await rejectsWithStatus(probeVideo(concat, 'ffmpeg'), 422, /pas une vidéo/);
  const renamed = path.join(dir, 'clip.webm');
  await fs.copyFile(mp4, renamed);
  await rejectsWithStatus(probeVideo(renamed, 'ffmpeg'), 422, /clip\.webm/);
});
