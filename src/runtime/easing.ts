// Adapted from saeedvaziry/caleb-video-editor (MIT)
export type Easing = (x: number) => number;

const { pow, sqrt, sin, cos, PI } = Math;
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * PI) / 3;
const c5 = (2 * PI) / 4.5;

function bounceOut(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

/** CSS-style cubic-bezier(x1, y1, x2, y2) easing. */
export function bezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number) => {
    // Newton first (fast), bisection when the slope is too flat to trust.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-7) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveX(x));
  };
}

/** Ease-out with a configurable overshoot (1.70158 is the classic "back"). */
function backOut(overshoot = c1): Easing {
  const k = overshoot + 1;
  return (x) => 1 + k * pow(x - 1, 3) + overshoot * pow(x - 1, 2);
}

/** Stepped easing, like CSS steps(n, jump-end). */
function steps(n: number): Easing {
  return (x) => Math.min(1, Math.floor(x * n) / n);
}

const outElastic: Easing = (x) => (x === 0 ? 0 : x === 1 ? 1 : pow(2, -10 * x) * sin((x * 10 - 0.75) * c4) + 1);

export const ease = {
  linear: ((x) => x) as Easing,
  inSine: ((x) => 1 - cos((x * PI) / 2)) as Easing,
  outSine: ((x) => sin((x * PI) / 2)) as Easing,
  inOutSine: ((x) => -(cos(PI * x) - 1) / 2) as Easing,
  inQuad: ((x) => x * x) as Easing,
  outQuad: ((x) => 1 - (1 - x) * (1 - x)) as Easing,
  inOutQuad: ((x) => (x < 0.5 ? 2 * x * x : 1 - pow(-2 * x + 2, 2) / 2)) as Easing,
  inCubic: ((x) => x * x * x) as Easing,
  outCubic: ((x) => 1 - pow(1 - x, 3)) as Easing,
  inOutCubic: ((x) => (x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2)) as Easing,
  inQuart: ((x) => x * x * x * x) as Easing,
  outQuart: ((x) => 1 - pow(1 - x, 4)) as Easing,
  inOutQuart: ((x) => (x < 0.5 ? 8 * x * x * x * x : 1 - pow(-2 * x + 2, 4) / 2)) as Easing,
  inQuint: ((x) => x * x * x * x * x) as Easing,
  outQuint: ((x) => 1 - pow(1 - x, 5)) as Easing,
  inOutQuint: ((x) => (x < 0.5 ? 16 * x * x * x * x * x : 1 - pow(-2 * x + 2, 5) / 2)) as Easing,
  inExpo: ((x) => (x === 0 ? 0 : pow(2, 10 * x - 10))) as Easing,
  outExpo: ((x) => (x === 1 ? 1 : 1 - pow(2, -10 * x))) as Easing,
  inOutExpo: ((x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? pow(2, 20 * x - 10) / 2 : (2 - pow(2, -20 * x + 10)) / 2)) as Easing,
  inCirc: ((x) => 1 - sqrt(1 - pow(x, 2))) as Easing,
  outCirc: ((x) => sqrt(1 - pow(x - 1, 2))) as Easing,
  inOutCirc: ((x) => (x < 0.5 ? (1 - sqrt(1 - pow(2 * x, 2))) / 2 : (sqrt(1 - pow(-2 * x + 2, 2)) + 1) / 2)) as Easing,
  inBack: ((x) => c3 * x * x * x - c1 * x * x) as Easing,
  outBack: backOut(),
  inOutBack: ((x) =>
    x < 0.5
      ? (pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
      : (pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2) as Easing,
  inElastic: ((x) => (x === 0 ? 0 : x === 1 ? 1 : -pow(2, 10 * x - 10) * sin((x * 10 - 10.75) * c4))) as Easing,
  outElastic,
  inOutElastic: ((x) =>
    x === 0
      ? 0
      : x === 1
        ? 1
        : x < 0.5
          ? -(pow(2, 20 * x - 10) * sin((20 * x - 11.125) * c5)) / 2
          : (pow(2, -20 * x + 10) * sin((20 * x - 11.125) * c5)) / 2 + 1) as Easing,
  inBounce: ((x) => 1 - bounceOut(1 - x)) as Easing,
  outBounce: bounceOut as Easing,
  inOutBounce: ((x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2)) as Easing,
  /** CSS `ease`. */
  css: bezier(0.25, 0.1, 0.25, 1),
  /** Material "standard": quick start, long gentle settle. Good default for UI moves. */
  standard: bezier(0.2, 0, 0, 1),
  /** Strong deceleration for elements entering the frame. */
  decelerate: bezier(0, 0, 0, 1),
  /** Accelerate out of frame. */
  accelerate: bezier(0.3, 0, 1, 1),
  /** Smooth in-out for camera moves and big transforms. */
  smooth: bezier(0.65, 0, 0.35, 1),
  bezier,
  backOut,
  steps,
};
