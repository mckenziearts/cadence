// The preset soundtracks in src/editor/soundtracks: the manifest is what the generator lists, every file is there, and
// Cadence's analyzer reads each version on its composed grid (tempo, beats, bar ones), the reason they are composed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeMusic } from '../../server/music/analyze';
import { median } from '../../server/music/beats';
import { soundtracks, type Soundtrack } from '../../server/music/soundtracks';
import { hasFfmpeg } from './synth';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/editor/soundtracks');
const presets = JSON.parse(readFileSync(path.join(DIR, 'presets.json'), 'utf8')) as Soundtrack[];
const skip = hasFfmpeg ? false : 'ffmpeg introuvable';

test('presets.json lists what the generator composes, and every file is there', () => {
  assert.deepEqual(presets, soundtracks());
  for (const preset of presets) {
    for (const version of preset.versions) assert.ok(existsSync(path.join(DIR, version.file)), `${version.file} manquant`);
  }
});

for (const preset of presets) {
  test(`${preset.name}: ${preset.bpm} BPM in 4/4, beats and bar ones on the composed grid`, { skip }, async () => {
    const beat = 60 / preset.bpm;
    /** Distance to the nearest multiple of `unit`. */
    const off = (t: number, unit: number) => Math.min(t % unit, unit - (t % unit));
    for (const version of preset.versions) {
      const a = await analyzeMusic(path.join(DIR, version.file), 'ffmpeg');
      // The final bar rings out without a beat: judge the grid before it.
      const before = (times: number[]) => times.filter((t) => t < version.duration - 4 * beat);
      assert.ok(Math.abs(a.bpm - preset.bpm) < 0.5, `${version.file} : ${a.bpm} BPM`);
      assert.equal(a.beatsPerBar, 4, version.file);
      const beatError = median(before(a.beats).map((t) => off(t, beat)));
      assert.ok(beatError < 0.02, `${version.file} : temps à ${Math.round(beatError * 1000)} ms de la grille`);
      const barError = median(before(a.downbeats).map((t) => off(t, 4 * beat)));
      assert.ok(barError < 0.02, `${version.file} : mesures à ${Math.round(barError * 1000)} ms de la grille`);
    }
  });
}
