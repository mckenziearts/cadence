// Voice-overs: sentences, what project.json keeps, speaking with a fake Piper (cache, placement, failures), the track
// and voice downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { duckExpression } from '../../server/capture/render';
import type { ElevenLabsApi, Hub, SpeechEngine } from '../../server/contracts';
import { m, setLanguage } from '../../server/i18n';
import { FileBrandStore } from '../../server/store/brands';
import { FileProjectStore } from '../../server/store/projects';
import { HttpError, pathExists, shortHash } from '../../server/util';
import { ElevenLabsClient, sidecarFile } from '../../server/voiceover/elevenlabs';
import { PiperEngine } from '../../server/voiceover/piper';
import { LocalVoiceOverService, splitSentences } from '../../server/voiceover/service';
import { VOICES, type VoiceSpec } from '../../server/voiceover/voices';
import { readWav, writeWav } from '../../server/voiceover/wav';
import type { ServerEvent } from '../../src/shared/types';
import { duckGain, voiceSpans } from '../../src/shared/voiceOver';
import { makeRoot, rejectsWithStatus, type TestRoot } from './helpers';

const RATE = 16000;
/** What the fake Piper says a sentence lasts. */
const seconds = (text: string) => Math.round((0.4 + 0.02 * text.length) * 1000) / 1000;

let t: TestRoot;
let store: FileProjectStore;
let voiceOver: LocalVoiceOverService;
let deps: ConstructorParameters<typeof LocalVoiceOverService>[0];
let events: ServerEvent[];
let spoken: { sentences: string[]; lengthScale: number }[];
/** The voice of each call to the fake Piper. */
let piperVoices: string[];
/** The sample rate the fake Piper speaks a voice at. */
let rateOf: (voice: string) => number;
let engineError: Error | null;
/** While set, the fake Piper waits for it before speaking (or failing). */
let hold: Promise<void> | null;
/** The fake Piper's sample `i` of a sentence. */
let wave: (text: string, i: number) => number;
/** What the fake ElevenLabs was asked to speak, without the files. */
let elevenLabsSpoken: Omit<Parameters<ElevenLabsApi['speak']>[0], 'files'>[];
/** Set, the fake ElevenLabs writes a sentence's words, then fails before its WAV, as a crash between the two would. */
let elevenLabsCrash: boolean;
/** What the fake ElevenLabs writes beside each sentence. */
const ELEVENLABS_SIDECAR = { words: [{ text: 'mot', start: 0.1, end: 0.25 }], level: [7, 9] };

beforeEach(async () => {
  t = await makeRoot();
  store = new FileProjectStore(t.config);
  events = [];
  spoken = [];
  engineError = null;
  hold = null;
  wave = () => 1000;
  piperVoices = [];
  rateOf = () => RATE;
  const hub: Hub = { send: (e) => void events.push(e), handleSse: () => undefined };
  const engine: SpeechEngine = {
    check: async () => ({ ok: true }),
    speak: async ({ model, sentences, lengthScale, files }) => {
      await hold;
      if (engineError) throw engineError;
      spoken.push({ sentences, lengthScale });
      const voice = path.basename(model, '.onnx');
      piperVoices.push(voice);
      const rate = rateOf(voice);
      for (const [i, text] of sentences.entries()) {
        const samples = Int16Array.from({ length: Math.round(seconds(text) * rate) }, (_, j) => wave(text, j));
        await fs.writeFile(files[i], writeWav({ sampleRate: rate, samples }));
      }
    },
  };
  elevenLabsSpoken = [];
  elevenLabsCrash = false;
  // Like the real client: no key is a 409 before any request, and each sentence's words are written before its WAV.
  const noKey = () => new HttpError(409, 'Aucune clé API ElevenLabs enregistrée');
  const elevenLabs: ElevenLabsApi = {
    voices: async (key) => (key ? [] : Promise.reject(noKey())),
    models: async (key) => (key ? [] : Promise.reject(noKey())),
    speak: async ({ files, ...input }) => {
      if (!input.key) throw noKey();
      elevenLabsSpoken.push(input);
      for (const [i, text] of input.sentences.entries()) {
        await fs.writeFile(sidecarFile(files[i]), JSON.stringify(ELEVENLABS_SIDECAR));
        if (elevenLabsCrash) throw new HttpError(502, 'ElevenLabs ne répond plus');
        const samples = Int16Array.from({ length: Math.round(seconds(text) * 24000) }, () => 500);
        await fs.writeFile(files[i], writeWav({ sampleRate: 24000, samples }));
      }
    },
  };
  deps = { config: t.config, store, brands: new FileBrandStore(t.config), hub, engine, elevenLabs };
  voiceOver = new LocalVoiceOverService(deps);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const speakings = () => events.filter((e) => e.type === 'voice-over' && e.status === 'speaking').length;

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await sleep(20);
  assert.ok(done());
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

const ELEVENLABS = {
  engine: 'elevenlabs',
  voice: 'JBFqnCBsd6RMkjVDRZzb',
  model: 'eleven_multilingual_v2',
  speed: 1.1,
  musicLevel: 0.3,
} as const;

test('project.json keeps Piper settings as they were and ElevenLabs settings with their engine and model', async () => {
  const id = await twoScenes();
  const file = path.join(store.dir(id), 'project.json');
  const raw = async () => JSON.parse(await fs.readFile(file, 'utf8')).voiceOver;

  await store.update(id, { voiceOver: { engine: 'piper', voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, model: 'x' } });
  assert.deepEqual(await raw(), { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 }, 'no engine key for Piper');

  await store.update(id, { voiceOver: ELEVENLABS });
  assert.deepEqual(await raw(), ELEVENLABS);
  assert.deepEqual((await store.get(id)).voiceOver, ELEVENLABS);

  for (const wrong of [{ speed: 1.5 }, { model: 'Eleven v2' }, { voice: 'fr_FR-siwis-medium' }, { model: undefined }]) {
    await assert.rejects(store.update(id, { voiceOver: { ...ELEVENLABS, ...wrong } }), { status: 400 });
  }

  // A project.json written before ElevenLabs reads as it did.
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...data, voiceOver: { voice: 'en_GB-cori-medium', speed: 1.2, musicLevel: 0.5 } }));
  assert.deepEqual((await store.get(id)).voiceOver, { voice: 'en_GB-cori-medium', speed: 1.2, musicLevel: 0.5 });
});

test('Piper sentences keep the cache name they always had: a project finds them again without speaking', async () => {
  const id = await twoScenes();
  const dir = path.join(store.dir(id), '.cadence', 'voice-over');
  await fs.mkdir(dir, { recursive: true });
  const samples = Int16Array.from({ length: RATE }, () => 1000);
  assert.equal(shortHash('fr_FR-siwis-medium\n1\nBonjour.'), 'ece9da11ffb1');
  await fs.writeFile(path.join(dir, 'ece9da11ffb1.wav'), writeWav({ sampleRate: RATE, samples }));
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await voiceOver.sync(id);
  assert.equal(spoken.length, 0);
  // A cache from before word timings: its words and mouth levels are computed from the WAV, once, without speaking.
  const line = { sceneId: 'demo', text: 'Bonjour.', start: 2, end: 3, speaker: null };
  const level = Array<number>(25).fill(255);
  assert.deepEqual((await store.get(id)).voiceOverLines, [{ ...line, words: [{ text: 'Bonjour.', start: 2, end: 3 }], level }]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'ece9da11ffb1.json'), 'utf8')), {
    words: [{ text: 'Bonjour.', start: 0, end: 1 }],
    level,
  });
});

test('a sidecar that does not parse or holds the wrong shape is computed again from the WAV', async () => {
  const id = await twoScenes();
  const dir = path.join(store.dir(id), '.cadence', 'voice-over');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'ece9da11ffb1.wav'), writeWav({ sampleRate: RATE, samples: new Int16Array(RATE / 2) }));
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  for (const broken of ['{"words": [', '{"words": 3, "level": []}', '{"words": [], "level": [256]}']) {
    await fs.writeFile(path.join(dir, 'ece9da11ffb1.json'), broken);
    // A new service: nothing known about the files yet.
    const fresh = new LocalVoiceOverService(deps);
    store.setVoiceOverProvider(fresh.provider);
    const [line] = (await store.get(id)).voiceOverLines;
    assert.deepEqual(line.words, [{ text: 'Bonjour.', start: 2, end: 2.5 }], broken);
    assert.deepEqual(line.level, Array<number>(13).fill(0), 'silence: a closed mouth');
  }
  assert.equal(spoken.length + elevenLabsSpoken.length, 0);
});

test('ElevenLabs speaks with the saved key, voice, model and speed, into its own cache names; Piper is not asked', async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  await store.update(id, { voiceOver: ELEVENLABS });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour. Ça va ?', at: 0 } });
  await voiceOver.sync(id);
  assert.deepEqual(elevenLabsSpoken, [
    { key: 'sk_saved', voice: ELEVENLABS.voice, model: ELEVENLABS.model, speed: 1.1, sentences: ['Bonjour.', 'Ça va ?'] },
  ]);
  assert.equal(spoken.length, 0);
  const dir = path.join(store.dir(id), '.cadence', 'voice-over');
  assert.equal(shortHash(`elevenlabs\n${ELEVENLABS.model}\n${ELEVENLABS.voice}\n1.1\nBonjour.`), '6c8d973262ab');
  assert.ok((await fs.readdir(dir)).includes('6c8d973262ab.wav'));
  const project = await store.get(id);
  assert.deepEqual(project.voiceOverPending, []);
  assert.deepEqual(
    project.voiceOverLines.map((l) => l.text),
    ['Bonjour.', 'Ça va ?'],
  );
});

test('ElevenLabs never speaks on its own, even right after a switch from Piper: only a sync pays for the sentences', async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  // Piper would speak this 400 ms later; the switch comes first.
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await store.update(id, { voiceOver: ELEVENLABS });
  for (let i = 0; i < 6; i++) {
    assert.deepEqual((await store.get(id)).voiceOverPending, ['demo']);
    await sleep(100);
  }
  assert.equal(spoken.length + elevenLabsSpoken.length, 0);

  await voiceOver.sync(id);
  assert.equal(elevenLabsSpoken.length, 1);
  assert.deepEqual((await store.get(id)).voiceOverPending, []);
});

test('without a saved key, ElevenLabs fails saying where to add it, and the project shows why', async () => {
  const id = await twoScenes();
  await store.update(id, { voiceOver: ELEVENLABS });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  let message = '';
  await assert.rejects(
    voiceOver.sync(id),
    (e: HttpError) => ((message = e.message), e.status === 409 && /ElevenLabs/.test(message)),
  );
  assert.equal(elevenLabsSpoken.length, 0);
  assert.equal((await store.get(id)).voiceOverError, message);
  assert.deepEqual(events.at(-1), { type: 'voice-over', projectId: id, status: 'error', error: message });
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
  assert.deepEqual(
    project.voiceOverLines.map(({ words: _words, level: _level, ...line }) => line),
    [
      { sceneId: 'demo', text: 'Un deux.', start: 2.5, end: 2.5 + a, speaker: null },
      {
        sceneId: 'demo',
        text: 'Trois quatre cinq.',
        start: 2.5 + a,
        end: Math.round((2.5 + a + b) * 1000) / 1000,
        speaker: null,
      },
    ],
  );
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

const ms = (x: number) => Math.round(x * 1000) / 1000;

test("each script line speaks with its speaker's voice, one Piper call per voice, turns 0.2 s apart", async () => {
  const id = await twoScenes();
  await install('fr_FR-gilles-low');
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium' };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-gilles-low' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [camille, leo] } });
  const lines = [
    { speaker: 'camille', text: 'Bonjour. Ça va ?' },
    { speaker: 'leo', text: '[laughs] Oui.', gesture: 'nod' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0.5, lines } });
  await voiceOver.sync(id);
  assert.deepEqual(piperVoices, ['fr_FR-siwis-medium', 'fr_FR-gilles-low']);
  assert.deepEqual(
    spoken.map((s) => s.sentences),
    [['Bonjour.', 'Ça va ?'], ['Oui.']],
    'Piper never reads a tag aloud',
  );

  const [a, b, c] = ['Bonjour.', 'Ça va ?', 'Oui.'].map(seconds);
  // The sync writes Piper's words and levels (tags not heard) while it holds the project, before any read computes them.
  const dir = path.join(store.dir(id), '.cadence', 'voice-over');
  const sidecar = async (voice: string, text: string) =>
    JSON.parse(await fs.readFile(path.join(dir, `${shortHash(`${voice}\n1\n${text}`)}.json`), 'utf8'));
  assert.deepEqual(await sidecar('fr_FR-siwis-medium', 'Bonjour.'), {
    words: [{ text: 'Bonjour.', start: 0, end: a }],
    level: Array<number>(Math.ceil(Math.round(a * RATE) / (RATE / 25))).fill(255),
  });
  assert.equal((await sidecar('fr_FR-siwis-medium', 'Ça va ?')).words.length, 3);
  assert.deepEqual(await sidecar('fr_FR-gilles-low', '[laughs] Oui.'), {
    words: [{ text: 'Oui.', start: 0, end: c }],
    level: Array<number>(Math.ceil(Math.round(c * RATE) / (RATE / 25))).fill(255),
  });
  const placed = (await store.get(id)).voiceOverLines;
  assert.deepEqual(
    placed.map(({ words: _words, level: _level, ...line }) => line),
    [
      { sceneId: 'demo', text: 'Bonjour.', start: 2.5, end: ms(2.5 + a), speaker: 'camille', line: 0 },
      { sceneId: 'demo', text: 'Ça va ?', start: ms(2.5 + a), end: ms(2.5 + a + b), speaker: 'camille', line: 0 },
      {
        sceneId: 'demo',
        text: 'Oui.',
        start: ms(2.5 + a + b + 0.2),
        end: ms(2.5 + a + b + 0.2 + c),
        speaker: 'leo',
        gesture: 'nod',
        line: 1,
      },
    ],
  );
  // Words in video seconds, timed by characters (Piper gives no alignment); a level every 40 ms of the sentence.
  const at = 2.5 + a;
  assert.deepEqual(placed[1].words, [
    { text: 'Ça', start: ms(at), end: ms(at + (2 * b) / 7) },
    { text: 'va', start: ms(at + (3 * b) / 7), end: ms(at + (5 * b) / 7) },
    { text: '?', start: ms(at + (6 * b) / 7), end: ms(at + b) },
  ]);
  assert.deepEqual(placed[2].level, Array<number>(Math.ceil(c * 25)).fill(255));
});

test("one speaker's lines in a row follow each other with no pause, each sentence keeps its line's gesture, a scene without lines speaks with the project voice", async () => {
  const id = await twoScenes();
  await install('fr_FR-gilles-low');
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-gilles-low' };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-siwis-medium' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [camille, leo] } });
  const intro = (await store.get(id)).scenes[0].id;
  await store.updateScene(id, intro, { voiceOver: { text: 'Salut.', at: 0 } });
  const lines = [
    { speaker: 'camille', text: 'Bonjour. Ça va ?', gesture: 'wave' },
    { speaker: 'camille', text: 'Super.' },
    { speaker: 'leo', text: 'Oui.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  await voiceOver.sync(id);
  const byVoice = Object.fromEntries(piperVoices.map((voice, i) => [voice, spoken[i].sentences]));
  assert.deepEqual(byVoice, { 'fr_FR-siwis-medium': ['Salut.', 'Oui.'], 'fr_FR-gilles-low': ['Bonjour.', 'Ça va ?', 'Super.'] });

  const [s, a, b, c, d] = ['Salut.', 'Bonjour.', 'Ça va ?', 'Super.', 'Oui.'].map(seconds);
  const placed = (await store.get(id)).voiceOverLines;
  assert.deepEqual(
    placed.map(({ sceneId, text, start, end, speaker, gesture }) => ({ sceneId, text, start, end, speaker, gesture })),
    [
      { sceneId: intro, text: 'Salut.', start: 0, end: s, speaker: null, gesture: undefined },
      { sceneId: 'demo', text: 'Bonjour.', start: 2, end: ms(2 + a), speaker: 'camille', gesture: 'wave' },
      { sceneId: 'demo', text: 'Ça va ?', start: ms(2 + a), end: ms(2 + a + b), speaker: 'camille', gesture: 'wave' },
      { sceneId: 'demo', text: 'Super.', start: ms(2 + a + b), end: ms(2 + a + b + c), speaker: 'camille', gesture: undefined },
      {
        sceneId: 'demo',
        text: 'Oui.',
        start: ms(2 + a + b + c + 0.2),
        end: ms(2 + a + b + c + 0.2 + d),
        speaker: 'leo',
        gesture: undefined,
      },
    ],
  );
  assert.ok(!('gesture' in placed[3]), 'a line without a gesture gives its sentences none');
});

test('each sentence carries the index of its script line; a scene without lines gives its sentences none', async () => {
  const id = await twoScenes();
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [camille] } });
  const intro = (await store.get(id)).scenes[0].id;
  await store.updateScene(id, intro, { voiceOver: { text: 'Salut.', at: 0 } });
  const lines = [
    { speaker: 'camille', text: 'Bonjour.' },
    { speaker: 'camille', text: 'Ça va ? Super.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  await voiceOver.sync(id);
  const placed = (await store.get(id)).voiceOverLines;
  assert.deepEqual(
    placed.map(({ text, line }) => ({ text, line })),
    [
      { text: 'Salut.', line: undefined },
      { text: 'Bonjour.', line: 0 },
      { text: 'Ça va ?', line: 1 },
      { text: 'Super.', line: 1 },
    ],
  );
  assert.ok(!('line' in placed[0]), 'the voice-over of a scene without lines is unchanged');
});

test('Piper skips a sentence made of audio tags alone; ElevenLabs speaks it and lays it as a line with no text', async () => {
  const id = await twoScenes();
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Oui.\n[sighs]', at: 0 } });
  await voiceOver.sync(id);
  assert.deepEqual(
    spoken.map((s) => s.sentences),
    [['Oui.']],
  );
  let project = await store.get(id);
  assert.deepEqual(
    project.voiceOverLines.map((l) => l.text),
    ['Oui.'],
  );
  assert.deepEqual(project.voiceOverPending, []);

  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  await store.update(id, { voiceOver: ELEVENLABS });
  await voiceOver.sync(id);
  assert.deepEqual(
    elevenLabsSpoken.map((s) => s.sentences),
    [['Oui.', '[sighs]']],
  );
  project = await store.get(id);
  assert.deepEqual(
    project.voiceOverLines.map((l) => l.text),
    ['Oui.', ''],
  );
  assert.deepEqual(project.voiceOverPending, []);
});

test('a speaker whose Piper voice is not downloaded stops the sync after the voices before it, and the next sync speaks only it', async () => {
  const id = await twoScenes();
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium' };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-gilles-low' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [camille, leo] } });
  const lines = [
    { speaker: 'camille', text: 'Bonjour.' },
    { speaker: 'leo', text: 'Oui.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  let message = '';
  await assert.rejects(voiceOver.sync(id), (e: HttpError) => ((message = e.message), e.status === 409 && /Gilles/.test(message)));
  assert.deepEqual(
    spoken.map((s) => s.sentences),
    [['Bonjour.']],
  );
  const project = await store.get(id);
  assert.deepEqual(project.voiceOverPending, ['demo']);
  assert.equal(project.voiceOverError, message, 'the failure stays on what is still missing');

  await install('fr_FR-gilles-low');
  await voiceOver.sync(id);
  assert.deepEqual(
    spoken.map((s) => s.sentences),
    [['Bonjour.'], ['Oui.']],
  );
  assert.deepEqual((await store.get(id)).voiceOverPending, []);
});

test("a host app's ElevenLabs client gets a null key when none is saved, and lists and speaks with its own", async () => {
  const id = await twoScenes();
  const keys: (string | null)[] = [];
  const voice = { id: 'host-voice', name: 'Hôte', category: 'premade', previewUrl: null, languages: [] };
  const model = { id: 'eleven_v3', name: 'Eleven v3' };
  const hosted = new LocalVoiceOverService({
    ...deps,
    elevenLabs: {
      hosted: true,
      voices: async (key) => (keys.push(key), [voice]),
      models: async (key) => (keys.push(key), [model]),
      speak: async (input) => {
        keys.push(input.key);
        await deps.elevenLabs.speak({ ...input, key: 'host' });
      },
    },
  });
  store.setVoiceOverProvider(hosted.provider);
  assert.deepEqual(await hosted.elevenLabs(), { voices: [voice], models: [model] });
  assert.deepEqual(keys, [null, null]);

  await store.update(id, { voiceOver: ELEVENLABS });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await hosted.sync(id);
  assert.deepEqual(keys, [null, null, null]);
  const project = await store.get(id);
  assert.deepEqual(project.voiceOverPending, []);
  assert.deepEqual(
    project.voiceOverLines.map((l) => l.text),
    ['Bonjour.'],
  );
});

/** A host app's secret store, in memory, with what it was asked. */
function memorySecrets() {
  const saved = new Map<string, string>();
  const asked: string[] = [];
  return {
    saved,
    asked,
    secrets: {
      get: async (name: string) => (asked.push(`get ${name}`), saved.get(name) ?? null),
      set: async (name: string, value: string | null) => {
        asked.push(`set ${name}`);
        if (value === null) saved.delete(name);
        else saved.set(name, value);
      },
    },
  };
}

test("with a host app's secret store, the ElevenLabs key goes through it and no file is written", async () => {
  const id = await twoScenes();
  const { saved, asked, secrets } = memorySecrets();
  const service = new LocalVoiceOverService({ ...deps, secrets });
  store.setVoiceOverProvider(service.provider);
  const file = path.join(t.config.stateDir, 'elevenlabs.json');

  assert.deepEqual((await service.voices()).elevenLabs, { configured: false });
  await service.setElevenLabsKey('sk_hook');
  assert.equal(saved.get('elevenlabs'), 'sk_hook');
  assert.equal(await pathExists(file), false);
  assert.deepEqual((await service.voices()).elevenLabs, { configured: true });

  await store.update(id, { voiceOver: ELEVENLABS });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await service.sync(id);
  assert.deepEqual(
    elevenLabsSpoken.map((s) => s.key),
    ['sk_hook'],
  );
  const files = (await fs.readdir(store.dir(id), { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
  assert.ok(
    files.some((f) => f.name.endsWith('.wav')) &&
      files.some((f) => f.name.endsWith('.json') && f.parentPath.includes('voice-over')),
  );
  for (const entry of files) {
    const content = await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8');
    assert.ok(!content.includes('sk_hook'), entry.name);
  }

  await service.setElevenLabsKey(null);
  assert.equal(saved.has('elevenlabs'), false);
  assert.equal(await pathExists(file), false);
  assert.ok(
    asked.every((call) => call.endsWith(' elevenlabs')),
    asked.join(),
  );
});

test('a secret store that fails to save or read is a 500 saying so, never what it threw', async () => {
  const leak = 'store said sk_fake_secret_789';
  const service = new LocalVoiceOverService({
    ...deps,
    secrets: { get: async () => Promise.reject(new Error(leak)), set: async () => Promise.reject(new Error(leak)) },
    elevenLabs: { ...deps.elevenLabs, voices: async () => [] },
  });
  await rejectsWithStatus(service.setElevenLabsKey('sk_new'), 500, /Clé ElevenLabs non enregistrée/);
  assert.equal(await pathExists(path.join(t.config.stateDir, 'elevenlabs.json')), false, 'no fallback to a file');
  await rejectsWithStatus(service.elevenLabs(), 500, /clé ElevenLabs/);
  // The Piper voices still come back: only ElevenLabs says it could not read its key.
  const state = await service.voices();
  assert.equal(state.voices.length, VOICES.length);
  assert.deepEqual(state.elevenLabs, { configured: false, error: m().media.voiceOver.elevenLabsKeyNotRead });
  setLanguage('en');
  try {
    await rejectsWithStatus(service.setElevenLabsKey('sk_new'), 500, /ElevenLabs key not saved/);
    await rejectsWithStatus(service.elevenLabs(), 500, /ElevenLabs key/);
  } finally {
    setLanguage('fr');
  }
  for (const failing of [() => service.setElevenLabsKey('sk_new'), () => service.elevenLabs()]) {
    await assert.rejects(failing(), (e: Error) => !e.message.includes('sk_fake'));
  }
});

test('a secret store that throws before returning a promise is the same 500, never what it threw', async () => {
  const fail = (): never => {
    throw new Error('store said sk_fake_secret_789');
  };
  const service = new LocalVoiceOverService({
    ...deps,
    secrets: { get: fail, set: fail },
    elevenLabs: { ...deps.elevenLabs, voices: async () => [] },
  });
  await rejectsWithStatus(service.setElevenLabsKey('sk_new'), 500, /Clé ElevenLabs non enregistrée/);
  await rejectsWithStatus(service.elevenLabs(), 500, /clé ElevenLabs/);
  assert.deepEqual((await service.voices()).elevenLabs, { configured: false, error: m().media.voiceOver.elevenLabsKeyNotRead });
});

test("with a host app's ElevenLabs client, the key is the host's: configured, hosted, nothing to save, nothing read", async () => {
  const { asked, secrets } = memorySecrets();
  // A file that would be a 500 if it were read.
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), 'sk_hand_edited\n');
  const keys: (string | null)[] = [];
  const service = new LocalVoiceOverService({
    ...deps,
    secrets,
    elevenLabs: {
      hosted: true,
      voices: async (key) => (keys.push(key), []),
      models: async (key) => (keys.push(key), []),
      speak: async () => undefined,
    },
  });
  assert.deepEqual((await service.voices()).elevenLabs, { configured: true, hosted: true });
  assert.deepEqual(await service.elevenLabs(), { voices: [], models: [] });
  assert.deepEqual(keys, [null, null]);
  await rejectsWithStatus(service.setElevenLabsKey('sk_mine'), 409, /application/);
  await rejectsWithStatus(service.setElevenLabsKey(null), 409);
  assert.deepEqual(asked, [], 'the secret store is never asked');
  // Same without a secret store: the file is not read either.
  const fileless = new LocalVoiceOverService({ ...deps, elevenLabs: { ...deps.elevenLabs, hosted: true } });
  assert.deepEqual((await fileless.voices()).elevenLabs, { configured: true, hosted: true });
});

test('ElevenLabs is asked once per voice and model, with the lines as written, and its words and levels reach the lines', async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  const camille = { id: 'camille', name: 'Camille', voice: 'cgSgspJ2msm6clMCkdW9' };
  const leo = { id: 'leo', name: 'Léo', voice: ELEVENLABS.voice, model: 'eleven_v3' };
  await store.update(id, { voiceOver: { ...ELEVENLABS, speakers: [camille, leo] } });
  const lines = [
    { speaker: 'camille', text: '[surprised] Tu as vu le prix ?' },
    { speaker: 'leo', text: 'Un café. Oui.' },
    { speaker: 'camille', text: 'Super.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  await voiceOver.sync(id);
  const asked = { key: 'sk_saved', speed: 1.1 };
  assert.deepEqual(elevenLabsSpoken, [
    { ...asked, voice: camille.voice, model: ELEVENLABS.model, sentences: ['[surprised] Tu as vu le prix ?', 'Super.'] },
    { ...asked, voice: leo.voice, model: 'eleven_v3', sentences: ['Un café.', 'Oui.'] },
  ]);
  assert.equal(spoken.length, 0);

  const placed = (await store.get(id)).voiceOverLines;
  assert.deepEqual(
    placed.map((line) => [line.speaker, line.text]),
    [
      ['camille', 'Tu as vu le prix ?'],
      ['leo', 'Un café.'],
      ['leo', 'Oui.'],
      ['camille', 'Super.'],
    ],
  );
  assert.equal(placed[0].start, 2);
  assert.equal(placed[1].start, ms(placed[0].end + 0.2), 'a turn');
  assert.equal(placed[2].start, placed[1].end, 'the same speaker goes on');
  assert.equal(placed[3].start, ms(placed[2].end + 0.2), 'a turn');
  assert.deepEqual(placed[1].words, [{ text: 'mot', start: ms(placed[1].start + 0.1), end: ms(placed[1].start + 0.25) }]);
  assert.deepEqual(placed[1].level, [7, 9]);
});

test("a speaker's own ElevenLabs model is part of its cache name: changing it speaks the line again", async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  const leo = { id: 'leo', name: 'Léo', voice: ELEVENLABS.voice, model: 'eleven_v3' };
  await store.update(id, { voiceOver: { ...ELEVENLABS, speakers: [leo] } });
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines: [{ speaker: 'leo', text: 'Un café.' }] } });
  await voiceOver.sync(id);
  const dir = path.join(store.dir(id), '.cadence', 'voice-over');
  assert.ok(await pathExists(path.join(dir, `${shortHash(`elevenlabs\neleven_v3\n${leo.voice}\n1.1\nUn café.`)}.wav`)));

  await store.update(id, { voiceOver: { ...ELEVENLABS, speakers: [{ ...leo, model: ELEVENLABS.model }] } });
  assert.deepEqual((await store.get(id)).voiceOverPending, ['demo']);
  await voiceOver.sync(id);
  assert.deepEqual(
    elevenLabsSpoken.map((call) => [call.model, call.sentences]),
    [
      ['eleven_v3', ['Un café.']],
      [ELEVENLABS.model, ['Un café.']],
    ],
  );
});

test('two speakers with the same ElevenLabs voice and different models get one call each, each with its own model', async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  const camille = { id: 'camille', name: 'Camille', voice: ELEVENLABS.voice };
  const leo = { id: 'leo', name: 'Léo', voice: ELEVENLABS.voice, model: 'eleven_v3' };
  await store.update(id, { voiceOver: { ...ELEVENLABS, speakers: [camille, leo] } });
  const lines = [
    { speaker: 'camille', text: 'Bonjour.' },
    { speaker: 'leo', text: 'Un café.' },
    { speaker: 'camille', text: 'Super.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  await voiceOver.sync(id);
  const asked = { key: 'sk_saved', voice: ELEVENLABS.voice, speed: 1.1 };
  assert.deepEqual(elevenLabsSpoken, [
    { ...asked, model: ELEVENLABS.model, sentences: ['Bonjour.', 'Super.'] },
    { ...asked, model: 'eleven_v3', sentences: ['Un café.'] },
  ]);
});

test('a sentence whose words were written but not its WAV is not spoken, and the next sync speaks it', async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  await store.update(id, { voiceOver: ELEVENLABS });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  elevenLabsCrash = true;
  await assert.rejects(voiceOver.sync(id), { status: 502 });
  assert.deepEqual(await fs.readdir(path.join(store.dir(id), '.cadence', 'voice-over')), ['6c8d973262ab.json']);
  assert.deepEqual((await store.get(id)).voiceOverPending, ['demo']);

  elevenLabsCrash = false;
  await voiceOver.sync(id);
  assert.equal(elevenLabsSpoken.length, 2);
  const project = await store.get(id);
  assert.deepEqual(project.voiceOverPending, []);
  assert.deepEqual(project.voiceOverLines[0].level, [7, 9]);
});

test('a sync whose project is deleted before it writes leaves nothing on disk', async () => {
  const id = await twoScenes();
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  const deleting = Object.assign(Object.create(store) as FileProjectStore, {
    get: async (projectId: string) => {
      const project = await store.get(projectId);
      await store.remove(projectId);
      return project;
    },
  });
  await assert.rejects(new LocalVoiceOverService({ ...deps, store: deleting }).sync(id), { status: 404 });
  assert.equal(await pathExists(store.dir(id)), false);
  assert.equal(spoken.length, 0);
});

test('a project deleted between two voices of a sync is not brought back by the next voice', async () => {
  const id = await twoScenes();
  await install('fr_FR-gilles-low');
  const calls: string[][] = [];
  const service = new LocalVoiceOverService({
    ...deps,
    engine: {
      ...deps.engine,
      speak: async (input) => {
        calls.push(input.sentences);
        await deps.engine.speak(input);
        if (calls.length === 1) await store.remove(id);
      },
    },
  });
  store.setVoiceOverProvider(service.provider);
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium' };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-gilles-low' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [camille, leo] } });
  const lines = [
    { speaker: 'camille', text: 'Bonjour.' },
    { speaker: 'leo', text: 'Oui.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  await assert.rejects(service.sync(id), { status: 404 });
  assert.deepEqual(calls, [['Bonjour.']]);
  assert.equal(await pathExists(store.dir(id)), false);
});

test('a project deleted while Piper speaks is not brought back by its WAVs', async () => {
  const id = await twoScenes();
  await install('fr_FR-gilles-low');
  // The real engine around a fake binary that writes one WAV per run.
  const bin = path.join(t.root, 'piper');
  await fs.writeFile(bin, '#!/bin/sh\nwhile [ "$1" != -d ]; do shift; done\ncat > /dev/null\n: > "$2/1.wav"\n', { mode: 0o755 });
  const piper = new PiperEngine(bin);
  const service = new LocalVoiceOverService({
    ...deps,
    engine: {
      ...deps.engine,
      speak: async (input) => {
        await store.remove(id);
        await piper.speak(input);
      },
    },
  });
  store.setVoiceOverProvider(service.provider);
  await store.update(id, { voiceOver: { voice: 'fr_FR-gilles-low', speed: 1, musicLevel: 0.3 } });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Oui.', at: 0 } });
  await assert.rejects(service.sync(id), { status: 404 });
  assert.equal(await pathExists(store.dir(id)), false);
});

test("a project deleted while Piper's words are computed from a WAV is not brought back by their sidecar", async (ctx) => {
  const id = await twoScenes();
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Oui.', at: 0 } });
  // The WAV is read, then the project goes before its `<hash>.json` is written.
  const readFile = fs.readFile;
  ctx.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const read = await readFile(...args);
    if (String(args[0]).endsWith('.wav')) await store.remove(id);
    return read;
  });
  await assert.rejects(voiceOver.sync(id), { status: 404 });
  assert.equal(await pathExists(store.dir(id)), false);
});

test('a project deleted while ElevenLabs speaks is not brought back by the sentences after it', async () => {
  const id = await twoScenes();
  await fs.writeFile(path.join(t.config.stateDir, 'elevenlabs.json'), JSON.stringify({ key: 'sk_saved' }));
  let requests = 0;
  const audio = Buffer.alloc(4800).toString('base64');
  const service = new LocalVoiceOverService({
    ...deps,
    elevenLabs: new ElevenLabsClient({
      http: async () => {
        // The first sentence is written by now: the project goes before the second one is.
        if (++requests === 2) await store.remove(id);
        return new Response(JSON.stringify({ audio_base64: audio }));
      },
    }),
  });
  store.setVoiceOverProvider(service.provider);
  await store.update(id, { voiceOver: ELEVENLABS });
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour. Ça va ?', at: 0 } });
  await assert.rejects(service.sync(id), { status: 404 });
  assert.equal(requests, 2);
  assert.equal(await pathExists(store.dir(id)), false);
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

test('the project keeps why Piper failed until the missing sentences change or a sync speaks them', async () => {
  const id = await twoScenes();
  engineError = new HttpError(500, 'Piper a échoué (code 1)');
  let project = await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  assert.equal(project.voiceOverError, null, 'nothing failed yet');
  await assert.rejects(voiceOver.sync(id));
  assert.equal((await store.get(id)).voiceOverError, 'Piper a échoué (code 1)');

  // The same sentences stay failed: nothing speaks on its own, the error stays.
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0.5 } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(events.filter((e) => e.type === 'voice-over' && e.status === 'speaking').length, 1);
  assert.equal((await store.get(id)).voiceOverError, 'Piper a échoué (code 1)');

  // A new text is new missing sentences: no error until Piper has tried them, and it does on its own.
  engineError = null;
  project = await store.updateScene(id, 'demo', { voiceOver: { text: 'Salut.', at: 0 } });
  assert.equal(project.voiceOverError, null);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(spoken, [{ sentences: ['Salut.'], lengthScale: 1 }]);

  // A sync that succeeds clears a failure.
  engineError = new HttpError(500, 'Piper a échoué (code 2)');
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Encore.', at: 0 } });
  await assert.rejects(voiceOver.sync(id));
  assert.equal((await store.get(id)).voiceOverError, 'Piper a échoué (code 2)');
  engineError = null;
  await voiceOver.sync(id);
  project = await store.get(id);
  assert.equal(project.voiceOverError, null);
  assert.deepEqual(project.voiceOverPending, []);
});

test('reading the project often does not hold back the sentences it schedules', async () => {
  const id = await twoScenes();
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  // The editor and the frames read the project whenever they like: a read must not push the start back.
  for (let i = 0; i < 20 && !spoken.length; i++) {
    await store.get(id);
    await sleep(100);
  }
  assert.deepEqual(spoken, [{ sentences: ['Bonjour.'], lengthScale: 1 }]);
  // Piper is still writing its WAVs: the project folder goes once they are written.
  await until(() => events.some((e) => e.type === 'voice-over' && e.status === 'ready'));
});

test('while Piper speaks, reading the project queues no second attempt and shows no stale error', async () => {
  const id = await twoScenes();
  let release = () => {};
  hold = new Promise((resolve) => (release = resolve));
  engineError = new HttpError(500, 'Piper a échoué (code 1)');
  await store.updateScene(id, 'demo', { voiceOver: { text: 'Bonjour.', at: 0 } });
  await until(() => speakings() === 1);
  for (let i = 0; i < 6; i++) {
    assert.equal((await store.get(id)).voiceOverError, null);
    await sleep(100);
  }
  await sleep(500); // what those reads would have scheduled starts now, while Piper still speaks
  release();
  await until(() => events.some((e) => e.type === 'voice-over' && e.status === 'error'));
  await sleep(600);
  assert.equal(speakings(), 1, 'one failure, told once');
  assert.equal((await store.get(id)).voiceOverError, 'Piper a échoué (code 1)');

  // Generate again, and a reload meanwhile: the failure is not shown while Piper tries again.
  hold = new Promise((resolve) => (release = resolve));
  engineError = null;
  const retry = voiceOver.sync(id);
  await until(() => speakings() === 2);
  assert.equal((await store.get(id)).voiceOverError, null, 'being spoken again');
  release();
  await retry;
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

test('the track mixes voices of different sample rates at the highest one, resampling the others', async () => {
  const id = await twoScenes();
  await install('fr_FR-gilles-low');
  rateOf = (voice) => (voice === 'fr_FR-gilles-low' ? 16000 : 22050);
  wave = (text, i) => (text === 'Oui.' ? i : 1000);
  const camille = { id: 'camille', name: 'Camille', voice: 'fr_FR-siwis-medium' };
  const leo = { id: 'leo', name: 'Léo', voice: 'fr_FR-gilles-low' };
  await store.update(id, { voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3, speakers: [camille, leo] } });
  // The 16000 Hz voice speaks first: the track's rate is not the first line's.
  const lines = [
    { speaker: 'leo', text: 'Oui.' },
    { speaker: 'camille', text: 'Bonjour.' },
  ];
  await store.updateScene(id, 'demo', { voiceOver: { at: 0, lines } });
  await voiceOver.sync(id);
  const track = (await voiceOver.track(id))!;
  const { sampleRate, samples } = readWav(await fs.readFile(track.file));
  assert.equal(sampleRate, 22050);
  assert.equal(samples.length, Math.ceil(track.lines[1].end * 22050));
  assert.equal(samples[Math.round(track.lines[1].start * 22050)], 1000, 'the 22050 Hz voice as it was spoken');
  // The 16000 Hz ramp keeps its pitch: sample k of the track is sample k * 16000 / 22050 of the voice.
  const at = Math.round(track.lines[0].start * 22050);
  for (const k of [0, 1, 2, 1000, 5001, Math.round(seconds('Oui.') * 22050) - 2]) {
    assert.ok(Math.abs(samples[at + k] - (k * 16000) / 22050) <= 1, `sample ${k}: ${samples[at + k]}`);
  }
});

test('two sentences that overlap are lowered just enough where their sum would clip, and only there', async () => {
  const id = await twoScenes();
  const first = 'Une phrase assez longue pour déborder.';
  const second = 'La suite.';
  const tone = (text: string, i: number) => Math.round(30000 * Math.sin((2 * Math.PI * (text === first ? 440 : 710) * i) / RATE));
  wave = tone;
  const intro = (await store.get(id)).scenes[0].id;
  await store.updateScene(id, intro, { voiceOver: { text: first, at: 1 } });
  await store.updateScene(id, 'demo', { voiceOver: { text: second, at: 0 } });
  await voiceOver.sync(id);
  const lines = (await voiceOver.track(id))!.lines;
  const atA = Math.round(lines[0].start * RATE);
  const atB = Math.round(lines[1].start * RATE);
  const endA = atA + Math.round(seconds(first) * RATE);
  const endB = atB + Math.round(seconds(second) * RATE);
  assert.ok(atB < endA, 'the first sentence runs into the second');
  const a = (i: number) => (i >= atA && i < endA ? tone(first, i - atA) : 0);
  const b = (i: number) => (i >= atB && i < endB ? tone(second, i - atB) : 0);
  const { samples } = readWav(await fs.readFile((await voiceOver.track(id))!.file));

  const ratios: number[] = [];
  let peak = 0;
  let sum = 0;
  for (let i = atB; i < endA; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
    sum = Math.max(sum, Math.abs(a(i) + b(i)));
    if (Math.abs(a(i) + b(i)) > 20000) ratios.push(samples[i] / (a(i) + b(i)));
  }
  assert.ok(sum > 40000, `the sum passes full scale: ${sum}`);
  assert.ok(
    Math.max(...ratios) - Math.min(...ratios) < 0.001,
    `one gain over the overlap: ${Math.min(...ratios)} to ${Math.max(...ratios)}`,
  );
  assert.ok(Math.max(...ratios) < 1, 'lowered');
  assert.ok(peak >= 32700, `just enough: peak ${peak}`);

  // On each side, the gain comes back to 1 over 20 ms instead of stepping.
  const ramp = Math.round(0.02 * RATE);
  const g = ratios[0];
  const before: number[] = [];
  const after: number[] = [];
  for (let i = atB - ramp + 1; i < atB; i++) if (Math.abs(a(i)) > 20000) before.push(samples[i] / a(i));
  for (let i = endA; i < endA + ramp - 1; i++) if (Math.abs(b(i)) > 20000) after.push(samples[i] / b(i));
  for (const gains of [before, after]) {
    assert.ok(
      gains.length && gains.every((x) => x > g + 0.001 && x < 0.9995),
      `a ramp between ${g} and 1: ${Math.min(...gains)} to ${Math.max(...gains)}`,
    );
  }

  // 50 ms away from the overlap, each sentence is as Piper spoke it.
  const margin = Math.round(0.05 * RATE);
  const expect = (from: number, to: number, f: (i: number) => number) =>
    Int16Array.from({ length: to - from }, (_, j) => f(from + j));
  assert.deepEqual(samples.subarray(atA, atB - margin), expect(atA, atB - margin, a), 'the first sentence');
  assert.deepEqual(samples.subarray(endA + margin, endB), expect(endA + margin, endB, b), 'the second sentence');

  // Without overlap, the track is each sentence at its time over silence.
  await store.updateScene(id, 'demo', { voiceOver: { text: second, at: 0.5 } });
  const apart = (await voiceOver.track(id))!;
  const at = Math.round(apart.lines[1].start * RATE);
  const end = at + Math.round(seconds(second) * RATE);
  const expected = expect(0, end, (i) => a(i) + (i >= at ? tone(second, i - at) : 0));
  assert.deepEqual(readWav(await fs.readFile(apart.file)).samples, expected);
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
      elevenLabs: { voices: async () => [], models: async () => [], speak: async () => undefined },
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
    assert.match(fetched[0], /\/resolve\/375a0fe641dea077c2a47b4e9a056d6da521eed3\/fr\/fr_FR\/test\/low\//);
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
