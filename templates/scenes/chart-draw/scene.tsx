import {
  Counter,
  DrawPath,
  ease,
  Fill,
  mix,
  mixColor,
  progress,
  spring,
  springs,
  Tag,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Chart draw: a dashboard card; the period tab slides, then the line chart draws itself with a dot riding its tip,
// the area fills behind it and the headline value counts up in sync, landing on a downbeat with its trend badge.
// Everything leaves on the last beat. First and last frame: the plain background.

/** On-screen copy and data, per brand language. `points` are the values plotted (same unit as `value`). */
const COPY = {
  fr: {
    title: 'Revenus mensuels',
    tabs: ['7 jours', '30 jours', '12 mois'],
    badge: '+24,8 %',
    locale: 'fr-FR',
    currency: 'EUR',
    labels: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    points: [18200, 21900, 20800, 26400, 29800, 27900, 33600, 38900, 36700, 42800, 47100, 52300],
  },
  en: {
    title: 'Monthly revenue',
    tabs: ['7 days', '30 days', '12 months'],
    badge: '+24.8%',
    locale: 'en-US',
    currency: 'USD',
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    points: [18200, 21900, 20800, 26400, 29800, 27900, 33600, 38900, 36700, 42800, 47100, 52300],
  },
};

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  card: [0, 1.4], // the card rises
  tab: [1, 1.8], // the period tab slides to the last one
  draw: [2, 8], // the line draws (lands on beat 8, a downbeat)
  exit: [0.9, 0], // everything leaves
};

/** Card box and chart area inside it (card px), per format. */
const LAYOUT = {
  landscape: { card: { x: 250, y: 140, w: 1420, h: 800 }, chart: { x: 110, y: 270, w: 1250, h: 420 }, value: 76 },
  portrait: { card: { x: 60, y: 380, w: 960, h: 1080 }, chart: { x: 100, y: 400, w: 820, h: 540 }, value: 84 },
  square: { card: { x: 70, y: 90, w: 940, h: 900 }, chart: { x: 96, y: 330, w: 800, h: 460 }, value: 68 },
  '4:5': { card: { x: 70, y: 130, w: 940, h: 1090 }, chart: { x: 96, y: 380, w: 800, h: 580 }, value: 72 },
};

export default function ChartDraw({ t, duration, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const { ui, colors, fonts } = brand;
  const copy = COPY[brand.language] ?? COPY.fr;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const enter = ease.outExpo(progress(t, b(TIMING.card[0]), b(TIMING.card[1])));
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const tab = mix(copy.tabs.length - 2, copy.tabs.length - 1, progress(t, b(TIMING.tab[0]), b(TIMING.tab[1]), ease.inOutCubic));
  const draw = progress(t, b(TIMING.draw[0]), b(TIMING.draw[1]), ease.inOutSine);
  const landed = t >= b(TIMING.draw[1]);
  const pop = landed ? spring(t - b(TIMING.draw[1]), { from: 0, to: 1, ...springs.bouncy }) : 0;

  // Chart geometry: y axis from 0 to a round maximum, the smooth line sampled densely (so the tip is exact).
  const { x: cx, y: cy, w: cw, h: ch } = L.chart;
  const max = niceMax(Math.max(...copy.points));
  const pts = copy.points.map((v, i) => ({ x: cx + (i / (copy.points.length - 1)) * cw, y: cy + ch - (v / max) * ch }));
  const line = sample(pts);
  const tip = pointAt(line, draw);
  const value = interpolatePoints(copy.points, tip.u);
  const money = (v: number) =>
    new Intl.NumberFormat(copy.locale, { style: 'currency', currency: copy.currency, maximumFractionDigits: 0 }).format(v);
  const d = `M${line.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`;
  const area = `${d}L${cx + cw},${cy + ch}L${cx},${cy + ch}Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <Fill>
      <Backdrop />
      <ui.Card
        variant="default"
        padding={0}
        style={{
          position: 'absolute',
          left: L.card.x,
          top: L.card.y,
          width: L.card.w,
          height: L.card.h,
          opacity: Math.min(1, enter * 1.5) * (1 - exit),
          transform: enter < 1 || exit > 0 ? `translateY(${(1 - enter) * 60 + exit * 24}px)` : undefined,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: cx,
            top: 56,
            fontFamily: fonts.body,
            fontSize: 24,
            fontWeight: 500,
            color: colors.muted,
          }}
        >
          {copy.title}
        </div>
        <div style={{ position: 'absolute', left: cx, top: 96, display: 'flex', alignItems: 'center', gap: 20 }}>
          <div
            style={{
              fontFamily: fonts.display,
              fontSize: L.value,
              fontWeight: displayWeight(brand),
              letterSpacing: '-0.035em',
              lineHeight: 1,
              color: colors.ink,
            }}
          >
            <Counter
              to={value}
              progress={1}
              locale={copy.locale}
              format={{ style: 'currency', currency: copy.currency, maximumFractionDigits: 0 }}
            />
          </div>
          {pop > 0 ? (
            <ui.Badge tone="success" style={{ transform: `scale(${pop})`, transformOrigin: '0 50%' }}>
              {copy.badge}
            </ui.Badge>
          ) : null}
        </div>
        <ui.Tabs
          items={copy.tabs}
          active={tab}
          style={{ position: 'absolute', right: L.card.w - cx - cw, top: f.isLandscape ? 60 : 250 }}
        />
        <svg width={L.card.w} height={L.card.h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <defs>
            <linearGradient id="cadence-chart-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={colors.primary} stopOpacity={0.22} />
              <stop offset="1" stopColor={colors.primary} stopOpacity={0} />
            </linearGradient>
            <clipPath id="cadence-chart-reveal">
              <rect x={cx - 4} y={cy - 40} width={Math.max(0, tip.x - cx + 4)} height={ch + 44} />
            </clipPath>
          </defs>
          {ticks.map((k) => (
            <g key={k}>
              <line
                x1={cx}
                x2={cx + cw}
                y1={cy + ch - k * ch}
                y2={cy + ch - k * ch}
                stroke={colors.line}
                strokeWidth={1}
                strokeDasharray={k === 0 ? undefined : '4 6'}
              />
              <text
                x={cx - 18}
                y={cy + ch - k * ch + 6}
                textAnchor="end"
                fill={colors.muted}
                style={{ fontFamily: fonts.mono, fontSize: 16 }}
              >
                {compact(k * max, copy.locale)}
              </text>
            </g>
          ))}
          {copy.labels.map((label, i) => (
            <text
              key={label}
              x={pts[i].x}
              y={cy + ch + 40}
              textAnchor="middle"
              fill={i / (copy.labels.length - 1) <= tip.u + 1e-6 ? colors.ink : colors.muted}
              style={{ fontFamily: fonts.mono, fontSize: 16 }}
            >
              {label}
            </text>
          ))}
          {draw > 0 ? <path d={area} fill="url(#cadence-chart-area)" clipPath="url(#cadence-chart-reveal)" /> : null}
          <DrawPath d={d} progress={draw} color={colors.primary} width={4} />
          {draw > 0 ? (
            <g>
              <circle cx={tip.x} cy={tip.y} r={18 + 10 * pop} fill={withAlpha(colors.primary, 0.14 * (1 - pop * 0.5))} />
              <circle cx={tip.x} cy={tip.y} r={8} fill={colors.surface} stroke={colors.primary} strokeWidth={4} />
            </g>
          ) : null}
        </svg>
        {draw > 0 ? (
          <Tag
            x={tip.x}
            y={tip.y - 34}
            anchor="bottom"
            color={mixColor(colors.ink, colors.primary, 0.15)}
            size={20}
            progress={progress(draw, 0, 0.08)}
          >
            {money(value)}
          </Tag>
        ) : null}
      </ui.Card>
    </Fill>
  );
}

/** A round axis maximum just above `v` (with some headroom), so the curve uses most of the height. */
function niceMax(v: number): number {
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].map((m) => m * step).find((m) => m >= v * 1.08) ?? v * 1.2;
}

/** "12 k", "1,2 M" (compact axis labels). */
function compact(v: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

/** Smooth curve through the points (Catmull-Rom), sampled into a dense polyline with cumulative lengths. */
function sample(points: { x: number; y: number }[], steps = 24) {
  const out: { x: number; y: number; u: number }[] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const k = s / steps;
      const k2 = k * k;
      const k3 = k2 * k;
      const c = (a: number, b: number, c2: number, d: number) =>
        0.5 * (2 * b + (-a + c2) * k + (2 * a - 5 * b + 4 * c2 - d) * k2 + (-a + 3 * b - 3 * c2 + d) * k3);
      out.push({ x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y), u: (i + k) / (n - 1) });
    }
  }
  out.push({ ...points[n - 1], u: 1 });
  const lengths = [0];
  for (let i = 1; i < out.length; i++)
    lengths.push(lengths[i - 1] + Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
  return { points: out, lengths, total: lengths[lengths.length - 1] };
}

/** The point at share `p` of the polyline's length (where DrawPath's tip is), with its position `u` along the data. */
function pointAt(line: ReturnType<typeof sample>, p: number) {
  const target = p * line.total;
  let i = 1;
  while (i < line.lengths.length - 1 && line.lengths[i] < target) i++;
  const a = line.points[i - 1];
  const z = line.points[i];
  const span = line.lengths[i] - line.lengths[i - 1] || 1;
  const k = Math.min(1, Math.max(0, (target - line.lengths[i - 1]) / span));
  return { x: mix(a.x, z.x, k), y: mix(a.y, z.y, k), u: mix(a.u, z.u, k) };
}

/** Data value at position `u` (0 to 1) along the series. */
function interpolatePoints(values: number[], u: number): number {
  const x = u * (values.length - 1);
  const i = Math.min(values.length - 2, Math.floor(x));
  return mix(values[i], values[i + 1], x - i);
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
