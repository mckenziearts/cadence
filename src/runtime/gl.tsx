// WebGL in scenes. Drawing happens in a layout effect, which the frame runs inside its synchronous render: a capture at
// t shows the pixels drawn for t, with no animation loop. The drawing buffer is kept for the screenshot that follows.
import { useLayoutEffect, useRef, type RefObject } from 'react';

// The runtime cannot import the frame's dictionaries (they read the document on load, and node tests import the
// runtime): the frame page gives its language in <html lang> like the rest of the frame.
const TEXTS = {
  fr: {
    unavailable: 'WebGL2 n’est pas disponible dans ce navigateur : GLCanvas et ThreeCanvas ne peuvent pas dessiner.',
    lost: 'Le contexte WebGL a été perdu : 16 contextes WebGL au plus restent actifs par page, le plus ancien se perd au-delà.',
  },
  en: {
    unavailable: 'WebGL2 is not available in this browser: GLCanvas and ThreeCanvas cannot draw.',
    lost: 'The WebGL context was lost: 16 WebGL contexts at most stay live per page, the oldest is lost beyond that.',
  },
};

/** The canvas's WebGL2 context, or a translated error when there is none or it was lost. */
export function webgl2(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const texts = TEXTS[document.documentElement.lang === 'en' ? 'en' : 'fr'];
  // From a pixel ratio of 2 (2x renders, supersampled ones that ffmpeg scales down again), edges already get 2 device px
  // per canvas px: multisampling would cost about 4x the drawing for nothing.
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: devicePixelRatio < 2 });
  if (!gl) throw new Error(texts.unavailable);
  if (gl.isContextLost()) throw new Error(texts.lost);
  return gl;
}

/**
 * Sizes the drawing buffer to the `width` x `height` canvas px as shown, times the pixel ratio: a 2x render stays sharp,
 * and the preview, scaled down to fit its pane, does not draw pixels it never shows. A canvas scaled up keeps its own
 * size, so a zoom on it cannot grow the buffer past what the GPU allows.
 */
export function fitBuffer(canvas: HTMLCanvasElement, width: number, height: number): void {
  const scale = Math.min(1, canvas.getBoundingClientRect().width / width) * devicePixelRatio;
  const [w, h] = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
  // Setting either size clears the buffer, even to the same value: only a real change pays for it.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

/** A canvas of `width` x `height` canvas px, whose WebGL context is lost when it unmounts. */
export function GLSurface({ ref, width, height }: { ref: RefObject<HTMLCanvasElement | null>; width: number; height: number }) {
  useLayoutEffect(() => {
    const canvas = ref.current;
    // The frame mounts the scene again at every cut and code change, in the same page: a context left to the garbage
    // collector keeps its buffers, and counts towards the 16 live contexts, until the browser drops the oldest.
    return () => canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  }, [ref]);
  return <canvas ref={ref} style={{ display: 'block', width, height }} />;
}

export interface GLCanvasProps {
  t: number;
  /** Size in canvas px; the drawing buffer is `gl.drawingBufferWidth` x `gl.drawingBufferHeight` device px. */
  width: number;
  height: number;
  /** Called at every render on a cleared buffer, the viewport set to the whole of it: a pure function of t. */
  draw: (gl: WebGL2RenderingContext, t: number) => void;
}

/** A WebGL2 canvas drawn by `draw(gl, t)` at every render. */
export function GLCanvas({ t, width, height, draw }: GLCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    fitBuffer(canvas.current!, width, height);
    const gl = webgl2(canvas.current!);
    // The buffer is preserved and capture pages are reused between seeks: what an earlier t drew must not stay, whatever
    // state its draw left that limits a clear.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawBuffers([gl.BACK]);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    draw(gl, t);
  });
  return <GLSurface ref={canvas} width={width} height={height} />;
}
