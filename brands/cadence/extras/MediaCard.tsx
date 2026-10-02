import { useId } from 'react';
import type { KitBaseProps } from '../../../src/shared/brandKit';
import { clamp, colors, fonts, mix, radius, shadow } from '../tokens';
import { MenuDots } from './ProfileCard';

export interface MediaCardProps extends KitBaseProps {
  title?: string;
  caption?: string;
  /** 0 = image inset in the card, 1 = image edge to edge (full bleed). */
  bleed?: number;
  /** 0..1 height of the sun above the dunes. */
  sun?: number;
  width?: number;
}

/** Greyscale dunes at sunset, drawn in SVG (no image file needed); fills its box. */
export function Landscape({ sun = 0.6, style }: { sun?: number; style?: KitBaseProps['style'] }) {
  const id = useId();
  const cy = mix(292, 170, clamp(sun));
  return (
    <svg
      viewBox="0 0 640 360"
      preserveAspectRatio="xMidYMid slice"
      style={{ display: 'block', width: '100%', height: '100%', ...style }}
    >
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c1c1f" />
          <stop offset="0.55" stopColor="#52525b" />
          <stop offset="1" stopColor="#b4b4bb" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx="400" cy={cy} r="190" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.75" />
          <stop offset="0.3" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="640" height="360" fill={`url(#${id}sky)`} />
      <rect width="640" height="360" fill={`url(#${id}glow)`} />
      <circle cx="400" cy={cy} r="30" fill="#fafafa" />
      <path d="M0 252C90 226 170 236 250 246S420 222 500 236 600 252 640 242V360H0Z" fill="#8c8c93" />
      <path d="M0 278C110 256 200 288 320 272S520 252 640 274V360H0Z" fill="#6c6c74" />
      <path d="M0 306C140 282 260 302 380 298S560 286 640 302V360H0Z" fill="#48484f" />
      <path d="M0 336C160 316 300 342 460 330S600 331 640 338V360H0Z" fill="#26262a" />
    </svg>
  );
}

/** Photo card from the "Full bleed" beat: the image grows from inset to edge to edge as `bleed` goes from 0 to 1. */
export function MediaCard({
  title = 'Last light',
  caption = 'Dolomites, 6:42 pm',
  bleed = 0,
  sun = 0.6,
  width = 560,
  style,
  className,
}: MediaCardProps) {
  const b = clamp(bleed);
  const inset = mix(14, 0, b);
  const corner = mix(radius.xl - 12, 0, b);
  return (
    <div
      className={className}
      style={{
        width,
        overflow: 'hidden',
        boxSizing: 'border-box',
        borderRadius: radius.xl,
        background: colors.surface,
        border: `1px solid ${colors.line}`,
        boxShadow: shadow.card,
        fontFamily: fonts.body,
        ...style,
      }}
    >
      <div
        style={{
          margin: `${inset}px ${inset}px 0`,
          height: ((width - 2 - 2 * inset) * 9) / 16,
          borderRadius: corner,
          overflow: 'hidden',
        }}
      >
        <Landscape sun={sun} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 24px 20px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: colors.ink }}>{title}</div>
          <div style={{ marginTop: 2, fontSize: 17, color: colors.muted }}>{caption}</div>
        </div>
        <MenuDots />
      </div>
    </div>
  );
}
