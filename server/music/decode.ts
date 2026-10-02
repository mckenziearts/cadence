// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { m } from '../i18n';

export const ANALYSIS_SAMPLE_RATE = 22050;
// The analysis holds about 1 MB per second of audio (spectrograms), so only the first 10 minutes are decoded (a 200 MB
// MP3 can be hours long). Streaming the features would lift that limit.
const MAX_SECONDS = 600;

/** Decode the first 10 minutes of any audio/video file to mono float32 PCM at `sampleRate` using ffmpeg. */
export function decodeAudio(filePath: string, ffmpegPath: string, sampleRate = ANALYSIS_SAMPLE_RATE): Promise<Float32Array> {
  // An absolute path keeps ffmpeg from reading names like "pipe:0" or "concat:..." as protocols.
  const input = path.resolve(filePath);
  const args = ['-v', 'error', '-nostdin', '-i', input, '-t', String(MAX_SECONDS), '-vn', '-ac', '1', '-ar', String(sampleRate)];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [...args, '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(new Error(m().media.ffmpegStart(ffmpegPath, err.message))));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(m().media.music.decodeFailed(path.basename(input), code, stderr.trim().slice(0, 500))));
        return;
      }
      // Copy into a fresh, 4-byte-aligned buffer before viewing as float32.
      const usable = bytes - (bytes % 4);
      const aligned = new ArrayBuffer(usable);
      const view = new Uint8Array(aligned);
      let offset = 0;
      for (const chunk of chunks) {
        const take = Math.min(chunk.length, usable - offset);
        if (take <= 0) break;
        view.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
        offset += take;
      }
      resolve(new Float32Array(aligned));
    });
  });
}
