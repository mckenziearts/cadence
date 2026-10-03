// Project slice: loading, selection, playhead, scenes and the per-project data around them (seams, renders and their
// publications, cost).
import { ApiError, api, ignore } from '../api';
import { browserLanguage, t } from '../i18n';
import type { AgentId, CreateSceneInput, FormatId, ProjectState, SeamResult } from '../../shared/types';
import { seamTone } from '../lib/format';
import { clamp, currentScene, get, previewDuration, sceneAt, set, useStore, type PreviewMode } from '.';
import { toast } from './ui';

// App

export async function loadApp(): Promise<void> {
  try {
    let app = await api.state({ quiet: true });
    if (!app.settings.language) {
      // First visit: the browser's language becomes the setting, so the server speaks it too.
      const settings = await api.saveSettings({ language: browserLanguage() });
      // The page came in the server's language: start over in the chosen one.
      if (settings.language !== get().language) return location.reload();
      app = { ...app, settings };
    }
    set({ app, appError: null, language: app.settings.language ?? get().language });
  } catch (e) {
    set({ appError: (e as Error).message });
    throw e;
  }
}

/** Switch the assistant that drives chats and brand builds. A new agent has its own catalogue, so the session picks drop. */
export async function setAgent(id: AgentId): Promise<void> {
  const settings = await api.saveSettings({ agent: id });
  const models = await api.agentModels(id).catch(() => undefined);
  set((s) => ({ app: s.app && { ...s.app, settings, ...(models ? { models } : {}) }, picks: {} }));
}

/** Hash of the Profile page: a project id never starts with @. */
export const PROFILE_PAGE = '@profil';

/** The project or page named by the URL hash; without one, the app opens on the projects home. */
export async function openInitialProject(): Promise<void> {
  const projects = get().app?.projects ?? [];
  const [hashProject, hashScene] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  if (hashProject === PROFILE_PAGE) set({ profile: true });
  else if (hashProject !== get().project?.id && projects.some((p) => p.id === hashProject)) {
    await openProject(hashProject, hashScene || null);
  }
}

// Project

/** The project being opened: a second call for it (the editor booted twice, a double click) waits for that one. */
let opening: { id: string; done: Promise<void> } | null = null;

export function openProject(id: string, sceneId?: string | null): Promise<void> {
  // A second load would empty the chats the first one already filled, and the open chat would never reload.
  if (opening?.id === id) return opening.done;
  const done = loadProject(id, sceneId).finally(() => {
    if (opening?.done === done) opening = null;
  });
  opening = { id, done };
  return done;
}

async function loadProject(id: string, sceneId?: string | null): Promise<void> {
  set({ projectLoading: true, playing: false });
  try {
    const project = await api.project(id);
    const scene = project.scenes.find((x) => x.id === sceneId) ?? project.scenes[0] ?? null;
    const format = project.formats.includes(get().format) ? get().format : project.formats[0];
    set({
      project,
      sceneId: scene?.id ?? null,
      format,
      generation: project.codeGeneration,
      mode: 'scene',
      time: 0,
      playing: false,
      frameErrors: [],
      chats: {},
      seams: [],
      renders: { jobs: [], files: [] },
      publishing: { jobs: [], publications: [] },
      profile: false,
      music: { status: project.music ? (project.musicGrid ? 'ready' : 'analyzing') : 'idle', error: null },
      voiceOver: { status: 'idle' },
      cost: null,
      focusVersion: null,
      renaming: null,
    });
    writeHash();
    void loadSeams();
    void loadRenders();
    void loadCost();
  } finally {
    set({ projectLoading: false });
  }
}

/** Back to the home, or to the page the URL now names (`keepUrl`). */
export function closeProject(keepUrl = false): void {
  set({ project: null, sceneId: null, playing: false, chats: {}, seams: [], cost: null });
  if (!keepUrl) history.replaceState(null, '', location.pathname);
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/** Refetch the open project; calls made while one is in flight coalesce into one more fetch. */
export function refreshProject(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      const id = get().project?.id;
      if (!id) return;
      try {
        applyProject(await api.project(id, { quiet: true }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && get().project?.id === id) {
          toast(t().shell.project.gone, 'error');
          closeProject();
          await loadApp().catch(ignore);
          await openInitialProject().catch(ignore);
        }
        return;
      }
    } while (refreshAgain);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Take a fresh ProjectState (from a refetch or a mutation response) and keep the selection valid. */
export function applyProject(project: ProjectState): void {
  const s = get();
  if (s.project && s.project.id !== project.id) return;
  const sceneId = project.scenes.some((x) => x.id === s.sceneId) ? s.sceneId : (project.scenes[0]?.id ?? null);
  const format = project.formats.includes(s.format) ? s.format : project.formats[0];
  const app = s.app && {
    ...s.app,
    projects: s.app.projects.map((x) =>
      x.id === project.id
        ? {
            ...x,
            name: project.name,
            brand: project.brand,
            formats: project.formats,
            sceneCount: project.scenes.length,
            duration: project.duration,
            updatedAt: project.updatedAt,
            cover: project.scenes[0]?.id ?? null,
          }
        : x,
    ),
  };
  const musicStatus = !project.music ? 'idle' : project.musicGrid ? 'ready' : s.music.status === 'error' ? 'error' : 'analyzing';
  set({
    project,
    sceneId,
    format,
    app,
    generation: Math.max(s.generation, project.codeGeneration),
    music: { status: musicStatus, error: musicStatus === 'error' ? s.music.error : null },
  });
  const max = previewDuration();
  if (get().time > max) set({ time: max });
  writeHash();
}

export async function updateProject(patch: Parameters<typeof api.updateProject>[1]): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  applyProject(await api.updateProject(id, patch));
}

// Selection & playhead

export function writeHash(): void {
  const s = get();
  if (!s.project) return;
  const next = `#/${[s.project.id, s.sceneId].filter(Boolean).join('/')}`;
  if (location.hash === next) return;
  // Opening a project from the home or another project gets its own history entry (Back returns there); scenes replace it.
  const [shown] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  if (shown === s.project.id) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
}

export function selectScene(sceneId: string): void {
  const s = get();
  const scene = s.project?.scenes.find((x) => x.id === sceneId);
  if (!scene) return;
  set({ sceneId, time: s.mode === 'whole' ? scene.start : 0, seekNonce: s.seekNonce + 1 });
  writeHash();
}

export function setMode(mode: PreviewMode): void {
  const s = get();
  if (s.mode === mode || !s.project) return;
  const scene = currentScene(s);
  if (mode === 'whole') {
    set({ mode, time: (scene?.start ?? 0) + s.time, seekNonce: s.seekNonce + 1 });
  } else {
    const at = sceneAt(s.project, s.time);
    set({
      mode,
      sceneId: at?.id ?? s.sceneId,
      time: at ? clamp(s.time - at.start, 0, at.duration) : 0,
      seekNonce: s.seekNonce + 1,
    });
  }
  writeHash();
}

/** Move the playhead. In whole-video mode the selected scene follows it once it rests (followPlayhead). */
export function seek(t: number): void {
  set({ time: clamp(t, 0, previewDuration()) });
  followPlayhead();
}

/**
 * Whole-video mode: select the scene under the playhead, once it rests. While it plays or scrubs, each cut would swap
 * the scene chat and redraw the filmstrip; the stage header and the track show where it is meanwhile.
 */
function followPlayhead(): void {
  const s = get();
  if (s.mode !== 'whole' || !s.project || s.playing || s.scrubbing) return;
  const at = sceneAt(s.project, s.time);
  if (!at || at.id === s.sceneId) return;
  set({ sceneId: at.id });
  writeHash();
}

// Playback pauses or ends, a scrub ends: the selection catches up with the playhead.
useStore.subscribe((s, prev) => {
  if ((prev.playing && !s.playing) || (prev.scrubbing && !s.scrubbing)) followPlayhead();
});

/** A seek the user asked for (scrub, step): also re-syncs the audio while playing. */
export function userSeek(t: number): void {
  seek(t);
  set((s) => ({ seekNonce: s.seekNonce + 1 }));
}

/** Play the preview from where a scene's voice-over starts, sound on: the button exists to hear it. */
export function playVoiceOver(sceneId: string): void {
  const s = get();
  const scene = s.project?.scenes.find((x) => x.id === sceneId);
  if (!scene) return;
  const at = scene.voiceOver?.at ?? 0;
  // A voice that starts past its scene's end is only heard in the whole video.
  if (s.mode === 'scene' && at < scene.duration) {
    selectScene(sceneId);
    userSeek(at);
  } else {
    setMode('whole');
    userSeek(scene.start + at);
  }
  set({ muted: false });
  setPlaying(true);
}

export function setPlaying(playing: boolean): void {
  const s = get();
  if (playing && s.time >= previewDuration(s) - 1e-3) set({ time: 0, seekNonce: s.seekNonce + 1 });
  set({ playing });
}

export function stepFrame(direction: 1 | -1, bigStep = false): void {
  const s = get();
  if (!s.project) return;
  const frame = 1 / s.project.fps;
  // Land on exact frame boundaries so repeated steps never drift.
  const index = Math.round(s.time / frame);
  const next = bigStep ? s.time + direction : (index + direction) * frame;
  set({ playing: false });
  userSeek(Math.round(next * 1e6) / 1e6);
}

export function stepScene(direction: 1 | -1): void {
  const s = get();
  const scene = currentScene(s);
  const next = s.project?.scenes[(scene?.index ?? 0) + direction];
  if (next) selectScene(next.id);
}

export function setFormat(format: FormatId): void {
  if (get().project?.formats.includes(format)) set({ format });
}

// Scenes

export async function addScene(input: CreateSceneInput): Promise<void> {
  const project = get().project;
  if (!project) return;
  const scene = await api.createScene(project.id, input);
  await refreshProject();
  set({ mode: 'scene', panel: 'scene' });
  selectScene(scene.id);
  toast(t().shell.project.sceneAdded(scene.name), 'success');
}

export async function renameScene(sceneId: string, name: string): Promise<void> {
  const project = get().project;
  const trimmed = name.trim();
  if (!project || !trimmed || project.scenes.find((s) => s.id === sceneId)?.name === trimmed) return;
  applyProject(await api.updateScene(project.id, sceneId, { name: trimmed }));
}

export async function setSceneDuration(sceneId: string, duration: number): Promise<void> {
  const project = get().project;
  if (!project) return;
  if (!Number.isFinite(duration) || duration <= 0) return toast(t().shell.project.badDuration, 'error');
  applyProject(await api.updateScene(project.id, sceneId, { duration: Math.round(duration * 1000) / 1000 }));
}

export async function duplicateScene(sceneId: string): Promise<void> {
  const project = get().project;
  if (!project) return;
  const copy = await api.duplicateScene(project.id, sceneId);
  await refreshProject();
  selectScene(copy.id);
}

export async function deleteScene(sceneId: string): Promise<void> {
  const project = get().project;
  if (!project) return;
  const index = project.scenes.findIndex((s) => s.id === sceneId);
  const name = project.scenes[index]?.name ?? sceneId;
  // The selection moves to a neighbour, not back to the first scene.
  const neighbour = project.scenes[index + 1] ?? project.scenes[index - 1];
  const wasSelected = currentScene()?.id === sceneId;
  applyProject(await api.deleteScene(project.id, sceneId));
  if (wasSelected && neighbour) selectScene(neighbour.id);
  toast(t().shell.project.sceneDeleted(name), 'info');
}

export async function reorderScenes(ids: string[]): Promise<void> {
  const project = get().project;
  if (!project || ids.join() === project.scenes.map((s) => s.id).join()) return;
  // Optimistic: the strip moves at once, the server's answer (or a refetch on failure) settles it.
  const byId = new Map(project.scenes.map((s) => [s.id, s]));
  let start = 0;
  const scenes = ids.map((id, index) => {
    const scene = { ...byId.get(id)!, index, start: Math.round(start * 1000) / 1000 };
    start += scene.duration;
    return scene;
  });
  set({ project: { ...project, scenes } });
  try {
    applyProject(await api.reorder(project.id, ids));
  } catch {
    await refreshProject();
  }
}

// Seams, renders, cost

export async function loadSeams(): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  const seams = await api.seams(id).catch(() => null);
  if (seams && get().project?.id === id) set({ seams });
}

export async function checkSeams(input: { sceneId?: string; format?: FormatId } = {}): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  set({ seamsChecking: true });
  try {
    // Without a format the server checks every format of the project, not just the one previewed.
    const results = await api.checkSeams(id, input);
    if (get().project?.id === id) mergeSeams(results);
    const jumps = [...new Set(results.filter((r) => ['jump', 'cut'].includes(seamTone(r))).map((r) => r.format))];
    if (!input.sceneId) {
      toast(
        results.length === 0
          ? t().shell.project.seams.none
          : jumps.length === 0
            ? t().shell.project.seams.clean
            : t().shell.project.seams.jumps(jumps.join(', ')),
        jumps.length === 0 ? 'success' : 'info',
      );
    }
  } finally {
    set({ seamsChecking: false });
  }
}

/** Newer results replace the ones for the same cut and format. */
export function mergeSeams(results: SeamResult[]): void {
  const key = (r: { from: string; to: string; format: string }) => `${r.from}>${r.to}@${r.format}`;
  const next = new Map(get().seams.map((r) => [key(r), r]));
  for (const r of results) next.set(key(r), r);
  set({ seams: [...next.values()] });
}

/** The exported videos and what the networks received of them. */
export async function loadRenders(): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  const [renders, publishing] = await Promise.all([api.renders(id).catch(() => null), api.publications(id).catch(() => null)]);
  if (get().project?.id !== id) return;
  if (renders) set({ renders });
  if (publishing) set({ publishing });
}

let costTimer: ReturnType<typeof setTimeout> | undefined;

export function loadCost(delay = 0): void {
  clearTimeout(costTimer);
  costTimer = setTimeout(async () => {
    const id = get().project?.id;
    if (!id) return;
    const cost = await api.cost(id).catch(() => null);
    if (cost && get().project?.id === id) set({ cost: cost.totalUsd });
  }, delay);
}
