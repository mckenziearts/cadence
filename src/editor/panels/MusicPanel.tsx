// Music: upload or a preset soundtrack, waveform with the beat grid and the video window, start offset, volume, grid
// overrides, cut snapping.
import clsx from 'clsx';
import { AlertTriangle, Check, Minus, Music, Pause, Play, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { MusicAnalysis, MusicGridData, SnapGrid } from '../../shared/types';
import { api, ignore } from '../api';
import { BeatPills, Button, ConfirmButton, Segmented, SectionTitle, Tooltip, fieldBase } from '../components/ui';
import { useT } from '../i18n';
import { NBSP, bytes, parseDecimal, percentShort, secs, secsLabel } from '../lib/format';
import soundtracks from '../soundtracks/presets.json';
import { currentScene, set, useStore } from '../store';
import { AUDIO_ACCEPT, patchMusic, saveVolume, snapCuts, uploadMusic } from '../store/music';
import { applyProject } from '../store/project';
import { toast } from '../store/ui';

type Track = { file: string; size: number; analysed: boolean };

export function MusicPanel() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const status = useStore((s) => s.music);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [analysis, setAnalysis] = useState<MusicAnalysis | null>(null);
  const music = project.music;

  useEffect(() => {
    let live = true;
    api
      .tracks(project.id)
      .then((list) => live && setTracks(list))
      .catch(ignore);
    return () => {
      live = false;
    };
  }, [project.id, music?.file, status.status]);

  const hasGrid = Boolean(project.musicGrid);
  useEffect(() => {
    let live = true;
    if (!music?.file || !hasGrid) return setAnalysis(null);
    api
      .analysis(project.id)
      .then((a) => live && setAnalysis(a))
      .catch(() => live && setAnalysis(null));
    return () => {
      live = false;
    };
  }, [project.id, music?.file, hasGrid]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {music ? (
        <div className="space-y-6 px-4 py-4">
          <TrackHeader file={music.file} analysis={analysis} />
          <WaveformSection />
          <Settings analysis={analysis} />
          <Snap />
          <Tracks tracks={tracks} current={music.file} />
          <Soundtracks title={t.production.music.soundtracks.title} current={music.file} />
          <div className="border-t border-rule pt-4">
            <ConfirmButton
              label={t.production.music.remove}
              confirmLabel={t.production.music.removeConfirm}
              icon={<Trash2 className="size-3.5" />}
              onConfirm={async () => applyProject(await api.removeMusic(project.id))}
            />
            <p className="mt-1.5 text-xs text-ink-3">{t.production.music.removeHint}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-6 px-4 py-4">
          <DropZone />
          <Soundtracks title={t.production.music.soundtracks.pick} current={null} />
          <Tracks tracks={tracks} current={null} />
        </div>
      )}
    </div>
  );
}

function DropZone() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const file = e.dataTransfer.files[0];
        if (!file) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void uploadMusic(file);
      }}
      className={clsx(
        'flex flex-col items-center border-2 border-dashed px-5 py-7 text-center',
        over ? 'border-now bg-now/10' : 'border-ink-4 bg-white',
      )}
    >
      <Music className="mb-2.5 size-6 text-ink" aria-hidden />
      <p className="display-caps text-[22px]/7 text-ink">{t.production.music.dropZone.title}</p>
      <p className="mt-1 max-w-64 text-[13px]/5 text-ink-3">{t.production.music.dropZone.hint}</p>
      <Button variant="primary" className="mt-4" icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>
        {t.production.music.dropZone.choose}
      </Button>
      <p className="mt-2.5 text-xs/[18px] text-ink-4">{t.production.music.dropZone.drop}</p>
      <input
        ref={input}
        type="file"
        accept={AUDIO_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadMusic(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// Preset soundtracks

type Soundtrack = (typeof soundtracks)[number];
type SoundtrackVersion = Soundtrack['versions'][number];

/** The audio of the presets (npm run cadence -- soundtracks), served by Vite. */
const SOUNDTRACK_URLS = import.meta.glob<string>('../soundtracks/*.m4a', { query: '?url', import: 'default', eager: true });
const soundtrackUrl = (file: string) => SOUNDTRACK_URLS[`../soundtracks/${file}`];

/** The version that covers the video: the shortest one at least as long, else the longest. */
const versionFor = (track: Soundtrack, duration: number): SoundtrackVersion =>
  track.versions.find((v) => v.duration >= duration - 0.05) ?? track.versions[track.versions.length - 1];

const presetOf = (file: string) => soundtracks.find((track) => track.versions.some((v) => `music/${v.file}` === file));

/** One preview at a time, whichever list started it. */
let preview: HTMLAudioElement | null = null;

function Soundtracks({ title, current }: { title: string; current: string | null }) {
  const t = useT();
  const texts = t.production.music.soundtracks;
  const duration = useStore((s) => s.project?.duration ?? 0);
  const editorPlaying = useStore((s) => s.playing);
  const [playing, setPlaying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const stop = () => {
    preview?.pause();
    preview = null;
    setPlaying(null);
  };
  useEffect(
    () => () => {
      preview?.pause();
      preview = null;
    },
    [],
  );
  // The editor's own playback takes over.
  useEffect(() => {
    if (editorPlaying) stop();
  }, [editorPlaying]);

  const listen = (track: Soundtrack, version: SoundtrackVersion) => {
    if (playing === track.id) return stop();
    preview?.pause();
    set({ playing: false });
    const audio = new Audio(soundtrackUrl(version.file));
    audio.onended = () => setPlaying((id) => (id === track.id ? null : id));
    preview = audio;
    setPlaying(track.id);
    void audio.play().catch(() => setPlaying(null));
  };

  const choose = async (track: Soundtrack, version: SoundtrackVersion) => {
    stop();
    setBusy(track.id);
    try {
      const res = await fetch(soundtrackUrl(version.file));
      if (!res.ok) throw new Error(String(res.status));
      await uploadMusic(new File([await res.blob()], version.file, { type: 'audio/mp4' }));
    } catch {
      toast(texts.loadFailed(track.name), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2.5" aria-label={texts.label}>
      <SectionTitle>{title}</SectionTitle>
      <p className="text-xs/[18px] text-ink-3">{texts.hint}</p>
      <ul className="divide-y divide-rule border-2 border-ink bg-white">
        {soundtracks.map((track) => {
          const version = versionFor(track, duration);
          const on = playing === track.id;
          const { style, use } = texts.presets[track.id] ?? track;
          return (
            <li key={track.id} className="flex items-center gap-2.5 py-2 pr-2.5 pl-2">
              <button
                type="button"
                aria-pressed={on}
                aria-label={on ? texts.stop(track.name) : texts.listen(track.name)}
                onClick={() => listen(track, version)}
                className={clsx(
                  'focus-ring press grid size-8 shrink-0 place-items-center border-2 border-ink',
                  on ? 'bg-ink text-now' : 'bg-white text-ink hover:bg-wash',
                )}
              >
                {on ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-px size-3.5 fill-current" />}
              </button>
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2">
                  <span className="display-caps text-base/5 text-ink">{track.name}</span>
                  {on ? (
                    <BeatPills tempo={track.bpm} className="text-ink" />
                  ) : (
                    <span className="label-caps truncate text-[10px] text-ink-4">{use}</span>
                  )}
                </p>
                <p className="truncate text-xs/[18px] text-ink-3">
                  {style} · {track.bpm}
                  {NBSP}BPM · {secsLabel(version.duration, 0)}
                </p>
              </div>
              {track.versions.some((v) => current === `music/${v.file}`) ? (
                <span className="label-caps inline-flex shrink-0 items-center gap-1 text-[11px] text-now-strong">
                  <Check className="size-3.5" aria-hidden /> {texts.used}
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="secondary"
                  aria-label={texts.useNamed(track.name)}
                  loading={busy === track.id}
                  disabled={busy !== null}
                  onClick={() => void choose(track, version)}
                >
                  {t.production.music.use}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Track

function TrackHeader({ file, analysis }: { file: string; analysis: MusicAnalysis | null }) {
  const t = useT();
  const status = useStore((s) => s.music);
  const grid = useStore((s) => s.project?.musicGrid ?? null);
  const name = file.replace(/^music\//, '');
  const preset = presetOf(file);
  return (
    <div className="border-2 border-ink bg-white px-3 py-2.5 shadow-hard-sm">
      {preset && <p className="label-caps text-[10px] text-ink-3">{t.production.music.track.preset}</p>}
      <p className="display-caps truncate text-lg/6 text-ink" title={name}>
        {preset?.name ?? name}
      </p>
      {status.status === 'analyzing' || (!grid && status.status !== 'error') ? (
        <p className="mt-1 flex items-center gap-2 text-xs text-ink-3">
          <BeatPills className="text-ink" /> {t.production.music.track.analyzing}
        </p>
      ) : status.status === 'error' ? (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-alert">
          <AlertTriangle className="mt-px size-3 shrink-0" /> {status.error ?? t.production.music.track.failed}
        </p>
      ) : grid ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-3">
          {secsLabel(grid.duration, 1)} · {fmtBpm(grid.bpm)}
          {analysis && (
            <Tooltip label={t.production.music.track.regularityHint} side="top">
              <span className="border border-ink px-1 text-[11px]/4 font-semibold text-ink-2">
                {t.production.music.track.regularity(percentShort(Math.round(analysis.confidence * 100)))}
              </span>
            </Tooltip>
          )}
        </p>
      ) : null}
    </div>
  );
}

const fmtBpm = (bpm: number) => `${secs(bpm, 1)}${NBSP}BPM`;

// Waveform

function WaveformSection() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const grid = project.musicGrid;
  const music = project.music!;
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <section className="space-y-2.5">
      <SectionTitle>{t.production.music.waveform.title}</SectionTitle>
      {grid ? (
        <Waveform grid={grid} start={music.start} length={project.duration} />
      ) : (
        <div className="skeleton h-[112px] border-2 border-ink" />
      )}
      <div className="flex items-center gap-2">
        <label htmlFor="music-start" className="label-caps text-[11px] whitespace-nowrap text-ink-2">
          {t.production.music.waveform.start}
        </label>
        <input
          id="music-start"
          inputMode="decimal"
          value={draft ?? secs(music.start, 3)}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={() => {
            const value = parseDecimal(draft ?? '');
            setDraft(null);
            if (Number.isFinite(value) && value >= 0 && Math.abs(value - music.start) > 0.0005)
              patchMusic({ start: Math.round(value * 1000) / 1000 });
          }}
          className={clsx(fieldBase, 'h-7 w-24 text-right text-[13px]')}
        />
        <span className="text-xs text-ink-3">s</span>
      </div>
      <p className="-mt-1 text-xs/[18px] text-ink-4">{t.production.music.waveform.hint}</p>
    </section>
  );
}

const WAVE_H = 108;
const LABEL_H = 16;

function Waveform({ grid, start, length }: { grid: MusicGridData; start: number; length: number }) {
  const texts = useT().production.music.waveform;
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const drag = useRef<{ grab: number; start: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const shownStart = preview ?? start;
  const px = (t: number) => (t / grid.duration) * width;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(WAVE_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_H);
    const top = LABEL_H;
    const h = WAVE_H - top;
    const mid = top + h / 2;
    const x = (t: number) => (t / grid.duration) * width;

    // Sections: alternating bands with their label.
    ctx.font = "600 10px 'Hanken Grotesk', system-ui, sans-serif";
    ctx.textBaseline = 'middle';
    grid.sections.forEach((s, i) => {
      const x0 = x(s.start);
      const x1 = x(s.end);
      if (i % 2 === 1) {
        ctx.fillStyle = 'rgba(24,24,27,0.035)';
        ctx.fillRect(x0, 0, x1 - x0, WAVE_H);
      }
      if (x1 - x0 > 28) {
        ctx.fillStyle = '#6b665c';
        ctx.fillText(s.label.toUpperCase(), x0 + 4, LABEL_H / 2, x1 - x0 - 8);
      }
    });

    // Grid: beats faint (when they fit), bars stronger, phrases in ink.
    const line = (t: number, color: string, y0: number, y1: number, w = 1) => {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x(t)) - w / 2, y0, w, y1 - y0);
    };
    const beatGap = grid.beats.length > 1 ? width / grid.beats.length : 0;
    if (beatGap >= 3) for (const t of grid.beats) line(t, 'rgba(24,24,27,0.07)', top, WAVE_H);
    const barGap = grid.downbeats.length > 1 ? width / grid.downbeats.length : 0;
    if (barGap >= 3) for (const t of grid.downbeats) line(t, 'rgba(24,24,27,0.16)', top, WAVE_H);
    for (const t of grid.phrases) line(t, '#18181b', top - 3, WAVE_H, 1.5);

    // Mirrored peaks, one bar every 2 px; inked inside the video window.
    const w0 = x(shownStart);
    const w1 = x(shownStart + length);
    const peaks = grid.waveform;
    for (let col = 0; col < width; col += 2) {
      const a = Math.floor((col / width) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((col + 2) / width) * peaks.length));
      let peak = 0;
      for (let i = a; i < b && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      const half = Math.max(0.75, peak * (h / 2 - 3));
      ctx.fillStyle = col >= w0 && col <= w1 ? '#18181b' : '#c9c1b1';
      ctx.fillRect(col, mid - half, 1.25, half * 2);
    }
  }, [grid, width, shownStart, length]);

  const timeAt = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * grid.duration;
  };
  /** Snap to the nearest downbeat within 6 px (hold Alt to place it freely). */
  const snap = (t: number, free: boolean) => {
    if (free) return t;
    let best = t;
    let bestPx = 6;
    for (const d of grid.downbeats) {
      const dist = Math.abs(px(d) - px(t));
      if (dist < bestPx) {
        best = d;
        bestPx = dist;
      }
    }
    return best;
  };
  const clampStart = (t: number) => Math.round(Math.min(Math.max(0, t), Math.max(0, grid.duration - 0.1)) * 1000) / 1000;

  const nudge = (beats: number) => {
    const beat = 60 / grid.bpm;
    patchMusic({ start: clampStart(start + beats * beat) }, 250);
  };

  return (
    <div className="border-2 border-ink bg-white">
      <div ref={box} className="relative select-none">
        <canvas ref={canvas} style={{ width, height: WAVE_H }} className="block" aria-hidden />
        <div
          role="slider"
          tabIndex={0}
          aria-label={texts.slider}
          aria-valuemin={0}
          aria-valuemax={Math.round(grid.duration * 100) / 100}
          aria-valuenow={Math.round(shownStart * 1000) / 1000}
          aria-valuetext={texts.sliderValue(secsLabel(shownStart))}
          className="focus-ring absolute inset-0 cursor-grab active:cursor-grabbing"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            e.stopPropagation();
            nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? grid.beatsPerBar : 1));
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const t = timeAt(e.clientX);
            const inside = t >= start && t <= start + length;
            drag.current = { grab: inside ? t - start : 0, start: inside ? start : clampStart(snap(t, e.altKey)) };
            setPreview(drag.current.start);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            setPreview(clampStart(snap(timeAt(e.clientX) - drag.current.grab, e.altKey)));
          }}
          onPointerUp={(e) => {
            if (!drag.current) return;
            e.currentTarget.releasePointerCapture(e.pointerId);
            drag.current = null;
            const next = preview ?? start;
            setPreview(null);
            if (Math.abs(next - start) > 0.0005) patchMusic({ start: next });
          }}
        >
          <span
            className="pointer-events-none absolute border-2 border-ink bg-now/15"
            style={{
              left: Math.max(0, px(shownStart)),
              width: Math.max(4, px(shownStart + length) - px(shownStart)),
              top: LABEL_H - 2,
              bottom: 2,
            }}
          >
            <span className="absolute bottom-0.5 left-0.5 bg-ink px-1 text-[11px]/[14px] font-semibold text-white">
              {secs(shownStart)}
            </span>
          </span>
          <TrackPlayhead duration={grid.duration} width={width} />
        </div>
      </div>
    </div>
  );
}

/** Where the preview playhead sits in the track: the logo's pink line. */
function TrackPlayhead({ duration, width }: { duration: number; width: number }) {
  const t = useStore((s) => {
    const scene = currentScene(s);
    return (s.project?.music?.start ?? 0) + (s.mode === 'scene' ? (scene?.start ?? 0) : 0) + s.time;
  });
  return (
    <span
      className="pointer-events-none absolute w-[2px] -translate-x-1/2 rounded-full bg-now"
      style={{ left: (t / duration) * width, top: LABEL_H - 4, bottom: 0 }}
    />
  );
}

// Settings

function Settings({ analysis }: { analysis: MusicAnalysis | null }) {
  const texts = useT().production.music.settings;
  const project = useStore((s) => s.project)!;
  const music = project.music!;
  const grid = project.musicGrid;
  const [bpm, setBpm] = useState<string | null>(null);
  const beatsPerBar = grid?.beatsPerBar ?? music.beatsPerBar ?? 4;
  const detected = analysis?.bpm ?? null;
  const offsetMs = Math.round((music.gridOffset ?? 0) * 1000);
  const update = async (patch: Parameters<typeof api.updateMusic>[1]) => {
    applyProject(await api.updateMusic(project.id, patch));
  };

  return (
    <section className="space-y-3.5">
      <SectionTitle>{texts.title}</SectionTitle>
      <Volume saved={music.volume} />
      <Row label={texts.tempo} hint={music.bpm ? texts.tempoForced : texts.tempoEmpty(detected ? fmtBpm(detected) : null)}>
        <input
          inputMode="decimal"
          aria-label={texts.tempoLabel}
          placeholder={detected ? secs(detected, 1) : '—'}
          value={bpm ?? (music.bpm ? secs(music.bpm, 1) : '')}
          onChange={(e) => setBpm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={() => {
            if (bpm === null) return;
            const value = parseDecimal(bpm);
            setBpm(null);
            if (bpm.trim() === '') void update({ bpm: null }).catch(ignore);
            else if (Number.isFinite(value) && value !== music.bpm)
              void update({ bpm: Math.round(value * 100) / 100 }).catch(ignore);
          }}
          className={clsx(fieldBase, 'h-7 w-20 text-right text-[13px]')}
        />
        <span className="text-xs text-ink-3">BPM</span>
        {music.bpm ? (
          <Button
            size="xs"
            variant="ghost"
            icon={<RotateCcw className="size-3" />}
            onClick={() => void update({ bpm: null }).catch(ignore)}
            className="ml-auto"
          >
            {texts.tempoDetected(detected ? secs(detected, 1) : null)}
          </Button>
        ) : null}
      </Row>
      <Row label={texts.meter}>
        <Segmented
          label={texts.beatsPerBar}
          size="sm"
          value={String(beatsPerBar)}
          onChange={(v) => void update({ beatsPerBar: Number(v) }).catch(ignore)}
          options={[
            { value: '3', label: '3/4' },
            { value: '4', label: '4/4' },
            { value: '6', label: '6/8' },
          ]}
        />
        {music.beatsPerBar !== undefined && analysis && music.beatsPerBar !== analysis.beatsPerBar && (
          <Button
            size="xs"
            variant="ghost"
            icon={<RotateCcw className="size-3" />}
            onClick={() => void update({ beatsPerBar: null }).catch(ignore)}
            className="ml-auto"
          >
            {texts.meterDetected}
          </Button>
        )}
      </Row>
      <Row label={texts.downbeat} hint={texts.downbeatHint}>
        <Stepper
          value={texts.downbeatValue((music.barOffset ?? 0) + 1)}
          minusLabel={texts.downbeatEarlier}
          plusLabel={texts.downbeatLater}
          onMinus={() => void update({ barOffset: ((music.barOffset ?? 0) - 1 + beatsPerBar) % beatsPerBar }).catch(ignore)}
          onPlus={() => void update({ barOffset: ((music.barOffset ?? 0) + 1) % beatsPerBar }).catch(ignore)}
        />
      </Row>
      <Row label={texts.offset} hint={texts.offsetHint}>
        <Stepper
          value={`${offsetMs > 0 ? '+' : offsetMs < 0 ? '−' : ''}${Math.abs(offsetMs)}${NBSP}ms`}
          minusLabel={texts.offsetEarlier}
          plusLabel={texts.offsetLater}
          onMinus={() =>
            void update({ gridOffset: Math.max(-0.25, Math.round((music.gridOffset ?? 0) * 1000 - 10) / 1000) }).catch(ignore)
          }
          onPlus={() =>
            void update({ gridOffset: Math.min(0.25, Math.round((music.gridOffset ?? 0) * 1000 + 10) / 1000) }).catch(ignore)
          }
        />
        {offsetMs !== 0 && (
          <Button
            size="xs"
            variant="ghost"
            icon={<RotateCcw className="size-3" />}
            onClick={() => void update({ gridOffset: null }).catch(ignore)}
            className="ml-auto"
          >
            0{NBSP}ms
          </Button>
        )}
      </Row>
    </section>
  );
}

/** The playing track follows the slider at once; the project saves the volume on release (saveVolume). */
function Volume({ saved }: { saved: number }) {
  const texts = useT().production.music.settings;
  const volume = useStore((s) => s.volumeDraft ?? saved);
  return (
    <Row label={texts.volume}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        aria-label={texts.volumeLabel}
        onChange={(e) => set({ volumeDraft: Number(e.target.value) })}
        onPointerUp={saveVolume}
        onKeyUp={saveVolume}
        onBlur={saveVolume}
        className="h-1.5 w-full min-w-0 flex-1"
      />
      <span className="w-10 text-right text-xs font-semibold text-ink-2">{percentShort(Math.round(volume * 100))}</span>
    </Row>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex min-h-7 items-center gap-2">
        <span className="label-caps w-[108px] shrink-0 text-[11px] text-ink-2">{label}</span>
        {children}
      </div>
      {hint && <p className="mt-0.5 pl-[116px] text-xs/[18px] text-ink-4">{hint}</p>}
    </div>
  );
}

function Stepper(props: { value: string; onMinus: () => void; onPlus: () => void; minusLabel: string; plusLabel: string }) {
  return (
    <span className="inline-flex items-stretch border-2 border-ink bg-white">
      <button
        type="button"
        aria-label={props.minusLabel}
        title={props.minusLabel}
        onClick={props.onMinus}
        className="focus-ring grid size-6 place-items-center text-ink-2 hover:bg-wash hover:text-ink"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="min-w-[76px] border-x-2 border-ink px-2 text-center text-xs/6 font-semibold text-ink">{props.value}</span>
      <button
        type="button"
        aria-label={props.plusLabel}
        title={props.plusLabel}
        onClick={props.onPlus}
        className="focus-ring grid size-6 place-items-center text-ink-2 hover:bg-wash hover:text-ink"
      >
        <Plus className="size-3.5" />
      </button>
    </span>
  );
}

// Snap & tracks

function Snap() {
  const texts = useT().production.music.snap;
  const ready = useStore((s) => Boolean(s.project?.musicGrid));
  const [busy, setBusy] = useState<SnapGrid | 'keep' | null>(null);
  const run = async (grid: SnapGrid, keepBars = false) => {
    setBusy(keepBars ? 'keep' : grid);
    await snapCuts(grid, keepBars ? { keepBars } : {}).catch(ignore);
    setBusy(null);
  };
  return (
    <section className="space-y-2">
      <SectionTitle>{texts.title}</SectionTitle>
      <Button
        size="sm"
        variant="primary"
        className="w-full"
        disabled={!ready || busy !== null}
        loading={busy === 'keep'}
        onClick={() => void run('bar', true)}
      >
        {texts.keepBars}
      </Button>
      <p className="text-xs/[18px] text-ink-3">{texts.keepBarsHint}</p>
      <div className="grid grid-cols-3 gap-2 pt-1">
        {(['beat', 'bar', 'phrase'] as const).map((grid) => (
          <Button
            key={grid}
            size="sm"
            variant="secondary"
            disabled={!ready || busy !== null}
            loading={busy === grid}
            onClick={() => void run(grid)}
          >
            {texts.grids[grid]}
          </Button>
        ))}
      </div>
      <p className="text-xs/[18px] text-ink-3">{texts.hint}</p>
    </section>
  );
}

function Tracks({ tracks, current }: { tracks: Track[]; current: string | null }) {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const input = useRef<HTMLInputElement>(null);
  if (tracks.length === 0 && current === null) return null;
  return (
    <section className="space-y-2.5">
      <SectionTitle
        action={
          current !== null && (
            <Button size="xs" variant="ghost" icon={<Upload className="size-3" />} onClick={() => input.current?.click()}>
              {t.production.music.tracks.other}
            </Button>
          )
        }
      >
        {t.production.music.tracks.title}
      </SectionTitle>
      <ul className="divide-y divide-rule border-2 border-ink bg-white">
        {tracks.map((track) => {
          const active = track.file === current;
          return (
            <li key={track.file} className="flex items-center gap-2 px-3 py-2">
              {active ? (
                <Check className="size-3.5 shrink-0 text-now-strong" aria-label={t.production.music.tracks.current} />
              ) : (
                <Music className="size-3.5 shrink-0 text-ink-4" aria-hidden />
              )}
              <span className={clsx('min-w-0 flex-1 truncate text-[13px]', active ? 'font-semibold text-ink' : 'text-ink-2')}>
                {track.file.replace(/^music\//, '')}
              </span>
              <span className="shrink-0 text-[11px] text-ink-4">{bytes(track.size)}</span>
              {!active && (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => void api.selectTrack(project.id, track.file).then(applyProject, ignore)}
                >
                  {t.production.music.use}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <input
        ref={input}
        type="file"
        accept={AUDIO_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadMusic(file);
          e.target.value = '';
        }}
      />
    </section>
  );
}
