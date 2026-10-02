# Art direction: Cadence (neutral preset)

Clear, precise, centered on the product. One idea per scene; the cut between two scenes must be invisible whenever
an object carries on from one scene to the next.

## Canvas and palette

- Background `#fafafa` in every scene, never pure white: white cards stay readable and cuts stay seamless.
- Ink `#0a0a0a`; secondary text `#8a8a8f`; quiet text `#a1a1aa`; hairlines `#e6e6e9`.
- Primary buttons in black `#18181b`, with white text.
- A single accent: pink `#ff2e88`, kept for annotations, flashes, text carets and scan lines. Blue `#3b82f6` only
  appears in timelines (the playhead).
- Success `#00bc7d`, warning `#fe9a00`, error `#fb2c36`: for statuses only, never as decoration.

## Typography (1920 × 1080 canvas)

| Role | Font | Size | Settings |
| --- | --- | --- | --- |
| Scene title | Inter Display 700 | 104 px | -0.045 em, line height 1, centered, top of the line at y = 118 |
| Subtitle | Inter 600 | 46 px | -0.03 em, `#a1a1aa` |
| Key figure | Inter 700 | 60-160 px | -0.04 em, tabular figures |
| Interface text | Geist 400-600 | 17-23 px | inside cards only |
| Labels, tags | JetBrains Mono 500 | 14-16 px | capitals, +0.1 em |
| Annotation caption | Geist 500 | 22 px | `#3f3f46` |

No text under 16 px on screen. A title fits on one line; beyond that, split the sentence across two scenes.

## Layout

- Generous margins: nothing closer than about 120 px to the edge, except in full-frame moments.
- One main card, centered (620-680 px wide). Reuse it from scene to scene at the same place rather than moving it:
  it carries the continuity.
- Annotations live around the card, on an 8 px grid.

## Motion

- Personality: calm and exact, like precision mechanics. No gratuitous bounce, no shake.
- Entrances: `ease.outExpo` (0.4-0.9 s) or `springs.snappy` springs for the interface; exits: `ease.inCubic`,
  faster than entrances (0.25-0.45 s).
- Large camera moves (3D tilts, lifts): `ease.smooth`, 0.8-1.4 s.
- Offset between linked elements: 45-100 ms. Overlap motions rather than chaining them.
- Titles swap word by word (`SwapWords`): the old word rises and fades, the new one rises from behind a mask.
- Style changes wipe from left to right behind a thin pink line, instead of a color fade.
- Annotations draw from the part outward (dot, then elbow, then label); the label appears last and leaves first.

## Music

- Clicks land on half beats (`music.snap(t, 'half')`), key frames on beats, logo pulses on the bars of a real track
  (`music.hasTrack`, `music.pulse(t, { grid: 'bar' })`). Without a track, the grid follows the project tempo from
  the start of each scene.

## Do

- One idea per shot, said by the title and shown by the card.
- White cards on the `#fafafa` background, with long soft shadows.
- The pink accent stays rare: one element at a time.

## Don't

- Colored gradients, a second accent, dark backgrounds outside full-frame moments.
- Hard shadows, thick outlines, rotations without a reason.
- Text that blinks or shakes; only the text caret blinks.

## Seams

- Every cut is designed to be invisible (0 % with `check_seams`): the first frame of a scene rebuilds the last frame
  of the one before exactly (same components, same positions, no leftover transform).
