import type { ReactNode } from 'react';
import {
  DrawPath,
  ease,
  Fill,
  measureText,
  mixColor,
  progress,
  spring,
  springs,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Feature list: a headline, then three feature cards land one per beat (icon drawn with a pen stroke, title, body);
// columns in landscape, a stacked list in tall formats. Everything leaves on the last beat.
// First and last frame: the plain background.

/**
 * On-screen copy. `features` null = the brand's first three features (brand.copy.features). `{name}` in the
 * headline is replaced by the brand name.
 */
const COPY = {
  fr: { headline: 'Pourquoi {name} ?', features: null as { title: string; body: string }[] | null },
  en: { headline: 'Why {name}?', features: null as { title: string; body: string }[] | null },
};

/** One icon per card (see ICONS): bolt, layers, shield, chart, clock, sparkle, globe, users, code, heart. */
const CARD_ICONS: IconName[] = ['bolt', 'layers', 'shield'];

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  headline: [0, 1.2], // the headline rises
  cards: 1, // first card lands on this beat, one card per beat after it
  exit: [0.9, 0], // everything leaves
};

/** Per format: headline (top, size), cards laid out in `columns` or rows, card size and inner sizes. */
const LAYOUT = {
  landscape: {
    head: { top: 150, size: 96 },
    columns: true,
    card: { w: 520, h: 430, gap: 36, top: 370 },
    title: 38,
    body: 24,
    icon: 84,
  },
  portrait: {
    head: { top: 290, size: 88 },
    columns: false,
    card: { w: 960, h: 300, gap: 24, top: 500 },
    title: 40,
    body: 28,
    icon: 96,
  },
  square: {
    head: { top: 80, size: 64 },
    columns: false,
    card: { w: 940, h: 250, gap: 20, top: 210 },
    title: 32,
    body: 23,
    icon: 80,
  },
  '4:5': {
    head: { top: 100, size: 72 },
    columns: false,
    card: { w: 940, h: 290, gap: 24, top: 260 },
    title: 34,
    body: 25,
    icon: 88,
  },
};

export default function FeatureList({ t, duration, width, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const { ui, colors, fonts } = brand;
  const copy = COPY[brand.language] ?? COPY.fr;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;
  const features = (copy.features ?? brand.copy.features).slice(0, 3);

  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const head = ease.outExpo(progress(t, b(TIMING.headline[0]), b(TIMING.headline[1])));
  const title = copy.headline.replace('{name}', brand.name).replace(/ ([?!:;])/g, '\u00a0$1');
  const headType = { fontFamily: fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.03em' };
  const headSize = Math.floor(
    Math.min(L.head.size, (L.head.size * (width - 240)) / measureText(title, { ...headType, fontSize: L.head.size }).width),
  );
  const n = features.length;
  const total = L.columns ? n * L.card.w + (n - 1) * L.card.gap : L.card.w;
  const left = (width - total) / 2;

  return (
    <Fill>
      <Backdrop />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 1 - exit,
          transform: exit > 0 ? `translateY(${exit * 24}px)` : undefined,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: L.head.top,
            textAlign: 'center',
            overflow: 'hidden',
            paddingBottom: '0.15em',
          }}
        >
          <div
            style={{
              ...headType,
              fontSize: headSize,
              lineHeight: 1.05,
              color: colors.ink,
              transform: head < 1 ? `translateY(${(1 - head) * 110}%)` : undefined,
            }}
          >
            {title}
          </div>
        </div>
        {features.map((feature, i) => {
          const land = b(TIMING.cards + i);
          const k = settle(t < land - 0.3 ? 0 : spring(t - (land - 0.3), { from: 0, to: 1, ...springs.snappy }));
          if (k <= 0) return null;
          const x = L.columns ? left + i * (L.card.w + L.card.gap) : left;
          const y = L.columns ? L.card.top : L.card.top + i * (L.card.h + L.card.gap);
          const draw = progress(t, land - 0.1, land + 0.5, ease.inOutCubic);
          return (
            <ui.Card
              key={i}
              variant="default"
              padding={L.columns ? 40 : 36}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: L.card.w,
                height: L.card.h,
                display: 'flex',
                flexDirection: L.columns ? 'column' : 'row',
                alignItems: 'flex-start',
                gap: L.columns ? 32 : 36,
                opacity: Math.min(1, k * 1.5),
                transform: k !== 1 ? `translateY(${(1 - k) * 60}px)` : undefined,
              }}
            >
              <IconTile name={CARD_ICONS[i % CARD_ICONS.length]} draw={draw} size={L.icon} />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: fonts.display,
                    fontSize: L.title,
                    fontWeight: displayWeight(brand),
                    letterSpacing: '-0.02em',
                    lineHeight: 1.2,
                    color: colors.ink,
                  }}
                >
                  {feature.title}
                </div>
                <div style={{ marginTop: 12, fontFamily: fonts.body, fontSize: L.body, lineHeight: 1.45, color: colors.muted }}>
                  {feature.body}
                </div>
              </div>
            </ui.Card>
          );
        })}
      </div>
    </Fill>
  );
}

/** A spring this close to its target counts as landed (whole-pixel rest, crisp text). */
function settle(v: number): number {
  return Math.abs(1 - v) < 0.002 ? 1 : v;
}

type IconName = keyof typeof ICONS;

/** 24 × 24 line icons (stroke paths), drawn like a pen. */
const ICONS = {
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7l1-8Z'],
  layers: ['M12 3 2 8l10 5 10-5-10-5Z', 'M2 13l10 5 10-5', 'M2 17.5l10 5 10-5'],
  shield: ['M12 2.5 4 6v6c0 5 3.4 8.6 8 9.5 4.6-.9 8-4.5 8-9.5V6l-8-3.5Z', 'm8.5 12 2.5 2.5 4.5-5'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3.5 2'],
  sparkle: ['M12 3c.8 4.6 3.4 7.2 8 8-4.6.8-7.2 3.4-8 8-.8-4.6-3.4-7.2-8-8 4.6-.8 7.2-3.4 8-8Z'],
  globe: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M3 12h18',
    'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z',
  ],
  users: [
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7',
    'M16 3.5a4 4 0 0 1 0 7.5',
    'M18.5 14.3A7 7 0 0 1 22 21',
  ],
  code: ['m8 7-5 5 5 5', 'm16 7 5 5-5 5', 'm14 4-4 16'],
  heart: ['M12 20.5S3 15 3 8.8A4.8 4.8 0 0 1 12 6.5a4.8 4.8 0 0 1 9 2.3c0 6.2-9 11.7-9 11.7Z'],
};

/** Rounded tile in a tint of the primary color, with the icon drawn by `draw` (0 to 1). */
function IconTile({ name, draw, size }: { name: IconName; draw: number; size: number }): ReactNode {
  const { colors, radius } = useBrand();
  const icon = size * 0.5;
  return (
    <div
      style={{
        flex: 'none',
        width: size,
        height: size,
        borderRadius: Math.min(radius.lg, size / 3),
        background: withAlpha(colors.primary, 0.1),
        boxShadow: `inset 0 0 0 1px ${withAlpha(colors.primary, 0.14)}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width={icon} height={icon} viewBox="0 0 24 24" style={{ overflow: 'visible' }}>
        {ICONS[name].map((d, i) => (
          <DrawPath
            key={i}
            d={d}
            progress={progress(draw, i * 0.15, 0.7 + i * 0.15)}
            color={mixColor(colors.primary, colors.ink, 0.1)}
            width={1.9}
          />
        ))}
      </svg>
    </div>
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
