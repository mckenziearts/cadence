import type { ReactNode } from 'react';
import {
  ease,
  Fill,
  measureText,
  mixColor,
  progress,
  useBrand,
  useFormat,
  withAlpha,
  type BrandKit,
  type SceneProps,
} from 'cadence';

// Code typing: next to a two-line headline, a dark editor window types a short snippet with syntax colors and a caret,
// then a terminal strip slides up and reports success. Everything leaves on the last beat.
// First and last frame: the plain background.

/** On-screen copy, per brand language. In CODE, `{id}` is the brand id and `{host}` the brand URL (or a placeholder). */
const COPY = {
  fr: {
    lines: ['Une fonction.', 'Et c’est en ligne.'],
    file: 'deploy.ts',
    command: 'npm run deploy',
    done: 'En ligne en 1,2 s',
  },
  en: {
    lines: ['One function.', 'And you’re live.'],
    file: 'deploy.ts',
    command: 'npm run deploy',
    done: 'Live in 1.2 s',
  },
};

/** The snippet (any language with C-like syntax: TS, JS, PHP...). Keep it short: about 40 characters per second. */
const CODE = `import { deploy } from '@{id}/sdk';

const site = await deploy({
  project: 'boutique',
  region: 'eu-west',
});

console.log(site.url); // https://{host}`;

/** Beats from the scene start, except `exit`: beats before the end. */
const TIMING = {
  enter: [0, 2], // headline rises, editor arrives
  type: [2, 8], // the code types
  terminal: [8.3, 9.3], // the terminal strip slides up, then reports
  exit: [0.9, 0], // everything leaves
};

/** Headline box, editor window (left, top, width, height), code size, per format. */
const LAYOUT = {
  landscape: {
    head: { x: 140, y: 540, size: 88, center: true, width: 600 },
    editor: { x: 800, y: 220, w: 980, h: 640 },
    code: 26,
  },
  portrait: { head: { x: 60, y: 250, size: 80, center: false, width: 960 }, editor: { x: 60, y: 500, w: 960, h: 900 }, code: 27 },
  square: { head: { x: 70, y: 90, size: 60, center: false, width: 940 }, editor: { x: 70, y: 290, w: 940, h: 660 }, code: 26 },
  '4:5': { head: { x: 70, y: 120, size: 66, center: false, width: 940 }, editor: { x: 70, y: 340, w: 940, h: 820 }, code: 27 },
};

type Kind = 'plain' | 'keyword' | 'string' | 'number' | 'fn' | 'punct' | 'comment';

export default function CodeTyping({ t, duration, music, brand }: SceneProps) {
  const f = useFormat();
  const L = f.pick(LAYOUT);
  const copy = COPY[brand.language] ?? COPY.fr;
  const { colors, fonts } = brand;
  const b = (n: number) => music.beat(n);
  const end = (n: number) => duration - n * music.beatLength;

  const enter = ease.outExpo(progress(t, b(TIMING.enter[0]) + 0.1, b(TIMING.enter[1])));
  const exit = progress(t, end(TIMING.exit[0]), end(TIMING.exit[1]), ease.inCubic);
  const host = brand.url || (brand.language === 'en' ? 'example.com' : 'exemple.fr');
  const code = CODE.replaceAll('{id}', brand.id).replaceAll('{host}', host);
  const lines = code.split('\n').map(tokenize);
  const total = code.replace(/\n/g, '').length;
  const typed = Math.round(progress(t, b(TIMING.type[0]), b(TIMING.type[1])) * total);
  const typing = typed < total;
  const term = progress(t, b(TIMING.terminal[0]), b(TIMING.terminal[1]), ease.outExpo);
  const done = t >= b(TIMING.terminal[1]) + 0.25;
  const palette = paletteOf(brand);
  const dark = mixColor(colors.ink, '#000000', 0.4);
  let budget = typed;
  let caretPlaced = false;

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
        <Lines lines={copy.lines} p={progress(t, b(TIMING.enter[0]), b(TIMING.enter[1]))} {...L.head} />
        <div
          style={{
            position: 'absolute',
            left: L.editor.x,
            top: L.editor.y,
            width: L.editor.w,
            height: L.editor.h,
            borderRadius: brand.radius.xl,
            overflow: 'hidden',
            background: dark,
            boxShadow: `0 0 0 1px ${withAlpha('#ffffff', 0.08)}, 0 40px 90px ${withAlpha(colors.ink, 0.28)}`,
            opacity: Math.min(1, enter * 1.5),
            transform: enter < 1 ? `translateY(${(1 - enter) * 60}px)` : undefined,
          }}
        >
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '0 22px',
              borderBottom: `1px solid ${withAlpha('#ffffff', 0.07)}`,
            }}
          >
            {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
              <span key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
            ))}
            <span
              style={{
                marginLeft: 18,
                padding: '6px 14px',
                borderRadius: 8,
                background: withAlpha('#ffffff', 0.07),
                fontFamily: fonts.mono,
                fontSize: 17,
                color: withAlpha('#ffffff', 0.75),
              }}
            >
              {copy.file}
            </span>
          </div>
          <div style={{ padding: '30px 0', fontFamily: fonts.mono, fontSize: L.code, lineHeight: 1.62, whiteSpace: 'pre' }}>
            {lines.map((tokens, li) => {
              const parts: ReactNode[] = [];
              tokens.forEach(([text, kind], ti) => {
                const shown = text.slice(0, Math.max(0, budget));
                budget -= text.length;
                if (shown)
                  parts.push(
                    <span key={ti} style={{ color: palette[kind], fontStyle: kind === 'comment' ? 'italic' : undefined }}>
                      {shown}
                    </span>,
                  );
              });
              const caretHere = typing && !caretPlaced && budget < 0;
              if (caretHere) caretPlaced = true;
              const lastLine = li === lines.length - 1;
              const idle = !typing && lastLine && music.beatPhase(t) < 0.5 && term === 0;
              return (
                <div key={li} style={{ display: 'flex' }}>
                  <span
                    style={{ width: 70, flex: 'none', paddingRight: 24, textAlign: 'right', color: withAlpha('#ffffff', 0.25) }}
                  >
                    {li + 1}
                  </span>
                  <span>
                    {parts}
                    {caretHere || idle ? <Caret color={colors.accent} /> : null}
                  </span>
                </div>
              );
            })}
          </div>
          {term > 0 ? (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 150,
                padding: '24px 34px',
                boxSizing: 'border-box',
                background: mixColor(dark, '#000000', 0.35),
                borderTop: `1px solid ${withAlpha('#ffffff', 0.08)}`,
                transform: `translateY(${(1 - term) * 100}%)`,
                fontFamily: fonts.mono,
                fontSize: L.code - 3,
                lineHeight: 1.7,
              }}
            >
              <div style={{ color: withAlpha('#ffffff', 0.8) }}>
                <span style={{ color: palette.fn }}>$</span> {copy.command}
              </div>
              <div style={{ color: palette.string, opacity: done ? 1 : 0.55 }}>
                {done ? '✓' : '…'} {done ? copy.done : ''}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Fill>
  );
}

/** A steady text caret with no layout width. */
function Caret({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 3,
        height: '1.15em',
        margin: '0 -1.5px',
        verticalAlign: '-0.2em',
        borderRadius: 2,
        background: color,
      }}
    />
  );
}

/** Syntax colors readable on the dark editor, from the brand's accent, success and warning colors. */
function paletteOf(brand: BrandKit): Record<Kind, string> {
  const light = (c: string, k: number) => mixColor(c, '#ffffff', k);
  return {
    plain: '#e8e8ec',
    keyword: light(brand.colors.accent, 0.3),
    string: light(brand.colors.success, 0.35),
    number: light(brand.colors.accent, 0.5),
    fn: light(brand.colors.warning, 0.25),
    punct: '#9d9da6',
    comment: '#6f6f7a',
  };
}

const KEYWORDS =
  /^(import|from|export|default|const|let|var|await|async|return|function|new|if|else|for|of|in|class|extends|use|public|private|protected|static|fn|echo|namespace|true|false|null)$/;

/** Minimal C-like tokenizer: comments, strings, numbers, keywords, calls, punctuation. */
function tokenize(line: string): [string, Kind][] {
  const out: [string, Kind][] = [];
  const re =
    /(\/\/.*$|#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>+\-*/!?&|@]+)|(\s+)/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(line))) {
    const [text, comment, string, number, word, punct] = m;
    const next = line.slice(re.lastIndex).trimStart();
    const kind: Kind = comment
      ? 'comment'
      : string
        ? 'string'
        : number
          ? 'number'
          : word
            ? KEYWORDS.test(word)
              ? 'keyword'
              : next.startsWith('(')
                ? 'fn'
                : 'plain'
            : punct
              ? 'punct'
              : 'plain';
    out.push([text, kind]);
    last = re.lastIndex;
  }
  if (last < line.length) out.push([line.slice(last), 'plain']);
  return out;
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
