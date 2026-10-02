import type { ReactNode } from 'react';
import {
  ClickRipple,
  Counter,
  DrawPath,
  ease,
  Fill,
  measureText,
  mixColor,
  PhoneFrame,
  progress,
  Stage3D,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Phone showcase: next to a two-line headline, a phone swings in; its screen (built from the brand kit) cascades in,
// scrolls, a row is tapped and the screen slides to its detail, where a check draws itself. Everything leaves on
// the last beat. First and last frame: the plain background.

/** On-screen copy, per brand language. */
const COPY = {
  fr: {
    lines: ['Tout sous la main.', 'Où que vous soyez.'],
    hello: 'Bonjour Olivia',
    sub: 'Voici votre semaine',
    stat: { label: 'Commandes cette semaine', value: 1284, delta: '+12 %' },
    section: 'Activité récente',
    rows: [
      { title: 'Camille Durand', subtitle: 'A commenté votre projet', trailing: '2 min' },
      { title: 'Studio Nord', subtitle: 'Nouvelle commande', trailing: '240 €' },
      { title: 'Hugo Martin', subtitle: 'A rejoint l’équipe', trailing: '1 h' },
      { title: 'Léa Bernard', subtitle: 'Rapport partagé', trailing: '3 h' },
      { title: 'Nina Robert', subtitle: 'Paiement reçu', trailing: 'hier' },
    ],
    button: 'Nouvelle commande',
    detail: {
      back: 'Activité',
      title: 'Commande confirmée',
      amount: '240,00 €',
      rows: [
        ['Client', 'Studio Nord'],
        ['Référence', 'n° 2031'],
        ['Livraison', 'Demain, 10 h'],
      ],
    },
  },
  en: {
    lines: ['Everything at hand.', 'Wherever you are.'],
    hello: 'Hello Olivia',
    sub: 'Here is your week',
    stat: { label: 'Orders this week', value: 1284, delta: '+12%' },
    section: 'Recent activity',
    rows: [
      { title: 'Camille Durand', subtitle: 'Commented on your project', trailing: '2 min' },
      { title: 'Studio Nord', subtitle: 'New order', trailing: '$240' },
      { title: 'Hugo Martin', subtitle: 'Joined the team', trailing: '1 h' },
      { title: 'Léa Bernard', subtitle: 'Shared a report', trailing: '3 h' },
      { title: 'Nina Robert', subtitle: 'Payment received', trailing: 'Yesterday' },
    ],
    button: 'New order',
    detail: {
      back: 'Activity',
      title: 'Order confirmed',
      amount: '$240.00',
      rows: [
        ['Customer', 'Studio Nord'],
        ['Reference', '#2031'],
        ['Delivery', 'Tomorrow, 10 am'],
      ],
    },
  },
};

/** Optional brand showcase component to put on the screen instead of the stat card, e.g. 'BudgetBar' (see the brand notes). */
const EXTRA: string | null = null;
/** Row the finger taps (its detail slides in). */
const TAPPED = 1;

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  enter: [0, 2], // the headline rises, the phone swings in
  screen: 1.4, // the screen content cascades in
  scroll: [4, 5], // the list scrolls up
  tap: 7, // a row is tapped...
  slide: [7.4, 8.4], // ...and its detail slides in
  check: [8.2, 9.4], // the check draws
  exit: [0.9, 0], // everything leaves
};

/** Headline box, phone (left, top, width), per format. */
const LAYOUT = {
  landscape: { head: { x: 200, y: 540, size: 88, center: true, width: 820 }, phone: { x: 1130, y: 100, w: 430 } },
  portrait: { head: { x: 60, y: 240, size: 76, center: false, width: 960 }, phone: { x: 280, y: 460, w: 520 } },
  square: { head: { x: 70, y: 380, size: 60, center: true, width: 470 }, phone: { x: 600, y: 60, w: 400 } },
  '4:5': { head: { x: 70, y: 470, size: 64, center: true, width: 470 }, phone: { x: 590, y: 90, w: 420 } },
};

/** The screen is designed at this width (px) and scaled to the phone. */
const SCREEN = 400;

export default function PhoneShowcase({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const copy = COPY[brand.language] ?? COPY.fr;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const enter = ease.outExpo(progress(t, b(TIMING.enter[0]), b(TIMING.enter[1])));
  const swing = progress(t, b(TIMING.enter[0]), b(TIMING.enter[1]) + 0.2, ease.smooth);
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const phoneH = Math.round(L.phone.w * 2.05);
  const bezel = L.phone.w * 0.035;
  const scale = (L.phone.w - 2 * bezel) / SCREEN;
  const tap = music.snap(b(TIMING.tap), 'half');
  const tapPoint = { x: 200, y: 486 + TAPPED * 76 - 150 };
  const k = 1 - swing;

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
        <Lines lines={copy.lines} p={progress(t, b(TIMING.enter[0]), b(TIMING.enter[1]))} {...L.head} />
        <Stage3D
          perspective={2000}
          focus={{ x: L.phone.x + L.phone.w / 2, y: L.phone.y + phoneH / 2 }}
          rotateY={-24 * k}
          rotateX={10 * k}
          y={140 * k}
        >
          <PhoneFrame
            width={L.phone.w}
            screen={brand.colors.background}
            style={{ position: 'absolute', left: L.phone.x, top: L.phone.y, opacity: Math.min(1, enter * 1.6) }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: SCREEN,
                height: (phoneH - 2 * bezel) / scale,
                transformOrigin: '0 0',
                transform: `scale(${scale})`,
              }}
            >
              <Screen t={t} b={b} tap={tap} tapPoint={tapPoint} />
            </div>
          </PhoneFrame>
        </Stage3D>
      </div>
    </Fill>
  );
}

/** The app: a home screen (header, stat card, activity list, button) and, slid in from the right, the tapped row's detail. */
function Screen({
  t,
  b,
  tap,
  tapPoint,
}: {
  t: number;
  b: (n: number) => number;
  tap: number;
  tapPoint: { x: number; y: number };
}) {
  const brand = useBrand();
  const { ui, colors, fonts, Logo } = brand;
  const copy = COPY[brand.language] ?? COPY.fr;
  const Extra = EXTRA ? brand.extras[EXTRA]?.component : undefined;
  const item = (i: number) => ease.outCubic(progress(t, b(TIMING.screen) + i * 0.06, b(TIMING.screen) + i * 0.06 + 0.5));
  const show = (i: number, children: ReactNode, key?: string) => {
    const k = item(i);
    return (
      <div key={key} style={{ opacity: k, transform: k < 1 ? `translateY(${(1 - k) * 16}px)` : undefined }}>
        {children}
      </div>
    );
  };
  const scroll = progress(t, b(TIMING.scroll[0]), b(TIMING.scroll[1]), ease.inOutCubic) * 150;
  const slide = progress(t, b(TIMING.slide[0]), b(TIMING.slide[1]), ease.inOutCubic);
  const check = progress(t, b(TIMING.check[0]), b(TIMING.check[1]), ease.inOutCubic);
  const count = progress(t, b(TIMING.screen), b(TIMING.screen + 2.4), ease.outExpo);
  const pressed = t >= tap - 0.08 && t < b(TIMING.slide[1]);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', fontFamily: fonts.body }}>
      <div style={{ position: 'absolute', inset: 0, transform: slide > 0 ? `translateX(${-slide * 100}%)` : undefined }}>
        <div
          style={{
            position: 'absolute',
            left: 20,
            right: 20,
            top: 62 - scroll,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {show(
            0,
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Logo variant="mark" height={34} />
              <div
                style={{ flex: 1, fontFamily: fonts.display, fontSize: 21, fontWeight: displayWeight(brand), color: colors.ink }}
              >
                {brand.name}
              </div>
              <ui.Avatar name="Olivia Martin" size={38} />
            </div>,
          )}
          {show(
            1,
            <div style={{ marginTop: 6 }}>
              <div
                style={{
                  fontFamily: fonts.display,
                  fontSize: 30,
                  fontWeight: displayWeight(brand),
                  letterSpacing: '-0.02em',
                  color: colors.ink,
                }}
              >
                {copy.hello}
              </div>
              <div style={{ marginTop: 2, fontSize: 18, color: colors.muted }}>{copy.sub}</div>
            </div>,
          )}
          {show(
            2,
            Extra ? (
              <Extra width={SCREEN - 40} />
            ) : (
              <ui.Card variant="default" padding={22}>
                <div style={{ transformOrigin: '0 0', transform: 'scale(0.82)', height: 118 }}>
                  <ui.Stat
                    label={copy.stat.label}
                    value={<Counter to={copy.stat.value} progress={count} locale={brand.language === 'en' ? 'en-US' : 'fr-FR'} />}
                    delta={copy.stat.delta}
                  />
                </div>
              </ui.Card>
            ),
          )}
          {show(3, <div style={{ marginTop: 4, fontSize: 18, fontWeight: 600, color: colors.ink }}>{copy.section}</div>)}
          <div style={{ margin: '0 -14px' }}>
            {copy.rows.map((row, i) =>
              show(
                4 + i,
                <ui.ListItem
                  title={row.title}
                  subtitle={row.subtitle}
                  leading={<ui.Avatar name={row.title} size={44} />}
                  trailing={<span style={{ fontSize: 16, color: colors.muted }}>{row.trailing}</span>}
                  selected={i === TAPPED && pressed}
                  style={{ padding: '12px 14px' }}
                />,
                row.title,
              ),
            )}
          </div>
        </div>
        {/* Scrolled content fades under the status bar at the top and under the fixed bottom bar. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: 64,
            background: `linear-gradient(${colors.background} 55%, ${withAlpha(colors.background, 0)})`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 150,
            background: `linear-gradient(${withAlpha(colors.background, 0)}, ${colors.background} 38%)`,
          }}
        />
        <div style={{ position: 'absolute', left: 20, right: 20, bottom: 30 }}>
          {show(
            10,
            <ui.Button variant="primary" size="lg" style={{ width: '100%' }}>
              {copy.button}
            </ui.Button>,
          )}
        </div>
        <ClickRipple x={tapPoint.x} y={tapPoint.y} t={t} at={tap} size={40} />
      </div>
      {slide > 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: colors.background,
            transform: `translateX(${(1 - slide) * 100}%)`,
          }}
        >
          <Detail check={check} />
        </div>
      ) : null}
    </div>
  );
}

/** Detail screen: back link, a check drawn in a success disc, title, amount, a few rows. */
function Detail({ check }: { check: number }) {
  const brand = useBrand();
  const { colors, fonts } = brand;
  const d = (COPY[brand.language] ?? COPY.fr).detail;
  return (
    <div style={{ position: 'absolute', left: 24, right: 24, top: 70, fontFamily: fonts.body }}>
      <div style={{ fontSize: 18, fontWeight: 500, color: colors.primary }}>‹ {d.back}</div>
      <div style={{ marginTop: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: 48,
            background: withAlpha(colors.success, 0.12 + 0.1 * check),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width={48} height={48} viewBox="0 0 24 24" style={{ overflow: 'visible' }}>
            <DrawPath d="M5 12.5l4.5 4.5L19 7.5" progress={check} color={colors.success} width={2.6} />
          </svg>
        </div>
        <div
          style={{
            marginTop: 26,
            fontFamily: fonts.display,
            fontSize: 28,
            fontWeight: displayWeight(brand),
            letterSpacing: '-0.02em',
            color: colors.ink,
          }}
        >
          {d.title}
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: fonts.display,
            fontSize: 44,
            fontWeight: displayWeight(brand),
            letterSpacing: '-0.03em',
            color: colors.ink,
          }}
        >
          {d.amount}
        </div>
      </div>
      <div style={{ marginTop: 40, borderTop: `1px solid ${colors.line}` }}>
        {d.rows.map(([label, value]) => (
          <div
            key={label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '16px 0',
              borderBottom: `1px solid ${colors.line}`,
              fontSize: 18,
            }}
          >
            <span style={{ color: colors.muted }}>{label}</span>
            <span style={{ color: colors.ink, fontWeight: 500 }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Headline lines rising from a mask; `y` is their vertical center when `center`, else their top. */
function Lines({
  lines,
  p,
  x,
  y,
  size,
  center,
  width,
}: {
  lines: string[];
  p: number;
  x: number;
  y: number;
  size: number;
  center: boolean;
  width: number;
}) {
  const brand = useBrand();
  const type = { fontFamily: brand.fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.03em' };
  const fit = Math.min(size, ...lines.map((line) => (size * width) / measureText(line, { ...type, fontSize: size }).width));
  const lineHeight = Math.round(fit * 1.08);
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
        const k = ease.outExpo(progress(p, i * 0.12, 0.75 + i * 0.12));
        return (
          <div key={i} style={{ height: lineHeight, overflow: 'hidden', paddingBottom: '0.14em', marginBottom: '-0.14em' }}>
            <div
              style={{
                color: i === 0 ? brand.colors.ink : mixColor(brand.colors.muted, brand.colors.background, 0.1),
                transform: k < 1 ? `translateY(${(1 - k) * 110}%)` : undefined,
              }}
            >
              {line}
            </div>
          </div>
        );
      })}
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
