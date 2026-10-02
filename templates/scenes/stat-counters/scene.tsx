import {
  Counter,
  ease,
  Fill,
  measureText,
  progress,
  spring,
  springs,
  useBrand,
  useFormat,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Stat counters: a headline, three stat cards (the kit's Stat) whose numbers count up together and land on the next
// downbeat, where each card gives a small kick and shows its trend. Everything leaves on the last beat.
// First and last frame: the plain background.

/** On-screen copy, per brand language. `{name}` = the brand name. Values: target, decimals, suffix, trend. */
const COPY = {
  fr: {
    headline: '{name} en chiffres',
    stats: [
      { label: 'Utilisateurs actifs', to: 12400, decimals: 0, suffix: '', delta: '+18 %' },
      { label: 'Heures gagnées par mois', to: 320, decimals: 0, suffix: '\u202fh', delta: '+42 %' },
      { label: 'Clients satisfaits', to: 98.6, decimals: 1, suffix: '\u202f%', delta: '+1,2 pt' },
    ],
  },
  en: {
    headline: '{name} by the numbers',
    stats: [
      { label: 'Active users', to: 12400, decimals: 0, suffix: '', delta: '+18%' },
      { label: 'Hours saved each month', to: 320, decimals: 0, suffix: ' h', delta: '+42%' },
      { label: 'Happy customers', to: 98.6, decimals: 1, suffix: '%', delta: '+1.2 pt' },
    ],
  },
};

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  headline: [0, 1.2], // the headline rises
  cards: 0.5, // first card rises, then one every `stagger` s
  stagger: 0.09,
  count: 1, // the numbers start counting...
  land: 4, // ...and land together on this beat (a downbeat)
  exit: [0.9, 0], // everything leaves
};

/** Per format: headline (top, size), cards in columns or rows (size, gap, top), scale of the kit's Stat inside. */
const LAYOUT = {
  landscape: { head: { top: 190, size: 92 }, columns: true, card: { w: 520, h: 270, gap: 36, top: 420 }, scale: 1.5 },
  portrait: { head: { top: 300, size: 84 }, columns: false, card: { w: 960, h: 300, gap: 30, top: 520 }, scale: 1.75 },
  square: { head: { top: 100, size: 64 }, columns: false, card: { w: 920, h: 250, gap: 24, top: 230 }, scale: 1.45 },
  '4:5': { head: { top: 120, size: 72 }, columns: false, card: { w: 920, h: 290, gap: 28, top: 280 }, scale: 1.6 },
};

export default function StatCounters({ t, duration, width, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const { ui, colors, fonts } = brand;
  const copy = COPY[brand.language] ?? COPY.fr;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;
  const locale = brand.language === 'en' ? 'en-US' : 'fr-FR';

  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const head = ease.outExpo(progress(t, b(TIMING.headline[0]), b(TIMING.headline[1])));
  const title = copy.headline.replace('{name}', brand.name);
  const headType = { fontFamily: fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.03em' };
  const headSize = Math.floor(
    Math.min(L.head.size, (L.head.size * (width - 240)) / measureText(title, { ...headType, fontSize: L.head.size }).width),
  );
  const count = progress(t, b(TIMING.count), b(TIMING.land), ease.outExpo);
  const landed = t >= b(TIMING.land);
  const kick = landed ? spring(t - b(TIMING.land), { from: 1.05, to: 1, ...springs.snappy }) : 1;
  const n = copy.stats.length;
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
        {copy.stats.map((stat, i) => {
          const rise = ease.outExpo(
            progress(t, b(TIMING.cards) + i * TIMING.stagger, b(TIMING.cards) + i * TIMING.stagger + 0.8),
          );
          if (rise <= 0) return null;
          const x = L.columns ? left + i * (L.card.w + L.card.gap) : left;
          const y = L.columns ? L.card.top : L.card.top + i * (L.card.h + L.card.gap);
          const k = Math.abs(kick - 1) < 0.001 ? 1 : kick;
          return (
            <ui.Card
              key={i}
              variant="default"
              padding={0}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: L.card.w,
                height: L.card.h,
                opacity: Math.min(1, rise * 1.4),
                transform: rise < 1 || k !== 1 ? `translateY(${(1 - rise) * 50}px) scale(${k})` : undefined,
              }}
            >
              <div style={{ position: 'absolute', left: 44, top: 40, transformOrigin: '0 0', transform: `scale(${L.scale})` }}>
                <ui.Stat
                  label={stat.label}
                  value={
                    <Counter
                      to={stat.to}
                      progress={count}
                      locale={locale}
                      format={{ minimumFractionDigits: stat.decimals, maximumFractionDigits: stat.decimals }}
                      suffix={stat.suffix}
                    />
                  }
                  delta={landed ? stat.delta : undefined}
                />
              </div>
            </ui.Card>
          );
        })}
      </div>
    </Fill>
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
