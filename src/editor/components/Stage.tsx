// Stage: header, live preview (frame.html fitted into a neutral surround), frame error banner, transport.
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, ChevronUp, Scan, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chatKeyForScene, FORMATS, type FormatId } from '../../shared/types';
import { useT } from '../i18n';
import { bars, secsLabel } from '../lib/format';
import { useSoundPlayer, type SoundPlayer } from '../lib/sounds';
import { SAFE_AREAS, sceneBars } from '../lib/timeline';
import { currentScene, get, previewDuration, sceneAt, set, useStore } from '../store';
import { prefill } from '../store/chat';
import { setFormat, setPlaying } from '../store/project';
import { FrameView, type FrameHandle } from './FrameView';
import { PlaybackEngine, Transport } from './Transport';
import { Button, FormatGlyph, IconButton, Segmented, Spinner } from './ui';
import { useAgentName } from './agents';

/** Room around the picture for its frame and printed shadow. */
const PAD = 32;

export function Stage() {
  const t = useT();
  const sounds = useSoundPlayer();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t.shell.stage.label}>
      <StageHeader />
      <Preview sounds={sounds} />
      <Transport />
      <PlaybackEngine sounds={sounds} />
    </section>
  );
}

function StageHeader() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  // The whole video names the scene under the playhead: the selection only catches up once it rests.
  const scene = useStore((s) => (s.mode === 'whole' && s.project ? sceneAt(s.project, s.time) : currentScene(s)));
  const mode = useStore((s) => s.mode);
  const format = useStore((s) => s.format);
  const safeArea = useStore((s) => s.safeArea);
  const count = project.scenes.length;
  const dot = (
    <span className="text-[9px] text-ink-4" aria-hidden>
      ◆
    </span>
  );

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b-2 border-ink bg-paper pr-2 pl-4">
      <p className="flex min-w-0 flex-1 items-center gap-2 truncate whitespace-nowrap">
        {mode === 'scene' && scene ? (
          <>
            <span className="display-caps text-[17px] text-ink">{t.shell.stage.sceneOf(scene.index + 1, count)}</span>
            {dot}
            <span className="truncate text-[13px] font-semibold text-ink">{scene.name}</span>
            {dot}
            <span className="text-xs text-ink-3">
              {secsLabel(scene.duration)} · {bars(sceneBars(project, scene))}
            </span>
          </>
        ) : (
          <>
            <span className="display-caps text-[17px] text-ink">{t.shell.stage.whole}</span>
            {dot}
            <span className="text-[13px] font-semibold text-ink">{t.shell.stage.sceneCount(count)}</span>
            {scene && (
              <>
                {dot}
                <span className="truncate text-xs text-ink-3">{t.shell.stage.scene(scene.index + 1, scene.name)}</span>
              </>
            )}
          </>
        )}
      </p>
      {project.formats.length > 1 && (
        <Segmented
          label={t.shell.stage.format}
          size="sm"
          value={format}
          onChange={(value: FormatId) => setFormat(value)}
          options={project.formats.map((f) => ({
            value: f,
            label: f,
            icon: <FormatGlyph format={f} />,
            title: t.common.formats[f],
          }))}
        />
      )}
      <IconButton
        label={safeArea ? t.shell.stage.hideSafeArea : t.shell.stage.showSafeArea}
        icon={<Scan className="size-4" />}
        active={safeArea}
        size="sm"
        onClick={() => set({ safeArea: !safeArea })}
      />
    </div>
  );
}

function Preview({ sounds }: { sounds: SoundPlayer }) {
  const t = useT();
  const app = useStore((s) => s.app)!;
  const project = useStore((s) => s.project)!;
  const format = useStore((s) => s.format);
  const mode = useStore((s) => s.mode);
  const sceneId = useStore((s) => currentScene(s)?.id ?? null);
  const epoch = useStore((s) => s.frameEpoch);
  const reload = useStore((s) => s.frameReload);
  const generation = useStore((s) => s.generation);
  const safeArea = useStore((s) => s.safeArea);
  const duration = useStore((s) => previewDuration(s));
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<FrameHandle>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Playback and scrubbing render synchronously; a resting playhead gets the exact, settled frame.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.time === prev.time && s.playing === prev.playing && s.scrubbing === prev.scrubbing) return;
        if (s.playing || s.scrubbing) frame.current?.render(s.time);
        else frame.current?.seek(s.time);
      }),
    [],
  );

  // Each reload re-imports the scenes and the brand, and a page never frees modules (about 0.3 MB per code change):
  // a fresh page every 100 generations bounds that.
  const key = `${project.id}:${epoch}:${Math.floor(generation / 100)}`;
  useEffect(() => {
    setReady(false);
    sounds.forget();
  }, [key, sounds]);
  const onErrors = useCallback((errors: string[]) => set({ frameErrors: errors }), []);
  const shownSceneId = mode === 'scene' ? sceneId : null;
  const scenes = mode === 'scene' ? 1 : project.scenes.length;
  useEffect(() => sounds.show({ sceneId: shownSceneId, duration, scenes }), [sounds, shownSceneId, duration, scenes]);

  const spec = FORMATS[format];
  const fit = Math.max(0, Math.min((box.w - PAD * 2) / spec.width, (box.h - PAD * 2) / spec.height));
  const w = Math.floor(spec.width * fit);
  const h = Math.floor(spec.height * fit);

  return (
    <div
      ref={area}
      className="relative min-h-0 flex-1 overflow-hidden bg-stage bg-grid"
      onClick={(e) => {
        // A click on the picture plays or pauses, like a video player.
        if ((e.target as HTMLElement).dataset.canvas !== undefined) setPlaying(!get().playing);
      }}
    >
      {w > 0 && h > 0 && (
        <div
          data-canvas=""
          className="absolute overflow-hidden bg-white shadow-[0_0_0_2px_var(--color-ink),6px_6px_0_2px_var(--color-ink)]"
          style={{ left: Math.round((box.w - w) / 2), top: Math.round((box.h - h) / 2), width: w, height: h }}
        >
          <FrameView
            key={key}
            ref={frame}
            frameOrigin={app.frameOrigin}
            projectId={project.id}
            mode="editor"
            sceneId={shownSceneId}
            format={format}
            initialTime={get().time}
            reload={reload}
            generation={generation}
            title={t.shell.stage.frame}
            className="pointer-events-none block size-full border-0"
            onReady={() => setReady(true)}
            onErrors={onErrors}
            onSounds={(id, cues) => sounds.receive(id, cues)}
          />
          {safeArea && <SafeAreaOverlay format={format} scale={fit} />}
          {!ready && (
            <div className="absolute inset-0 grid place-items-center bg-white">
              <Spinner className="size-5" />
            </div>
          )}
        </div>
      )}
      <FrameErrorBanner />
    </div>
  );
}

function SafeAreaOverlay({ format, scale }: { format: FormatId; scale: number }) {
  const t = useT();
  const safe = SAFE_AREAS[format];
  const social = format !== '16:9';
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div
        className="absolute border border-dashed border-now shadow-[0_0_0_9999px_rgb(255_46_136/0.08)]"
        style={{ top: safe.top * scale, right: safe.right * scale, bottom: safe.bottom * scale, left: safe.left * scale }}
      />
      {social && (
        <>
          <span className="label-caps absolute top-1 left-1/2 -translate-x-1/2 bg-ink px-1.5 py-0.5 text-[10px] text-white">
            {t.shell.stage.appHeader}
          </span>
          <span className="label-caps absolute bottom-1 left-1/2 -translate-x-1/2 bg-ink px-1.5 py-0.5 text-[10px] text-white">
            {t.shell.stage.caption}
          </span>
        </>
      )}
    </div>
  );
}

function FrameErrorBanner() {
  const t = useT();
  const agent = useAgentName();
  const errors = useStore((s) => s.frameErrors);
  const scene = useStore((s) => currentScene(s));
  const [open, setOpen] = useState(false);
  if (errors.length === 0) return null;
  const [title, ...rest] = errors[0].split('\n');
  // The error's title ends with the scene file (scenes/<id>.tsx); otherwise the selected scene is the one.
  const named = /scenes\/([a-z0-9-]+)\.tsx/.exec(errors[0])?.[1];
  const target = get().project?.scenes.find((s) => s.id === named) ?? scene;
  const ask = () => {
    if (!target) return;
    prefill(chatKeyForScene(target.id), t.shell.stage.fixPrompt(errors.join('\n\n').slice(0, 4000)));
  };
  return (
    <div className="absolute inset-x-4 top-3 z-10 animate-pop-in border-2 border-l-8 border-ink border-l-alert bg-white shadow-float">
      <div className="flex items-start gap-3 px-3.5 py-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-alert">{title}</p>
          {rest.length > 0 && !open && <p className="truncate font-mono text-xs text-ink-2">{rest[0]}</p>}
        </div>
        {rest.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            onClick={() => setOpen(!open)}
          >
            {open ? t.shell.stage.collapse : t.shell.stage.details}
          </Button>
        )}
        {target && (
          <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" />} onClick={ask}>
            {t.shell.stage.askFix(agent)}
          </Button>
        )}
      </div>
      {open && (
        <pre
          className={clsx(
            'max-h-56 overflow-auto border-t-2 border-ink px-3.5 py-2.5 font-mono text-xs whitespace-pre-wrap text-ink-2',
          )}
        >
          {errors.join('\n\n')}
        </pre>
      )}
    </div>
  );
}
