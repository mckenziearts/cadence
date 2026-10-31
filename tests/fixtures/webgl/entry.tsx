// What tests/server/webgl.test.ts runs in Chromium: the WebGL components, rendered synchronously as the frame renders a
// scene, and what they leave in the drawing buffer. The tests pass plain arrows only: tsx would wrap a function stored in a
// property in a `__name` call the page does not define, so elements and named functions are built here.
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { GLCanvas, type GLCanvasProps } from '../../../src/runtime/gl';
import { THREE, ThreeCanvas } from '../../../src/runtime/three';

let root: Root | undefined;
const errors: string[] = [];

/** Renders `element` (null unmounts it) and returns the messages of the errors the render threw. */
export function show(element: ReactElement | null): string[] {
  root ??= createRoot(document.body.appendChild(document.createElement('div')), {
    onUncaughtError: (error) => errors.push((error as Error).message),
  });
  flushSync(() => root!.render(element));
  return errors.splice(0);
}

/** A GLCanvas of `size` x `size` canvas px at `t`. */
export const glCanvas = (t: number, draw: GLCanvasProps['draw'], size = 32) => (
  <GLCanvas t={t} width={size} height={size} draw={draw} />
);

/** A ThreeCanvas of `size` x `size` canvas px at `t`, drawing the plane of `setupPlane`. */
export const threeCanvas = (t: number, size = 32) => (
  <ThreeCanvas t={t} width={size} height={size} setup={setupPlane} render={renderPlane} />
);

/** The RGBA of the page's canvas at (x, y) device px from its top-left corner, read from its drawing buffer. */
export function pixel(x: number, y: number): number[] {
  const gl = document.querySelector('canvas')!.getContext('webgl2')!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const rgba = new Uint8Array(4);
  gl.readPixels(x, gl.drawingBufferHeight - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  return [...rgba];
}

/** The size of the page's canvas drawing buffer. */
export function bufferSize(): number[] {
  const canvas = document.querySelector('canvas')!;
  return [canvas.width, canvas.height];
}

/** Loses the context of the page's canvas, as the browser does past 16 live contexts. */
export function loseContext(): void {
  document.querySelector('canvas')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
}

const VERTEX = `#version 300 es
uniform float z;
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(corners[gl_VertexID], z, 1.0); }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 color;
out vec4 fragColor;
void main() { fragColor = color; }`;

/** Fills the viewport with `color` at depth `z` (-1 near, 1 far), behind a LESS depth test. */
export function paint(gl: WebGL2RenderingContext, color: number[], z = 0): void {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.uniform1f(gl.getUniformLocation(program, 'z'), z);
  gl.uniform4fv(gl.getUniformLocation(program, 'color'), color);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** State a draw may leave behind that limits the next clear, by name. */
export const leftovers = {
  none: () => {},
  scissor: (gl) => {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, 1);
  },
  colorMask: (gl) => gl.colorMask(false, false, false, false),
  rasterizerDiscard: (gl) => gl.enable(gl.RASTERIZER_DISCARD),
  framebuffer: (gl) => gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer()),
  drawBuffers: (gl) => gl.drawBuffers([gl.NONE]),
  depthMask: (gl) => gl.depthMask(false),
  clearDepth: (gl) => gl.clearDepth(0),
} satisfies Record<string, (gl: WebGL2RenderingContext) => void>;

/** Calls of `setupPlane` and `renderPlane`, and disposals of the renderers `setupPlane` got. */
export const calls = { setups: 0, renders: 0, disposals: 0 };

/** A ThreeCanvas `setup`: a plane over the whole view. */
function setupPlane(renderer: THREE.WebGLRenderer) {
  calls.setups++;
  const dispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    calls.disposals++;
    dispose();
  };
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const material = new THREE.MeshBasicMaterial();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { scene, camera, material };
}

/** A ThreeCanvas `render`: the plane in the sRGB color (t, 0, 1 - t). */
function renderPlane(state: ReturnType<typeof setupPlane>, t: number, renderer: THREE.WebGLRenderer): void {
  calls.renders++;
  state.material.color.setRGB(t, 0, 1 - t, THREE.SRGBColorSpace);
  renderer.render(state.scene, state.camera);
}
