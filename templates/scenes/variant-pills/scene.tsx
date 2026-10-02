import type { CSSProperties, ReactNode } from 'react';
import {
  clamp,
  ease,
  Fill,
  Layer3D,
  measureText,
  mix,
  progress,
  SwapWords,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Variant pills: under the headline, a row of mono pills names the card's styles; on every beat the pill slides to
// the next one and the card's containers wipe to that style, left to right (Caleb's "Every style").
// First frame: headline `from` + flat card (pose "titled"). Last frame: headline + the same card, back to its first
// style, pills gone (pose "titled").

/** On-screen copy, per brand language. `labels` name the styles of VARIANTS, in order. */
const COPY = {
  fr: {
    from: 'Chaque pièce à sa place',
    headline: 'Chaque style',
    labels: ['Encart', 'Pleine largeur', 'Divisée', 'Séparée', 'Sans bord'],
  },
  en: {
    from: 'Every part in its place',
    headline: 'Every style',
    labels: ['Inset', 'Flush', 'Divided', 'Separated', 'Seamless'],
  },
};

/** Styles shown by the pills (see CardShell), then the order they play in: one change per beat, back to the first. */
const VARIANTS: CardVariant[] = ['inset', 'flush', 'divided', 'separated', 'seamless'];
const SEQUENCE: CardVariant[] = ['inset', 'flush', 'divided', 'separated', 'seamless', 'inset'];

/** Beats from the scene start, except `out`: beats before the end. */
const TIMING = {
  headline: [0, 2], // the headline swaps
  pills: [0.5, 1.5], // the pills rise in
  first: 2, // beat of the first change, then one per beat
  wipe: 0.32, // seconds per change (wipe + pill slide)
  out: [1.5, 0.5], // the pills leave
};

/** Pills: gap under the card and font size, per format. */
const LAYOUT = {
  landscape: { gap: 44, size: 17 },
  portrait: { gap: 64, size: 22 },
  square: { gap: 34, size: 16 },
  '4:5': { gap: 48, size: 19 },
};

export default function VariantPills({ t, duration, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const card = usePoses().titled;
  const copy = COPY[brand.language] ?? COPY.fr;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  // Which change is playing: SEQUENCE[i] to SEQUENCE[i + 1], wiping over `p`.
  const starts = SEQUENCE.slice(1).map((_, i) => b(TIMING.first + i));
  const i = starts.reduce((last, start, k) => (t >= start ? k : last), -1);
  const p = i < 0 ? 0 : progress(t, starts[i], starts[i] + TIMING.wipe, ease.inOutCubic);
  const from = SEQUENCE[Math.max(0, i)];
  const to = SEQUENCE[Math.max(0, i) + (i < 0 ? 0 : 1)];
  const state: CardState = p >= 1 ? { variant: to } : { variant: from, wipe: { to, p } };
  const active = mix(VARIANTS.indexOf(from), VARIANTS.indexOf(to), p);
  const pills =
    progress(t, b(TIMING.pills[0]), b(TIMING.pills[1]), ease.outCubic) *
    (1 - progress(t, end(TIMING.out[0]), end(TIMING.out[1]), ease.inCubic));

  const h = CARD.h * card.s;
  return (
    <Fill>
      <Backdrop />
      <Headline from={copy.from} to={copy.headline} p={progress(t, b(TIMING.headline[0]), b(TIMING.headline[1]))} />
      <ProfileCard pose={card} state={state} />
      {p > 0 && p < 1 ? (
        // The thin accent line riding the wipe.
        <div
          style={{
            position: 'absolute',
            left: card.x + p * CARD.w * card.s - 1,
            top: card.y - 18,
            width: 2,
            height: h + 36,
            borderRadius: 1,
            background: brand.colors.accent,
            boxShadow: `0 0 12px ${withAlpha(brand.colors.accent, 0.5)}`,
            opacity: Math.sin(Math.PI * p),
          }}
        />
      ) : null}
      {pills > 0 ? (
        <Pills
          labels={copy.labels.map((label) => label.toLocaleUpperCase(brand.language))}
          active={active}
          top={Math.round(card.y + h + L.gap)}
          size={L.size}
          show={pills}
        />
      ) : null}
    </Fill>
  );
}

/** Mono labels in a centered row; the ink pill slides and resizes to the active one (`active` may be fractional). */
function Pills({
  labels,
  active,
  top,
  size,
  show,
}: {
  labels: string[];
  active: number;
  top: number;
  size: number;
  show: number;
}) {
  const { colors, fonts } = useBrand();
  const { width } = useFormat();
  const type = { fontFamily: fonts.mono, fontSize: size, fontWeight: 500, letterSpacing: '0.12em' };
  const pad = Math.round(size * 0.95);
  const gap = Math.round(size * 0.35);
  const height = Math.round(size * 2.1);
  const widths = labels.map((label) => Math.ceil(measureText(label, type).width) + 2 * pad);
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * (labels.length - 1);
  const xs = widths.map((_, i) => Math.round((width - total) / 2 + widths.slice(0, i).reduce((sum, w) => sum + w + gap, 0)));
  const a = clamp(Math.floor(active), 0, labels.length - 1);
  const z = clamp(a + 1, 0, labels.length - 1);
  const x = mix(xs[a], xs[z], active - a);
  const w = mix(widths[a], widths[z], active - a);
  // Muted labels, the ink pill, then the same labels in the light color clipped to the pill: crisp while it slides.
  const row = (color: string) =>
    labels.map((label, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: xs[i],
          top: 0,
          width: widths[i],
          height,
          lineHeight: `${height}px`,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          ...type,
          color,
        }}
      >
        {label}
      </div>
    ));
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top,
        width,
        height,
        opacity: show,
        transform: show < 1 ? `translateY(${(1 - show) * 14}px)` : undefined,
      }}
    >
      {row(colors.muted)}
      <div
        style={{ position: 'absolute', left: x, top: 0, width: w, height, borderRadius: height / 2, background: colors.ink }}
      />
      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${width - x - w}px 0 ${x}px round ${height / 2}px)` }}>
        {row(colors.background)}
      </div>
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
