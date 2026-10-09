import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as cadence from '../../src/runtime/index';
import type { SoundCue, SoundName, SoundProps } from '../../src/runtime/index';
import { SOUND_NAMES } from '../../src/shared/sounds';

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
  'voiceLevel',
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

test('the runtime exports the sound types, and API.md documents sound effects', () => {
  // Type-checked by `npm run typecheck`: what a scene writes, `gain` left out.
  const sounds = (props: SoundProps): SoundCue[] => [{ at: props.music.beat(1), sound: 'click' satisfies SoundName }];
  assert.equal(typeof sounds, 'function');
  assert.equal('SOUND_NAMES' in cadence, false, 'types only');

  const api = fs.readFileSync(new URL('../../src/runtime/API.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const section = api.slice(api.indexOf('## Sound effects'));
  assert.ok(api.includes('## Sound effects'));
  for (const rule of [
    'export function sounds(props: SoundProps): SoundCue[]',
    '`at` is the contact',
    'the loudest point of a whoosh',
    '`gain`',
    'one function',
    'a sound per meaningful contact, not per beat',
  ]) {
    assert.ok(section.includes(rule), rule);
  }
  for (const name of SOUND_NAMES) assert.ok(section.includes(`- \`${name}\``), name);
});

test('API.md documents the voice-over line fields and voiceLevel', () => {
  const api = fs.readFileSync(new URL('../../src/runtime/API.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const section = api.slice(api.indexOf('## Voice-over'), api.indexOf('## Sound effects'));
  for (const rule of ['`speaker`', '`words`', '`level`', '`gesture`', 'voiceLevel(voiceOver, t, speaker?)', '0 to 1']) {
    assert.ok(section.includes(rule), rule);
  }
});
