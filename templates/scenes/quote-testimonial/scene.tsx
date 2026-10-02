import type { ReactNode } from 'react';
import {
  ease,
  Fill,
  measureText,
  mixColor,
  progress,
  spring,
  springs,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Quote testimonial: a large quotation mark pops, the quote lights up word by word as if read aloud, a marker
// underlines its key phrase, then the author slides in. Everything leaves on the last beat.
// First and last frame: the plain background.

/** On-screen copy, per brand language. `{name}` = the brand name; `highlight` must appear in the quote; `mark` is the big quotation mark above it. */
const COPY = {
  fr: {
    mark: '«',
    quote: 'Avec {name}, on a divisé par deux le temps passé sur nos rapports. Toute l’équipe l’a adopté en une semaine.',
    highlight: 'divisé par deux',
    author: 'Camille Durand',
    role: 'Directrice des opérations',
  },
  en: {
    mark: '“',
    quote: 'With {name}, we cut the time spent on reports in half. The whole team adopted it within a week.',
    highlight: 'in half',
    author: 'Camille Durand',
    role: 'Head of Operations',
  },
};

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  mark: 0, // the quotation mark pops
  read: [0.4, 4], // words light up, in reading order
  marker: [3.6, 4.6], // the key phrase gets its marker
  author: [4, 5], // the author slides in
  exit: [0.9, 0], // everything leaves
};

/** Quote size and width, quotation mark size, author size, per format. */
const LAYOUT = {
  landscape: { size: 62, width: 1440, mark: 170, author: 26 },
  portrait: { size: 64, width: 920, mark: 180, author: 30 },
  square: { size: 54, width: 940, mark: 140, author: 25 },
  '4:5': { size: 54, width: 920, mark: 150, author: 26 },
};

export default function QuoteTestimonial({ t, duration, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const copy = COPY[brand.language] ?? COPY.fr;
  const { ui, colors, fonts, Logo } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const quote = copy.quote.replace('{name}', brand.name);
  const words = splitWords(quote);
  const mark = settle(t < b(TIMING.mark) ? 0 : spring(t - b(TIMING.mark), { from: 0, to: 1, ...springs.snappy }));
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  // The dim quote fades in first, so the first frame is the plain background.
  const enter = progress(t, b(TIMING.mark), b(TIMING.read[0]) + 0.1, ease.outCubic);
  const each = (b(TIMING.read[1]) - b(TIMING.read[0])) / Math.max(1, words.length);
  const marker = progress(t, b(TIMING.marker[0]), b(TIMING.marker[1]), ease.inOutCubic);
  const author = ease.outExpo(progress(t, b(TIMING.author[0]), b(TIMING.author[1])));
  const dim = mixColor(colors.ink, colors.background, 0.84);
  // Which words belong to the highlighted phrase.
  const key = splitWords(copy.highlight);
  const start = words.findIndex((_, i) =>
    key.every((w, j) => words[i + j]?.replace(/[.,;:!?\u00a0]/g, '') === w.replace(/[.,;:!?\u00a0]/g, '')),
  );
  const inKey = (i: number) => start >= 0 && i >= start && i < start + key.length;
  // The marker sweeps the phrase left to right, one word after another.
  const swept = (i: number) => Math.min(1, Math.max(0, marker * key.length - (i - start)));
  const type = { fontFamily: fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.025em' };
  const size = Math.floor(
    Math.min(L.size, (L.size * L.width * 3.2) / measureText(words.join(' '), { ...type, fontSize: L.size }).width),
  );

  return (
    <Fill>
      <Backdrop />
      <Fill
        center
        style={{
          flexDirection: 'column',
          gap: 44,
          opacity: enter * (1 - exit),
          transform: exit > 0 ? `translateY(${-exit * 30}px)` : undefined,
        }}
      >
        <div
          style={{
            height: Math.round(L.mark * 0.62),
            marginTop: -Math.round(L.mark * 0.08),
            fontFamily: fonts.display,
            fontSize: L.mark,
            fontWeight: displayWeight(brand),
            lineHeight: 1,
            color: colors.accent,
            opacity: Math.min(1, mark * 2),
            transform: `scale(${mark})`,
          }}
        >
          {copy.mark}
        </div>
        <div style={{ width: L.width, textAlign: 'center', ...type, fontSize: size, lineHeight: 1.18, color: colors.ink }}>
          {words.map((word, i) => {
            const lit = ease.outCubic(progress(t, b(TIMING.read[0]) + i * each, b(TIMING.read[0]) + i * each + 0.3));
            const first = inKey(i) && !inKey(i - 1);
            const last = inKey(i) && !inKey(i + 1);
            return (
              <span key={i}>
                {i > 0 ? inKey(i) && !first ? <Marker p={swept(i) > 0 ? 1 : 0}> </Marker> : ' ' : null}
                {inKey(i) ? (
                  <Marker p={swept(i)} round={first ? 'left' : last ? 'right' : undefined}>
                    <span style={{ color: mixColor(dim, colors.ink, lit) }}>{word}</span>
                  </Marker>
                ) : (
                  <span style={{ color: mixColor(dim, colors.ink, lit) }}>{word}</span>
                )}
              </span>
            );
          })}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            opacity: author,
            transform: author < 1 ? `translateY(${(1 - author) * 24}px)` : undefined,
            fontFamily: fonts.body,
          }}
        >
          <ui.Avatar name={copy.author} size={Math.round(L.author * 2.4)} />
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: L.author, fontWeight: 600, color: colors.ink }}>{copy.author}</div>
            <div style={{ marginTop: 2, fontSize: Math.round(L.author * 0.82), color: colors.muted }}>{copy.role}</div>
          </div>
          <div style={{ width: 1, height: L.author * 2, margin: '0 10px', background: colors.line }} />
          <Logo variant="mark" height={Math.round(L.author * 1.9)} />
        </div>
      </Fill>
    </Fill>
  );
}

/** Highlighter stroke behind a run of text, growing from left to right with `p`. */
function Marker({ p, round, children }: { p: number; round?: 'left' | 'right'; children: ReactNode }) {
  const { colors } = useBrand();
  const c = withAlpha(colors.accent, 0.3);
  return (
    <span
      style={{
        backgroundImage: `linear-gradient(${c}, ${c})`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '0 92%',
        backgroundSize: `${p * 100}% 0.5em`,
        borderRadius: round === 'left' ? '0.1em 0 0 0.1em' : round === 'right' ? '0 0.1em 0.1em 0' : undefined,
      }}
    >
      {children}
    </span>
  );
}

/** Words, keeping French punctuation with its word (never a line break before « ? » or after « «). */
function splitWords(text: string): string[] {
  return text.split(/ (?![?!:;»”])(?<![«“])/).map((word) => word.replace(/ /g, '\u00a0'));
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
