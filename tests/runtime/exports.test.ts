import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as cadence from '../../src/runtime/index';
import type { SoundCue, SoundName, SoundProps } from '../../src/runtime/index';
import { SOUND_NAMES } from '../../src/shared/sounds';

const PATH_TOOLS = [
  ...['parsePath', 'getLength', 'getPointAtLength', 'getTangentAtLength', 'evolvePath'],
  ...['rectPath', 'roundedRect', 'circle', 'ellipse', 'polygon', 'star', 'triangle', 'pie'],
];

// The exports ARCHITECTURE.md promises to scenes, templates and the frame page.
const REQUIRED = [
  ...['progress', 'interpolate', 'keyframes', 'spring', 'springs', 'springDuration', 'ease', 'bezier', 'mix', 'clamp'],
  ...['remap', 'stagger', 'staggerFrom', 'loop', 'pingpong'],
  ...['parseColor', 'toHex', 'mixColor', 'interpolateColor', 'withAlpha'],
  ...['random', 'randomRange', 'noise', 'noise2'],
  ...['SplitText', 'typed', 'measureText', 'TypeOn', 'SwapWords', 'Counter'],
  ...['Fill', 'SceneContext', 'useScene', 'BrandContext', 'useBrand', 'useFormat', 'asset', 'setAssetBase'],
  ...['Stage3D', 'Camera', 'DrawPath', 'Glow', 'Callout', 'Dimension', 'RadiusArc', 'Guide', 'Tag', 'Highlight'],
  ...['Cursor', 'ClickRipple', 'BrowserFrame', 'PhoneFrame', 'Grain', 'Vignette', 'MotionBlur'],
  ...PATH_TOOLS,
  'createMusic',
  'voiceLevel',
];

test('index exports everything the architecture requires', () => {
  const missing = REQUIRED.filter((name) => !(name in cadence));
  assert.deepEqual(missing, []);
});

test('API.md documents every path tool and shape', () => {
  const api = fs.readFileSync(new URL('../../src/runtime/API.md', import.meta.url), 'utf8');
  const section = api.slice(api.indexOf('## Paths & shapes'), api.indexOf('## Annotations'));
  assert.ok(api.includes('## Paths & shapes'));
  for (const name of PATH_TOOLS) assert.ok(section.includes(`\`${name}(`), name);
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

test('API.md documents music.spectrum, its band count and its pending error', () => {
  const api = fs.readFileSync(new URL('../../src/runtime/API.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const section = api.slice(api.indexOf('## Music'), api.indexOf('## Voice-over'));
  for (const rule of ['music.spectrum(t, bands = 24)', 'from 1 to 24', '40 Hz to 11 kHz', 'MusicAnalysisPending', 'zeros']) {
    assert.ok(section.includes(rule), rule);
  }
});

test('API.md documents MotionBlur', () => {
  const api = fs.readFileSync(new URL('../../src/runtime/API.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const rule of [
    '<MotionBlur t={t} fps={fps}',
    'samples={8}',
    'shutter={0.5}',
    '1 to 16',
    'opaque background inside',
    'positioned box around the path only',
    '`samples={1}` outside the move',
    'never nest',
    "`useId()` called inside the render prop's own component",
  ]) {
    assert.ok(api.includes(rule), rule);
  }
});
