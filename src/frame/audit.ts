// Text checks of a rendered frame for the agent (render_frames): text cut by its container, off the canvas, in the
// safe margins, under the captions or too faint. Capture mode only: the stage sits at 0,0 at scale 1, so client rects
// are canvas px. Reads layout and computed styles; the one write, a sheet that lets hit-tests see click-through text, is
// undone before returning: capture pages render up to 150 frames each.
// Straight from the module, not 'cadence': the frame e2e harness stands in a reduced runtime for it.
import { parseColor, type RGBA } from '../runtime/color';
import type { AuditFinding, AuditKind } from '../shared/frameProtocol';
import { SAFE_AREAS, type FormatSpec } from '../shared/types';

const MAX_FINDINGS = 6;
/** Bounds the walk on scenes that draw thousands of glyphs as separate spans. */
const MAX_TEXT_NODES = 500;
const TEXT_CHARS = 40;
/** Text fading in or out is not judged yet. */
const MIN_OPACITY = 0.95;
/** Small print (legal lines, labels) may sit in the safe margins. Rendered px. */
const SAFE_MIN_FONT = 24;
/** ponytail: elementsFromPoint costs ~0.5 ms on a busy page; text past the 100th checked element gets no contrast check. */
const MAX_CONTRAST_CHECKS = 100;
/** Fainter overlays (a tint, film grain) do not hide the text under them; tints are blended in. */
const MIN_COVER_OPACITY = 0.1;
const REPLACED = ['IMG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED'];
const ORDER: AuditKind[] = ['clipped', 'offCanvas', 'underCaptions', 'contrast', 'outsideSafe'];

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGBA) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** `top` drawn over `bottom`, straight alpha. */
function composite(top: RGBA, bottom: RGBA): RGBA {
  const alpha = top[3] + bottom[3] * (1 - top[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

/** WCAG 2 contrast ratio of a text color, blended over an opaque background first. */
export function contrastRatio(text: RGBA, background: RGBA): number {
  const a = luminance(composite(text, background));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG large text (24 px, or 14 pt and bold) needs 3:1, the rest 4.5:1. */
export function requiredRatio(fontSize: number, fontWeight: number): number {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
}

/** Hidden text first, then the faintest contrast, then the safe margins; equals keep document order. */
export function worstFirst(findings: AuditFinding[]): AuditFinding[] {
  const rank = (f: AuditFinding) => ORDER.indexOf(f.kind);
  const shortfall = (f: AuditFinding) => (f.kind === 'contrast' ? f.ratio! / f.required! : 0);
  return [...findings].sort((a, b) => rank(a) - rank(b) || shortfall(a) - shortfall(b)).slice(0, MAX_FINDINGS);
}

function color(value: string): RGBA | null {
  try {
    return parseColor(value);
  } catch {
    // color(), lab() and the like: no ratio rather than a wrong one.
    return null;
  }
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Inline boxes overhang tight line heights by up to a quarter of the font size: `slack` keeps reveal masks quiet. */
const inside = (box: Box, area: Box, slack: number) =>
  box.left >= area.left - 1 && box.right <= area.right + 1 && box.top >= area.top - slack && box.bottom <= area.bottom + slack;

function union(rects: Box[]): Box {
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

/**
 * What the text's containers up to the stage do to it: where their overflow (or a rounded `inset(0)` clip-path) lets it
 * show and how much their transforms scale it (Camera zooms). Null under any other clip-path or a mask (a wipe reveal):
 * what shows of it cannot be told from boxes.
 */
function containersOf(el: Element, stage: Element): { area: Box; scale: number } | null {
  const area: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  let scale = 1;
  // ponytail: only `transform` in 2D is read: the individual `scale` and `zoom` properties, perspective and translateZ
  // (a Layer3D brought forward renders larger) are not.
  for (let node: Element | null = el; node && node !== stage; node = node.parentElement) {
    const style = getComputedStyle(node);
    const rounded = /^inset\(0(px|%)( round [^)]*)?\)$/.test(style.clipPath);
    if ((style.clipPath !== 'none' && !rounded) || style.maskImage !== 'none') return null;
    // Chromium does not transform inline boxes.
    if (style.transform !== 'none' && style.display !== 'inline') {
      const m = new DOMMatrixReadOnly(style.transform);
      scale *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    }
    const clipX = rounded || style.overflowX !== 'visible';
    const clipY = rounded || style.overflowY !== 'visible';
    if (!clipX && !clipY) continue;
    const r = node.getBoundingClientRect();
    if (clipX) {
      area.left = Math.max(area.left, r.left);
      area.right = Math.min(area.right, r.right);
    }
    if (clipY) {
      area.top = Math.max(area.top, r.top);
      area.bottom = Math.min(area.bottom, r.bottom);
    }
  }
  return { area, scale };
}

/** The background color of a layer that paints nothing else (an svg root is hit over its whole box), else null. */
function veilOf(el: Element): RGBA | null {
  if ((el instanceof SVGElement && !(el instanceof SVGSVGElement)) || REPLACED.includes(el.tagName)) return null;
  const s = getComputedStyle(el);
  if (s.backgroundImage !== 'none' || s.filter !== 'none' || s.backdropFilter !== 'none' || s.mixBlendMode !== 'normal') {
    return null;
  }
  return color(s.backgroundColor);
}

/** Draws something opaque enough to hide what lies under it. */
function paints(el: Element, opacity: number): boolean {
  if (opacity < MIN_COVER_OPACITY) return false;
  if ((el instanceof SVGElement && !(el instanceof SVGSVGElement)) || REPLACED.includes(el.tagName)) return true;
  const s = getComputedStyle(el);
  const fill = color(s.backgroundColor);
  return !fill || fill[3] * opacity >= MIN_COVER_OPACITY || s.backgroundImage !== 'none' || s.backdropFilter !== 'none';
}

/**
 * The text's color against the first opaque background under it, translucent colors under it and faint tints over it
 * blended in. Null when that cannot be told from styles: an image, gradient, svg, canvas, filter or blend lies under the
 * text, something paints over it, or it is outlined or shadowed. Runtime decor (Vignette, Grain) is looked through.
 */
function contrastOf(
  el: Element,
  style: CSSStyleDeclaration,
  rect: DOMRect,
  fontSize: number,
  stage: Element,
  opacityOf: (el: Element) => number,
): { ratio: number; required: number } | null {
  if (el instanceof SVGElement || style.textShadow !== 'none') return null;
  if (style.getPropertyValue('-webkit-text-stroke-width') !== '0px') return null;
  const ink = color(style.getPropertyValue('-webkit-text-fill-color') || style.color);
  if (!ink || ink[3] === 0) return null;
  const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const start = stack.indexOf(el);
  if (start < 0) return null;
  const veils: RGBA[] = [];
  for (const over of stack.slice(0, start)) {
    if (el.contains(over) || over.closest('[data-cadence-decor]')) continue;
    const veil = veilOf(over);
    if (!veil) {
      if (paints(over, opacityOf(over))) return null;
      continue;
    }
    veil[3] *= opacityOf(over);
    veils.push(veil);
  }
  // A backdrop or a frosted card dims what lies under it on purpose: only faint tints are judged through.
  if (1 - veils.reduce((clear, veil) => clear * (1 - veil[3]), 1) >= MIN_COVER_OPACITY) return null;
  const layers: RGBA[] = [];
  let background: RGBA | null = null;
  for (const under of stack.slice(start)) {
    if (!stage.contains(under)) break;
    const fill = under instanceof SVGElement ? null : veilOf(under);
    if (!fill) return null;
    fill[3] *= opacityOf(under);
    if (fill[3] >= 0.995) {
      background = fill;
      break;
    }
    if (fill[3] > 0) layers.push(fill);
  }
  if (!background) return null;
  ink[3] *= opacityOf(el);
  const behind = layers.reduceRight((below, layer) => composite(layer, below), background);
  const veiled = (c: RGBA) => veils.reduceRight((below, veil) => composite(veil, below), c);
  const ratio = contrastRatio(veiled(composite(ink, behind)), veiled(behind));
  const required = requiredRatio(fontSize, Number(style.fontWeight));
  return ratio < required ? { ratio: Math.round(ratio * 100) / 100, required } : null;
}

/** Lets hit-tests reach text and layers under `pointer-events: none` (annotation labels): the property inherits. */
const hitTestSheet = () => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('[data-cadence-stage], [data-cadence-stage] * { pointer-events: auto !important; }');
  return sheet;
};

export function auditStage(stage: HTMLElement, spec: FormatSpec): AuditFinding[] {
  // A copy: the property returns a live array.
  const adopted = [...document.adoptedStyleSheets];
  document.adoptedStyleSheets = [...adopted, hitTestSheet()];
  try {
    return audit(stage, spec);
  } finally {
    document.adoptedStyleSheets = adopted;
  }
}

interface Group {
  kind: AuditKind;
  text: string;
  box: Box;
  /** The box and CSS font size of the text that joined last. */
  last: Box;
  cssSize: number;
  contrast?: { ratio: number; required: number };
}

/**
 * The next word or letter on the group's line: same CSS size (letters popping in at their own scale stay one title),
 * same line, at most a space of one rendered font size after it.
 * ponytail: left-to-right lines only; letters tracked wider than 0.15 em are labelled with spaces between them.
 */
function continues(group: Group, box: Box, cssSize: number, fontSize: number): boolean {
  const height = (b: Box) => b.bottom - b.top;
  const overlap = Math.min(box.bottom, group.last.bottom) - Math.max(box.top, group.last.top);
  const gap = box.left - group.last.right;
  return (
    Math.abs(cssSize - group.cssSize) <= 0.05 * Math.max(cssSize, group.cssSize) &&
    overlap >= Math.min(height(box), height(group.last)) / 2 &&
    gap >= -0.5 * fontSize &&
    gap <= fontSize
  );
}

function audit(stage: HTMLElement, spec: FormatSpec): AuditFinding[] {
  const captions = stage.querySelector('[data-cadence-captions]');
  const captionBoxes = [...(captions?.querySelector('span')?.getClientRects() ?? [])];

  // Text per element, in document order: React splits `{n} items` into several text nodes.
  const texts = new Map<Element, { text: string; rects: DOMRect[] }>();
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(), walked = 0; node && walked < MAX_TEXT_NODES; node = walker.nextNode(), walked++) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue?.trim() || captions?.contains(parent)) continue;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const entry = texts.get(parent);
    if (entry) {
      entry.text += node.nodeValue;
      entry.rects.push(...rects);
    } else texts.set(parent, { text: node.nodeValue, rects });
  }

  const opacities = new Map<Element, number>();
  const opacityOf = (el: Element): number => {
    if (el === stage || !el.parentElement) return 1;
    let value = opacities.get(el);
    if (value === undefined) {
      value = Number(getComputedStyle(el).opacity) * opacityOf(el.parentElement);
      opacities.set(el, value);
    }
    return value;
  };

  const canvas: Box = { left: 0, top: 0, right: spec.width, bottom: spec.height };
  const margins = SAFE_AREAS[spec.id];
  const safe: Box = {
    left: margins.left,
    top: margins.top,
    right: spec.width - margins.right,
    bottom: spec.height - margins.bottom,
  };
  // A title drawn letter by letter or word by word is one finding per kind, not one per span.
  const groups: Group[] = [];
  const lastOf = new Map<AuditKind, Group>();
  let contrastChecks = 0;
  for (const [el, { text, rects }] of texts) {
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible' || opacityOf(el) < MIN_OPACITY) continue;
    const box = union(rects);
    const containers = containersOf(el, stage);
    // Wholly hidden (before a slide-in, behind a reveal mask): nothing on screen to judge.
    if (!containers || !overlaps(box, canvas) || !overlaps(box, containers.area)) continue;
    const { area, scale } = containers;
    const cssSize = parseFloat(style.fontSize);
    const fontSize = cssSize * scale;
    const slack = fontSize * 0.25;
    const add = (kind: AuditKind, contrast?: { ratio: number; required: number }) => {
      const group = lastOf.get(kind);
      if (!group || !continues(group, box, cssSize, fontSize)) {
        const created: Group = { kind, text, box, last: box, cssSize, contrast };
        lastOf.set(kind, created);
        groups.push(created);
        return;
      }
      group.text += (box.left - group.last.right > fontSize * 0.15 ? ' ' : '') + text;
      group.box = union([group.box, box]);
      group.last = box;
      group.cssSize = cssSize;
      if (contrast && contrast.ratio / contrast.required < group.contrast!.ratio / group.contrast!.required) {
        group.contrast = contrast;
      }
    };
    // Clip edges at or past the canvas edge (a scene root, a full-width band) are the canvas edge: offCanvas says it.
    const shown: Box = {
      left: area.left <= 1 ? -Infinity : area.left,
      top: area.top <= 1 ? -Infinity : area.top,
      right: area.right >= spec.width - 1 ? Infinity : area.right,
      bottom: area.bottom >= spec.height - 1 ? Infinity : area.bottom,
    };
    if (!inside(box, shown, slack)) add('clipped');
    if (!inside(box, canvas, slack)) add('offCanvas');
    else if (fontSize >= SAFE_MIN_FONT && !inside(box, safe, slack)) add('outsideSafe');
    if (captionBoxes.some((c) => rects.some((r) => overlaps(r, c)))) add('underCaptions');
    if (contrastChecks++ < MAX_CONTRAST_CHECKS) {
      const contrast = contrastOf(el, style, rects[0], fontSize, stage, opacityOf);
      if (contrast) add('contrast', contrast);
    }
  }
  // Cells of a table or a grid in the same colors are one fix: one finding, which leaves room for the others.
  const sameFix = new Map<string, Group>();
  const merged = groups.filter((group) => {
    if (!group.contrast) return true;
    const key = `${group.contrast.ratio} ${group.contrast.required}`;
    const first = sameFix.get(key);
    if (!first) {
      sameFix.set(key, group);
      return true;
    }
    first.box = union([first.box, group.box]);
    return false;
  });
  const findings = merged.map((group) => ({
    kind: group.kind,
    text: Array.from(group.text.replace(/\s+/g, ' ').trim()).slice(0, TEXT_CHARS).join(''),
    box: {
      x: Math.round(group.box.left),
      y: Math.round(group.box.top),
      width: Math.round(group.box.right - group.box.left),
      height: Math.round(group.box.bottom - group.box.top),
    },
    ...group.contrast,
  }));
  return worstFirst(findings);
}
