// Rendu tab: export settings, running jobs with progress, finished renders with their preview.
import clsx from 'clsx';
import {
  Clapperboard,
  Copy,
  Download,
  Film,
  Images,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  Send,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  FORMATS,
  RENDER_OUTPUTS,
  type FormatId,
  type Publication,
  type PublishJob,
  type RenderFile,
  type RenderJob,
  type RenderOutput,
  type RenderQuality,
} from '../../shared/types';
import { api, ignore } from '../api';
import { useT } from '../i18n';
import { NBSP, bytes, percentShort, relative, secs, secsLabel } from '../lib/format';
import { fileAfterRemoval, fileView, hasAlpha, renderRequest, stillTime, unavailable } from '../lib/render';
import { currentScene, useStore } from '../store';
import { loadRenders } from '../store/project';
import { copyText, openModal } from '../store/ui';
import { NetworkLogo } from './logos';
import {
  Button,
  Checkbox,
  ConfirmButton,
  EmptyState,
  FormatGlyph,
  IconButton,
  Segmented,
  SectionTitle,
  Tooltip,
  useFocusAfter,
} from './ui';

const QUALITIES: RenderQuality[] = ['draft', 'standard', 'master'];

export function RenderView() {
  const texts = useT().production.render;
  const project = useStore((s) => s.project)!;
  const scene = useStore((s) => currentScene(s));
  const renders = useStore((s) => s.renders);
  const publishing = useStore((s) => s.publishing);
  const [formats, setFormats] = useState<FormatId[]>(project.formats);
  const [quality, setQuality] = useState<RenderQuality>('standard');
  const [scale, setScale] = useState('1');
  const [fps, setFps] = useState(String(project.fps));
  const playhead = useStore((s) => (s.mode === 'scene' && scene ? stillTime(scene, s.time, Number(fps)) : s.time));
  const [supersample, setSupersample] = useState(false);
  const [range, setRange] = useState<'all' | 'scene'>('all');
  const [output, setOutput] = useState<RenderOutput>('mp4');
  const [transparent, setTransparent] = useState(false);
  const [starting, setStarting] = useState(false);
  const { list: shelf, focusAfter } = useFocusAfter<HTMLElement>();

  useEffect(() => {
    setFormats((current) => current.filter((f) => project.formats.includes(f)));
  }, [project.formats]);

  const chosen = project.formats.filter((f) => formats.includes(f));
  const seconds = range === 'scene' && scene ? scene.duration : project.duration;
  const outputLabel = texts.outputs[output].label;
  const blocked = unavailable(output, renders.outputs);
  // Same rounding as the encoder (H.264 needs even sizes): 4:5 at 0,5× is 540 × 674.
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  const size = (f: FormatId) =>
    `${even(FORMATS[f].width * Number(scale))}${NBSP}×${NBSP}${even(FORMATS[f].height * Number(scale))}`;
  const active = renders.jobs.filter((j) => j.status === 'queued' || j.status === 'rendering' || j.status === 'encoding');
  const failed = renders.jobs.filter(
    (j) => (j.status === 'error' || j.status === 'cancelled') && Date.now() - new Date(j.createdAt).getTime() < 3_600_000,
  );

  const start = async () => {
    setStarting(true);
    try {
      await api.startRender(
        project.id,
        renderRequest({
          formats: chosen,
          quality,
          scale: Number(scale),
          fps: Number(fps),
          supersample,
          output,
          transparent,
          range: range === 'scene' && scene ? { from: scene.start, to: scene.start + scene.duration } : null,
          playhead,
        }),
      );
    } catch {
      // toast shown
    } finally {
      setStarting(false);
    }
  };

  // The focused delete button leaves with its card: the next card's takes the focus (another of its controls while it
  // uploads, since its delete button is off then), or the empty state after the last.
  const remove = (name: string) => {
    const next = fileAfterRemoval(
      renders.files.map((f) => f.name),
      name,
    );
    const removed = api.deleteRender(project.id, name).then(loadRenders);
    focusAfter(
      removed.then(
        () => true,
        () => false,
      ),
      next
        ? [`[data-file="${next}"] [data-control="remove"] button`, `[data-file="${next}"] button:not(:disabled)`]
        : ['[data-control="empty"]'],
    );
    return removed;
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-grid-fade">
      <div className="mx-auto grid max-w-[92rem] grid-cols-[380px_minmax(0,1fr)] gap-6 px-6 py-10">
        <form
          className="h-fit space-y-5 border-2 border-ink bg-white p-5 shadow-hard"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div>
            <h2 className="display-caps text-[22px]/7 text-ink">{texts.title}</h2>
            <p className="mt-1 text-[13px] text-ink-3">{texts.subtitle}</p>
          </div>
          <section className="space-y-2">
            <SectionTitle>{texts.output}</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={texts.output}>
              {RENDER_OUTPUTS.map((value) => {
                const reason = unavailable(value, renders.outputs);
                const on = output === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={reason !== null}
                    onClick={() => setOutput(value)}
                    className={clsx(
                      'focus-ring press border-2 border-ink px-3 py-2 text-left disabled:border-track disabled:text-ink-4',
                      on ? 'bg-ink text-white' : 'bg-white text-ink enabled:hover:bg-wash',
                    )}
                  >
                    <span className="block text-[13px] font-semibold">{texts.outputs[value].label}</span>
                    <span className={clsx('block text-xs', on ? 'text-ink-4' : reason === null && 'text-ink-3')}>
                      {reason ?? texts.outputs[value].detail}
                    </span>
                  </button>
                );
              })}
            </div>
            {hasAlpha(output) && (
              <Checkbox
                checked={transparent}
                onChange={setTransparent}
                label={texts.transparent}
                description={texts.transparentHint}
              />
            )}
          </section>
          <section className="space-y-2">
            <SectionTitle>{texts.formats}</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5">
              {project.formats.map((f) => {
                const on = formats.includes(f);
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFormats(on ? formats.filter((x) => x !== f) : [...formats, f])}
                    className={clsx(
                      'focus-ring press flex items-center gap-2.5 border-2 border-ink px-3 py-2 text-left',
                      on ? 'bg-ink text-white' : 'bg-white text-ink hover:bg-wash',
                    )}
                  >
                    <FormatGlyph format={f} className={on ? 'opacity-90' : 'opacity-50'} />
                    <span className="min-w-0">
                      <span className="display-caps block text-[15px]/5">{f}</span>
                      <span className={clsx('block font-mono text-[10.5px]', on ? 'text-ink-4' : 'text-ink-3')}>{size(f)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="space-y-2">
            <SectionTitle>{texts.quality}</SectionTitle>
            <div className="space-y-1.5" role="radiogroup" aria-label={texts.quality}>
              {QUALITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={quality === value}
                  data-down={quality === value || undefined}
                  onClick={() => setQuality(value)}
                  className={clsx(
                    'focus-ring press flex w-full items-start gap-2.5 border-2 border-ink px-3 py-2 text-left',
                    quality === value ? 'bg-ink text-white' : 'bg-white text-ink hover:bg-wash',
                  )}
                >
                  {/* The chosen quality lights up, like a selector on a deck. */}
                  <span
                    className={clsx(
                      'mt-0.5 grid size-4 shrink-0 place-items-center border-2',
                      quality === value ? 'border-white' : 'border-ink',
                    )}
                  >
                    {quality === value && <span className="size-1.5 bg-now" />}
                  </span>
                  <span>
                    <span className="block text-[13px] font-semibold">{texts.qualities[value].label}</span>
                    <span className={clsx('block text-xs', quality === value ? 'text-ink-4' : 'text-ink-3')}>
                      {texts.qualities[value].description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <div className="grid grid-cols-2 gap-4">
            <section className="space-y-2">
              <SectionTitle>{texts.scale}</SectionTitle>
              <Segmented
                label={texts.scale}
                size="sm"
                stretch
                value={scale}
                onChange={setScale}
                options={[
                  { value: '0.5', label: texts.halfScale },
                  { value: '1', label: '1×' },
                  { value: '2', label: '2× 4K' },
                ]}
              />
            </section>
            <section className="space-y-2">
              <SectionTitle>{texts.fps}</SectionTitle>
              <Segmented
                label={texts.fps}
                size="sm"
                stretch
                value={fps}
                onChange={setFps}
                options={['24', '30', '60'].map((v) => ({ value: v, label: v }))}
              />
            </section>
          </div>
          <Checkbox
            checked={supersample}
            onChange={setSupersample}
            label={texts.supersample}
            description={texts.supersampleHint}
          />
          <section className="space-y-2">
            <SectionTitle>{texts.range}</SectionTitle>
            {output === 'png' ? (
              <p className="text-xs text-ink-3">{texts.stillAt(secsLabel(playhead))}</p>
            ) : (
              <>
                <Segmented
                  label={texts.range}
                  size="sm"
                  stretch
                  value={range}
                  onChange={setRange}
                  options={[
                    { value: 'all', label: texts.wholeVideo },
                    { value: 'scene', label: texts.selectedScene, disabled: !scene },
                  ]}
                />
                <p className="text-xs text-ink-3">
                  {range === 'scene' && scene
                    ? texts.sceneRange(scene.name, secs(scene.start), secsLabel(scene.start + scene.duration))
                    : texts.videoRange(project.scenes.length, secsLabel(project.duration))}
                </p>
              </>
            )}
          </section>
          <div className="border-t border-rule pt-4">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              icon={<Clapperboard className="size-4" />}
              loading={starting}
              disabled={chosen.length === 0 || blocked !== null}
            >
              {texts.start}
            </Button>
            <p className="mt-2 text-center text-xs text-ink-3" aria-live="polite">
              {chosen.length === 0
                ? texts.noFormat
                : (blocked ??
                  (output === 'png'
                    ? texts.stillSummary(outputLabel, chosen.length, secsLabel(playhead))
                    : texts.summary(outputLabel, chosen.length, secsLabel(seconds), fps, Math.round(seconds * Number(fps)))))}
            </p>
          </div>
        </form>

        <div className="min-w-0 space-y-6">
          {(active.length > 0 || failed.length > 0) && (
            <section className="space-y-4">
              <h2 className="display-caps text-[22px]/7 text-ink">{active.length > 0 ? texts.running : texts.recent}</h2>
              <ul className="space-y-3">
                {[...active, ...failed].map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            </section>
          )}
          <section ref={shelf} className="space-y-4">
            <h2 className="display-caps text-[22px]/7 text-ink">{texts.exported}</h2>
            {renders.files.length === 0 ? (
              <div data-control="empty" tabIndex={-1} className="border-2 border-dashed border-ink bg-paper/70 outline-none">
                <EmptyState icon={<Film className="size-5" />} title={texts.empty}>
                  {texts.emptyHint}
                </EmptyState>
              </div>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-6">
                {renders.files.map((file) => (
                  <FileCard
                    key={file.name}
                    file={file}
                    dir={project.dir}
                    publications={publishing.publications.filter((p) => p.file === file.name)}
                    sending={publishing.jobs.find((j) => j.file === file.name && j.status === 'uploading')}
                    onRemove={() => remove(file.name)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function JobRow({ job }: { job: RenderJob }) {
  const texts = useT().production.render.job;
  const live = job.status === 'queued' || job.status === 'rendering' || job.status === 'encoding';
  const pct = Math.round(job.progress * 100);
  return (
    <li className="border-2 border-ink bg-white px-4 py-3 shadow-hard">
      <div className="flex items-center gap-3">
        <FormatGlyph format={job.format} className="text-ink-3" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">
            {job.format} · {job.width}
            {NBSP}×{NBSP}
            {job.height} · {texts.fps(job.fps)}
          </p>
          <p
            className={clsx(
              'flex items-center gap-1.5 text-xs select-text',
              job.status === 'error' ? 'text-alert' : 'text-ink-3',
            )}
          >
            {live && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {texts.status[job.status]}
            {job.status === 'rendering' && ` · ${texts.frames(job.framesDone, job.framesTotal)}`}
            {job.status === 'error' && job.error ? texts.error(job.error) : ''}
          </p>
        </div>
        {live && <span className="font-mono text-[13px] font-medium text-ink-2 tabular-nums">{percentShort(pct)}</span>}
        {live && (
          <IconButton
            label={texts.cancel}
            icon={<X className="size-4" />}
            size="sm"
            onClick={() => void api.cancelRender(job.id).catch(ignore)}
          />
        )}
      </div>
      {live && (
        <div
          className="mt-2.5 h-2 overflow-hidden rounded-full bg-white ring-[1.5px] ring-ink"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={texts.progress(job.format)}
        >
          <div
            className={clsx('h-full transition-[width] duration-300', job.status === 'encoding' ? 'bg-now' : 'bg-ink')}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      )}
    </li>
  );
}

function FileCard(props: {
  file: RenderFile;
  dir: string;
  publications: Publication[];
  sending?: PublishJob;
  onRemove: () => Promise<unknown>;
}) {
  const { file, dir, publications, sending, onRemove } = props;
  const { common, production } = useT();
  const texts = production.render.file;
  const visibilities = common.visibilities;
  const networks = useStore((s) => s.app?.networks);
  const label = (id: string) => networks?.find((n) => n.id === id)?.label ?? id;
  const view = fileView(file.output);
  const image = useRef<HTMLImageElement>(null);
  // A GIF loops and keeps the render's size and rate: like a video, nothing loads before its play key.
  const [shown, setShown] = useState(file.output !== 'gif');
  const show = () => {
    flushSync(() => setShown(true));
    image.current?.focus();
  };
  return (
    <li data-file={file.name} className="flex flex-col overflow-hidden border-2 border-ink bg-white shadow-hard">
      {view.preview === 'video' && <Player src={file.url} label={file.name} />}
      {view.preview === 'image' && (
        <div className="aspect-video border-b-2 border-ink bg-ink">
          {shown ? (
            <img
              ref={image}
              src={file.url}
              alt={file.name}
              loading="lazy"
              decoding="async"
              tabIndex={-1}
              className="size-full object-contain outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={show}
              aria-label={texts.playGif}
              className="focus-ring grid size-full cursor-(--control-cursor) place-items-center"
            >
              <span className="grid size-12 place-items-center bg-now text-ink">
                <Play className="ml-0.5 size-5 fill-current" />
              </span>
            </button>
          )}
        </div>
      )}
      {view.preview === 'frames' && (
        <div className="grid aspect-video place-items-center border-b-2 border-ink bg-ink text-ink-4" aria-hidden>
          <Images className="size-6" />
        </div>
      )}
      {/* Actions at the bottom: they line up across a row whatever the publications above them. */}
      <div className="flex flex-1 flex-col px-3.5 py-3">
        <p className="truncate font-mono text-[12px] font-medium text-ink-2" title={file.name}>
          {file.name}
        </p>
        <p className="mt-0.5 text-xs text-ink-3">
          {file.format ?? texts.unknownFormat} · {production.render.outputs[file.output].label}
          {file.frames !== undefined && ` · ${texts.frames(file.frames)}`} · {bytes(file.size)} · {relative(file.createdAt)}
        </p>
        {(publications.length > 0 || sending) && (
          <ul className="mt-2 space-y-0.5 text-xs text-ink-3">
            {sending && (
              <li className="font-semibold text-ink-2">
                {texts.uploading(label(sending.network), percentShort(Math.round(sending.progress * 100)))}
              </li>
            )}
            {publications.map((p) => (
              <li key={`${p.publishedAt} ${p.url}`} className="truncate">
                {p.url ? (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring inline-flex items-center gap-1 font-semibold text-ink-2 underline decoration-now decoration-2 underline-offset-2"
                  >
                    <NetworkLogo id={p.network} className="size-3.5" />
                    {label(p.network)}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 font-semibold text-ink-2">
                    <NetworkLogo id={p.network} className="size-3.5" />
                    {label(p.network)}
                  </span>
                )}{' '}
                {visibilities[p.visibility].toLowerCase()}, {relative(p.publishedAt)}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex items-center gap-1.5 pt-2.5">
          {view.publish && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Send className="size-3.5" />}
              onClick={() => openModal({ kind: 'publish', file: file.name })}
            >
              {texts.publish}
            </Button>
          )}
          <span className="flex-1" />
          <IconButton
            label={texts.copyPath}
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => void copyText(`${dir}/renders/${file.name}`, texts.pathCopied)}
          />
          {view.download && (
            <Tooltip label={texts.download}>
              <a
                href={file.url}
                download={file.name}
                aria-label={texts.download}
                className="focus-ring grid size-7 cursor-(--control-cursor) place-items-center text-ink-2 hover:bg-wash hover:text-ink"
              >
                <Download className="size-3.5" />
              </a>
            </Tooltip>
          )}
          {/* The server refuses it too while this video uploads: the network reads the file. */}
          <span data-control="remove" className="contents">
            <ConfirmButton
              iconOnly
              label={texts.remove}
              confirmLabel={texts.removeConfirm}
              icon={<Trash2 className="size-3.5" />}
              disabled={sending !== undefined}
              onConfirm={onRemove}
            />
          </span>
        </div>
      </div>
    </li>
  );
}

/**
 * An exported video on an ink screen, over a small deck in the transport's style: play key, counter, the clip and its
 * playhead. A video the browser cannot show (ProRes outside Safari) gets a note instead: the download stays on the card.
 */
function Player({ src, label }: { src: string; label: string }) {
  const { timeline, production } = useT();
  const keys = timeline.transport;
  const texts = production.render.file;
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const playKey = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const [unplayable, setUnplayable] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Until the first play or seek, the screen shows the poster frame (#t below) and the deck reads 0.
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(false);
  const shown = started ? time : 0;
  const pct = `${duration > 0 ? (shown / duration) * 100 : 0}%`;

  // timeupdate comes about four times a second: follow the frames while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      setTime(video.current!.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = () => {
    const v = video.current!;
    if (v.paused) void v.play().catch(ignore);
    else v.pause();
  };
  const seek = (t: number) => {
    const v = video.current!;
    v.currentTime = Math.min(duration, Math.max(0, t));
    setStarted(true);
    setTime(v.currentTime);
  };
  const at = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * duration;
  };
  // Chromium plays the sound of a ProRes file without its picture, so no picture counts as unplayable too.
  const fail = () => {
    const focused = box.current?.contains(document.activeElement);
    flushSync(() => setUnplayable(true));
    if (focused) note.current?.focus();
  };

  if (unplayable) {
    return (
      <div className="grid aspect-video place-items-center border-b-2 border-ink bg-ink px-4 text-center">
        <p ref={note} tabIndex={-1} className="text-[13px] text-ink-4 outline-none">
          {texts.previewUnavailable}
        </p>
      </div>
    );
  }

  return (
    <div ref={box} className="flex flex-col">
      <div className={clsx('relative bg-ink', full ? 'min-h-0 flex-1' : 'aspect-video')}>
        {/* #t: the poster is a frame a little into the video (first frames are often the plain background). */}
        <video
          ref={video}
          src={`${src}#t=1.2`}
          preload="metadata"
          className="absolute inset-0 size-full cursor-(--control-cursor) object-contain"
          aria-label={label}
          onClick={toggle}
          onError={fail}
          onLoadedMetadata={(e) => (e.currentTarget.videoWidth === 0 ? fail() : setDuration(e.currentTarget.duration))}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          onPause={() => setPlaying(false)}
          onPlay={(e) => {
            setPlaying(true);
            if (started) return;
            // The first play starts from the beginning, not from the poster frame.
            setStarted(true);
            e.currentTarget.currentTime = 0;
          }}
        />
        {!started && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
            <span className="grid size-12 place-items-center bg-now text-ink">
              <Play className="ml-0.5 size-5 fill-current" />
            </span>
          </span>
        )}
      </div>
      <div className={clsx('bg-paper px-3 pt-1.5 pb-2.5', !full && 'border-b-2 border-ink')}>
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label={keys.playhead}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 100) / 100}
          aria-valuenow={Math.round(shown * 100) / 100}
          aria-valuetext={secsLabel(shown)}
          className="focus-ring relative h-6 cursor-(--control-cursor) touch-none select-none"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(at(e.clientX));
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(at(e.clientX));
          }}
          onKeyDown={(e) => {
            const to = ({ ArrowLeft: shown - 1, ArrowRight: shown + 1, Home: 0, End: duration } as Record<string, number>)[e.key];
            if (to === undefined) return;
            e.preventDefault();
            seek(to);
          }}
        >
          <div className="pointer-events-none absolute inset-x-0 top-3 h-2 overflow-hidden rounded-full bg-white ring-[1.5px] ring-ink">
            <div className="h-full bg-ink" style={{ width: pct }} />
          </div>
          <span
            className="pointer-events-none absolute top-1 h-5 w-[3px] -translate-x-1/2 rounded-full bg-now before:absolute before:-top-1 before:left-1/2 before:size-[9px] before:-translate-x-1/2 before:rounded-full before:bg-now"
            style={{ left: pct }}
          />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {/* The play key stays down while the video plays, like the transport's. */}
          <button
            ref={playKey}
            type="button"
            onClick={toggle}
            aria-label={playing ? keys.pause : keys.play}
            data-down={playing || undefined}
            className={clsx(
              'focus-ring press grid size-8 shrink-0 place-items-center border-2 border-ink',
              playing ? 'bg-ink text-now' : 'bg-now text-ink hover:bg-now/85',
            )}
          >
            {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
          </button>
          <span className="bg-ink px-2 py-1 text-[13px]/5 font-semibold">
            <span className={playing ? 'text-now' : 'text-white'}>{secs(shown)}</span>
            <span className="text-ink-4"> / {secsLabel(duration)}</span>
          </span>
          <span className="flex-1" />
          <IconButton
            label={muted ? keys.unmute : keys.mute}
            icon={muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            size="sm"
            side="top"
            onClick={() => {
              video.current!.muted = !muted;
            }}
          />
          <IconButton
            label={full ? texts.exitFullScreen : texts.fullScreen}
            icon={full ? <Minimize className="size-3.5" /> : <Maximize className="size-3.5" />}
            size="sm"
            side="top"
            onClick={() => {
              if (full) void document.exitFullscreen().catch(ignore);
              // On the play key, Space plays and pauses instead of pressing this button again.
              else void box.current!.requestFullscreen().then(() => playKey.current?.focus(), ignore);
            }}
          />
        </div>
      </div>
    </div>
  );
}
