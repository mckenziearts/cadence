// Kinetic type. SplitText, typed and the SwapWords choreography are adapted from saeedvaziry/caleb-video-editor (MIT).
import type { CSSProperties, ReactNode } from 'react';
import { clamp, mix, progress as progressOf } from './animate';
import { mixColor } from './color';
import { ease } from './easing';
import { useKitTheme } from './scene';

type PieceStyle = (index: number, count: number, text: string) => CSSProperties | undefined;

/**
 * Text split into individually styleable pieces (characters or words) for kinetic type.
 * Spaces stay plain text so lines still wrap; indexes skip whitespace.
 */
export function SplitText(props: {
  text: string;
  by?: 'chars' | 'words';
  piece?: PieceStyle;
  style?: CSSProperties;
  className?: string;
}) {
  const { text, by = 'chars', piece } = props;
  const tokens = text.split(/(\s+)/).filter((s) => s.length > 0);
  const words = tokens.filter((s) => !/^\s+$/.test(s));
  const count = by === 'words' ? words.length : words.reduce((n, w) => n + [...w].length, 0);
  let index = 0;
  const children = tokens.map((token, ti) => {
    if (/^\s+$/.test(token)) return token;
    if (by === 'words') {
      const i = index++;
      return (
        <span key={ti} style={{ display: 'inline-block', whiteSpace: 'pre', ...piece?.(i, count, token) }}>
          {token}
        </span>
      );
    }
    return (
      <span key={ti} style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
        {[...token].map((ch, ci) => {
          const i = index++;
          return (
            <span key={ci} style={{ display: 'inline-block', whiteSpace: 'pre', ...piece?.(i, count, ch) }}>
              {ch}
            </span>
          );
        })}
      </span>
    );
  });
  return (
    <span className={props.className} style={props.style}>
      {children}
    </span>
  );
}

/** The first `progress × length` characters of text (typewriter effect). */
export function typed(text: string, progress: number): string {
  const chars = [...text];
  return chars.slice(0, Math.round(clamp(progress) * chars.length)).join('');
}

export interface TextStyle {
  fontSize: number;
  /** CSS font-family, e.g. brand.fonts.display. Required: measuring with the wrong font is a silent bug. */
  fontFamily: string;
  fontWeight?: number | string;
  fontStyle?: 'normal' | 'italic';
  /** CSS letter-spacing: a number is px, or a string such as '-0.045em' or '2px'. */
  letterSpacing?: number | string;
}

function letterSpacingPx(style: TextStyle): number {
  const ls = style.letterSpacing;
  if (typeof ls === 'number') return ls;
  if (!ls || ls === 'normal') return 0;
  const n = parseFloat(ls);
  return ls.endsWith('em') ? n * style.fontSize : n;
}

let measuring: CanvasRenderingContext2D | null = null;

/**
 * Size of one line of text in canvas px (canvas measurement in the browser, the same shaping as the page).
 * Without a DOM (tests, SSR) it returns a deterministic approximation.
 *   const { width } = measureText('Storyboard', { fontSize: 120, fontFamily: brand.fonts.display, fontWeight: 700 })
 */
export function measureText(text: string, style: TextStyle): { width: number; height: number } {
  // CSS letter-spacing is added after every character, the last one included.
  const spacing = letterSpacingPx(style) * [...text].length;
  // Scenes measure while they render: a new canvas per call cost about 27 µs, the shared context about 1 µs.
  const ctx = typeof document === 'undefined' ? null : (measuring ??= document.createElement('canvas').getContext('2d'));
  if (!ctx) {
    let em = 0;
    for (const ch of text) {
      em += ch === ' ' ? 0.28 : /[iljtfr.,:;'!|]/.test(ch) ? 0.3 : /[mwMW@]/.test(ch) ? 0.86 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.55;
    }
    const bold = Number(style.fontWeight ?? 400) >= 600 ? 1.04 : 1;
    return { width: em * style.fontSize * bold + spacing, height: style.fontSize * 1.2 };
  }
  ctx.font = `${style.fontStyle ?? 'normal'} ${style.fontWeight ?? 400} ${style.fontSize}px ${style.fontFamily}`;
  const m = ctx.measureText(text);
  return { width: m.width + spacing, height: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent };
}

export interface TypeOnProps {
  text: string;
  /** 0 to 1. At 1 every character is typed and settled. */
  progress: number;
  /** Final text color (default: inherited; the brand ink when `pendingColor` is set). */
  color?: string;
  /** Color a new character starts from (e.g. a light gray). Without it, new characters fade in by opacity. */
  pendingColor?: string;
  /** How many characters the fade spans (default 2). */
  fade?: number;
  /** Keep the room of untyped characters, so centered text does not shift while typing. */
  reserve?: boolean;
  /** Caret after the last typed character: true or { color (default brand accent), width (px, default 0.05em) }. */
  caret?: boolean | { color?: string; width?: number };
  style?: CSSProperties;
  className?: string;
}

/**
 * Typewriter text: characters appear one by one and fade from `pendingColor` to `color`, with an optional caret.
 * Everything is a pure function of `progress`; blink the caret yourself if you want it: caret={p < 1 || t % 1 < 0.5}.
 */
export function TypeOn({
  text,
  progress,
  color,
  pendingColor,
  fade = 2,
  reserve = false,
  caret = false,
  style,
  className,
}: TypeOnProps) {
  const theme = useKitTheme();
  const finalColor = color ?? (pendingColor ? theme.ink : undefined);
  const chars = [...text];
  const n = chars.length;
  const f = Math.max(fade, 1e-6);
  // Stretch the timeline so the last character has fully settled exactly at progress 1.
  const typedCount = clamp(progress) * (n + Math.max(0, f - 1));
  const shown = Math.min(n, Math.ceil(typedCount));
  const settled = Math.max(0, Math.min(shown, Math.floor(typedCount - f + 1)));
  const caretOptions = caret === true ? {} : caret || null;
  const rootStyle: CSSProperties = { color: finalColor, ...style };

  if (settled === n && !caretOptions) {
    return (
      <span className={className} style={rootStyle}>
        {text}
      </span>
    );
  }
  const fading = chars.slice(settled, shown).map((ch, j) => {
    const k = clamp((typedCount - (settled + j)) / f);
    const charStyle: CSSProperties =
      pendingColor && finalColor ? { color: mixColor(pendingColor, finalColor, ease.outQuad(k)) } : { opacity: mix(0.2, 1, k) };
    return (
      <span key={settled + j} style={charStyle}>
        {ch}
      </span>
    );
  });
  const caretWidth = typeof caretOptions?.width === 'number' ? `${caretOptions.width}px` : '0.05em';
  return (
    <span className={className} style={rootStyle}>
      {chars.slice(0, settled).join('')}
      {fading}
      {caretOptions ? (
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: caretWidth,
            height: '1.1em',
            marginLeft: '0.04em',
            // Zero net advance: showing or hiding the caret never moves the text.
            marginRight: `calc(-1 * (${caretWidth} + 0.04em))`,
            verticalAlign: '-0.2em',
            borderRadius: 999,
            background: caretOptions.color ?? theme.accent,
          }}
        />
      ) : null}
      {reserve && shown < n ? <span style={{ visibility: 'hidden' }}>{chars.slice(shown).join('')}</span> : null}
    </span>
  );
}

export interface SwapWordsProps {
  /** Sentence before the swap. Words shared at the start and end of both sentences stay in place. */
  from: string;
  /** Sentence after the swap. */
  to: string;
  /** 0 to 1 over the whole swap: old words lift away, the line re-centers, new words rise from behind a mask. */
  progress: number;
  /** Style of the outgoing words (keep it equal to the previous swap's `toStyle` when chaining swaps). */
  fromStyle?: CSSProperties;
  /** Style of the incoming words, e.g. { color: brand.colors.accent }. */
  toStyle?: CSSProperties;
  style?: CSSProperties;
  className?: string;
}

/** The mask: open 1em above (outgoing words lift freely), closed 0.3em under the line box (descenders stay visible). */
const SWAP_CLIP = 'inset(-1em -0.15em -0.3em -0.15em)';
/** Incoming words start this far down: fully hidden below the mask. */
const SWAP_RISE = 1.35;

function SwapWord(props: { text: string; open: number; shift: number; fade: number; style?: CSSProperties }) {
  return (
    <span style={{ display: 'inline-grid', gridTemplateColumns: `minmax(0, ${props.open}fr)` }}>
      <span style={{ minWidth: 0, whiteSpace: 'pre', clipPath: SWAP_CLIP }}>
        <span
          style={{
            display: 'inline-block',
            transform: props.shift ? `translateY(${props.shift}em)` : undefined,
            opacity: props.fade,
            ...props.style,
          }}
        >
          {props.text}
        </span>
      </span>
    </span>
  );
}

/**
 * One line of text whose changing words swap (Caleb's running headline), from "Every scene is code." to "Every part in its place".
 * Single line (white-space: nowrap); stack several for multi-line layouts. At progress 0 and 1 it renders plain text.
 */
export function SwapWords({ from, to, progress, fromStyle, toStyle, style, className }: SwapWordsProps) {
  const a = from.split(/\s+/).filter(Boolean);
  const b = to.split(/\s+/).filter(Boolean);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const lead = a.slice(0, pre);
  const tail = a.slice(a.length - suf);
  const out = a.slice(pre, a.length - suf);
  const incoming = b.slice(pre, b.length - suf);
  // The space next to a changing word collapses with it, so the line ends exactly as `to` reads.
  const spaced = (word: string, i: number) => (lead.length ? ` ${word}` : tail.length ? `${word} ` : i === 0 ? word : ` ${word}`);
  const leadText = lead.join(' ');
  const tailText = tail.length ? (lead.length ? ' ' : '') + tail.join(' ') : '';
  const rootStyle: CSSProperties = { whiteSpace: 'nowrap', ...style };
  const p = clamp(progress);

  if (p <= 0 || p >= 1) {
    const words = (p <= 0 ? out : incoming).map(spaced).join('');
    const wordsStyle = p <= 0 ? fromStyle : toStyle;
    return (
      <span className={className} style={rootStyle}>
        {leadText}
        {words && wordsStyle ? <span style={wordsStyle}>{words}</span> : words}
        {tailText}
      </span>
    );
  }
  const width = progressOf(p, 0.14, 0.58, ease.smooth);
  const outStep = out.length > 1 ? Math.min(0.03, 0.06 / (out.length - 1)) : 0;
  const inStep = incoming.length > 1 ? Math.min(0.045, 0.14 / (incoming.length - 1)) : 0;
  return (
    <span className={className} style={rootStyle}>
      {leadText}
      {out.map((word, i) => {
        const gone = progressOf(p, i * outStep, 0.16 + i * outStep, ease.outCubic);
        return (
          <SwapWord
            key={`out${i}`}
            text={spaced(word, i)}
            open={1 - width}
            shift={-0.28 * gone}
            fade={1 - gone}
            style={fromStyle}
          />
        );
      })}
      {incoming.map((word, j) => {
        const start = 0.48 + j * inStep;
        const arrive = progressOf(p, start, start + 0.38, ease.outExpo);
        const shown = progressOf(p, start, start + 0.1);
        return (
          <SwapWord
            key={`in${j}`}
            text={spaced(word, j)}
            open={width}
            shift={SWAP_RISE * (1 - arrive)}
            fade={shown}
            style={toStyle}
          />
        );
      })}
      {tailText}
    </span>
  );
}

export interface CounterProps {
  /** Start value (default 0). */
  from?: number;
  to: number;
  /** 0 to 1 (not clamped: a spring may overshoot on purpose). */
  progress: number;
  /** Default 'fr-FR' (1 234,5 with a narrow no-break space). */
  locale?: string;
  /** Intl.NumberFormat options; default { maximumFractionDigits: 0 }. e.g. { style: 'currency', currency: 'XAF' }. */
  format?: Intl.NumberFormatOptions;
  prefix?: ReactNode;
  suffix?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/** Animated number with tabular digits, formatted with Intl.NumberFormat. */
export function Counter({ from = 0, to, progress, locale = 'fr-FR', format, prefix, suffix, style, className }: CounterProps) {
  const text = new Intl.NumberFormat(locale, format ?? { maximumFractionDigits: 0 }).format(mix(from, to, progress));
  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      {prefix}
      {text}
      {suffix}
    </span>
  );
}
