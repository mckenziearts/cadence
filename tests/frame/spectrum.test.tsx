// The spectrum the frame hands to music.spectrum(): the checked file, the pending error, or nothing without a track.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSpectrum, spectrumFor, spectrumUrl } from '../../src/frame/spectrum';
import type { MusicSpectrum, ProjectMusic } from '../../src/shared/types';

const texts = {
  spectrumFailed: (file: string, reason: string) => `failed ${file}: ${reason}`,
  spectrumSize: (size: number, expected: number) => `${size} of ${expected}`,
  spectrumPending: 'pending',
};
const file: MusicSpectrum = { bands: 24, rate: 25, file: 'music/my track#1.mp3.spectrum.bin', size: 48 };
const music: ProjectMusic = { file: 'music/my track#1.mp3', start: 0, volume: 1, spectrum: file };

test('spectrumUrl: the file under /@fs of the project folder, each segment encoded and the slashes kept', () => {
  assert.equal(spectrumUrl('/home/a/projects/demo', file), '/@fs/home/a/projects/demo/music/my%20track%231.mp3.spectrum.bin');
});

test('readSpectrum: the bytes with the layout of the analysis when the size matches', async () => {
  const bytes = new Uint8Array(48).fill(7);
  assert.deepEqual(await readSpectrum(file, new Response(bytes), texts), { bands: 24, rate: 25, bytes });
});

test('readSpectrum: an HTTP error or a wrong size is a load error naming the file', async () => {
  await assert.rejects(readSpectrum(file, new Response('no', { status: 404 }), texts), {
    message: 'failed music/my track#1.mp3.spectrum.bin: HTTP 404',
  });
  await assert.rejects(readSpectrum(file, new Response(new Uint8Array(47)), texts), {
    message: 'failed music/my track#1.mp3.spectrum.bin: 47 of 48',
  });
});

test('spectrumFor: the loaded spectrum, a MusicAnalysisPending error for a track without one, null without a track', () => {
  const loaded = { bands: 24, rate: 25, bytes: new Uint8Array(48) };
  assert.equal(spectrumFor(music, loaded, texts), loaded);
  const pending = spectrumFor({ ...music, spectrum: null }, null, texts);
  assert.ok(pending instanceof Error);
  assert.equal(pending.name, 'MusicAnalysisPending');
  assert.equal(pending.message, 'pending');
  assert.equal(spectrumFor(null, null, texts), null);
});
