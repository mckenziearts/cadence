// Color parsing and perceptual mixing. OKLab math: Björn Ottosson, https://bottosson.github.io/posts/oklab/
// Hex/rgb parsing and the rgba() output are adapted from saeedvaziry/caleb-video-editor (MIT).
import { interpolate, type InterpolateOptions } from './animate';

/** [r, g, b, a]: channels 0..255 (not rounded), alpha 0..1. */
export type RGBA = [number, number, number, number];

const NAMED: Record<string, RGBA> = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
};

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(%|deg|rad|grad|turn)?$/;

function unsupported(input: string): Error {
  return new Error(
    `Unsupported color "${input}": use #rgb, #rrggbb, #rrggbbaa, rgb(), hsl(), oklch(), oklab(), transparent, black or white`,
  );
}

const clampTo = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb[a](), hsl[a](), oklch(), oklab(), transparent, black, white. */
export function parseColor(input: string): RGBA {
  const s = input.trim().toLowerCase();
  if (Object.hasOwn(NAMED, s)) return [...NAMED[s]];
  if (s.startsWith('#')) {
    if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) throw unsupported(input);
    let hex = s.slice(1);
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    const num = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [num(0), num(2), num(4), hex.length === 8 ? num(6) / 255 : 1];
  }
  const m = /^(rgba?|hsla?|oklch|oklab)\(([^()]*)\)$/.exec(s);
  if (!m) throw unsupported(input);
  const parts = m[2].trim().split(/\s*[,/]\s*|\s+/);
  if (parts.length !== 3 && parts.length !== 4) throw unsupported(input);
  const values = parts.map((part) => {
    if (part === 'none') return { n: 0, unit: '' };
    const u = NUMBER.exec(part);
    if (!u) throw unsupported(input);
    return { n: parseFloat(part), unit: u[1] ?? '' };
  });
  const [p0, p1, p2, pa] = values;
  const alpha = pa === undefined ? 1 : clampTo(pa.unit === '%' ? pa.n / 100 : pa.n, 1);
  const angle = (v: { n: number; unit: string }) =>
    v.unit === 'rad' ? (v.n * 180) / Math.PI : v.unit === 'grad' ? v.n * 0.9 : v.unit === 'turn' ? v.n * 360 : v.n;
  const lightness = (v: { n: number; unit: string }) => (v.unit === '%' ? v.n / 100 : v.n);
  const chroma = (v: { n: number; unit: string }) => (v.unit === '%' ? (v.n / 100) * 0.4 : v.n);
  let rgb: [number, number, number];
  if (m[1].startsWith('rgb')) {
    const channel = (v: { n: number; unit: string }) => (v.unit === '%' ? (v.n / 100) * 255 : v.n);
    rgb = [channel(p0), channel(p1), channel(p2)];
  } else if (m[1].startsWith('hsl')) {
    rgb = hslToRgb(angle(p0), p1.n / 100, p2.n / 100);
  } else if (m[1] === 'oklch') {
    const h = (angle(p2) * Math.PI) / 180;
    const c = Math.max(0, chroma(p1));
    rgb = oklabToRgb([lightness(p0), c * Math.cos(h), c * Math.sin(h)]);
  } else {
    rgb = oklabToRgb([lightness(p0), chroma(p1), chroma(p2)]);
  }
  return [clampTo(rgb[0], 255), clampTo(rgb[1], 255), clampTo(rgb[2], 255), alpha];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s = clampTo(s, 1);
  l = clampTo(l, 1);
  const f = (n: number) => {
    const k = (((n + h / 30) % 12) + 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055) * 255;

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** OKLab with premultiplied alpha, so fading from/to `transparent` never passes through gray. */
function toPremultipliedLab(color: string): RGBA {
  const [r, g, b, a] = parseColor(color);
  const [L, A, B] = rgbToOklab(r, g, b);
  return [L * a, A * a, B * a, a];
}

function fromPremultipliedLab([L, A, B, alpha]: RGBA): RGBA {
  if (alpha <= 0) return [0, 0, 0, 0];
  return [...oklabToRgb([L / alpha, A / alpha, B / alpha]), alpha];
}

function format([r, g, b, a]: RGBA): string {
  const c = (v: number) => Math.round(clampTo(v, 255));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(clampTo(a, 1) * 1000) / 1000})`;
}

/** '#rrggbb', or '#rrggbbaa' when the color is not opaque. */
export function toHex(color: string): string {
  const [r, g, b, a] = parseColor(color);
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  const alpha = Math.round(a * 255);
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha === 255 ? '' : hex(alpha)}`;
}

/** Blend two colors in OKLab (a at p = 0, b at p = 1). Returns `rgba(r, g, b, a)`. */
export function mixColor(a: string, b: string, p: number): string {
  const ca = toPremultipliedLab(a);
  const cb = toPremultipliedLab(b);
  return format(fromPremultipliedLab(ca.map((v, i) => v + (cb[i] - v) * p) as RGBA));
}

/** Like interpolate(), but the outputs are colors (mixed in OKLab). Returns `rgba(r, g, b, a)`. */
export function interpolateColor(
  t: number,
  input: readonly number[],
  colors: readonly string[],
  options: InterpolateOptions = {},
): string {
  const labs = colors.map(toPremultipliedLab);
  return format(
    fromPremultipliedLab(
      [0, 1, 2, 3].map((ch) =>
        interpolate(
          t,
          input,
          labs.map((c) => c[ch]),
          options,
        ),
      ) as RGBA,
    ),
  );
}

/** The color with its alpha multiplied by `alpha` (opaque colors get exactly `alpha`). Returns `rgba(r, g, b, a)`. */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b, a] = parseColor(color);
  return format([r, g, b, a * alpha]);
}
