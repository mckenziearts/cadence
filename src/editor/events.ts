// Server-to-editor events (SSE). Reconnects with backoff; after a reconnect everything is refetched and frames are
// remounted, because a restarted server starts code generations over.
import { ignore } from './api';
import type { ServerEvent } from '../shared/types';
import { t } from './i18n';
import { get, set } from './store';
import { applyChat, applyDelta, applyMessage, loadChat } from './store/chat';
import { loadApp, loadCost, loadRenders, loadSeams, mergeSeams, refreshProject } from './store/project';
import { toast } from './store/ui';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export function connectEvents(): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let lost = false;
  let closed = false;

  const open = () => {
    source = new EventSource('/api/events');
    source.onopen = () => {
      attempts = 0;
      set({ connected: true });
      if (lost) {
        lost = false;
        void resync();
      }
    };
    source.onmessage = (event) => {
      try {
        handle(JSON.parse(event.data) as ServerEvent);
      } catch (e) {
        console.warn(t().shell.events.unreadable, e);
      }
    };
    source.onerror = () => {
      // The browser would retry at a fixed pace; we back off instead.
      source?.close();
      set({ connected: false });
      lost = true;
      if (!closed) timer = setTimeout(open, BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}

async function resync(): Promise<void> {
  set((s) => ({ frameEpoch: s.frameEpoch + 1, thumbEpoch: s.thumbEpoch + 1, versionsTick: s.versionsTick + 1 }));
  await loadApp().catch(ignore);
  if (!get().project) return;
  await refreshProject();
  for (const key of Object.keys(get().chats)) void loadChat(key as never).catch(ignore);
  void loadSeams();
  void loadRenders();
  loadCost();
}

let stateTimer: ReturnType<typeof setTimeout> | undefined;
/** Project lists change in bursts (a template instantiating many files): one refetch per burst. */
function refreshAppSoon(): void {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => void loadApp().catch(ignore), 150);
}

function handle(event: ServerEvent): void {
  const current = get().project?.id;
  switch (event.type) {
    case 'language-changed':
      // Every text of the page, the server's too, comes back in the new language.
      if (event.language !== get().language) location.reload();
      return;
    case 'projects-changed':
    case 'brands-changed':
    case 'accounts-changed':
      refreshAppSoon();
      return;
    case 'project-changed':
      if (event.projectId !== current) return refreshAppSoon();
      // Frames cache the project (durations, order, music): they re-fetch it too.
      set((s) => ({ frameReload: s.frameReload + 1, thumbEpoch: s.thumbEpoch + 1 }));
      void refreshProject();
      return;
    case 'code-changed':
      // On the home, the project covers are thumbnails too.
      if (!current) return set((s) => ({ thumbEpoch: s.thumbEpoch + 1 }));
      if (event.projectId !== current) return;
      set((s) => ({
        generation: Math.max(s.generation, event.generation),
        frameReload: s.frameReload + 1,
        thumbEpoch: s.thumbEpoch + 1,
      }));
      void refreshProject();
      return;
    case 'chat':
      if (event.projectId !== current) return;
      applyChat(event.state);
      if (!event.state.running && !event.state.queued) loadCost(300);
      return;
    case 'chat-message':
      if (event.projectId === current) applyMessage(event.key, event.message);
      return;
    case 'chat-delta':
      if (event.projectId === current) applyDelta(event.key, event.messageId, event.text);
      return;
    case 'render': {
      if (event.job.projectId !== current) return;
      const jobs = get().renders.jobs.filter((j) => j.id !== event.job.id);
      set((s) => ({
        renders: { ...s.renders, jobs: [event.job, ...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) },
      }));
      if (event.job.status === 'done') {
        void loadRenders();
        toast(t().shell.events.renderDone(event.job.format), 'success');
      } else if (event.job.status === 'error') {
        toast(t().shell.events.renderFailed(event.job.format, event.job.error), 'error');
      }
      return;
    }
    case 'publish': {
      const { job } = event;
      if (job.projectId !== current) return;
      set((s) => ({
        publishing: {
          ...s.publishing,
          jobs: [job, ...s.publishing.jobs.filter((j) => j.id !== job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        },
      }));
      const network = get().app?.networks.find((n) => n.id === job.network)?.label ?? job.network;
      if (job.status === 'done') {
        void loadRenders();
        toast(t().shell.events.published(network), 'success');
      } else if (job.status === 'error') {
        toast(t().shell.events.publishFailed(network, job.error), 'error');
      }
      return;
    }
    case 'brand-build': {
      const { build } = event;
      set((s) => {
        if (!s.app) return {};
        const known = s.app.brandBuilds.some((b) => b.id === build.id);
        const brandBuilds = known ? s.app.brandBuilds.map((b) => (b.id === build.id ? build : b)) : [build, ...s.app.brandBuilds];
        return { app: { ...s.app, brandBuilds } };
      });
      if (build.status === 'done') {
        refreshAppSoon();
        toast(t().shell.events.brandReady(build.name), 'success');
      } else if (build.status === 'error') {
        toast(t().shell.events.brandFailed(build.name), 'error');
      }
      return;
    }
    case 'seams':
      if (event.projectId === current) mergeSeams(event.results);
      return;
    case 'music':
      if (event.projectId !== current) return;
      set({ music: { status: event.status, error: event.error ?? null } });
      if (event.status === 'ready') void refreshProject();
      if (event.status === 'error') toast(event.error ?? t().shell.events.musicFailed, 'error');
      return;
    case 'voice-over':
      if (event.projectId !== current) return;
      // A new try hides the last failure until it ends, as the server does: no stale alert between 'ready' and the refetch.
      set((s) => ({
        voiceOver: { status: event.status },
        project: event.status === 'speaking' && s.project ? { ...s.project, voiceOverError: null } : s.project,
      }));
      if (event.status === 'error') {
        toast(event.error ?? t().production.voiceOver.status.failed, 'error');
        // project.voiceOverError holds it from now on, also after a reload.
        void refreshProject();
      }
      return;
    case 'versions':
      if (event.projectId === current) set((s) => ({ versionsTick: s.versionsTick + 1 }));
      return;
    case 'assets':
      if (event.projectId === current) set((s) => ({ assetsTick: s.assetsTick + 1 }));
      return;
  }
}
