import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BrandContext,
  BrowserFrame,
  Callout,
  Camera,
  ClickRipple,
  Counter,
  Cursor,
  Dimension,
  DrawPath,
  Fill,
  Glow,
  Grain,
  Guide,
  Highlight,
  Layer3D,
  PhoneFrame,
  RadiusArc,
  SceneContext,
  SplitText,
  Stage3D,
  SwapWords,
  Tag,
  TypeOn,
  Vignette,
  asset,
  createMusic,
  cursorAt,
  cursorPress,
  measureText,
  project3D,
  rectPath,
  setAssetBase,
  typed,
  useBrand,
  useCameraZoom,
  useFormat,
  useScene,
  type BrandKit,
  type FormatId,
  type SceneProps,
} from '../../src/runtime/index';
import { FORMATS } from '../../src/shared/types';

const brand = {
  id: 'test',
  name: 'Test',
  colors: {
    background: '#fafafa',
    surface: '#ffffff',
    ink: '#111111',
    muted: '#71717a',
    line: '#e4e4e7',
    primary: '#2563eb',
    primaryInk: '#ffffff',
    accent: '#00aa55',
    success: '#16a34a',
    warning: '#f59e0b',
    danger: '#dc2626',
  },
  fonts: { display: 'Display', body: 'Body', mono: 'Mono', preload: [] },
} as unknown as BrandKit;

function sceneProps(format: FormatId = '16:9', t = 1): SceneProps {
  const spec = FORMATS[format];
  return {
    t,
    duration: 4,
    width: spec.width,
    height: spec.height,
    format,
    orientation: spec.orientation,
    fps: 30,
    music: createMusic({ grid: null, tempo: 120, musicStart: 0, sceneStart: 0, sceneDuration: 4 }),
    voiceOver: { text: '', lines: [] },
    scene: { id: 'intro', name: 'Intro', index: 0, count: 3, start: 0 },
    brand,
  };
}

function render(node: ReactNode, format: FormatId = '16:9'): string {
  return renderToStaticMarkup(<SceneContext.Provider value={sceneProps(format)}>{node}</SceneContext.Provider>);
}

const P = { x: 100, y: 200 };
const Q = { x: 400, y: 200 };
const PATH = [
  { t: 0, x: 100, y: 100 },
  { t: 1, x: 500, y: 300 },
];

const gallery: [string, ReactElement][] = [
  ['Fill', <Fill center>x</Fill>],
  ['SplitText', <SplitText text="Every part" by="words" piece={(i) => ({ opacity: i / 2 })} />],
  ['TypeOn', <TypeOn text="Impeccable" progress={0.5} pendingColor="#dddddd" caret />],
  ['SwapWords', <SwapWords from="Every scene is code." to="Every part in its place" progress={0.6} />],
  ['Counter', <Counter to={1234} progress={1} />],
  [
    'Stage3D',
    <Stage3D rotateX={40}>
      <Layer3D z={20}>x</Layer3D>
    </Stage3D>,
  ],
  [
    'Camera',
    <Camera x={300} y={200} zoom={3}>
      <Tag x={10} y={10}>
        t
      </Tag>
    </Camera>,
  ],
  [
    'DrawPath',
    <svg>
      <DrawPath d="M0,0L100,0" progress={0.5} head />
    </svg>,
  ],
  [
    'Glow',
    <svg>
      <Glow>
        <path d="M0,0L100,0" />
      </Glow>
    </svg>,
  ],
  [
    'Tag',
    <Tag x={5} y={5} anchor="top-left" mono>
      card.footer
    </Tag>,
  ],
  ['Callout', <Callout from={P} to={Q} label="Header" variant="tag" progress={0.8} />],
  ['Dimension', <Dimension from={P} to={Q} />],
  ['RadiusArc', <RadiusArc x={300} y={300} r={16} corner="bottom-right" />],
  ['Guide', <Guide y={120} />],
  ['Highlight', <Highlight x={10} y={10} width={200} height={50} label="card.header" />],
  ['Cursor', <Cursor t={0.5} path={PATH} clicks={[0.5]} ripple hover={0.5} />],
  ['ClickRipple', <ClickRipple x={10} y={10} t={0.2} at={0} />],
  ['BrowserFrame', <BrowserFrame width={800} height={500} url="acme.dev" />],
  ['PhoneFrame', <PhoneFrame />],
  ['Grain', <Grain seed={2} t={1} />],
  ['Vignette', <Vignette />],
];

describe('components render deterministically', () => {
  for (const [name, element] of gallery) {
    test(name, () => {
      const a = render(element);
      assert.ok(a.length > 0, `${name} rendered nothing`);
      assert.equal(render(element), a);
    });
  }
});

describe('scene contexts', () => {
  test('useScene and useBrand throw outside a scene', () => {
    const S = () => <i>{useScene().t}</i>;
    const B = () => <i>{useBrand().name}</i>;
    assert.throws(() => renderToStaticMarkup(<S />), /inside a Cadence scene/);
    assert.throws(() => renderToStaticMarkup(<B />), /inside a Cadence scene/);
  });

  test('useBrand prefers BrandContext and falls back to the scene brand', () => {
    const B = () => <i>{useBrand().name}</i>;
    assert.equal(render(<B />), '<i>Test</i>');
    const other = { ...brand, name: 'Other' } as BrandKit;
    assert.equal(
      renderToStaticMarkup(
        <BrandContext.Provider value={other}>
          <B />
        </BrandContext.Provider>,
      ),
      '<i>Other</i>',
    );
  });

  test('useFormat: orientation flags, pick fallbacks and safe areas', () => {
    const F = () => {
      const f = useFormat();
      const picked = f.pick({ landscape: 'L', portrait: 'P', square: 'S', '4:5': 'F' });
      const noSquare = f.pick({ landscape: 'L', portrait: 'P' });
      return (
        <i>
          {[
            f.format,
            f.width,
            f.height,
            f.orientation,
            f.isPortrait,
            f.isLandscape,
            f.isSquare,
            picked,
            noSquare,
            JSON.stringify(f.safe),
          ].join('|')}
        </i>
      );
    };
    assert.equal(
      render(<F />, '16:9'),
      '<i>16:9|1920|1080|landscape|false|true|false|L|L|{&quot;top&quot;:72,&quot;right&quot;:72,&quot;bottom&quot;:72,&quot;left&quot;:72}</i>',
    );
    assert.equal(
      render(<F />, '9:16'),
      '<i>9:16|1080|1920|portrait|true|false|false|P|P|{&quot;top&quot;:220,&quot;right&quot;:60,&quot;bottom&quot;:380,&quot;left&quot;:60}</i>',
    );
    assert.equal(
      render(<F />, '1:1'),
      '<i>1:1|1080|1080|square|false|false|true|S|P|{&quot;top&quot;:60,&quot;right&quot;:60,&quot;bottom&quot;:60,&quot;left&quot;:60}</i>',
    );
    assert.equal(render(<F />, '4:5').split('|')[7], 'F');
  });

  test('kit components default to the brand tokens', () => {
    assert.match(render(<Tag>x</Tag>), /background:#00aa55/);
    assert.match(render(<Tag mono>x</Tag>), /font-family:Mono/);
  });
});

describe('asset', () => {
  afterEach(() => setAssetBase(''));

  test('encodes path segments under the asset base', () => {
    setAssetBase('/@fs/p/assets');
    assert.equal(asset('screens/home page.png'), '/@fs/p/assets/screens/home%20page.png');
    assert.equal(asset('/logo.svg'), '/@fs/p/assets/logo.svg');
    setAssetBase('/x/');
    assert.equal(asset('a#b.png'), '/x/a%23b.png');
  });
});

describe('text', () => {
  test('typed and SplitText', () => {
    assert.equal(typed('héllo', 0.4), 'hé');
    assert.equal(typed('abc', 2), 'abc');
    const html = render(<SplitText text="ab c" />);
    assert.equal((html.match(/display:inline-block;white-space:pre/g) ?? []).length, 3);
  });

  test('TypeOn: settled text, fading characters, zero-width caret, plain text when done', () => {
    const mid = render(
      <TypeOn text="Impeccable" progress={0.5} color="#111111" pendingColor="#dddddd" caret={{ color: '#ff0000', width: 4 }} />,
    );
    assert.match(mid, /^<span style="color:#111111">Impe<span style="color:rgba\(/);
    assert.match(mid, /width:4px;[^"]*margin-right:calc\(-1 \* \(4px \+ 0.04em\)\)[^"]*background:#ff0000/);
    assert.doesNotMatch(mid, /cable/);
    assert.equal(
      render(<TypeOn text="Impeccable" progress={1} pendingColor="#dddddd" />),
      '<span style="color:#111111">Impeccable</span>',
    );
    assert.equal(render(<TypeOn text="Hi" progress={0} />), '<span></span>');
    assert.match(render(<TypeOn text="centered" progress={0.3} reserve />), /visibility:hidden">[a-z]+<\/span><\/span>$/);
  });

  test('SwapWords renders plain text at rest and masked words in between', () => {
    const from = 'Every scene is code.';
    const to = 'Every part in its place';
    assert.equal(
      render(<SwapWords from={from} to={to} progress={0} />),
      `<span style="white-space:nowrap">Every scene is code.</span>`,
    );
    assert.equal(
      render(<SwapWords from={from} to={to} progress={1} />),
      `<span style="white-space:nowrap">Every part in its place</span>`,
    );
    const mid = render(<SwapWords from={from} to={to} progress={0.5} />);
    assert.match(mid, /^<span style="white-space:nowrap">Every<span style="display:inline-grid/);
    assert.match(mid, /clip-path:inset\(-1em -0.15em -0.3em -0.15em\)/);
    assert.equal((mid.match(/display:inline-grid/g) ?? []).length, 3 + 4);
    // Shared tail words stay; the changing word is styled.
    const swap = render(
      <SwapWords from="anywhere you want" to="everywhere you want" progress={1} toStyle={{ color: '#ff2e88' }} />,
    );
    assert.equal(swap, '<span style="white-space:nowrap"><span style="color:#ff2e88">everywhere </span>you want</span>');
  });

  test('Counter formats with Intl in fr-FR by default', () => {
    assert.equal(render(<Counter to={1234.4} progress={1} />), '<span style="font-variant-numeric:tabular-nums">1 234</span>');
    assert.equal(
      render(<Counter from={0} to={100} progress={0.5} suffix=" %" />),
      '<span style="font-variant-numeric:tabular-nums">50 %</span>',
    );
    assert.match(render(<Counter to={2500} progress={1} format={{ style: 'currency', currency: 'EUR' }} />), /2 500,00 €/);
    assert.match(
      render(<Counter to={1234.5} progress={1} locale="en-US" format={{ maximumFractionDigits: 1 }} prefix="$" />),
      />\$1,234\.5</,
    );
  });

  test('measureText approximation without a DOM is deterministic and counts letter-spacing', () => {
    const style = { fontSize: 100, fontFamily: 'Body', fontWeight: 700 };
    const a = measureText('Storyboard', style);
    assert.deepEqual(measureText('Storyboard', style), a);
    assert.ok(a.width > 300 && a.width < 700, `${a.width}`);
    assert.equal(a.height, 120);
    const spaced = measureText('Storyboard', { ...style, letterSpacing: '-0.05em' });
    assert.ok(Math.abs(a.width - spaced.width - 10 * 5) < 1e-9);
  });
});

describe('stage and camera', () => {
  test('Stage3D is flat at rest, 3D otherwise', () => {
    const flat = render(
      <Stage3D rotateX={0.0001} perspective={900}>
        <Layer3D z={50}>x</Layer3D>
      </Stage3D>,
    );
    assert.doesNotMatch(flat, /perspective|preserve-3d|translateZ/);
    const tilted = render(
      <Stage3D rotateX={30} perspective={900}>
        <Layer3D z={50}>x</Layer3D>
      </Stage3D>,
    );
    assert.match(tilted, /perspective:900px/);
    assert.match(tilted, /rotateX\(30deg\)/);
    assert.match(tilted, /translateZ\(50px\)/);
    assert.doesNotMatch(
      render(
        <Stage3D rotateX={30}>
          <Layer3D z={0}>x</Layer3D>
        </Stage3D>,
      ),
      /translateZ/,
    );
  });

  test('project3D is the identity at rest and rotates around the focus', () => {
    const canvas = { width: 1920, height: 1080 };
    const p = project3D({ x: 700, y: 300 }, {}, canvas);
    assert.ok(Math.abs(p.x - 700) < 1e-9 && Math.abs(p.y - 300) < 1e-9);
    const r = project3D({ x: 1060, y: 540 }, { rotateZ: 90 }, canvas);
    assert.ok(Math.abs(r.x - 960) < 1e-9 && Math.abs(r.y - 640) < 1e-9);
    // Points lifted toward the viewer spread away from the focus.
    const near = project3D({ x: 1060, y: 540, z: 300 }, { perspective: 1200 }, canvas);
    assert.ok(Math.abs(near.x - (960 + 100 * (1200 / 900))) < 1e-9);
  });

  test('Camera adds no transform at rest and keeps annotation size constant when zoomed', () => {
    assert.doesNotMatch(render(<Camera>x</Camera>), /transform:/);
    const Z = () => <i>{useCameraZoom()}</i>;
    const html = render(
      <Camera x={300} y={200} zoom={4}>
        <Camera zoom={2}>
          <Z />
        </Camera>
        <Tag x={10} y={10}>
          t
        </Tag>
      </Camera>,
    );
    assert.match(html, /transform:translate\(960px, 540px\) rotate\(0deg\) scale\(4\) translate\(-300px, -200px\)/);
    assert.match(html, /<i>8<\/i>/);
    assert.match(html, /scale\(0.25\)/);
  });
});

describe('drawing and annotations', () => {
  test('rectPath', () => {
    assert.equal(rectPath(0, 0, 10, 20), 'M0,0H10V20H0Z');
    assert.equal(
      rectPath(0, 0, 100, 50, 10),
      'M10,0H90A10,10 0 0 1 100,10V40A10,10 0 0 1 90,50H10A10,10 0 0 1 0,40V10A10,10 0 0 1 10,0Z',
    );
    assert.match(rectPath(0, 0, 10, 10, 50), /A5,5/);
  });

  test('DrawPath: nothing at 0, dashed while drawing, plain stroke when done', () => {
    assert.equal(
      render(
        <svg>
          <DrawPath d="M0,0L10,0" progress={0} />
        </svg>,
      ),
      '<svg></svg>',
    );
    const mid = render(
      <svg>
        <DrawPath d="M0,0L10,0" progress={0.25} head />
      </svg>,
    );
    assert.match(mid, /pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="0.75"/);
    assert.match(mid, /stroke-dasharray="0.06 2" stroke-dashoffset="-0.19"/);
    const done = render(
      <svg>
        <DrawPath d="M0,0L10,0" progress={1} head />
      </svg>,
    );
    assert.doesNotMatch(done, /dasharray/);
  });

  test('Glow references its own filter', () => {
    const html = render(
      <svg>
        <Glow color="#ff0000" intensity={1.5}>
          <path d="M0,0" />
        </Glow>
      </svg>,
    );
    const id = /<filter id="([^"]+)"/.exec(html)?.[1];
    assert.ok(id);
    assert.match(html, new RegExp(`filter="url\\(#${id}\\)"`));
    assert.match(html, /flood-color="#ff0000"/);
  });

  test('labels and values are visible', () => {
    assert.match(render(<Callout from={P} to={Q} label="Header" />), />Header</);
    assert.equal(render(<Callout from={P} to={Q} label="Header" progress={0} />), '');
    assert.match(render(<Dimension from={P} to={Q} />), />300</);
    assert.match(render(<Dimension from={P} to={Q} label="4" labelAt="end" />), />4</);
    assert.match(render(<RadiusArc x={300} y={300} r={16} corner="bottom-right" />), />r 16</);
    assert.match(render(<Highlight x={0} y={0} width={10} height={10} label="card.footer" />), />card\.footer</);
    assert.match(render(<BrowserFrame width={800} height={500} url="orbit.example" />), /orbit\.example/);
    assert.match(render(<PhoneFrame time="10:24" />), />10:24</);
    assert.doesNotMatch(render(<PhoneFrame time={false} />), /9:41/);
  });

  test('Guide spans the canvas and needs coordinates', () => {
    assert.match(render(<Guide y={120} />), /d="M0,120L1920,120"/);
    assert.match(render(<Guide x={50} progress={0.5} />, '9:16'), /d="M50,0L50,960"/);
    assert.throws(() => render(<Guide />), /Guide needs x, y, or from and to/);
  });

  test('Grain changes with t only through its seed', () => {
    const seedOf = (html: string) => /seed="(\d+)"/.exec(html)?.[1];
    assert.equal(seedOf(render(<Grain seed={3} />)), '3');
    assert.equal(seedOf(render(<Grain seed={3} t={1} fps={12} />)), '15');
  });

  test('Grain and Vignette mark their root as decor: the frame text checks look through them', () => {
    assert.match(render(<Grain />), /^<svg data-cadence-decor=""/);
    assert.match(render(<Vignette />), /^<div data-cadence-decor=""/);
  });
});

describe('cursor', () => {
  test('cursorAt follows keyframes with eased, bowed moves', () => {
    assert.deepEqual(cursorAt(-1, PATH), { x: 100, y: 100 });
    assert.deepEqual(cursorAt(5, PATH), { x: 500, y: 300 });
    const straight = cursorAt(0.5, PATH, 0);
    assert.ok(Math.abs(straight.x - 300) < 1e-9 && Math.abs(straight.y - 200) < 1e-9);
    const bowed = cursorAt(0.5, PATH);
    assert.ok(Math.hypot(bowed.x - 300, bowed.y - 200) > 10);
    assert.deepEqual(cursorAt(1, []), { x: 0, y: 0 });
  });

  test('press ramps around the click and releases', () => {
    assert.equal(cursorPress(0.5, [1]), 0);
    assert.equal(cursorPress(1, [1]), 1);
    assert.ok(cursorPress(1.15, [1]) > 0 && cursorPress(1.15, [1]) < 1);
    assert.equal(cursorPress(1.3, [1]), 0);
    assert.match(render(<Cursor t={1} path={PATH} clicks={[1]} />), /scale\(0.86\)/);
  });

  test('ClickRipple only exists during its animation', () => {
    assert.equal(render(<ClickRipple x={0} y={0} t={0.9} at={1} />), '');
    assert.notEqual(render(<ClickRipple x={0} y={0} t={1.2} at={1} />), '');
    assert.equal(render(<ClickRipple x={0} y={0} t={1.6} at={1} />), '');
  });
});
