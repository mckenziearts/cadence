// ElevenLabs' voices, models and speech against a fake fetch: no request leaves the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ElevenLabsClient } from '../../server/voiceover/elevenlabs';
import { readWav } from '../../server/voiceover/wav';
import { rejectsWithStatus } from './helpers';

const KEY = 'sk_secret_key_123';

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  signal: RequestInit['signal'];
}

function elevenLabs(respond: (req: Sent, index: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const client = new ElevenLabsClient(async (url, init = {}) => {
    const req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, signal: init.signal };
    sent.push(req);
    return respond(req, sent.length - 1);
  });
  return { client, sent };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
/** Raw 16-bit little-endian PCM, what `output_format=pcm_24000` answers. */
const pcm = (samples: number[]) => {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => out.writeInt16LE(sample, i * 2));
  return new Response(out, { status: 200, headers: { 'Content-Type': 'audio/pcm' } });
};

let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-elevenlabs-'));
});

after(() => fs.rm(dir, { recursive: true, force: true }));

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
    assert.equal(req.url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=pcm_24000');
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
  assert.equal(sent[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/a%2Fb%3Fc?output_format=pcm_24000');
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
