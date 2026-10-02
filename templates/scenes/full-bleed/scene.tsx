import {
  ease,
  Fill,
  interpolateColor,
  measureText,
  mix,
  mixColor,
  progress,
  Tag,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Full bleed: a photo card sits next to a two-line headline; its padding is marked, the image bleeds to the card's
// edges, then opens to the whole frame (the headline turns white over it), and folds back into the card
// (Caleb's "Full bleed. Edge to edge.").
// First frame: the plain background. Last frame: the plain background (everything exits on the last beat).

/** On-screen copy, per brand language. */
const COPY = {
  fr: {
    lines: ['Plein cadre.', 'Bord à bord.'],
    title: 'Dernière lumière',
    caption: 'Dolomites, 18 h 42',
    padding: 'padding 24',
    bleed: 'bleed',
  },
  en: {
    lines: ['Full bleed.', 'Edge to edge.'],
    title: 'Last light',
    caption: 'Dolomites, 6:42 pm',
    padding: 'padding 24',
    bleed: 'bleed',
  },
};

/** Beats from the scene start, except `back` and `exit`: beats before the end. */
const TIMING = {
  enter: [0, 2], // headline and card arrive
  padding: [1.8, 3.6], // the padding is marked
  bleed: [3.6, 4.4], // the image bleeds to the card's edges (lands on beat 4)
  open: [5.6, 7], // the image opens to the whole frame (lands on beat 7)
  back: [2.6, 1.2], // the image folds back into the card
  exit: [0.9, 0], // everything leaves
};

/** Headline (left, top or vertical center, size), card (left, top, width), per format. */
const LAYOUT = {
  landscape: { head: { x: 140, y: 540, size: 104, center: true }, card: { x: 1000, y: 262, w: 740 } },
  portrait: { head: { x: 60, y: 290, size: 96, center: false }, card: { x: 90, y: 620, w: 900 } },
  square: { head: { x: 80, y: 80, size: 72, center: false }, card: { x: 190, y: 330, w: 700 } },
  '4:5': { head: { x: 80, y: 100, size: 80, center: false }, card: { x: 150, y: 400, w: 780 } },
};

/** Inner padding of the card around the image, caption height, image aspect ratio (w / h). */
const MEDIA = { pad: 24, caption: 96, ratio: 16 / 10 };

export default function FullBleed({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const copy = COPY[brand.language] ?? COPY.fr;
  const { ui, colors, fonts, radius } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const enter = progress(t, b(TIMING.enter[0]), b(TIMING.enter[1]));
  const arrive = ease.outExpo(progress(t, b(TIMING.enter[0] + 0.25), b(TIMING.enter[1])));
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const marked =
    progress(t, b(TIMING.padding[0]), b(TIMING.padding[0]) + 0.4, ease.outCubic) *
    (1 - progress(t, b(TIMING.bleed[0]) - 0.1, b(TIMING.bleed[0]) + 0.15));
  const bleed = progress(t, b(TIMING.bleed[0]), b(TIMING.bleed[1]), ease.inOutCubic);
  const open =
    progress(t, b(TIMING.open[0]), b(TIMING.open[1]), ease.inOutCubic) *
    (1 - progress(t, end(TIMING.back[0]), end(TIMING.back[1]), ease.inOutCubic));
  const bleedTag =
    progress(t, b(TIMING.bleed[1]) - 0.1, b(TIMING.bleed[1]) + 0.3, ease.outCubic) *
    (1 - progress(t, b(TIMING.open[0]), b(TIMING.open[0]) + 0.25));

  // Card box, image box inside it (inset by the padding until it bleeds), then the image box opens to the canvas.
  const rise = (1 - arrive) * 60 + exit * 30;
  const cw = L.card.w;
  const iw0 = cw - 2 * MEDIA.pad;
  const ih = Math.round(iw0 / MEDIA.ratio);
  const ch = MEDIA.pad + ih + MEDIA.caption;
  const cx = L.card.x;
  const cy = L.card.y + rise;
  const inset = MEDIA.pad * (1 - bleed);
  const inCard = { x: cx + inset, y: cy + inset, w: cw - 2 * inset, h: ih + MEDIA.pad - inset };
  const box = {
    x: mix(inCard.x, 0, open),
    y: mix(inCard.y, 0, open),
    w: mix(inCard.w, width, open),
    h: mix(inCard.h, height, open),
  };
  const r = radius.xl;
  const corner = (1 - open) * (bleed > 0 ? mix(Math.max(2, radius.md), r, bleed) : Math.max(2, radius.md));
  const bottom = (1 - open) * (1 - bleed) * Math.max(2, radius.md);

  const headColor = interpolateColor(open, [0.35, 0.8], [colors.ink, '#ffffff']);
  const subColor = interpolateColor(
    open,
    [0.35, 0.8],
    [mixColor(colors.muted, colors.background, 0.1), withAlpha('#ffffff', 0.72)],
  );

  return (
    <Fill>
      <Backdrop />
      <div style={{ position: 'absolute', inset: 0, opacity: 1 - exit }}>
        <div style={{ position: 'absolute', inset: 0, opacity: Math.min(1, arrive * 1.6) }}>
          <ui.Card variant="default" padding={0} style={{ position: 'absolute', left: cx, top: cy, width: cw, height: ch }}>
            <div
              style={{
                position: 'absolute',
                left: MEDIA.pad,
                right: MEDIA.pad,
                bottom: 22,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                fontFamily: fonts.body,
              }}
            >
              <div>
                <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.35, color: colors.ink }}>{copy.title}</div>
                <div style={{ marginTop: 2, fontSize: 17, lineHeight: 1.35, color: colors.muted }}>{copy.caption}</div>
              </div>
              <div style={{ display: 'flex', gap: 4, paddingBottom: 10 }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{ width: 5, height: 5, borderRadius: 3, background: colors.muted }} />
                ))}
              </div>
            </div>
          </ui.Card>
          {marked > 0 ? (
            // The padding, hatched in the accent color around the image.
            <div
              style={{
                position: 'absolute',
                left: cx,
                top: cy,
                width: cw,
                height: ih + 2 * MEDIA.pad,
                borderRadius: `${r}px ${r}px 0 0`,
                background: `repeating-linear-gradient(45deg, ${withAlpha(colors.accent, 0.55)} 0 1.5px, transparent 1.5px 8px)`,
                boxShadow: `inset 0 0 0 1.5px ${withAlpha(colors.accent, 0.8)}`,
                opacity: marked,
              }}
            />
          ) : null}
          <div
            style={{
              position: 'absolute',
              left: box.x,
              top: box.y,
              width: box.w,
              height: box.h,
              overflow: 'hidden',
              borderRadius: `${corner}px ${corner}px ${bottom}px ${bottom}px`,
            }}
          >
            <Landscape brand={brand} t={t} />
          </div>
          {marked > 0 ? (
            <Tag x={cx + 10} y={cy + 10} anchor="top-left" mono progress={marked}>
              {copy.padding}
            </Tag>
          ) : null}
          {bleedTag > 0 ? (
            <Tag x={box.x + 14} y={box.y + 14} anchor="top-left" mono progress={bleedTag}>
              {copy.bleed}
            </Tag>
          ) : null}
        </div>
        <Lines lines={copy.lines} colors={[headColor, subColor]} p={enter} {...L.head} />
      </div>
    </Fill>
  );
}

/** Two headline lines rising from a mask; `y` is their vertical center when `center`, else their top. */
function Lines({
  lines,
  colors,
  p,
  x,
  y,
  size,
  center,
}: {
  lines: string[];
  colors: string[];
  p: number;
  x: number;
  y: number;
  size: number;
  center: boolean;
}) {
  const brand = useBrand();
  const { width } = useFormat();
  const type = { fontFamily: brand.fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.03em' };
  const max = width - x - (center ? 1000 : 80);
  const fit = Math.min(
    size,
    ...lines.map((line) => (size * Math.max(300, max)) / measureText(line, { ...type, fontSize: size }).width),
  );
  const lineHeight = Math.round(fit * 1.06);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: center ? y - lineHeight : y,
        ...type,
        fontSize: Math.floor(fit),
        lineHeight: `${lineHeight}px`,
      }}
    >
      {lines.map((line, i) => {
        const k = progress(p, i * 0.12, 0.75 + i * 0.12);
        return (
          <div key={i} style={{ height: lineHeight, overflow: 'hidden', paddingBottom: '0.14em', marginBottom: '-0.14em' }}>
            <div style={{ color: colors[i], transform: k < 1 ? `translateY(${(1 - ease.outExpo(k)) * 110}%)` : undefined }}>
              {line}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Dunes at dusk, tinted by the brand's primary color, drawn to cover its box (like object-fit: cover). */
function Landscape({ brand, t }: { brand: BrandKit; t: number }) {
  const tint = mixColor(brand.colors.primary, '#71717a', 0.6);
  const shade = (k: number) => mixColor(tint, '#000000', k);
  const drift = t * 6;
  // Smooth dune ridge: a sum of two sines, closed down to the bottom of the view box.
  const ridge = (base: number, amp: number, freq: number, phase: number) => {
    const points: string[] = [];
    for (let x = -40; x <= 1640; x += 40) {
      const y = base + amp * Math.sin((x + phase) * freq) + amp * 0.45 * Math.sin((x - phase * 0.6) * freq * 2.3 + 1.7);
      points.push(`${x},${y.toFixed(1)}`);
    }
    return `M${points.join('L')}L1640,1000L-40,1000Z`;
  };
  const sunY = 600 - t * 4;
  return (
    <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="cadence-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(0.82)} />
          <stop offset="0.62" stopColor={mixColor(tint, '#ffffff', 0.35)} />
          <stop offset="1" stopColor={mixColor(tint, '#ffffff', 0.55)} />
        </linearGradient>
        <radialGradient id="cadence-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.85} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect width={1600} height={1000} fill="url(#cadence-sky)" />
      <circle cx={800} cy={sunY} r={260} fill="url(#cadence-sun)" />
      <circle cx={800} cy={sunY} r={62} fill="#ffffff" />
      <path d={ridge(640, 26, 0.004, 120 + drift)} fill={shade(0.25)} />
      <path d={ridge(700, 34, 0.0032, 520 - drift * 1.4)} fill={shade(0.42)} />
      <path d={ridge(785, 42, 0.0026, 900 + drift * 1.8)} fill={shade(0.6)} />
      <path d={ridge(890, 48, 0.0022, 1300 - drift * 2.4)} fill={shade(0.78)} />
    </svg>
  );
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
