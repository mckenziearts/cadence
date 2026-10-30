// Shape path data. Every shape is centred on (x, y), default (0, 0), and draws clockwise on screen; angles start
// straight up and turn clockwise, in degrees. rectPath is the exception: its origin is the top-left corner.

/** Coordinates to 3 decimals: trigonometry would otherwise print 6.123233995736766e-15. */
const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** Point at `radius` from (x, y), `turn` degrees clockwise from straight up. */
function polar(x: number, y: number, radius: number, turn: number): string {
  const a = (turn * Math.PI) / 180;
  return `${n(x + radius * Math.sin(a))},${n(y - radius * Math.cos(a))}`;
}

/** Rounded-rectangle path starting at the top-left corner, clockwise (for DrawPath wireframes). */
export function rectPath(x: number, y: number, w: number, h: number, r = 0): string {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  if (k === 0) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
  const arc = (ex: number, ey: number) => `A${k},${k} 0 0 1 ${ex},${ey}`;
  return (
    `M${x + k},${y}H${x + w - k}${arc(x + w, y + k)}V${y + h - k}${arc(x + w - k, y + h)}` +
    `H${x + k}${arc(x, y + h - k)}V${y + k}${arc(x + k, y)}Z`
  );
}

/** Rounded rectangle centred on (x, y); the corner radius is clamped to half the short side. */
export function roundedRect({
  width,
  height,
  cornerRadius = 0,
  x = 0,
  y = 0,
}: {
  width: number;
  height: number;
  cornerRadius?: number;
  x?: number;
  y?: number;
}): string {
  return rectPath(x - width / 2, y - height / 2, width, height, cornerRadius);
}

/** Ellipse centred on (x, y), starting at its rightmost point. */
export function ellipse({ rx, ry, x = 0, y = 0 }: { rx: number; ry: number; x?: number; y?: number }): string {
  const arc = (ex: number) => `A${n(rx)},${n(ry)} 0 1 1 ${n(ex)},${n(y)}`;
  return `M${n(x + rx)},${n(y)}${arc(x - rx)}${arc(x + rx)}Z`;
}

/** Circle centred on (x, y), starting at its rightmost point. */
export function circle({ radius, x = 0, y = 0 }: { radius: number; x?: number; y?: number }): string {
  return ellipse({ rx: radius, ry: radius, x, y });
}

/** Closed path through `radii` (one per vertex, repeated around the turn), first vertex at `rotation`. */
function ring(radii: number[], count: number, x: number, y: number, rotation: number): string {
  const vertices = Array.from({ length: count }, (_, i) => polar(x, y, radii[i % radii.length], rotation + (i * 360) / count));
  return `M${vertices.join('L')}Z`;
}

/** Regular polygon inscribed in a circle of `radius` around (x, y); its first vertex points up (then `rotation`). */
export function polygon({
  sides,
  radius,
  rotation = 0,
  x = 0,
  y = 0,
}: {
  sides: number;
  radius: number;
  rotation?: number;
  x?: number;
  y?: number;
}): string {
  if (!Number.isInteger(sides) || sides < 3) throw new Error(`polygon: needs a whole number of sides, at least 3 (got ${sides})`);
  return ring([radius], sides, x, y, rotation);
}

/** Star around (x, y): `points` tips at `outerRadius`, valleys at `innerRadius`; the first tip points up. */
export function star({
  points = 5,
  outerRadius,
  innerRadius,
  rotation = 0,
  x = 0,
  y = 0,
}: {
  points?: number;
  outerRadius: number;
  innerRadius: number;
  rotation?: number;
  x?: number;
  y?: number;
}): string {
  if (!Number.isInteger(points) || points < 2)
    throw new Error(`star: needs a whole number of points, at least 2 (got ${points})`);
  return ring([outerRadius, innerRadius], 2 * points, x, y, rotation);
}

/** Equilateral triangle of side `side`, its bounding box centred on (x, y), its tip towards `direction`. */
export function triangle({
  side,
  direction = 'up',
  x = 0,
  y = 0,
}: {
  side: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  x?: number;
  y?: number;
}): string {
  const tip = (side * Math.sqrt(3)) / 4;
  // Tip, then the two base corners clockwise, in the 'up' frame; the other directions turn it.
  const corners: [number, number][] = [
    [0, -tip],
    [side / 2, tip],
    [-side / 2, tip],
  ];
  const [cos, sin] = { up: [1, 0], right: [0, 1], down: [-1, 0], left: [0, -1] }[direction];
  const points = corners.map(([px, py]) => `${n(x + px * cos - py * sin)},${n(y + px * sin + py * cos)}`);
  return `M${points.join('L')}Z`;
}

/**
 * Pie slice of a circle of `radius` around (x, y): from straight up (then `rotation`), clockwise over `progress`
 * of the turn (0 to 1). The path starts at the centre; at 1 it is the whole circle.
 */
export function pie({
  radius,
  progress,
  rotation = 0,
  x = 0,
  y = 0,
}: {
  radius: number;
  progress: number;
  rotation?: number;
  x?: number;
  y?: number;
}): string {
  if (Number.isNaN(progress)) throw new Error('pie: progress is NaN');
  if (progress >= 1) return circle({ radius, x, y });
  if (progress <= 0) return `M${n(x)},${n(y)}Z`;
  const r = n(radius);
  const start = polar(x, y, radius, rotation);
  const end = polar(x, y, radius, rotation + progress * 360);
  // Near 0 or 1 (a spring settling), rounding lands the end on the start, and an arc between equal points draws
  // nothing (SVG 1.1 F.6.2): just under 1 the slice would vanish instead of filling.
  if (end === start) return progress > 0.5 ? circle({ radius, x, y }) : `M${n(x)},${n(y)}Z`;
  // Equal pieces of a quarter turn at most: the browser rebuilds each arc's centre from its rounded ends (F.6.5), which
  // drifts by px on a chord of a few thousandths (near a full turn) or a near-diameter (near half a turn).
  const pieces = Math.ceil(progress * 4);
  const arcs = Array.from(
    { length: pieces },
    (_, i) => `A${r},${r} 0 0 1 ${polar(x, y, radius, rotation + ((i + 1) / pieces) * progress * 360)}`,
  );
  return `M${n(x)},${n(y)}L${start}${arcs.join('')}Z`;
}
