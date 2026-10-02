import type { CSSProperties, ReactNode } from 'react';
import {
  Callout,
  Camera,
  clamp,
  Dimension,
  ease,
  Fill,
  Guide,
  Layer3D,
  measureText,
  mix,
  mixColor,
  progress,
  RadiusArc,
  SwapWords,
  Tag,
  TypeOn,
  useBrand,
  useFormat,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Zoom & annotate: the title types itself while the camera flies into the hero card, three shots measure its
// geometry (concentric corners, one left edge, equal margins) with drawn annotations, then the camera pulls back
// (Caleb's "Impeccable geometry").
// First and last frame: the hero card alone, centered (pose "hero"); the title leaves before the end.

/** On-screen copy, per brand language. */
const COPY = {
  fr: {
    title: 'Une géométrie impeccable',
    corner: 'Rayons concentriques',
    edge: 'Un seul alignement',
    margins: 'Marges égales',
  },
  en: {
    title: 'Impeccable geometry',
    corner: 'Concentric radii',
    edge: 'One left edge',
    margins: 'Equal margins',
  },
};

/** Beats from the scene start, except `out`: beats before the end. Each shot: camera in, annotations, camera leaves. */
const TIMING = {
  title: [1.5, 4], // the title types
  shots: [
    { move: [0.5, 3.5], notes: [3.5, 7.5] }, // corner
    { move: [8, 10.5], notes: [10.5, 14.5] }, // left edge
    { move: [15, 17], notes: [17, 20.5] }, // margins
  ],
  out: [2.6, 0.2], // back to the full card, the title leaves
};

/**
 * Camera shots, per format: `at` = the card point (card px) the shot looks at, `screen` = where that point sits on the
 * canvas, `zoom`. Then the title box (left, top, max width, font size).
 */
const LAYOUT = {
  landscape: {
    shots: [
      { at: { x: 640, y: 572 }, screen: { x: 1480, y: 820 }, zoom: 7 },
      { at: { x: 28, y: 250 }, screen: { x: 620, y: 781 }, zoom: 1.75 },
      { at: { x: 320, y: 286 }, screen: { x: 960, y: 686 }, zoom: 1.22 },
    ],
    title: { x: 140, y: 108, width: 1640, size: 104 },
  },
  portrait: {
    shots: [
      { at: { x: 640, y: 572 }, screen: { x: 820, y: 1250 }, zoom: 5.5 },
      { at: { x: 28, y: 250 }, screen: { x: 260, y: 962 }, zoom: 1.3 },
      { at: { x: 320, y: 286 }, screen: { x: 540, y: 909 }, zoom: 1 },
    ],
    title: { x: 60, y: 250, width: 960, size: 92 },
  },
  square: {
    shots: [
      { at: { x: 640, y: 572 }, screen: { x: 800, y: 800 }, zoom: 6 },
      { at: { x: 28, y: 250 }, screen: { x: 170, y: 580 }, zoom: 1.2 },
      { at: { x: 320, y: 286 }, screen: { x: 540, y: 590 }, zoom: 1 },
    ],
    title: { x: 70, y: 64, width: 940, size: 72 },
  },
  '4:5': {
    shots: [
      { at: { x: 640, y: 572 }, screen: { x: 800, y: 950 }, zoom: 6 },
      { at: { x: 28, y: 250 }, screen: { x: 180, y: 683 }, zoom: 1.3 },
      { at: { x: 320, y: 286 }, screen: { x: 540, y: 710 }, zoom: 1 },
    ],
    title: { x: 70, y: 90, width: 940, size: 80 },
  },
};

export default function ZoomAnnotate({ t, duration, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const card = usePoses().hero;
  const copy = COPY[brand.language] ?? COPY.fr;
  const { colors, radius } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;
  // Card px to canvas px; MID is a height inside the bio field for every kit (the fields sit mid-band).
  const MID = CARD.fieldsEnd - 70;
  const X = (x: number) => card.x + x * card.s;
  const Y = (y: number) => card.y + y * card.s;

  // Camera: rest, shot 1, shot 2, shot 3, rest, zoom interpolated in log space.
  const views = [
    { x: width / 2, y: height / 2, zoom: 1 },
    ...L.shots.map((s) => ({
      x: X(s.at.x) - (s.screen.x - width / 2) / s.zoom,
      y: Y(s.at.y) - (s.screen.y - height / 2) / s.zoom,
      zoom: s.zoom,
    })),
  ];
  const moves = [...TIMING.shots.map((s) => [b(s.move[0]), b(s.move[1])]), [end(TIMING.out[0]), end(TIMING.out[1])]];
  const stops = [0, 1, 2, 3, 0];
  let view = views[0];
  moves.forEach(([start, stop], i) => {
    const k = progress(t, start, stop, ease.inOutCubic);
    if (k <= 0) return;
    const a = views[stops[i]];
    const z = views[stops[i + 1]];
    view = {
      x: mix(a.x, z.x, k),
      y: mix(a.y, z.y, k),
      zoom: Math.exp(mix(Math.log(a.zoom), Math.log(z.zoom), k)),
    };
  });

  // Annotation progress per shot: draw in, then retract as the camera leaves.
  const notes = TIMING.shots.map((s, i) => {
    const leave = i < 2 ? b(TIMING.shots[i + 1].move[0]) : end(TIMING.out[0]);
    return (offset: number) =>
      progress(t, b(s.notes[0]) + offset, b(s.notes[0]) + offset + 0.7, ease.outCubic) *
      (1 - progress(t, leave - 0.35 + offset * 0.2, leave + offset * 0.2, ease.inCubic));
  });
  // How much each shot is on: fades in over the start of its camera move, out over the end of the next one.
  const leaving = (i: number) => (i < 2 ? TIMING.shots[i + 1].move.map(b) : [end(TIMING.out[0]), end(TIMING.out[1])]);
  const shotOf = (i: number) => {
    const [in0, in1] = TIMING.shots[i].move.map(b);
    const [out0, out1] = leaving(i);
    return progress(t, in0, mix(in0, in1, 0.4), ease.inOutSine) * (1 - progress(t, mix(out0, out1, 0.45), out1, ease.inOutSine));
  };
  // Dim what each shot is not about: only the frame and the panel in the corner shot, no footer on the left edge.
  const [s1, s2] = [shotOf(0), shotOf(1)];
  const opacity =
    s1 + s2 <= 0
      ? undefined
      : {
          header: 1 - s1,
          fields: 1 - s1,
          footer: 1 - Math.max(s1, 0.7 * s2),
          action: 1 - Math.max(s1, 0.7 * s2),
        };

  const title = progress(t, b(TIMING.title[0]), b(TIMING.title[1]));
  const titleOut = progress(t, end(TIMING.out[0]), end(TIMING.out[0] - 0.8), ease.inCubic);
  const accent = colors.accent;
  const xl = radius.xl;
  const inner = Math.max(2, xl - CARD.inset);
  // The corner callout reads toward the middle of the canvas.
  const side = L.shots[0].screen.x > width - 400 ? -1 : 1;
  const n1 = notes[0];
  const n2 = notes[1];
  const n3 = notes[2];

  return (
    <Fill>
      <Backdrop />
      <Camera x={view.x} y={view.y} zoom={view.zoom}>
        <ProfileCard pose={card} state={{ opacity }} />
        {/* Shot 1: concentric corners. */}
        <RadiusArc x={X(CARD.w)} y={Y(CARD.h)} r={xl * card.s} corner="bottom-right" label={`r ${xl}`} progress={n1(0)} />
        <RadiusArc
          x={X(CARD.w - CARD.inset)}
          y={Y(CARD.h - CARD.inset)}
          r={inner * card.s}
          corner="bottom-right"
          label={`r ${inner}`}
          extend={-75}
          progress={n1(0.25)}
        />
        <Dimension
          from={{ x: X(CARD.w - CARD.inset), y: Y(CARD.h - 70) }}
          to={{ x: X(CARD.w), y: Y(CARD.h - 70) }}
          label={String(CARD.inset)}
          labelAt="end"
          progress={n1(0.5)}
        />
        <Dimension
          from={{ x: X(CARD.w - 90), y: Y(CARD.h - CARD.inset) }}
          to={{ x: X(CARD.w - 90), y: Y(CARD.h) }}
          label={String(CARD.inset)}
          labelAt="end"
          progress={n1(0.6)}
        />
        <Callout
          from={{ x: X(CARD.w - (1 - Math.SQRT1_2) * xl), y: Y(CARD.h - (1 - Math.SQRT1_2) * xl) }}
          to={{ x: X(CARD.w) + (side * 90) / view.zoom, y: Y(CARD.h - 40) - 50 / view.zoom }}
          label={copy.corner}
          variant="tag"
          elbow={24}
          progress={n1(0.9)}
        />
        {/* Shot 2: one left edge from the title to the footer; the tag sits on the guide, above the card. */}
        <Guide from={{ x: X(CARD.pad), y: Y(-24) }} to={{ x: X(CARD.pad), y: Y(CARD.h - 8) }} progress={n2(0)} />
        <Dimension from={{ x: X(0), y: Y(100) }} to={{ x: X(CARD.pad), y: Y(100) }} label={String(CARD.pad)} progress={n2(0.3)} />
        <Tag x={X(CARD.pad) + 12 / view.zoom} y={Y(-24)} anchor="left" progress={n2(0.6)}>
          {copy.edge}
        </Tag>
        {/* Shot 3: the same margin on both sides of the panel. */}
        {[CARD.pad, CARD.w - CARD.pad].map((x, i) => (
          <Guide key={x} from={{ x: X(x), y: Y(-24) }} to={{ x: X(x), y: Y(CARD.h + 20) }} progress={n3(i * 0.1)} />
        ))}
        <Dimension
          from={{ x: X(CARD.inset), y: Y(MID) }}
          to={{ x: X(CARD.pad), y: Y(MID) }}
          label={String(CARD.pad - CARD.inset)}
          labelAt="start"
          progress={n3(0.3)}
        />
        <Dimension
          from={{ x: X(CARD.w - CARD.pad), y: Y(MID) }}
          to={{ x: X(CARD.w - CARD.inset), y: Y(MID) }}
          label={String(CARD.pad - CARD.inset)}
          labelAt="end"
          progress={n3(0.4)}
        />
        <Tag x={X(CARD.w / 2)} y={Y(-24)} progress={n3(0.7)}>
          {copy.margins}
        </Tag>
      </Camera>
      {title > 0 && titleOut < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: L.title.x,
            top: L.title.y,
            width: L.title.width,
            fontFamily: brand.fonts.display,
            fontWeight: displayWeight(brand),
            fontSize: L.title.size,
            letterSpacing: '-0.03em',
            lineHeight: 1.02,
            color: colors.ink,
            opacity: 1 - titleOut,
            transform: titleOut > 0 ? `translateY(${-titleOut * 30}px)` : undefined,
          }}
        >
          <TypeOn
            text={copy.title}
            progress={title}
            color={colors.ink}
            pendingColor={mixColor(colors.ink, colors.background, 0.75)}
            caret={
              title < 1 || (t < b(TIMING.title[1] + 2) && music.beatPhase(t) < 0.5)
                ? { color: accent, width: Math.round(L.title.size * 0.05) }
                : false
            }
          />
        </div>
      ) : null}
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
