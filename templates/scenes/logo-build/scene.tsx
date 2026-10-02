import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import {
  clamp,
  DrawPath,
  ease,
  Fill,
  mix,
  mixColor,
  progress,
  spring,
  springs,
  TypeOn,
  useBrand,
  useFormat,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Logo build: a dot pops inside a thin ring, opens into the brand mark, the wordmark unrolls from the mark while the
// lockup re-centers, then the URL types itself underneath (Caleb's logo outro).
// First frame: the plain background. Last frame: the lockup and the URL (end of the video: nothing leaves).

/** Under the logo: the brand URL, or this text when the brand has none (null = the brand tagline). */
const COPY = { fallback: null as string | null };

/** Beats from the scene start. */
const TIMING = {
  dot: 0, // the dot pops, the ring draws
  mark: [2, 4], // the dot opens into the mark (lands on beat 4)
  lockup: [5.6, 7.6], // the wordmark unrolls, the lockup re-centers
  url: [8.5, 10.5], // the URL types in
};

/** Logo height, vertical center of the lockup, URL size and gap, per format. */
const LAYOUT = {
  landscape: { height: 168, y: 520, url: 30, gap: 60 },
  portrait: { height: 170, y: 880, url: 36, gap: 64 },
  square: { height: 116, y: 520, url: 28, gap: 48 },
  '4:5': { height: 126, y: 640, url: 30, gap: 52 },
};

export default function LogoBuild({ t, width, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const { colors, fonts, Logo } = brand;
  const b = (n: number) => music.beat(n);
  const H = L.height;
  const cx = width / 2;

  // Widths of the mark and of the full lockup at H px (the kit's Logo keeps its aspect ratio).
  const markW = useLogoWidth(Logo, 'mark', H, H);
  const fullW = useLogoWidth(Logo, 'full', H, H * 3.4);

  const pop = spring(t - b(TIMING.dot), { from: 0, to: 1, ...springs.snappy });
  const ring = progress(t, b(TIMING.dot) + 0.1, b(TIMING.dot + 1.6), ease.inOutCubic);
  const open = progress(t, b(TIMING.mark[0]), b(TIMING.mark[1]), ease.inOutCubic);
  const markScale = t < b(TIMING.mark[0]) ? 0 : spring(t - b(TIMING.mark[0]), { from: 0.55, to: 1, ...springs.snappy });
  const k = progress(t, b(TIMING.lockup[0]), b(TIMING.lockup[1]), ease.inOutCubic);
  const shown = mix(markW, fullW, k);
  const left = cx - shown / 2;
  const wipe = mix(0, fullW, k);
  const handoff = clamp((wipe - markW) / (0.25 * fullW));
  // Once landed, the lockup thumps on the bars of the track (a silent video keeps it still).
  const pulse = music.hasTrack
    ? 1 + 0.012 * music.pulse(t, { grid: 'bar', decay: 5 }) * progress(t, b(TIMING.lockup[1]), b(TIMING.lockup[1] + 1))
    : 1;
  const url = brand.url || COPY.fallback || brand.tagline;
  const typing = progress(t, b(TIMING.url[0]), b(TIMING.url[1]));
  const dotSize = Math.round(H * 0.2);
  const top = L.y - H / 2;

  return (
    <Fill>
      <Backdrop />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transformOrigin: `${cx}px ${L.y}px`,
          transform: pulse !== 1 ? `scale(${pulse})` : undefined,
        }}
      >
        {/* The dot, then its ring (drawn, then widening and fading as the mark opens). */}
        {open < 1 ? (
          <svg width={width} height={L.y * 2} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
            <DrawPath
              d={circle(cx, L.y, H * 0.62 + H * 0.35 * open)}
              progress={ring}
              color={colors.line}
              width={1.5}
              opacity={1 - open}
            />
            <circle cx={cx} cy={L.y} r={(dotSize / 2) * pop * (1 - open)} fill={colors.ink} />
          </svg>
        ) : null}
        {/* The mark alone: opens from the dot (circular reveal), then rides with the lockup until the wordmark covers it. */}
        {open > 0 && handoff < 1 ? (
          <div
            style={{
              position: 'absolute',
              left: k > 0 ? left : cx - markW / 2,
              top,
              clipPath: open < 1 ? `circle(${mix(dotSize / 2, markW, open)}px at ${markW / 2}px ${H / 2}px)` : undefined,
              transformOrigin: `${markW / 2}px ${H / 2}px`,
              transform: markScale !== 1 ? `scale(${markScale})` : undefined,
              opacity: 1 - handoff,
            }}
          >
            <Logo variant="mark" height={H} />
          </div>
        ) : null}
        {/* The full lockup, unrolling from its left edge. */}
        {k > 0 ? (
          <div
            style={{ position: 'absolute', left, top, clipPath: k < 1 ? `inset(-4px ${fullW - wipe}px -4px -4px)` : undefined }}
          >
            <Logo variant="full" height={H} />
          </div>
        ) : null}
        {typing > 0 && url ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: L.y + H / 2 + L.gap,
              textAlign: 'center',
              fontFamily: fonts.body,
              fontSize: L.url,
              fontWeight: 500,
              letterSpacing: '0.01em',
              color: colors.muted,
            }}
          >
            <TypeOn
              text={url}
              progress={typing}
              reserve
              pendingColor={mixColor(colors.muted, colors.background, 0.7)}
              color={colors.muted}
              caret={
                typing < 1 || (t < b(TIMING.url[1] + 2) && music.beatPhase(t) < 0.5) ? { color: colors.accent, width: 3 } : false
              }
            />
          </div>
        ) : null}
      </div>
    </Fill>
  );
}

/** A circle as a path starting at its top, clockwise (so DrawPath draws it like a pen). */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r}A${r},${r} 0 1 1 ${cx},${cy + r}A${r},${r} 0 1 1 ${cx},${cy - r}`;
}

/**
 * Width of the brand logo at `height` px. Kits size their <svg> from its aspect ratio, so the element their Logo
 * returns carries it; this calls the component like a hook (same call every render). Falls back when unreadable.
 */
function useLogoWidth(Logo: BrandKit['Logo'], variant: 'mark' | 'full', height: number, fallback: number): number {
  if (typeof Logo !== 'function' || (Logo.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent)
    return fallback;
  const element = (Logo as (props: ComponentProps<BrandKit['Logo']>) => ReactNode)({ variant, height });
  const w = isValidElement(element) ? Number((element.props as { width?: unknown }).width) : NaN;
  return Number.isFinite(w) && w > 0 ? w : fallback;
}

// Shared by every template: the backdrop (the resting frame between scenes) and the headline weight. Cuts
// between scenes that end and start on the backdrop stay invisible only if it renders identically everywhere.

/**
 * The plain brand background: the resting frame between scenes. Flat on purpose: a soft radial light looked nice
 * but banded in 8-bit video; depth comes from the cards' shadows.
 */
function Backdrop() {
  const { colors } = useBrand();
  return <Fill style={{ background: colors.background }} />;
}

/** Weight the brand preloads for its display font ("700 104px 'Inter Variable'"), else 700. */
function displayWeight(brand: BrandKit): number {
  const family = brand.fonts.display
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '');
  const face = brand.fonts.preload.find((f) => f.includes(family));
  const weight = face ? parseInt(face, 10) : NaN;
  return Number.isFinite(weight) ? weight : 700;
}
