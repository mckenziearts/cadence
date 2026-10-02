// Kit sheet: a brand's logos, colors, fonts, every UI component with sample props and its extras, rendered on the frame
// origin (a kit is code, possibly written by the brand builder: it never runs in the server or in the editor page). The
// brand builder looks at it and checks it through capture; the editor shows it once a brand is built. `view=panel` and
// `view=extra` are the editor's brand panel: a smaller sheet, or one extra, sized for it over postMessage.
import '@fontsource-variable/inter';
import { BrandContext } from 'cadence';
import { Component, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { FrameBrandData } from '../../server/frames/frameServer';
import type { BrandKit } from '../shared/brandKit';
import type { KitFontFace, KitSheetResult, KitToEditor } from '../shared/frameProtocol';
import { uiSamples } from '../shared/kitSamples';
import type { BrandColors } from '../shared/types';
import { postToEditor } from './editor';
import { language, texts } from './texts';

const query = new URLSearchParams(location.search);
const brandId = query.get('brand') ?? '';
const view = query.get('view');
const embedded = view === 'panel' || view === 'extra';
const extraName = query.get('name') ?? '';
// Scrollbars would show while the iframe is still smaller than what it measures.
if (embedded) document.documentElement.style.overflow = 'hidden';
const problems: string[] = [];
/** False when the brand's index.tsx or theme failed to load: the build then diagnoses the compile error. */
let brandLoaded = true;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
window.addEventListener('error', (e) => problems.push(e.message));
window.addEventListener('unhandledrejection', (e) => problems.push(message(e.reason)));

/** One sample that throws shows its error in place and is reported; the rest of the sheet still renders. */
class Guard extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: message(e) };
  }
  componentDidCatch(e: unknown) {
    problems.push(texts.sampleFailed(this.props.name, message(e)));
  }
  render() {
    if (this.state.error === null) return this.props.children;
    return <p style={{ margin: 0, color: '#e7000b', font: "500 15px 'Inter Variable', sans-serif" }}>{this.state.error}</p>;
  }
}

function Sheet({ kit }: { kit: BrandKit }) {
  const { colors, fonts, Logo } = kit;
  const label: CSSProperties = {
    font: "600 13px 'Inter Variable', sans-serif",
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: colors.muted,
  };
  const title = (text: string) => <h2 style={{ ...label, margin: '0 0 20px', fontSize: 15, color: colors.ink }}>{text}</h2>;
  return (
    <BrandContext.Provider value={kit}>
      <main
        style={{
          boxSizing: 'border-box',
          padding: 64,
          display: 'flex',
          flexDirection: 'column',
          gap: 64,
          background: colors.background,
          color: colors.ink,
          fontFamily: fonts.body,
        }}
      >
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 56 }}>
          <Guard name="Logo full">
            <Logo variant="full" height={72} />
          </Guard>
          <Guard name="Logo mark">
            <Logo variant="mark" height={72} />
          </Guard>
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 56, lineHeight: 1.1 }}>{kit.name}</div>
            <div style={{ marginTop: 8, fontSize: 22, color: colors.muted }}>{kit.tagline}</div>
          </div>
        </header>

        <section>
          {title(texts.sections.colors)}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            {(Object.keys(colors) as (keyof BrandColors)[]).map((key) => (
              <div key={key} style={{ width: 132 }}>
                <div
                  style={{
                    height: 72,
                    borderRadius: kit.radius.md,
                    background: colors[key],
                    boxShadow: `inset 0 0 0 1px ${colors.line}`,
                  }}
                />
                <div style={{ ...label, marginTop: 8, textTransform: 'none', letterSpacing: 0, color: colors.ink }}>{key}</div>
                <div style={{ ...label, textTransform: 'none', letterSpacing: 0 }}>{colors[key]}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          {title(texts.sections.fonts)}
          <div style={{ display: 'grid', gap: 18 }}>
            <div style={{ fontFamily: fonts.display, fontSize: 64, lineHeight: 1.1 }}>{kit.copy.taglines[0] ?? kit.name}</div>
            <div style={{ fontSize: 24, maxWidth: 1200 }}>{kit.copy.features[0]?.body ?? kit.tagline}</div>
            <div style={{ fontFamily: fonts.mono, fontSize: 20 }}>const brand = &apos;{kit.id}&apos;; // 0123456789</div>
            <div style={label}>
              {fonts.display} · {fonts.body} · {fonts.mono}
            </div>
          </div>
        </section>

        <section>
          {title(texts.sections.components)}
          {/* Three columns at the capture's 1920 px, two in the editor's New brand preview, one below. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(480px, 100%), 1fr))',
              gap: 40,
              alignItems: 'start',
            }}
          >
            {uiSamples(kit.ui, language).map(([name, element]) => (
              <div key={name} style={{ display: 'grid', gap: 10, justifyItems: 'start' }}>
                <div style={label}>{name}</div>
                <Guard name={name}>{element}</Guard>
              </div>
            ))}
          </div>
        </section>

        <section>
          {title(texts.sections.extras)}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 56, alignItems: 'flex-start' }}>
            {Object.entries(kit.extras).map(([name, { component: Extra, description }]) => (
              <div key={name} className="kit-extra" style={{ display: 'grid', gap: 12, maxWidth: '100%' }}>
                <div style={label}>{name}</div>
                <div style={{ fontSize: 15, color: colors.muted, maxWidth: 720 }}>{description}</div>
                <Guard name={name}>
                  <Extra />
                </Guard>
              </div>
            ))}
          </div>
        </section>
      </main>
    </BrandContext.Provider>
  );
}

function post(message: KitToEditor): void {
  postToEditor(message);
}

/** Reports the natural size of what it shows: the editor scales the iframe to fit its panel. */
function Embedded({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    const observer = new ResizeObserver(() =>
      post({ source: 'cadence-kit', type: 'size', width: el.offsetWidth, height: el.offsetHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // max-content: the iframe is still small when it measures, and must not wrap what it measures.
  return (
    <div ref={box} style={{ position: 'absolute', width: 'max-content' }}>
      {children}
    </div>
  );
}

/** Kit components at video scale, laid out like a spec sheet: the brand panel's view. */
function PanelSheet({ kit }: { kit: BrandKit }) {
  const sheet = texts.sheet;
  const { ui, Logo } = kit;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, padding: 36, width: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Logo variant="full" height={48} />
        <div style={{ flex: 1 }} />
        <ui.Button variant="primary">{sheet.save}</ui.Button>
        <ui.Button variant="secondary">{sheet.cancel}</ui.Button>
      </div>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <ui.Card style={{ flex: 1.3 }}>
          <ui.CardHeader>{sheet.profile}</ui.CardHeader>
          <ui.CardBody style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <ui.Input label={sheet.name} value="Olivia Martin" focused caret />
            <ui.ListItem
              title="Olivia Martin"
              subtitle={sheet.saved}
              leading={<ui.Avatar name="Olivia Martin" size={44} />}
              trailing={<ui.Badge tone="success">{sheet.active}</ui.Badge>}
            />
          </ui.CardBody>
        </ui.Card>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <ui.Stat label={sheet.month} value={sheet.amount} delta={sheet.delta} trend="up" />
          <ui.Tabs items={sheet.tabs} active={1} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <ui.Toggle on label={sheet.notifications} />
            <ui.Badge tone="primary">{sheet.new}</ui.Badge>
            <ui.Badge tone="warning">{sheet.pending}</ui.Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The @font-face rules of the brand theme, read through the CSSOM: the editor shows the fonts under its own names. */
function fontFaces(sheet: CSSStyleSheet): KitFontFace[] {
  const faces: KitFontFace[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        const value = (name: string) => rule.style.getPropertyValue(name) || undefined;
        const sources = [
          ...rule.style.getPropertyValue('src').matchAll(/url\("((?:[^"\\]|\\.)*)"\)(?:\s*format\("([^"]*)"\))?/g),
        ];
        faces.push({
          family: rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, ''),
          sources: sources.map(([, url, format]) => ({ url: new URL(url, location.href).href, format })),
          weight: value('font-weight'),
          style: value('font-style'),
          stretch: value('font-stretch'),
          unicodeRange: value('unicode-range'),
        });
      } else if (rule instanceof CSSGroupingRule) {
        visit(rule.cssRules);
      }
    }
  };
  visit(sheet.cssRules);
  return faces;
}

function Page({ kit }: { kit: BrandKit }) {
  if (!embedded) return <Sheet kit={kit} />;
  const Extra = view === 'extra' ? kit.extras[extraName].component : null;
  return (
    <BrandContext.Provider value={kit}>
      <Embedded>
        <Guard name={Extra ? extraName : kit.name}>{Extra ? <Extra /> : <PanelSheet kit={kit} />}</Guard>
      </Embedded>
    </BrandContext.Provider>
  );
}

async function load(): Promise<KitSheetResult> {
  const root = createRoot(document.getElementById('root')!, {
    // The guards report caught errors; React would also log them as console errors.
    onCaughtError: () => undefined,
    onUncaughtError: (e) => problems.push(message(e)),
  });
  try {
    const res = await fetch(`/frame-api/brands/${encodeURIComponent(brandId)}`, { cache: 'no-store' });
    const data = (await res.json()) as FrameBrandData & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    // Same cache-busting query as frames (`g`): Vite keeps `v=` for its own dependency versions.
    const generation = (query.get('v') ?? '').replace(/\W/g, '');
    const [css, mod] = await Promise.all([
      import(/* @vite-ignore */ `${data.brandUrl}theme.css?inline&g=${generation}`) as Promise<{ default: string }>,
      import(/* @vite-ignore */ `${data.brandUrl}index.tsx?g=${generation}`) as Promise<{ default?: BrandKit }>,
    ]);
    const kit = mod.default;
    if (!kit?.ui) throw new Error(texts.kitExport);
    const style = document.createElement('style');
    style.textContent = css.default;
    document.head.append(style);
    for (const face of data.brand.fonts.preload) {
      await document.fonts.load(face).catch(() => undefined);
      // check() is true when no face matches at all: look for a loaded face of that family instead.
      const family = /'([^']+)'/.exec(face)?.[1];
      const loaded = [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === family && f.status === 'loaded');
      if (!loaded) problems.push(texts.fontFailed(face));
    }
    if (view === 'extra' && !Object.hasOwn(kit.extras, extraName)) throw new Error(extraName);
    flushSync(() => root.render(<Page kit={kit} />));
    if (view === 'panel') {
      const extras = Object.entries(kit.extras).map(([name, extra]) => ({ name, description: extra.description }));
      post({ source: 'cadence-kit', type: 'kit', extras, copy: kit.copy, fonts: fontFaces(style.sheet!) });
    }
  } catch (e) {
    brandLoaded = false;
    problems.push(texts.brandFailed(brandId, message(e)));
    const error = <p style={{ margin: 32, color: '#e7000b', font: '500 18px sans-serif' }}>{problems.at(-1)}</p>;
    flushSync(() => root.render(embedded ? <Embedded>{error}</Embedded> : error));
    if (embedded) post({ source: 'cadence-kit', type: 'failed', error: message(e) });
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await document.fonts.ready;
  return { problems, loaded: brandLoaded };
}

window.__cadenceKit = { ready: load() };
