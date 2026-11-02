// The math behind the frame's text checks: WCAG contrast, the large-text threshold, and which findings come first.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contrastRatio, gifName, requiredRatio, worstFirst } from '../../src/frame/audit';
import type { AuditFinding } from '../../src/shared/frameProtocol';
import type { RGBA } from '../../src/runtime/index';

const WHITE: RGBA = [255, 255, 255, 1];
const BLACK: RGBA = [0, 0, 0, 1];
const round = (ratio: number) => Math.round(ratio * 100) / 100;

describe('contrastRatio', () => {
  test('known pairs: black on white is 21, #777777 on white is 4.48, either way round', () => {
    assert.equal(contrastRatio(BLACK, WHITE), 21);
    assert.equal(contrastRatio(WHITE, BLACK), 21);
    assert.equal(round(contrastRatio([0x77, 0x77, 0x77, 1], WHITE)), 4.48);
    assert.equal(contrastRatio(WHITE, WHITE), 1);
  });

  test('a translucent text color blends over the background first', () => {
    const halfBlack = contrastRatio([0, 0, 0, 0.5], WHITE);
    assert.equal(round(halfBlack), round(contrastRatio([127.5, 127.5, 127.5, 1], WHITE)));
    assert.equal(round(halfBlack), 3.98);
    assert.equal(contrastRatio([0, 0, 0, 0], WHITE), 1);
  });
});

describe('requiredRatio', () => {
  test('large text (24 px, or 14 pt and bold) needs 3, the rest 4.5', () => {
    assert.equal(requiredRatio(24, 400), 3);
    assert.equal(requiredRatio(23.9, 400), 4.5);
    assert.equal(requiredRatio(18.6667, 700), 3);
    assert.equal(requiredRatio(18.6667, 600), 4.5);
    assert.equal(requiredRatio(18, 700), 4.5);
    assert.equal(requiredRatio(16, 900), 4.5);
  });
});

describe('worstFirst', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  const finding = (kind: AuditFinding['kind'], text: string, ratio?: number, required?: number): AuditFinding => ({
    kind,
    text,
    box,
    ...(ratio === undefined ? {} : { ratio, required }),
  });

  test('cut text, then text off the canvas, under the captions, the faintest contrast, then the safe margins', () => {
    const sorted = worstFirst([
      finding('outsideSafe', 'margin'),
      finding('contrast', 'close', 4.2, 4.5),
      finding('underCaptions', 'covered'),
      finding('contrast', 'faint', 1.5, 3),
      finding('offCanvas', 'off'),
      finding('clipped', 'cut'),
    ]);
    assert.deepEqual(
      sorted.map((f) => f.text),
      ['cut', 'off', 'covered', 'faint', 'close', 'margin'],
    );
  });

  test('a GIF in an <img> comes after hidden text and before contrast and the safe margins', () => {
    const sorted = worstFirst([
      finding('outsideSafe', 'margin'),
      finding('contrast', 'faint', 1.5, 3),
      finding('gif', 'spin.gif'),
      finding('underCaptions', 'covered'),
    ]);
    assert.deepEqual(
      sorted.map((f) => f.text),
      ['covered', 'spin.gif', 'faint', 'margin'],
    );
  });

  test('contrast goes by how far it falls short of the ratio it needs, not by the raw ratio', () => {
    assert.deepEqual(
      worstFirst([finding('contrast', 'large', 2.9, 3), finding('contrast', 'small', 4.2, 4.5)]).map((f) => f.text),
      ['small', 'large'],
    );
  });

  test('keeps six, and document order between equals', () => {
    const many = Array.from({ length: 9 }, (_, i) => finding('outsideSafe', `t${i}`));
    assert.deepEqual(
      worstFirst([finding('clipped', 'cut'), ...many]).map((f) => f.text),
      ['cut', 't0', 't1', 't2', 't3', 't4'],
    );
  });
});

describe('gifName', () => {
  test('the path under assets/ of an image URL ending in .gif, decoded, query and case ignored', () => {
    assert.equal(gifName('http://p.localhost/@fs/home/a/demo/assets/loops/my%20spin.gif'), 'loops/my spin.gif');
    assert.equal(gifName('http://p.localhost/@fs/home/a/demo/assets/spin.GIF?v=2#top'), 'spin.GIF');
    assert.equal(gifName('http://p.localhost/images/spin.gif'), 'spin.gif');
  });

  test('null for any other image', () => {
    assert.equal(gifName('http://p.localhost/@fs/home/a/demo/assets/logo.png'), null);
    assert.equal(gifName('http://p.localhost/@fs/home/a/demo/assets/logo.png?file=a.gif'), null);
    assert.equal(gifName('http://p.localhost/@fs/home/a/demo/assets/gif'), null);
    assert.equal(gifName('data:image/gif;base64,R0lGODlhAQABAAAAACw='), null);
    assert.equal(gifName(''), null);
  });

  test('gifName never throws on a lone percent sign in the path', () => {
    assert.equal(gifName('http://a/@fs/h/demo/assets/100%.gif'), '100%.gif');
  });
});
