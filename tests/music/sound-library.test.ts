// The sound effects in src/editor/sounds: each file is what the generator writes byte for byte, in the format the mix
// expects, with its loudest sample where SOUND_PEAKS says; and the cue contract scenes return from `sounds()`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLanguage, m } from '../../server/i18n';
import { writeSounds } from '../../server/sounds/library';
import { readWav } from '../../server/voiceover/wav';
import {
  MAX_SOUND_CUES,
  SOUND_NAMES,
  SOUND_PEAKS,
  parseSoundCues,
  videoSoundCues,
  type SoundName,
} from '../../src/shared/sounds';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/editor/sounds');

/** Peak levels in dBFS: the loudest, impact, keeps 0.2 dB under the -1 dBFS ceiling. */
const LEVELS: Record<SoundName, number> = { click: -6, key: -8, pop: -4, whoosh: -3, impact: -1.2 };

test('the library has the five sounds', () => {
  assert.deepEqual([...SOUND_NAMES], ['click', 'key', 'pop', 'whoosh', 'impact']);
});

for (const name of SOUND_NAMES) {
  test(`${name}.wav: 16-bit mono at 44.1 kHz, under 1.5 s, peak at ${LEVELS[name]} dBFS, loudest sample at its declared peak`, () => {
    const data = readFileSync(path.join(DIR, `${name}.wav`));
    assert.equal(data.readUInt16LE(22), 1, 'mono');
    assert.equal(data.readUInt16LE(34), 16, '16-bit');
    const { sampleRate, samples } = readWav(data);
    assert.equal(sampleRate, 44100);
    assert.ok(samples.length > 0 && samples.length / sampleRate < 1.5, `${samples.length / sampleRate} s`);
    let loudest = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]) > Math.abs(samples[loudest])) loudest = i;
    const dbfs = 20 * Math.log10(Math.abs(samples[loudest]) / 32768);
    assert.ok(Math.abs(dbfs - LEVELS[name]) < 0.01, `${dbfs.toFixed(3)} dBFS`);
    assert.ok(
      Math.abs(loudest / sampleRate - SOUND_PEAKS[name]) <= 1 / sampleRate,
      `peak at ${(loudest / sampleRate).toFixed(6)} s`,
    );
  });
}

test('the committed files are what `npm run cadence -- sounds` writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-sounds-'));
  try {
    await writeSounds(dir);
    for (const name of SOUND_NAMES) {
      assert.ok((await fs.readFile(path.join(dir, `${name}.wav`))).equals(readFileSync(path.join(DIR, `${name}.wav`))), name);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const texts = () => m().media.sounds.cues;

test('parseSoundCues keeps valid cues and defaults gain to 1', () => {
  setLanguage('en');
  const value = [
    { at: 0, sound: 'click' },
    { at: 2.5, sound: 'whoosh', gain: 0.4 },
    { at: 4, sound: 'impact', gain: 0 },
    { at: 4, sound: 'key', gain: 1 },
  ];
  assert.deepEqual(parseSoundCues(value, 4, texts()), {
    cues: [
      { at: 0, sound: 'click', gain: 1 },
      { at: 2.5, sound: 'whoosh', gain: 0.4 },
      { at: 4, sound: 'impact', gain: 0 },
      { at: 4, sound: 'key', gain: 1 },
    ],
  });
  assert.deepEqual(parseSoundCues([], 4, texts()), { cues: [] });
});

test('parseSoundCues accepts the maximum number of cues and refuses one more', () => {
  setLanguage('en');
  const cues = Array.from({ length: MAX_SOUND_CUES }, (_, i) => ({ at: i / 1000, sound: 'pop' }));
  assert.equal(MAX_SOUND_CUES, 1000);
  assert.ok('cues' in parseSoundCues(cues, 1, texts()));
  const result = parseSoundCues([...cues, { at: 0, sound: 'pop' }], 1, texts());
  assert.ok('error' in result && result.error.includes('1000'), JSON.stringify(result));
});

const invalid: [string, unknown][] = [
  ['not an object', 'click'],
  ['null', null],
  ['at missing', { sound: 'click' }],
  ['at a string', { at: '1', sound: 'click' }],
  ['at NaN', { at: Number.NaN, sound: 'click' }],
  ['at infinite', { at: Number.POSITIVE_INFINITY, sound: 'click' }],
  ['at negative', { at: -0.01, sound: 'click' }],
  ['at past the duration', { at: 4.01, sound: 'click' }],
  ['unknown sound', { at: 1, sound: 'boing' }],
  ['sound missing', { at: 1 }],
  ['gain above 1', { at: 1, sound: 'pop', gain: 1.5 }],
  ['gain negative', { at: 1, sound: 'pop', gain: -0.1 }],
  ['gain NaN', { at: 1, sound: 'pop', gain: Number.NaN }],
  ['gain a string', { at: 1, sound: 'pop', gain: '0.5' }],
];

for (const [label, cue] of invalid) {
  test(`parseSoundCues names the index of a cue with ${label}`, () => {
    for (const language of ['en', 'fr'] as const) {
      setLanguage(language);
      const result = parseSoundCues([{ at: 0, sound: 'click' }, { at: 1, sound: 'key' }, cue], 4, texts());
      assert.ok('error' in result, JSON.stringify(result));
      assert.match(result.error, /\b2\b/, result.error);
    }
  });
}

test('parseSoundCues shows the unknown sound it received as a literal, or its type when it is no string', () => {
  for (const language of ['en', 'fr'] as const) {
    setLanguage(language);
    const result = parseSoundCues([{ at: 1, sound: 'boing' }], 4, texts());
    assert.ok('error' in result && /"boing" \(click, key, pop, whoosh, impact\)/.test(result.error), JSON.stringify(result));
  }
  setLanguage('en');
  for (const [sound, shown] of [
    [3, 'unknown sound number'],
    [undefined, 'unknown sound undefined'],
    [{ name: 'pop' }, 'unknown sound object'],
    ['a\nb', 'unknown sound "a\\nb"'],
  ] as const) {
    const result = parseSoundCues([{ at: 1, sound }], 4, texts());
    assert.ok('error' in result && result.error.includes(shown), JSON.stringify(result));
  }
});

test('parseSoundCues refuses anything but an array', () => {
  setLanguage('en');
  for (const value of [undefined, null, {}, 'click', 3]) {
    const result = parseSoundCues(value, 4, texts());
    assert.ok('error' in result && result.error.length > 0, JSON.stringify(result));
  }
});

test('videoSoundCues shifts each scene by its start, rounds, skips scenes in error and sorts', () => {
  assert.deepEqual(
    videoSoundCues([
      { start: 0, sounds: { cues: [{ at: 1.5, sound: 'whoosh', gain: 1 }] } },
      { start: 0.1, sounds: { cues: [{ at: 0.2, sound: 'pop', gain: 0.5 }] } },
      { start: 2, sounds: { error: 'sounds() threw' } },
      { start: 1, sounds: { cues: [{ at: 0, sound: 'click', gain: 1 }] } },
    ]),
    [
      { at: 0.3, sound: 'pop', gain: 0.5 },
      { at: 1, sound: 'click', gain: 1 },
      { at: 1.5, sound: 'whoosh', gain: 1 },
    ],
  );
  assert.deepEqual(videoSoundCues([]), []);
});
