import type { CSSProperties, ReactNode } from 'react';
import {
  BrowserFrame,
  Camera,
  Counter,
  ease,
  Fill,
  Highlight,
  mix,
  mixColor,
  progress,
  Stage3D,
  Tag,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Browser showcase: a browser window swings up flat; the dashboard inside (built from the brand kit) cascades in,
// bars grow, then the camera pushes into the chart, marks the best month and pulls back. Everything leaves on the
// last beat. First and last frame: the plain background.

/** On-screen copy, per brand language. */
const COPY = {
  fr: {
    url: 'app.exemple.fr/tableau-de-bord',
    nav: ['Tableau de bord', 'Clients', 'Commandes', 'Rapports', 'Réglages'],
    title: 'Tableau de bord',
    subtitle: 'Semaine du 22 septembre',
    tabs: ['Jour', 'Semaine', 'Mois'],
    stats: [
      { label: 'Revenus', to: 48290, suffix: '\u202f€', delta: '+12,4 %' },
      { label: 'Commandes', to: 1284, suffix: '', delta: '+8,1 %' },
      { label: 'Nouveaux clients', to: 312, suffix: '', delta: '+21 %' },
    ],
    chart: 'Revenus par mois',
    months: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    bars: [42, 55, 48, 61, 66, 58, 72, 69, 94, 80, 84, 90],
    best: 8,
    note: '+32 % en septembre',
    list: 'Dernières commandes',
    rows: [
      { name: 'Camille Durand', detail: 'n° 2031', amount: '240 €', status: 'Payée' },
      { name: 'Studio Nord', detail: 'n° 2030', amount: '1 180 €', status: 'Payée' },
      { name: 'Hugo Martin', detail: 'n° 2029', amount: '86 €', status: 'En cours' },
      { name: 'Léa Bernard', detail: 'n° 2028', amount: '412 €', status: 'Payée' },
    ],
  },
  en: {
    url: 'app.example.com/dashboard',
    nav: ['Dashboard', 'Customers', 'Orders', 'Reports', 'Settings'],
    title: 'Dashboard',
    subtitle: 'Week of September 22',
    tabs: ['Day', 'Week', 'Month'],
    stats: [
      { label: 'Revenue', to: 48290, suffix: '', delta: '+12.4%' },
      { label: 'Orders', to: 1284, suffix: '', delta: '+8.1%' },
      { label: 'New customers', to: 312, suffix: '', delta: '+21%' },
    ],
    chart: 'Revenue by month',
    months: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    bars: [42, 55, 48, 61, 66, 58, 72, 69, 94, 80, 84, 90],
    best: 8,
    note: '+32% in September',
    list: 'Latest orders',
    rows: [
      { name: 'Camille Durand', detail: '#2031', amount: '$240', status: 'Paid' },
      { name: 'Studio Nord', detail: '#2030', amount: '$1,180', status: 'Paid' },
      { name: 'Hugo Martin', detail: '#2029', amount: '$86', status: 'Pending' },
      { name: 'Léa Bernard', detail: '#2028', amount: '$412', status: 'Paid' },
    ],
  },
};

/** Optional brand showcase component for the right panel instead of the orders list, e.g. 'OrderCard' (see the brand notes). */
const EXTRA: string | null = null;

/** Beats from the scene start, except `back` and `exit`: beats before the end. */
const TIMING = {
  enter: [0, 2], // the browser swings up flat
  content: 1.2, // the dashboard cascades in
  bars: [2, 4], // bars grow
  push: [5, 6.6], // the camera pushes into the chart
  note: [6.6, 7.4], // the best month is marked
  back: [2.6, 1], // the camera pulls back
  exit: [0.9, 0], // everything leaves
};

type Box = { x: number; y: number; w: number; h: number };

/**
 * Per format: browser box (canvas px), sidebar width (0 = none), then page boxes (px inside the page, under the address
 * bar) for the title, stats row, chart and list (list null = hidden), and the camera zoom of the push-in.
 */
const LAYOUT: Record<
  'landscape' | 'portrait' | 'square' | '4:5',
  { browser: Box; sidebar: number; head: Box; stats: Box; chart: Box; list: Box | null; zoom: number }
> = {
  landscape: {
    browser: { x: 160, y: 96, w: 1600, h: 900 },
    sidebar: 260,
    head: { x: 300, y: 34, w: 1260, h: 90 },
    stats: { x: 300, y: 146, w: 1260, h: 168 },
    chart: { x: 300, y: 338, w: 780, h: 480 },
    list: { x: 1104, y: 338, w: 456, h: 480 },
    zoom: 1.55,
  },
  portrait: {
    browser: { x: 60, y: 300, w: 960, h: 1240 },
    sidebar: 0,
    head: { x: 36, y: 30, w: 888, h: 150 },
    stats: { x: 36, y: 196, w: 888, h: 168 },
    chart: { x: 36, y: 388, w: 888, h: 420 },
    list: { x: 36, y: 832, w: 888, h: 344 },
    zoom: 1.15,
  },
  square: {
    browser: { x: 60, y: 80, w: 960, h: 920 },
    sidebar: 0,
    head: { x: 36, y: 30, w: 888, h: 150 },
    stats: { x: 36, y: 196, w: 888, h: 168 },
    chart: { x: 36, y: 388, w: 888, h: 440 },
    list: null,
    zoom: 1.15,
  },
  '4:5': {
    browser: { x: 60, y: 90, w: 960, h: 1170 },
    sidebar: 0,
    head: { x: 36, y: 30, w: 888, h: 150 },
    stats: { x: 36, y: 196, w: 888, h: 168 },
    chart: { x: 36, y: 388, w: 888, h: 420 },
    list: { x: 36, y: 832, w: 888, h: 250 },
    zoom: 1.15,
  },
};

const BAR = 52;

export default function BrowserShowcase({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const copy = COPY[brand.language] ?? COPY.fr;
  const { ui, colors, fonts, Logo } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;
  const Extra = EXTRA ? brand.extras[EXTRA]?.component : undefined;

  const enter = progress(t, b(TIMING.enter[0]), b(TIMING.enter[1]), ease.smooth);
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const item = (i: number) => ease.outCubic(progress(t, b(TIMING.content) + i * 0.07, b(TIMING.content) + i * 0.07 + 0.55));
  const appear = (i: number, style?: CSSProperties): CSSProperties => {
    const k = item(i);
    return { ...style, opacity: k, transform: k < 1 ? `translateY(${(1 - k) * 18}px)` : undefined };
  };
  const push =
    progress(t, b(TIMING.push[0]), b(TIMING.push[1]), ease.inOutCubic) *
    (1 - progress(t, end(TIMING.back[0]), end(TIMING.back[1]), ease.inOutCubic));
  const note =
    progress(t, b(TIMING.note[0]), b(TIMING.note[1]), ease.outCubic) *
    (1 - progress(t, end(TIMING.back[0]) - 0.3, end(TIMING.back[0]), ease.inCubic));
  const count = progress(t, b(TIMING.content), b(TIMING.content + 3), ease.outExpo);

  // Page px to canvas px, and the camera's target: the chart card's center.
  const px = (x: number) => L.browser.x + x;
  const py = (y: number) => L.browser.y + BAR + y;
  const target = { x: px(L.chart.x + L.chart.w / 2), y: py(L.chart.y + L.chart.h / 2) };
  const zoom = Math.pow(L.zoom, push);
  const kx = push === 0 ? 0 : (1 - 1 / zoom) / (1 - 1 / L.zoom);

  // Bars of the chart, in page px.
  const plot = { x: L.chart.x + 36, y: L.chart.y + 110, w: L.chart.w - 72, h: L.chart.h - 170 };
  const n = copy.bars.length;
  const slot = plot.w / n;
  const bw = Math.min(40, slot * 0.56);
  const maxBar = Math.max(...copy.bars);
  const barBox = (i: number) => {
    const h = (copy.bars[i] / maxBar) * plot.h;
    return { x: plot.x + i * slot + (slot - bw) / 2, y: plot.y + plot.h - h, w: bw, h };
  };
  const best = barBox(copy.best);
  const locale = brand.language === 'en' ? 'en-US' : 'fr-FR';
  const k = 1 - enter;

  return (
    <Fill>
      <Backdrop />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 1 - exit,
          transform: exit > 0 ? `translateY(${exit * 30}px)` : undefined,
        }}
      >
        <Camera x={mix(width / 2, target.x, kx)} y={mix(height / 2, target.y, kx)} zoom={zoom}>
          <Stage3D perspective={2600} focus={{ x: width / 2, y: L.browser.y + L.browser.h }} rotateX={18 * k} y={160 * k}>
            <BrowserFrame
              width={L.browser.w}
              height={L.browser.h}
              url={copy.url}
              style={{
                position: 'absolute',
                left: L.browser.x,
                top: L.browser.y,
                opacity: Math.min(1, enter * 2),
                background: colors.background,
              }}
            >
              {L.sidebar ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: L.sidebar,
                    background: mixColor(colors.background, colors.surface, 0.5),
                    borderRight: `1px solid ${colors.line}`,
                    padding: '28px 16px',
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={appear(0, { padding: '0 10px 26px' })}>
                    <Logo variant="full" height={30} />
                  </div>
                  {copy.nav.map((label, i) => (
                    <div key={label} style={appear(1 + i * 0.5)}>
                      <ui.ListItem
                        title={label}
                        selected={i === 0}
                        style={{ padding: '11px 14px' }}
                        leading={<NavIcon i={i} />}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={appear(1, { position: 'absolute', left: L.head.x, top: L.head.y, width: L.head.w })}>
                <div
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 34,
                    fontWeight: displayWeight(brand),
                    letterSpacing: '-0.025em',
                    color: colors.ink,
                  }}
                >
                  {copy.title}
                </div>
                <div style={{ marginTop: 4, fontFamily: fonts.body, fontSize: 18, color: colors.muted }}>{copy.subtitle}</div>
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: L.head.h > 120 ? 84 : 0,
                    left: L.head.h > 120 ? 0 : undefined,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: L.head.h > 120 ? 'space-between' : 'flex-end',
                    gap: 18,
                  }}
                >
                  <ui.Tabs items={copy.tabs} active={1} />
                  <ui.Avatar name="Olivia Martin" size={44} />
                </div>
              </div>
              {copy.stats.map((stat, i) => {
                const gap = 20;
                const w = (L.stats.w - 2 * gap) / 3;
                return (
                  <div
                    key={stat.label}
                    style={appear(2 + i, {
                      position: 'absolute',
                      left: L.stats.x + i * (w + gap),
                      top: L.stats.y,
                      width: w,
                      height: L.stats.h,
                    })}
                  >
                    <ui.Card variant="default" padding={24} style={{ height: '100%', boxSizing: 'border-box' }}>
                      <div style={{ transformOrigin: '0 0', transform: `scale(${w < 320 ? 0.72 : 0.9})` }}>
                        <ui.Stat
                          label={stat.label}
                          value={<Counter to={stat.to} progress={count} locale={locale} suffix={stat.suffix} />}
                          delta={stat.delta}
                        />
                      </div>
                    </ui.Card>
                  </div>
                );
              })}
              <div
                style={appear(5, { position: 'absolute', left: L.chart.x, top: L.chart.y, width: L.chart.w, height: L.chart.h })}
              >
                <ui.Card variant="default" padding={0} style={{ height: '100%' }} />
              </div>
              <div
                style={appear(5.5, {
                  position: 'absolute',
                  left: L.chart.x + 36,
                  top: L.chart.y + 32,
                  fontFamily: fonts.body,
                  fontSize: 21,
                  fontWeight: 600,
                  color: colors.ink,
                })}
              >
                {copy.chart}
              </div>
              {copy.bars.map((_, i) => {
                const box = barBox(i);
                const grow = ease.outCubic(progress(t, b(TIMING.bars[0]) + i * 0.05, b(TIMING.bars[0]) + i * 0.05 + 0.6));
                const isBest = i === copy.best;
                return (
                  <div key={i}>
                    <div
                      style={{
                        position: 'absolute',
                        left: box.x,
                        top: box.y + box.h * (1 - grow),
                        width: box.w,
                        height: box.h * grow,
                        borderRadius: `${Math.min(8, bw / 3)}px ${Math.min(8, bw / 3)}px 2px 2px`,
                        background: isBest
                          ? mixColor(withAlpha(colors.primary, 0.35), colors.primary, note)
                          : withAlpha(colors.primary, 0.35),
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        left: plot.x + i * slot,
                        top: plot.y + plot.h + 14,
                        width: slot,
                        textAlign: 'center',
                        fontFamily: fonts.mono,
                        fontSize: 15,
                        color: colors.muted,
                        opacity: item(6),
                      }}
                    >
                      {copy.months[i]}
                    </div>
                  </div>
                );
              })}
              {L.list ? (
                <div
                  style={appear(6, { position: 'absolute', left: L.list.x, top: L.list.y, width: L.list.w, height: L.list.h })}
                >
                  {Extra ? (
                    <Extra width={L.list.w} />
                  ) : (
                    <ui.Card
                      variant="default"
                      padding={24}
                      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}
                    >
                      <div style={{ fontFamily: fonts.body, fontSize: 21, fontWeight: 600, color: colors.ink, marginBottom: 10 }}>
                        {copy.list}
                      </div>
                      {copy.rows.map((row, i) => (
                        <div key={row.name} style={appear(6.5 + i * 0.6)}>
                          <ui.ListItem
                            title={row.name}
                            subtitle={row.detail}
                            leading={<ui.Avatar name={row.name} size={42} />}
                            trailing={<ui.Badge tone={i === 2 ? 'warning' : 'success'}>{row.status}</ui.Badge>}
                            style={{ padding: '8px 4px' }}
                          />
                        </div>
                      ))}
                    </ui.Card>
                  )}
                </div>
              ) : null}
            </BrowserFrame>
          </Stage3D>
          <Highlight x={px(best.x)} y={py(best.y)} width={best.w} height={best.h} radius={8} pad={6} progress={note} />
          <Tag x={px(best.x + best.w / 2)} y={py(best.y) - 22} anchor="bottom" progress={note}>
            {copy.note}
          </Tag>
        </Camera>
      </div>
    </Fill>
  );
}

/** Small line icons for the sidebar items. */
function NavIcon({ i }: { i: number }): ReactNode {
  const { colors } = useBrand();
  const paths = [
    'M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-3H4z',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M17 4a4 4 0 0 1 0 7M22 21a6 6 0 0 0-3.5-5.5',
    'M4 7h16l-1.5 12h-13zM9 7V5a3 3 0 0 1 6 0v2',
    'M5 20V10M12 20V4M19 20v-7',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
  ];
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={i === 0 ? colors.ink : colors.muted}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[i % paths.length]} />
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
