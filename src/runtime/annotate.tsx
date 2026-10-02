// Drawing and annotation kit: every piece is driven by `progress` (0 to 1 draws in, 1 to 0 retracts).
// Annotations (Tag, Callout, Dimension, RadiusArc, Guide, Highlight) keep their screen size inside a <Camera>:
// positions follow the content, strokes/dots/labels are divided by the camera zoom. CSS vector-effect cannot do
// this for us: non-scaling-stroke ignores transforms on HTML ancestors in Chromium.
import { useId, type CSSProperties, type ReactNode } from 'react';
import { clamp, mix, progress as progressOf } from './animate';
import { withAlpha } from './color';
import { ease } from './easing';
import { useCanvas, useKitTheme } from './scene';
import { Overlay, Pin, useCameraZoom } from './stage';
import type { Point } from './types';

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

export interface DrawPathProps {
  /** SVG path data (see rectPath). */
  d: string;
  /** 0 to 1: share of the path drawn from its start. */
  progress: number;
  /** Stroke color (default currentColor). */
  color?: string;
  /** Stroke width (default 2). Scales with the content. */
  width?: number;
  opacity?: number;
  /** Bright comet head riding the tip while drawing: true or { length (share of the path, default 0.06), color, width }. */
  head?: boolean | { length?: number; color?: string; width?: number };
  linecap?: 'round' | 'butt' | 'square';
  style?: CSSProperties;
}

/** An SVG path drawn by progress. Renders SVG elements: place it inside an <svg> (or a <Glow>). */
export function DrawPath({
  d,
  progress,
  color = 'currentColor',
  width = 2,
  opacity,
  head,
  linecap = 'round',
  style,
}: DrawPathProps) {
  const p = clamp(progress);
  if (p <= 0) return null;
  const headOptions = head === true ? {} : head || null;
  const h = Math.min(headOptions?.length ?? 0.06, p);
  const headWidth = headOptions?.width ?? width * 1.6;
  // A dash of length `len` ending exactly at the drawing tip.
  const dash = (len: number, w: number) => (
    <path
      d={d}
      fill="none"
      stroke={headOptions?.color ?? '#ffffff'}
      strokeWidth={w}
      strokeLinecap="round"
      pathLength={1}
      strokeDasharray={`${len} 2`}
      strokeDashoffset={len - p}
    />
  );
  return (
    <g opacity={opacity} style={style}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap={linecap}
        strokeLinejoin="round"
        {...(p < 1 ? { pathLength: 1, strokeDasharray: '1 1', strokeDashoffset: 1 - p } : null)}
      />
      {headOptions && p < 1 ? (
        <>
          {dash(h, headWidth)}
          {dash(Math.min(0.002, p), headWidth * 1.8)}
        </>
      ) : null}
    </g>
  );
}

export interface GlowProps {
  /** Glow color (default white). */
  color?: string;
  /** Strength, 0 to 2 (default 1). */
  intensity?: number;
  /** Blur radius of the outer bloom in px (default 10). */
  radius?: number;
  children?: ReactNode;
}

/** Bloom around SVG children (glowing wireframes on black). Renders SVG elements: place it inside an <svg>. */
export function Glow({ color = '#ffffff', intensity = 1, radius = 10, children }: GlowProps) {
  const id = `cadence-glow-${useId().replace(/[^\w-]/g, '')}`;
  const { width, height } = useCanvas();
  return (
    <>
      <defs>
        {/* userSpaceOnUse: a horizontal line has a zero-height bbox and would vanish with the default filter region. */}
        <filter
          id={id}
          filterUnits="userSpaceOnUse"
          x={-width}
          y={-height}
          width={width * 3}
          height={height * 3}
          colorInterpolationFilters="sRGB"
        >
          {/* A wide blur of a thin line is faint, so each blur's alpha is boosted separately. */}
          <feGaussianBlur in="SourceAlpha" stdDeviation={radius / 4} result="near" />
          <feComponentTransfer in="near" result="nearA">
            <feFuncA type="linear" slope={1.5 * intensity} />
          </feComponentTransfer>
          <feGaussianBlur in="SourceAlpha" stdDeviation={radius} result="far" />
          <feComponentTransfer in="far" result="farA">
            <feFuncA type="linear" slope={4 * intensity} />
          </feComponentTransfer>
          <feMerge result="strength">
            <feMergeNode in="farA" />
            <feMergeNode in="nearA" />
          </feMerge>
          <feFlood floodColor={color} result="tint" />
          <feComposite in="tint" in2="strength" operator="in" result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#${id})`}>{children}</g>
    </>
  );
}

export type Anchor = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Which point of the box sits on the anchor point, in % of the box. */
const ANCHORS: Record<Anchor, [number, number]> = {
  center: [50, 50],
  left: [0, 50],
  right: [100, 50],
  top: [50, 0],
  bottom: [50, 100],
  'top-left': [0, 0],
  'top-right': [100, 0],
  'bottom-left': [0, 100],
  'bottom-right': [100, 100],
};

/** Anchor whose side faces back along `(dx, dy)`: a label placed past the end of a line. */
function anchorFacing(dx: number, dy: number): Anchor {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
  return dy >= 0 ? 'top' : 'bottom';
}

export interface TagProps {
  children?: ReactNode;
  /** Anchor point in canvas px. Omit x and y to render the tag inline. */
  x?: number;
  y?: number;
  /** Which point of the pill sits on (x, y). Default 'center'. */
  anchor?: Anchor;
  /** Background (default brand accent). */
  color?: string;
  /** Text color (default white). */
  textColor?: string;
  /** Small monospace code tag, like "card.footer". */
  mono?: boolean;
  /** Font size in px (default 22, mono 15). */
  size?: number;
  /** 0 to 1 pop-in (default 1). */
  progress?: number;
  style?: CSSProperties;
  className?: string;
}

/** Pill label (Caleb's pink annotation tags). Keeps its screen size inside a Camera. */
export function Tag({
  children,
  x,
  y,
  anchor = 'center',
  color,
  textColor = '#ffffff',
  mono = false,
  size,
  progress = 1,
  style,
  className,
}: TagProps) {
  const theme = useKitTheme();
  const p = clamp(progress);
  if (p <= 0) return null;
  const bg = color ?? theme.accent;
  const positioned = x !== undefined && y !== undefined;
  const [ax, ay] = ANCHORS[anchor];
  const scale = mix(0.85, 1, ease.outBack(p));
  const pill = (
    <div
      className={className}
      style={{
        ...(positioned ? { position: 'absolute' as const, left: 0, top: 0 } : null),
        display: 'inline-flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        padding: mono ? '0.12em 0.4em' : '0.2em 0.55em',
        borderRadius: mono ? '0.25em' : '0.36em',
        background: bg,
        color: textColor,
        fontFamily: mono ? theme.mono : theme.font,
        fontSize: size ?? (mono ? 15 : 22),
        fontWeight: mono ? 500 : 600,
        lineHeight: 1.25,
        letterSpacing: mono ? '0.01em' : '-0.01em',
        boxShadow: mono ? undefined : `0 0.2em 0.7em ${withAlpha(bg, 0.3)}`,
        opacity: clamp(p * 1.5),
        transformOrigin: `${ax}% ${ay}%`,
        transform: positioned ? `translate(${-ax}%, ${-ay}%) scale(${scale})` : `scale(${scale})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
  return positioned ? (
    <Pin x={x} y={y}>
      {pill}
    </Pin>
  ) : (
    pill
  );
}

export interface CalloutProps {
  /** Anchor on the object, canvas px. */
  from: Point;
  /** End of the line, where the label starts (label on the right when to.x >= from.x, else on the left). */
  to: Point;
  label: ReactNode;
  /** 0 to 1: the dot pops, the line draws, the label fades in last (and leaves first when reversed). Default 1. */
  progress?: number;
  /** 'line' (default): thin ink line, hollow dot, text label. 'tag': accent line, dot with halo, pill label. */
  variant?: 'line' | 'tag';
  color?: string;
  /** Screen px of the horizontal run into the label (default 40; 0 = one straight segment). */
  elbow?: number;
  labelStyle?: CSSProperties;
}

/** Anchor dot, then elbow line, then label. */
export function Callout({ from, to, label, progress = 1, variant = 'line', color, elbow = 40, labelStyle }: CalloutProps) {
  const theme = useKitTheme();
  const u = 1 / useCameraZoom();
  const p = clamp(progress);
  if (p <= 0) return null;
  const tag = variant === 'tag';
  const stroke = color ?? (tag ? theme.accent : theme.ink);
  const dir = to.x >= from.x ? 1 : -1;
  const run = Math.min(elbow * u, Math.abs(to.x - from.x));
  const d = `M${from.x},${from.y}${run > 0 ? `L${to.x - dir * run},${to.y}` : ''}L${to.x},${to.y}`;
  const dot = progressOf(p, 0, 0.3, ease.outBack);
  const line = progressOf(p, 0.15, 0.75, ease.outCubic);
  const text = progressOf(p, 0.6, 1, ease.outCubic);
  const gap = 10 * u;
  const slide = (1 - text) * 10 * dir;
  return (
    <>
      <Overlay>
        <DrawPath d={d} progress={line} color={stroke} width={1.6 * u} opacity={tag ? 1 : 0.75} linecap="butt" />
        {tag ? <circle cx={from.x} cy={from.y} r={12 * u * dot} fill={withAlpha(stroke, 0.16)} /> : null}
        <circle
          cx={from.x}
          cy={from.y}
          r={(tag ? 4.5 : 5.5) * u * dot}
          fill={tag ? stroke : theme.surface}
          stroke={tag ? undefined : stroke}
          strokeWidth={1.6 * u}
        />
      </Overlay>
      {tag ? (
        <Tag x={to.x + dir * gap} y={to.y} anchor={dir > 0 ? 'left' : 'right'} color={stroke} progress={text} style={labelStyle}>
          {label}
        </Tag>
      ) : text > 0 ? (
        <Pin x={to.x + dir * gap} y={to.y}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: `translate(${dir > 0 ? 0 : -100}%, -50%) translateX(${slide}px)`,
              whiteSpace: 'nowrap',
              fontFamily: theme.font,
              fontSize: 22,
              fontWeight: 500,
              lineHeight: 1.3,
              color: theme.ink,
              opacity: text,
              ...labelStyle,
            }}
          >
            {label}
          </div>
        </Pin>
      ) : null}
    </>
  );
}

export interface DimensionProps {
  from: Point;
  to: Point;
  /** Default: the length in px, rounded. null/false hides it. */
  label?: ReactNode;
  /** 0 to 1: the line grows from its middle, the end ticks pop, the label appears. Default 1. */
  progress?: number;
  /** Default brand accent. */
  color?: string;
  /** End tick length in screen px (default 12). */
  tick?: number;
  /** 'center' (on the line), 'start' or 'end' (past that end). Default 'center'. */
  labelAt?: 'center' | 'start' | 'end';
}

/** Measure line with end ticks and a value tag ("480", "4"). */
export function Dimension({ from, to, label, progress = 1, color, tick = 12, labelAt = 'center' }: DimensionProps) {
  const theme = useKitTheme();
  const u = 1 / useCameraZoom();
  const p = clamp(progress);
  if (p <= 0) return null;
  const c = color ?? theme.accent;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const nx = length ? -dy / length : 0;
  const ny = length ? dx / length : 1;
  const grow = progressOf(p, 0, 0.6, ease.outCubic) / 2;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const half = (progressOf(p, 0.45, 0.8, ease.outBack) * tick * u) / 2;
  const tickPath = (q: Point) => `M${q.x + nx * half},${q.y + ny * half}L${q.x - nx * half},${q.y - ny * half}`;
  const text = label === undefined ? String(Math.round(length)) : label;
  const gap = 8 * u;
  const out = length ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
  const labelPoint =
    labelAt === 'center'
      ? mid
      : labelAt === 'end'
        ? { x: to.x + out.x * gap, y: to.y + out.y * gap }
        : { x: from.x - out.x * gap, y: from.y - out.y * gap };
  const anchor: Anchor =
    labelAt === 'center' ? 'center' : labelAt === 'end' ? anchorFacing(out.x, out.y) : anchorFacing(-out.x, -out.y);
  return (
    <>
      <Overlay>
        <path
          d={`M${mid.x - dx * grow},${mid.y - dy * grow}L${mid.x + dx * grow},${mid.y + dy * grow}`}
          stroke={c}
          strokeWidth={1.5 * u}
        />
        {half > 0 ? <path d={tickPath(from) + tickPath(to)} stroke={c} strokeWidth={1.5 * u} /> : null}
      </Overlay>
      {text !== null && text !== false ? (
        <Tag
          x={labelPoint.x}
          y={labelPoint.y}
          anchor={anchor}
          color={c}
          size={18}
          progress={progressOf(p, 0.55, 1, ease.outCubic)}
        >
          {text}
        </Tag>
      ) : null}
    </>
  );
}

export interface RadiusArcProps {
  /** Outer corner of the element's box (where its two edges would meet), canvas px. */
  x: number;
  y: number;
  /** Corner radius, canvas px. */
  r: number;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Default `r ${r}`. */
  label?: ReactNode;
  /** 0 to 1: circle draws, corner arc thickens, radius line and label appear. Default 1. */
  progress?: number;
  /** Default brand accent. */
  color?: string;
  /** Screen px the radius line runs past the arc before the label (default 30; 0 = label on the arc). */
  extend?: number;
}

/** Radius annotation: faint full circle, bold corner arc, center dot, 45° radius line and tag ("r 16"). */
export function RadiusArc({ x, y, r, corner, label, progress = 1, color, extend = 30 }: RadiusArcProps) {
  const theme = useKitTheme();
  const u = 1 / useCameraZoom();
  const p = clamp(progress);
  if (p <= 0) return null;
  const c = color ?? theme.accent;
  const sx = corner.endsWith('right') ? 1 : -1;
  const sy = corner.startsWith('bottom') ? 1 : -1;
  const cx = x - sx * r;
  const cy = y - sy * r;
  const diag = Math.SQRT1_2;
  const reach = r + extend * u;
  const end = { x: cx + sx * diag * reach, y: cy + sy * diag * reach };
  const circle = progressOf(p, 0, 0.55, ease.smooth);
  const arc = progressOf(p, 0.3, 0.75, ease.outCubic);
  const radius = progressOf(p, 0.45, 0.8, ease.outCubic);
  const dot = progressOf(p, 0, 0.25, ease.outBack);
  // Corner quarter from the side edge to the bottom/top edge; SVG sweep 1 = clockwise on screen.
  const quarter = `M${cx + sx * r},${cy}A${r},${r} 0 0 ${sx * sy > 0 ? 1 : 0} ${cx},${cy + sy * r}`;
  const anchor = `${sy > 0 ? 'top' : 'bottom'}-${sx > 0 ? 'left' : 'right'}` as Anchor;
  return (
    <>
      <Overlay>
        <DrawPath
          d={`M${cx + r},${cy}A${r},${r} 0 1 1 ${cx - r},${cy}A${r},${r} 0 1 1 ${cx + r},${cy}`}
          progress={circle}
          color={c}
          width={1.5 * u}
          opacity={0.45}
          linecap="butt"
        />
        <DrawPath d={quarter} progress={arc} color={c} width={3.5 * u} />
        <DrawPath d={`M${cx},${cy}L${end.x},${end.y}`} progress={radius} color={c} width={1.5 * u} linecap="butt" />
        <circle cx={cx} cy={cy} r={5 * u * dot} fill={c} />
      </Overlay>
      <Tag x={end.x} y={end.y} anchor={anchor} color={c} size={18} progress={progressOf(p, 0.7, 1, ease.outCubic)}>
        {label ?? `r ${r}`}
      </Tag>
    </>
  );
}

export interface GuideProps {
  /** Vertical guide across the canvas at this x... */
  x?: number;
  /** ...or horizontal guide across the canvas at this y... */
  y?: number;
  /** ...or a segment from `from` to `to`. */
  from?: Point;
  to?: Point;
  /** 0 to 1: draws from `from` (the left/top edge for x/y guides). Default 1. */
  progress?: number;
  /** Default brand accent. */
  color?: string;
  /** Default true. */
  dashed?: boolean;
  /** Screen px (default 1.5). */
  width?: number;
  opacity?: number;
}

/** Alignment guide line (baselines, edges, overhangs). */
export function Guide({ x, y, from, to, progress = 1, color, dashed = true, width = 1.5, opacity = 1 }: GuideProps) {
  const theme = useKitTheme();
  const canvas = useCanvas();
  const u = 1 / useCameraZoom();
  const p = clamp(progress);
  if (p <= 0) return null;
  const [a, b] =
    from && to
      ? [from, to]
      : x !== undefined
        ? [
            { x, y: 0 },
            { x, y: canvas.height },
          ]
        : y !== undefined
          ? [
              { x: 0, y },
              { x: canvas.width, y },
            ]
          : [null, null];
  if (!a || !b) throw new Error('Guide needs x, y, or from and to');
  return (
    <Overlay>
      <path
        d={`M${a.x},${a.y}L${mix(a.x, b.x, p)},${mix(a.y, b.y, p)}`}
        stroke={color ?? theme.accent}
        strokeWidth={width * u}
        strokeDasharray={dashed ? `${6 * u} ${5 * u}` : undefined}
        opacity={opacity}
      />
    </Overlay>
  );
}

export interface HighlightProps {
  /** Box of the highlighted element, canvas px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The element's corner radius (default 12). */
  radius?: number;
  /** Outset in screen px (default 4). */
  pad?: number;
  /** Small mono tag on the top-left corner, e.g. "card.footer". */
  label?: ReactNode;
  /** 0 to 1: the outline snaps in from slightly larger, then the label pops. Default 1. */
  progress?: number;
  /** Default brand accent. */
  color?: string;
  /** Fill opacity (default 0.05). */
  fill?: number;
}

/** Outline around an element, with an optional code-style label. */
export function Highlight({
  x,
  y,
  width,
  height,
  radius = 12,
  pad = 4,
  label,
  progress = 1,
  color,
  fill = 0.05,
}: HighlightProps) {
  const theme = useKitTheme();
  const u = 1 / useCameraZoom();
  const p = clamp(progress);
  if (p <= 0) return null;
  const c = color ?? theme.accent;
  const o = (pad + 10 * (1 - progressOf(p, 0, 0.7, ease.outCubic))) * u;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x - o,
          top: y - o,
          width: width + 2 * o,
          height: height + 2 * o,
          boxSizing: 'border-box',
          borderRadius: radius + o,
          border: `${2 * u}px solid ${c}`,
          background: withAlpha(c, fill),
          boxShadow: `0 0 0 ${4 * u}px ${withAlpha(c, 0.1)}`,
          opacity: progressOf(p, 0, 0.5),
          pointerEvents: 'none',
        }}
      />
      {label ? (
        <Tag x={x - o} y={y - o} anchor="bottom-left" mono color={c} progress={progressOf(p, 0.3, 0.9)}>
          {label}
        </Tag>
      ) : null}
    </>
  );
}
