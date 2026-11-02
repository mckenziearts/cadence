export type LottieProblem =
  { kind: 'header' } | { kind: 'image'; path: string } | { kind: 'font'; path: string } | { kind: 'file'; path: string };

interface Asset {
  t?: unknown;
  p?: unknown;
  u?: unknown;
  e?: unknown;
  sid?: unknown;
  layers?: unknown;
}

const SLOT_KEYS = new Set(['id', 'nm', 'w', 'h', 'u', 'p', 'e']);
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const objects = (list: unknown) => Array.isArray(list) && list.every((entry) => typeof entry === 'object' && entry !== null);

/**
 * What keeps a Lottie animation out of a scene, checked at upload and by <Lottie>: a header the player cannot read, or
 * an image, font or other file it would fetch. A scene loads nothing from the network, and a path would reach files the
 * project does not hold.
 */
export function lottieProblem(doc: unknown): LottieProblem | null {
  const anim = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null;
  const assets = anim?.assets ?? [];
  const fonts = (anim?.fonts as { list?: unknown } | null | undefined)?.list ?? [];
  const header =
    anim !== null &&
    typeof anim.v === 'string' &&
    ['fr', 'ip', 'op', 'w', 'h'].every((key) => isNumber(anim[key])) &&
    (anim.op as number) - (anim.ip as number) >= 1 &&
    Array.isArray(anim.layers) &&
    objects(assets) &&
    objects(fonts);
  if (!header) return { kind: 'header' };
  // lottie-web fetches the next segment files of the animation itself.
  const segments = anim.segments as { length?: unknown } | null | undefined;
  if (segments && segments.length !== 0) return { kind: 'file', path: 'segments' };
  const slots = anim.slots as Record<string, { p?: unknown } | null | undefined> | null | undefined;
  for (const asset of assets as Asset[]) {
    // A precomp holds layers, and lottie-web loads no file for it, unless an image layer shows it: then it loads its p.
    if (asset.layers && asset.p === undefined && asset.u === undefined && !asset.sid) continue;
    const views: Asset[] = [asset];
    if (asset.sid) {
      const slot = slots?.[String(asset.sid)]?.p;
      // lottie-web assigns the slot onto the asset at each image layer that shows it: a slot that sets a sid or a
      // prototype ("__proto__") would change what the next layer loads.
      if (Object.keys(Object(slot)).some((key) => !SLOT_KEYS.has(key)))
        return { kind: 'file', path: `slots.${String(asset.sid)}` };
      views.push({ ...asset, ...(slot as Asset) });
    }
    for (const { t, p, u, e } of views) {
      // A footage asset is a data file lottie-web fetches, embedded or not.
      if (t === 3) return { kind: 'file', path: String(p ?? u) };
      // lottie-web keeps p as it is only with e set or no u; otherwise it loads u + p, a data: p included.
      const embedded = typeof p === 'string' && p.startsWith('data:');
      if (!embedded || (e !== 1 && u)) return { kind: 'image', path: String(embedded ? u : (p ?? u)) };
    }
  }
  // A font path is a stylesheet, a script or a font file lottie-web adds to the page.
  for (const { fPath } of fonts as { fPath?: unknown }[]) {
    if (fPath) return { kind: 'font', path: String(fPath) };
  }
  return null;
}
