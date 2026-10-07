// What the server lets through from the frame's text checks: scene code shares the page, so anything else is null.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Page } from 'playwright';
import { auditFrame } from '../../server/capture/capture';

const page = (evaluate: () => Promise<unknown>) => ({ evaluate }) as unknown as Page;
const answering = (value: unknown) => page(async () => value);
const box = { x: 1, y: 2, width: 3, height: 4 };

describe('auditFrame', () => {
  test('null for anything but a short list of known findings', async () => {
    for (const junk of [
      'junk',
      { kind: 'clipped', text: 'x', box },
      [{ kind: 'pwned', text: 'x', box }],
      [{ kind: 'clipped', text: 'x', box: { ...box, x: Number.NaN } }],
      [{ kind: 'clipped', text: 'x', box: { ...box, width: Number.POSITIVE_INFINITY } }],
      [{ kind: 'clipped', text: 1, box }],
      Array.from({ length: 7 }, () => ({ kind: 'clipped', text: 'x', box })),
      [{ kind: 'contrast', text: 'x', box }],
      [{ kind: 'contrast', text: 'x', box, ratio: 2 }],
      [{ kind: 'contrast', text: 'x', box, required: 4.5 }],
      [{ kind: 'contrast', text: 'x', box, ratio: Number.NaN, required: 4.5 }],
    ]) {
      assert.equal(await auditFrame(answering(junk)), null, JSON.stringify(junk));
    }
  });

  test('null when the page throws or does not answer in time, never a throw', async () => {
    assert.equal(
      await auditFrame(
        page(async () => {
          throw new Error('boom');
        }),
      ),
      null,
    );
    assert.equal(
      await auditFrame(
        page(() => new Promise(() => undefined)),
        50,
      ),
      null,
    );
  });

  test('scene text becomes one line of 40 code points, unknown keys and stray ratios dropped', async () => {
    // The emoji is the 40th code point: a UTF-16 cut would split it.
    const text = `Grey\nlabel\u2028a\u2029b\u202ec\u200bd${'x'.repeat(21)}\u{1F600}${'y'.repeat(20)}`;
    const [found] = (await auditFrame(answering([{ kind: 'clipped', text, box, extra: 'dropped', ratio: 1.2, required: 3 }])))!;
    assert.deepEqual(found, { kind: 'clipped', text: `Grey label a b c d${'x'.repeat(21)}\u{1F600}`, box });
    assert.equal([...found.text].length, 40);
  });

  test('a contrast finding keeps its ratio and the one it needs', async () => {
    const contrast = { kind: 'contrast', text: 'Grey label', box, ratio: 2.31, required: 4.5 };
    assert.deepEqual(await auditFrame(answering([contrast, { kind: 'offCanvas', text: 'Off', box }])), [
      contrast,
      { kind: 'offCanvas', text: 'Off', box },
    ]);
  });
});
