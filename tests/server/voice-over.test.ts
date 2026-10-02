// Voice-overs: sentences, what project.json keeps, speaking with a fake Piper (cache, placement, failures), the track
// and voice downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { duckExpression } from '../../server/capture/render';
import type { Hub, SpeechEngine } from '../../server/contracts';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { HttpError } from '../../server/util';
import { LocalVoiceOverService, splitSentences } from '../../server/voiceover/service';
import { VOICES, type VoiceSpec } from '../../server/voiceover/voices';
import { readWav, writeWav } from '../../server/voiceover/wav';
import type { ServerEvent } from '../../src/shared/types';
import { duckGain, voiceSpans } from '../../src/shared/voiceOver';
import { makeRoot, type TestRoot } from './helpers';

const RATE = 16000;
/** What the fake Piper says a sentence lasts. */
const seconds = (text: string) => Math.round((0.4 + 0.02 * text.length) * 1000) / 1000;

let t: TestRoot;
let store: FileProjectStore;
let voiceOver: LocalVoiceOverService;
let events: ServerEvent[];
let spoken: { sentences: string[]; lengthScale: number }[];
let engineError: Error | null;

beforeEach(async () => {
  t = await makeRoot();
  store = new FileProjectStore(t.config);
  events = [];
  spoken = [];
  engineError = null;
  const hub: Hub = { send: (e) => void events.push(e), handleSse: () => undefined };
  const engine: SpeechEngine = {
    check: async () => ({ ok: true }),
    speak: async ({ sentences, lengthScale, files }) => {
      if (engineError) throw engineError;
      spoken.push({ sentences, lengthScale });
      for (const [i, text] of sentences.entries()) {
        const samples = new Int16Array(Math.round(seconds(text) * RATE)).fill(1000);
        await fs.writeFile(files[i], writeWav({ sampleRate: RATE, samples }));
      }
    },
  };
  voiceOver = new LocalVoiceOverService({ config: t.config, store, brands: new FileBrandStore(t.config), hub, engine });
  store.setVoiceOverProvider(voiceOver.provider);
  await install('fr_FR-siwis-medium');
});

afterEach(() => t.cleanup());

async function install(voice: string) {
  const dir = path.join(t.config.stateDir, 'voices');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${voice}.onnx`), 'model');
  await fs.writeFile(path.join(dir, `${voice}.onnx.json`), '{}');
}

/** A project with two 2 s scenes, `intro` and `demo`. */
async function twoScenes(): Promise<string> {
  const project = await store.create({ name: 'Voix', brand: null, formats: ['16:9'], fps: 30 });
  const first = project.scenes[0].id;
  const demo = await store.createScene(project.id, { name: 'Demo', duration: 2 });
  await store.setDurations(project.id, { [first]: 2 });
  assert.equal(demo.id, 'demo');
  return project.id;
}

test('a voice-over text splits into the sentences Piper speaks, line breaks included', () => {
  assert.deepEqual(splitSentences('Vos factures en PDF, en un clic.  Un seul bouton suffit !\nEssayez-le', 'fr'), [
    'Vos factures en PDF, en un clic.',
    'Un seul bouton suffit !',
    'Essayez-le',
  ]);
  assert.deepEqual(splitSentences(' ... !\n', 'fr'), []);
});

test('project.json keeps a scene voice-over through other edits; a blank text removes it', async () => {
  const id = await twoScenes();
  await store.updateScene(id, 'demo', { voiceOver: { text: '  Bonjour.  ', at: 0.5004 } });
  await store.updateScene(id, 'demo', { name: 'Démo' });
  let scene = (await store.get(id)).scenes.find((s) => s.id === 'demo')!;
  assert.deepEqual(scene.voiceOver, { text: 'Bonjour.', at: 0.5 });
  await assert.rejects(store.updateScene(id, 'demo', { voiceOver: { text: 'x', at: -1 } }), { status: 400 });
  await store.updateScene(id, 'demo', { voiceOver: { text: ' \n', at: 0 } });
  scene = (await store.get(id)).scenes.find((s) => s.id === 'demo')!;
  assert.equal(scene.voiceOver, undefined);
  const raw = JSON.parse(await fs.readFile(path.join(store.dir(id), 'project.json'), 'utf8'));
  assert.equal(raw.scenes[1].voiceOver, undefined);
});

test('until a voice is picked, the project speaks with the default voice of its language', async () => {
  const id = await twoScenes();
  assert.deepEqual((await store.get(id)).voiceOver, { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 });
  await store.update(id, { language: 'en' });
  assert.equal((await store.get(id)).voiceOver.voice, 'en_US-joe-medium');
  await store.update(id, { voiceOver: { voice: 'en_GB-cori-medium', speed: 1.2, musicLevel: 0.5 } });
  assert.deepEqual((await store.get(id)).voiceOver, { voice: 'en_GB-cori-medium', speed: 1.2, musicLevel: 0.5 });
  await assert.rejects(store.update(id, { voiceOver: { voice: 'en_GB-cori-medium', speed: 3, musicLevel: 0.5 } }), {
    status: 400,
  });
});

test('sync speaks each sentence once, lays them from scene start + at, and follows the scenes without speaking again', async () => {
  const id = await twoScenes();
  let project = await store.updateScene(id, 'demo', { voiceOver: { text: 'Un deux. Trois quatre cinq.', at: 0.5 } });
  assert.deepEqual(project.voiceOverPending, ['demo']);
  assert.equal(project.voiceOverUrl, null);

  await voiceOver.sync(id);
  assert.deepEqual(spoken, [{ sentences: ['Un deux.', 'Trois quatre cinq.'], lengthScale: 1 }]);
  project = await store.get(id);
  const a = seconds('Un deux.');
  const b = seconds('Trois quatre cinq.');
  assert.deepEqual(project.voiceOverLines, [
    { sceneId: 'demo', text: 'Un deux.', start: 2.5, end: 2.5 + a },
    { sceneId: 'demo', text: 'Trois quatre cinq.', start: 2.5 + a, end: Math.round((2.5 + a + b) * 1000) / 1000 },
  ]);
  assert.deepEqual(project.voiceOverPending, []);
  assert.match(project.voiceOverUrl ?? '', /^\/api\/projects\/voix\/voice-over\/audio\?v=\w+$/);
  assert.deepEqual(
    events.map((e) => (e.type === 'voice-over' ? e.status : e.type)),
    ['speaking', 'ready', 'project-changed'],
  );

  // A longer first scene moves the lines; nothing is spoken again.
  await store.setDurations(id, { [project.scenes[0].id]: 3 });
  assert.equal((await store.get(id)).voiceOverLines[0].start, 3.5);
  await voiceOver.sync(id);
  assert.equal(spoken.length, 1);

  // Only the new sentence is spoken; a new speed speaks everything again.
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Un deux. Six.', at: 0.5 } });
  await voiceOver.sync(id);
  assert.deepEqual(spoken[1], { sentences: ['Six.'], lengthScale: 1 });
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1.25, musicLevel: 0.3 } });
  await voiceOver.sync(id);
  assert.deepEqual(spoken[2], { sentences: ['Un deux.', 'Six.'], lengthScale: 0.8 });
});

test('a failure is told once: the same sentences are not retried on their own, but sync on request does', async () => {
  const id = await twoScenes();
  engineError = new HttpError(500, 'Piper a échoué (code 1)');
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await assert.rejects(voiceOver.sync(id), /Piper a échoué/);
  assert.deepEqual(events.at(-1), { type: 'voice-over', projectId: id, status: 'error', error: 'Piper a échoué (code 1)' });

  engineError = null;
  assert.deepEqual((await store.get(id)).voiceOverPending, ['demo']);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(spoken.length, 0, 'no automatic retry of the same sentences');

  await voiceOver.sync(id);
  assert.deepEqual((await store.get(id)).voiceOverPending, []);
});

test('a voice that is not downloaded fails with a message saying where to get it', async () => {
  const id = await twoScenes();
  await store.update(id, { voiceOver: { voice: 'fr_FR-gilles-low', speed: 1, musicLevel: 0.3 } });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await assert.rejects(voiceOver.sync(id), (e: HttpError) => e.status === 409 && /Gilles/.test(e.message));
  assert.equal(spoken.length, 0);
});

test('the track lays each sentence at its time, as one WAV', async () => {
  const id = await twoScenes();
  assert.equal(await voiceOver.track(id), null);
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Un. Deux.', at: 0.25 } });
  await voiceOver.sync(id);
  const track = (await voiceOver.track(id))!;
  assert.equal(track.musicLevel, 0.3);
  assert.equal(track.lines.length, 2);
  const { sampleRate, samples } = readWav(await fs.readFile(track.file));
  assert.equal(sampleRate, RATE);
  assert.equal(samples.length, Math.ceil(track.lines[1].end * RATE));
  const at = Math.round(2.25 * RATE);
  assert.equal(samples[at - 1], 0, 'silent before the first sentence');
  assert.equal(samples[at], 1000);
  assert.equal(samples.at(-1), 1000);
});

test('downloads check the md5, share one transfer, and refuse a voice Cadence does not offer', async () => {
  await assert.rejects(voiceOver.download('xx_XX-nobody-low'), { status: 404 });

  const files = { '.onnx': Buffer.from('model bytes'), '.onnx.json': Buffer.from('{"audio":{}}') };
  const md5 = (data: Buffer) => createHash('md5').update(data).digest('hex');
  const spec: VoiceSpec = {
    id: 'fr_FR-test-low',
    name: 'Test',
    license: 'CC0',
    commercial: true,
    credit: false,
    path: 'fr/fr_FR/test/low',
    size: 23,
    md5: { onnx: md5(files['.onnx']), json: md5(files['.onnx.json']) },
  };
  VOICES.push(spec);
  try {
    const fetched: string[] = [];
    let corrupt = true;
    const service = new LocalVoiceOverService({
      config: t.config,
      store,
      brands: new FileBrandStore(t.config),
      hub: { send: () => undefined, handleSse: () => undefined },
      engine: { check: async () => ({ ok: true }), speak: async () => undefined },
      fetch: async (url) => {
        fetched.push(String(url));
        const data = String(url).endsWith('.json') ? files['.onnx.json'] : files['.onnx'];
        return new Response(corrupt ? Buffer.from('not it') : data);
      },
    });
    await assert.rejects(service.download(spec.id), { status: 502 });
    const dir = path.join(t.config.stateDir, 'voices');
    assert.deepEqual(
      (await fs.readdir(dir)).filter((f) => f.includes('test')),
      [],
    );

    corrupt = false;
    fetched.length = 0;
    const [one, two] = await Promise.all([service.download(spec.id), service.download(spec.id)]);
    assert.equal(one.installed, true);
    assert.deepEqual(two, one);
    assert.deepEqual(
      fetched.map((u) => u.split('/').slice(-1)[0]),
      ['fr_FR-test-low.onnx.json', 'fr_FR-test-low.onnx'],
    );
    assert.match(fetched[0], /\/resolve\/c10ece1aade47bb51c153c893d14e5bf8e5b7117\/fr\/fr_FR\/test\/low\//);
    assert.ok((await service.voices()).voices.find((v) => v.id === spec.id)?.installed);
  } finally {
    VOICES.pop();
  }
});

test('the music ducks once per run of back-to-back sentences, the same in the preview and in the MP4', () => {
  const lines = [
    { start: 1, end: 2 },
    { start: 2, end: 2.8 },
    { start: 5, end: 6 },
  ];
  assert.deepEqual(voiceSpans(lines), [
    [1, 2.8],
    [5, 6],
  ]);
  // A render from 4.5 s: the first run is over, the second starts 0.5 s in.
  assert.deepEqual(voiceSpans(lines, 4.5), [[0.5, 1.5]]);
  assert.equal(duckExpression([[0.5, 1.5]], 0.3), '1-0.700*clip(min((t-0.250)/0.25,(1.750-t)/0.25),0,1)');
  const gain = (t: number) => Math.round(duckGain([[0.5, 1.5]], 0.3, t) * 1000) / 1000;
  assert.deepEqual([0, 0.25, 0.375, 0.5, 1, 1.5, 1.625, 1.75, 3].map(gain), [1, 1, 0.65, 0.3, 0.3, 0.3, 0.65, 1, 1]);
});
