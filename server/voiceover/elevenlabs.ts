// ElevenLabs speaks the voice-over with the person's own API key, billed on their account, or through a host app that
// brings its own key and gateway. Raw 24 kHz PCM, wrapped into the same 16-bit mono WAV Piper writes, so the cache, the
// track and the render stay as they are, with the words and mouth levels of each sentence in a JSON file beside it.
import type { ElevenLabsModel, ElevenLabsVoice } from '../../src/shared/types';
import type { ElevenLabsApi, Fetch } from '../contracts';
import { m } from '../i18n';
import { HttpError, writeFileAtomic } from '../util';
import { levels } from './levels';
import { writeWav } from './wav';
import { wordsByProrata, wordsFromAlignment, type Alignment } from './words';

/** What an ElevenLabs voice id and model id look like (`JBFqnCBsd6RMkjVDRZzb`, `eleven_multilingual_v2`). */
export const ELEVENLABS_VOICE_PATTERN = /^[A-Za-z0-9]{1,64}$/;
export const ELEVENLABS_MODEL_PATTERN = /^[a-z0-9_]{1,64}$/;

const API = 'https://api.elevenlabs.io';
/** `pcm_24000`: 16-bit signed little-endian mono PCM, available on every plan. */
const SAMPLE_RATE = 24000;
const LIST_TIMEOUT_MS = 15_000;
const SPEAK_TIMEOUT_MS = 120_000;
/** The longest `retry-after` of a 429 worth waiting for, once, before giving up. */
const RETRY_AFTER_MAX_S = 30;
const MESSAGE_MAX = 300;
const LOOPBACK = ['localhost', '127.0.0.1'];

export interface ElevenLabsOptions {
  http?: Fetch;
  /** Where the API answers (a host app's gateway); ElevenLabs' own by default. */
  baseUrl?: string;
  /** A host app's own key (or a function giving it at each request): the client is hosted and ignores the key it is passed. */
  key?: string | (() => string | null | undefined | Promise<string | null | undefined>);
}

/** Where the words and mouth levels of a spoken sentence are kept: its WAV with `.json`. */
export function sidecarFile(wav: string): string {
  return wav.replace(/\.wav$/, '.json');
}

export class ElevenLabsClient implements ElevenLabsApi {
  readonly hosted: boolean;
  private readonly http: Fetch;
  private readonly baseUrl: string;
  private readonly key: ElevenLabsOptions['key'];

  constructor(options: ElevenLabsOptions = {}) {
    this.http = options.http ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? API).replace(/\/+$/, '');
    // The key travels in a header: in clear only to this machine.
    const { protocol, hostname } = new URL(this.baseUrl);
    if (protocol !== 'https:' && !(protocol === 'http:' && LOOPBACK.includes(hostname))) {
      throw new Error(m().media.voiceOver.elevenLabsInsecureUrl);
    }
    this.key = options.key;
    this.hosted = options.key !== undefined;
  }

  async voices(key: string | null): Promise<ElevenLabsVoice[]> {
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

  async models(key: string | null): Promise<ElevenLabsModel[]> {
    const data = (await this.json(key, '/v1/models')) as { model_id: string; name: string; can_do_text_to_speech: boolean }[];
    return data.filter((model) => model.can_do_text_to_speech).map((model) => ({ id: model.model_id, name: model.name }));
  }

  async speak(input: {
    key: string | null;
    voice: string;
    model: string;
    speed: number;
    sentences: string[];
    files: string[];
  }): Promise<void> {
    const { key, voice, model, speed, sentences, files } = input;
    for (const [i, text] of sentences.entries()) {
      const answer = (await this.request(
        key,
        `/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=pcm_${SAMPLE_RATE}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: model, voice_settings: { speed } }),
        },
        SPEAK_TIMEOUT_MS,
        (res) => res.json(),
      )) as { audio_base64?: unknown; alignment?: unknown } | null;
      const pcm = typeof answer?.audio_base64 === 'string' ? Buffer.from(answer.audio_base64, 'base64') : null;
      if (!pcm?.length || pcm.length % 2) throw new HttpError(502, m().media.voiceOver.elevenLabsNoSound);
      const samples = new Int16Array(pcm.length >> 1);
      for (let s = 0; s < samples.length; s++) samples[s] = pcm.readInt16LE(s * 2);
      const words = isAlignment(answer?.alignment)
        ? wordsFromAlignment(text, answer.alignment)
        : wordsByProrata(text, samples.length / SAMPLE_RATE);
      // The sidecar first: a WAV is what marks a sentence spoken, and it must never be there without its words. Into the
      // folder the caller made only, so a project deleted between two sentences stays deleted.
      const level = levels(samples, SAMPLE_RATE);
      await writeFileAtomic(sidecarFile(files[i]), JSON.stringify({ words, level }), undefined, { mkdir: false });
      await writeFileAtomic(files[i], writeWav({ sampleRate: SAMPLE_RATE, samples }), undefined, { mkdir: false });
    }
  }

  /** What the host's key function gives, never what it threw: its error may hold the key, or another secret. */
  private async hostKey(read: Exclude<ElevenLabsOptions['key'], string | undefined>): Promise<string | null | undefined> {
    try {
      return await read();
    } catch {
      throw new HttpError(502, m().media.voiceOver.elevenLabsHostKeyFailed);
    }
  }

  private json(key: string | null, route: string): Promise<unknown> {
    return this.request(key, route, {}, LIST_TIMEOUT_MS, (res) => res.json());
  }

  /** The OK answer's body, else an HttpError in the interface language. */
  private async request<T>(
    given: string | null,
    route: string,
    init: RequestInit,
    timeout: number,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const key = (this.key === undefined ? given : typeof this.key === 'string' ? this.key : await this.hostKey(this.key)) || null;
    // A host app has no Profile key to send the person to.
    if (!key)
      throw new HttpError(409, this.hosted ? m().media.voiceOver.elevenLabsHostNoKey : m().media.voiceOver.elevenLabsNoKey);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.http(`${this.baseUrl}${route}`, {
          ...init,
          headers: { ...init.headers, 'xi-api-key': key },
          signal: AbortSignal.timeout(timeout),
        });
        // The timeout also covers the body: a body cut short is no answer either.
        if (res.ok) return await read(res);
      } catch {
        throw new HttpError(502, m().media.voiceOver.elevenLabsDown);
      }
      const retryAfter = res.headers.get('retry-after') ?? '';
      const wait = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Infinity;
      if (res.status !== 429 || attempt > 0 || wait > RETRY_AFTER_MAX_S) {
        throw await elevenLabsError(res, key, this.hosted);
      }
      // An unread body holds its connection until it is collected.
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}

function isAlignment(value: unknown): value is Alignment {
  const alignment = value as Partial<Record<keyof Alignment, unknown>> | null | undefined;
  const times = (list: unknown) => Array.isArray(list) && list.every(Number.isFinite);
  return (
    Array.isArray(alignment?.characters) &&
    alignment.characters.every((character) => typeof character === 'string') &&
    times(alignment.character_start_times_seconds) &&
    times(alignment.character_end_times_seconds)
  );
}

/**
 * ElevenLabs' own words when it gives some (cut short), never the key. A refused key is a 400: 401 means Cadence's own
 * tokens. A spent quota comes back as a 401 too, so its status is read first. A host app's gateway speaks for itself:
 * its 401, 402 and 403 keep their status and its message.
 */
async function elevenLabsError(res: Response, key: string, hosted: boolean): Promise<HttpError> {
  const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = data?.detail as { status?: unknown; message?: unknown } | string | null | undefined;
  const said = typeof detail === 'string' ? detail : detail?.message;
  const message = typeof said === 'string' ? said.split(key).join('***').slice(0, MESSAGE_MAX) : null;
  const reason = typeof detail === 'object' ? detail?.status : undefined;
  const { voiceOver } = m().media;
  if (hosted && [401, 402, 403].includes(res.status)) {
    return new HttpError(res.status, message ?? voiceOver.elevenLabsSaid(voiceOver.elevenLabsHttpStatus(res.status)));
  }
  if (res.status === 429 || reason === 'quota_exceeded') return new HttpError(429, voiceOver.elevenLabsQuota(message));
  if (res.status === 402) return new HttpError(402, voiceOver.elevenLabsSaid(message ?? voiceOver.elevenLabsHttpStatus(402)));
  if (res.status === 401 || res.status === 403) return new HttpError(400, voiceOver.elevenLabsKeyRefused(message));
  return new HttpError(502, voiceOver.elevenLabsSaid(message ?? voiceOver.elevenLabsHttpStatus(res.status)));
}
