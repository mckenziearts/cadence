// Filmstrip: scene cards (server thumbnails), seam badges and transitions between them, rename, duration, reorder, context menu.
import clsx from 'clsx';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blend,
  Check,
  Copy,
  CopyPlus,
  FlipHorizontal2,
  MoreHorizontal,
  MoveHorizontal,
  Pencil,
  Plus,
  Scissors,
  SquareSplitHorizontal,
  Trash2,
} from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_KINDS,
  type SceneState,
  type SceneTransition,
  type SeamResult,
} from '../../shared/types';
import { api, ignore } from '../api';
import { useT } from '../i18n';
import { bars, parseDecimal, parseDuration, percent, seamShare, seamTone, secs, secsExact, secsLabel } from '../lib/format';
import { barDrift, sceneBars, sceneMusic } from '../lib/timeline';
import { clampedTransition, editTransition } from '../lib/transitions';
import { currentScene, get, set, useStore } from '../store';
import {
  deleteScene,
  duplicateScene,
  renameScene,
  reorderScenes,
  selectScene,
  setSceneDuration,
  setTransition,
} from '../store/project';
import { copyText, openModal } from '../store/ui';
import { Tooltip } from './ui';

const CARD_W = 176;
const THUMB_H = 99;
const KIND_ICONS = { fade: Blend, slide: MoveHorizontal, wipe: SquareSplitHorizontal, flip: FlipHorizontal2 };
const DIRECTION_ICONS = { left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown };
const MENU_ITEM =
  'focus-ring flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px] font-medium text-ink outline-none hover:bg-wash focus:bg-wash';

/** Seconds as typed in a field, to the ms and without trailing zeros: "2,5", not "2,500". */
const fieldSecs = (t: number) => secs(t, 3).replace(/0+$/, '').replace(/[.,]$/, '');

export function Filmstrip() {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const selected = useStore((s) => currentScene(s)?.id ?? null);
  const seams = useStore((s) => s.seams);
  const format = useStore((s) => s.format);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ scene: SceneState; x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  const drop = () => {
    if (!dragId || dropIndex === null) return;
    const ids = project.scenes.map((s) => s.id).filter((id) => id !== dragId);
    const from = project.scenes.findIndex((s) => s.id === dragId);
    ids.splice(dropIndex > from ? dropIndex - 1 : dropIndex, 0, dragId);
    setDragId(null);
    setDropIndex(null);
    void reorderScenes(ids);
  };

  const seamFor = (from: SceneState, to: SceneState): SeamResult | undefined =>
    seams.find((r) => r.from === from.id && r.to === to.id && r.format === format);

  return (
    <div className="relative shrink-0 border-t-2 border-ink bg-paper">
      <div
        ref={strip}
        role="list"
        aria-label={t.timeline.filmstrip.label}
        className="flex items-start overflow-x-auto px-4 pt-4 pb-3"
        onWheel={(e) => {
          if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY;
        }}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-scene-card]')];
          let index = cards.length;
          for (let i = 0; i < cards.length; i++) {
            const rect = cards[i].getBoundingClientRect();
            if (e.clientX < rect.left + rect.width / 2) {
              index = i;
              break;
            }
          }
          setDropIndex(index);
        }}
        onDrop={(e) => {
          if (!dragId) return;
          e.preventDefault();
          drop();
        }}
      >
        {project.scenes.map((scene, i) => (
          <Fragment key={scene.id}>
            {i > 0 && <SeamBadge from={project.scenes[i - 1]} to={scene} result={seamFor(project.scenes[i - 1], scene)} />}
            <SceneCard
              scene={scene}
              selected={scene.id === selected}
              dragging={dragId === scene.id}
              dropBefore={dragId !== null && dropIndex === i && dragId !== scene.id}
              onDragStart={() => setDragId(scene.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              onMenu={(x, y) => setMenu({ scene, x, y })}
            />
          </Fragment>
        ))}
        <div
          className={clsx(
            'relative ml-3 shrink-0',
            dragId &&
              dropIndex === project.scenes.length &&
              'before:absolute before:top-0 before:-left-2 before:h-[99px] before:w-1 before:bg-now',
          )}
        >
          <button
            type="button"
            aria-label={t.timeline.filmstrip.addScene}
            onClick={() => openModal({ kind: 'templates' })}
            className="focus-ring display-caps flex flex-col items-center justify-center gap-1 border-2 border-dashed border-ink-4 text-[15px] text-ink-3 hover:border-ink hover:bg-white hover:text-ink"
            style={{ width: 120, height: THUMB_H }}
          >
            <Plus className="size-5" aria-hidden />
            {t.timeline.filmstrip.newScene}
          </button>
        </div>
      </div>
      {menu && <SceneMenu scene={menu.scene} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

// Card

function SceneCard(props: {
  scene: SceneState;
  selected: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const { scene, selected } = props;
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const renaming = useStore((s) => s.renaming === scene.id);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selected]);

  return (
    <div
      ref={ref}
      data-scene-card={scene.id}
      role="listitem"
      className={clsx(
        'group relative shrink-0 transition-opacity',
        props.dragging && 'opacity-40',
        props.dropBefore && 'before:absolute before:top-0 before:-left-[22px] before:h-[99px] before:w-1 before:bg-now',
      )}
      style={{ width: CARD_W }}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-cadence-scene', scene.id);
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        selectScene(scene.id);
        props.onMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        aria-label={t.timeline.filmstrip.scene(scene.index + 1, scene.name)}
        aria-current={selected || undefined}
        onClick={() => selectScene(scene.id)}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            e.stopPropagation();
            moveScene(scene.id, e.key === 'ArrowLeft' ? -1 : 1);
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            props.onMenu(rect.left + 12, rect.bottom - 8);
          } else if (e.key === 'F2') {
            e.preventDefault();
            set({ renaming: scene.id });
          }
        }}
        className={clsx(
          'focus-ring relative block w-full overflow-hidden border-2 border-ink bg-wash',
          // The scene in the preview casts the logo's pink.
          selected ? 'shadow-[4px_4px_0_0_var(--color-now)]' : 'shadow-hard-sm hover:shadow-hard',
        )}
        style={{ height: THUMB_H }}
      >
        <Thumb scene={scene} />
        <span
          className={clsx(
            'absolute top-0 left-0 grid h-5 min-w-5 place-items-center px-1 text-xs font-bold',
            selected ? 'bg-now text-ink' : 'bg-ink text-white',
          )}
        >
          {scene.index + 1}
        </span>
      </button>
      <button
        type="button"
        aria-label={t.timeline.filmstrip.actions(scene.name)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          selectScene(scene.id);
          props.onMenu(rect.left, rect.bottom + 4);
        }}
        className="focus-ring absolute top-1.5 right-1.5 grid size-6 place-items-center border-2 border-ink bg-white text-ink opacity-0 group-hover:opacity-100 hover:bg-now focus-visible:opacity-100"
      >
        <MoreHorizontal className="size-4" />
      </button>
      <div className="mt-2 px-0.5">
        <SceneName scene={scene} selected={selected} />
        <SceneDuration scene={scene} />
      </div>
    </div>
  );
}

function moveScene(sceneId: string, direction: -1 | 1): void {
  const ids = get().project?.scenes.map((s) => s.id) ?? [];
  const from = ids.indexOf(sceneId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  void reorderScenes(ids);
}

/** Server thumbnail at the middle of the scene. The previous image stays until the new one has loaded (no flash). */
function Thumb({ scene }: { scene: SceneState }) {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const format = useStore((s) => s.format);
  const epoch = useStore((s) => s.thumbEpoch);
  const version = `${project.codeGeneration}-${scene.codeVersion}-${scene.duration}-${scene.start}-${epoch}`;
  const url = api.thumbnailUrl(project.id, scene.id, format, version);
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live) {
        setShown(url);
        setFailed(false);
      }
    };
    img.onerror = () => live && setFailed(true);
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);

  if (!shown)
    return failed ? (
      <span className="absolute inset-0 grid place-items-center text-xs text-ink-4">{t.timeline.filmstrip.noPreview}</span>
    ) : (
      <span className="skeleton absolute inset-0" />
    );
  return <img src={shown} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />;
}

function SceneName({ scene, selected }: { scene: SceneState; selected: boolean }) {
  const t = useT();
  const renaming = useStore((s) => s.renaming === scene.id);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  if (renaming) {
    const commit = () => {
      const value = input.current?.value ?? '';
      set({ renaming: null });
      void renameScene(scene.id, value).catch(ignore);
    };
    return (
      <input
        ref={input}
        defaultValue={scene.name}
        aria-label={t.timeline.filmstrip.name}
        maxLength={120}
        className="block h-5 w-full bg-white px-1 text-[13px] font-semibold text-ink outline-none ring-2 ring-now"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') set({ renaming: null });
        }}
        onBlur={commit}
      />
    );
  }
  return (
    <span
      className={clsx('block h-5 truncate text-[13px]/5 font-semibold', selected ? 'text-ink' : 'text-ink-2')}
      title={t.timeline.filmstrip.renameHint(scene.name)}
      onDoubleClick={() => set({ renaming: scene.id })}
    >
      {scene.name}
    </span>
  );
}

function SceneDuration({ scene }: { scene: SceneState }) {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const barCount = sceneBars(project, scene);
  const drift = barDrift(project, scene);
  const offGrid = drift === null ? null : t.timeline.sceneDuration.offGrid(secsLabel(Math.abs(drift)), drift < 0);

  useLayoutEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (editing) {
    const commit = () => {
      setEditing(false);
      const value = parseDuration(input.current?.value ?? '', sceneMusic(project, scene).barLength);
      if (Number.isFinite(value) && Math.abs(value - scene.duration) > 0.0005)
        void setSceneDuration(scene.id, value).catch(ignore);
    };
    return (
      <span className="flex h-[18px] items-center gap-0.5">
        <input
          ref={input}
          defaultValue={fieldSecs(scene.duration)}
          aria-label={t.timeline.sceneDuration.input}
          inputMode="decimal"
          className="h-[18px] w-14 bg-white px-1 text-right text-xs text-ink outline-none ring-2 ring-now"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={commit}
        />
        <span className="text-xs text-ink-4">s</span>
      </span>
    );
  }
  return (
    <Tooltip label={offGrid ? t.timeline.sceneDuration.editOffGrid(offGrid) : t.timeline.sceneDuration.edit} side="top">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring -ml-0.5 block h-[18px] px-0.5 text-xs/[18px] text-ink-3 hover:bg-wash hover:text-ink"
        aria-label={t.timeline.sceneDuration.label(secsLabel(scene.duration), bars(barCount), offGrid)}
      >
        {secsLabel(scene.duration)}
        <span className={offGrid ? 'font-semibold text-warn-ink' : 'text-ink-4'}> · {bars(barCount)}</span>
      </button>
    </Tooltip>
  );
}

// Seams

function SeamBadge({ from, to, result }: { from: SceneState; to: SceneState; result: SeamResult | undefined }) {
  const t = useT();
  const format = useStore((s) => s.format);
  const control = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tone = seamTone(result);
  const label = !result ? (
    '·'
  ) : result.error ? (
    '!'
  ) : (
    <>
      {seamShare(result.diffPercent)}
      <span className="text-[0.7em]">%</span>
    </>
  );
  const seams = t.timeline.seams;
  const title = !result
    ? seams.unchecked(from.name, to.name)
    : result.error
      ? seams.checkFailed(result.error)
      : seams.changed(
          percent(result.diffPercent),
          from.name,
          to.name,
          tone === 'clean' ? seams.clean : tone === 'jump' ? seams.jump : seams.cut,
        );
  const words = t.timeline.transitions;
  const played = to.transition;
  const clamped = clampedTransition(to);
  const cut = words.control(
    from.name,
    to.name,
    played
      ? words.summary(
          words.kinds[played.kind].toLowerCase(),
          played.direction ? words.directions[played.direction].toLowerCase() : null,
          clamped ? words.clamped(secsExact(clamped.played), secsExact(clamped.declared)) : secsExact(played.duration),
        )
      : words.none.toLowerCase(),
  );
  const Kind = played && KIND_ICONS[played.kind];
  return (
    <div className="flex w-10 shrink-0 flex-col items-center">
      <div className="relative flex w-full justify-center" style={{ height: THUMB_H }}>
        <span className="absolute inset-y-2 left-1/2 -translate-x-1/2 border-l-2 border-dashed border-ink-4" aria-hidden />
        {Kind ? (
          // A transition hides the hard cut the seam check measures; the cut control below says the same.
          <Tooltip label={cut} side="top" className="relative self-center">
            <span
              aria-hidden
              className="relative z-10 flex size-7 items-center justify-center rounded-full border-2 border-ink bg-now text-ink"
            >
              <Kind className="size-3.5" />
            </span>
          </Tooltip>
        ) : (
          <Tooltip label={title} side="top" className="relative self-center">
            <button
              type="button"
              aria-label={title}
              onClick={() => openModal({ kind: 'seam', from: from.id, to: to.id, format })}
              className={clsx(
                'focus-ring relative z-10 flex size-7 items-center justify-center rounded-full border-2 border-ink text-[10px]/none font-bold tracking-tight transition-transform hover:scale-110',
                {
                  unknown: 'bg-white text-ink-3',
                  clean: 'bg-ok text-white',
                  jump: 'bg-warn text-ink',
                  cut: 'bg-alert text-white',
                  error: 'bg-white text-alert',
                }[tone],
              )}
            >
              {label}
            </button>
          </Tooltip>
        )}
      </div>
      <button
        ref={control}
        type="button"
        aria-label={cut}
        aria-haspopup="dialog"
        aria-expanded={menu !== null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4 });
        }}
        className={clsx(
          'focus-ring mt-2 flex h-5 items-center px-1 text-[11px] whitespace-nowrap hover:bg-wash hover:text-ink',
          clamped ? 'font-semibold text-warn-ink' : 'text-ink-3',
        )}
      >
        {played ? secsExact(played.duration) : <Blend className="size-3.5 text-ink-4" aria-hidden />}
      </button>
      {menu && (
        <TransitionMenu
          from={from}
          to={to}
          x={menu.x}
          y={menu.y}
          anchor={control}
          onClose={() => setMenu(null)}
          onDone={() => {
            control.current?.focus();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** The cut's popover: kind, direction and duration, each sent as soon as picked. `onDone` closes it back to the cut control. */
function TransitionMenu(props: {
  from: SceneState;
  to: SceneState;
  x: number;
  y: number;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { to, onDone } = props;
  const t = useT();
  const words = t.timeline.transitions;
  const declared = to.declaredTransition;
  const clamped = clampedTransition(to);
  const directionLabel = useId();
  const durationField = useId();
  const send = (next: SceneTransition | null) => void setTransition(to.id, next).catch(ignore);
  const commitDuration = (input: HTMLInputElement) => {
    const next = editTransition(declared, { duration: parseDecimal(input.value) });
    if (!next) return;
    input.value = fieldSecs(next.duration);
    if (next.duration !== declared?.duration) send(next);
  };

  return (
    <Popover
      role="dialog"
      label={words.dialog(props.from.name, to.name)}
      x={props.x}
      y={props.y}
      anchor={props.anchor}
      focus='[aria-pressed="true"]'
      onClose={props.onClose}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <div role="group" aria-label={words.kind}>
        {([null, ...TRANSITION_KINDS] as const).map((kind) => {
          const Icon = kind ? KIND_ICONS[kind] : Scissors;
          const on = (declared?.kind ?? null) === kind;
          return (
            <button
              key={kind ?? 'none'}
              type="button"
              aria-pressed={on}
              className={clsx(MENU_ITEM, on && 'bg-wash')}
              onClick={() => {
                if (!on) send(kind && editTransition(declared, { kind }));
                if (!kind) onDone();
              }}
            >
              <Icon className="size-4 text-ink-3" aria-hidden /> {kind ? words.kinds[kind] : words.none}
              {on && <Check className="ml-auto size-4" aria-hidden />}
            </button>
          );
        })}
      </div>
      {declared && (
        <>
          <div className="my-1 h-px bg-rule" />
          {declared.kind !== 'fade' && (
            <div role="group" aria-labelledby={directionLabel} className="flex items-center gap-0.5 px-2.5 py-1">
              <span id={directionLabel} className="mr-auto text-xs text-ink-3">
                {words.direction}
              </span>
              {TRANSITION_DIRECTIONS.map((direction) => {
                const Icon = DIRECTION_ICONS[direction];
                const on = declared.direction === direction;
                return (
                  <button
                    key={direction}
                    type="button"
                    aria-label={words.directions[direction]}
                    aria-pressed={on}
                    className={clsx(
                      'focus-ring grid size-7 place-items-center border-2 text-ink',
                      on ? 'border-ink bg-now' : 'border-transparent hover:bg-wash',
                    )}
                    onClick={() => !on && send(editTransition(declared, { direction }))}
                  >
                    <Icon className="size-4" aria-hidden />
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 px-2.5 py-1">
            <label htmlFor={durationField} className="mr-auto text-xs text-ink-3">
              {words.duration}
            </label>
            <input
              id={durationField}
              defaultValue={fieldSecs(declared.duration)}
              inputMode="decimal"
              className="h-6 w-14 bg-white px-1 text-right text-xs text-ink ring-2 ring-rule outline-none focus:ring-now"
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDuration(e.currentTarget);
                // The blur that follows closing must find nothing to send.
                if (e.key === 'Escape') e.currentTarget.value = fieldSecs(declared.duration);
              }}
              onBlur={(e) => commitDuration(e.currentTarget)}
            />
          </div>
          {clamped && (
            <p className="px-2.5 pt-0.5 pb-1.5 text-xs/4 text-warn-ink">
              {words.clampedNote(secsExact(clamped.played), secsExact(clamped.declared))}
            </p>
          )}
        </>
      )}
    </Popover>
  );
}

// Context menu

function SceneMenu({ scene, x, y, onClose }: { scene: SceneState; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };

  const single = (get().project?.scenes.length ?? 0) <= 1;
  const run = (fn: () => unknown) => () => {
    onClose();
    fn();
  };

  return (
    <Popover
      role="menu"
      label={t.timeline.sceneMenu.label(scene.name)}
      x={x}
      y={y}
      focus='[role="menuitem"]'
      onClose={onClose}
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(() => set({ renaming: scene.id }))}>
        <Pencil className="size-4 text-ink-3" /> {t.timeline.sceneMenu.rename}
        <span className="ml-auto font-mono text-[11px] text-ink-3">F2</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={run(() => void duplicateScene(scene.id).catch(ignore))}
      >
        <CopyPlus className="size-4 text-ink-3" /> {t.timeline.sceneMenu.duplicate}
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={run(() => void copyText(scene.file, t.timeline.sceneMenu.pathCopied))}
      >
        <Copy className="size-4 text-ink-3" /> {t.timeline.sceneMenu.copyPath}
      </button>
      <div className="my-1 h-px bg-rule" />
      <button
        type="button"
        role="menuitem"
        disabled={single}
        title={single ? t.timeline.sceneMenu.lastScene : undefined}
        className={clsx(
          MENU_ITEM,
          confirming ? 'bg-alert text-white hover:bg-alert/90 focus:bg-alert/90' : 'text-alert disabled:text-ink-4',
        )}
        onClick={() => {
          if (!confirming) return setConfirming(true);
          onClose();
          void deleteScene(scene.id).catch(ignore);
        }}
      >
        <Trash2 className={clsx('size-4', confirming ? 'text-white' : 'text-alert')} />
        {confirming ? t.timeline.sceneMenu.confirmDelete : t.timeline.sceneMenu.delete}
      </button>
    </Popover>
  );
}

/**
 * A panel opened at (x, y) that focuses its first `focus` match, keeps keys to itself and closes on a press outside it.
 * A press on `anchor`, the control it opens from, is not outside: that control's own click closes it.
 */
function Popover(props: {
  role: 'menu' | 'dialog';
  label: string;
  x: number;
  y: number;
  anchor?: RefObject<HTMLElement | null>;
  focus: string;
  onClose: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const { x, y, anchor, focus, onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep the panel inside the window (it usually opens near the bottom edge). Too tall for below y, it grows upwards
    // from y, or from above its anchor so that it does not cover it.
    const left = Math.min(x, innerWidth - rect.width - 8);
    const above = anchor?.current ? anchor.current.getBoundingClientRect().top - 4 : y;
    setPos(y + rect.height > innerHeight - 8 ? { left, bottom: innerHeight - above } : { left, top: y });
    panel.current?.querySelector<HTMLElement>(focus)?.focus();
  }, [x, y, anchor, focus]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      // A field left by a press outside commits as on any blur, before the panel goes. A press on the anchor too: Safari
      // and Firefox do not focus a pressed button, so the field would keep the focus until the anchor's click closes it.
      if (panel.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (!anchor?.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panel}
      role={props.role}
      aria-label={props.label}
      onKeyDown={(e) => {
        e.stopPropagation();
        props.onKeyDown(e);
      }}
      className="fixed z-60 w-56 animate-pop-in border-2 border-ink bg-white p-1 shadow-float"
      style={pos}
    >
      {props.children}
    </div>,
    document.body,
  );
}
