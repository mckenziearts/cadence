// Stand-in for the `cadence` module (src/runtime) in the frame e2e harness: the frame page only needs these exports,
// and frame tests should not break when the real runtime changes.
import { createContext } from 'react';
import { createMusic as createRuntimeMusic, type CreateMusicInput } from '../../../src/runtime/music';

// The real one: the frame tests draw it through the capture path.
export { GLCanvas } from '../../../src/runtime/gl';

export const SceneContext = createContext<unknown>(null);
export const BrandContext = createContext<unknown>(null);

let assetBase = '';

export function setAssetBase(base: string) {
  assetBase = base;
}

export function asset(file: string): string {
  return assetBase + file;
}

export function createMusic(input: CreateMusicInput) {
  const beatLength = 60 / input.tempo;
  return {
    hasTrack: input.grid !== null,
    bpm: input.tempo,
    beatLength,
    sceneStart: input.sceneStart,
    // The real runtime without a track: a steady grid that starts with the scene.
    beat: (n: number) => n * beatLength,
    // The real one: the frame tests check what the frame loads for it.
    spectrum: createRuntimeMusic(input).spectrum,
  };
}

// The real component: its e2e test measures the pixels it composites.
export { MotionBlur } from '../../../src/runtime/motionBlur';

// The real component and context: the frame provides the clips, and the frame tests capture what it shows.
export { Clip, ClipContext } from '../../../src/runtime/clip';
