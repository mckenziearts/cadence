// `cadence/three`: three.js for scenes, out of the `cadence` index so a scene that does not import it never loads it.
// The renderer draws only when the scene renders, like GLCanvas: no animation loop.
import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { fitBuffer, GLSurface, webgl2 } from './gl';

export { THREE };

export interface ThreeCanvasProps<S> {
  t: number;
  /** Size in canvas px; the drawing buffer follows the pixel ratio. */
  width: number;
  height: number;
  /** Called once, when the renderer is created: builds the scene, camera and meshes `render` uses. */
  setup: (renderer: THREE.WebGLRenderer) => S;
  /** Called at every render: sets the objects for t, then calls `renderer.render(scene, camera)`. */
  render: (state: S, t: number, renderer: THREE.WebGLRenderer) => void;
}

/** A three.js renderer on a canvas, created on first render and disposed of on unmount. */
export function ThreeCanvas<S>({ t, width, height, setup, render }: ThreeCanvasProps<S>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const three = useRef<{ renderer: THREE.WebGLRenderer; state: S } | null>(null);
  useLayoutEffect(() => {
    fitBuffer(canvas.current!, width, height);
    const context = webgl2(canvas.current!);
    if (!three.current) {
      const renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, context });
      three.current = { renderer, state: setup(renderer) };
    }
    const { renderer, state } = three.current;
    // fitBuffer sizes the buffer: three keeps a pixel ratio of 1 and draws on the whole of it.
    renderer.setViewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight);
    render(state, t, renderer);
  });
  useLayoutEffect(
    () => () => {
      three.current?.renderer.dispose();
      three.current = null;
    },
    [],
  );
  return <GLSurface ref={canvas} width={width} height={height} />;
}
