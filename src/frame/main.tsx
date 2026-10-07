// Frame page: renders one scene (or the whole video) of a project at an exact time. The same page backs the editor
// preview (cross-origin iframe, postMessage), thumbnails, the agent's frames, seam checks and MP4 renders.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import { BrandContext, SceneContext, createMusic, setAssetBase, type Music, type SceneProps, type VoiceOverInfo } from 'cadence';
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { FrameProjectData } from '../../server/frames/frameServer';
import type { BrandKit } from '../shared/brandKit';
import type { EditorToFrame, FrameApi, FrameRenderResult, FrameToEditor } from '../shared/frameProtocol';
import { parseSoundCues, videoSoundCues, type SceneSounds, type SoundCue, type SoundProps } from '../shared/sounds';
import { FORMATS, isFormatId, type FormatId, type FormatSpec, type ProjectState, type SceneState } from '../shared/types';
import { Captions } from './captions';
import { editorOrigins, postToEditor } from './editor';
import { texts } from './texts';

const BASE_FACES = [
  "400 32px 'Inter Variable'",
  "italic 400 32px 'Inter Variable'",
  "400 32px 'Geist Variable'",
  "400 32px 'Geist Mono Variable'",
  "400 32px 'JetBrains Mono Variable'",
];

const query = new URLSearchParams(location.search);
const projectId = query.get('project') ?? '';
const mode = query.get('mode') === 'capture' ? 'capture' : query.get('mode') === 'present' ? 'present' : 'editor';
const queryFormat = query.get('format');
let requestedFormat: FormatId | null = isFormatId(queryFormat) ? queryFormat : null;
let sceneId: string | null = query.get('scene') || null;
let currentT = Number(query.get('t')) || 0;
// Seam checks and thumbnails open the page with captions=0: they look at the scene, and a caption would hide part of it.
const captionsShown = query.get('captions') !== '0';

// After the base font styles, so the brand theme wins.
const brandStyle = document.createElement('style');
brandStyle.id = 'cadence-brand';
document.head.append(brandStyle);

const embedded = window.parent !== window;

interface LoadedScene {
  /** `<generation>-<codeVersion>`: the module is re-imported when it changes. */
  key: string;
  Comp: ComponentType<SceneProps> | null;
  /** The module's `sounds` export, checked when it is called. */
  sounds: unknown;
  error: string | null;
}

interface Picked {
  scene: SceneState;
  local: number;
}

type View =
  | { kind: 'empty' }
  | { kind: 'error'; title: string; message: string }
  | { kind: 'scene'; label: string; key: string; Comp: ComponentType<SceneProps>; props: SceneProps };

let data: FrameProjectData | null = null;
/** The brand module's kit; `kit` is the same kit in the project's on-screen language. */
let brandKit: BrandKit | null = null;
let kit: BrandKit | null = null;
let brandKey = '';
let brandError: string | null = null;
let loadError: string | null = null;
let loadedGeneration = 0;
let scenes = new Map<string, LoadedScene>();
const musicCache = new Map<string, Music>();
const voiceOverCache = new Map<string, VoiceOverInfo>();
/** Per scene and format, like the props `sounds()` gets; cleared with the music on every load. */
const soundsCache = new Map<string, SceneSounds>();
let renderErrors: string[] = [];
let boundaryFailed = false;
let lastErrors: string[] = [];
let lastPosted: string | null = null;
let lastPostedSounds: string | null = null;
let boundaryEpoch = 0;
/** src last decoded per <img>: scenes may swap the src of the same element over time. */
const decodedSrc = new WeakMap<HTMLImageElement, string>();

const root = createRoot(document.getElementById('root')!);

function post(message: FrameToEditor): void {
  if (embedded) postToEditor(message);
}

// Errors

/** Readable stack lines: project-relative paths, no origin, no cache-busting query. */
function cleanLine(line: string): string {
  const out = line
    .replace(/https?:\/\/[^/\s)]+/g, '')
    .replace(/\/@fs/g, '')
    .replace(/\?[^:\s)]*(?=:\d)/g, '');
  return (data ? out.split(`${data.project.dir}/`).join('') : out).trim();
}

function formatError(e: unknown): string {
  try {
    if (!(e instanceof Error)) return String(e);
    const stack = (e.stack ?? '')
      .split('\n')
      .slice(1, 6)
      .filter((line) => !line.includes('/node_modules/') && !line.includes('/src/frame/'))
      .map(cleanLine)
      .filter(Boolean)
      .join('\n');
    return String(stack ? `${e.message}\n${stack}` : e.message);
  } catch {
    // Scene code can throw anything: a value with no string form, an Error whose getters throw.
    return typeof e;
  }
}

function ErrorOverlay(props: { title: string; message: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: 72,
        background: '#fef3f2',
        color: '#7a271a',
        fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
        fontSize: 26,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          marginBottom: 28,
          color: '#b42318',
          fontFamily: "'Inter Variable', system-ui, sans-serif",
          fontSize: 40,
          fontWeight: 700,
          letterSpacing: '-0.02em',
        }}
      >
        {props.title}
      </div>
      {props.message}
    </div>
  );
}

class Boundary extends Component<{ label: string; children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const where = (info.componentStack ?? '')
      .split('\n')
      .filter((line) => line.includes('/scenes/') || line.includes('/components/'))
      .slice(0, 3)
      .map(cleanLine)
      .join('\n');
    renderErrors.push(`${texts.runtimeError(this.props.label)}\n${formatError(error)}${where ? `\n${where}` : ''}`);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return <ErrorOverlay title={texts.runtimeError(this.props.label)} message={formatError(this.state.error)} />;
  }
}

// Loading

async function fetchProjectData(): Promise<FrameProjectData> {
  const res = await fetch(`/frame-api/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as (FrameProjectData & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

async function loadBrand(next: FrameProjectData): Promise<void> {
  const generation = next.project.codeGeneration;
  const key = `${next.brandUrl}|${generation}`;
  if (key === brandKey) return;
  brandKey = key;
  try {
    const [css, mod] = await Promise.all([
      import(/* @vite-ignore */ `${next.brandUrl}theme.css?inline&g=${generation}`) as Promise<{ default: string }>,
      import(/* @vite-ignore */ `${next.brandUrl}index.tsx?g=${generation}`) as Promise<{ default?: BrandKit }>,
    ]);
    if (!mod.default?.ui) throw new Error(texts.kitExport);
    brandStyle.textContent = css.default;
    await Promise.all(next.brand.fonts.preload.map((face) => document.fonts.load(face).catch(() => undefined)));
    brandKit = mod.default;
    brandError = null;
  } catch (e) {
    brandError = texts.brandFailed(next.brandId, formatError(e));
  }
}

/** Vite hides compile errors behind "Failed to fetch dynamically imported module": ask the server. */
async function describeImportError(dir: string, scene: SceneState, e: unknown): Promise<string> {
  try {
    const url = `/frame-api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(scene.id)}/diagnostics`;
    const body = (await (await fetch(url, { cache: 'no-store' })).json()) as { error?: string | null };
    if (body.error) return body.error.split(`${dir}/`).join('');
  } catch {
    // fall back to the browser's message
  }
  return formatError(e);
}

async function importScene(project: ProjectState, scene: SceneState, key: string): Promise<LoadedScene> {
  try {
    const mod = (await import(/* @vite-ignore */ `${scene.url}?g=${key}`)) as { default?: unknown; sounds?: unknown };
    const Comp = mod.default;
    if (typeof Comp !== 'function' && (typeof Comp !== 'object' || Comp === null)) {
      throw new Error(texts.sceneExport(scene.id));
    }
    return { key, Comp: Comp as ComponentType<SceneProps>, sounds: mod.sounds, error: null };
  } catch (e) {
    return { key, Comp: null, sounds: undefined, error: await describeImportError(project.dir, scene, e) };
  }
}

/** The scenes this frame shows: one in scene mode, all in whole-video mode. */
const shownScenes = (project: ProjectState) => (sceneId ? project.scenes.filter((s) => s.id === sceneId) : project.scenes);

/** Import the shown scenes whose code changed. */
async function loadScenes(project: ProjectState, current: Map<string, LoadedScene>): Promise<Map<string, LoadedScene>> {
  const next = new Map(current);
  await Promise.all(
    shownScenes(project).map(async (scene) => {
      const key = `${project.codeGeneration}-${scene.codeVersion}`;
      if (next.get(scene.id)?.key !== key) next.set(scene.id, await importScene(project, scene, key));
    }),
  );
  return next;
}

/** Fetch the project, then swap everything at once so a render never mixes two versions. */
async function load(): Promise<void> {
  const next = await fetchProjectData();
  await loadBrand(next);
  const nextScenes = await loadScenes(next.project, scenes);
  data = next;
  scenes = nextScenes;
  // Scenes pick their copy with brand.language: the project's setting wins (a language change is no code change).
  kit = brandKit && { ...brandKit, language: next.project.language ?? brandKit.language };
  loadedGeneration = next.project.codeGeneration;
  setAssetBase(`/@fs${next.project.dir}/assets/`);
  musicCache.clear();
  voiceOverCache.clear();
  soundsCache.clear();
}

async function reloadNow(generation: number): Promise<void> {
  // The server bumps the generation before announcing it, so one fetch is normally enough.
  for (let attempt = 0; ; attempt++) {
    try {
      await load();
      loadError = null;
    } catch (e) {
      loadError = texts.projectFailed(projectId, formatError(e));
      break;
    }
    if (loadedGeneration >= generation || attempt >= 10) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  renderAt(currentT);
}

let queue: Promise<unknown> = Promise.resolve();

/** Loads, scene switches and seeks run one at a time, in call order. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// Rendering

function formatOf(project: ProjectState | undefined): FormatId {
  return requestedFormat ?? project?.formats[0] ?? '16:9';
}

/** Float noise (video time 2.3 − scene start 2 = 0.2999...) must not flip a `t >= 0.3` against the scene-mode preview. */
const tidy = (t: number) => Math.round(t * 1e9) / 1e9;

function pickScene(project: ProjectState, t: number): Picked | null {
  if (sceneId) {
    const scene = project.scenes.find((s) => s.id === sceneId);
    return scene ? { scene, local: tidy(Math.min(Math.max(0, t), scene.duration)) } : null;
  }
  // A frame exactly on a cut belongs to the next scene; the epsilon absorbs float sums like 0.5 + 0.6.
  for (const scene of project.scenes) {
    if (t < scene.start + scene.duration - 1e-9) return { scene, local: tidy(Math.max(0, t - scene.start)) };
  }
  const last = project.scenes.at(-1);
  return last ? { scene: last, local: last.duration } : null;
}

function musicFor(project: ProjectState, scene: SceneState): Music {
  const key = `${scene.id}|${scene.start}|${scene.duration}`;
  let music = musicCache.get(key);
  if (!music) {
    music = createMusic({
      grid: project.musicGrid,
      tempo: project.tempo,
      musicStart: project.music?.start ?? 0,
      sceneStart: scene.start,
      sceneDuration: scene.duration,
    });
    musicCache.set(key, music);
  }
  return music;
}

/** The scene's voice-over in scene seconds; one object per scene and project load, like its music. */
function voiceOverFor(project: ProjectState, scene: SceneState): VoiceOverInfo {
  let voiceOver = voiceOverCache.get(scene.id);
  if (!voiceOver) {
    const lines = project.voiceOverLines
      .filter((l) => l.sceneId === scene.id)
      .map((l) => ({ text: l.text, start: tidy(l.start - scene.start), end: tidy(l.end - scene.start) }));
    voiceOver = { text: scene.voiceOver?.text ?? '', lines };
    voiceOverCache.set(scene.id, voiceOver);
  }
  return voiceOver;
}

/** Everything the scene component gets but `t`: also what `sounds()` gets, so its cues match the render. */
function sceneProps(project: ProjectState, scene: SceneState, spec: FormatSpec, brand: BrandKit): SoundProps {
  return {
    duration: scene.duration,
    width: spec.width,
    height: spec.height,
    format: spec.id,
    orientation: spec.orientation,
    fps: project.fps,
    music: musicFor(project, scene),
    voiceOver: voiceOverFor(project, scene),
    scene: { id: scene.id, name: scene.name, index: scene.index, count: project.scenes.length, start: scene.start },
    brand,
  };
}

function evaluateSounds(project: ProjectState, scene: SceneState, spec: FormatSpec): SceneSounds {
  const loaded = scenes.get(scene.id);
  if (!loaded?.Comp || !kit || loaded.sounds === undefined) return { cues: [] };
  // Called on its own: `this` in a scene's sounds() must not reach the frame's record of the scene.
  const { sounds } = loaded;
  if (typeof sounds !== 'function') return { error: texts.soundsExport(scene.id) };
  try {
    return parseSoundCues(sounds(sceneProps(project, scene, spec, kit)), scene.duration, texts.soundCues);
  } catch (e) {
    return { error: formatError(e) };
  }
}

function soundsOf(project: ProjectState, scene: SceneState, spec: FormatSpec): SceneSounds {
  const loaded = scenes.get(scene.id);
  // The module version is in the key: a render during set-scene's import must not pin the old module's cues.
  const key = `${scene.id}|${loaded?.key}|${spec.id}`;
  let sounds = soundsCache.get(key);
  if (!sounds) {
    sounds = evaluateSounds(project, scene, spec);
    if (loaded) soundsCache.set(key, sounds);
  }
  return sounds;
}

/** The cues of the shown scenes on the frame's timeline, like `render`: video seconds, scene seconds in scene mode. */
function soundCues(): Required<SoundCue>[] {
  // A failed reload keeps the last project to draw from, but the frame shows the failure, not its scenes.
  if (!data || loadError) return [];
  const { project } = data;
  const spec = FORMATS[formatOf(project)];
  return videoSoundCues(
    shownScenes(project).map((scene) => ({ start: sceneId ? 0 : scene.start, sounds: soundsOf(project, scene, spec) })),
  );
}

function postSounds(): void {
  if (!embedded) return;
  const message: FrameToEditor = { source: 'cadence-frame', type: 'sounds', sceneId, cues: soundCues() };
  const signature = JSON.stringify(message);
  if (signature === lastPostedSounds) return;
  lastPostedSounds = signature;
  post(message);
}

function view(picked: Picked | null, spec: FormatSpec): View {
  if (loadError) return { kind: 'error', title: 'Projet indisponible', message: loadError };
  if (!data) return { kind: 'empty' };
  if (brandError) return { kind: 'error', title: 'Marque indisponible', message: brandError };
  if (!picked) {
    if (!sceneId) return { kind: 'empty' };
    return { kind: 'error', title: texts.sceneNotFound, message: texts.sceneMissing(sceneId) };
  }
  const { project } = data;
  const { scene, local } = picked;
  const label = `scenes/${scene.id}.tsx`;
  const loaded = scenes.get(scene.id);
  if (!loaded || !kit) return { kind: 'empty' };
  if (!loaded.Comp) return { kind: 'error', title: texts.compileError(label), message: loaded.error ?? '' };
  const props: SceneProps = { t: local, ...sceneProps(project, scene, spec, kit) };
  return { kind: 'scene', label, key: `${scene.id}:${loaded.key}:${boundaryEpoch}`, Comp: loaded.Comp, props };
}

function Stage(props: { spec: FormatSpec; view: View }) {
  const { spec, view } = props;
  const fit = mode === 'capture' ? 1 : Math.min(innerWidth / spec.width, innerHeight / spec.height);
  const colors = kit?.colors ?? data?.brand.colors;
  const fonts = kit?.fonts ?? data?.brand.fonts;
  let content: ReactNode = null;
  if (view.kind === 'error') content = <ErrorOverlay title={view.title} message={view.message} />;
  if (view.kind === 'scene') {
    const Scene = view.Comp;
    content = (
      <BrandContext.Provider value={view.props.brand}>
        <SceneContext.Provider value={view.props}>
          <Boundary key={view.key} label={view.label}>
            <Scene {...view.props} />
          </Boundary>
        </SceneContext.Provider>
      </BrandContext.Provider>
    );
  }
  return (
    <div
      data-cadence-stage=""
      style={{
        position: 'absolute',
        left: mode === 'capture' ? 0 : (innerWidth - spec.width * fit) / 2,
        top: mode === 'capture' ? 0 : (innerHeight - spec.height * fit) / 2,
        width: spec.width,
        height: spec.height,
        transform: fit === 1 ? undefined : `scale(${fit})`,
        transformOrigin: '0 0',
        overflow: 'hidden',
        contain: 'strict',
        background: colors?.background ?? '#ffffff',
        color: colors?.ink ?? '#0a0a0a',
        fontFamily: fonts?.body ?? "'Inter Variable', system-ui, sans-serif",
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {content}
      {/* Outside the scene's error boundary: a scene that throws keeps its captions. */}
      {view.kind === 'scene' && captionsShown && data?.project.captions && (
        <Captions lines={data.project.voiceOverLines} spec={spec} t={tidy(view.props.scene.start + view.props.t)} />
      )}
    </div>
  );
}

function renderAt(t: number): FrameRenderResult {
  currentT = Number.isFinite(t) ? t : 0;
  // Remount the error boundary after a failure: the scene may only throw at some times.
  if (boundaryFailed) boundaryEpoch++;
  renderErrors = [];
  const project = data?.project;
  const picked = project ? pickScene(project, currentT) : null;
  const spec = FORMATS[formatOf(project)];
  const shown = view(picked, spec);
  flushSync(() => root.render(<Stage spec={spec} view={shown} />));
  boundaryFailed = renderErrors.length > 0;
  const errors = [...(shown.kind === 'error' ? [`${shown.title}\n${shown.message}`] : []), ...renderErrors];
  // A failing sounds() is an error of the scene, which still draws.
  if (project && picked && shown.kind === 'scene') {
    const sounds = soundsOf(project, picked.scene, spec);
    if ('error' in sounds) errors.push(`${texts.soundsError(shown.label)}\n${sounds.error}`);
  }
  lastErrors = errors;
  const signature = errors.join('\n\u0000\n');
  if (signature !== lastPosted) {
    lastPosted = signature;
    post({ source: 'cadence-frame', type: 'errors', errors });
  }
  return { errors, sceneId: picked?.scene.id ?? null, localTime: picked?.local ?? 0 };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wait until what was rendered is what gets painted: fonts loaded, images decoded, two frames presented. */
async function settle(): Promise<void> {
  void document.body.offsetHeight; // style + layout now, so the fonts this frame needs start loading
  await document.fonts.ready;
  const images = Array.from(document.images).filter((img) => decodedSrc.get(img) !== img.src);
  await Promise.all(
    images.map((img) =>
      img.decode().then(
        () => decodedSrc.set(img, img.src),
        () => undefined,
      ),
    ),
  );
  await nextFrame();
  await nextFrame();
}

// Public API (headless capture) and postMessage bridge (editor)

const ready: Promise<void> = serial(async () => {
  await Promise.all(BASE_FACES.map((face) => document.fonts.load(face).catch(() => undefined)));
  await reloadNow(0);
  post({ source: 'cadence-frame', type: 'ready', generation: loadedGeneration });
  postSounds();
});

const api: FrameApi = {
  ready,
  render: (t) => renderAt(t),
  seek: (t) =>
    serial(async () => {
      const result = renderAt(t);
      await settle();
      return result;
    }),
  reload: (generation = 0) =>
    serial(async () => {
      await reloadNow(generation);
      postSounds();
      post({ source: 'cadence-frame', type: 'reloaded', generation: loadedGeneration });
    }),
  setScene: (id) =>
    serial(async () => {
      sceneId = id;
      if (data) scenes = await loadScenes(data.project, scenes);
      renderAt(0);
      postSounds();
    }),
  setFormat: (format) =>
    serial(async () => {
      if (!isFormatId(format)) throw new Error(`Format inconnu : ${String(format)}`);
      requestedFormat = format;
      renderAt(currentT);
      postSounds();
    }),
  duration() {
    if (!data) return 0;
    if (!sceneId) return data.project.duration;
    return data.project.scenes.find((s) => s.id === sceneId)?.duration ?? 0;
  },
  errors: () => lastErrors,
  sounds: soundCues,
  generation: () => loadedGeneration,
};
window.__cadence = api;

window.addEventListener('message', (event: MessageEvent) => {
  if (!embedded || event.source !== window.parent || !editorOrigins.includes(event.origin)) return;
  const message = event.data as EditorToFrame | null;
  if (message?.source !== 'cadence-editor') return;
  const ignore = () => undefined;
  switch (message.type) {
    case 'render':
      api.render(message.t);
      break;
    case 'seek':
      api
        .seek(message.t)
        .then((result) => post({ source: 'cadence-frame', type: 'seeked', requestId: message.requestId, result }), ignore);
      break;
    case 'reload':
      api.reload(message.generation).catch(ignore);
      break;
    case 'set-scene':
      api.setScene(message.sceneId).catch(ignore);
      break;
    case 'set-format':
      api.setFormat(message.format).catch(ignore);
      break;
  }
});

window.addEventListener('resize', () => {
  if (mode !== 'capture') renderAt(currentT);
});
