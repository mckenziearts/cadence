// Transport bar (mode, play, time, scrubber with the music grid) and the playback engine (audio clock or wall clock).
import clsx from 'clsx';
import { Keyboard, Pause, Play, Repeat, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useT } from '../i18n';
import { secs, secsLabel } from '../lib/format';
import { frameStart, playbackTime, rulerStep, timelineMarks } from '../lib/timeline';
import { duckedVolume, followVoice } from '../lib/voiceOver';
import { currentScene, get, previewDuration, set, useStore } from '../store';
import { seek, setMode, setPlaying, userSeek } from '../store/project';
import { IconButton, Kbd, Popover, Segmented, Tooltip } from './ui';

// Playback

/** Advances the playhead while playing, a frame at a time. With music, the picture keeps within a frame of the sound. */
export function PlaybackEngine() {
  const audio = useRef<HTMLAudioElement>(null);
  const voice = useRef<HTMLAudioElement>(null);
  const url = useStore((s) => s.project?.musicUrl ?? null);
  const voiceUrl = useStore((s) => s.project?.voiceOverUrl ?? null);
  const volume = useStore((s) => s.volumeDraft ?? s.project?.music?.volume ?? 1);
  const muted = useStore((s) => s.muted);
  const playing = useStore((s) => s.playing);

  useEffect(() => {
    if (audio.current) audio.current.volume = Math.min(1, Math.max(0, volume));
  }, [volume, url]);

  useEffect(() => {
    const a = audio.current;
    if (!playing) {
      a?.pause();
      voice.current?.pause();
      return;
    }
    /** Video time at playhead 0 of what the preview shows. */
    const shown = () => {
      const s = get();
      return s.mode === 'scene' ? (currentScene(s)?.start ?? 0) : 0;
    };
    /** Track time at playhead 0 of what the preview shows. */
    const offset = () => (get().project?.music?.start ?? 0) + shown();
    const withAudio = () => Boolean(a && get().project?.musicUrl);
    const syncAudio = () => {
      if (!a || !withAudio()) return;
      const target = offset() + get().time;
      if (Number.isFinite(a.duration) && target >= a.duration) return a.pause();
      if (Math.abs(a.currentTime - target) > 0.03) a.currentTime = target;
      void a.play().catch(() => undefined);
    };
    syncAudio();
    followVoice(voice.current, shown() + get().time);

    // The playhead moves by whole frames: the preview and the deck redraw once per project frame, not at every display
    // refresh. `clock` keeps the exact time in between.
    let clock = get().time;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const s = get();
      // Stopped elsewhere (a pause, a modal, the project closing) before this effect's cleanup ran.
      if (!s.playing || !s.project) return;
      const duration = previewDuration(s);
      const heard = a && withAudio() && !a.paused && !a.seeking && a.readyState >= 2 ? a.currentTime - offset() : null;
      clock = playbackTime(clock, (now - last) / 1000, heard, s.project.fps);
      last = now;
      followVoice(voice.current, shown() + clock);
      if (a && withAudio()) a.volume = duckedVolume(s.project, s.volumeDraft ?? s.project.music?.volume ?? 1, shown() + clock);
      if (clock >= duration - 1e-4) {
        if (s.loop && duration > 0) {
          clock = 0;
          seek(0);
          syncAudio();
        } else {
          seek(duration);
          set({ playing: false });
          return;
        }
      } else {
        const frame = frameStart(clock, s.project.fps);
        if (frame !== s.time) seek(frame);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // Scrubs, mode switches and scene changes move the playhead under the audio: re-sync it.
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.seekNonce !== prev.seekNonce || s.mode !== prev.mode || (s.mode === 'scene' && s.sceneId !== prev.sceneId)) {
        clock = s.time;
        last = performance.now();
        syncAudio();
        followVoice(voice.current, shown() + clock);
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      a?.pause();
      voice.current?.pause();
    };
  }, [playing]);

  return (
    <>
      {url && <audio ref={audio} src={url} preload="auto" muted={muted} />}
      {voiceUrl && <audio ref={voice} src={voiceUrl} preload="auto" muted={muted} />}
    </>
  );
}

// Transport

export function Transport() {
  const t = useT();
  const mode = useStore((s) => s.mode);
  const playing = useStore((s) => s.playing);
  const loop = useStore((s) => s.loop);
  const muted = useStore((s) => s.muted);
  const hasMusic = useStore((s) => Boolean(s.project?.musicUrl));

  return (
    <div className="flex h-16 shrink-0 items-center gap-3 border-t-2 border-ink bg-paper px-4">
      <Segmented
        label={t.timeline.transport.preview}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'scene', label: t.timeline.transport.scene },
          { value: 'whole', label: t.timeline.transport.whole },
        ]}
      />
      <Tooltip label={playing ? t.timeline.transport.pauseHint : t.timeline.transport.playHint}>
        {/* The play key stays down while the video plays, like on a tape deck. */}
        <button
          type="button"
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? t.timeline.transport.pause : t.timeline.transport.play}
          data-down={playing || undefined}
          className={clsx(
            'focus-ring press ml-1 grid size-10 shrink-0 place-items-center border-2 border-ink',
            playing ? 'bg-ink text-now' : 'bg-now text-ink hover:bg-now/85',
          )}
        >
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </button>
      </Tooltip>
      <TimeDisplay />
      <Scrubber />
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={loop ? t.timeline.transport.loop : t.timeline.transport.once}
          icon={<Repeat className="size-4" />}
          active={loop}
          side="top"
          onClick={() => set({ loop: !loop })}
        />
        {hasMusic && (
          <IconButton
            label={muted ? t.timeline.transport.unmute : t.timeline.transport.mute}
            icon={muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            side="top"
            onClick={() => set({ muted: !muted })}
          />
        )}
        <ShortcutsButton />
      </div>
    </div>
  );
}

/** The deck's counter: current time in pink while it runs. */
function TimeDisplay() {
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => previewDuration(s));
  return (
    <div className="shrink-0 bg-ink px-2.5 py-1.5 text-[15px]/5 font-semibold" aria-live="off">
      <span className={playing ? 'text-now' : 'text-white'}>{secs(time)}</span>
      <span className="text-ink-4"> / {secsLabel(duration)}</span>
    </div>
  );
}

// Scrubber

function Scrubber() {
  const playhead = useT().timeline.transport.playhead;
  const project = useStore((s) => s.project)!;
  const mode = useStore((s) => s.mode);
  const scene = useStore((s) => currentScene(s));
  const duration = useStore((s) => previewDuration(s));
  const ref = useRef<HTMLDivElement>(null);
  const showHover = useRef<(t: number | null) => void>(null);
  const [width, setWidth] = useState(600);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The value follows the playhead without redrawing the scrubber, its marks and its clips at every frame.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.time !== prev.time) ref.current?.setAttribute('aria-valuetext', secsLabel(s.time));
      }),
    [],
  );

  const marks = useMemo(() => timelineMarks(project, mode === 'scene' ? scene : null), [project, mode, scene]);
  const pct = (t: number) => `${duration > 0 ? (t / duration) * 100 : 0}%`;
  const step = rulerStep(duration, width);
  const labels: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) labels.push(Math.round(t * 1000) / 1000);
  const density = (count: number) => width / Math.max(1, count);
  const showBeats = density(marks.beats.length + marks.bars.length + marks.phrases.length) >= 5;
  const showBars = density(marks.bars.length + marks.phrases.length) >= 3;
  // One clip per scene, like the pills of the logo.
  const edges = [0, ...marks.cuts.map((cut) => cut.t), duration];

  const toTime = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return frameStart(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration, project.fps);
  };

  return (
    <div
      ref={ref}
      className="group relative h-10 min-w-0 flex-1 cursor-pointer touch-none select-none"
      role="slider"
      aria-label={playhead}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration * 100) / 100}
      aria-valuetext={secsLabel(get().time)}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        set({ scrubbing: true });
        userSeek(toTime(e.clientX));
      }}
      onPointerMove={(e) => {
        const t = toTime(e.clientX);
        showHover.current?.(t);
        if (dragging.current) userSeek(t);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        set({ scrubbing: false });
      }}
      onPointerCancel={() => {
        dragging.current = false;
        set({ scrubbing: false });
      }}
      onPointerLeave={() => showHover.current?.(null)}
    >
      {/* Grid: beats short, bars longer, phrases tallest; cuts span the whole height. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-4" aria-hidden>
        {showBeats &&
          marks.beats.map((t) => <span key={`b${t}`} className="absolute bottom-0 h-1 w-px bg-ink-4" style={{ left: pct(t) }} />)}
        {showBars &&
          marks.bars.map((t) => <span key={`m${t}`} className="absolute bottom-0 h-2 w-px bg-ink-3" style={{ left: pct(t) }} />)}
        {marks.phrases.map((t) => (
          <span key={`p${t}`} className="absolute bottom-0 h-3 w-0.5 -translate-x-1/2 bg-ink" style={{ left: pct(t) }} />
        ))}
      </div>
      {edges.slice(1).map((end, i) => (
        <Clip key={i} start={edges[i]} end={end} duration={duration} first={i === 0} last={i === edges.length - 2} />
      ))}
      <Handle duration={duration} />
      <HoverTime ref={showHover} duration={duration} />
      <div className="pointer-events-none absolute inset-x-0 top-[29px] h-3 text-[11px]/3 text-ink-3" aria-hidden>
        {labels.map((t) => (
          <span key={t} className={clsx('absolute', t === 0 ? '' : '-translate-x-1/2')} style={{ left: pct(t) }}>
            {step < 1 ? secs(t, step < 0.5 ? 2 : 1) : Math.round(t)}
            {t === 0 ? ' s' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A scene on the track: a pill outlined in ink, filled in ink up to the playhead. */
function Clip(props: { start: number; end: number; duration: number; first: boolean; last: boolean }) {
  const { start, end, duration, first, last } = props;
  const fill = useStore((s) => (end > start ? Math.min(1, Math.max(0, (s.time - start) / (end - start))) : 0));
  if (duration <= 0) return null;
  const inset = (on: boolean) => (on ? 0 : 2);
  return (
    <div
      className="pointer-events-none absolute top-[18px] h-2 overflow-hidden rounded-full bg-white ring-[1.5px] ring-ink"
      style={{
        left: `calc(${(start / duration) * 100}% + ${inset(first)}px)`,
        width: `calc(${((end - start) / duration) * 100}% - ${inset(first) + inset(last)}px)`,
      }}
    >
      <div className="h-full bg-ink" style={{ width: `${fill * 100}%` }} />
    </div>
  );
}

/** The time under the pointer. Its own state: a hover redraws this label, not the scrubber. */
function HoverTime({ ref, duration }: { ref: Ref<(t: number | null) => void>; duration: number }) {
  const [hover, setHover] = useState<number | null>(null);
  useImperativeHandle(ref, () => setHover, []);
  if (hover === null) return null;
  return (
    <span
      className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-white opacity-0 group-hover:opacity-100"
      style={{ left: `${duration > 0 ? (hover / duration) * 100 : 0}%` }}
    >
      {secs(hover)}
    </span>
  );
}

/** The logo's playhead: a pink line with its dot on top. */
function Handle({ duration }: { duration: number }) {
  const time = useStore((s) => s.time);
  return (
    <span
      className="pointer-events-none absolute top-1 h-7 w-[3px] -translate-x-1/2 rounded-full bg-now before:absolute before:-top-1 before:left-1/2 before:size-[9px] before:-translate-x-1/2 before:rounded-full before:bg-now"
      style={{ left: `${duration > 0 ? (time / duration) * 100 : 0}%` }}
    />
  );
}

// Shortcuts

export function ShortcutsButton() {
  const t = useT();
  const open = useStore((s) => s.shortcuts && s.modal === null);
  return (
    <Popover
      open={open}
      onClose={() => set({ shortcuts: false })}
      align="end"
      side="top"
      label={t.timeline.shortcuts.label}
      className="w-80 p-3"
      trigger={
        <IconButton
          label={t.timeline.shortcuts.button}
          icon={<Keyboard className="size-4" />}
          side="top"
          active={open}
          onClick={() => set({ shortcuts: !open })}
        />
      }
    >
      <p className="display-caps mb-2 px-1 text-[17px] text-ink">{t.timeline.shortcuts.title}</p>
      <ul className="space-y-1">
        {t.timeline.shortcuts.list.map(({ keys, label }) => (
          <li key={label} className="flex items-center justify-between gap-3 px-1 py-1 text-[13px] text-ink-2">
            <span>{label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Popover>
  );
}
