// Simulated mouse: a cursor that follows keyframes, presses on clicks, and ripples.
import { progress as progressOf } from './animate';
import { withAlpha } from './color';
import { ease, type Easing } from './easing';
import { useKitTheme } from './scene';
import { Pin } from './stage';
import type { Point } from './types';

export interface CursorKey {
  /** Scene seconds. */
  t: number;
  x: number;
  y: number;
  /** Easing of the move into this key (default ease.inOutCubic). */
  ease?: Easing;
}

/**
 * Cursor position at time t along keyframes: eased moves that bow slightly (`arc` × distance), like a hand on a mouse.
 * Use it to drive hover/pressed states of the UI under the cursor.
 */
export function cursorAt(t: number, path: readonly CursorKey[], arc = 0.12): Point {
  if (path.length === 0) return { x: 0, y: 0 };
  const first = path[0];
  const last = path[path.length - 1];
  if (t <= first.t) return { x: first.x, y: first.y };
  if (t >= last.t) return { x: last.x, y: last.y };
  let i = 0;
  while (i < path.length - 2 && t >= path[i + 1].t) i++;
  const a = path[i];
  const b = path[i + 1];
  if (b.t <= a.t) return { x: b.x, y: b.y };
  const k = (b.ease ?? ease.inOutCubic)((t - a.t) / (b.t - a.t));
  const bow = arc * Math.sin(Math.PI * k);
  return { x: a.x + (b.x - a.x) * k - (b.y - a.y) * bow, y: a.y + (b.y - a.y) * k + (b.x - a.x) * bow };
}

/** 0 to 1 and back to 0 around each click: pressed from 80 ms before the click, released over the 200 ms after. */
export function cursorPress(t: number, clicks: readonly number[]): number {
  let press = 0;
  for (const c of clicks) {
    const down = progressOf(t, c - 0.08, c, ease.outQuad);
    const up = progressOf(t, c + 0.05, c + 0.25, ease.outCubic);
    press = Math.max(press, down * (1 - up));
  }
  return press;
}

// Classic arrow, tip at (2, 2) in a 20 × 26 box; pointing hand, fingertip at (8.5, 1) in a 23 × 26 box.
const ARROW = 'M2 2L2 21L6.6 16.8L9.6 23.6L12.9 22.2L9.9 15.6L16 15.6Z';
const HAND =
  'M6.5 3.2C6.5 2 7.4 1 8.5 1C9.6 1 10.5 2 10.5 3.2L10.5 10.2C10.5 9.3 11.3 8.6 12.3 8.6C13.3 8.6 14.1 9.3 14.1 10.2L14.1 10.8' +
  'C14.1 9.9 14.9 9.3 15.8 9.3C16.7 9.3 17.5 9.9 17.5 10.8L17.5 11.8C17.5 11 18.2 10.4 19 10.4C19.8 10.4 20.5 11 20.5 11.8' +
  'L20.5 17.5C20.5 21.6 17.8 25 13.6 25L11.8 25C9.6 25 8.2 24.2 6.8 22.6L2.6 17.4C1.9 16.6 2 15.4 2.8 14.8' +
  'C3.6 14.2 4.8 14.3 5.4 15.1L6.5 16.4Z';

export interface CursorProps {
  /** Current scene time (pass `t`). */
  t: number;
  /** Keyframes { t, x, y, ease? } in canvas px. */
  path: readonly CursorKey[];
  /** Click times: the pointer presses (shrinks) around each. */
  clicks?: readonly number[];
  /** 0 to 1: cross-fade to the pointing hand (over links and buttons). */
  hover?: number;
  /** Height in px (default 30). Keeps its screen size inside a Camera. */
  size?: number;
  /** Draw a ClickRipple at each click. */
  ripple?: boolean;
  /** Bow of the moves (default 0.12; 0 = straight). */
  arc?: number;
  opacity?: number;
}

/** Mouse pointer following keyframes, with press and hover states. */
export function Cursor({ t, path, clicks = [], hover = 0, size = 30, ripple = false, arc, opacity = 1 }: CursorProps) {
  const pos = cursorAt(t, path, arc);
  const press = cursorPress(t, clicks);
  const k = size / 26;
  return (
    <>
      {ripple
        ? clicks.map((c) => {
            const at = cursorAt(c, path, arc);
            return <ClickRipple key={c} x={at.x} y={at.y} t={t} at={c} />;
          })
        : null}
      <Pin x={pos.x} y={pos.y} opacity={opacity}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            transform: press ? `scale(${1 - 0.14 * press})` : undefined,
            filter: 'drop-shadow(0 1.5px 2px rgba(0, 0, 0, 0.3))',
          }}
        >
          {hover < 1 ? (
            <svg
              width={20 * k}
              height={26 * k}
              viewBox="0 0 20 26"
              style={{ position: 'absolute', left: -2 * k, top: -2 * k, opacity: 1 - hover }}
            >
              <path d={ARROW} fill="#0a0a0a" stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
            </svg>
          ) : null}
          {hover > 0 ? (
            <svg
              width={23 * k}
              height={26 * k}
              viewBox="0 0 23 26"
              style={{ position: 'absolute', left: -8.5 * k, top: -1 * k, opacity: hover }}
            >
              <path d={HAND} fill="#ffffff" stroke="#0a0a0a" strokeWidth={1.3} strokeLinejoin="round" />
            </svg>
          ) : null}
        </div>
      </Pin>
    </>
  );
}

export interface ClickRippleProps {
  x: number;
  y: number;
  /** Current scene time. */
  t: number;
  /** Click time. */
  at: number;
  /** Default brand accent. */
  color?: string;
  /** Final radius in screen px (default 34). */
  size?: number;
  /** Seconds (default 0.5). */
  duration?: number;
}

/** Expanding ring at (x, y) starting at `at`. */
export function ClickRipple({ x, y, t, at, color, size = 34, duration = 0.5 }: ClickRippleProps) {
  const theme = useKitTheme();
  const k = (t - at) / duration;
  if (k < 0 || k >= 1) return null;
  const c = color ?? theme.accent;
  const r = size * ease.outCubic(k);
  return (
    <Pin x={x} y={y}>
      <div
        style={{
          position: 'absolute',
          left: -r,
          top: -r,
          width: 2 * r,
          height: 2 * r,
          boxSizing: 'border-box',
          borderRadius: '50%',
          border: `2px solid ${withAlpha(c, 0.7)}`,
          background: withAlpha(c, 0.14),
          opacity: 1 - ease.inQuad(k),
        }}
      />
    </Pin>
  );
}
