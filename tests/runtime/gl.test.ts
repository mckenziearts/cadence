import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fitBuffer, webgl2 } from '../../src/runtime/gl';

const realDocument = globalThis.document;

afterEach(() => {
  globalThis.document = realDocument;
  Reflect.deleteProperty(globalThis, 'devicePixelRatio');
});

/** A page in `lang` at pixel ratio `ratio`. */
function inPage(lang: string, ratio = 1): void {
  globalThis.document = { documentElement: { lang } } as Document;
  Reflect.set(globalThis, 'devicePixelRatio', ratio);
}

/** A canvas whose `getContext` answers `context` and records what it was asked. */
function canvas(context: object | null): { element: HTMLCanvasElement; asked: unknown[][] } {
  const asked: unknown[][] = [];
  const element = {
    getContext: (...args: unknown[]) => {
      asked.push(args);
      return context;
    },
  } as unknown as HTMLCanvasElement;
  return { element, asked };
}

test('asks for one WebGL2 context that keeps its drawing buffer for the screenshot, antialiased below a pixel ratio of 2', () => {
  const gl = { isContextLost: () => false };
  for (const [ratio, antialias] of [
    [1, true],
    [1.5, true],
    [2, false],
    [4, false],
  ] as const) {
    inPage('fr', ratio);
    const { element, asked } = canvas(gl);
    assert.equal(webgl2(element), gl);
    assert.deepEqual(asked, [['webgl2', { preserveDrawingBuffer: true, antialias }]], `pixel ratio ${ratio}`);
  }
});

test('turns a missing WebGL2 context into a translated error', () => {
  inPage('fr');
  assert.throws(() => webgl2(canvas(null).element), { message: /WebGL2 n’est pas disponible/ });
  inPage('en');
  assert.throws(() => webgl2(canvas(null).element), { message: /WebGL2 is not available/ });
});

test('turns a lost context into a translated error that names the 16 context limit', () => {
  const lost = { isContextLost: () => true };
  inPage('fr');
  assert.throws(() => webgl2(canvas(lost).element), { message: /Le contexte WebGL a été perdu.*16/ });
  inPage('en');
  assert.throws(() => webgl2(canvas(lost).element), { message: /The WebGL context was lost.*16/ });
});

/** The buffer size fitBuffer gives a 1920 x 1080 canvas shown `shown` px wide at pixel ratio `ratio`, and the sizes set. */
function fitted(shown: number, ratio: number, start = [300, 150]): { size: number[]; writes: string[] } {
  const writes: string[] = [];
  const size = { width: start[0], height: start[1] };
  const element = {
    getBoundingClientRect: () => ({ width: shown }),
    get width() {
      return size.width;
    },
    set width(value: number) {
      writes.push(`width ${value}`);
      size.width = value;
    },
    get height() {
      return size.height;
    },
    set height(value: number) {
      writes.push(`height ${value}`);
      size.height = value;
    },
  } as unknown as HTMLCanvasElement;
  Reflect.set(globalThis, 'devicePixelRatio', ratio);
  fitBuffer(element, 1920, 1080);
  return { size: [size.width, size.height], writes };
}

test('sizes the drawing buffer to the canvas as shown, times the pixel ratio', () => {
  assert.deepEqual(fitted(1920, 1).size, [1920, 1080], 'a capture at 1x');
  assert.deepEqual(fitted(1920, 2).size, [3840, 2160], 'a capture at 2x');
  assert.deepEqual(fitted(640, 2).size, [1280, 720], 'a retina preview scaled down to a third');
  assert.deepEqual(fitted(5760, 2).size, [3840, 2160], 'a canvas zoomed in keeps its own size');
  assert.deepEqual(fitted(0, 2).size, [1, 1], 'a canvas scaled to nothing keeps a buffer');
});

test('resizes the drawing buffer only when its size changes, since a resize clears it', () => {
  assert.deepEqual(fitted(1920, 1, [1920, 1080]).writes, []);
  assert.deepEqual(fitted(1920, 1, [1920, 540]).writes, ['height 1080']);
});
