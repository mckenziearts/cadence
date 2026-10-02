import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { interpolateColor, mixColor, parseColor, toHex, withAlpha } from '../../src/runtime/index';

const near = (actual: number[], expected: number[], eps = 0.6) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= eps, `${actual} ≉ ${expected}`));

describe('parseColor', () => {
  test('hex forms', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
    assert.deepEqual(parseColor('#FF2E88'), [255, 46, 136, 1]);
    near(parseColor('#ff2e8880'), [255, 46, 136, 128 / 255], 1e-9);
    near(parseColor('#f008'), [255, 0, 0, 0x88 / 255], 1e-9);
  });

  test('rgb() and rgba(), comma and space syntax, percentages', () => {
    assert.deepEqual(parseColor('rgb(255, 0, 0)'), [255, 0, 0, 1]);
    assert.deepEqual(parseColor('rgba(255,0,0,0.5)'), [255, 0, 0, 0.5]);
    assert.deepEqual(parseColor('rgb(255 0 0 / 25%)'), [255, 0, 0, 0.25]);
    assert.deepEqual(parseColor('  RGB(100%, 0%, 50%) '), [255, 0, 127.5, 1]);
  });

  test('hsl() and hsla() with angle units', () => {
    near(parseColor('hsl(0, 100%, 50%)'), [255, 0, 0, 1]);
    near(parseColor('hsl(120 100% 25%)'), [0, 127.5, 0, 1]);
    near(parseColor('hsla(240, 100%, 50%, 0.3)'), [0, 0, 255, 0.3]);
    near(parseColor('hsl(0.5turn 100% 50%)'), [0, 255, 255, 1]);
    near(parseColor('hsl(-120deg 100% 50%)'), [0, 0, 255, 1]);
  });

  test('oklch() and oklab() round-trip to sRGB', () => {
    near(parseColor('oklch(62.8% 0.2577 29.23)'), [255, 0, 0, 1], 1);
    near(parseColor('oklch(0.628 0.2577 29.23deg / 0.5)'), [255, 0, 0, 0.5], 1);
    near(parseColor('oklab(0.628 0.2249 0.1258)'), [255, 0, 0, 1], 1);
    near(parseColor('oklch(1 0 0)'), [255, 255, 255, 1], 0.5);
    near(parseColor('oklch(0 0 none)'), [0, 0, 0, 1], 0.5);
    // Out-of-gamut colors are clipped into sRGB.
    const wild = parseColor('oklch(0.7 0.4 150)');
    assert.ok(wild.slice(0, 3).every((v) => v >= 0 && v <= 255));
  });

  test('keywords', () => {
    assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
    assert.deepEqual(parseColor('black'), [0, 0, 0, 1]);
    assert.deepEqual(parseColor('White'), [255, 255, 255, 1]);
  });

  test('unsupported strings throw a clear error', () => {
    for (const bad of [
      'red',
      'var(--x)',
      '#ff000',
      '#12345g',
      'rgb(1, 2)',
      'rgb(a, b, c)',
      'hsl(1 2 3 4 5)',
      'constructor',
      '',
    ]) {
      assert.throws(() => parseColor(bad), /Unsupported color/, bad);
    }
  });
});

describe('toHex & withAlpha', () => {
  test('toHex writes #rrggbb, #rrggbbaa when translucent', () => {
    assert.equal(toHex('#abc'), '#aabbcc');
    assert.equal(toHex('rgb(255 46 136)'), '#ff2e88');
    assert.equal(toHex('rgba(255, 46, 136, 0.5)'), '#ff2e8880');
    assert.equal(toHex('oklch(62.8% 0.2577 29.23)'), '#ff0000');
    assert.equal(toHex('transparent'), '#00000000');
  });

  test('withAlpha multiplies alpha', () => {
    assert.equal(withAlpha('#ff2e88', 0.3), 'rgba(255, 46, 136, 0.3)');
    assert.equal(withAlpha('rgba(0, 0, 0, 0.5)', 0.5), 'rgba(0, 0, 0, 0.25)');
  });
});

describe('mixColor & interpolateColor (OKLab)', () => {
  test('endpoints are exact', () => {
    assert.equal(mixColor('#ff2e88', '#3b82f6', 0), 'rgba(255, 46, 136, 1)');
    assert.equal(mixColor('#ff2e88', '#3b82f6', 1), 'rgba(59, 130, 246, 1)');
  });

  test('the black to white midpoint is perceptual (L = 0.5), not the sRGB average', () => {
    assert.equal(mixColor('#000000', '#ffffff', 0.5), 'rgba(99, 99, 99, 1)');
  });

  test('fading from transparent keeps the hue (premultiplied alpha)', () => {
    assert.equal(mixColor('transparent', '#ff2e88', 0.5), 'rgba(255, 46, 136, 0.5)');
    assert.equal(mixColor('#ff2e88', 'transparent', 1), 'rgba(0, 0, 0, 0)');
  });

  test('interpolateColor matches mixColor per segment and clamps', () => {
    const stops = ['#ff0000', '#00ff00', '#0000ff'];
    assert.equal(interpolateColor(0.5, [0, 1, 2], stops), mixColor('#ff0000', '#00ff00', 0.5));
    assert.equal(interpolateColor(1.25, [0, 1, 2], stops), mixColor('#00ff00', '#0000ff', 0.25));
    assert.equal(interpolateColor(-3, [0, 1, 2], stops), 'rgba(255, 0, 0, 1)');
    assert.equal(interpolateColor(9, [0, 1, 2], stops), 'rgba(0, 0, 255, 1)');
    assert.equal(interpolateColor(0.5, [0, 1], ['hsl(0 100% 50%)', 'oklch(0.628 0.2577 29.23)']), 'rgba(255, 0, 0, 1)');
  });
});
