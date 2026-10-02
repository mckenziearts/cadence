import {
  ease,
  Fill,
  measureText,
  mixColor,
  progress,
  spring,
  springs,
  SwapWords,
  useBrand,
  useFormat,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Title reveal: the brand mark pops, the headline rises word by word from a mask, the subline arrives and swaps to a
// second line on the next bar; everything lifts away on the last beat.
// First and last frame: the plain background.

/**
 * On-screen copy. null = the brand's own copy: the tagline as headline, the next taglines as sublines. Set strings
 * to override, e.g. { headline: 'Nouveautés de septembre', sublines: ['Trois nouveautés', 'Un seul clic'] }.
 */
const COPY: { headline: string | null; sublines: string[] | null } = { headline: null, sublines: null };

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  mark: 0, // the mark pops
  words: [0.4, 2.4], // headline words rise, one after another
  subline: [2, 3], // the subline arrives
  swap: [4, 5.4], // the subline swaps (lands just after the bar)
  exit: [0.9, 0], // everything lifts away (set to [0, 0] to hold the last frame)
};

/** Mark height, headline size and max width, subline size, per format. */
const LAYOUT = {
  landscape: { mark: 84, size: 124, width: 1480, sub: 40, gap: 44 },
  portrait: { mark: 96, size: 112, width: 900, sub: 42, gap: 48 },
  square: { mark: 76, size: 92, width: 900, sub: 34, gap: 36 },
  '4:5': { mark: 84, size: 100, width: 900, sub: 36, gap: 40 },
};

export default function TitleReveal({ t, duration, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const { colors, fonts, Logo } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;
  const { headline, sublines } = copyOf(brand);

  const pop = t < b(TIMING.mark) ? 0 : spring(t - b(TIMING.mark), { from: 0, to: 1, ...springs.snappy });
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const sub = progress(t, b(TIMING.subline[0]), b(TIMING.subline[1]), ease.outCubic);
  const swap = sublines.length > 1 ? progress(t, b(TIMING.swap[0]), b(TIMING.swap[1])) : 0;
  const subType = { fontFamily: fonts.body, fontSize: L.sub };
  const subSize = Math.floor(Math.min(L.sub, ...sublines.map((line) => (L.sub * L.width) / measureText(line, subType).width)));

  // Headline: at most two balanced lines, sized down only if a line is too wide.
  const type = { fontFamily: fonts.display, fontWeight: displayWeight(brand), letterSpacing: '-0.035em' };
  const lines = balance(headline, (text) => measureText(text, { ...type, fontSize: L.size }).width, L.width);
  const widest = Math.max(...lines.map((line) => measureText(line, { ...type, fontSize: L.size }).width));
  const size = Math.floor(Math.min(L.size, (L.size * L.width) / widest));
  const words = lines.map(splitWords);
  const count = words.flat().length;
  const each = count > 1 ? (b(TIMING.words[1]) - b(TIMING.words[0]) - 0.7) / (count - 1) : 0;
  let index = 0;

  return (
    <Fill>
      <Backdrop />
      <Fill
        center
        style={{
          flexDirection: 'column',
          gap: L.gap,
          opacity: 1 - exit,
          transform: exit > 0 ? `translateY(${-exit * 40}px)` : undefined,
        }}
      >
        <div style={{ transform: `scale(${pop})`, opacity: Math.min(1, pop * 2) }}>
          <Logo variant="mark" height={L.mark} />
        </div>
        <div style={{ ...type, fontSize: size, lineHeight: 1.04, color: colors.ink, textAlign: 'center' }}>
          {words.map((line, li) => (
            <div key={li} style={{ whiteSpace: 'nowrap' }}>
              {line.map((word, wi) => {
                const start = b(TIMING.words[0]) + index++ * each;
                const k = ease.outExpo(progress(t, start, start + 0.7));
                return (
                  <span key={wi}>
                    {wi > 0 ? ' ' : null}
                    <span
                      style={{
                        display: 'inline-block',
                        overflow: 'hidden',
                        verticalAlign: 'top',
                        paddingBottom: '0.12em',
                        marginBottom: '-0.12em',
                      }}
                    >
                      <span style={{ display: 'inline-block', transform: k < 1 ? `translateY(${(1 - k) * 105}%)` : undefined }}>
                        {word}
                      </span>
                    </span>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        {sublines.length ? (
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: subSize,
              lineHeight: 1,
              color: mixColor(colors.muted, colors.ink, 0.15),
              opacity: sub,
              transform: sub < 1 ? `translateY(${(1 - sub) * 18}px)` : undefined,
            }}
          >
            <SwapWords from={sublines[0]} to={sublines[1] ?? sublines[0]} progress={swap} toStyle={{ color: colors.ink }} />
          </div>
        ) : null}
      </Fill>
    </Fill>
  );
}

/** The copy to show: COPY when set, else the brand's tagline and taglines. */
function copyOf(brand: BrandKit): { headline: string; sublines: string[] } {
  // A subline reads in one glance: the brand's other taglines, the short ones first.
  const taglines = brand.copy.taglines.filter((line) => line !== brand.tagline);
  const short = [...taglines.filter((line) => line.length <= 48), ...taglines.filter((line) => line.length > 48)];
  return {
    headline: COPY.headline ?? brand.tagline ?? brand.name,
    sublines: COPY.sublines ?? short.slice(0, 2),
  };
}

/** Words, keeping French punctuation with its word (« Combien ai-je ? » never breaks before the « ? »). */
function splitWords(text: string): string[] {
  return text.split(/ (?![?!:;»])(?<!«)/).map((word) => word.replace(/ /g, '\u00a0'));
}

/** One line if it fits, else two lines split where their widths are the most even. */
function balance(text: string, measure: (text: string) => number, max: number): string[] {
  if (measure(text) <= max) return [text];
  const words = splitWords(text);
  let best = [text];
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const z = words.slice(i).join(' ');
    const s = Math.max(measure(a), measure(z));
    if (s < score) [best, score] = [[a, z], s];
  }
  return best;
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
