// Transitions in the frame: which scenes a video time draws, and what the cut does to each of them at one frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickScene } from '../../src/frame/pick';
import { presentation } from '../../src/frame/transitions';
import type { SceneState, SceneTransition, TransitionDirection } from '../../src/shared/types';

const W = 1920;
const H = 1080;

function scene(id: string, start: number, duration: number, transition?: SceneTransition): SceneState {
  return { id, name: id, index: 0, start, duration, file: '', url: '', codeVersion: 'x', ...(transition && { transition }) };
}

// A 0.4 s, then B 0.6 s with a 0.1 s fade: B starts at 0.3, A ends at 0.4.
const scenes = [scene('a', 0, 0.4), scene('b', 0.3, 0.6, { kind: 'fade', duration: 0.1 })];
const [a, b] = scenes;

test('pickScene: before an overlap only the outgoing scene is drawn', () => {
  assert.deepEqual(pickScene(scenes, 0.29, null), { scene: a, local: 0.29 });
});

test('pickScene: from the incoming start, both scenes, the outgoing one at its own time, progress from 0', () => {
  const atStart = { scene: b, local: 0, outgoing: { scene: a, local: 0.3, progress: 0 } };
  assert.deepEqual(pickScene(scenes, 0.3, null), atStart);
  // Float sums a hair after or before the cut still start it at progress 0.
  assert.deepEqual(pickScene(scenes, 0.1 + 0.2, null), atStart);
  assert.deepEqual(pickScene(scenes, 0.7 - 0.4, null), atStart);
  assert.deepEqual(pickScene(scenes, 0.35, null), { scene: b, local: 0.05, outgoing: { scene: a, local: 0.35, progress: 0.5 } });
});

test("pickScene: a frame exactly at the outgoing scene's end belongs to the incoming one only", () => {
  assert.deepEqual(pickScene(scenes, 0.4, null), { scene: b, local: 0.1 });
  assert.deepEqual(pickScene(scenes, 0.7 - 0.3, null), { scene: b, local: 0.1 });
  assert.deepEqual(pickScene(scenes, 0.2 + 0.2, null), { scene: b, local: 0.1 });
});

test('pickScene: a cut after the first one pairs the scene with the one just before it, at its own time', () => {
  // A 0-1, B 1-2, C from 1.7 with a 0.3 s fade.
  const three = [scene('a', 0, 1), scene('b', 1, 1), scene('c', 1.7, 1, { kind: 'fade', duration: 0.3 })];
  assert.deepEqual(pickScene(three, 1.85, null), {
    scene: three[2],
    local: 0.15,
    outgoing: { scene: three[1], local: 0.85, progress: 0.5 },
  });
});

test('pickScene: back-to-back overlaps, the end of one cut is the start of the next', () => {
  // B lasts exactly twice the 0.3 s cut: its own cut ends at 1, where C's starts.
  const fade = { kind: 'fade', duration: 0.3 } as const;
  const chain = [scene('a', 0, 1), scene('b', 0.7, 0.6, fade), scene('c', 1, 1, fade)];
  const [, chainB, chainC] = chain;
  assert.deepEqual(pickScene(chain, 0.85, null), {
    scene: chainB,
    local: 0.15,
    outgoing: { scene: chain[0], local: 0.85, progress: 0.5 },
  });
  assert.deepEqual(pickScene(chain, 1, null), { scene: chainC, local: 0, outgoing: { scene: chainB, local: 0.3, progress: 0 } });
  assert.deepEqual(pickScene(chain, 0.7 + 0.3, null), {
    scene: chainC,
    local: 0,
    outgoing: { scene: chainB, local: 0.3, progress: 0 },
  });
  assert.deepEqual(pickScene(chain, 1.3, null), { scene: chainC, local: 0.3 });
});

test('pickScene: before the video, past its end, scene mode and no scenes', () => {
  assert.deepEqual(pickScene(scenes, -1, null), { scene: a, local: 0 });
  assert.deepEqual(pickScene(scenes, 5, null), { scene: b, local: 0.6 });
  // Scene mode shows one scene, without its transition, at times clamped to it.
  assert.deepEqual(pickScene(scenes, 0.05, 'b'), { scene: b, local: 0.05 });
  assert.deepEqual(pickScene(scenes, 2, 'b'), { scene: b, local: 0.6 });
  assert.equal(pickScene(scenes, 0, 'missing'), null);
  assert.equal(pickScene([], 0, null), null);
});

test('pickScene: hard cuts still belong to the next scene, the epsilon absorbs 0.5 + 0.6', () => {
  const hard = [scene('a', 0, 0.5), scene('b', 0.5, 0.6), scene('c', 1.1, 1)];
  assert.deepEqual(pickScene(hard, 0.5 + 0.6, null), { scene: hard[2], local: 0 });
  assert.deepEqual(pickScene(hard, 1.0999, null), { scene: hard[1], local: 0.5999 });
});

/** Per kind and direction: the incoming scene's style at progress 0, both styles at 0.5, the outgoing one's at 1. */
const cases: {
  kind: SceneTransition['kind'];
  direction?: TransitionDirection;
  wrapper: object;
  identity: object;
  hiddenIn: object;
  halfIn: object;
  halfOut: object;
  hiddenOut: object;
}[] = [
  {
    kind: 'fade',
    wrapper: { isolation: 'isolate' },
    identity: { opacity: 1, mixBlendMode: 'plus-lighter' },
    hiddenIn: { opacity: 0, mixBlendMode: 'plus-lighter' },
    halfIn: { opacity: 0.5, mixBlendMode: 'plus-lighter' },
    halfOut: { opacity: 0.5, mixBlendMode: 'plus-lighter' },
    hiddenOut: { opacity: 0, mixBlendMode: 'plus-lighter' },
  },
  ...(
    [
      ['left', 'translate(1920px, 0px)', 'translate(960px, 0px)', 'translate(-960px, 0px)', 'translate(-1920px, 0px)'],
      ['right', 'translate(-1920px, 0px)', 'translate(-960px, 0px)', 'translate(960px, 0px)', 'translate(1920px, 0px)'],
      ['up', 'translate(0px, 1080px)', 'translate(0px, 540px)', 'translate(0px, -540px)', 'translate(0px, -1080px)'],
      ['down', 'translate(0px, -1080px)', 'translate(0px, -540px)', 'translate(0px, 540px)', 'translate(0px, 1080px)'],
    ] as const
  ).map(([direction, hiddenIn, halfIn, halfOut, hiddenOut]) => ({
    kind: 'slide' as const,
    direction,
    wrapper: {},
    identity: { transform: 'translate(0px, 0px)' },
    hiddenIn: { transform: hiddenIn },
    halfIn: { transform: halfIn },
    halfOut: { transform: halfOut },
    hiddenOut: { transform: hiddenOut },
  })),
  ...(
    [
      ['left', 'inset(0% 0% 0% 100%)', 'inset(0% 0% 0% 50%)', 'inset(0% 50% 0% 0%)', 'inset(0% 100% 0% 0%)'],
      ['right', 'inset(0% 100% 0% 0%)', 'inset(0% 50% 0% 0%)', 'inset(0% 0% 0% 50%)', 'inset(0% 0% 0% 100%)'],
      ['up', 'inset(100% 0% 0% 0%)', 'inset(50% 0% 0% 0%)', 'inset(0% 0% 50% 0%)', 'inset(0% 0% 100% 0%)'],
      ['down', 'inset(0% 0% 100% 0%)', 'inset(0% 0% 50% 0%)', 'inset(50% 0% 0% 0%)', 'inset(100% 0% 0% 0%)'],
    ] as const
  ).map(([direction, hiddenIn, halfIn, halfOut, hiddenOut]) => ({
    kind: 'wipe' as const,
    direction,
    wrapper: {},
    identity: { clipPath: 'inset(0% 0% 0% 0%)' },
    hiddenIn: { clipPath: hiddenIn },
    halfIn: { clipPath: halfIn },
    halfOut: { clipPath: halfOut },
    hiddenOut: { clipPath: hiddenOut },
  })),
  ...(
    [
      ['left', 'rotateY(0deg)', 'rotateY(180deg)', 'rotateY(90deg)', 'rotateY(-90deg)', 'rotateY(-180deg)'],
      ['right', 'rotateY(0deg)', 'rotateY(-180deg)', 'rotateY(-90deg)', 'rotateY(90deg)', 'rotateY(180deg)'],
      ['up', 'rotateX(0deg)', 'rotateX(-180deg)', 'rotateX(-90deg)', 'rotateX(90deg)', 'rotateX(180deg)'],
      ['down', 'rotateX(0deg)', 'rotateX(180deg)', 'rotateX(90deg)', 'rotateX(-90deg)', 'rotateX(-180deg)'],
    ] as const
  ).map(([direction, identity, hiddenIn, halfIn, halfOut, hiddenOut]) => {
    const face = (transform: string) => ({ transform, backfaceVisibility: 'hidden' });
    return {
      kind: 'flip' as const,
      direction,
      wrapper: { perspective: '3840px' },
      identity: face(identity),
      hiddenIn: face(hiddenIn),
      halfIn: face(halfIn),
      halfOut: face(halfOut),
      hiddenOut: face(hiddenOut),
    };
  }),
];

for (const c of cases) {
  const name = `${c.kind}${c.direction ? ` ${c.direction}` : ''}`;
  test(`presentation ${name}: incoming hidden and outgoing untouched at 0, halfway at 0.5, the reverse at 1`, () => {
    assert.deepEqual(presentation(c.kind, c.direction, 0, W, H), {
      wrapper: c.wrapper,
      outgoing: c.identity,
      incoming: c.hiddenIn,
    });
    assert.deepEqual(presentation(c.kind, c.direction, 0.5, W, H), {
      wrapper: c.wrapper,
      outgoing: c.halfOut,
      incoming: c.halfIn,
    });
    assert.deepEqual(presentation(c.kind, c.direction, 1, W, H), {
      wrapper: c.wrapper,
      outgoing: c.hiddenOut,
      incoming: c.identity,
    });
  });
}

test("presentation: the progress goes through the runtime's in-out ease, and slide, wipe and flip default to left", () => {
  // ease.inOutCubic(0.25) = 4 * 0.25^3
  assert.equal(presentation('fade', undefined, 0.25, W, H).incoming.opacity, 0.0625);
  assert.deepEqual(presentation('slide', undefined, 0.5, W, H), presentation('slide', 'left', 0.5, W, H));
  assert.deepEqual(presentation('flip', undefined, 0.3, W, H), presentation('flip', 'left', 0.3, W, H));
  // A portrait canvas slides by its own height and gets a perspective from its longest side.
  assert.equal(presentation('slide', 'up', 0, 1080, 1920).incoming.transform, 'translate(0px, 1920px)');
  assert.deepEqual(presentation('flip', 'up', 0, 1080, 1920).wrapper, { perspective: '3840px' });
});
