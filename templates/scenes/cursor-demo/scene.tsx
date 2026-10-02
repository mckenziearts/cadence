import type { CSSProperties, ReactNode } from 'react';
import {
  clamp,
  Cursor,
  cursorPress,
  ease,
  Fill,
  Highlight,
  Layer3D,
  measureText,
  mix,
  mixColor,
  progress,
  SwapWords,
  Tag,
  typed,
  useBrand,
  useFormat,
  type BrandKit,
  type CursorKey,
  type SceneProps,
} from 'cadence';

// Cursor demo: the card slides aside for a two-line headline; a cursor clicks into the bio field, types, then presses
// Save; the status turns to "saved" and the headline's changing words swap in the accent color.
// First frame: the hero card alone, centered (pose "hero"). Last frame: the plain background (everything exits).

/** On-screen copy, per brand language. `swap` replaces `line2` once saved (shared words stay in place). */
const COPY = {
  fr: {
    line1: 'Chaque détail',
    line2: 'se modifie en direct.',
    swap: 's’enregistre en direct.',
    bio: 'Designer produit à Lyon. J’aime les interfaces calmes.',
    saved: 'Enregistré à l’instant',
    tags: { field: 'input.bio', button: 'button.primary' },
  },
  en: {
    line1: 'Every detail',
    line2: 'edits in place.',
    swap: 'saves in place.',
    bio: 'Product designer in Lyon. I like calm interfaces.',
    saved: 'Saved just now',
    tags: { field: 'input.bio', button: 'button.primary' },
  },
};

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  aside: [0, 1.6], // the card moves aside
  headline: [0.6, 2.2], // the two lines rise
  field: 3.6, // the cursor reaches the bio field (hover)
  click: 4, // click into the field
  type: [4.3, 7.6], // typing
  save: 9.5, // the cursor reaches Save
  press: 10, // press
  swap: [10.5, 12.5], // the headline's second line swaps
  exit: [1.2, 0], // everything leaves
};

/** Card pose next to the headline, headline box (left, top, width, size), per format. */
const LAYOUT = {
  landscape: { card: { x: 1076, y: 225, s: 1.1 }, head: { x: 140, y: 540, width: 860, size: 92, center: true } },
  portrait: { card: { x: 124, y: 690, s: 1.3 }, head: { x: 60, y: 300, width: 960, size: 84, center: false } },
  square: { card: { x: 236, y: 380, s: 0.95 }, head: { x: 80, y: 80, width: 920, size: 66, center: false } },
  '4:5': { card: { x: 196, y: 470, s: 1.07 }, head: { x: 80, y: 110, width: 920, size: 74, center: false } },
};

export default function CursorDemo({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const hero = usePoses().hero;
  const copy = COPY[brand.language] ?? COPY.fr;
  const { colors } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const card = mixPose(hero, L.card, progress(t, b(TIMING.aside[0]), b(TIMING.aside[1]), ease.inOutCubic));
  const X = (x: number) => card.x + x * card.s;
  const Y = (y: number) => card.y + y * card.s;
  // Where the Bio block sits for every kit (the two fields are centered in their band), card px.
  const BIO = { top: CARD.fields + 112, bottom: CARD.fieldsEnd + 8 };

  // Cursor: in from the bottom-right, into the bio field, aside while typing, onto Save, then away.
  const click = music.snap(b(TIMING.click), 'half');
  const press = music.snap(b(TIMING.press), 'half');
  const path: CursorKey[] = [
    { t: b(TIMING.field) - 1.1, x: width + 80, y: height * 0.92 },
    { t: b(TIMING.field), x: X(430), y: Y(CARD.fieldsEnd - 70) },
    { t: b(TIMING.type[0]) + 0.5, x: X(520), y: Y(CARD.fieldsEnd - 20), ease: ease.inOutSine },
    { t: b(TIMING.save), x: X(CARD.w - CARD.pad - 64), y: Y(CARD.footer + 6) },
    { t: b(TIMING.swap[1]), x: X(CARD.w - 20), y: Y(CARD.h + 60), ease: ease.inOutSine },
  ];
  const onSave = progress(t, b(TIMING.save) - 0.12, b(TIMING.save) + 0.05) * (1 - progress(t, press + 0.35, press + 0.5));
  const typing = progress(t, b(TIMING.type[0]), b(TIMING.type[1]));
  const focused = t >= click && t < press;
  const saved = t >= press + 0.05;
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);

  const state: CardState = {
    bio: t >= click ? typed(copy.bio, typing) : undefined,
    focus: focused ? 'bio' : null,
    caret: focused && (typing < 1 || music.beatPhase(t) < 0.5),
    hover: onSave > 0.5 ? 'save' : null,
    pressed: cursorPress(t, [press]) > 0.5,
    status: saved ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: colors.success }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: colors.success }} />
        {copy.saved}
      </span>
    ) : undefined,
  };
  const fieldHover =
    progress(t, b(TIMING.field) - 0.15, b(TIMING.field) + 0.1, ease.outCubic) * (1 - progress(t, click + 0.1, click + 0.35));
  const buttonHover =
    progress(t, b(TIMING.save) - 0.1, b(TIMING.save) + 0.15, ease.outCubic) * (1 - progress(t, press + 0.3, press + 0.6));

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
        <TwoLines
          line1={copy.line1}
          from={copy.line2}
          to={copy.swap}
          rise={progress(t, b(TIMING.headline[0]), b(TIMING.headline[1]))}
          swap={progress(t, b(TIMING.swap[0]), b(TIMING.swap[1]))}
          {...L.head}
        />
        <ProfileCard pose={card} state={state} />
        {/* The whole Bio block (label + field; kits size them differently), tagged inside its top-right corner. */}
        <Highlight
          x={X(CARD.pad - 12)}
          y={Y(BIO.top)}
          width={(CARD.w - 2 * CARD.pad + 24) * card.s}
          height={(BIO.bottom - BIO.top) * card.s}
          radius={(brand.radius.md + 6) * card.s}
          progress={fieldHover}
        />
        <Tag x={X(CARD.w - CARD.pad)} y={Y(BIO.top + 8)} anchor="top-right" mono progress={fieldHover}>
          {copy.tags.field}
        </Tag>
        {/* The button's width depends on the brand: tag its right edge rather than outlining it. */}
        <Tag x={X(CARD.w - CARD.pad)} y={Y(CARD.footer - 36)} anchor="bottom-right" mono progress={buttonHover}>
          {copy.tags.button}
        </Tag>
        <Cursor t={t} path={path} clicks={[click, press]} hover={onSave} ripple size={Math.round(30 * Math.max(1, card.s))} />
      </div>
    </Fill>
  );
}

/**
 * Two headline lines: the first in ink, the second in muted; both rise from a mask, then the second swaps its changing
 * words, which take the accent color. Vertically centered on `y` when `center`, else from the top.
 */
function TwoLines(props: {
  line1: string;
  from: string;
  to: string;
  rise: number;
  swap: number;
  x: number;
  y: number;
  width: number;
  size: number;
  center: boolean;
}) {
  const brand = useBrand();
  const { colors, fonts } = brand;
  const { line1, from, to, rise, swap, x, y, width, size, center } = props;
  const type = { fontFamily: fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.03em' };
  const fit = Math.min(
    size,
    ...[line1, from, to].map((line) => (size * width) / measureText(line, { ...type, fontSize: size }).width),
  );
  const lineHeight = Math.round(fit * 1.08);
  const top = center ? y - lineHeight : y;
  const line = (i: number, children: ReactNode, color: string) => {
    const k = progress(rise, i * 0.14, 0.72 + i * 0.14);
    return (
      <div style={{ height: lineHeight, overflow: 'hidden', paddingBottom: '0.14em', marginBottom: '-0.14em' }}>
        <div style={{ color, transform: k < 1 ? `translateY(${(1 - ease.outExpo(k)) * 110}%)` : undefined }}>{children}</div>
      </div>
    );
  };
  return (
    <div style={{ position: 'absolute', left: x, top, width, ...type, fontSize: Math.floor(fit), lineHeight: `${lineHeight}px` }}>
      {line(0, line1, colors.ink)}
      {line(
        1,
        <SwapWords from={from} to={to} progress={swap} toStyle={{ color: colors.accent }} />,
        mixColor(colors.muted, colors.background, 0.15),
      )}
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
