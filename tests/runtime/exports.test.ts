import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as cadence from '../../src/runtime/index';

// The exports ARCHITECTURE.md promises to scenes, templates and the frame page.
const REQUIRED = [
  ...['progress', 'interpolate', 'keyframes', 'spring', 'springs', 'springDuration', 'ease', 'bezier', 'mix', 'clamp'],
  ...['remap', 'stagger', 'staggerFrom', 'loop', 'pingpong'],
  ...['parseColor', 'toHex', 'mixColor', 'interpolateColor', 'withAlpha'],
  ...['random', 'randomRange', 'noise', 'noise2'],
  ...['SplitText', 'typed', 'measureText', 'TypeOn', 'SwapWords', 'Counter'],
  ...['Fill', 'SceneContext', 'useScene', 'BrandContext', 'useBrand', 'useFormat', 'asset', 'setAssetBase'],
  ...['Stage3D', 'Camera', 'DrawPath', 'Glow', 'Callout', 'Dimension', 'RadiusArc', 'Guide', 'Tag', 'Highlight'],
  ...['Cursor', 'ClickRipple', 'BrowserFrame', 'PhoneFrame', 'Grain', 'Vignette'],
  'createMusic',
];

test('index exports everything the architecture requires', () => {
  const missing = REQUIRED.filter((name) => !(name in cadence));
  assert.deepEqual(missing, []);
});

test('API.md warns about what renders do differently from the preview', () => {
  const api = fs.readFileSync(new URL('../../src/runtime/API.md', import.meta.url), 'utf8');
  for (const rule of [
    'always pass an explicit locale to `Intl.*` and `toLocale*()`',
    'GIF/WebP/SVG images freeze on their first frame',
    'Its cost grows with the extent of its children',
    'a cut is invisible below 0.05 %',
    'gate it with `music.hasTrack`',
  ]) {
    assert.ok(api.replace(/\s+/g, ' ').includes(rule), rule);
  }
});
