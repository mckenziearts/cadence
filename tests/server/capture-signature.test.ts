// Thumbnails and seam checks are cached under the scene signature: what a scene shows must move it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sceneSignature } from '../../server/capture/capture';
import type { ClipState, ProjectState, SceneState } from '../../src/shared/types';

const scene = { id: 'intro', name: 'Intro', index: 0, start: 0, duration: 4, codeVersion: 'abc' } as SceneState;
const ready = (key: string): ClipState => ({
  status: 'ready',
  key,
  fps: 30,
  frames: 30,
  width: 320,
  height: 240,
  duration: 1,
  audio: false,
});
const project = (clips: Record<string, ClipState>) =>
  ({
    scenes: [scene],
    fps: 30,
    tempo: 120,
    brand: null,
    language: null,
    music: null,
    musicGrid: null,
    clips,
  }) as unknown as ProjectState;
const signature = (clips: Record<string, ClipState>) => sceneSignature(project(clips), scene);

describe('sceneSignature', () => {
  test('stays the same while the clips do', () => {
    assert.equal(signature({ 'clip.mp4': ready('clip-1a2b') }), signature({ 'clip.mp4': ready('clip-1a2b') }));
  });

  test('moves when an asset is replaced: its clip gets a new key', () => {
    assert.notEqual(signature({ 'clip.mp4': ready('clip-1a2b') }), signature({ 'clip.mp4': ready('clip-9f8e') }));
  });

  test('moves when a clip becomes ready, fails, or appears', () => {
    const states = [
      signature({}),
      signature({ 'clip.mp4': { status: 'preparing' } }),
      signature({ 'clip.mp4': { status: 'error', error: 'x' } }),
      signature({ 'clip.mp4': ready('clip-1a2b') }),
    ];
    assert.equal(new Set(states).size, states.length);
  });
});
