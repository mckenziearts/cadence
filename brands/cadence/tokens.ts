// Cadence preset (the neutral default): brand.json, the extra greys of the reference look, and the helpers the kit
// shares. Every brand folder carries its own copy of these helpers so a preset can be copied and edited on its own.
import type { BrandFile } from '../../src/shared/types';
import file from './brand.json';

export const brand = file as BrandFile;
export const { colors, fonts, radius } = brand;

/** Neutrals of the reference look (zinc family), used inside cards and controls. */
export const tone = {
  chip: '#f4f4f5',
  chipInk: '#52525b',
  inset: '#fafafa',
  insetLine: '#e7e7ea',
  text: '#3f3f46',
  hint: '#a1a1aa',
  border: '#e4e4e7',
  hover: '#27272a',
  pressed: '#09090b',
  /** Playhead / active-time blue: timelines only. */
  blue: '#3b82f6',
};

export const shadow = {
  xs: '0 1px 2px rgba(0, 0, 0, 0.05)',
  card: '0 1px 2px rgba(0, 0, 0, 0.05), 0 24px 60px rgba(0, 0, 0, 0.08)',
  lifted: '0 2px 4px rgba(0, 0, 0, 0.04), 0 40px 90px rgba(0, 0, 0, 0.14)',
};

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const mix = (from: number, to: number, p: number) => from + (to - from) * p;
/** CSS color between `from` (p = 0) and `to` (p = 1), mixed in OKLab like the runtime color helpers. */
export const blend = (from: string, to: string, p: number) =>
  p <= 0 ? from : p >= 1 ? to : `color-mix(in oklab, ${to} ${+(p * 100).toFixed(2)}%, ${from})`;
/** `#rrggbb` with an alpha channel. */
export const alpha = (hex: string, a: number) =>
  `${hex}${Math.round(clamp(a) * 255)
    .toString(16)
    .padStart(2, '0')}`;
/** A boolean or 0..1 state as 0..1 (a fraction animates the state). */
export const level = (state: boolean | number | undefined) => (typeof state === 'number' ? clamp(state) : state ? 1 : 0);

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const first = Array.from(words[0] ?? '?')[0] ?? '?';
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Stable index for `name` in a list of `size` items (avatar colors). */
export function pick(name: string, size: number): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % size;
}
