// Brand panel: colors, fonts, live kit components, extras and copy of the project's brand. The kit is brand code, maybe
// written by the brand builder: it renders in kit.html iframes on the frame origin, never in the editor page and its token.
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KitFontFace, KitToEditor } from '../../shared/frameProtocol';
import type { BrandFile } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { useStore } from '../store';
import { copyText } from '../store/ui';
import { SectionTitle, Spinner } from './ui';
import { useAgentName } from './agents';

const COLORS: (keyof BrandFile['colors'])[] = [
  'background',
  'surface',
  'ink',
  'muted',
  'line',
  'primary',
  'primaryInk',
  'accent',
  'success',
  'warning',
  'danger',
];

type KitInfo = Extract<KitToEditor, { type: 'kit' }>;

export function BrandPanel({ brandId }: { brandId: string }) {
  const texts = useT().production.brand;
  const agent = useAgentName();
  const frameOrigin = useStore((s) => s.app?.frameOrigin ?? '');
  const [brand, setBrand] = useState<BrandFile | null>(null);
  const [kit, setKit] = useState<KitInfo | null>(null);
  const [kitError, setKitError] = useState<string | null>(null);

  useEffect(() => {
    if (brand && kit) addBrandFonts(brand, kit.fonts, frameOrigin);
  }, [brand, kit, frameOrigin]);

  useEffect(() => {
    let live = true;
    api
      .brand(brandId)
      .then((b) => live && setBrand(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [brandId]);

  if (!brand) {
    return (
      <div className="grid h-40 place-items-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="max-h-[min(720px,calc(100vh-80px))] overflow-y-auto">
      <div className="border-b border-rule px-4 pt-4 pb-3.5" style={{ background: brand.colors.background }}>
        <img
          src={api.logoUrl(brandId, 'full')}
          alt={brand.name}
          className="h-7 w-auto max-w-[260px] object-contain object-left"
        />
        <p className="mt-2.5 text-[13px] font-medium" style={{ color: brand.colors.ink }}>
          {brand.tagline}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: brand.colors.muted }}>
          {brand.url ? `${brand.url.replace(/^https?:\/\//, '')} · ` : ''}
          {texts.written[brand.language]}
        </p>
      </div>
      <div className="space-y-5 px-4 py-4">
        <section className="space-y-2">
          <SectionTitle>{texts.colors}</SectionTitle>
          <div className="grid grid-cols-4 gap-2">
            {COLORS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => void copyText(brand.colors[key], texts.colorCopied(brand.colors[key]))}
                className="focus-ring group rounded-lg text-left"
                title={texts.copyColor(brand.colors[key], key)}
              >
                <span
                  className="block h-9 rounded-lg ring-1 ring-black/10 ring-inset"
                  style={{ background: brand.colors[key] }}
                />
                <span className="mt-1 block truncate text-[11px] font-medium text-ink-2">{texts.colorNames[key]}</span>
                <span className="block font-mono text-[10px] text-ink-4 uppercase group-hover:text-ink-2">
                  {brand.colors[key]}
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="space-y-2">
          <SectionTitle>{texts.fonts}</SectionTitle>
          <div className="divide-y divide-rule rounded-xl ring-1 ring-rule">
            {(
              [
                ['display', 22, 650],
                ['body', 15, 400],
                ['mono', 14, 400],
              ] as const
            ).map(([key, size, weight]) => (
              <div key={key} className="px-3 py-2.5">
                <p
                  className="truncate text-ink"
                  style={{
                    fontFamily: kit ? `'${brandFontName(brand.id, key)}', ${brand.fonts[key]}` : brand.fonts[key],
                    fontSize: size,
                    fontWeight: weight,
                    letterSpacing: key === 'display' ? '-0.02em' : undefined,
                  }}
                >
                  {texts.fontRoles[key].sample}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-ink-4">
                  {texts.fontRoles[key].label} ·{' '}
                  <span className="font-mono">{brand.fonts[key].split(',')[0].replace(/['"]/g, '')}</span>
                </p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-ink-4">
            {texts.radii([brand.radius.sm, brand.radius.md, brand.radius.lg, brand.radius.xl])}
          </p>
        </section>
        <section className="space-y-2">
          <SectionTitle>{texts.kit}</SectionTitle>
          {kitError === null ? (
            <div className="overflow-hidden rounded-xl ring-1 ring-rule">
              <KitFrame
                query={{ brand: brandId, view: 'panel' }}
                title={texts.kit}
                background={brand.colors.background}
                maxScale={0.5}
                onKit={setKit}
                onFailed={setKitError}
              />
            </div>
          ) : (
            <p className="text-xs text-alert">{texts.kitFailed(kitError)}</p>
          )}
          <p className="text-[11px] leading-relaxed text-ink-4">{texts.kitHint}</p>
        </section>
        {kit && kit.extras.length > 0 && (
          <section className="space-y-2">
            <SectionTitle action={<span className="text-[11px] text-ink-4">{texts.extrasHint(agent)}</span>}>
              {texts.extras}
            </SectionTitle>
            <ul className="space-y-2">
              {kit.extras.map(({ name, description }) => (
                <li key={name} className="overflow-hidden rounded-xl ring-1 ring-rule">
                  <KitFrame
                    query={{ brand: brandId, view: 'extra', name }}
                    title={name}
                    background={brand.colors.background}
                    maxScale={0.4}
                    maxHeight={170}
                  />
                  <div className="px-3 py-2">
                    <p className="font-mono text-[12px] font-medium text-ink">{name}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {kit && (kit.copy.taglines.length > 0 || kit.copy.features.length > 0) && (
          <section className="space-y-2">
            <SectionTitle>{texts.copy}</SectionTitle>
            <ul className="flex flex-wrap gap-1.5">
              {kit.copy.taglines.map((line) => (
                <li key={line} className="rounded-lg bg-wash px-2 py-1 text-[12px] text-ink-2">
                  {texts.tagline(line)}
                </li>
              ))}
            </ul>
            <dl className="space-y-1.5">
              {kit.copy.features.map((f) => (
                <div key={f.title} className="text-[12px] leading-relaxed">
                  <dt className="font-medium text-ink-2">{f.title}</dt>
                  <dd className="text-ink-3">{f.body}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <section className="space-y-1.5 pb-1">
          <SectionTitle>{texts.voice}</SectionTitle>
          <p className="text-[12.5px] leading-relaxed text-ink-2">{brand.voice}</p>
        </section>
      </div>
    </div>
  );
}

/**
 * kit.html at video scale, shrunk to fit and centered. The page reports its natural size, once in view: Chrome does not
 * lay out a cross-origin iframe out of view (nor an empty one), so until then it gets the usual size of a sheet.
 */
function KitFrame(props: {
  query: { brand: string; view: 'panel' | 'extra'; name?: string };
  title: string;
  background: string;
  maxScale: number;
  maxHeight?: number;
  onKit?: (kit: KitInfo) => void;
  onFailed?: (error: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const origin = useStore((s) => s.app?.frameOrigin ?? '');

  useLayoutEffect(() => {
    const el = box.current!;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const message = readKitMessage(event.data);
      if (message?.type === 'size') setSize({ width: message.width, height: message.height });
      else if (message?.type === 'kit') latest.current.onKit?.(message);
      else if (message?.type === 'failed') latest.current.onFailed?.(message.error);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin]);

  const pad = 12;
  const natural = size ?? { width: 900, height: 500 };
  const scale = width ? Math.min(props.maxScale, (width - pad * 2) / natural.width) : props.maxScale;
  const height = Math.min(props.maxHeight ?? Infinity, natural.height * scale + pad * 2);
  return (
    <div
      ref={box}
      className={clsx('relative overflow-hidden', !size && 'skeleton')}
      style={{ background: size ? props.background : undefined, height }}
    >
      {origin && (
        <iframe
          ref={frame}
          src={`${origin}/kit.html?${new URLSearchParams(props.query)}`}
          title={props.title}
          // Own origin kept (it fetches the brand); no navigation, popups or forms.
          sandbox="allow-scripts allow-same-origin"
          tabIndex={-1}
          className="absolute border-0"
          style={{
            left: Math.max(pad, (width - natural.width * scale) / 2),
            top: pad,
            width: natural.width,
            height: natural.height,
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
          }}
        />
      )}
    </div>
  );
}

const FONT_ROLES = ['display', 'body', 'mono'] as const;
const addedFaces = new Set<string>();

/** Cadence's name for a brand font: a kit's face never applies to the editor's own text, only to these samples. */
function brandFontName(brandId: string, role: (typeof FONT_ROLES)[number]): string {
  return `Cadence brand ${brandId} ${role}`;
}

/** The faces of each role's first family, files on the frame origin only (which allows the editor to load them). */
function addBrandFonts(brand: BrandFile, faces: KitFontFace[], frameOrigin: string): void {
  for (const role of FONT_ROLES) {
    const family = brand.fonts[role]
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    for (const face of faces) {
      const sources = face.sources.filter((source) => URL.parse(source.url)?.origin === frameOrigin);
      const key = JSON.stringify([brand.id, role, face]);
      if (face.family !== family || !sources.length || addedFaces.has(key)) continue;
      addedFaces.add(key);
      const src = sources
        .map(({ url, format }) => `url(${JSON.stringify(url)})${format ? ` format(${JSON.stringify(format)})` : ''}`)
        .join(', ');
      const { weight, style, stretch, unicodeRange } = face;
      try {
        document.fonts.add(new FontFace(brandFontName(brand.id, role), src, { weight, style, stretch, unicodeRange }));
      } catch {
        // A descriptor the browser refuses: that sample keeps the fallback fonts.
      }
    }
  }
}

/** Kit code runs in the page that sends these: a message that does not have the expected shape is dropped. */
function readKitMessage(data: unknown): KitToEditor | null {
  const message = data as Partial<Record<string, unknown>> | null;
  if (message?.source !== 'cadence-kit') return null;
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  const texts = (value: unknown, keys: string[]) =>
    Array.isArray(value) &&
    value.every((item) => typeof item === 'object' && item !== null && keys.every((key) => typeof item[key] === 'string'));
  const dimension = (value: unknown) => typeof value === 'number' && value > 0 && value < 100_000;
  if (message.type === 'size' && dimension(message.width) && dimension(message.height)) return message as KitToEditor;
  if (message.type === 'failed' && typeof message.error === 'string') return message as KitToEditor;
  const copy = message.copy as Partial<KitInfo['copy']> | undefined;
  const optional = (value: unknown) => value === undefined || typeof value === 'string';
  const fonts =
    Array.isArray(message.fonts) &&
    message.fonts.every(
      (face: Partial<KitFontFace> | null) =>
        typeof face?.family === 'string' &&
        Array.isArray(face.sources) &&
        face.sources.every((source) => typeof source?.url === 'string' && optional(source.format)) &&
        [face.weight, face.style, face.stretch, face.unicodeRange].every(optional),
    );
  if (
    message.type === 'kit' &&
    texts(message.extras, ['name', 'description']) &&
    strings(copy?.taglines) &&
    texts(copy?.features, ['title', 'body']) &&
    fonts
  ) {
    return message as KitToEditor;
  }
  return null;
}
