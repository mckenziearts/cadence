// A dialogue made through MCP tools alone, on the whole server: a scene template that brings a mouth component, two
// speakers, lines spoken by a fake ElevenLabs (no request leaves the machine, no agent turn runs) and frames where each
// mouth opens with its speaker's voice. Run with the person's key in the store, then with a host app's client and
// gateway: the results are the same.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentProvider, Fetch } from '../../server/contracts';
import { startServer } from '../../server/index';
import { ElevenLabsClient } from '../../server/voiceover/elevenlabs';
import { FIXTURES, near, pixel, ROOT } from './helpers/harness';

const TEMPLATES = path.join(FIXTURES, 'templates/dialogue');
const MOUTH = path.join(TEMPLATES, 'scenes/dialogue/components/Mouth.tsx');
const ELEVENLABS = 'https://api.elevenlabs.io';
const GATEWAY = 'https://gateway.example/elevenlabs';
const PERSON_KEY = 'sk_person';
const HOST_KEY = 'host-key-4567';
const SAMPLE_RATE = 24000;
/** Pixels of the 960×540 frames render_frames sends: inside a mouth when it opens wide, outside it when it is closed. */
const CAMILLE_MOUTH = [240, 195] as const;
const SAMI_MOUTH = [720, 195] as const;

const provider: AgentProvider = {
  id: 'fake',
  label: 'Agent factice',
  status: async () => ({ ok: true, label: 'Agent factice' }),
  async *run() {
    yield { type: 'done', text: '', isError: false, durationMs: 0 };
  },
};

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Content[]; isError?: boolean };

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** 0.4 s plus 20 ms a character of a 500 Hz square wave, loudest in the middle of the sentence. */
function speech(text: string): string {
  const count = Math.round((0.4 + 0.02 * text.length) * SAMPLE_RATE);
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const envelope = 1 - Math.abs((2 * i) / count - 1);
    pcm.writeInt16LE(Math.round((Math.floor(i / 24) % 2 ? 20000 : -20000) * envelope), i * 2);
  }
  return pcm.toString('base64');
}

/** ElevenLabs as it answers at `baseUrl` with `key`; any other request fails as if the network were down. */
function fakeElevenLabs(baseUrl: string, key: string): { http: Fetch; sent: { url: string; key: string | null }[] } {
  const sent: { url: string; key: string | null }[] = [];
  const http: Fetch = async (url, init = {}) => {
    const given = new Headers(init.headers).get('xi-api-key');
    sent.push({ url, key: given });
    if (!url.startsWith(`${baseUrl}/`)) throw new TypeError(`no network in this test: ${url}`);
    if (given !== key) return json({ detail: { message: 'Invalid API key' } }, 401);
    const route = url.slice(baseUrl.length);
    if (route === '/v2/voices?page_size=100') {
      return json({
        voices: [
          { voice_id: 'voiceCamille', name: 'Camille', category: 'premade', verified_languages: [{ language: 'fr' }] },
          { voice_id: 'voiceSami', name: 'Sami', category: 'premade', verified_languages: [{ language: 'fr' }] },
        ],
      });
    }
    if (route === '/v1/models')
      return json([{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true }]);
    if (/^\/v1\/text-to-speech\/\w+\/with-timestamps\?output_format=pcm_24000$/.test(route) && init.method === 'POST') {
      return json({ audio_base64: speech((JSON.parse(String(init.body)) as { text: string }).text), alignment: null });
    }
    throw new TypeError(`no network in this test: ${url}`);
  };
  return { http, sent };
}

/** A JPEG as PNG, through ffmpeg: pngjs reads only PNG. */
function jpegToPng(jpeg: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v',
      'error',
      '-f',
      'jpeg_pipe',
      '-i',
      'pipe:0',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited with ${code}`))));
    ffmpeg.stdin.end(jpeg);
  });
}

const textOf = (result: Result) =>
  result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** The whole flow on a server of its own; what each tool answered, the project id replaced, and how the mouths look. */
async function dialogueFlow(name: string, elevenLabs: ElevenLabsClient): Promise<string[]> {
  // Own dependency cache: test files run in parallel and must not disturb a running Cadence.
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(ROOT, 'node_modules/.vite-e2e/dialogue');
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `cadence-e2e-dialogue-${name}-`));
  const id = `e2e-dialogue-${name}-${process.pid}`;
  const server = await startServer({
    editorPort: 0,
    framePort: 0,
    quiet: true,
    provider,
    root: ROOT,
    stateDir,
    templatesDir: TEMPLATES,
    elevenLabs,
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  try {
    const { store, tokens, voiceOver } = server.services;
    if (!elevenLabs.hosted) await voiceOver.setElevenLabsKey(PERSON_KEY);
    await store.create({ id, name: 'Dialogue', brand: null, formats: ['16:9'], fps: 30 });
    await store.update(id, {
      voiceOver: { engine: 'elevenlabs', voice: 'voiceCamille', model: 'eleven_multilingual_v2', speed: 1, musicLevel: 0.3 },
    });
    const dir = store.dir(id);

    const token = tokens.issue({ kind: 'project', projectId: id });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.config.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const replies: string[] = [];
    const call = async (tool: string, args: Record<string, unknown> = {}): Promise<Result> => {
      const result = (await client.callTool({ name: tool, arguments: args })) as Result;
      assert.ok(!result.isError, `${tool}: ${textOf(result)}`);
      replies.push(`${tool}: ${textOf(result).split(id).join('<project>')}`);
      return result;
    };

    assert.doesNotMatch(textOf(await call('get_project')), /Speakers:/);

    const templates = textOf(await call('list_templates'));
    assert.match(templates, /- `dialogue`: \*\*Dialogue\*\* .* Components \(copied into components\/\): Mouth\.tsx\./);
    assert.match(templates, /Speakers: camille \(Camille\), sami \(Sami\)\./);

    assert.equal(
      textOf(await call('list_voices')),
      'ElevenLabs voices (id: name (languages)):\n- voiceCamille: Camille (fr)\n- voiceSami: Sami (fr)',
    );

    const speakers = await call('set_speakers', {
      speakers: [
        { id: 'camille', name: 'Camille', voice: 'voiceCamille', color: '#e8590c' },
        { id: 'sami', name: 'Sami', voice: 'voiceSami' },
      ],
    });
    assert.equal(textOf(speakers), 'Speakers: camille "Camille" (voice voiceCamille), sami "Sami" (voice voiceSami)');

    const created = textOf(await call('create_scene', { name: 'Conversation', template: 'dialogue' }));
    const sceneId = /^Created scene (\S+) /.exec(created)?.[1];
    assert.ok(sceneId, created);
    const copied = path.join(dir, 'components/Mouth.tsx');
    assert.equal(await readFile(copied, 'utf8'), await readFile(MOUTH, 'utf8'));
    // A second scene of the template keeps the project's copy, edited or not.
    await appendFile(copied, '// Edited in the project.\n');
    const edited = await readFile(copied, 'utf8');
    await call('create_scene', { name: 'Suite', template: 'dialogue' });
    assert.equal(await readFile(copied, 'utf8'), edited);

    const said = textOf(
      await call('set_voice_over', {
        sceneId,
        at: 0.5,
        lines: [
          { speaker: 'camille', text: 'Bonjour Sami.' },
          { speaker: 'sami', text: 'Salut Camille. Ça va ?' },
        ],
      }),
    );
    const spoken = [...said.matchAll(/(\d+\.\d{3})-(\d+\.\d{3}) (\w+): "([^"]+)"/g)].map(([, start, end, speaker, text]) => ({
      start: Number(start),
      end: Number(end),
      speaker,
      text,
    }));
    // 0.4 s + 20 ms a character each, one after the other from 0.5 s, 0.2 s between the two speakers.
    assert.deepEqual(spoken, [
      { start: 0.5, end: 1.16, speaker: 'camille', text: 'Bonjour Sami.' },
      { start: 1.36, end: 2.04, speaker: 'sami', text: 'Salut Camille.' },
      { start: 2.04, end: 2.58, speaker: 'sami', text: 'Ça va ?' },
    ]);
    const cache = path.join(dir, '.cadence/voice-over');
    const files = (await readdir(cache)).sort();
    assert.equal(files.filter((f) => f.endsWith('.wav')).length, 3, files.join(', '));
    for (const sidecar of files.filter((f) => f.endsWith('.json'))) {
      const { words, level } = JSON.parse(await readFile(path.join(cache, sidecar), 'utf8')) as {
        words: unknown[];
        level: number[];
      };
      assert.ok(words.length > 0 && Math.max(...level) === 255, sidecar);
    }
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 3, files.join(', '));

    await call('set_scene_duration', { sceneId, seconds: 3.1 });

    // The loudest 40 ms window of Camille's line and of Sami's second sentence, from the levels the scene gets, and the
    // silence between the two speakers.
    const project = await store.get(id);
    const scene = project.scenes.find((s) => s.id === sceneId)!;
    const loudestAt = (speaker: string, text: string) => {
      const line = project.voiceOverLines.find((l) => l.sceneId === sceneId && l.speaker === speaker && l.text === text)!;
      const loudest = line.level.indexOf(Math.max(...line.level));
      return Math.round((line.start - scene.start + loudest / 25) * 1000) / 1000;
    };
    const between = (spoken[0].end + spoken[1].start) / 2;
    const times = [loudestAt('camille', 'Bonjour Sami.'), loudestAt('sami', 'Ça va ?'), between];
    const frames = await call('render_frames', { sceneId, times });
    const images = await Promise.all(
      frames.content.filter((c) => c.type === 'image').map((c) => jpegToPng(Buffer.from(c.data!, 'base64'))),
    );
    assert.equal(images.length, 3);
    const mouths = images.map((png) =>
      [CAMILLE_MOUTH, SAMI_MOUTH].map(([x, y]) => (near(pixel(png, x, y), [0, 0, 0], 40) ? 'open' : 'closed')).join(' '),
    );
    // Camille speaks while Sami listens, Sami answers while Camille listens, then both mouths are closed.
    assert.deepEqual(mouths, ['open closed', 'closed open', 'closed closed']);
    assert.ok(near(pixel(images[2], ...CAMILLE_MOUTH), [255, 255, 255], 40));
    replies.push(`mouths: ${mouths.join(' / ')}`);

    assert.match(textOf(await call('check_motion', { sceneId })), new RegExp(`\\n- ${sceneId}: `));
    assert.match(textOf(await call('save_version', { label: 'Dialogue' })), /^Saved version v\d{4} "Dialogue"/);
    return replies;
  } finally {
    await client.close();
    const { projectsDir } = server.config;
    await server.close();
    await rm(path.join(projectsDir, id), { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

const runs: string[][] = [];

it("makes a dialogue through MCP with the person's ElevenLabs key in the store", { timeout: 240_000 }, async () => {
  const { http, sent } = fakeElevenLabs(ELEVENLABS, PERSON_KEY);
  runs.push(await dialogueFlow('key', new ElevenLabsClient({ http })));
  assert.ok(sent.every((req) => req.url.startsWith(`${ELEVENLABS}/`) && req.key === PERSON_KEY));
  assert.equal(sent.filter((req) => req.url.includes('/with-timestamps')).length, 3, 'each sentence spoken once');
});

it("makes the same dialogue through a host app's ElevenLabs client and gateway", { timeout: 240_000 }, async () => {
  const { http, sent } = fakeElevenLabs(GATEWAY, HOST_KEY);
  runs.push(await dialogueFlow('host', new ElevenLabsClient({ http, baseUrl: GATEWAY, key: HOST_KEY })));
  assert.ok(sent.every((req) => req.url.startsWith(`${GATEWAY}/`) && req.key === HOST_KEY));
  assert.equal(sent.filter((req) => req.url.includes('/with-timestamps')).length, 3, 'each sentence spoken once');
  assert.deepEqual(runs[1], runs[0]);
});
