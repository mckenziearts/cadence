// Music slice actions: upload, settings (start and volume apply at once, the request follows), snapping cuts.
import { api } from '../api';
import type { MusicSettingsPatch, SnapGrid } from '../../shared/types';
import { t } from '../i18n';
import { get, set } from '.';
import { applyProject, refreshProject } from './project';
import { toast } from './ui';

export const AUDIO_ACCEPT = '.mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*';
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.includes(file.name.split('.').pop()?.toLowerCase() ?? '');
}

export async function uploadMusic(file: File): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  if (!isAudioFile(file)) return toast(t().production.music.upload.notAudio(file.name), 'error');
  set({ music: { status: 'analyzing', error: null } });
  toast(t().production.music.upload.sending(file.name), 'info', 2500);
  try {
    applyProject(await api.uploadMusic(id, file));
    set({ panel: 'music' });
  } catch {
    set({ music: { status: get().project?.music ? 'ready' : 'idle', error: null } });
  }
}

let pending: MusicSettingsPatch = {};
let pendingProject = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();

/** Start and volume show immediately; the PATCH goes out after `delay` ms of calm (sliders, drags). */
export function patchMusic(patch: MusicSettingsPatch, delay = 0): void {
  const project = get().project;
  if (!project?.music) return;
  const music = { ...project.music };
  if (patch.start !== undefined) music.start = patch.start;
  if (patch.volume !== undefined) music.volume = patch.volume;
  set({ project: { ...project, music } });
  pending = { ...pending, ...patch };
  pendingProject = project.id;
  clearTimeout(timer);
  timer = setTimeout(() => void flushMusic(), delay);
}

/**
 * Sends a change still waiting for calm at once, and resolves once every change sent is answered: an undo pressed meanwhile
 * must revert that change, not the step before it.
 */
export function flushMusic(): Promise<void> {
  clearTimeout(timer);
  if (Object.keys(pending).length) {
    const [id, body] = [pendingProject, pending];
    pending = {};
    saving = saving.then(async () => {
      try {
        applyProject(await api.updateMusic(id, body));
      } catch {
        await refreshProject();
      }
    });
  }
  return saving;
}

/**
 * The volume slider is released: the project saves the volume it moved to. While it moves, only `volumeDraft` changes
 * and the playing track follows it: writing the project at every step would redraw everything that reads it.
 */
export function saveVolume(): void {
  const volume = get().volumeDraft;
  if (volume === null) return;
  if (volume !== get().project?.music?.volume) patchMusic({ volume });
  set({ volumeDraft: null });
}

/** keepBars: each scene keeps its number of bars, laid on the track's bar lines (campaigns, beat-timed payoffs). */
export async function snapCuts(grid: SnapGrid, opts: { keepBars?: boolean } = {}): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  applyProject(await api.snap(id, grid, opts));
  const texts = t().production.music.snap;
  toast(opts.keepBars ? texts.doneKeepingBars : texts.done[grid], 'success');
}
