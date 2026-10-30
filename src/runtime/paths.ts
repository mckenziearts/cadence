// SVG path data as pure math: parsing, measuring, drawing by progress. No DOM: getTotalLength is missing in node
// and differs between engines, and a render must give the same numbers in every one.
import { clamp } from './animate';
import type { Point } from './types';

/** A cubic Bézier. Every command (lines, quadratics, arcs) is converted to these. */
export interface CubicSegment {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

/** What one M (and what follows it) draws. `closed`: ended by Z. */
export interface Subpath {
  segments: CubicSegment[];
  closed: boolean;
}

const COMMANDS = 'MLHVCSQTAZ';
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
// SVG grammar: whitespace around commands, one comma at most between two numbers.
const WSP = /\s*/y;
const COMMA_WSP = /(\s*)(,?)\s*/y;

const line = (from: Point, to: Point): CubicSegment => ({
  from,
  c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
  c2: { x: from.x + ((to.x - from.x) * 2) / 3, y: from.y + ((to.y - from.y) * 2) / 3 },
  to,
});

const quadratic = (from: Point, control: Point, to: Point): CubicSegment => ({
  from,
  c1: { x: from.x + ((control.x - from.x) * 2) / 3, y: from.y + ((control.y - from.y) * 2) / 3 },
  c2: { x: to.x + ((control.x - to.x) * 2) / 3, y: to.y + ((control.y - to.y) * 2) / 3 },
  to,
});

/** Endpoint arc to cubics, per SVG 1.1 appendix F.6.5 (center parameterization) and F.6.6 (radii out of range). */
function arc(from: Point, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, to: Point): CubicSegment[] {
  if (from.x === to.x && from.y === to.y) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [line(from, to)];
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  // Eighth turns at most: a cubic stays within 5e-6 of the radius of the true arc (0.003 px at r = 540; quarter
  // turns were off by 0.5 px of length there).
  const pieces = Math.ceil(Math.abs(delta) / (Math.PI / 4));
  const step = delta / pieces;
  const handle = (4 / 3) * Math.tan(step / 4);
  const at = (x: number, y: number): Point => ({ x: cx + rx * cos * x - ry * sin * y, y: cy + rx * sin * x + ry * cos * y });
  const segments: CubicSegment[] = [];
  let start = from;
  for (let i = 0; i < pieces; i++) {
    const a1 = theta + i * step;
    const a2 = a1 + step;
    const end = i === pieces - 1 ? to : at(Math.cos(a2), Math.sin(a2));
    segments.push({
      from: start,
      c1: at(Math.cos(a1) - handle * Math.sin(a1), Math.sin(a1) + handle * Math.cos(a1)),
      c2: at(Math.cos(a2) + handle * Math.sin(a2), Math.sin(a2) - handle * Math.cos(a2)),
      to: end,
    });
    start = end;
  }
  return segments;
}

/**
 * Parses SVG path data (M L H V C S Q T A Z, absolute and relative) into subpaths of cubic segments.
 * Throws `Invalid path data at position <i>` on anything the SVG grammar refuses.
 */
export function parsePath(d: string): Subpath[] {
  let i = 0;
  const fail = (reason: string): never => {
    throw new Error(`Invalid path data at position ${i}: ${reason} ("${d.slice(i, i + 16)}")`);
  };
  // Position of the comma after the last number or flag, -1 when none: only another number may follow it.
  let comma = -1;
  const skip = () => {
    WSP.lastIndex = i;
    WSP.exec(d);
    i = WSP.lastIndex;
  };
  const skipAfterNumber = () => {
    COMMA_WSP.lastIndex = i;
    const [, space, mark] = COMMA_WSP.exec(d)!;
    comma = mark ? i + space.length : -1;
    i = COMMA_WSP.lastIndex;
  };
  const noTrailingComma = () => {
    if (comma < 0) return;
    i = comma;
    fail('a comma must sit between two numbers');
  };
  const number = (): number => {
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(d);
    if (!match) return fail('expected a number');
    if (!Number.isFinite(Number(match[0]))) return fail('number out of range');
    i = NUMBER.lastIndex;
    skipAfterNumber();
    return Number(match[0]);
  };
  const flag = (): boolean => {
    if (d[i] !== '0' && d[i] !== '1') return fail('expected an arc flag (0 or 1)');
    const value = d[i] === '1';
    i++;
    skipAfterNumber();
    return value;
  };

  skip();
  if (i === d.length) throw new Error('Invalid path data: empty');
  const subpaths: Subpath[] = [];
  let current = null as Subpath | null;
  let point: Point = { x: 0, y: 0 };
  let start: Point = point;
  // Control point S or T reflects, when the previous command was of the same family.
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let command = '';

  const push = (segments: CubicSegment[]) => {
    if (!current) {
      current = { segments: [], closed: false };
      subpaths.push(current);
    }
    current.segments.push(...segments);
  };

  while (i < d.length) {
    const letter = d[i];
    if (/[a-zA-Z]/.test(letter)) {
      noTrailingComma();
      if (!COMMANDS.includes(letter.toUpperCase())) fail(`unknown command "${letter}"`);
      if (!command && letter.toUpperCase() !== 'M') fail('path data must start with M');
      command = letter;
      i++;
      skip();
    } else if (!command) {
      fail('path data must start with M');
    } else if (command.toUpperCase() === 'Z') {
      fail('Z takes no numbers');
    }
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const ox = relative ? point.x : 0;
    const oy = relative ? point.y : 0;
    const xy = (): Point => {
      const x = number();
      return { x: ox + x, y: oy + number() };
    };
    let cubic: Point | null = null;
    let quad: Point | null = null;

    if (upper === 'M') {
      point = xy();
      start = point;
      current = null;
      // Pairs after a moveto are implicit linetos.
      command = relative ? 'l' : 'L';
    } else if (upper === 'Z') {
      if (current) {
        if (point.x !== start.x || point.y !== start.y) current.segments.push(line(point, start));
        current.closed = true;
      }
      current = null;
      point = start;
    } else if (upper === 'L' || upper === 'H' || upper === 'V') {
      const to = upper === 'L' ? xy() : upper === 'H' ? { x: ox + number(), y: point.y } : { x: point.x, y: oy + number() };
      push([line(point, to)]);
      point = to;
    } else if (upper === 'C' || upper === 'S') {
      const c1 = upper === 'C' ? xy() : lastCubic ? { x: 2 * point.x - lastCubic.x, y: 2 * point.y - lastCubic.y } : point;
      const c2 = xy();
      const to = xy();
      push([{ from: point, c1, c2, to }]);
      cubic = c2;
      point = to;
    } else if (upper === 'Q' || upper === 'T') {
      const control: Point =
        upper === 'Q' ? xy() : lastQuad ? { x: 2 * point.x - lastQuad.x, y: 2 * point.y - lastQuad.y } : point;
      const to = xy();
      push([quadratic(point, control, to)]);
      quad = control;
      point = to;
    } else {
      const rx = number();
      const ry = number();
      const rotation = number();
      const large = flag();
      const sweep = flag();
      const to = xy();
      push(arc(point, rx, ry, rotation, large, sweep, to));
      point = to;
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  noTrailingComma();
  return subpaths.filter((sub) => sub.segments.length > 0);
}

// 16-point Gauss-Legendre nodes and weights on [-1, 1].
const GAUSS_X = [
  0.0950125098376374, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438, 0.755404408355003, 0.8656312023878318,
  0.9445750230732326, 0.9894009349916499,
];
const GAUSS_W = [
  0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767, 0.1246289712555339, 0.0951585116824928,
  0.0622535239386479, 0.0271524594117541,
];

function pointAt({ from, c1, c2, to }: CubicSegment, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * from.x + b * c1.x + c * c2.x + e * to.x, y: a * from.y + b * c1.y + c * c2.y + e * to.y };
}

function derivativeAt({ from, c1, c2, to }: CubicSegment, t: number): Point {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return {
    x: a * (c1.x - from.x) + b * (c2.x - c1.x) + c * (to.x - c2.x),
    y: a * (c1.y - from.y) + b * (c2.y - c1.y) + c * (to.y - c2.y),
  };
}

function gauss(segment: CubicSegment, a: number, b: number): number {
  const mid = (a + b) / 2;
  const half = (b - a) / 2;
  let sum = 0;
  for (let k = 0; k < GAUSS_X.length; k++) {
    for (const x of [mid - half * GAUSS_X[k], mid + half * GAUSS_X[k]]) {
      const v = derivativeAt(segment, x);
      sum += GAUSS_W[k] * Math.hypot(v.x, v.y);
    }
  }
  return sum * half;
}

/** Splits [a, b] until both halves agree with the whole: a sharp turn (control points far out) needs it. */
function integrate(segment: CubicSegment, a: number, b: number, whole: number, depth: number): number {
  const mid = (a + b) / 2;
  const left = gauss(segment, a, mid);
  const right = gauss(segment, mid, b);
  if (depth >= 10 || Math.abs(left + right - whole) < 1e-7) return left + right;
  return integrate(segment, a, mid, left, depth + 1) + integrate(segment, mid, b, right, depth + 1);
}

/** Arc length of a segment from t = 0 to t. */
function lengthTo(segment: CubicSegment, t: number): number {
  return integrate(segment, 0, t, gauss(segment, 0, t), 0);
}

/** The t whose arc length from the segment start is `length`, out of the segment's `total`. */
function tAtLength(segment: CubicSegment, length: number, total: number): number {
  // Newton on the arc length (its derivative is the speed), kept inside a bisection bracket: where the speed drops to
  // 0 (a cusp) the step leaves the bracket and halves it instead.
  let lo = 0;
  let hi = 1;
  let t = length / total;
  for (let n = 0; n < 40; n++) {
    const error = lengthTo(segment, t) - length;
    // The bracket test too: near a fold the integration noise (up to about 2e-4 px) stays above the length tolerance.
    if (Math.abs(error) < 1e-9 * Math.max(1, total) || hi - lo < 1e-9) break;
    if (error < 0) lo = t;
    else hi = t;
    const v = derivativeAt(segment, t);
    const next = t - error / Math.hypot(v.x, v.y);
    t = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  return t;
}

function measureUncached(d: string) {
  const subpaths = parsePath(d);
  const segments = subpaths.flatMap((sub) => sub.segments);
  const lengths = segments.map((segment) => lengthTo(segment, 1));
  return { subpaths: subpaths.length, segments, lengths, total: lengths.reduce((a, b) => a + b, 0) };
}

// Scenes pass the same d on every frame, often to several of these functions: measure each d once. Internal only, so
// callers never hold the cached segments (parsePath still hands out fresh ones).
// Least recently read out first, so a d that changes every frame (a pie growing) drops its old frames before the
// glyphs read on every one. Capped in segments too (about 150-300 B each): a big d rebuilt every frame would
// otherwise keep 1024 of them.
// ponytail: 1024 d and 100k segments (about 7 KB for a 40-segment glyph, 30 MB at most); a scene cycling through
// more misses every time, and a d of more than about 100k segments next to a d that changes every frame is measured
// again on every frame (about 135 ms): raise the caps then.
const MEASURED_MAX = 1024;
const MEASURED_SEGMENTS_MAX = 100_000;
const measured = new Map<string, ReturnType<typeof measureUncached>>();
let measuredSegments = 0;
function measure(d: string) {
  let entry = measured.get(d);
  if (entry) {
    measured.delete(d);
  } else {
    entry = measureUncached(d);
    measuredSegments += entry.segments.length;
    for (const [old, { segments }] of measured) {
      if (measured.size < MEASURED_MAX && measuredSegments <= MEASURED_SEGMENTS_MAX) break;
      measured.delete(old);
      measuredSegments -= segments.length;
    }
  }
  measured.set(d, entry);
  return entry;
}

/** The segment and its t at a distance along the path, clamped to the path's ends. */
function locate(d: string, length: number, caller: string): { segment: CubicSegment; t: number } {
  if (Number.isNaN(length)) throw new Error(`${caller}: length is NaN`);
  const { segments, lengths, total } = measure(d);
  // A rounding residue (a trig polygon closed by Z, an exported SVG) draws nothing: its direction is noise. Zero-length
  // or residue segments only (a shape at size 0): no direction to give, like a path with no segment.
  const drawn = (k: number) => lengths[k] > 1e-9 * Math.max(1, total);
  const last = lengths.findLastIndex((_, k) => drawn(k));
  if (last === -1) throw new Error(`${caller}: the path draws nothing`);
  let rest = clamp(length, 0, total);
  for (let k = 0; k < last; k++) {
    if (rest <= lengths[k] && drawn(k))
      return { segment: segments[k], t: tAtLength(segments[k], clamp(rest, 0, lengths[k]), lengths[k]) };
    rest -= lengths[k];
  }
  // The last drawn segment takes what is left: the residues after it, and rounding a hair past the end. Clamped like the
  // others, since a residue shifts rest by a hair: past an end whose handle sits on it, the derivative points backwards.
  return { segment: segments[last], t: tAtLength(segments[last], clamp(rest, 0, lengths[last]), lengths[last]) };
}

/** Length of the drawn path in px (moves between subpaths add nothing), like SVG getTotalLength(). */
export function getLength(d: string): number {
  return measure(d).total;
}

/** Point at `length` px along the path; lengths outside [0, getLength(d)] clamp to the ends. */
export function getPointAtLength(d: string, length: number): Point {
  const { segment, t } = locate(d, length, 'getPointAtLength');
  return pointAt(segment, t);
}

/** Unit vector of the drawing direction at `length` px along the path. */
export function getTangentAtLength(d: string, length: number): Point {
  const { segment, t } = locate(d, length, 'getTangentAtLength');
  let v = derivativeAt(segment, t);
  // A handle on its end point makes the derivative vanish at that end (inside the segment, a cusp or a pause). The
  // derivative a hair inside gives the line there: ahead in the first half, behind in the second. It comes from the
  // control points, where a difference of two points at canvas coordinates is lost in rounding.
  if (Math.hypot(v.x, v.y) < 1e-9) v = derivativeAt(segment, t < 0.5 ? t + 1e-6 : t - 1e-6);
  const norm = Math.hypot(v.x, v.y);
  return { x: v.x / norm, y: v.y / norm };
}

/**
 * Stroke props that draw the path from its start by `progress` (0 to 1): spread them on a <path d={d}>.
 * One subpath per d: browsers restart the dash on each subpath, so split a logo into one <path> per subpath.
 */
export function evolvePath(progress: number, d: string): { strokeDasharray: string; strokeDashoffset: number } {
  if (Number.isNaN(progress)) throw new Error('evolvePath: progress is NaN');
  if (measure(d).subpaths > 1) {
    throw new Error('evolvePath: one subpath per d (browsers restart the dash on each), use one <path> per subpath');
  }
  const p = clamp(progress);
  // At the ends a dash would still show: a notch at the corner where a closed path meets its start, a round-cap dot
  // in WebKit before anything is drawn. Drawn means no dash; not started means one zero-length dash off the path.
  if (p >= 1) return { strokeDasharray: 'none', strokeDashoffset: 0 };
  const length = getLength(d);
  // The next dash sits a whole length past the end, so a browser that measures the path a little longer still misses it.
  if (p <= 0) return { strokeDasharray: `0 ${2 * length + 2}`, strokeDashoffset: 1 };
  return { strokeDasharray: `${length} ${length}`, strokeDashoffset: length * (1 - p) };
}
