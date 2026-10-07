// Device frames and finishing layers.
import { useId, type CSSProperties, type ReactNode } from 'react';
import { withAlpha } from './color';
import { useCanvas, useKitTheme } from './scene';

export interface BrowserFrameProps {
  /** Outer size in px; the page gets width × (height − 52). */
  width: number;
  height: number;
  /** Text of the address bar. */
  url?: string;
  dark?: boolean;
  /** Corner radius (default 14). */
  radius?: number;
  /** The page. */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

const BROWSER_BAR = 52;

/** Desktop browser window: traffic lights, address bar, page viewport (children). Position it with `style`. */
export function BrowserFrame({
  width,
  height,
  url = '',
  dark = false,
  radius = 14,
  children,
  style,
  className,
}: BrowserFrameProps) {
  const theme = useKitTheme();
  const c = dark
    ? { bar: '#26262b', field: '#1a1a1e', text: '#a1a1aa', line: 'rgba(255, 255, 255, 0.08)', page: '#0f0f12' }
    : { bar: '#f4f4f5', field: '#ffffff', text: '#71717a', line: 'rgba(0, 0, 0, 0.08)', page: '#ffffff' };
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: radius,
        overflow: 'hidden',
        background: c.page,
        boxShadow: `0 0 0 1px ${c.line}, 0 24px 60px rgba(0, 0, 0, 0.16)`,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          height: BROWSER_BAR,
          background: c.bar,
          borderBottom: `1px solid ${c.line}`,
        }}
      >
        {['#ff5f57', '#febc2e', '#28c840'].map((color, i) => (
          <span
            key={color}
            style={{
              position: 'absolute',
              left: 20 + i * 20,
              top: BROWSER_BAR / 2 - 6,
              width: 12,
              height: 12,
              borderRadius: 6,
              background: color,
            }}
          />
        ))}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: (BROWSER_BAR - 30) / 2,
            transform: 'translateX(-50%)',
            width: Math.min(560, width * 0.5),
            height: 30,
            borderRadius: 8,
            background: c.field,
            boxShadow: `inset 0 0 0 1px ${c.line}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            fontFamily: theme.font,
            fontSize: 14,
            color: c.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <svg width={10} height={12} viewBox="0 0 10 12" style={{ flex: 'none' }}>
            <rect x={0.5} y={5} width={9} height={6.5} rx={1.5} fill={c.text} />
            <path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke={c.text} strokeWidth={1.4} />
          </svg>
          {url}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 0, top: BROWSER_BAR, right: 0, bottom: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

export interface PhoneFrameProps {
  /** Outer width in px (default 400). Every detail scales with it. */
  width?: number;
  /** Outer height (default width × 2.05). */
  height?: number;
  /** Body color (default near-black). */
  color?: string;
  /** Screen background (default white). */
  screen?: string;
  /** Status bar time (default '9:41'); false hides the status bar. */
  time?: string | false;
  /** Light status bar glyphs, for dark screens. */
  darkScreen?: boolean;
  /** The screen content (fills the screen, under the status bar: keep ~0.13 × width free at the top). */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/** Modern phone with a dynamic island and a status bar; children are the screen. Position it with `style`. */
export function PhoneFrame({
  width = 400,
  height = width * 2.05,
  color = '#0b0b0d',
  screen = '#ffffff',
  time = '9:41',
  darkScreen = false,
  children,
  style,
  className,
}: PhoneFrameProps) {
  const theme = useKitTheme();
  const bezel = width * 0.035;
  const outer = width * 0.165;
  const glyph = darkScreen ? '#ffffff' : '#0a0a0a';
  const bar = width * 0.13;
  const font = width * 0.042;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: outer,
        background: color,
        boxShadow: `inset 0 0 0 ${width * 0.006}px ${withAlpha('#ffffff', 0.14)}, 0 30px 70px rgba(0, 0, 0, 0.22)`,
        ...style,
      }}
    >
      <div style={{ position: 'absolute', inset: bezel, borderRadius: outer - bezel, overflow: 'hidden', background: screen }}>
        {children}
        {time === false ? null : (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: bar, color: glyph, fontFamily: theme.font }}>
            <span style={{ position: 'absolute', left: '15%', top: bar * 0.36, fontSize: font, fontWeight: 600, lineHeight: 1 }}>
              {time}
            </span>
            <svg
              width={width * 0.16}
              height={font}
              viewBox="0 0 64 16"
              style={{ position: 'absolute', right: '9%', top: bar * 0.36 }}
              fill={glyph}
            >
              {[0, 1, 2, 3].map((i) => (
                <rect key={i} x={i * 5} y={12 - i * 3} width={3.4} height={4 + i * 3} rx={1} />
              ))}
              <rect
                x={33}
                y={2.5}
                width={25}
                height={12}
                rx={3.5}
                fill="none"
                stroke={glyph}
                strokeOpacity={0.4}
                strokeWidth={1.2}
              />
              <rect x={35} y={4.5} width={19} height={8} rx={2} />
              <rect x={59.5} y={6.5} width={2} height={4} rx={1} fillOpacity={0.4} />
            </svg>
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: width * 0.028,
            width: width * 0.28,
            height: width * 0.082,
            transform: 'translateX(-50%)',
            borderRadius: width,
            background: '#000000',
          }}
        />
      </div>
    </div>
  );
}

export interface GrainProps {
  /** Noise pattern (integer). */
  seed?: number;
  /** Animate: pass the scene time; the pattern changes `fps` times per second. */
  t?: number;
  fps?: number;
  /** Default 0.08. */
  opacity?: number;
  /** Noise frequency; higher = finer grain (default 0.85). */
  frequency?: number;
  /** Default 'overlay'. */
  blend?: CSSProperties['mixBlendMode'];
}

/** Film grain over the whole canvas: breaks banding in dark gradients. Static for a seed; animated only through t. */
export function Grain({ seed = 0, t, fps = 12, opacity = 0.08, frequency = 0.85, blend = 'overlay' }: GrainProps) {
  const id = `cadence-grain-${useId().replace(/[^\w-]/g, '')}`;
  const { width, height } = useCanvas();
  const frame = seed + (t === undefined ? 0 : Math.floor(t * fps));
  return (
    <svg
      data-cadence-decor=""
      width={width}
      height={height}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', opacity, mixBlendMode: blend }}
    >
      <filter id={id} x={0} y={0} width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={2} seed={frame} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#${id})`} />
    </svg>
  );
}

export interface VignetteProps {
  /** Default black. */
  color?: string;
  /** Darkness at the corners, 0 to 1 (default 0.45). */
  strength?: number;
  /** Share of the canvas (from the center) left untouched, 0 to 1 (default 0.55). */
  size?: number;
}

/** Darkens the edges of the canvas. */
export function Vignette({ color = '#000000', strength = 0.45, size = 0.55 }: VignetteProps) {
  return (
    <div
      data-cadence-decor=""
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background: `radial-gradient(ellipse at center, ${withAlpha(color, 0)} ${size * 100}%, ${withAlpha(color, strength)} 100%)`,
      }}
    />
  );
}
