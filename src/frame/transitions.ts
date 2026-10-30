// What a transition does to the two scenes it overlaps, at one frame. Styles are computed from the progress, never CSS
// transitions: a render at any time gives the same picture as the preview.
import type { CSSProperties } from 'react';
// Straight from the module, not 'cadence': the frame e2e harness stands in a reduced runtime for it.
import { ease } from '../runtime/easing';
import type { TransitionDirection, TransitionKind } from '../shared/types';

export interface Presentation {
  /** The element holding both scenes. */
  wrapper: CSSProperties;
  outgoing: CSSProperties;
  incoming: CSSProperties;
}

/** Where the motion goes, in canvas axes (y down). */
const AXIS: Record<TransitionDirection, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const SIDE = { left: 'left', right: 'right', up: 'top', down: 'bottom' } as const;
const OPPOSITE = { left: 'right', right: 'left', up: 'bottom', down: 'top' } as const;

/** Cut `share` (0 to 1) off one side of the box. */
function inset(side: 'top' | 'right' | 'bottom' | 'left', share: number): string {
  const cut = { top: 0, right: 0, bottom: 0, left: 0, [side]: share * 100 };
  return `inset(${cut.top}% ${cut.right}% ${cut.bottom}% ${cut.left}%)`;
}

/**
 * The outgoing and incoming scenes' styles at `progress` (0 to 1, eased in and out here). `direction` is where the motion
 * goes: `left` brings the incoming scene in from the right.
 */
export function presentation(
  kind: TransitionKind,
  direction: TransitionDirection = 'left',
  progress: number,
  width: number,
  height: number,
): Presentation {
  const p = ease.inOutCubic(progress);
  const q = 1 - p;
  const [x, y] = AXIS[direction];
  switch (kind) {
    case 'fade':
      // Light added inside an isolated group: two opaque scenes blend 50/50 halfway instead of letting the background
      // through, and transparent parts still show the background once.
      return {
        wrapper: { isolation: 'isolate' },
        outgoing: { opacity: q, mixBlendMode: 'plus-lighter' },
        incoming: { opacity: p, mixBlendMode: 'plus-lighter' },
      };
    case 'slide':
      return {
        wrapper: {},
        outgoing: { transform: `translate(${x * p * width}px, ${y * p * height}px)` },
        incoming: { transform: `translate(${-x * q * width}px, ${-y * q * height}px)` },
      };
    case 'wipe':
      return {
        wrapper: {},
        outgoing: { clipPath: inset(OPPOSITE[direction], p) },
        incoming: { clipPath: inset(SIDE[direction], q) },
      };
    case 'flip': {
      // The face turns toward the motion; past 90 degrees each scene shows its back, which is hidden.
      const rotate = (turn: number) => (x ? `rotateY(${x * turn}deg)` : `rotateX(${-y * turn}deg)`);
      return {
        wrapper: { perspective: `${2 * Math.max(width, height)}px` },
        outgoing: { transform: rotate(180 * p), backfaceVisibility: 'hidden' },
        incoming: { transform: rotate(-180 * q), backfaceVisibility: 'hidden' },
      };
    }
  }
}
