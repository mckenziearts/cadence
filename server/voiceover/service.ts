// Voice-overs: the voices Cadence offers and their download, each scene's sentences spoken by Piper or ElevenLabs and
// cached by content in projects/<id>/.cadence/voice-over/, and the track that lays them over the video for the preview
// and the render. The ElevenLabs key lives in .cadence/elevenlabs.json (mode 600): never sent to the browser, never in a
// project (projects are versioned), and denied to Claude Code's tools. Codex's sandbox limits writes only: it can read it.
import { createHash } from 'node:crypto';
import { createWriteStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  ElevenLabsModel,
  ElevenLabsVoice,
  ProjectFile,
  SceneState,
  VoiceInfo,
  VoiceOverLine,
  VoiceOverSettings,
  VoicesState,
} from '../../src/shared/types';
import type {
  BrandStore,
  CadenceConfig,
  ElevenLabsApi,
  Hub,
  ProjectStore,
  SpeechEngine,
  VoiceOverProvider,
  VoiceOverService,
  VoiceOverTrack,
} from '../contracts';
import { m } from '../i18n';
import { DEFAULT_BRAND } from '../store/brands';
import { HttpError, KeyedMutex, pathExists, randomToken, readJsonOr, roundMs, shortHash, writeFileAtomic } from '../util';
import { VOICES, defaultVoiceOver, voiceParts, voiceSpec, voiceUrl, type VoiceSpec } from './voices';
import { readWav, wavSeconds, writeWav } from './wav';

/** Typing in the editor saves often: speak once the text rests. */
const SYNC_DELAY_MS = 400;
/** How long the gain of an overlap that would clip takes to come back to 1 on each side. */
const OVERLAP_RAMP_S = 0.02;

interface Sentence {
  text: string;
  file: string;
  /** null until it is spoken. */
  seconds: number | null;
}

interface PlacedLine extends VoiceOverLine {
  file: string;
}

/** What decides the video's language: a ProjectFile or a ProjectState. */
type Video = Pick<ProjectFile, 'language' | 'brand'>;

/** The sentences Piper speaks one by one (line breaks end a sentence too). */
export function splitSentences(text: string, language: 'fr' | 'en'): string[] {
  const segments = new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text);
  return [...segments].map((s) => s.segment.replace(/\s+/g, ' ').trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export class LocalVoiceOverService implements VoiceOverService {
  private seconds = new Map<string, { size: number; seconds: number }>();
  private mutex = new KeyedMutex();
  /** Per project, the pending automatic sync and the missing sentences it was set for. */
  private timers = new Map<string, { timer: NodeJS.Timeout; key: string }>();
  /** Projects being synced: reading them neither schedules another try nor shows the last failure. */
  private syncing = new Set<string>();
  /** Per project, the sentences Piper last failed on and why: retried only once they change, or when someone asks. */
  private failed = new Map<string, { key: string; error: string }>();
  private downloads = new Map<string, Promise<void>>();
  /** Per project, which lines the track.wav on disk holds. */
  private built = new Map<string, string>();

  constructor(
    private readonly deps: {
      config: CadenceConfig;
      store: ProjectStore;
      brands: BrandStore;
      hub: Hub;
      engine: SpeechEngine;
      elevenLabs: ElevenLabsApi;
      fetch?: typeof fetch;
    },
  ) {}

  async voices(): Promise<VoicesState> {
    const [piper, voices, key] = await Promise.all([
      this.deps.engine.check(),
      Promise.all(VOICES.map((spec) => this.info(spec))),
      this.elevenLabsKey(),
    ]);
    return { piper, voices, elevenLabs: { configured: key !== null } };
  }

  async elevenLabs(): Promise<{ voices: ElevenLabsVoice[]; models: ElevenLabsModel[] }> {
    const key = await this.elevenLabsKey();
    if (!key) throw new HttpError(409, m().media.voiceOver.elevenLabsNoKey);
    const [voices, models] = await Promise.all([this.deps.elevenLabs.voices(key), this.deps.elevenLabs.models(key)]);
    return { voices, models };
  }

  async setElevenLabsKey(key: string | null): Promise<void> {
    // The check runs in turn too: a removal sent during a slow check is not undone by the key it was checking.
    await this.mutex.run('elevenlabs:key', async () => {
      if (key === null) return fs.rm(this.elevenLabsFile(), { force: true });
      await this.deps.elevenLabs.voices(key);
      await writeFileAtomic(this.elevenLabsFile(), `${JSON.stringify({ key }, null, 2)}\n`, 0o600);
    });
  }

  async download(id: string): Promise<VoiceInfo> {
    const spec = voiceSpec(id);
    if (!spec) throw new HttpError(404, m().media.voiceOver.unknownVoice(id));
    let running = this.downloads.get(id);
    if (!running) {
      running = this.fetchVoice(spec).finally(() => this.downloads.delete(id));
      this.downloads.set(id, running);
    }
    await running;
    return this.info(spec);
  }

  /** ProjectState's voice-over fields, from the cache only; the sentences still missing are spoken in the background. */
  readonly provider: VoiceOverProvider = async (id, data, scenes) => {
    const voiceOver = data.voiceOver ?? defaultVoiceOver(await this.language(data));
    const planned = await this.plan(id, data, voiceOver, scenes);
    const lines = place(planned);
    const missing = missingKey(planned);
    const failure = this.failed.get(id);
    const syncing = this.syncing.has(id);
    // ElevenLabs bills every request: only an explicit sync speaks, never half-typed text (nor a Piper try still set).
    if (voiceOver.engine === 'elevenlabs') this.unschedule(id);
    // The editor and the frames read the project at any time: once per set of missing sentences, never during a sync,
    // and a read never pushes back the try already set.
    else if (missing && !syncing && failure?.key !== missing && this.timers.get(id)?.key !== missing) this.schedule(id, missing);
    return {
      voiceOver,
      voiceOverUrl: lines.length ? `/api/projects/${id}/voice-over/audio?v=${trackKey(lines)}` : null,
      voiceOverLines: lines.map(({ file: _file, ...line }) => line),
      voiceOverPending: planned.filter((p) => p.sentences.some((s) => s.seconds === null)).map((p) => p.scene.id),
      voiceOverError: missing && !syncing && failure?.key === missing ? failure.error : null,
    };
  };

  async sync(projectId: string): Promise<void> {
    this.unschedule(projectId);
    await this.mutex.run(projectId, async () => {
      this.syncing.add(projectId);
      try {
        await this.speakMissing(projectId);
      } finally {
        this.syncing.delete(projectId);
      }
    });
  }

  private async speakMissing(projectId: string): Promise<void> {
    const project = await this.deps.store.get(projectId);
    const planned = await this.plan(projectId, project, project.voiceOver, project.scenes);
    const missing = [
      ...new Map(planned.flatMap((p) => p.sentences.filter((s) => s.seconds === null)).map((s) => [s.file, s])).values(),
    ];
    if (!missing.length) return;
    const { hub, engine, elevenLabs } = this.deps;
    hub.send({ type: 'voice-over', projectId, status: 'speaking' });
    try {
      const { engine: engineId, voice, model, speed } = project.voiceOver;
      const sentences = missing.map((s) => s.text);
      const files = missing.map((s) => s.file);
      if (engineId === 'elevenlabs') {
        const key = await this.elevenLabsKey();
        if (!key) throw new HttpError(409, m().media.voiceOver.elevenLabsNoKey);
        await fs.mkdir(this.cacheDir(projectId), { recursive: true });
        // The store never keeps ElevenLabs settings without their model.
        await elevenLabs.speak({ key, voice, model: model!, speed, sentences, files });
      } else {
        const spec = voiceSpec(voice);
        if (!spec) throw new HttpError(400, m().media.voiceOver.unknownVoice(voice));
        if (!(await this.installed(spec))) throw new HttpError(409, m().media.voiceOver.notDownloaded(spec.name));
        await fs.mkdir(this.cacheDir(projectId), { recursive: true });
        await engine.speak({ model: this.modelFile(spec), sentences, lengthScale: 1 / speed, files });
      }
      this.failed.delete(projectId);
    } catch (e) {
      const error = (e as Error).message;
      this.failed.set(projectId, { key: missingKey(planned), error });
      hub.send({ type: 'voice-over', projectId, status: 'error', error });
      throw e;
    }
    hub.send({ type: 'voice-over', projectId, status: 'ready' });
    // The editor and its frames re-fetch the project: new lines, new track.
    hub.send({ type: 'project-changed', projectId });
  }

  async track(projectId: string): Promise<VoiceOverTrack | null> {
    const project = await this.deps.store.get(projectId);
    const lines = place(await this.plan(projectId, project, project.voiceOver, project.scenes));
    if (!lines.length) return null;
    const file = path.join(this.cacheDir(projectId), 'track.wav');
    const key = trackKey(lines);
    await this.mutex.run(`track:${projectId}`, async () => {
      if (this.built.get(projectId) === key && (await pathExists(file))) return;
      const sentences = await Promise.all(lines.map((line) => fs.readFile(line.file).then(readWav)));
      const rate = sentences[0].sampleRate;
      const mix = new Int32Array(Math.ceil(Math.max(...lines.map((l) => l.end)) * rate));
      const spans: [number, number][] = [];
      for (const [i, line] of lines.entries()) {
        const at = Math.round(line.start * rate);
        const source = sentences[i].samples;
        for (let j = 0; j < source.length && at + j < mix.length; j++) mix[at + j] += source[j];
        spans.push([at, Math.min(mix.length, at + source.length)]);
      }
      // A sentence that runs into the next scene's voice-over overlaps it: both are heard, and where their sum would
      // clip, the shared stretch is lowered just enough.
      lowerOverlaps(mix, spans, Math.round(OVERLAP_RAMP_S * rate));
      const samples = new Int16Array(mix.length);
      for (let i = 0; i < mix.length; i++) samples[i] = Math.max(-32768, Math.min(32767, mix[i]));
      await writeFileAtomic(file, writeWav({ sampleRate: rate, samples }));
      this.built.set(projectId, key);
    });
    return {
      file,
      lines: lines.map(({ file: _file, ...line }) => line),
      musicLevel: project.voiceOver.musicLevel,
    };
  }

  private unschedule(projectId: string): void {
    clearTimeout(this.timers.get(projectId)?.timer);
    this.timers.delete(projectId);
  }

  private schedule(projectId: string, key: string): void {
    clearTimeout(this.timers.get(projectId)?.timer);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      // The editor hears about a failure through the hub event.
      this.sync(projectId).catch(() => undefined);
    }, SYNC_DELAY_MS);
    timer.unref();
    this.timers.set(projectId, { timer, key });
  }

  private async plan(projectId: string, project: Video, settings: VoiceOverSettings, scenes: SceneState[]) {
    const elevenLabs = settings.engine === 'elevenlabs';
    // An ElevenLabs voice speaks any language: the sentences follow the video's.
    const language = elevenLabs ? await this.language(project) : voiceParts(settings.voice).language;
    // Piper's names stay what they always were, so existing caches and restored versions find their sentences.
    const voice = elevenLabs ? `elevenlabs\n${settings.model}\n${settings.voice}` : settings.voice;
    const dir = this.cacheDir(projectId);
    const planned: { scene: SceneState; sentences: Sentence[] }[] = [];
    for (const scene of scenes) {
      if (!scene.voiceOver) continue;
      const sentences: Sentence[] = [];
      for (const text of splitSentences(scene.voiceOver.text, language)) {
        const file = path.join(dir, `${shortHash(`${voice}\n${settings.speed}\n${text}`)}.wav`);
        sentences.push({ text, file, seconds: await this.secondsOf(file) });
      }
      if (sentences.length) planned.push({ scene, sentences });
    }
    return planned;
  }

  private async secondsOf(file: string): Promise<number | null> {
    const stat: Stats | null = await fs.stat(file).catch(() => null);
    if (!stat) return null;
    const known = this.seconds.get(file);
    if (known?.size === stat.size) return known.seconds;
    const seconds = await wavSeconds(file).catch(() => null);
    if (seconds !== null) this.seconds.set(file, { size: stat.size, seconds });
    return seconds;
  }

  /** The video's on-screen language, which picks the default voice. */
  private async language(data: Video): Promise<'fr' | 'en'> {
    if (data.language) return data.language;
    const brand = await this.deps.brands.get(data.brand ?? DEFAULT_BRAND).catch(() => null);
    return brand?.language ?? 'fr';
  }

  private async info(spec: VoiceSpec): Promise<VoiceInfo> {
    const { language, locale, quality } = voiceParts(spec.id);
    const { id, name, license, commercial, credit, size } = spec;
    return { id, language, locale, name, quality, license, commercial, credit, size, installed: await this.installed(spec) };
  }

  private async installed(spec: VoiceSpec): Promise<boolean> {
    const model = this.modelFile(spec);
    return (await pathExists(model)) && (await pathExists(`${model}.json`));
  }

  private async fetchVoice(spec: VoiceSpec): Promise<void> {
    await fs.mkdir(this.voicesDir(), { recursive: true });
    // The model last: a voice counts as installed once both files are there, and each is only renamed in once checked.
    for (const [ext, md5] of [
      ['.onnx.json', spec.md5.json],
      ['.onnx', spec.md5.onnx],
    ] as const) {
      const file = path.join(this.voicesDir(), `${spec.id}${ext}`);
      if (await pathExists(file)) continue;
      const res = await (this.deps.fetch ?? fetch)(voiceUrl(spec, ext)).catch((e: Error) => {
        throw new HttpError(502, m().media.voiceOver.downloadFailed(spec.name, e.message));
      });
      if (!res.ok || !res.body) throw new HttpError(502, m().media.voiceOver.downloadFailed(spec.name, `HTTP ${res.status}`));
      const part = `${file}.${randomToken(6)}.part`;
      const hash = createHash('md5');
      try {
        await pipeline(
          Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              hash.update(chunk);
              yield chunk;
            }
          },
          createWriteStream(part),
        );
        if (hash.digest('hex') !== md5) throw new HttpError(502, m().media.voiceOver.corrupted(spec.name));
        await fs.rename(part, file);
      } finally {
        await fs.rm(part, { force: true });
      }
    }
  }

  private async elevenLabsKey(): Promise<string | null> {
    const file = this.elevenLabsFile();
    // JSON.parse quotes the text it chokes on: a hand-edited file must not put the key in an error the agent reads.
    const saved = await readJsonOr<{ key?: string }>(file, {}).catch(() => {
      throw new HttpError(500, m().media.voiceOver.elevenLabsKeyUnreadable(file));
    });
    return saved.key ?? null;
  }

  private elevenLabsFile(): string {
    return path.join(this.deps.config.stateDir, 'elevenlabs.json');
  }

  private voicesDir(): string {
    return path.join(this.deps.config.stateDir, 'voices');
  }

  private modelFile(spec: VoiceSpec): string {
    return path.join(this.voicesDir(), `${spec.id}.onnx`);
  }

  private cacheDir(projectId: string): string {
    return path.join(this.deps.store.dir(projectId), '.cadence', 'voice-over');
  }
}

/**
 * Each scene's sentences one after the other from `scene.start + at`, in video seconds. A scene with a sentence not
 * spoken yet has no line at all: where its later sentences fall is not known.
 */
function place(planned: { scene: SceneState; sentences: Sentence[] }[]): PlacedLine[] {
  const lines: PlacedLine[] = [];
  for (const { scene, sentences } of planned) {
    if (sentences.some((s) => s.seconds === null)) continue;
    let t = scene.start + (scene.voiceOver?.at ?? 0);
    for (const { text, file, seconds } of sentences) {
      lines.push({ sceneId: scene.id, text, start: roundMs(t), end: roundMs(t + seconds!), file });
      t += seconds!;
    }
  }
  return lines;
}

/**
 * Lowers, in place, each stretch where sentences overlap and their sum passes 32767: one gain brings its peak to 32767,
 * with linear ramps of `ramp` samples back to 1 on each side. Stretches closer than two ramps count as one, so ramps
 * never cross.
 */
function lowerOverlaps(mix: Int32Array, spans: [number, number][], ramp: number): void {
  const stretches: [number, number][] = [];
  let furthest = 0;
  for (const [start, end] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (start < furthest) {
      const last = stretches.at(-1);
      if (last && start - last[1] < 2 * ramp) last[1] = Math.max(last[1], Math.min(end, furthest));
      else stretches.push([start, Math.min(end, furthest)]);
    }
    furthest = Math.max(furthest, end);
  }
  for (const [start, end] of stretches) {
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(mix[i]));
    if (peak <= 32767) continue;
    const g = 32767 / peak;
    for (let i = Math.max(0, start - ramp + 1); i < Math.min(mix.length, end + ramp - 1); i++) {
      const away = i < start ? start - i : i >= end ? i - end + 1 : 0;
      mix[i] = Math.round(mix[i] * (g + ((1 - g) * away) / ramp));
    }
  }
}

function missingKey(planned: { sentences: Sentence[] }[]): string {
  const files = planned.flatMap((p) => p.sentences.filter((s) => s.seconds === null).map((s) => path.basename(s.file)));
  return [...new Set(files)].sort().join(',');
}

function trackKey(lines: PlacedLine[]): string {
  return shortHash(JSON.stringify(lines.map((l) => [path.basename(l.file), l.start])));
}
