import { spawn } from 'node:child_process';
import path from 'node:path';
import { m } from '../i18n';
import { HttpError } from '../util';

export interface VideoProbe {
  /** Seconds; 0 for a GIF of one untimed image. */
  duration: number;
  width: number;
  height: number;
  fps: number;
  audio: boolean;
}

/**
 * The demuxer each clip extension is read with. Forced so a text playlist (HLS, ffconcat) renamed .mp4 is not opened as
 * one: it would make ffmpeg read other files, or other protocols, at render time.
 */
export const DEMUXERS: Record<string, string> = { mp4: 'mov', mov: 'mov', m4v: 'mov', webm: 'matroska', gif: 'gif' };

/** A clip prints a few kilobytes; a file that makes ffmpeg print more is not one, and is not kept in memory. */
const STDERR_LIMIT = 1024 * 1024;

/** Duration, size, frame rate and audio of a clip, from what `ffmpeg -i` prints; 422 when ffmpeg cannot read it as a video. */
export function probeVideo(
  file: string,
  ffmpegPath: string,
  { name = path.basename(file), timeoutMs = 10_000 }: { name?: string; timeoutMs?: number } = {},
): Promise<VideoProbe> {
  const demuxer = DEMUXERS[path.extname(file).slice(1).toLowerCase()];
  if (!demuxer) return Promise.reject(new HttpError(422, m().media.clips.unreadable(name)));
  // No output file: ffmpeg prints the input and exits 1, so the exit code says nothing and stderr is the answer.
  const args = ['-hide_banner', '-protocol_whitelist', 'file', '-f', demuxer, '-i', path.resolve(file)];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length <= STDERR_LIMIT) return;
      // Closed on our side too: a child ffmpeg started may still hold the pipe after it is killed.
      proc.stderr.destroy();
      proc.kill('SIGKILL');
    });
    proc.on('error', (err) => reject(new Error(m().media.ffmpegStart(ffmpegPath, err.message))));
    proc.on('close', (_code, signal) => {
      // Killed, at the timeout or past the output limit, is a failure whatever ffmpeg printed first.
      const exited = !signal && stderr.length <= STDERR_LIMIT;
      const probe = exited ? parseProbe(stderr, { still: demuxer === 'gif' }) : null;
      if (probe) resolve(probe);
      // A webm written to a pipe (MediaRecorder) states no duration: a remux writes it, so say how rather than refuse it bare.
      else if (exited && parseProbe(stderr, { still: true })) reject(new HttpError(422, m().media.clips.noDuration(name)));
      else reject(new HttpError(422, m().media.clips.unreadable(name)));
    });
  });
}

/**
 * The first input's duration and first video stream, as ffmpeg 7 and 8 print them; null when either is missing. With
 * `still`, `Duration: N/A` is a single image of duration 0: a GIF without a Graphic Control Extension (GIF87a, or a
 * GIF89a that states no delay) has no timing at all. Lines are matched from their leading spaces, never `\s`: in a
 * multiline regex U+2028 both ends a line and is a space, so a metadata value made of it would make each match quadratic.
 * For the same reason `(?!\d)` ends the stream number: otherwise `.*?` rescans the line for each digit `\d+` gives back.
 */
export function parseProbe(stderr: string, { still = false }: { still?: boolean } = {}): VideoProbe | null {
  const duration = /^ *Duration: (?:(\d+):(\d\d):(\d\d(?:\.\d+)?)|(N\/A))/m.exec(stderr);
  const video = /^ *Stream #\d+:\d+(?!\d).*?: Video: (.*)$/m.exec(stderr)?.[1];
  if (!duration || (duration[4] && !still) || !video) return null;
  const size = /, (\d+)x(\d+)(?=[ ,]|$)/.exec(video);
  // tbr is ffmpeg's guess when the container states no frame rate; a "k" value (1k tbn) is a timebase, not a rate.
  const fps = Number((/, ([\d.]+) fps/.exec(video) ?? /, ([\d.]+) tbr/.exec(video))?.[1]);
  if (!size || !(fps > 0)) return null;
  return {
    duration: duration[4] ? 0 : Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: Number(size[1]),
    height: Number(size[2]),
    fps,
    audio: /^ *Stream #\d+:\d+(?!\d).*?: Audio: /m.test(stderr),
  };
}
