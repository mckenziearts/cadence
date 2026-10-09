// The real Piper, when this machine has it: CADENCE_TEST_PIPER_VOICE=<a voice .onnx> (and PIPER_PATH if `piper` is not
// on the PATH). Skipped otherwise: the other voice-over tests use a fake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PiperEngine } from '../../server/voiceover/piper';
import { wavSeconds } from '../../server/voiceover/wav';

const model = process.env.CADENCE_TEST_PIPER_VOICE;

test('a missing Piper says how to install it', async () => {
  const state = await new PiperEngine('/nonexistent/piper').check();
  assert.equal(state.ok, false);
  assert.match(state.error ?? '', /pipx install piper-tts/);
});

test('a Piper that dies before reading its text fails the voice-over, not the server', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-piper-'));
  try {
    // Gone at once: the sentences, more than a pipe buffer holds, meet a closed pipe (EPIPE).
    const bin = path.join(dir, 'piper');
    await fs.writeFile(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const sentences = Array.from({ length: 3000 }, (_, i) => `Phrase numéro ${i}, assez longue pour remplir le tampon du tube.`);
    const files = sentences.map((_, i) => path.join(dir, `${i}.wav`));
    await assert.rejects(new PiperEngine(bin).speak({ model: 'x.onnx', sentences, lengthScale: 1, files }), /\(code 1\)/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Piper never makes the folder of its targets: a deleted project stays deleted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-piper-'));
  try {
    const bin = path.join(dir, 'piper');
    await fs.writeFile(bin, '#!/bin/sh\nwhile [ "$1" != -d ]; do shift; done\ncat > /dev/null\n: > "$2/1.wav"\n', {
      mode: 0o755,
    });
    const target = path.join(dir, 'project', '.cadence', 'voice-over');
    const files = [path.join(target, 'a.wav')];
    await assert.rejects(new PiperEngine(bin).speak({ model: 'x.onnx', sentences: ['Oui.'], lengthScale: 1, files }), {
      code: 'ENOENT',
    });
    assert.equal(await fs.stat(path.join(dir, 'project')).catch(() => null), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  'Piper speaks one WAV per sentence, in the order of the sentences',
  { skip: !model && 'set CADENCE_TEST_PIPER_VOICE to a voice .onnx to run it' },
  async (t) => {
    const engine = new PiperEngine(process.env.PIPER_PATH || 'piper');
    const state = await engine.check();
    if (!state.ok) {
      t.skip(state.error);
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-piper-'));
    try {
      // Lengths far apart: if the files were mixed up, the durations would not follow the text.
      const sentences = [
        'Oui.',
        'Cadence lit chaque phrase de la voix off, une par une, puis les pose sur la vidéo.',
        'Un bouton suffit.',
      ];
      const files = sentences.map((_, i) => path.join(dir, `${i}.wav`));
      await engine.speak({ model: model!, sentences, lengthScale: 1, files });
      const [short, long, medium] = await Promise.all(files.map(wavSeconds));
      assert.ok(short < medium && medium < long, `${short} < ${medium} < ${long}`);
      const faster = path.join(dir, 'faster.wav');
      await engine.speak({ model: model!, sentences: [sentences[1]], lengthScale: 0.8, files: [faster] });
      assert.ok((await wavSeconds(faster)) < long * 0.9);
      assert.deepEqual((await fs.readdir(dir)).sort(), ['0.wav', '1.wav', '2.wav', 'faster.wav'], 'no temporary folder left');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
