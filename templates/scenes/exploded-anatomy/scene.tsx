import type { CSSProperties, ReactNode } from 'react';
import {
  Callout,
  clamp,
  ease,
  Fill,
  Layer3D,
  measureText,
  mix,
  mixColor,
  progress,
  project3D,
  Stage3D,
  SwapWords,
  useBrand,
  useFormat,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Exploded anatomy: the hero card tilts into 3D, its layers separate and each one gets a drawn callout, then
// everything settles back flat under the headline (Caleb's "Every part in its place").
// First frame: the hero card alone, centered (pose "hero"). Last frame: headline + flat card (pose "titled").

/** On-screen copy, per brand language. `from` is the previous scene's headline ('' = none): the words swap in. */
const COPY = {
  fr: {
    from: '',
    headline: 'Chaque pièce à sa place',
    labels: {
      header: 'En-tête',
      panel: 'Encart',
      footer: 'Pied de carte',
      surface: 'Surface',
      menu: 'Actions',
      fields: 'Champs',
      action: 'Action principale',
    },
  },
  en: {
    from: '',
    headline: 'Every part in its place',
    labels: {
      header: 'Header',
      panel: 'Inset border',
      footer: 'Footer',
      surface: 'Card surface',
      menu: 'Actions',
      fields: 'Fields',
      action: 'Primary action',
    },
  },
};

/** Beats from the scene start (1 beat = 60 / BPM s), except `back` and `flat`: beats before the end. */
const TIMING = {
  headline: [0, 2], // the headline swaps in while the card moves up
  move: [0, 1.6], // hero to titled pose
  tilt: [0.4, 2.2], // the card tilts into 3D
  explode: [1, 2.8], // layers separate
  labels: 1.8, // first callout draws, the others follow every `stagger` s
  stagger: 0.06,
  back: 2.2, // callouts retract, layers collapse
  flat: 0.35, // flat and at rest from here to the end
};

/** 3D pose at full tilt, per format (`spread` multiplies the layer lifts, x/y move the whole stack). */
const STAGE = {
  landscape: { rotateX: 50, rotateZ: -24, scale: 0.94, x: 0, y: 40, spread: 1 },
  portrait: { rotateX: 52, rotateZ: -14, scale: 0.68, x: -130, y: 170, spread: 2.2 },
  square: { rotateX: 56, rotateZ: -10, scale: 0.64, x: 0, y: 70, spread: 1.4 },
  '4:5': { rotateX: 52, rotateZ: -14, scale: 0.66, x: -150, y: 130, spread: 1.8 },
};

type Labels = { sides: 'both' | 'right'; left: number; right: number; gap: number; size: number };

/** Callouts per format: both sides (labels end at `left`, start at `right`) or all on the right; row gap, font size. */
const LABELS: { landscape: Labels; portrait: Labels; square: Labels; '4:5': Labels } = {
  landscape: { sides: 'both', left: 560, right: 1360, gap: 74, size: 22 },
  portrait: { sides: 'right', left: 0, right: 770, gap: 120, size: 28 },
  square: { sides: 'both', left: 250, right: 830, gap: 72, size: 21 },
  '4:5': { sides: 'right', left: 0, right: 770, gap: 104, size: 25 },
};

type LabelKey = keyof (typeof COPY)['fr']['labels'];

/** Where each callout lands on the card (card px) and on which layer, for labels on both sides. */
const ANCHORS: { key: LabelKey; part: CardPart; x: number; y: number; side: 'left' | 'right' }[] = [
  { key: 'header', part: 'header', x: 16, y: 40, side: 'left' },
  { key: 'panel', part: 'panel', x: 6, y: 340, side: 'left' },
  { key: 'footer', part: 'footer', x: 16, y: 512, side: 'left' },
  { key: 'surface', part: 'surface', x: 150, y: 572, side: 'left' },
  { key: 'menu', part: 'header', x: 626, y: 40, side: 'right' },
  { key: 'fields', part: 'fields', x: 612, y: 215, side: 'right' },
  { key: 'action', part: 'action', x: 612, y: 512, side: 'right' },
];

/** The same, all on the right edge (tall formats): fewer labels, no line crosses the card. */
const ANCHORS_RIGHT: typeof ANCHORS = [
  { key: 'header', part: 'header', x: 626, y: 40, side: 'right' },
  { key: 'fields', part: 'fields', x: 612, y: 215, side: 'right' },
  { key: 'panel', part: 'panel', x: 634, y: 380, side: 'right' },
  { key: 'action', part: 'action', x: 612, y: 512, side: 'right' },
  { key: 'surface', part: 'surface', x: 560, y: 572, side: 'right' },
];

export default function ExplodedAnatomy({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const poses = usePoses();
  const S = f.pick(STAGE);
  const C = f.pick(LABELS);
  const copy = COPY[brand.language] ?? COPY.fr;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const move = progress(t, b(TIMING.move[0]), b(TIMING.move[1]), ease.inOutCubic);
  const card = mixPose(poses.hero, poses.titled, move);
  const tilt =
    progress(t, b(TIMING.tilt[0]), b(TIMING.tilt[1]), ease.smooth) *
    (1 - progress(t, end(TIMING.back), end(TIMING.flat), ease.smooth));
  const explode =
    progress(t, b(TIMING.explode[0]), b(TIMING.explode[1]), ease.outExpo) *
    (1 - progress(t, end(TIMING.back), end(TIMING.flat + 0.3), ease.inOutCubic));
  // A slow drift keeps the exploded view alive when the scene is long.
  const drift = progress(t, b(TIMING.tilt[1]), end(TIMING.back), ease.inOutSine);
  const anchors = C.sides === 'right' ? ANCHORS_RIGHT : ANCHORS;
  const stage = (k: number, d: number) => ({
    perspective: 2400,
    focus: { x: card.x + (CARD.w * card.s) / 2, y: card.y + (CARD.h * card.s) / 2 },
    rotateX: S.rotateX * k,
    rotateZ: (S.rotateZ - 4 * d) * k,
    x: S.x * k,
    y: S.y * k,
    scale: 1 - (1 - S.scale) * k,
  });
  const pose = stage(tilt, drift);

  // Labels sit in two columns, evenly spaced around where their anchors land in the full exploded view.
  const rows = labelRows(anchors, poses.titled, stage(1, 0.5), S.spread, C.gap, { width, height });

  return (
    <Fill>
      <Backdrop />
      <Headline from={copy.from} to={copy.headline} p={progress(t, b(TIMING.headline[0]), b(TIMING.headline[1]))} />
      <Stage3D {...pose}>
        <ProfileCard pose={card} lift={explode * S.spread} />
      </Stage3D>
      {anchors.map((a, i) => {
        const start = b(TIMING.labels) + i * TIMING.stagger;
        const shown =
          progress(t, start, start + 0.6) * (1 - progress(t, end(TIMING.back) + i * 0.02, end(TIMING.back) + 0.3 + i * 0.02));
        if (shown <= 0) return null;
        const from = project3D(
          { x: card.x + a.x * card.s, y: card.y + a.y * card.s, z: LIFT[a.part] * explode * S.spread },
          pose,
          { width, height },
        );
        return (
          <Callout
            key={a.key}
            from={from}
            to={{ x: a.side === 'left' ? C.left : C.right, y: rows[a.key] }}
            label={copy.labels[a.key]}
            progress={shown}
            elbow={36}
            labelStyle={{
              fontFamily: brand.fonts.body,
              fontSize: C.size,
              color: mixColor(brand.colors.ink, brand.colors.muted, 0.35),
            }}
          />
        );
      })}
    </Fill>
  );
}

/** Label row (canvas y) per callout: sorted by where the anchors project, spaced by `gap` around their mean. */
function labelRows(
  anchors: typeof ANCHORS,
  card: CardPose,
  pose: Parameters<typeof project3D>[1],
  spread: number,
  gap: number,
  canvas: { width: number; height: number },
): Record<LabelKey, number> {
  const rows = {} as Record<LabelKey, number>;
  for (const side of ['left', 'right'] as const) {
    const items = anchors
      .filter((a) => a.side === side)
      .map((a) => ({
        a,
        y: project3D({ x: card.x + a.x * card.s, y: card.y + a.y * card.s, z: LIFT[a.part] * spread }, pose, canvas).y,
      }))
      .sort((p, q) => p.y - q.y);
    if (!items.length) continue;
    const mean = items.reduce((sum, item) => sum + item.y, 0) / items.length;
    items.forEach((item, i) => (rows[item.a.key] = Math.round(mean + (i - (items.length - 1) / 2) * gap)));
  }
  return rows;
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
