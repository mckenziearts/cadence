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
  MAX_CLIP_LAYERS,
  MAX_SOUND_CUES,
  SOUND_NAMES,
  SOUND_PEAKS,
  parseSoundCues,
  videoSoundCues,
  type SoundName,
} from '../../src/shared/sounds';
import type { ClipState } from '../../src/shared/types';

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
  assert.deepEqual(parseSoundCues(value, 4, texts(), {}), {
    cues: [
      { at: 0, sound: 'click', gain: 1 },
      { at: 2.5, sound: 'whoosh', gain: 0.4 },
      { at: 4, sound: 'impact', gain: 0 },
      { at: 4, sound: 'key', gain: 1 },
    ],
  });
  assert.deepEqual(parseSoundCues([], 4, texts(), {}), { cues: [] });
});

test('parseSoundCues accepts the maximum number of cues and refuses one more', () => {
  setLanguage('en');
  const cues = Array.from({ length: MAX_SOUND_CUES }, (_, i) => ({ at: i / 1000, sound: 'pop' }));
  assert.equal(MAX_SOUND_CUES, 1000);
  assert.ok('cues' in parseSoundCues(cues, 1, texts(), {}));
  const result = parseSoundCues([...cues, { at: 0, sound: 'pop' }], 1, texts(), {});
  assert.ok('error' in result && result.error.includes('1000'), JSON.stringify(result));
});

test('parseSoundCues takes another maximum when the caller gives one', () => {
  setLanguage('en');
  const cues = Array.from({ length: 2 * MAX_SOUND_CUES }, () => ({ at: 0, sound: 'pop' }));
  assert.ok('cues' in parseSoundCues(cues, 1, texts(), {}, 2 * MAX_SOUND_CUES));
  const result = parseSoundCues([...cues, { at: 0, sound: 'pop' }], 1, texts(), {}, 2 * MAX_SOUND_CUES);
  assert.ok('error' in result && result.error.includes('2000'), JSON.stringify(result));
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
      const result = parseSoundCues([{ at: 0, sound: 'click' }, { at: 1, sound: 'key' }, cue], 4, texts(), {});
      assert.ok('error' in result, JSON.stringify(result));
      assert.match(result.error, /\b2\b/, result.error);
    }
  });
}

test('parseSoundCues shows the unknown sound it received as a literal, or its type when it is no string', () => {
  for (const language of ['en', 'fr'] as const) {
    setLanguage(language);
    const result = parseSoundCues([{ at: 1, sound: 'boing' }], 4, texts(), {});
    assert.ok('error' in result && /"boing" \(click, key, pop, whoosh, impact\)/.test(result.error), JSON.stringify(result));
  }
  setLanguage('en');
  for (const [sound, shown] of [
    [3, 'unknown sound number'],
    [undefined, 'unknown sound undefined'],
    [{ name: 'pop' }, 'unknown sound object'],
    ['a\nb', 'unknown sound "a\\nb"'],
  ] as const) {
    const result = parseSoundCues([{ at: 1, sound }], 4, texts(), {});
    assert.ok('error' in result && result.error.includes(shown), JSON.stringify(result));
  }
});

test('parseSoundCues shows only the first 40 characters of an unknown sound', () => {
  setLanguage('en');
  // Emoji take two UTF-16 units each: a cut by units would show 20 of them.
  const result = parseSoundCues([{ at: 1, sound: `${'\u{1F600}'.repeat(41)}${'x'.repeat(10_000)}` }], 4, texts(), {});
  assert.ok('error' in result, JSON.stringify(result));
  assert.ok(result.error.includes(`unknown sound "${'\u{1F600}'.repeat(40)}" (`), result.error);
});

test('parseSoundCues refuses anything but an array', () => {
  setLanguage('en');
  for (const value of [undefined, null, {}, 'click', 3]) {
    const result = parseSoundCues(value, 4, texts(), {});
    assert.ok('error' in result && result.error.length > 0, JSON.stringify(result));
  }
});

/** A 3 s clip with sound, one still being prepared, one that failed, one without sound. */
const CLIPS: Record<string, ClipState> = {
  'demo/talk.mp4': {
    status: 'ready',
    key: 'talk-0123456789ab',
    fps: 30,
    frames: 90,
    width: 320,
    height: 240,
    duration: 3,
    audio: true,
  },
  'busy.mp4': { status: 'preparing' },
  'broken.mov': { status: 'error', error: 'moov atom not found' },
  'mute.gif': {
    status: 'ready',
    key: 'mute-000000000000',
    fps: 10,
    frames: 20,
    width: 32,
    height: 32,
    duration: 2,
    audio: false,
  },
};

test('parseSoundCues resolves a clip cue: from 0 by default, heard to the clip end or the scene end, whichever comes first', () => {
  setLanguage('en');
  const value = [
    { at: 0, clip: 'demo/talk.mp4' },
    { at: 1, clip: '/demo/talk.mp4', from: 2.5, gain: 0.5 },
    { at: 0.5, clip: 'demo/talk.mp4', from: 1, duration: 0.25 },
    { at: 2.5, clip: 'demo/talk.mp4', from: 0.5, duration: 2 },
    { at: 4, clip: 'demo/talk.mp4' },
    { at: 2, sound: 'pop' },
  ];
  assert.deepEqual(parseSoundCues(value, 4, texts(), CLIPS), {
    cues: [
      { at: 0, clip: 'demo/talk.mp4', from: 0, duration: 3, gain: 1 },
      { at: 1, clip: 'demo/talk.mp4', from: 2.5, duration: 0.5, gain: 0.5 },
      { at: 0.5, clip: 'demo/talk.mp4', from: 1, duration: 0.25, gain: 1 },
      { at: 2.5, clip: 'demo/talk.mp4', from: 0.5, duration: 1.5, gain: 1 },
      { at: 2, sound: 'pop', gain: 1 },
    ],
  });
});

test('parseSoundCues counts clip cues in the maximum', () => {
  setLanguage('en');
  const cues = Array.from({ length: MAX_SOUND_CUES }, () => ({ at: 0, clip: 'demo/talk.mp4', duration: 0.001 }));
  assert.ok('cues' in parseSoundCues(cues, 1, texts(), CLIPS));
  const result = parseSoundCues([...cues, { at: 0, clip: 'demo/talk.mp4' }], 1, texts(), CLIPS);
  assert.ok('error' in result && result.error.includes('1000'), JSON.stringify(result));
});

test('parseSoundCues refuses clip cues heard more than 8 times the scene length in all, what the mix can add at once', () => {
  assert.equal(MAX_CLIP_LAYERS, 8);
  // On a 2 s scene each cue is heard 2 s: eight fill the 16 s allowed.
  const layers = (n: number) => Array.from({ length: n }, () => ({ at: 0, clip: 'demo/talk.mp4' }));
  assert.ok('cues' in parseSoundCues(layers(8), 2, texts(), CLIPS));
  for (const language of ['en', 'fr'] as const) {
    setLanguage(language);
    assert.deepEqual(parseSoundCues(layers(9), 2, texts(), CLIPS), { error: texts().clipTotal(16) });
    // What the scene end cuts does not count.
    assert.ok('cues' in parseSoundCues([...layers(8), { at: 2, clip: 'demo/talk.mp4' }], 2, texts(), CLIPS));
  }
  assert.match(texts().clipTotal(16), /sounds\(\) : .*16 s/);
  setLanguage('en');
  assert.match(texts().clipTotal(16), /sounds\(\): .*16 s/);
});

const invalidClips: [string, unknown, RegExp, RegExp][] = [
  [
    'both a sound and a clip',
    { at: 1, sound: 'pop', clip: 'demo/talk.mp4' },
    /sound or clip, not both/,
    /sound ou clip, pas les deux/,
  ],
  [
    'an unknown clip',
    { at: 1, clip: 'demo/none.mp4' },
    /clip "demo\/none\.mp4" is not a video/,
    /clip "demo\/none\.mp4" n’est pas/,
  ],
  ['a clip that is not a string', { at: 1, clip: 3 }, /clip number is not a video/, /clip number n’est pas/],
  ['a clip inherited from Object', { at: 1, clip: 'toString' }, /clip "toString" is not/, /clip "toString" n’est pas/],
  ['a clip being prepared', { at: 1, clip: 'busy.mp4' }, /assets\/busy\.mp4 is being prepared/, /assets\/busy\.mp4 est en cours/],
  ['a clip that failed', { at: 1, clip: 'broken.mov' }, /assets\/broken\.mov: moov atom not found/, /assets\/broken\.mov : moov/],
  ['a clip without sound', { at: 1, clip: 'mute.gif' }, /assets\/mute\.gif has no sound/, /assets\/mute\.gif n’a pas de son/],
  [
    'from negative',
    { at: 1, clip: 'demo/talk.mp4', from: -0.1 },
    /from must .* below 3, the length of assets\/demo\/talk\.mp4/,
    /from doit/,
  ],
  ['from at the clip end', { at: 1, clip: 'demo/talk.mp4', from: 3 }, /from must/, /from doit/],
  ['from past the clip end', { at: 1, clip: 'demo/talk.mp4', from: 7 }, /from must/, /from doit/],
  ['from a string', { at: 1, clip: 'demo/talk.mp4', from: '1' }, /from must/, /from doit/],
  ['from NaN', { at: 1, clip: 'demo/talk.mp4', from: Number.NaN }, /from must/, /from doit/],
  ['duration 0', { at: 1, clip: 'demo/talk.mp4', duration: 0 }, /duration must be a number of seconds above 0/, /duration doit/],
  ['duration negative', { at: 1, clip: 'demo/talk.mp4', duration: -1 }, /duration must/, /duration doit/],
  ['duration a string', { at: 1, clip: 'demo/talk.mp4', duration: '1' }, /duration must/, /duration doit/],
  ['a clip at past the scene', { at: 4.5, clip: 'demo/talk.mp4' }, /at must/, /at doit/],
  ['a clip gain above 1', { at: 1, clip: 'demo/talk.mp4', gain: 2 }, /gain must/, /gain doit/],
];

for (const [label, cue, en, fr] of invalidClips) {
  test(`parseSoundCues names the index and the problem of a cue with ${label}`, () => {
    for (const [language, expected] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      setLanguage(language);
      const result = parseSoundCues([{ at: 0, sound: 'click' }, { at: 1, clip: 'demo/talk.mp4' }, cue], 4, texts(), CLIPS);
      assert.ok('error' in result, JSON.stringify(result));
      assert.match(result.error, /\b2\b/, result.error);
      assert.match(result.error, expected, result.error);
    }
  });
}

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
