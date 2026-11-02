// What a scene's <Clip src> gets from the frame: the extracted frames of a ready clip, or an error naming the asset.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipSources } from '../../src/frame/clips';
import type { ClipState } from '../../src/shared/types';

const texts = {
  clipUnknown: (file: string) => `unknown ${file}`,
  clipPreparing: (file: string) => `preparing ${file}`,
  clipFailed: (file: string, error: string) => `failed ${file}: ${error}`,
};
const ready: ClipState = {
  status: 'ready',
  key: 'my-loop-000000000000',
  fps: 25,
  frames: 50,
  width: 320,
  height: 240,
  duration: 2,
  audio: false,
};
const clips: Record<string, ClipState> = {
  'loops/my loop#1.gif': ready,
  'intro.mp4': { status: 'preparing' },
  'broken.mov': { status: 'error', error: 'moov atom not found' },
};
const lookup = clipSources('/home/a/projects/demo', clips, texts);

test('clipSources: a ready clip gives its fps, its frame count and the URL of each 0-based frame, numbered from 1', () => {
  const clip = lookup('loops/my loop#1.gif');
  assert.ok(!(clip instanceof Error));
  assert.equal(clip.fps, 25);
  assert.equal(clip.frames, 50);
  assert.equal(clip.url(0), '/@fs/home/a/projects/demo/clips/my-loop-000000000000/000001.jpg');
  assert.equal(clip.url(49), '/@fs/home/a/projects/demo/clips/my-loop-000000000000/000050.jpg');
});

test('clipSources: an unknown, preparing or failed asset is an error naming it, the failed one with its error line', () => {
  const message = (src: string) => {
    const clip = lookup(src);
    assert.ok(clip instanceof Error, src);
    return clip.message;
  };
  assert.equal(message('missing.mp4'), 'unknown missing.mp4');
  assert.equal(message('intro.mp4'), 'preparing intro.mp4');
  assert.equal(message('broken.mov'), 'failed broken.mov: moov atom not found');
  // Not the prototype's: a scene cannot reach Object.prototype through the map.
  assert.equal(message('constructor'), 'unknown constructor');
  assert.equal(message('__proto__'), 'unknown __proto__');
});
