// Voice-overs: the voices Cadence offers and their download, each scene's sentences spoken by Piper and cached by content
// in projects/<id>/.cadence/voice-over/, and the track that lays them over the video for the preview and the render.
import { createHash } from 'node:crypto';
import { createWriteStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ProjectFile, SceneState, VoiceInfo, VoiceOverLine, VoiceOverSettings, VoicesState } from '../../src/shared/types';
import type {
  BrandStore,
  CadenceConfig,
  Hub,
  ProjectStore,
  SpeechEngine,
  VoiceOverProvider,
  VoiceOverService,
  VoiceOverTrack,
} from '../contracts';
import { m } from '../i18n';
import { DEFAULT_BRAND } from '../store/brands';
import { HttpError, KeyedMutex, pathExists, randomToken, roundMs, shortHash, writeFileAtomic } from '../util';
import { VOICES, defaultVoiceOver, voiceParts, voiceSpec, voiceUrl, type VoiceSpec } from './voices';
import { readWav, wavSeconds, writeWav } from './wav';

/** Typing in the editor saves often: speak once the text rests. */
const SYNC_DELAY_MS = 400;

interface Sentence {
  text: string;
  file: string;
  /** null until Piper has spoken it. */
  seconds: number | null;
}

interface PlacedLine extends VoiceOverLine {
  file: string;
}

/** The sentences Piper speaks one by one (line breaks end a sentence too). */
export function splitSentences(text: string, language: 'fr' | 'en'): string[] {
  const segments = new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text);
  return [...segments].map((s) => s.segment.replace(/\s+/g, ' ').trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export class LocalVoiceOverService implements VoiceOverService {
  private seconds = new Map<string, { size: number; seconds: number }>();
  private mutex = new KeyedMutex();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Per project, the sentences Piper last failed on: retried only once they change, or when someone asks. */
  private failed = new Map<string, string>();
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
      fetch?: typeof fetch;
    },
  ) {}

  async voices(): Promise<VoicesState> {
    const [piper, voices] = await Promise.all([this.deps.engine.check(), Promise.all(VOICES.map((spec) => this.info(spec)))]);
    return { piper, voices };
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
    const planned = await this.plan(id, voiceOver, scenes);
    const lines = place(planned);
    const missing = missingKey(planned);
    if (missing && this.failed.get(id) !== missing) this.schedule(id);
    return {
      voiceOver,
      voiceOverUrl: lines.length ? `/api/projects/${id}/voice-over/audio?v=${trackKey(lines)}` : null,
      voiceOverLines: lines.map(({ file: _file, ...line }) => line),
      voiceOverPending: planned.filter((p) => p.sentences.some((s) => s.seconds === null)).map((p) => p.scene.id),
    };
  };

  async sync(projectId: string): Promise<void> {
    this.unschedule(projectId);
    // Its own store.get() schedules the missing sentences again: drop that, or a failure would retry on its own.
    await this.mutex.run(projectId, () => this.speakMissing(projectId).finally(() => this.unschedule(projectId)));
  }

  private async speakMissing(projectId: string): Promise<void> {
    const project = await this.deps.store.get(projectId);
    const planned = await this.plan(projectId, project.voiceOver, project.scenes);
    const missing = [
      ...new Map(planned.flatMap((p) => p.sentences.filter((s) => s.seconds === null)).map((s) => [s.file, s])).values(),
    ];
    if (!missing.length) return;
    const { hub, engine } = this.deps;
    hub.send({ type: 'voice-over', projectId, status: 'speaking' });
    try {
      const { voice, speed } = project.voiceOver;
      const spec = voiceSpec(voice);
      if (!spec) throw new HttpError(400, m().media.voiceOver.unknownVoice(voice));
      if (!(await this.installed(spec))) throw new HttpError(409, m().media.voiceOver.notDownloaded(spec.name));
      await fs.mkdir(this.cacheDir(projectId), { recursive: true });
      await engine.speak({
        model: this.modelFile(spec),
        sentences: missing.map((s) => s.text),
        lengthScale: 1 / speed,
        files: missing.map((s) => s.file),
      });
      this.failed.delete(projectId);
    } catch (e) {
      this.failed.set(projectId, missingKey(planned));
      hub.send({ type: 'voice-over', projectId, status: 'error', error: (e as Error).message });
      throw e;
    }
    hub.send({ type: 'voice-over', projectId, status: 'ready' });
    // The editor and its frames re-fetch the project: new lines, new track.
    hub.send({ type: 'project-changed', projectId });
  }

  async track(projectId: string): Promise<VoiceOverTrack | null> {
    const project = await this.deps.store.get(projectId);
    const lines = place(await this.plan(projectId, project.voiceOver, project.scenes));
    if (!lines.length) return null;
    const file = path.join(this.cacheDir(projectId), 'track.wav');
    const key = trackKey(lines);
    await this.mutex.run(`track:${projectId}`, async () => {
      if (this.built.get(projectId) === key && (await pathExists(file))) return;
      const sentences = await Promise.all(lines.map((line) => fs.readFile(line.file).then(readWav)));
      const rate = sentences[0].sampleRate;
      const samples = new Int16Array(Math.ceil(Math.max(...lines.map((l) => l.end)) * rate));
      for (const [i, line] of lines.entries()) {
        const at = Math.round(line.start * rate);
        const source = sentences[i].samples;
        // A sentence that runs into the next scene's voice-over overlaps it: both are heard.
        for (let j = 0; j < source.length && at + j < samples.length; j++) {
          samples[at + j] = Math.max(-32768, Math.min(32767, samples[at + j] + source[j]));
        }
      }
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
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
  }

  private schedule(projectId: string): void {
    clearTimeout(this.timers.get(projectId));
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      // The editor hears about a failure through the hub event.
      this.sync(projectId).catch(() => undefined);
    }, SYNC_DELAY_MS);
    timer.unref();
    this.timers.set(projectId, timer);
  }

  private async plan(projectId: string, settings: VoiceOverSettings, scenes: SceneState[]) {
    const { language } = voiceParts(settings.voice);
    const dir = this.cacheDir(projectId);
    const planned: { scene: SceneState; sentences: Sentence[] }[] = [];
    for (const scene of scenes) {
      if (!scene.voiceOver) continue;
      const sentences: Sentence[] = [];
      for (const text of splitSentences(scene.voiceOver.text, language)) {
        const file = path.join(dir, `${shortHash(`${settings.voice}\n${settings.speed}\n${text}`)}.wav`);
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
  private async language(data: ProjectFile): Promise<'fr' | 'en'> {
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

function missingKey(planned: { sentences: Sentence[] }[]): string {
  const files = planned.flatMap((p) => p.sentences.filter((s) => s.seconds === null).map((s) => path.basename(s.file)));
  return [...new Set(files)].sort().join(',');
}

function trackKey(lines: PlacedLine[]): string {
  return shortHash(JSON.stringify(lines.map((l) => [path.basename(l.file), l.start])));
}
