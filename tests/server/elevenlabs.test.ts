// ElevenLabs' voices, models and speech against a fake fetch: no request leaves the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setLanguage } from '../../server/i18n';
import { ElevenLabsClient, sidecarFile, type ElevenLabsOptions } from '../../server/voiceover/elevenlabs';
import { readWav } from '../../server/voiceover/wav';
import type { Alignment, Word } from '../../server/voiceover/words';
import { rejectsWithStatus } from './helpers';

const KEY = 'sk_secret_key_123';

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  signal: RequestInit['signal'];
}

function elevenLabs(
  respond: (req: Sent, index: number) => Response | Promise<Response>,
  options: Omit<ElevenLabsOptions, 'http'> = {},
) {
  const sent: Sent[] = [];
  const client = new ElevenLabsClient({
    ...options,
    http: async (url, init = {}) => {
      const req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, signal: init.signal };
      sent.push(req);
      return respond(req, sent.length - 1);
    },
  });
  return { client, sent };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
/** Raw 16-bit little-endian PCM in base64, what `output_format=pcm_24000` answers with its timestamps. */
const pcm = (samples: number[], alignment: Alignment | null = null) => {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => out.writeInt16LE(sample, i * 2));
  return json({ audio_base64: out.toString('base64'), alignment, normalized_alignment: alignment });
};

let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-elevenlabs-'));
});

after(() => fs.rm(dir, { recursive: true, force: true }));

const sidecar = async (wav: string) =>
  JSON.parse(await fs.readFile(sidecarFile(wav), 'utf8')) as { words: Word[]; level: number[] };

function speak(client: ElevenLabsClient, sentences: string[], name = 'a') {
  const files = sentences.map((_, i) => path.join(dir, `${name}-${i}.wav`));
  return {
    files,
    done: client.speak({
      key: KEY,
      voice: 'JBFqnCBsd6RMkjVDRZzb',
      model: 'eleven_multilingual_v2',
      speed: 1.1,
      sentences,
      files,
    }),
  };
}

test('speaks each sentence in order, one request each, into a 24 kHz WAV', async () => {
  const { client, sent } = elevenLabs((_req, i) => pcm(i === 0 ? [0, 1000, -1000, 32767] : [-32768, 5]));
  const { files, done } = speak(client, ['Bonjour.', 'Au revoir.']);
  await done;

  assert.equal(sent.length, 2);
  for (const req of sent) {
    assert.equal(
      req.url,
      'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=pcm_24000',
    );
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.get('xi-api-key'), KEY);
    assert.equal(req.headers.get('content-type'), 'application/json');
    assert.ok(req.signal instanceof AbortSignal);
  }
  assert.deepEqual(
    sent.map((req) => JSON.parse(req.body as string)),
    [
      { text: 'Bonjour.', model_id: 'eleven_multilingual_v2', voice_settings: { speed: 1.1 } },
      { text: 'Au revoir.', model_id: 'eleven_multilingual_v2', voice_settings: { speed: 1.1 } },
    ],
  );

  const first = readWav(await fs.readFile(files[0]));
  assert.equal(first.sampleRate, 24000);
  assert.deepEqual([...first.samples], [0, 1000, -1000, 32767]);
  const second = readWav(await fs.readFile(files[1]));
  assert.equal(second.sampleRate, 24000);
  assert.deepEqual([...second.samples], [-32768, 5]);

  const sidecars = [await sidecar(files[0]), await sidecar(files[1])];
  assert.deepEqual(
    sidecars.map(({ words }) => words.map((w) => w.text)),
    [['Bonjour.'], ['Au', 'revoir.']],
  );
  assert.deepEqual(
    sidecars.map(({ words }) => words.at(-1)!.end),
    [4 / 24000, 2 / 24000],
  );
  assert.deepEqual(
    sidecars.map(({ level }) => level.length),
    [first, second].map(({ samples }) => Math.ceil((samples.length * 25) / 24000)),
  );
});

test('waits for each sentence before asking for the next one', async () => {
  let open = 0;
  let most = 0;
  const { client } = elevenLabs(async () => {
    most = Math.max(most, ++open);
    await new Promise((resolve) => setImmediate(resolve));
    open--;
    return pcm([1]);
  });
  await speak(client, ['Un.', 'Deux.', 'Trois.'], 'serial').done;
  assert.equal(most, 1);
});

test('puts the voice in the path, encoded', async () => {
  const { client, sent } = elevenLabs(() => pcm([1]));
  await client.speak({ key: KEY, voice: 'a/b?c', model: 'm', speed: 1, sentences: ['Oui.'], files: [path.join(dir, 'enc.wav')] });
  assert.equal(sent[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/a%2Fb%3Fc/with-timestamps?output_format=pcm_24000');
});

test('lists the voices of the account', async () => {
  const { client, sent } = elevenLabs(() =>
    json({
      voices: [
        {
          voice_id: 'v1',
          name: 'George',
          category: 'premade',
          labels: { accent: 'british' },
          preview_url: 'https://storage.googleapis.com/v1.mp3',
          verified_languages: [
            { language: 'en', model_id: 'eleven_multilingual_v2', accent: 'british', locale: 'en-GB', preview_url: null },
            { language: 'fr', model_id: 'eleven_multilingual_v2', accent: 'standard', locale: 'fr-FR', preview_url: null },
            { language: 'en', model_id: 'eleven_turbo_v2_5', accent: 'british', locale: 'en-GB', preview_url: null },
          ],
        },
        { voice_id: 'v2', name: 'Clone', category: 'cloned', labels: {}, preview_url: null },
      ],
      has_more: false,
      next_page_token: null,
      total_count: 2,
    }),
  );
  assert.deepEqual(await client.voices(KEY), [
    {
      id: 'v1',
      name: 'George',
      category: 'premade',
      previewUrl: 'https://storage.googleapis.com/v1.mp3',
      languages: ['en', 'fr'],
    },
    { id: 'v2', name: 'Clone', category: 'cloned', previewUrl: null, languages: [] },
  ]);
  assert.equal(sent[0].url, 'https://api.elevenlabs.io/v2/voices?page_size=100');
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].headers.get('xi-api-key'), KEY);
  assert.ok(sent[0].signal instanceof AbortSignal);
});

test('lists only the models that speak text', async () => {
  const { client, sent } = elevenLabs(() =>
    json([
      {
        model_id: 'eleven_multilingual_v2',
        name: 'Eleven Multilingual v2',
        can_do_text_to_speech: true,
        languages: [{ language_id: 'fr', name: 'French' }],
      },
      { model_id: 'eleven_multilingual_sts_v2', name: 'Eleven Multilingual v2 STS', can_do_text_to_speech: false, languages: [] },
    ]),
  );
  assert.deepEqual(await client.models(KEY), [{ id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2' }]);
  assert.equal(sent[0].url, 'https://api.elevenlabs.io/v1/models');
  assert.equal(sent[0].headers.get('xi-api-key'), KEY);
});

const refused = (status: string, message: string, http = 401) => json({ detail: { status, message } }, http);

/** Rejects with `status` and `message`, and the key nowhere in the message. */
async function failsWith(promise: Promise<unknown>, status: number, message: RegExp) {
  await rejectsWithStatus(promise, status, message);
  await promise.catch((e: Error) => assert.ok(!e.message.includes(KEY), e.message));
}

test('a refused key is a 400 with what ElevenLabs said', async () => {
  const { client } = elevenLabs(() => refused('invalid_api_key', 'Invalid API key'));
  await failsWith(client.voices(KEY), 400, /refuse la clé API \(Invalid API key\).*Profil/);
  await failsWith(elevenLabs(() => new Response('', { status: 403 })).client.models(KEY), 400, /refuse la clé API :/);
});

test('a spent quota or a rate limit is a 429', async () => {
  const quota = elevenLabs(() => refused('quota_exceeded', 'This request exceeds your quota of 10000.'));
  await failsWith(speak(quota.client, ['Oui.'], 'quota').done, 429, /exceeds your quota of 10000/);
  const busy = elevenLabs(() => json({ detail: 'Too many concurrent requests' }, 429));
  await failsWith(busy.client.models(KEY), 429, /Too many concurrent requests/);
});

test('any other refusal is a 502 with ElevenLabs words or the HTTP status', async () => {
  const invalid = elevenLabs(() => refused('voice_not_found', 'A voice with this id was not found.', 404));
  await failsWith(speak(invalid.client, ['Oui.'], 'nf').done, 502, /ElevenLabs a répondu : A voice with this id was not found\./);
  const validation = elevenLabs(() => json({ detail: [{ loc: ['body', 'text'], msg: 'field required' }] }, 422));
  await failsWith(validation.client.voices(KEY), 502, /ElevenLabs a répondu : erreur 422/);
  const html = elevenLabs(() => new Response('<html>Bad gateway</html>', { status: 503 }));
  await failsWith(html.client.voices(KEY), 502, /erreur 503/);
});

test('stops at the first sentence ElevenLabs refuses', async () => {
  const { client, sent } = elevenLabs((_req, i) => (i === 0 ? pcm([1]) : refused('quota_exceeded', 'No credits left.')));
  const { files, done } = speak(client, ['Un.', 'Deux.', 'Trois.'], 'stop');
  await failsWith(done, 429, /No credits left/);
  assert.equal(sent.length, 2);
  assert.ok(await fs.stat(files[0]));
  await assert.rejects(fs.stat(files[1]));
});

test('no answer, or no answer in time, is a 502', async () => {
  const down = elevenLabs(() => Promise.reject(new TypeError(`fetch failed for ${KEY}`)));
  await failsWith(down.client.voices(KEY), 502, /ElevenLabs ne répond pas/);
  const slow = elevenLabs(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
  await failsWith(speak(slow.client, ['Oui.'], 'slow').done, 502, /ElevenLabs ne répond pas/);
});

test('never repeats the key, even when ElevenLabs echoes it', async () => {
  const { client } = elevenLabs(() => refused('invalid_api_key', `Invalid API key: ${KEY}`));
  await failsWith(client.voices(KEY), 400, /refuse la clé API/);
});

test('a sound cut short is no answer either', async () => {
  const cut = new ReadableStream({
    start(controller) {
      controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    },
  });
  const { client } = elevenLabs(() => new Response(cut, { status: 200 }));
  await failsWith(speak(client, ['Oui.'], 'cut').done, 502, /ElevenLabs ne répond pas/);
});

const HOST_KEY = 'host_key_456';

interface Recorded {
  responses: { text: string; body: { audio_base64: string; alignment: Alignment } }[];
}

async function recorded(text: string) {
  const file = path.join(import.meta.dirname, '../fixtures/elevenlabs/with-timestamps.json');
  const { responses } = JSON.parse(await fs.readFile(file, 'utf8')) as Recorded;
  return responses.find((r) => r.text === text)!.body;
}

test('the sidecar of a sentence is its WAV with .json', () => {
  assert.equal(sidecarFile('/p/.cadence/voice-over/ab12cd34.wav'), '/p/.cadence/voice-over/ab12cd34.json');
});

test('sends the sentence with its tags and writes the words of the alignment next to the WAV', async () => {
  const body = await recorded('[surprised] Tu as vu le prix ?');
  const { client, sent } = elevenLabs(() => json(body));
  const { files, done } = speak(client, ['[surprised] Tu as vu le prix ?'], 'tags');
  await done;

  assert.equal(JSON.parse(sent[0].body as string).text, '[surprised] Tu as vu le prix ?');
  const { words, level } = await sidecar(files[0]);
  assert.deepEqual(
    words.map((w) => w.text),
    ['Tu', 'as', 'vu', 'le', 'prix', '?'],
  );
  assert.equal(words[0].start, 0.149);
  const { samples, sampleRate } = readWav(await fs.readFile(files[0]));
  assert.equal(sampleRate, 24000);
  assert.equal(samples.length * 2, Buffer.from(body.audio_base64, 'base64').length);
  assert.equal(level.length, Math.ceil((samples.length * 25) / 24000));
  assert.ok(level.every((value) => Number.isInteger(value) && value >= 0 && value <= 255));
  assert.equal(Math.max(...level), 255);
});

test('without an alignment, the words share the length of the sound', async () => {
  const { client } = elevenLabs(() => pcm(Array.from({ length: 24000 }, (_, i) => (i % 2 ? 1000 : -1000))));
  const { files, done } = speak(client, ['Oui non'], 'prorata');
  await done;
  const { words, level } = await sidecar(files[0]);
  assert.deepEqual(words, [
    { text: 'Oui', start: 0, end: 3 / 7 },
    { text: 'non', start: 4 / 7, end: 1 },
  ]);
  assert.equal(level.length, 25);
});

test('an alignment holding anything but characters and times counts as none', async () => {
  const text = 'Oui non';
  const good = {
    characters: [...text] as unknown[],
    character_start_times_seconds: [...text].map((_, i) => i / 10) as unknown[],
    character_end_times_seconds: [...text].map((_, i) => (i + 1) / 10) as unknown[],
  };
  const broken = [
    { ...good, characters: [null, ...good.characters.slice(1)] },
    { ...good, character_start_times_seconds: good.character_start_times_seconds.map(String) },
    { ...good, character_end_times_seconds: [...good.character_end_times_seconds.slice(1), null] },
  ];
  const second = Array.from({ length: 24000 }, () => 0);
  for (const [i, alignment] of broken.entries()) {
    const { client } = elevenLabs(() => pcm(second, alignment as Alignment));
    const { files, done } = speak(client, [text], `broken-${i}`);
    await done;
    assert.deepEqual((await sidecar(files[0])).words, [
      { text: 'Oui', start: 0, end: 3 / 7 },
      { text: 'non', start: 4 / 7, end: 1 },
    ]);
  }
});

test('the words take the times of the alignment, not of the normalized one', async () => {
  const chars = (text: string, start: number) => ({
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => start + i / 10),
    character_end_times_seconds: [...text].map((_, i) => start + (i + 1) / 10),
  });
  const { client } = elevenLabs(() =>
    json({
      audio_base64: Buffer.alloc(4).toString('base64'),
      alignment: chars('4 ans', 0),
      normalized_alignment: chars('quatre ans', 5),
    }),
  );
  const { files, done } = speak(client, ['4 ans'], 'normalized');
  await done;
  assert.deepEqual((await sidecar(files[0])).words, [
    { text: '4', start: 0, end: 0.1 },
    { text: 'ans', start: 0.2, end: 0.5 },
  ]);
});

test('writes the sidecar before the WAV', async () => {
  const { client } = elevenLabs(() => pcm([1, 2]));
  const wav = path.join(dir, 'order.wav');
  // A WAV path taken by a folder: the WAV cannot be written, the sidecar already is.
  await fs.mkdir(path.join(wav, 'taken'), { recursive: true });
  await assert.rejects(client.speak({ key: KEY, voice: 'v', model: 'm', speed: 1, sentences: ['Oui.'], files: [wav] }));
  assert.deepEqual(
    (await sidecar(wav)).words.map((w) => w.text),
    ['Oui.'],
  );
});

test('an answer without sound, or with half a sample, is a 502', async () => {
  const none = elevenLabs(() => json({ alignment: null }));
  await failsWith(speak(none.client, ['Oui.'], 'none').done, 502, /sans son/);
  const empty = elevenLabs(() => json({ audio_base64: '', alignment: null }));
  await failsWith(speak(empty.client, ['Oui.'], 'empty').done, 502, /sans son/);
  const odd = elevenLabs(() => json({ audio_base64: Buffer.from([1, 2, 3]).toString('base64'), alignment: null }));
  const { files, done } = speak(odd.client, ['Oui.'], 'odd');
  await failsWith(done, 502, /sans son/);
  await assert.rejects(fs.stat(sidecarFile(files[0])));
});

test('voices, models and speech all go through the base URL', async () => {
  const { client, sent } = elevenLabs(
    (req) => (req.url.includes('voices') ? json({ voices: [] }) : req.url.includes('models') ? json([]) : pcm([1])),
    { baseUrl: 'https://gateway.example/elevenlabs' },
  );
  await client.voices(KEY);
  await client.models(KEY);
  await speak(client, ['Oui.'], 'base').done;
  assert.deepEqual(
    sent.map((req) => req.url),
    [
      'https://gateway.example/elevenlabs/v2/voices?page_size=100',
      'https://gateway.example/elevenlabs/v1/models',
      'https://gateway.example/elevenlabs/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=pcm_24000',
    ],
  );
});

test('a base URL ending with slashes loses them', async () => {
  for (const baseUrl of ['https://gateway.example/elevenlabs/', 'https://gateway.example/elevenlabs//']) {
    const { client, sent } = elevenLabs(() => json([]), { baseUrl });
    await client.models(KEY);
    assert.equal(sent[0].url, 'https://gateway.example/elevenlabs/v1/models');
  }
});

test('without a key, the default client answers 409 and asks nothing', async () => {
  const { client, sent } = elevenLabs(() => json([]));
  assert.equal(client.hosted, false);
  await rejectsWithStatus(client.voices(null), 409, /Aucune clé API ElevenLabs/);
  await rejectsWithStatus(client.models(null), 409, /Aucune clé API ElevenLabs/);
  const files = [path.join(dir, 'nokey.wav')];
  await rejectsWithStatus(
    client.speak({ key: null, voice: 'v', model: 'm', speed: 1, sentences: ['Oui.'], files }),
    409,
    /Aucune clé API ElevenLabs/,
  );
  assert.equal(sent.length, 0);
});

test('a host client sends its own key, whatever key it is given', async () => {
  const { client, sent } = elevenLabs(() => json([]), { key: HOST_KEY });
  assert.equal(client.hosted, true);
  await client.models(KEY);
  await client.models(null);
  assert.deepEqual(
    sent.map((req) => req.headers.get('xi-api-key')),
    [HOST_KEY, HOST_KEY],
  );
});

test('a host key function is read at each request, and no key from it is a 409', async () => {
  const keys = ['first', undefined, 'second', null, ''];
  const { client, sent } = elevenLabs(() => json([]), { key: async () => keys.shift() });
  assert.equal(client.hosted, true);
  await client.models(KEY);
  await rejectsWithStatus(client.models(KEY), 409, /L’application n’a pas fourni de clé ElevenLabs/);
  await client.models(KEY);
  await rejectsWithStatus(client.models(KEY), 409, /n’a pas fourni/);
  await rejectsWithStatus(client.models(KEY), 409, /n’a pas fourni/);
  assert.deepEqual(
    sent.map((req) => req.headers.get('xi-api-key')),
    ['first', 'second'],
  );
});

test('a host key function that throws or rejects is a 502 that never repeats what it threw', async () => {
  const leak = 'vault said sk_fake_secret_789';
  for (const key of [
    () => {
      throw new Error(leak);
    },
    async () => Promise.reject(new Error(leak)),
  ]) {
    const { client, sent } = elevenLabs(() => json([]), { key });
    try {
      await client.models(KEY);
      assert.fail('expected a rejection');
    } catch (e) {
      const err = e as { status?: number; message: string };
      assert.equal(err.status, 502);
      assert.match(err.message, /clé ElevenLabs/);
      assert.ok(!err.message.includes('sk_fake_secret'), err.message);
    }
    assert.equal(sent.length, 0);
  }
  setLanguage('en');
  try {
    const { client } = elevenLabs(() => json([]), { key: () => Promise.reject(new Error(leak)) });
    await rejectsWithStatus(client.models(KEY), 502, /ElevenLabs key/);
  } finally {
    setLanguage('fr');
  }
});

test('a base URL is https, or http on localhost or 127.0.0.1 only', async () => {
  for (const baseUrl of ['https://gateway.example/elevenlabs', 'http://localhost:8787/el', 'http://127.0.0.1:9000']) {
    const { client, sent } = elevenLabs(() => json([]), { baseUrl });
    await client.models(KEY);
    assert.equal(sent[0].url, `${baseUrl}/v1/models`);
  }
  for (const baseUrl of ['http://gateway.example', 'http://localhost.example', 'ftp://127.0.0.1', 'file:///tmp/x']) {
    assert.throws(() => new ElevenLabsClient({ baseUrl }), /https/, baseUrl);
  }
});

test('a 402 keeps its status and what was said', async () => {
  const own = elevenLabs(() => refused('payment_required', 'This voice needs a paid plan.', 402));
  await failsWith(speak(own.client, ['Oui.'], 'pay').done, 402, /ElevenLabs a répondu : This voice needs a paid plan\./);
  const host = elevenLabs(() => refused('payment_required', 'Refused by the host.', 402), { key: HOST_KEY });
  await rejectsWithStatus(speak(host.client, ['Oui.'], 'host402').done, 402, /^Refused by the host\.$/);
});

test('a host client passes 401 and 403 as they came, its key masked', async () => {
  const revoked = elevenLabs(() => refused('revoked', `Key ${HOST_KEY} revoked.`, 401), { key: HOST_KEY });
  const err = await revoked.client.voices(KEY).catch((e: Error & { status: number }) => e);
  assert.equal((err as { status: number }).status, 401);
  assert.equal((err as Error).message, 'Key *** revoked.');
  const forbidden = elevenLabs(() => refused('forbidden', 'Not allowed here.', 403), { key: () => HOST_KEY });
  await rejectsWithStatus(forbidden.client.models(KEY), 403, /^Not allowed here\.$/);
});

test('a 402, or a host refusal, that says nothing gives its HTTP status', async () => {
  const silent = (status: number) => () => new Response('', { status });
  await failsWith(elevenLabs(silent(402)).client.models(KEY), 402, /^ElevenLabs a répondu : erreur 402$/);
  for (const status of [401, 402, 403]) {
    const host = elevenLabs(silent(status), { key: HOST_KEY });
    await rejectsWithStatus(host.client.models(KEY), status, new RegExp(`^ElevenLabs a répondu : erreur ${status}$`));
  }
});

test('a long message is cut to 300 characters', async () => {
  const host = elevenLabs(() => refused('payment_required', 'x'.repeat(1000), 402), { key: HOST_KEY });
  const err = (await host.client.models(KEY).catch((e: Error) => e)) as Error;
  assert.equal(err.message, 'x'.repeat(300));
  const own = elevenLabs(() => refused('voice_not_found', 'y'.repeat(1000), 404));
  await rejectsWithStatus(own.client.models(KEY), 502, /^ElevenLabs a répondu : y{300}$/);
});

test('the key is masked before the message is cut, so no piece of it stays at the cut', async () => {
  const host = elevenLabs(() => refused('payment_required', `${'x'.repeat(295)}${HOST_KEY} left.`, 402), { key: HOST_KEY });
  const err = (await host.client.models(KEY).catch((e: Error) => e)) as Error;
  assert.equal(err.message, `${'x'.repeat(295)}*** l`);
  const own = elevenLabs(() => refused('voice_not_found', `${'y'.repeat(290)}${KEY}`, 404));
  await failsWith(own.client.models(KEY), 502, /^ElevenLabs a répondu : y{290}\*\*\*$/);
});

const busy = (retryAfter?: string) =>
  new Response(JSON.stringify({ detail: 'Too many concurrent requests' }), {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });

/** Lets the client reach its wait: the answers and their bodies are read across a few turns of the event loop. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A tick that comes before the client waits leaves its timer pending forever: the test fails instead of hanging. */
const timed = { timeout: 5_000 };

test('a 429 that asks to wait 30 s or less is asked again once, after that wait', timed, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sent } = elevenLabs((_req, i) => (i === 0 ? busy('30') : json([])));
  const done = client.models(KEY);
  await settle();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await done, []);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].signal, sent[0].signal);
  assert.equal(sent[1].signal?.aborted, false);
});

test('a second 429 after the wait is the quota 429', timed, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sent } = elevenLabs(() => busy('1'));
  const done = failsWith(client.models(KEY), 429, /Too many concurrent requests/);
  await settle();
  t.mock.timers.tick(1000);
  await done;
  assert.equal(sent.length, 2);
});

test('the body of a 429 is let go before the wait, so its connection is free for the next request', timed, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const body = new ReadableStream({
    cancel: () => {
      cancelled = true;
    },
  });
  const { client } = elevenLabs((_req, i) =>
    i === 0 ? new Response(body, { status: 429, headers: { 'retry-after': '1' } }) : json([]),
  );
  const done = client.models(KEY);
  await settle();
  assert.equal(cancelled, true);
  t.mock.timers.tick(1000);
  assert.deepEqual(await done, []);
});

test('a 429 that asks to wait longer, or does not say, is the quota 429 at once', async () => {
  for (const retryAfter of ['31', undefined, 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    const { client, sent } = elevenLabs(() => busy(retryAfter));
    await failsWith(client.models(KEY), 429, /Too many concurrent requests/);
    assert.equal(sent.length, 1);
  }
});

test('each attempt gets its own timeout: 120 s for speech, 15 s for voices and models', timed, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = t.mock.method(AbortSignal, 'timeout');
  const timeouts = () => timeout.mock.calls.map((call) => call.arguments[0]);
  const speech = elevenLabs((_req, i) => (i === 0 ? busy('1') : pcm([1])));
  const { done } = speak(speech.client, ['Oui.'], 'timeout');
  await settle();
  t.mock.timers.tick(1000);
  await done;
  assert.deepEqual(timeouts(), [120_000, 120_000]);
  timeout.mock.resetCalls();
  const lists = elevenLabs((req, i) => (i === 0 ? busy('1') : json(req.url.includes('/v2/voices') ? { voices: [] } : [])));
  const models = lists.client.models(KEY);
  await settle();
  t.mock.timers.tick(1000);
  await models;
  await lists.client.voices(KEY);
  assert.deepEqual(timeouts(), [15_000, 15_000, 15_000]);
});

test('a sentence answered 429 is asked again, the same, after the wait', timed, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sent } = elevenLabs((_req, i) => (i === 0 ? busy('2') : pcm([1])));
  const { files, done } = speak(client, ['Oui.'], 'retry');
  await settle();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(2000);
  await done;
  assert.equal(sent.length, 2);
  for (const key of ['url', 'method', 'body'] as const) assert.equal(sent[1][key], sent[0][key]);
  assert.equal(sent[1].headers.get('xi-api-key'), KEY);
  assert.deepEqual([...readWav(await fs.readFile(files[0])).samples], [1]);
  assert.deepEqual(
    (await sidecar(files[0])).words.map((w) => w.text),
    ['Oui.'],
  );
});

test('only a 429 is asked again: any other refusal fails at once, whatever its retry-after', async () => {
  const unavailable = elevenLabs(() => new Response('', { status: 503, headers: { 'retry-after': '1' } }));
  await failsWith(unavailable.client.models(KEY), 502, /erreur 503/);
  assert.equal(unavailable.sent.length, 1);
  const host = elevenLabs(
    () =>
      new Response(JSON.stringify({ detail: { status: 'payment_required', message: 'Refused by the host.' } }), {
        status: 402,
        headers: { 'retry-after': '1' },
      }),
    { key: HOST_KEY },
  );
  await rejectsWithStatus(host.client.models(KEY), 402, /^Refused by the host\.$/);
  assert.equal(host.sent.length, 1);
});

test(
  "a host client's own refusal passes as is, even a spent quota; its 429 is asked again once, like the default client",
  timed,
  async (t) => {
    const quota = elevenLabs(() => refused('quota_exceeded', 'Quota of the host spent.', 401), { key: HOST_KEY });
    await rejectsWithStatus(quota.client.models(KEY), 401, /^Quota of the host spent\.$/);
    assert.equal(quota.sent.length, 1);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, sent } = elevenLabs((_req, i) => (i === 0 ? busy('1') : json([])), { key: HOST_KEY });
    const done = client.models(KEY);
    await settle();
    t.mock.timers.tick(1000);
    assert.deepEqual(await done, []);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].headers.get('xi-api-key'), HOST_KEY);
  },
);
