// Stand-in for the `cadence` module (src/runtime) in the frame e2e harness: the frame page only needs these exports,
// and frame tests should not break when the real runtime changes.
import { createContext } from 'react';

export const SceneContext = createContext<unknown>(null);
export const BrandContext = createContext<unknown>(null);

let assetBase = '';

export function setAssetBase(base: string) {
  assetBase = base;
}

export function asset(file: string): string {
  return assetBase + file;
}

export function createMusic(input: {
  grid: unknown;
  tempo: number;
  musicStart: number;
  sceneStart: number;
  sceneDuration: number;
}) {
  return { hasTrack: input.grid !== null, bpm: input.tempo, beatLength: 60 / input.tempo, sceneStart: input.sceneStart };
}
