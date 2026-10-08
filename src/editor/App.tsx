import clsx from 'clsx';
import { AudioLines, CircleCheck, CircleAlert, Info, WifiOff, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ignore } from './api';
import { Filmstrip } from './components/Filmstrip';
import { Home } from './components/Home';
import { Present } from './components/Present';
import { Profile } from './components/Profile';
import { RenderView } from './components/RenderView';
import { Stage } from './components/Stage';
import { Logo, TopBar } from './components/TopBar';
import { Button, Spinner } from './components/ui';
import { connectEvents } from './events';
import { t, useT } from './i18n';
import { Modals } from './modals/Modals';
import { SidePanel } from './panels/SidePanel';
import { get, set, useStore } from './store';
import { parseHash, resolvePage, type Pages } from './lib/routing';
import { restoreDrafts } from './store/chat';
import { isAudioFile, uploadMusic } from './store/music';
import {
  closeProject,
  loadApp,
  openInitialProject,
  openProject,
  PROFILE_PAGE,
  selectScene,
  setPlaying,
  stepFrame,
  stepScene,
} from './store/project';
import { dismissToast, toast } from './store/ui';

const CORE_PAGES: Pages = { [PROFILE_PAGE]: Profile };

/**
 * The editor. `pages` adds a host app's screens, opened by `#/@<id>`; a host page replaces a core one of the same id.
 * `profile={false}` takes the Profile entry off the top bar, for a host that keeps the person on one of its pages.
 */
export function App({ pages, profile = true }: { pages?: Pages; profile?: boolean }) {
  const t = useT();
  const app = useStore((s) => s.app);
  const appError = useStore((s) => s.appError);
  const project = useStore((s) => s.project);
  const projectLoading = useStore((s) => s.projectLoading);
  const view = useStore((s) => s.view);
  const presenting = useStore((s) => s.presenting);
  const page = useStore((s) => s.page);
  const Page = page ? resolvePage(page, pages, CORE_PAGES) : null;
  const [booted, setBooted] = useState(false);
  // Pages and the home frame the top bar to their content's width; a project, even loading, keeps the editor's.
  const framed = !project && (Page !== null || (booted && !projectLoading));

  useEffect(() => {
    restoreDrafts();
    const disconnect = connectEvents();
    loadApp()
      .then(openInitialProject)
      .catch(ignore)
      .finally(() => setBooted(true));
    return disconnect;
  }, []);

  // A page nobody provides: the home, and a hash that no longer names it.
  useEffect(() => {
    if (!page || Page) return;
    set({ page: null });
    history.replaceState(null, '', '#/');
  }, [page, Page]);

  useShortcuts();
  const drop = useAudioDrop();

  if (!app) {
    return (
      <div className="bg-grid grid h-full place-items-center bg-paper">
        {appError && booted ? (
          <div className="max-w-sm text-center">
            <CircleAlert className="mx-auto mb-3 size-6 text-alert" />
            <p className="display-caps text-[22px]/7 text-ink">{t.shell.app.down}</p>
            <p className="mt-1 text-[13px] text-ink-3">{appError}</p>
            <Button className="mt-4" onClick={() => void loadApp().then(openInitialProject).catch(ignore)}>
              {t.shell.app.retry}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-[13px] text-ink-3">
            <Logo className="size-9" />
            <Spinner />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-[1180px] flex-col overflow-hidden bg-white" {...drop.handlers}>
      {framed ? (
        // The strip around the box still drags a host's window. 16 px over the 56 px bar is three squares of the grid,
        // so its lines run on into the page's. A host's window may keep the box its full width (--titlebar-max-width).
        <div className="shrink-0 bg-grid bg-stage [-webkit-app-region:drag] [app-region:drag]">
          <div className="mx-auto max-w-[var(--titlebar-max-width,92rem)] px-6 pt-4">
            <TopBar framed profile={profile} />
          </div>
        </div>
      ) : (
        <TopBar profile={profile} />
      )}
      <StaleBanner />
      {project ? (
        view === 'scenes' ? (
          <>
            <main className="flex min-h-0 flex-1">
              <Stage />
              <SidePanel />
            </main>
            <Filmstrip />
          </>
        ) : (
          <RenderView />
        )
      ) : Page ? (
        <Page />
      ) : booted && !projectLoading ? (
        <Home />
      ) : (
        <ProjectSkeleton />
      )}
      <Modals />
      {presenting && project && <Present />}
      {drop.active && (
        <div className="pointer-events-none fixed inset-3 z-[90] grid animate-fade-in place-items-center border-4 border-dashed border-ink bg-paper/90">
          <div className="flex flex-col items-center gap-2 text-ink">
            <AudioLines className="size-8" />
            <p className="display-caps text-[28px]/8">{t.shell.app.dropMusic}</p>
            <p className="text-[13px] text-ink-3">{t.shell.app.dropMusicHint}</p>
          </div>
        </div>
      )}
      <ConnectionBadge />
      <Toasts />
    </div>
  );
}

/** The editor's layout while a project loads, so nothing jumps when it arrives. */
function ProjectSkeleton() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" aria-label={t.shell.app.loadingProject}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 items-center border-b-2 border-ink px-4">
            <div className="skeleton h-4 w-56" />
          </div>
          <div className="bg-grid grid min-h-0 flex-1 place-items-center bg-stage p-8">
            <div className="skeleton aspect-video w-full max-w-4xl" />
          </div>
          <div className="flex h-16 items-center gap-3 border-t-2 border-ink px-4">
            <div className="skeleton h-7 w-52" />
            <div className="skeleton size-10" />
            <div className="skeleton h-2 flex-1 rounded-full" />
          </div>
        </div>
        <div className="w-[348px] shrink-0 space-y-3 border-l-2 border-ink p-3 xl:w-[400px]">
          <div className="skeleton h-8" />
          <div className="skeleton h-12" />
          <div className="skeleton ml-auto h-10 w-2/3" />
          <div className="skeleton h-28" />
        </div>
      </div>
      <div className="flex gap-10 border-t-2 border-ink px-4 pt-4 pb-10">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton h-[99px] w-[176px] shrink-0" />
        ))}
      </div>
    </div>
  );
}

// Toasts & status

function Toasts() {
  const t = useT();
  const toasts = useStore((s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed bottom-5 left-1/2 z-[95] flex w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
      role="status"
    >
      {toasts.map((notification) => (
        <div
          key={notification.id}
          className={clsx(
            'pointer-events-auto flex max-w-full animate-pop-in items-start gap-2.5 border-2 border-ink px-3.5 py-2.5 text-[13px] shadow-float',
            notification.tone === 'error' ? 'bg-alert text-white' : 'bg-ink text-white',
          )}
        >
          {notification.tone === 'error' ? (
            <CircleAlert className="mt-px size-4 shrink-0" />
          ) : notification.tone === 'success' ? (
            <CircleCheck className="mt-px size-4 shrink-0 text-now" />
          ) : (
            <Info className="mt-px size-4 shrink-0 text-ink-4" />
          )}
          <p className="min-w-0 [overflow-wrap:anywhere]">{notification.text}</p>
          <button
            type="button"
            onClick={() => dismissToast(notification.id)}
            aria-label={t.shell.app.closeToast}
            className="-mr-1 shrink-0 p-0.5 opacity-60 hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function StaleBanner() {
  const t = useT();
  const stale = useStore((s) => s.stale);
  if (!stale) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b-2 border-ink bg-warn/20 px-4 py-2 text-[13px] font-medium text-ink"
    >
      <CircleAlert className="size-4 shrink-0 text-warn" aria-hidden />
      <p className="flex-1">{t.shell.app.stale}</p>
      <Button size="sm" variant="primary" onClick={() => location.reload()}>
        {t.shell.app.reload}
      </Button>
    </div>
  );
}

/** Shown only after the stream has been down for a moment (restarts are quick). */
function ConnectionBadge() {
  const t = useT();
  const connected = useStore((s) => s.connected);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (connected) return setLate(false);
    const timer = setTimeout(() => setLate(true), 2500);
    return () => clearTimeout(timer);
  }, [connected]);
  if (connected || !late) return null;
  return (
    <div
      className="fixed right-4 bottom-4 z-[95] flex items-center gap-2 border-2 border-ink bg-warn px-3 py-1.5 text-xs font-semibold text-ink shadow-hard-sm"
      role="status"
    >
      <WifiOff className="size-3.5" /> {t.shell.app.offline}
    </div>
  );
}

// Keyboard

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(type);
}

function useShortcuts() {
  useEffect(() => {
    // Whether focus last moved with Tab (then Space activates the focused control) or with the pointer.
    let tabbed = false;
    const onPointer = () => {
      tabbed = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tabbed = true;
      const s = get();
      if (e.defaultPrevented || s.presenting || s.modal || !s.project || s.view !== 'scenes') return;
      if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      const focused =
        e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('button, a, summary, [role="slider"]') : null;
      switch (e.key) {
        case ' ':
          if (focused && tabbed) return;
          e.preventDefault();
          // A button still focused from a click would also be "clicked" by this Space on keyup.
          focused?.blur();
          setPlaying(!s.playing);
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (e.altKey || focused?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          stepFrame(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          if (focused?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          stepScene(e.key === 'ArrowDown' ? 1 : -1);
          break;
        case 'l':
        case 'L':
          set({ loop: !s.loop });
          toast(!s.loop ? t().shell.app.loop : t().shell.app.playOnce, 'info', 1400);
          break;
        case '?':
          set({ shortcuts: !s.shortcuts });
          break;
        case 'Home':
          e.preventDefault();
          set({ time: 0, seekNonce: s.seekNonce + 1 });
          break;
      }
    };
    // The URL names the project and scene (#/<projet>/<scène>), a page (#/@profil), or the home without one: follow it
    // (links, Back).
    const onHash = () => {
      const { page, projectId, sceneId } = parseHash(location.hash);
      const s = get();
      if (page) {
        if (s.project) closeProject(true);
        set({ page });
        return;
      }
      if (s.page) set({ page: null });
      if (!projectId) {
        if (s.project) closeProject();
        return;
      }
      if (projectId !== s.project?.id) void openProject(projectId, sceneId).catch(ignore);
      else if (sceneId && sceneId !== s.sceneId) selectScene(sceneId);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
}

// Audio drop anywhere

function useAudioDrop() {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const hasProject = useStore((s) => Boolean(s.project));
  // Drop zones inside the app stop the event: reset from the capture phase, which always runs.
  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setActive(false);
    };
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset, true);
    };
  }, []);
  const accepts = (e: DragEvent) => hasProject && e.dataTransfer.types.includes('Files');
  // Images and fonts go to the Médias drop zone: only audio (or an unknown type) lights up the whole window.
  const looksAudio = (e: DragEvent) => {
    const type = e.dataTransfer.items?.[0]?.type ?? '';
    return type === '' || type.startsWith('audio/');
  };
  return {
    active,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!accepts(e)) return;
        depth.current++;
        if (looksAudio(e)) setActive(true);
      },
      onDragOver: (e: DragEvent) => {
        if (accepts(e)) e.preventDefault();
      },
      onDragLeave: (e: DragEvent) => {
        if (!accepts(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDrop: (e: DragEvent) => {
        depth.current = 0;
        setActive(false);
        if (!accepts(e)) return;
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        if (isAudioFile(file)) void uploadMusic(file);
        else toast(t().shell.app.dropNotAudio, 'info');
      },
    },
  };
}
