// ElevenLabs speaks the voice-over with the person's own API key, billed on their account. Raw 24 kHz PCM, wrapped
// into the same 16-bit mono WAV Piper writes, so the cache, the track and the render stay as they are.
import type { ElevenLabsModel, ElevenLabsVoice } from '../../src/shared/types';
import type { ElevenLabsApi, Fetch } from '../contracts';
import { m } from '../i18n';
import { HttpError, writeFileAtomic } from '../util';
import { writeWav } from './wav';

/** What an ElevenLabs voice id and model id look like (`JBFqnCBsd6RMkjVDRZzb`, `eleven_multilingual_v2`). */
export const ELEVENLABS_VOICE_PATTERN = /^[A-Za-z0-9]{1,64}$/;
export const ELEVENLABS_MODEL_PATTERN = /^[a-z0-9_]{1,64}$/;

const API = 'https://api.elevenlabs.io';
/** `pcm_24000`: 16-bit signed little-endian mono PCM, available on every plan. */
const SAMPLE_RATE = 24000;
const LIST_TIMEOUT_MS = 15_000;
const SPEAK_TIMEOUT_MS = 120_000;

export class ElevenLabsClient implements ElevenLabsApi {
  constructor(private readonly http: Fetch = (input, init) => fetch(input, init)) {}

  async voices(key: string): Promise<ElevenLabsVoice[]> {
    const data = (await this.json(key, '/v2/voices?page_size=100')) as {
      voices: {
        voice_id: string;
        name: string;
        category: string;
        preview_url?: string | null;
        verified_languages?: { language: string }[] | null;
      }[];
    };
    return data.voices.map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      category: voice.category,
      previewUrl: voice.preview_url ?? null,
      languages: [...new Set((voice.verified_languages ?? []).map((verified) => verified.language))],
    }));
  }

  async models(key: string): Promise<ElevenLabsModel[]> {
    const data = (await this.json(key, '/v1/models')) as { model_id: string; name: string; can_do_text_to_speech: boolean }[];
    return data.filter((model) => model.can_do_text_to_speech).map((model) => ({ id: model.model_id, name: model.name }));
  }

  async speak(input: {
    key: string;
    voice: string;
    model: string;
    speed: number;
    sentences: string[];
    files: string[];
  }): Promise<void> {
    const { key, voice, model, speed, sentences, files } = input;
    for (const [i, text] of sentences.entries()) {
      const pcm = await this.request(
        key,
        `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${SAMPLE_RATE}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: model, voice_settings: { speed } }),
          signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
        },
        async (res) => Buffer.from(await res.arrayBuffer()),
      );
      const samples = new Int16Array(pcm.length >> 1);
      for (let s = 0; s < samples.length; s++) samples[s] = pcm.readInt16LE(s * 2);
      await writeFileAtomic(files[i], writeWav({ sampleRate: SAMPLE_RATE, samples }));
    }
  }

  private json(key: string, route: string): Promise<unknown> {
    return this.request(key, route, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }, (res) => res.json());
  }

  /** The OK answer's body, else an HttpError in the interface language. */
  private async request<T>(key: string, route: string, init: RequestInit, read: (res: Response) => Promise<T>): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${API}${route}`, { ...init, headers: { ...init.headers, 'xi-api-key': key } });
      // The timeout also covers the body: a body cut short is no answer either.
      if (res.ok) return await read(res);
    } catch {
      throw new HttpError(502, m().media.voiceOver.elevenLabsDown);
    }
    throw await elevenLabsError(res, key);
  }
}

/**
 * ElevenLabs' own words when it gives some, never the key. A refused key is a 400: 401 means Cadence's own tokens.
 * A spent quota comes back as a 401 too, so its status is read first.
 */
async function elevenLabsError(res: Response, key: string): Promise<HttpError> {
  const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = data?.detail as { status?: unknown; message?: unknown } | string | null | undefined;
  const said = typeof detail === 'string' ? detail : detail?.message;
  const message = typeof said === 'string' ? said.split(key).join('***') : null;
  const reason = typeof detail === 'object' ? detail?.status : undefined;
  if (res.status === 429 || reason === 'quota_exceeded') return new HttpError(429, m().media.voiceOver.elevenLabsQuota(message));
  if (res.status === 401 || res.status === 403) return new HttpError(400, m().media.voiceOver.elevenLabsKeyRefused(message));
  return new HttpError(502, m().media.voiceOver.elevenLabsSaid(message ?? m().media.voiceOver.elevenLabsHttpStatus(res.status)));
}
