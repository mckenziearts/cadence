# `cadence` runtime: API reference

Scenes import everything from `'cadence'`. Every function and component is a pure function of its arguments:
the same props give the same pixels, whatever order frames are rendered in. Units: seconds for time, canvas px for space
(1920 × 1080 in 16:9, 1080 × 1920 in 9:16, 1080 × 1080 in 1:1, 1080 × 1350 in 4:5), degrees for angles.
Kit components are driven by `progress` 0 to 1 (draw in); run it 1 to 0 to retract. Colors default to the brand
(`accent` for annotations, `ink` for text lines, `body`/`mono` fonts).

## Scene props

```ts
interface SceneProps {
  t: number;            // scene seconds, 0 to duration
  duration: number;
  width: number; height: number;          // canvas px
  format: '16:9' | '9:16' | '1:1' | '4:5';
  orientation: 'landscape' | 'portrait' | 'square';   // 4:5 is portrait
  fps: number;
  music: Music;         // beat grid in scene seconds (see Music)
  voiceOver: VoiceOverInfo;  // { text, lines: { text, start, end }[] } in scene seconds (see Voice-over)
  scene: SceneInfo;     // { id, name, index, count, start (video seconds) }
  brand: BrandKit;      // same object as useBrand()
}
```
Types exported: `SceneProps, SceneInfo, VoiceOverInfo, Music, MusicGrid, MusicSection, Easing, Point ({x, y}), BrandKit, FormatId,
Orientation, FormatInfo, SafeArea, Anchor, CursorKey, Stage3DPose, RGBA` and every component's `<Name>Props`.

## Time & animation

- `progress(t, start, end, easing = ease.linear): number`: 0 to 1 through [start, end], clamped, eased. The workhorse.
- `interpolate(t, input[], output[], { easing?: e | e[], clamp = true }): number`: multi-stop map; `easing[i]` shapes
  segment i; `clamp: false` extrapolates linearly.
- `keyframes(t, [[time, value, easingIntoThisKey?], ...]): number`: the same as tuples.
- `spring(tSinceStart, { from = 0, to = 1, stiffness = 170, damping = 26, mass = 1, velocity = 0 }): number`: exact
  damped spring; returns `from` for t ≤ 0. `springs.smooth | snappy | gentle | bouncy` presets.
  `springDuration(config, threshold = 0.001): number`: seconds until it settles.
- `ease.*`: `linear`; `in/out/inOut` × `Sine Quad Cubic Quart Quint Expo Circ Back Elastic Bounce` (e.g.
  `ease.outExpo`, `ease.inOutBack`); `standard` (UI default), `decelerate` (entrances), `accelerate` (exits), `smooth`
  (camera moves, big transforms), `css` (CSS `ease`); factories `ease.bezier(x1, y1, x2, y2)` (also exported as
  `bezier`), `ease.backOut(overshoot = 1.70158)`, `ease.steps(n)`.
- `mix(a, b, p)`: lerp, p not clamped. `clamp(v, min = 0, max = 1)`.
- `remap(v, inMin, inMax, outMin, outMax, easing?)`: clamped map between ranges (reversed ranges work).
- `stagger(i, each, start = 0)` returns `start + i * each`. `staggerFrom(i, count, each, from = 'center', start = 0)`:
  delay growing away from `'start' | 'center' | 'end' |` an item index.
- `loop(t, period)` returns t wrapped into [0, period). `pingpong(t, period)` returns a triangle wave from 0 to 1 and back.

```tsx
const enter = progress(t, 0.1, 0.8, ease.outExpo);                         // entrance
const exit = progress(t, duration - 0.35, duration, ease.inCubic);        // faster exit
const y = spring(t - 0.4, { from: 60, to: 0, ...springs.snappy });        // starts at 0.4 s
const scale = interpolate(t, [0, 0.3, 1.2, 1.5], [0.9, 1, 1, 0.95], { easing: [ease.outBack, ease.linear, ease.inCubic] });
{items.map((item, i) => { const p = progress(t, stagger(i, 0.06, 0.3), stagger(i, 0.06, 0.9), ease.outExpo); ... })}
```

## Color

Accepted everywhere: `#rgb #rgba #rrggbb #rrggbbaa`, `rgb()/rgba()` (comma or space syntax, `/ alpha`, %),
`hsl()/hsla()` (deg, rad, turn), `oklch(L C H / a)`, `oklab(L a b / a)`, `transparent`, `black`, `white`. Anything
else (named colors, `var(--x)`, `currentColor`) throws `Unsupported color`. Brand colors are hex.

- `mixColor(a, b, p): string`: blend in OKLab (perceptual; premultiplied alpha, so fading from `transparent` keeps
  the hue). Returns `rgba(r, g, b, a)`.
- `interpolateColor(t, input[], colors[], { easing?, clamp? }): string`: `interpolate` for colors, in OKLab.
- `withAlpha(color, alpha): string`: multiplies the alpha (opaque colors get exactly `alpha`). `rgba()` string.
- `toHex(color): string`: `#rrggbb`, or `#rrggbbaa` when translucent. `parseColor(color): RGBA`, that is `[r, g, b, a]`
  (0-255, alpha 0-1).

```tsx
color: interpolateColor(t, [0.4, 0.9], [brand.colors.muted, brand.colors.accent])
background: withAlpha(brand.colors.accent, 0.12)
```

## Random & noise (never `Math.random()`)

- `random(seed: number | string): number`: deterministic [0, 1). `random('star-3')` is the same on every frame.
- `randomRange(seed, min, max): number`.
- `noise(x, seed = 0): number`: smooth 1D noise, -1 to 1, no flat spots. Drift: `noise(t * 0.7, 'card') * 8`.
- `noise2(x, y, seed = 0): number`: smooth 2D gradient noise, -1 to 1; 0 on integer lattice points, so sample
  between them (`noise2(i * 0.37, t * 0.5, 'field')`).

## Text

- `<SplitText text by="chars" | "words" piece={(i, count, text) => CSSProperties} />`: per-piece styles for kinetic
  type; whitespace stays text so lines still wrap.
- `typed(text, p): string`: the first `p × length` characters.
- `measureText(text, { fontSize, fontFamily, fontWeight?, fontStyle?, letterSpacing? }): { width, height }`: one
  line, canvas px, measured with the browser's text shaping (`letterSpacing`: px number or `'-0.045em'`). Pass the
  font you render with (`brand.fonts.display`). Use it to center, underline, or size boxes around text.
- `<TypeOn text progress color? pendingColor? fade={2} reserve? caret? style? className? />`: typewriter:
  characters appear one by one and fade from `pendingColor` to `color` over `fade` characters; settled at
  `progress` 1. `caret`: `true | { color (default accent), width (px, default 0.05em) }`, zero-width in layout, steady
  (blink it yourself: `caret={p < 1 || t % 1 < 0.5}`). `reserve` keeps the room of untyped characters (centered
  text does not move). Without `pendingColor`, new characters fade in by opacity.
- `<SwapWords from to progress fromStyle? toStyle? style? className? />`: one line whose changing words swap:
  words shared at the start/end of both sentences stay; outgoing words lift and fade, the line re-centers, incoming
  words rise from behind a mask under the line. Plain text at `progress` 0 and 1 (seam-safe). Single line
  (`nowrap`): stack several for multi-line layouts. Use `lineHeight: 1`.
- `<Counter from={0} to progress locale="fr-FR" format? prefix? suffix? style? className? />`: animated number,
  tabular digits, `Intl.NumberFormat` (default `{ maximumFractionDigits: 0 }` gives `12 345`). `progress` is not
  clamped (a spring may overshoot). Currency: `format={{ style: 'currency', currency: 'XAF' }}` gives `12 345 FCFA`.
- Numbers and dates: always pass an explicit locale to `Intl.*` and `toLocale*()` (`'fr-FR'` or `'en-US'`
  from `brand.language`). Renders do not use the viewer's locale: a bare `toLocaleString()` may show `25 000` in the preview and
  `25,000` in the MP4.

```tsx
<h1 style={{ margin: 0, fontFamily: brand.fonts.display, fontSize: 104, fontWeight: 700, letterSpacing: '-0.045em', lineHeight: 1 }}>
  <TypeOn text="Impeccable geometry" progress={progress(t, 0.2, 1.6)} color={brand.colors.ink}
          pendingColor={brand.colors.line} caret={t < 1.9 && { color: brand.colors.accent, width: 5 }} />
</h1>
<div style={{ position: 'absolute', left: 0, right: 0, top: 118, textAlign: 'center', fontSize: 104, lineHeight: 1 }}>
  <SwapWords from="Every scene is code." to="Every part in its place" progress={progress(t, 0.05, 0.9)} />
</div>
<SwapWords from="anywhere you" to="everywhere you" progress={p} toStyle={{ color: brand.colors.accent }} />
<Counter to={1250000} progress={progress(t, 0.3, 1.8, ease.outExpo)} suffix=" FCFA" />
```

## Scene, brand, format

- `<Fill center? style? className?>`: absolutely positioned layer covering the canvas. Paint backgrounds with it.
- `useScene(): SceneProps`: scene props in nested components.
- `useBrand(): BrandKit`: `{ id, name, tagline, url, language, colors, fonts, radius, voice, Logo, ui, extras, copy }`.
  `colors`: `background surface ink muted line primary primaryInk accent success warning danger` (hex).
  `fonts`: `display body mono` (CSS families). `radius`: `sm md lg xl`. `Logo`: `variant 'mark'|'full', height, color`.
  `ui`: `Card CardHeader CardBody CardFooter Button Input Badge Avatar Stat Toggle Tabs ListItem`: presentational,
  every state is a prop (`Button pressed hovered`, `Input value focused caret`, `Toggle on`, `Tabs active` fractional),
  all accept `style`/`className`. `extras[name].component`: brand showcase pieces (see the brand notes).
  `copy.taglines`, `copy.features`: real product copy.
- `useFormat(): FormatInfo`: `{ format, width, height, orientation, isPortrait, isLandscape, isSquare, pick, safe }`.
  `pick({ landscape, portrait, square?, '4:5'?: ... })` returns the value for this format (an exact format key wins;
  `square` falls back to `portrait`). `safe` = `{ top, right, bottom, left }` margins kept clear of social-app UI:
  220 / 60 / 380 / 60 in 9:16, 60 in 1:1 and 4:5, 72 in 16:9.
- `asset(path): string`: URL of the project's `assets/<path>`: `<img src={asset('screens/home.png')} />`. Animated
  GIF/WebP/SVG images freeze on their first frame in frames and renders (the preview may still play them): drive
  motion from `t` instead (an image sequence, transforms).
- Frame internals (never use in scenes): `SceneContext`, `BrandContext`, `setAssetBase`, `createMusic`.

```tsx
const { ui, colors } = useBrand();
const f = useFormat();
const L = f.pick({
  landscape: { x: 140, y: 380, size: 104, card: { x: 1000, y: 200 } },
  portrait: { x: f.safe.left + 20, y: f.safe.top + 40, size: 88, card: { x: 100, y: 760 } },
  square: { x: 80, y: 120, size: 80, card: { x: 200, y: 460 } },
});
<ui.Card variant="elevated" style={{ position: 'absolute', left: L.card.x, top: L.card.y, width: 680 }}>
  <ui.CardBody>
    <ui.Input label="Nom" value={typed('Olivia Martin', p)} focused caret={p < 1} />
  </ui.CardBody>
  <ui.CardFooter>
    <ui.Button variant="primary" hovered={hover > 0.5} pressed={cursorPress(t, CLICKS) > 0.5}>Enregistrer</ui.Button>
  </ui.CardFooter>
</ui.Card>
```

## Music (scene seconds; key moments to the grid, never to hard-coded seconds)

`music`: `hasTrack` (false = steady 4/4 grid at the project tempo from t = 0, phrases of 4 bars), `bpm`, `beatLength`,
`barLength`, `beatsPerBar`, `beats`, `downbeats`, `phrases` (grid points inside this scene, 0 to duration),
`sections` (`{ start, end, label, energy }` overlapping the scene), `accents` (`{ t, strength }` inside the scene).

- `music.beat(n)`, `music.bar(n)`, `music.phrase(n)`: time of the nth beat / downbeat / phrase start at or after the
  scene start (`n = 0` is the first one; fractional n interpolates; negative n goes back before the cut).
- `music.bars(n)`: length of n bars in seconds (`music.bars(1) === music.barLength`).
- `music.snap(t, grid = 'beat')`: nearest grid time; grid `'beat' | 'bar' | 'phrase' | 'half' | 'quarter'`.
- `music.pulse(t, { grid = 'beat', decay = 6 })`: 1 exactly on each hit, decaying exponentially (0 where the track
  has no beats). Without a track it pulses on the steady grid: gate it with `music.hasTrack` so a silent video stays
  still.
- `music.beatPhase(t)`: 0 to 1 through the current beat.

```tsx
const hit = music.bar(1);                                              // second downbeat of the scene
const pop = spring(t - hit, { from: 0.85, to: 1, ...springs.bouncy });
const thump = music.hasTrack ? 1 + 0.03 * music.pulse(t, { grid: 'beat', decay: 9 }) : 1;
const click = music.snap(1.2, 'half');                                 // cursor click on a half-beat
const cardIn = progress(t, music.beat(0), music.beat(2), ease.outExpo);
```

## Voice-over (scene seconds)

`voiceOver.text` is what the voice says over this scene ('' when nothing); `voiceOver.lines` lists its sentences with
`start` and `end` once Cadence has spoken them (empty before: draw the scene so it still works). Key a word on screen to
the sentence that says it: `progress(t, voiceOver.lines[0]?.start ?? 0, (voiceOver.lines[0]?.start ?? 0) + 0.4)`. The
voice is set with the `set_voice_over` tool, never in the scene's code; keep the scene at least as long as its last
`end`. Timing is per sentence, not per word.

## 3D stage

- `<Stage3D perspective={1800} focus={{ x, y }} rotateX rotateY rotateZ x y z scale style? className?>`: full-canvas
  perspective container. Children are positioned in canvas px; `focus` (default canvas center) is the pivot and the
  vanishing point. Rotations apply Z, then Y, then X; `rotateX > 0` tilts the top away. `scale` is uniform (3D).
- `<Layer3D z? style? className?>`: full-canvas layer lifted `z` px toward the viewer (exploded views). Must be a
  direct child of Stage3D, or inside wrappers with `transformStyle: 'preserve-3d'`.
- `project3D({ x, y, z? }, pose, { width, height }): Point`: where a layer point lands on the canvas: the exact CSS
  math, so callouts outside the stage can anchor to 3D parts. `pose` = the props you gave Stage3D.
- **Flat at rest**: when every pose value is 0 (scale 1; within 0.001 so settling springs count), Stage3D renders a
  plain layer (no perspective, preserve-3d or transform) and Layer3D drops its translateZ. So the first/last frame
  of a 3D move is pixel-identical to the same UI rendered flat in the neighbouring scene. Bring tilt and explode
  back to exactly 0 at the cut (`progress` ends at 0/1 exactly).

```tsx
const tilt = progress(t, 0.4, 1.4, ease.smooth) * (1 - progress(t, duration - 1, duration - 0.2, ease.smooth));
const explode = progress(t, 0.9, 1.9, ease.outExpo) * (1 - progress(t, duration - 1.3, duration - 0.5, ease.inOutCubic));
const POSE = { perspective: 2400, rotateX: 52 * tilt, rotateZ: -34 * tilt, scale: 1 - 0.06 * tilt, focus: { x: 960, y: 600 } };
const out = progress(t, 3.6, 3.9);                                     // labels leave first
<Stage3D {...POSE}>
  <Layer3D><CardSurface /></Layer3D>                                   {/* same components as the flat scenes */}
  <Layer3D z={90 * explode}><CardBody /></Layer3D>
  <Layer3D z={150 * explode}><SaveButton /></Layer3D>
</Stage3D>
<Callout from={project3D({ x: 624, y: 440, z: 90 * explode }, POSE, { width, height })} to={{ x: 470, y: 360 }}
         label="Body" progress={progress(t, 1.6, 2.3) * (1 - out)} />
```

## Camera

- `<Camera x y zoom={1} rotate={0} style? className?>`: looks at content point (x, y) (default canvas center) and
  zooms/rotates around the frame center. Children keep canvas coordinates. At rest (center, zoom 1, rotate 0) it
  adds no transform. Nest cameras freely.
- `useCameraZoom(): number`: effective zoom of the enclosing cameras. Kit annotations (Tag, Callout, Dimension,
  RadiusArc, Guide, Highlight, Cursor, ClickRipple) read it: their positions follow the content, their strokes, dots,
  ticks, labels and gaps keep a constant screen size. Do the same in custom SVG: `strokeWidth={2 / zoom}`:
  `vectorEffect="non-scaling-stroke"` does not compensate CSS transforms in Chromium.

```tsx
// Zoom into the card's bottom-right corner and annotate its geometry (Caleb's "Impeccable geometry").
const z = progress(t, 0.3, 1.5, ease.smooth);
const zoom = mix(1, 6, z);
const C = { x: 1300, y: 750 };                                         // outer box corner of the card
const a = (s: number, e: number) => progress(t, s, e, ease.outCubic);
<Camera x={mix(960, C.x - 40, z)} y={mix(540, C.y - 30, z)} zoom={zoom}>
  <ProfileCard x={620} y={330} />
  <RadiusArc x={C.x} y={C.y} r={16} corner="bottom-right" progress={a(1.6, 2.4)} />
  <RadiusArc x={C.x - 4} y={C.y - 4} r={12} corner="bottom-right" extend={0} progress={a(1.8, 2.6)} />
  <Dimension from={{ x: C.x - 4, y: 700 }} to={{ x: C.x, y: 700 }} label="4" labelAt="end" progress={a(2.4, 2.9)} />
  <Callout from={{ x: C.x - 3, y: C.y - 15 }} to={{ x: C.x + 90 / zoom, y: C.y - 50 / zoom }}  // 90 / 50 screen px away
           label="Concentric radii" variant="tag" progress={a(2.8, 3.4)} />
</Camera>
```

## Drawing

- `rectPath(x, y, w, h, r = 0): string`: rounded-rect path data (clockwise from the top-left).
- `<DrawPath d progress color="currentColor" width={2} opacity? head? linecap="round" style? />`: SVG path drawn
  from its start by `progress` (nothing at 0, plain stroke at 1). `head`: `true | { length = 0.06, color = '#fff',
  width }`: a bright comet riding the tip. Renders SVG elements: put it inside an `<svg>` (or `<Glow>`). Its width
  scales with the content (it is content, not an annotation).
- `<Glow color="#fff" intensity={1} radius={10}>`: bloom around its SVG children (inside an `<svg>`); `intensity`
  0 to 2. Its cost grows with the extent of its children, and inside `Stage3D`/`Camera` a filter is not clipped to
  the screen: lines running far past the canvas (construction guides) cost about 1 s per frame. Keep long lines out
  of it: draw them before it, in the same `<svg>` (`GuideLine` in the wireframe-glow template gives them a cheap
  gradient halo).

```tsx
// Glowing wireframe drawing itself on black, in perspective, then landing flat.
const land = progress(t, 2.2, 3.2, ease.smooth);
<Fill style={{ background: '#050505' }}>
  <Stage3D perspective={1400} rotateX={58 * (1 - land)} rotateZ={-20 * (1 - land)} focus={{ x: 960, y: 560 }}>
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      <Glow intensity={0.9} radius={8}>
        {BOXES.map((b, i) => (
          <DrawPath key={i} d={rectPath(b.x, b.y, b.w, b.h, b.r)} progress={progress(t, 0.2 + i * 0.15, 1.4 + i * 0.15, ease.inOutCubic)}
                    color="#e5e5e5" width={2} head />
        ))}
      </Glow>
    </svg>
  </Stage3D>
  <Vignette strength={0.7} />
  <Grain t={t} opacity={0.1} />
</Fill>
```

## Annotations (positions in canvas px; constant screen size inside a Camera)

- `<Tag x? y? anchor="center" color? textColor="#fff" mono? size? progress={1} style? className?>label</Tag>`: pill
  label (accent background). `anchor` (`center left right top bottom top-left top-right bottom-left bottom-right`)
  is the point of the pill placed on (x, y); omit x/y to render inline. `mono`: small code tag (`card.footer`).
- `<Callout from to label progress={1} variant="line" | "tag" color? elbow={40} labelStyle? />`: an anchor dot,
  then a line (with a horizontal run of `elbow` screen px into the label), then the label. The label sits right of `to` when
  `to.x >= from.x`, else left. `line`: thin ink line, hollow dot, text label; `tag`: accent line, halo dot, pill.
- `<Dimension from to label? progress={1} color? tick={12} labelAt="center" | "start" | "end" />`: measure line
  with end ticks; the label defaults to the rounded length; `null` hides it. `start`/`end` put it past that end.
- `<RadiusArc x y r corner progress={1} label? color? extend={30} />`: radius annotation of a rounded corner:
  `(x, y)` is the element's outer box corner, `corner` `top-left | top-right | bottom-left | bottom-right`. Faint
  circle, bold corner arc, center dot, 45° radius line, `r {r}` tag `extend` screen px past the arc (0 = on it).
- `<Guide x? | y? | from + to  progress={1} color? dashed={true} width={1.5} opacity? />`: alignment guide: `x` =
  vertical line across the canvas, `y` = horizontal, or a segment; draws from the left/top (or `from`).
- `<Highlight x y width height radius={12} pad={4} label? progress={1} color? fill={0.05} />`: outline around an
  element's box (snaps in from slightly larger), soft ring, optional mono tag on its top-left corner.

```tsx
<Guide y={474} progress={a(0.2, 0.8)} dashed={false} />                        // baseline across the card
<Callout from={{ x: 830, y: 474 }} to={{ x: 905, y: 358 }} elbow={20} variant="tag" label="Baseline alignment" progress={a(0.6, 1.2)} />
<Highlight x={624} y={690} width={672} height={56} radius={10} label="card.footer" progress={hoverFooter} />
```

## Cursor

- `cursorAt(t, path, arc = 0.12): Point`: position along keyframes `path: { t, x, y, ease? }[]` (moves ease in-out
  and bow by `arc × distance`, like a hand on a mouse; 0 = straight). Use it to drive hover states.
- `cursorPress(t, clicks): number`: 0 to 1 to 0 around each click time (down 80 ms before, released 200 ms after).
- `<Cursor t path clicks? hover={0} size={30} ripple? arc? opacity? />`: macOS-style arrow at `cursorAt`,
  shrinks while pressed; `hover` from 0 to 1 cross-fades to the pointing hand; `ripple` adds a ClickRipple per click.
- `<ClickRipple x y t at color? size={34} duration={0.5} />`: expanding ring from time `at`.

```tsx
const PATH = [{ t: 0, x: 1500, y: 980 }, { t: 0.9, x: 1250, y: 770 }, { t: 1.8, x: 1560, y: 780, ease: ease.inOutQuart }];
const CLICKS = [music.snap(2.1, 'half')];
const onSave = progress(t, 1.6, 1.8);                                  // the cursor reaches Save at 1.8 s
<ui.Button hovered={onSave > 0.5} pressed={cursorPress(t, CLICKS) > 0.5} style={{ position: 'absolute', left: 1500, top: 750 }}>Save</ui.Button>
<Highlight x={624} y={690} width={672} height={56} label="card.footer" progress={progress(t, 0.8, 1.0)} />
<Cursor t={t} path={PATH} clicks={CLICKS} hover={onSave} ripple />
```

## Frames & finishing

- `<BrowserFrame width height url? dark? radius={14} style? className?>page</BrowserFrame>`: browser window
  (traffic lights, address bar); the page gets `width × (height − 52)`. Position it with `style`.
- `<PhoneFrame width={400} height? color? screen="#fff" time="9:41" | false darkScreen? style? className?>screen</PhoneFrame>`
  : phone with dynamic island and status bar; children fill the screen (keep ~0.13 × width free at the top).
- `<Grain seed={0} t? fps={12} opacity={0.08} frequency={0.85} blend="overlay" />`: film grain over the canvas
  against banding in dark gradients; static per seed, animated only when you pass `t`.
- `<Vignette color="#000" strength={0.45} size={0.55} />`: darkens the edges.

## Seam checklist

Consecutive scenes cut hard: when something continues across a cut, the last frame (t = duration) must equal the
next scene's first frame (t = 0). Share positions/sizes/copy through `components/`; end 3D moves, camera moves and
swaps exactly at rest (progress 0 or 1): Stage3D, Camera, SwapWords and TypeOn then render exactly what a plain
flat layout renders; no leftover filters, transforms or opacity at the cut. `check_seams` measures the share of
pixels that change at a cut: a cut is invisible below 0.05 %.
