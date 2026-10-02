import {
  Cursor,
  cursorPress,
  ease,
  Fill,
  measureText,
  mixColor,
  progress,
  spring,
  springs,
  TypeOn,
  useBrand,
  useFormat,
  type BrandKit,
  type CursorKey,
  type SceneProps,
} from 'cadence';

// Call to action: the headline rises, the button pops, a cursor glides onto it and presses it on the downbeat, then
// the URL types itself and the logo settles at the bottom. The end of the video: nothing leaves.
// First frame: the plain background. Last frame: headline, button, URL and logo, at rest.

/** On-screen copy, per brand language. `{name}` = the brand name; `sub` null = the brand tagline. */
const COPY = {
  fr: { headline: 'Essayez {name}', sub: null as string | null, button: 'Commencer gratuitement' },
  en: { headline: 'Try {name}', sub: null as string | null, button: 'Get started for free' },
};

/** Beats from the scene start. */
const TIMING = {
  headline: [0, 1.4], // the headline rises
  sub: [0.8, 1.8], // the subline arrives
  button: 1.4, // the button pops
  cursor: [2.2, 3.6], // the cursor glides onto the button...
  press: 4, // ...and presses it on this beat (a downbeat)
  url: [4.4, 6], // the URL types in
  logo: [5, 6], // the logo settles
};

/** Button center (y), headline size, sub size, button scale, gap, logo height, URL size, per format. */
const LAYOUT = {
  landscape: { y: 610, size: 128, sub: 38, button: 1.5, gap: 64, logo: 46, url: 30 },
  portrait: { y: 1000, size: 112, sub: 40, button: 1.6, gap: 70, logo: 54, url: 34 },
  square: { y: 610, size: 96, sub: 32, button: 1.35, gap: 50, logo: 42, url: 28 },
  '4:5': { y: 740, size: 104, sub: 34, button: 1.45, gap: 56, logo: 46, url: 30 },
};

/** Height of the kit's large button before scaling (kits use 62-66 px). */
const BUTTON_H = 64;

export default function CtaEnd({ t, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const copy = COPY[brand.language] ?? COPY.fr;
  const { ui, colors, fonts, Logo } = brand;
  const b = (n: number) => music.beat(n);

  const title = copy.headline.replace('{name}', brand.name);
  const sub = copy.sub ?? brand.tagline;
  const headType = { fontFamily: fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.04em' };
  const size = Math.floor(
    Math.min(L.size, (L.size * (width - 2 * f.safe.left - 40)) / measureText(title, { ...headType, fontSize: L.size }).width),
  );
  const head = ease.outExpo(progress(t, b(TIMING.headline[0]), b(TIMING.headline[1])));
  const subIn = ease.outCubic(progress(t, b(TIMING.sub[0]), b(TIMING.sub[1])));
  const pop = settle(t < b(TIMING.button) ? 0 : spring(t - b(TIMING.button), { from: 0, to: 1, ...springs.snappy }));
  const press = music.snap(b(TIMING.press), 'beat');
  const hover = progress(t, b(TIMING.cursor[1]) - 0.15, b(TIMING.cursor[1]));
  const logo = ease.outCubic(progress(t, b(TIMING.logo[0]), b(TIMING.logo[1])));
  const url = progress(t, b(TIMING.url[0]), b(TIMING.url[1]));

  // Explicit layout around the button's center, so the cursor knows where to click.
  const buttonH = BUTTON_H * L.button;
  const subGap = Math.round(L.gap * 0.4);
  const blockH = size * 1.02 + subGap + L.sub * 1.3;
  const headTop = L.y - buttonH / 2 - L.gap - blockH;
  const path: CursorKey[] = [
    { t: b(TIMING.cursor[0]), x: width * 0.8, y: height * 0.92 },
    { t: b(TIMING.cursor[1]), x: width / 2 + 36 * L.button, y: L.y + 6 },
    { t: b(TIMING.cursor[1]) + 2.5, x: width / 2 + 70 * L.button, y: L.y + 50 },
  ];
  const cursorIn = progress(t, b(TIMING.cursor[0]), b(TIMING.cursor[0]) + 0.3);

  return (
    <Fill>
      <Backdrop />
      <div style={{ position: 'absolute', left: 0, right: 0, top: headTop, textAlign: 'center' }}>
        <div style={{ overflow: 'hidden', paddingBottom: '0.12em', marginBottom: '-0.12em' }}>
          <div
            style={{
              ...headType,
              fontSize: size,
              lineHeight: 1.02,
              color: colors.ink,
              transform: head < 1 ? `translateY(${(1 - head) * 110}%)` : undefined,
            }}
          >
            {title}
          </div>
        </div>
        <div
          style={{
            marginTop: subGap,
            fontFamily: fonts.body,
            fontSize: L.sub,
            lineHeight: 1.3,
            color: mixColor(colors.muted, colors.ink, 0.15),
            opacity: subIn,
            transform: subIn < 1 ? `translateY(${(1 - subIn) * 16}px)` : undefined,
          }}
        >
          {sub}
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: L.y,
          height: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div style={{ transform: `scale(${L.button * pop})`, opacity: Math.min(1, pop * 2) }}>
          <ui.Button variant="primary" size="lg" hovered={hover > 0.5} pressed={cursorPress(t, [press]) > 0.5}>
            {copy.button}
          </ui.Button>
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: L.y + buttonH / 2 + L.gap * 0.8,
          textAlign: 'center',
          fontFamily: fonts.mono,
          fontSize: L.url,
          color: colors.muted,
          letterSpacing: '0.02em',
        }}
      >
        {brand.url && url > 0 ? (
          <TypeOn
            text={brand.url}
            progress={url}
            reserve
            color={colors.muted}
            pendingColor={mixColor(colors.muted, colors.background, 0.7)}
            caret={url < 1 ? { color: colors.accent, width: 3 } : false}
          />
        ) : null}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: f.safe.bottom + 40,
          display: 'flex',
          justifyContent: 'center',
          opacity: logo,
          transform: logo < 1 ? `translateY(${(1 - logo) * 14}px)` : undefined,
        }}
      >
        <Logo variant="full" height={L.logo} />
      </div>
      <Cursor
        t={t}
        path={path}
        clicks={[press]}
        hover={hover}
        ripple
        opacity={cursorIn}
        size={Math.round(32 * Math.max(1, L.button * 0.8))}
      />
    </Fill>
  );
}

/** A spring this close to its target counts as landed. */
function settle(v: number): number {
  return Math.abs(1 - v) < 0.002 ? 1 : v;
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
