# Cadence kit (neutral default)

The look of the reference teaser: near-white canvas, white cards with long soft shadows, black buttons, one pink
accent. Use it when a project has no brand, or for Cadence's own videos.

```tsx
const { ui, colors, fonts, radius, Logo, extras } = brand; // or useBrand()
import { PromptCard, ProfileCard, MediaCard, MenuDots, Landscape } from '@brands/cadence';
import { tone, shadow } from '@brands/cadence/tokens'; // extra greys + shadows of the reference look
```

Every size is video scale (1920×1080): UI text 17–23 px, buttons 52 px high, inputs 56 px. Every component takes
`style` and `className`, merged last: position and transform through `style`. Pressed buttons use the CSS `scale`
property, so your own `transform` is never overwritten. Nothing animates by itself: drive every state from `t`.

## Tokens

- Colors: background `#fafafa`, surface `#ffffff`, ink `#0a0a0a`, muted `#8a8a8f`, line `#e6e6e9`, primary
  `#18181b` (black buttons), accent `#ff2e88` (annotations, carets, scan lines — one at a time).
- `tone`: chip `#f4f4f5`, chipInk `#52525b`, inset `#fafafa`, text `#3f3f46`, hint `#a1a1aa`, border `#e4e4e7`,
  blue `#3b82f6` (timeline playhead only).
- `shadow.card` for resting cards, `shadow.lifted` for a card raised toward the camera.
- Fonts: display Inter (Display optical size kicks in automatically above ~30 px), body Geist, mono JetBrains Mono.
- Radius: sm 8, md 12, lg 16, xl 22 (cards).
- Tailwind classes work too: `bg-background`, `text-ink`, `text-muted`, `bg-accent`, `font-display`, `rounded-xl`,
  `shadow-card`, `bg-chip`.

## Components

- `Card` — `variant`: `default` (white, hairline, soft shadow), `muted` (the reference card: grey frame, `CardBody`
  becomes a white inset panel), `outline`, `elevated` (no border, bigger shadow). `padding` default 28.
  - `CardHeader`: title row, 22 px / 600, flex space-between. Put the title (and a muted subtitle in its own
    `<div style={{ fontSize: 18, fontWeight: 400, color: colors.muted }}>`) left, a `Badge` or `MenuDots` right.
  - `CardBody`: 20 px text; stack fields with `style={{ display: 'flex', flexDirection: 'column', gap: 24 }}`.
  - `CardFooter`: flex row aligned right, gap 12. Status text first with `style={{ marginRight: 'auto' }}`.
- `Button` — `variant` primary (black) | secondary (white + border) | ghost | danger; `size` sm 42 / md 52 / lg 64;
  `hovered`, `pressed`; `icon` (a ~20 px element, e.g. lucide-react `<Plus size={20} />`).
- `Input` — `label`, `value`, `placeholder`, `focused` (dark border + soft ring), `caret` (pink, zero-width: blink it
  by toggling from `t`, type with `typed()`), `invalid` + `hint`, `multiline` (136 px).
- `Badge` — `tone` neutral | primary (black) | success | warning | danger. 34 px, radius 8.
- `Avatar` — initials on a neutral disc (stable per name) or `src={asset('olivia.png')}`; `size` 56.
- `Stat` — `label`, `value` (Inter 60 px bold, tabular), `delta` with an arrow; `trend` is inferred from the sign
  of `delta` when omitted.
- `Toggle` — `on` true/false, or a 0..1 number to slide the knob (`on={progress(t, 1.2, 1.4)}`).
- `Tabs` — segmented control with equal-width segments. `active` may be fractional: `active={mix(0, 2, p)}` slides
  the white indicator and cross-fades the labels.
- `ListItem` — `leading` (Avatar/icon), `title`, `subtitle`, `trailing` (Badge/amount), `selected` (grey fill).
- `Logo` — `variant` mark | full, `height` (64), `color` for a one-color version (the mark becomes a knocked-out
  squircle: pass `#ffffff` on dark backgrounds). The mark is three clips on a timeline crossed by the pink playhead;
  animate the lockup by revealing the clips left to right, then the playhead.

## Extras

- `ProfileCard` — the reference profile card: "Profile / This is how others see you", fields Name and Bio,
  footer "Saved 2 minutes ago", then Cancel and Save. Props: `variant` (muted), `name`, `bio`, `focus`
  ("name" | "bio"), `caret`, `pressed` / `hovered` ("save" | "cancel"), `saved`, `width` (620). Use it for "every
  part in its place", style swaps (animate `variant` changes with a left-to-right wipe) and typing beats.
- `PromptCard` — a scene prompt card, 680×340 (`PROMPT_CARD`), built from absolute layers. Props: `title`,
  `subtitle`, `prompt`, `chars` (typing: `Math.floor(typed progress * length)`), `caret`, `duration` ("3.32 s"),
  `pressed`, `hovered`, `explode` (0..1 separates the layers in Z — wrap it in `Stage3D` and tilt ~50° for an
  exploded view).
- `MediaCard` — photo card with an SVG sunset over dunes (no image file). Props: `title`, `caption`, `bleed`
  (0 inset → 1 edge to edge: the "Full bleed" beat), `sun` (0..1 height, animate for a sunrise), `width` (560).
  `Landscape` alone fills any box (full-frame transition after the bleed).
- `MenuDots` — the "…" menu icon used in card headers.

## Copy

- Taglines: "Every scene is code.", "Written to the millisecond.", "Timed to the music.", "One brand, every format."
- Running headline pattern from the reference: "Every ..." stays and the tail swaps ("Every scene is code.", then
  "Every part in its place", "Every style", "Every beat.").
- Features: Scenes in code, On the beat, Invisible cuts, Every format.

## Do / Don't

- Do keep one main card centred and reuse it across scenes; annotate around it in pink.
- Do use `muted` cards for product shots and `default` cards for single floating objects.
- Don't put the pink accent on buttons or large surfaces; don't mix blue in outside timelines.
- Don't shrink UI below its video size to fit more; cut to another scene instead.
