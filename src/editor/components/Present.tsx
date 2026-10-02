// Présenter: the whole video fullscreen with its soundtrack. Space, Esc, and the left and right arrow keys between scenes.
import clsx from 'clsx';
import { Pause, Play, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { secs } from '../lib/format';
import { frameStart, playbackTime } from '../lib/timeline';
import { duckedVolume, followVoice } from '../lib/voiceOver';
import { get, set, useStore } from '../store';
import { FrameView, type FrameHandle } from './FrameView';

export function Present() {
  const t = useT();
  const app = useStore((s) => s.app)!;
  const project = useStore((s) => s.project)!;
  const format = useStore((s) => s.format);
  const reload = useStore((s) => s.frameReload);
  const generation = useStore((s) => s.generation);
  const frame = useRef<FrameHandle>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const voice = useRef<HTMLAudioElement>(null);
  const timeRef = useRef(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const total = project.duration;
  const offset = project.music?.start ?? 0;

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    set({ presenting: false });
  }, []);

  const jump = useCallback(
    (t: number) => {
      timeRef.current = Math.min(total, Math.max(0, t));
      setTime(timeRef.current);
      frame.current?.seek(timeRef.current);
      if (audio.current && project.musicUrl) audio.current.currentTime = offset + timeRef.current;
      if (voice.current) voice.current.currentTime = timeRef.current;
    },
    [total, offset, project.musicUrl],
  );

  // Fullscreen is requested by the button that opened this (it needs the click's user activation).
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) set({ presenting: false });
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Start shortly after the first frame is up, like a projector.
  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => setPlaying(true), 450);
    return () => clearTimeout(id);
  }, [ready]);

  useEffect(() => {
    const a = audio.current;
    if (!playing) {
      a?.pause();
      voice.current?.pause();
      frame.current?.seek(timeRef.current);
      return;
    }
    if (timeRef.current >= total - 1e-3) jump(0);
    if (a && project.musicUrl) {
      a.volume = project.music?.volume ?? 1;
      a.currentTime = offset + timeRef.current;
      void a.play().catch(() => undefined);
    }
    let last = performance.now();
    let raf = 0;
    let drawn = -1;
    const tick = (now: number) => {
      const heard = a && project.musicUrl && !a.paused && a.readyState >= 2 ? a.currentTime - offset : null;
      let t = playbackTime(timeRef.current, (now - last) / 1000, heard, project.fps);
      last = now;
      if (t >= total) {
        t = total;
        setPlaying(false);
      }
      timeRef.current = t;
      followVoice(voice.current, t);
      const current = get().project ?? project;
      if (a && current.musicUrl) a.volume = duckedVolume(current, current.music?.volume ?? 1, t);
      // Whole frames, like the editor's deck: one render per project frame, not per display refresh.
      const shown = t < total ? frameStart(t, project.fps) : total;
      if (shown !== drawn) {
        drawn = shown;
        frame.current?.render(shown);
        setTime(shown);
      }
      if (t < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      a?.pause();
      voice.current?.pause();
    };
  }, [playing, total, offset, project.musicUrl, project.music?.volume, project.voiceOverUrl, project.fps, jump]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const starts = project.scenes.map((s) => s.start);
        const now = timeRef.current;
        jump(
          e.key === 'ArrowRight'
            ? (starts.find((s) => s > now + 0.05) ?? total)
            : ([...starts].reverse().find((s) => s < now - 0.4) ?? 0),
        );
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, jump, project.scenes, total]);

  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 2000);
  };
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const scene = [...project.scenes].reverse().find((s) => s.start <= time + 1e-6) ?? project.scenes[0];
  const ended = !playing && time >= total - 1e-3;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.shell.present.label}
      className={clsx('fixed inset-0 z-[80] bg-black', idle && playing && 'cursor-none')}
      onPointerMove={poke}
    >
      <FrameView
        ref={frame}
        frameOrigin={app.frameOrigin}
        projectId={project.id}
        mode="present"
        sceneId={null}
        format={format}
        initialTime={0}
        reload={reload}
        generation={generation}
        title={t.shell.present.frame}
        className="pointer-events-none absolute inset-0 size-full border-0"
        onReady={() => setReady(true)}
      />
      {project.musicUrl && <audio ref={audio} src={project.musicUrl} preload="auto" />}
      {project.voiceOverUrl && <audio ref={voice} src={project.voiceOverUrl} preload="auto" />}
      <div
        className={clsx(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-8 pt-16 pb-6 transition-opacity duration-300',
          idle && playing ? 'opacity-0' : 'opacity-100',
        )}
      >
        <div className="mx-auto flex max-w-5xl items-center gap-4 text-white">
          <button
            type="button"
            onClick={() => setPlaying(!playing)}
            aria-label={playing ? t.shell.present.pause : ended ? t.shell.present.replay : t.shell.present.play}
            className="focus-ring grid size-11 shrink-0 place-items-center rounded-full bg-white text-ink hover:bg-rule"
          >
            {ended ? (
              <RotateCcw className="size-4" />
            ) : playing ? (
              <Pause className="size-4 fill-current" />
            ) : (
              <Play className="ml-0.5 size-4 fill-current" />
            )}
          </button>
          <div
            className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/25"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              jump(((e.clientX - rect.left) / rect.width) * total);
            }}
          >
            <div className="h-full rounded-full bg-white" style={{ width: `${(time / Math.max(total, 0.001)) * 100}%` }} />
            {project.scenes.slice(1).map((s) => (
              <span
                key={s.id}
                className="absolute top-0 h-full w-0.5 bg-black/50"
                style={{ left: `${(s.start / total) * 100}%` }}
              />
            ))}
          </div>
          <span className="shrink-0 font-mono text-[13px] text-white/80 tabular-nums">
            {secs(time)} / {secs(total)}&nbsp;s
          </span>
          <span className="hidden max-w-48 truncate text-[13px] text-white/70 lg:inline">{scene?.name}</span>
          <button
            type="button"
            onClick={close}
            aria-label={t.shell.present.exit}
            className="focus-ring grid size-9 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
