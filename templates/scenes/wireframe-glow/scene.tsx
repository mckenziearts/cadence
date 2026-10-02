import { useId, type CSSProperties, type ReactNode } from 'react';
import {
  clamp,
  DrawPath,
  ease,
  Fill,
  Glow,
  Grain,
  interpolateColor,
  Layer3D,
  measureText,
  mix,
  mixColor,
  progress,
  rectPath,
  Stage3D,
  SwapWords,
  useBrand,
  useFormat,
  Vignette,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Wireframe glow: in the dark, the blueprint of the hero card draws itself in glowing lines, seen at a grazing angle;
// the camera rises to face it, the scene develops to the brand background and the real card lands on its wireframe
// (Caleb's opener).
// First frame: plain darkness. Last frame: the hero card alone, centered (pose "hero").

/** Beats from the scene start. */
const TIMING = {
  draw: [0.3, 7], // the wireframe draws (each shape in turn)
  rise: [0.5, 11.5], // the camera rises from a grazing angle to face the card
  develop: [7.5, 11.5], // darkness to brand background, glowing lines to blueprint lines
  land: [10, 13.5], // the real card builds on the wireframe, layer by layer
};

/** Camera at the start of the rise, per format (degrees, scale; x/y shift the card on the canvas). */
const START = {
  landscape: { rotateX: 66, rotateZ: -26, scale: 1.7, x: -120, y: 160 },
  portrait: { rotateX: 64, rotateZ: -20, scale: 1.5, x: -60, y: 240 },
  square: { rotateX: 64, rotateZ: -24, scale: 1.6, x: -80, y: 160 },
  '4:5': { rotateX: 64, rotateZ: -22, scale: 1.6, x: -80, y: 200 },
};

/** The blueprint, in card px: rounded boxes (x, y, w, h, radius) and text lines as pills, drawn over the real card. */
function shapes(brand: BrandKit): { box: [number, number, number, number, number]; weight: number }[] {
  const xl = brand.radius.xl;
  const md = brand.radius.md;
  const r = (x: number, y: number, w: number, h: number, radius: number, weight = 1) => ({
    box: [x, y, w, h, radius] as [number, number, number, number, number],
    weight,
  });
  return [
    r(0, 0, CARD.w, CARD.h, xl, 1.4),
    r(CARD.inset, CARD.header, CARD.w - 2 * CARD.inset, CARD.h - CARD.header - CARD.inset, Math.max(2, xl - CARD.inset), 1.2),
    r(28, 30, 86, 20, 10, 0.8),
    r(28, 64, 300, 14, 7, 0.7),
    r(586, 34, 26, 10, 5, 0.7),
    r(28, 149, 56, 14, 7, 0.7),
    r(28, 179, 584, 56, md, 1),
    r(46, 199, 128, 16, 8, 0.7),
    r(28, 261, 40, 14, 7, 0.7),
    r(28, 291, 584, 136, md, 1),
    r(46, 309, 212, 14, 7, 0.7),
    r(28, 505, 176, 14, 7, 0.7),
    r(356, 502, 78, 20, 10, 0.7),
    r(462, 486, 150, 52, md, 1),
    r(492, 504, 90, 16, 8, 0.8),
  ];
}

export default function WireframeGlow({ t, width, height, music, brand }: SceneProps) {
  const f = useFormat();
  const card = usePoses().hero;
  const S = f.pick(START);
  const { colors, fonts } = brand;
  const b = (n: number) => music.beat(n);
  const X = (x: number) => card.x + x * card.s;
  const Y = (y: number) => card.y + y * card.s;

  const rise = progress(t, b(TIMING.rise[0]), b(TIMING.rise[1]), ease.smooth);
  const k = 1 - rise;
  const pose = {
    perspective: 1500,
    focus: { x: X(CARD.w / 2), y: Y(CARD.h / 2) },
    rotateX: S.rotateX * k,
    rotateZ: S.rotateZ * k,
    x: S.x * k,
    y: S.y * k,
    scale: 1 + (S.scale - 1) * k,
  };
  const develop = progress(t, b(TIMING.develop[0]), b(TIMING.develop[1]), ease.inOutSine);
  const dark = mixColor(colors.ink, '#000000', 0.6);
  // Lines turn from white to blueprint grey while the background is still mid-dark, so they never vanish.
  const lineColor = interpolateColor(develop, [0.2, 0.55], ['#ffffff', mixColor(colors.ink, colors.background, 0.45)]);
  const land = (i: number) => progress(t, b(TIMING.land[0]) + i * 0.09, b(TIMING.land[0]) + i * 0.09 + 0.5, ease.outCubic);
  const wireOut = progress(t, b(TIMING.land[0]) + 0.3, b(TIMING.land[1]), ease.inOutSine);

  const list = shapes(brand);
  const drawAt = (i: number) => {
    const [d0, d1] = TIMING.draw;
    const start = b(mix(d0, d1 - 2.4, i / (list.length - 1)));
    return progress(t, start, start + b(2.4) - b(0), ease.inOutCubic);
  };
  // Construction lines: the frame's edges and the fields' edges, across the whole canvas.
  const guides = [
    { y: Y(0), at: 0 },
    { y: Y(CARD.h), at: 0.3 },
    { x: X(0), at: 0.15 },
    { x: X(CARD.w), at: 0.45 },
    { y: Y(CARD.header), at: 0.8 },
    { x: X(CARD.pad), at: 1 },
  ];
  const guide = (at: number) => progress(t, b(0.2 + at), b(2.6 + at), ease.inOutCubic);
  // The glow fades out while the scene develops.
  const halo = 1 - progress(develop, 0, 0.5);
  const label = progress(t, b(4), b(5.5), ease.outCubic) * (1 - wireOut);
  const mono: CSSProperties = { fontFamily: fonts.mono, fontSize: 15, letterSpacing: '0.08em' };

  return (
    <Fill style={{ background: interpolateColor(develop, [0, 1], [dark, colors.background]) }}>
      {develop > 0 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: develop }}>
          <Backdrop />
        </div>
      ) : null}
      <Stage3D {...pose}>
        {wireOut < 1 ? (
          <svg
            width={width}
            height={height}
            style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: 1 - wireOut }}
          >
            {guides.map(({ at, ...line }, i) => (
              <GuideLine
                key={i}
                {...line}
                progress={guide(at)}
                color={lineColor}
                opacity={0.35 + 0.15 * (1 - develop)}
                halo={halo}
              />
            ))}
            <Glow color="#ffffff" intensity={0.8 * halo} radius={9}>
              {list.map((s, i) => (
                <DrawPath
                  key={i}
                  d={rectPath(X(s.box[0]), Y(s.box[1]), s.box[2] * card.s, s.box[3] * card.s, s.box[4] * card.s)}
                  progress={drawAt(i)}
                  color={lineColor}
                  width={1.35 * s.weight}
                  opacity={0.95}
                  head={develop < 1 ? { color: '#ffffff', length: 0.08 } : undefined}
                />
              ))}
            </Glow>
            {label > 0 ? (
              <g opacity={label} fill={lineColor} style={mono}>
                <text x={X(CARD.w / 2)} y={Y(0) - 22} textAnchor="middle">
                  {CARD.w}
                </text>
                <text x={X(0) - 22} y={Y(CARD.h / 2)} textAnchor="middle" transform={`rotate(-90 ${X(0) - 22} ${Y(CARD.h / 2)})`}>
                  {CARD.h}
                </text>
              </g>
            ) : null}
          </svg>
        ) : null}
        <ProfileCard
          pose={card}
          state={{
            opacity:
              t >= b(TIMING.land[1])
                ? undefined
                : { surface: land(0), panel: land(1), header: land(2), fields: land(3), footer: land(4), action: land(5) },
          }}
        />
      </Stage3D>
      {develop < 1 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - develop }}>
          <Vignette strength={0.6} size={0.5} />
          <Grain t={t} opacity={0.12} />
        </div>
      ) : null}
    </Fill>
  );
}

/** A guide's halo: [distance from the line / HALO_R, alpha], as <Glow radius={9} intensity={0.8}> painted it. */
const HALO_R = 26;
const HALO: [number, number][] = [
  [0, 0.19],
  [0.08, 0.14],
  [0.19, 0.08],
  [0.38, 0.043],
  [0.69, 0.011],
  [1, 0],
];

/**
 * A construction line across the canvas (`x`: vertical, `y`: horizontal), drawn by `progress`, with a halo painted by
 * a gradient stroke. Not in <Glow>: inside the 3D stage a filter costs with the extent of what it blurs, about 1 s per
 * frame for lines three canvases long.
 */
function GuideLine(props: { x?: number; y?: number; progress: number; color: string; opacity: number; halo: number }) {
  const { x = 0, y, progress, color, opacity, halo } = props;
  const { width, height } = useFormat();
  const id = `guide-${useId().replace(/[^\w-]/g, '')}`;
  const d = y === undefined ? `M${x},${-height}V${2 * height}` : `M${-width},${y}H${2 * width}`;
  // From the line to HALO_R px away; reflected on the other side.
  const across = y === undefined ? { x1: x, x2: x + HALO_R, y1: 0, y2: 0 } : { x1: 0, x2: 0, y1: y, y2: y + HALO_R };
  return (
    <>
      {halo > 0 ? (
        <>
          <defs>
            <linearGradient id={id} gradientUnits="userSpaceOnUse" spreadMethod="reflect" {...across}>
              {HALO.map(([offset, alpha]) => (
                <stop key={offset} offset={offset} stopColor="#ffffff" stopOpacity={alpha * halo} />
              ))}
            </linearGradient>
          </defs>
          <DrawPath d={d} progress={progress} color={`url(#${id})`} width={2 * HALO_R} linecap="butt" />
        </>
      ) : null}
      <DrawPath d={d} progress={progress} color={color} width={1.1} opacity={opacity} />
    </>
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
