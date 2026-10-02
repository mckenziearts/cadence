import type { CSSProperties, ReactNode } from 'react';
import {
  Camera,
  clamp,
  ease,
  Fill,
  Layer3D,
  measureText,
  mix,
  mixColor,
  progress,
  SwapWords,
  toHex,
  useBrand,
  useFormat,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Surface grid: the card shrinks into a row of its styles ("Every surface"), the row becomes the first line of a grid
// whose rows sit on backgrounds from light to dark ("On every background"), then the camera flies back into the
// original card (Caleb's "Every surface / On every background").
// First frame: headline `from` + flat card (pose "titled"). Last frame: the card alone, centered (pose "hero").

/** On-screen copy, per brand language. `labels` name the styles of COLUMNS, in order. */
const COPY = {
  fr: {
    from: 'Chaque style',
    headline: 'Chaque surface',
    grid: ['Sur chaque', 'fond'],
    labels: ['Divisée', 'Pleine largeur', 'Encart', 'Séparée', 'Sans bord'],
  },
  en: {
    from: 'Every style',
    headline: 'Every surface',
    grid: ['On every', 'background'],
    labels: ['Divided', 'Flush', 'Inset', 'Separated', 'Seamless'],
  },
};

/** Styles of the columns; the one at HERO_COLUMN is the scene's own card (it shrinks into it, and comes back). */
const COLUMNS: CardVariant[] = ['divided', 'flush', 'inset', 'separated', 'seamless'];
const HERO_COLUMN = 2;

/** Row backgrounds, light to dark, from the brand colors (labelled with their hex value). */
function rowColors(brand: BrandKit): string[] {
  const { surface, background, ink } = brand.colors;
  return [
    surface,
    background,
    mixColor(background, ink, 0.1),
    mixColor(ink, background, 0.14),
    mixColor(ink, '#000000', 0.55),
  ].map((color) => toHex(color));
}

/** Beats from the scene start, except `back`: beats before the end. */
const TIMING = {
  headline: [0, 2], // "Every style" to "Every surface"
  row: [0, 1.6], // the card shrinks into the row
  neighbours: [0.6, 2.2], // the other styles appear, from the center out
  grid: [3.6, 5.4], // the row moves into the grid, the headline changes
  rows: [4.4, 7], // background rows unfold, top to bottom
  back: [2.6, 0.25], // everything else fades, the camera flies back into the card
};

/**
 * Per format: the row (card scale, gap, top; it may overflow the frame), the grid (card scale, gap, left, top, band
 * padding), the second headline (left, top, size, alignment) and the labels (size, right edge of the row labels;
 * 0 = no row labels).
 */
const LAYOUT = {
  landscape: {
    row: { s: 0.46, gap: 24, y: 468 },
    grid: { s: 0.25, gap: 16, x: 860, y: 126, pad: 14 },
    head: { x: 140, y: 540, size: 96, align: 'left' },
    labels: { size: 15, right: 840 },
  },
  portrait: {
    row: { s: 0.5, gap: 24, y: 842 },
    grid: { s: 0.26, gap: 12, x: 101, y: 640, pad: 12 },
    head: { x: 0, y: 330, size: 92, align: 'center' },
    labels: { size: 16, right: 0 },
  },
  square: {
    row: { s: 0.38, gap: 18, y: 493 },
    grid: { s: 0.22, gap: 10, x: 230, y: 236, pad: 10 },
    head: { x: 0, y: 100, size: 72, align: 'center' },
    labels: { size: 13, right: 214 },
  },
  '4:5': {
    row: { s: 0.42, gap: 20, y: 656 },
    grid: { s: 0.24, gap: 10, x: 210, y: 330, pad: 12 },
    head: { x: 0, y: 170, size: 80, align: 'center' },
    labels: { size: 14, right: 194 },
  },
};

export default function SurfaceGrid({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const poses = usePoses();
  const copy = COPY[brand.language] ?? COPY.fr;
  const { colors, fonts } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;
  const rows = rowColors(brand);

  // Geometry: slot of each column in the row, and cell of each (row, column) in the grid.
  const cw = (s: number) => CARD.w * s;
  const ch = (s: number) => CARD.h * s;
  const rowX = (i: number) => Math.round((width - (5 * cw(L.row.s) + 4 * L.row.gap)) / 2 + i * (cw(L.row.s) + L.row.gap));
  const band = ch(L.grid.s) + 2 * L.grid.pad;
  const cell = (r: number, c: number): CardPose => ({
    x: L.grid.x + c * (cw(L.grid.s) + L.grid.gap),
    y: L.grid.y + r * band + L.grid.pad,
    s: L.grid.s,
  });

  const shrink = progress(t, b(TIMING.row[0]), b(TIMING.row[1]), ease.inOutCubic);
  const toGrid = progress(t, b(TIMING.grid[0]), b(TIMING.grid[1]), ease.inOutCubic);
  const back = progress(t, end(TIMING.back[0]), end(TIMING.back[1]), ease.inOutCubic);
  const fadeRest = 1 - progress(t, end(TIMING.back[0]), end(TIMING.back[0] - 0.8), ease.outCubic);
  const headA = 1 - progress(t, b(TIMING.grid[0]), b(TIMING.grid[0] + 0.8), ease.inCubic);
  const headB = progress(t, b(TIMING.grid[0] + 0.6), b(TIMING.grid[1] + 0.4), ease.outExpo);

  const slot = (c: number): CardPose => ({ x: rowX(c), y: L.row.y, s: L.row.s });
  const poseOf = (c: number): CardPose => {
    const inRow = mixPose(slot(c), cell(0, c), toGrid);
    return c === HERO_COLUMN ? mixPose(poses.titled, inRow, shrink) : inRow;
  };

  // The return: a camera move that lands the hero cell exactly on the "hero" pose, then the plain card takes over.
  const target = cell(0, HERO_COLUMN);
  const zoom = poses.hero.s / target.s;
  const heroCenter = { x: poses.hero.x + cw(poses.hero.s) / 2, y: poses.hero.y + ch(poses.hero.s) / 2 };
  const cellCenter = { x: target.x + cw(target.s) / 2, y: target.y + ch(target.s) / 2 };
  const cam = {
    x: cellCenter.x - (heroCenter.x - width / 2) / zoom,
    y: cellCenter.y - (heroCenter.y - height / 2) / zoom,
  };
  if (back >= 1) {
    return (
      <Fill>
        <Backdrop />
        <ProfileCard pose={poses.hero} />
      </Fill>
    );
  }
  // Exponential zoom feels constant; the look-at point follows so the target slides straight to its place.
  const z = Math.pow(zoom, back);
  const k = back === 0 ? 0 : (1 - 1 / z) / (1 - 1 / zoom);

  return (
    <Fill>
      <Backdrop />
      <Headline
        from={copy.from}
        to={copy.headline}
        p={progress(t, b(TIMING.headline[0]), b(TIMING.headline[1]))}
        style={{ opacity: headA, transform: headA < 1 ? `translateY(${-(1 - headA) * 40}px)` : undefined }}
      />
      {headB > 0 && fadeRest > 0 ? (
        <div style={{ opacity: fadeRest, transform: fadeRest < 1 ? `translateY(${-(1 - fadeRest) * 30}px)` : undefined }}>
          <GridHeadline lines={copy.grid} p={headB} {...L.head} />
        </div>
      ) : null}
      <Camera x={mix(width / 2, cam.x, k)} y={mix(height / 2, cam.y, k)} zoom={z}>
        {rows.map((color, r) => {
          const unfold =
            // The first band opens once its cards have nearly reached the grid, so it never floats alone.
            r === 0
              ? progress(toGrid, 0.85, 1)
              : progress(t, b(TIMING.rows[0]) + r * 0.12, b(TIMING.rows[0]) + r * 0.12 + 0.5, ease.outCubic);
          if (unfold <= 0) return null;
          const top = L.grid.y + r * band;
          const gridW = 5 * cw(L.grid.s) + 4 * L.grid.gap;
          return (
            <div key={r} style={{ opacity: fadeRest }}>
              <div
                style={{
                  position: 'absolute',
                  left: L.grid.x - L.grid.pad,
                  top,
                  width: gridW + 2 * L.grid.pad,
                  height: band,
                  background: color,
                  borderRadius: r === 0 ? '18px 18px 0 0' : r === rows.length - 1 ? '0 0 18px 18px' : 0,
                  clipPath: `inset(0 0 ${(1 - unfold) * 100}% 0)`,
                }}
              />
              <RowLabel text={color} top={top + band / 2} show={unfold} {...L.labels} />
            </div>
          );
        })}
        {rows.map((_, r) =>
          COLUMNS.map((variant, c) => {
            if (r === 0) {
              const appear =
                c === HERO_COLUMN
                  ? 1
                  : progress(
                      t,
                      b(TIMING.neighbours[0]) + Math.abs(c - HERO_COLUMN) * 0.08,
                      b(TIMING.neighbours[1]),
                      ease.outCubic,
                    );
              const opacity = appear * (c === HERO_COLUMN ? 1 : fadeRest);
              if (opacity <= 0) return null;
              return (
                <Fade key={`${r}-${c}`} opacity={opacity} rise={(1 - appear) * 24}>
                  <ProfileCard pose={poseOf(c)} state={{ variant }} />
                </Fade>
              );
            }
            const start = b(TIMING.rows[0]) + r * 0.12 + c * 0.03;
            const appear = progress(t, start + 0.08, start + 0.45, ease.outCubic) * fadeRest;
            if (appear <= 0) return null;
            return (
              <Fade key={`${r}-${c}`} opacity={appear} rise={0}>
                <ProfileCard pose={cell(r, c)} state={{ variant }} />
              </Fade>
            );
          }),
        )}
      </Camera>
      {/* Style names over the row, until the grid takes over. */}
      {COLUMNS.map((_, c) => {
        const shown = progress(t, b(TIMING.neighbours[0]) + 0.3, b(TIMING.neighbours[1]) + 0.2, ease.outCubic) * (1 - toGrid * 3);
        if (shown <= 0) return null;
        return (
          <div
            key={c}
            style={{
              position: 'absolute',
              left: rowX(c),
              top: L.row.y - L.labels.size * 2.4,
              width: cw(L.row.s),
              textAlign: 'center',
              fontFamily: fonts.mono,
              fontSize: L.labels.size,
              fontWeight: 500,
              letterSpacing: '0.12em',
              color: colors.muted,
              whiteSpace: 'nowrap',
              opacity: shown,
            }}
          >
            {copy.labels[c].toLocaleUpperCase(brand.language)}
          </div>
        );
      })}
    </Fill>
  );
}

function Fade({ opacity, rise, children }: { opacity: number; rise: number; children: ReactNode }) {
  if (opacity >= 1 && !rise) return <>{children}</>;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity, transform: rise ? `translateY(${rise}px)` : undefined }}>
      {children}
    </div>
  );
}

/** Hex value of a row's background, in mono, right-aligned before `right` (none when `right` is 0). */
function RowLabel({ text, top, show, size, right }: { text: string; top: number; show: number; size: number; right: number }) {
  const { colors, fonts } = useBrand();
  if (!right) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: right - 240,
        width: 240,
        top: top - size * 0.65,
        textAlign: 'right',
        fontFamily: fonts.mono,
        fontSize: size,
        fontWeight: 500,
        lineHeight: 1.3,
        letterSpacing: '0.06em',
        whiteSpace: 'nowrap',
        color: colors.muted,
        opacity: show,
      }}
    >
      {text.toUpperCase()}
    </div>
  );
}

/** Two lines rising from a mask, left-aligned or centered. */
function GridHeadline({
  lines,
  p,
  x,
  y,
  size,
  align,
}: {
  lines: string[];
  p: number;
  x: number;
  y: number;
  size: number;
  align: string;
}) {
  const brand = useBrand();
  const { width } = useFormat();
  const type: CSSProperties = {
    fontFamily: brand.fonts.display,
    fontWeight: displayWeight(brand),
    fontSize: size,
    letterSpacing: '-0.03em',
    lineHeight: 1.04,
    color: brand.colors.ink,
  };
  const centered = align === 'center';
  const oneLine =
    centered &&
    measureText(lines.join(' '), {
      fontFamily: brand.fonts.display,
      fontWeight: displayWeight(brand),
      fontSize: size,
      letterSpacing: '-0.03em',
    }).width <
      width - 160;
  const shown = oneLine ? [lines.join(' ')] : lines;
  const top = centered ? y : y - (shown.length * size * 1.04) / 2;
  return (
    <div
      style={{
        position: 'absolute',
        left: centered ? 0 : x,
        width: centered ? width : undefined,
        top,
        textAlign: centered ? 'center' : 'left',
        ...type,
      }}
    >
      {shown.map((line, i) => {
        const k = progress(p, i * 0.12, 0.7 + i * 0.12);
        return (
          <div key={i} style={{ overflow: 'hidden', paddingBottom: '0.12em', marginBottom: '-0.12em' }}>
            <div style={{ transform: k < 1 ? `translateY(${(1 - ease.outExpo(k)) * 110}%)` : undefined }}>{line}</div>
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

// Shared by the teaser templates (wireframe-glow, exploded-anatomy, variant-pills, surface-grid, zoom-annotate,
// cursor-demo): poses, headline and hero card. Cuts between them stay invisible only if these render identically:
// edit them in every scene that uses them, or move them to components/ and import them from there.

/** Named poses: card top-left + scale ("hero" alone, centered; "titled" under the headline), headline top + size. */
const POSES = {
  landscape: { hero: { s: 1.1, y: 225 }, titled: { s: 0.96, y: 306 }, head: { top: 148, size: 104, max: 1640 } },
  portrait: { hero: { s: 1.36, y: 491 }, titled: { s: 1.3, y: 540 }, head: { top: 330, size: 92, max: 960 } },
  square: { hero: { s: 1.2, y: 197 }, titled: { s: 1.04, y: 236 }, head: { top: 100, size: 76, max: 960 } },
  '4:5': { hero: { s: 1.3, y: 303 }, titled: { s: 1.18, y: 330 }, head: { top: 170, size: 84, max: 960 } },
};

interface CardPose {
  x: number;
  y: number;
  s: number;
}

function usePoses() {
  const f = useFormat();
  const p = f.pick(POSES);
  const at = (q: { s: number; y: number }): CardPose => ({ x: Math.round((f.width - CARD.w * q.s) / 2), y: q.y, s: q.s });
  return { hero: at(p.hero), titled: at(p.titled), head: p.head };
}

function mixPose(a: CardPose, b: CardPose, k: number): CardPose {
  return { x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), s: mix(a.s, b.s, k) };
}

/**
 * One centered headline line at the pose's top; `from` words swap to `to` (SwapWords). A text too wide for the
 * frame gets a smaller size; during the swap the size moves from one text's size to the other's, so each end of the
 * scene depends only on the text shown there (and matches the neighbouring scene).
 */
function Headline({ from, to, p, style }: { from: string; to: string; p: number; style?: CSSProperties }) {
  const brand = useBrand();
  const { head } = usePoses();
  const type = { fontFamily: brand.fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.03em' };
  const fit = (text: string) =>
    text ? Math.min(head.size, (head.size * head.max) / measureText(text, { ...type, fontSize: head.size }).width) : head.size;
  const size = Math.floor(mix(fit(from || to), fit(to || from), ease.inOutCubic(clamp(p))));
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: head.top,
        textAlign: 'center',
        ...type,
        fontSize: size,
        lineHeight: 1,
        color: brand.colors.ink,
        ...style,
      }}
    >
      <SwapWords from={from} to={to} progress={p} />
    </div>
  );
}

// Hero card: a profile card built from the brand kit. Geometry in card px (a pose places and scales it): header on
// the frame, fields and footer on the inset panel. Kits size their inputs differently, so the two fields stack in the
// middle of the band [fields, fieldsEnd] instead of sitting at fixed positions.
const CARD = { w: 640, h: 572, header: 112, inset: 6, pad: 28, fields: 136, fieldsEnd: 436, rule: 460, footer: 512 };

const CARD_COPY = {
  fr: {
    title: 'Profil',
    subtitle: 'Voici comment les autres vous voient',
    nameLabel: 'Nom',
    name: 'Olivia Martin',
    bioLabel: 'Bio',
    bio: 'Quelques mots sur vous',
    status: 'Enregistré il y a 2 min',
    cancel: 'Annuler',
    save: 'Enregistrer',
  },
  en: {
    title: 'Profile',
    subtitle: 'This is how others will see you',
    nameLabel: 'Name',
    name: 'Olivia Martin',
    bioLabel: 'Bio',
    bio: 'A few words about yourself',
    status: 'Last saved 2 minutes ago',
    cancel: 'Cancel',
    save: 'Save',
  },
};

type CardVariant = 'inset' | 'flush' | 'divided' | 'separated' | 'seamless';
type CardPart = 'surface' | 'panel' | 'header' | 'fields' | 'footer' | 'action';

/** Z lift of each layer (px) in the fully exploded view. */
const LIFT: Record<CardPart, number> = { surface: 0, panel: 60, header: 120, fields: 135, footer: 150, action: 220 };

interface CardState {
  variant?: CardVariant;
  /** Left-to-right wipe from `variant` to `to` (p from 0 to 1). */
  wipe?: { to: CardVariant; p: number };
  name?: string;
  bio?: string;
  focus?: 'name' | 'bio' | null;
  caret?: boolean;
  hover?: 'save' | 'cancel' | null;
  pressed?: boolean;
  status?: ReactNode;
  /** Opacity per layer (dim what the camera is not looking at). */
  opacity?: Partial<Record<CardPart, number>>;
}

/** The hero card, one Layer3D per part: flat anywhere, exploded when `lift` > 0 inside a Stage3D. */
function ProfileCard({ pose, lift = 0, state = {} }: { pose: CardPose; lift?: number; state?: CardState }) {
  const brand = useBrand();
  const { ui, colors, fonts } = brand;
  const c = CARD_COPY[brand.language] ?? CARD_COPY.fr;
  const variant = state.variant ?? 'inset';
  const layer = (part: CardPart, children: ReactNode) => (
    <Layer3D key={part} z={LIFT[part] * lift}>
      <div
        style={{
          position: 'absolute',
          left: pose.x,
          top: pose.y,
          width: CARD.w,
          height: CARD.h,
          transformOrigin: '0 0',
          transform: pose.s === 1 ? undefined : `scale(${pose.s})`,
          opacity: state.opacity?.[part],
        }}
      >
        {children}
      </div>
    </Layer3D>
  );
  const shells = (part: 'surface' | 'panel') => {
    const wipe = state.wipe && state.wipe.p > 0 ? state.wipe : null;
    if (!wipe) return <CardShell part={part} variant={variant} />;
    return (
      <>
        <Slice from={wipe.p} to={1}>
          <CardShell part={part} variant={variant} />
        </Slice>
        <Slice from={0} to={wipe.p}>
          <CardShell part={part} variant={wipe.to} />
        </Slice>
      </>
    );
  };
  // Both buttons in both layers keep the row's layout; each layer shows only its own.
  const row = (own: 'footer' | 'action') => (
    <div
      style={{
        position: 'absolute',
        right: CARD.pad,
        top: CARD.footer - 30,
        height: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <ui.Button
        variant="ghost"
        hovered={state.hover === 'cancel'}
        style={{ visibility: own === 'footer' ? 'visible' : 'hidden' }}
      >
        {c.cancel}
      </ui.Button>
      <ui.Button
        variant="primary"
        hovered={state.hover === 'save'}
        pressed={state.pressed}
        style={{ visibility: own === 'action' ? 'visible' : 'hidden' }}
      >
        {c.save}
      </ui.Button>
    </div>
  );
  return (
    <>
      {layer('surface', shells('surface'))}
      {layer('panel', shells('panel'))}
      {layer(
        'header',
        <ui.CardHeader style={{ position: 'absolute', left: CARD.pad, top: 26, width: CARD.w - 2 * CARD.pad, margin: 0 }}>
          <div>
            <div>{c.title}</div>
            <div
              style={{
                marginTop: 4,
                fontFamily: fonts.body,
                fontSize: 18,
                fontWeight: 400,
                lineHeight: '26px',
                letterSpacing: 0,
                color: colors.muted,
              }}
            >
              {c.subtitle}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, paddingTop: 12 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ width: 5, height: 5, borderRadius: 3, background: colors.ink }} />
            ))}
          </div>
        </ui.CardHeader>,
      )}
      {layer(
        'fields',
        <div
          style={{
            position: 'absolute',
            left: CARD.pad,
            top: CARD.fields,
            width: CARD.w - 2 * CARD.pad,
            height: CARD.fieldsEnd - CARD.fields,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 22,
          }}
        >
          <ui.Input
            label={c.nameLabel}
            value={state.name ?? c.name}
            focused={state.focus === 'name'}
            caret={state.focus === 'name' && state.caret}
          />
          <ui.Input
            label={c.bioLabel}
            value={state.bio}
            placeholder={c.bio}
            multiline
            focused={state.focus === 'bio'}
            caret={state.focus === 'bio' && state.caret}
          />
        </div>,
      )}
      {layer(
        'footer',
        <>
          <div
            style={{
              position: 'absolute',
              left: CARD.pad,
              top: CARD.footer - 13,
              fontFamily: fonts.body,
              fontSize: 17,
              lineHeight: '26px',
              color: colors.muted,
              whiteSpace: 'nowrap',
            }}
          >
            {state.status ?? c.status}
          </div>
          {row('footer')}
        </>,
      )}
      {layer('action', row('action'))}
    </>
  );
}

/** Frame (`surface`) or inner containers (`panel`) of a card variant, from the kit's Card and CardBody. */
function CardShell({ part, variant }: { part: 'surface' | 'panel'; variant: CardVariant }) {
  const { ui, colors, radius } = useBrand();
  const fill: CSSProperties = { position: 'absolute', inset: 0 };
  const box = (top: number, bottom: number): CSSProperties => ({
    position: 'absolute',
    left: 0,
    top,
    width: CARD.w,
    height: bottom - top,
  });
  const rule = (top: number, inset: number) => (
    <div style={{ position: 'absolute', left: inset, right: inset, top, height: 1, background: colors.line }} />
  );
  if (part === 'surface') {
    if (variant === 'separated') return null;
    const look = variant === 'divided' ? 'default' : variant === 'seamless' ? 'elevated' : 'muted';
    return <ui.Card variant={look} padding={0} style={fill} />;
  }
  if (variant === 'divided') {
    return (
      <>
        {rule(CARD.header, 0)}
        {rule(CARD.rule, 0)}
      </>
    );
  }
  if (variant === 'seamless') return null;
  if (variant === 'separated') {
    return (
      <>
        <ui.Card padding={0} style={box(0, CARD.header - 8)} />
        <ui.Card padding={0} style={box(CARD.header, CARD.rule - 8)} />
        <ui.Card padding={0} style={box(CARD.rule, CARD.h)} />
      </>
    );
  }
  // inset / flush: the kit's muted body panel (CardBody reads the variant from its Card), on a transparent Card.
  const k = variant === 'inset' ? CARD.inset : 0;
  const r = Math.max(2, radius.xl - CARD.inset);
  return (
    <ui.Card variant="muted" padding={0} style={{ ...fill, background: 'transparent', boxShadow: 'none', border: 'none' }}>
      <ui.CardBody
        style={{
          position: 'absolute',
          left: k,
          top: CARD.header,
          width: CARD.w - 2 * k,
          height: CARD.h - CARD.header - k,
          margin: 0,
          padding: 0,
          boxSizing: 'border-box',
          borderRadius: variant === 'inset' ? r : `0 0 ${radius.xl}px ${radius.xl}px`,
        }}
      />
      {rule(CARD.rule, k)}
    </ui.Card>
  );
}

/** Vertical slice [from, to] of the card box (fractions of its width); shadows overflow the other sides. */
function Slice({ from, to, children }: { from: number; to: number; children: ReactNode }) {
  const left = from <= 0 ? '-80px' : `${from * 100}%`;
  const right = to >= 1 ? '-80px' : `${(1 - to) * 100}%`;
  return <div style={{ position: 'absolute', inset: 0, clipPath: `inset(-80px ${right} -80px ${left})` }}>{children}</div>;
}
