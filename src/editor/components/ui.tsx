// Small UI kit of the editor: buttons, segmented controls, modals, popovers, tooltips, inline confirmations.
import clsx from 'clsx';
import { ChevronDown, Loader2, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

// Buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'xs' | 'sm' | 'md' | 'lg';

/** Framed buttons are keys (ink frame, printed shadow, Anton capitals); ghost and subtle ones are quiet labels. */
const VARIANTS: Record<Variant, string> = {
  primary: 'press border-2 border-ink bg-now text-ink hover:bg-now/85 disabled:border-track disabled:bg-wash disabled:text-ink-4',
  secondary: 'press border-2 border-ink bg-white text-ink hover:bg-wash disabled:border-track disabled:text-ink-4',
  ghost: 'text-ink-2 hover:bg-wash hover:text-ink active:bg-track disabled:text-ink-4',
  // A toggle that is on: an ink key, pushed in.
  subtle: 'press border-2 border-ink bg-ink text-white',
  danger: 'press border-2 border-ink bg-alert text-white hover:bg-alert/90 disabled:opacity-50',
};

const KEYS = new Set<Variant>(['primary', 'secondary', 'danger']);

const SIZES: Record<Size, string> = {
  xs: 'h-6 px-1.5 gap-1',
  sm: 'h-7 px-2.5 gap-1.5',
  md: 'h-8 px-3 gap-1.5',
  lg: 'h-10 px-4 gap-2',
};

/** Keys print their label in Anton capitals; quiet buttons in small tracked capitals. */
const TEXT: Record<Size, [key: string, quiet: string]> = {
  xs: ['display-caps text-[13px]', 'label-caps text-[11px]'],
  sm: ['display-caps text-sm', 'label-caps text-[11px]'],
  md: ['display-caps text-[15px]', 'label-caps text-xs'],
  lg: ['display-caps text-[17px]', 'label-caps text-[13px]'],
};

/** Icon-only sizes: a separate map, because two padding utilities on one element resolve by stylesheet order. */
const SQUARES: Record<Size, string> = {
  xs: 'size-6',
  sm: 'size-7',
  md: 'size-8',
  lg: 'size-10',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Icon only: square, no horizontal padding. */
  square?: boolean;
  icon?: ReactNode;
  loading?: boolean;
  ref?: RefObject<HTMLButtonElement | null>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  square,
  icon,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'focus-ring inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none [&>svg]:shrink-0',
        VARIANTS[variant],
        square ? SQUARES[size] : [SIZES[size], TEXT[size][KEYS.has(variant) ? 0 : 1]],
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Accessible name, also shown as a tooltip. */
  label: string;
  tooltip?: boolean;
  side?: 'top' | 'bottom';
  active?: boolean;
}

export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  tooltip = true,
  side = 'bottom',
  active,
  className,
  ...rest
}: IconButtonProps) {
  const button = (
    <Button
      {...rest}
      variant={active ? 'subtle' : variant}
      size={size}
      square
      aria-label={label}
      aria-pressed={active}
      icon={icon}
      className={className}
    />
  );
  return tooltip ? (
    <Tooltip label={label} side={side}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin text-ink-4', className ?? 'size-4')} aria-hidden />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-5 min-w-5 items-center justify-center border border-ink bg-white px-1 font-mono text-[11px] font-medium text-ink shadow-[1px_1px_0_0_var(--color-ink)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The agent at work: the logo's three clips light up one per beat, at the project tempo (held to 90-140 BPM). */
export function BeatPills({ tempo, className }: { tempo?: number; className?: string }) {
  const bpm = Math.min(140, Math.max(90, tempo ?? 120));
  return (
    <span
      aria-hidden
      className={clsx('beat-pills inline-flex w-3.5 shrink-0 flex-col gap-0.5', className)}
      style={{ '--beat': `${(60 / bpm).toFixed(3)}s` } as CSSProperties}
    >
      <span className="h-[3px] w-2 rounded-full bg-current" />
      <span className="ml-1 h-[3px] w-2.5 rounded-full bg-now" />
      <span className="ml-0.5 h-[3px] w-[7px] rounded-full bg-current" />
    </span>
  );
}

// Segmented control

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
  disabled?: boolean;
}

/**
 * A row of toggle buttons (aria-pressed), not a radio group: arrow keys stay free for the transport (frame stepping),
 * Tab moves between segments. `keys`: deck keys, the one on is pushed in (ink, or pink with `accent` for the view the
 * editor is in). `tabs`: folder tabs standing on the ink line below them, the open one merges with the panel.
 */
export function Segmented<T extends string>(props: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
  look?: 'keys' | 'tabs';
  accent?: boolean;
  className?: string;
  stretch?: boolean;
}) {
  const { value, options, onChange, label, size = 'md', look = 'keys', accent, className, stretch } = props;
  const tabs = look === 'tabs';
  return (
    <div
      role="group"
      aria-label={label}
      className={clsx(tabs ? 'flex items-end gap-1' : 'inline-flex items-center gap-1.5', stretch && 'flex w-full', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.title}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={clsx(
              'focus-ring display-caps inline-flex items-center justify-center gap-1.5 border-2 border-ink whitespace-nowrap select-none disabled:text-ink-4',
              // Six side-panel tabs share 324 px below xl: each takes its label's width, plus an equal share of the rest.
              stretch && (tabs ? 'min-w-0 flex-auto' : 'min-w-0 flex-1'),
              tabs
                ? [
                    '-mb-0.5 h-8 px-1 text-[13px] xl:px-2.5 xl:text-[15px]',
                    active
                      ? 'border-b-paper bg-paper text-ink shadow-[inset_0_3px_0_0_var(--color-now)]'
                      : 'bg-wash text-ink-3 hover:bg-white hover:text-ink',
                  ]
                : [
                    'press',
                    size === 'sm' ? 'h-6 px-2 text-[13px]' : 'h-7 px-2.5 text-[15px]',
                    active
                      ? accent
                        ? 'bg-now text-ink'
                        : 'bg-ink text-white'
                      : 'bg-white text-ink-2 hover:bg-wash hover:text-ink',
                  ],
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// Tooltip

/** Hover/focus tooltip rendered in a portal (never clipped by scroll containers). */
export function Tooltip(props: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom'; className?: string }) {
  const { label, children, side = 'bottom' } = props;
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const id = useId();
  // Centered under its anchor but kept inside the window: by the right edge, the box would shrink to the space left.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!pos || !el) return;
    const half = el.offsetWidth / 2;
    el.style.left = `${Math.min(Math.max(pos.x, half + 8), window.innerWidth - half - 8)}px`;
  }, [pos, label]);
  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPos({ x: rect.left + rect.width / 2, y: side === 'bottom' ? rect.bottom + 6 : rect.top - 6 });
  };
  return (
    <span
      ref={anchor}
      className={clsx('inline-flex', props.className)}
      onPointerEnter={show}
      onPointerLeave={() => setPos(null)}
      // Keyboard focus only: a clicked button keeps focus, and its tooltip would cover what the click opened.
      onFocus={(e) => (e.target as HTMLElement).matches(':focus-visible') && show()}
      onBlur={() => setPos(null)}
      onPointerDown={() => setPos(null)}
      aria-describedby={pos ? id : undefined}
    >
      {children}
      {pos &&
        createPortal(
          <span
            ref={tip}
            id={id}
            role="tooltip"
            style={{ left: pos.x, top: pos.y }}
            className={clsx(
              'pointer-events-none fixed z-[70] w-max max-w-64 -translate-x-1/2 animate-fade-in bg-ink px-2 py-1 text-center text-xs/4 font-medium text-white',
              side === 'top' && '-translate-y-full',
            )}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}

// Popover

/** Closes on outside pointer-down and Escape; `anchor` is the element the popover hangs from. */
export function usePopover(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      (anchor.current?.querySelector('button') ?? anchor.current)?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, anchor, panel]);
}

export function Popover(props: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
  label?: string;
}) {
  const { open, onClose, trigger, children, align = 'start', side = 'bottom', className, label } = props;
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  usePopover(anchor, panel, open, onClose);
  return (
    <div ref={anchor} className="relative inline-flex">
      {trigger}
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          className={clsx(
            'absolute z-40 animate-pop-in border-2 border-ink bg-white shadow-float',
            align === 'start' ? 'left-0' : 'right-0',
            side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Modal

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  bodyClassName?: string;
  /** Element focused on open (defaults to the first field or button of the body). */
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const { title, subtitle, onClose, children, footer, width = 'max-w-lg', bodyClassName, initialFocus } = props;
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const body = dialog.current?.querySelector<HTMLElement>('[data-modal-body]');
    const target =
      initialFocus?.current ??
      body?.querySelector<HTMLElement>('input, textarea, select') ??
      body?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? dialog.current)?.focus();
    return () => previous?.focus?.();
    // Once, when the dialog opens: focus goes back where it was when it closes.
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    // Keep Tab inside the dialog.
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-ink/40 p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={clsx(
          'flex max-h-[calc(100vh-3rem)] w-full animate-pop-in flex-col overflow-hidden border-2 border-ink bg-paper shadow-modal outline-none',
          width,
        )}
      >
        <header className="flex items-start gap-3 border-b-2 border-ink bg-white px-5 pt-4 pb-3.5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="display-caps text-xl text-ink">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
          </div>
          <IconButton
            label={t.common.close}
            icon={<X className="size-4" />}
            size="sm"
            tooltip={false}
            onClick={onClose}
            className="-mt-0.5 -mr-1.5"
          />
        </header>
        <div data-modal-body className={clsx('min-h-0 flex-1 overflow-y-auto', bodyClassName ?? 'px-5 py-4')}>
          {children}
        </div>
        {footer && <footer className="flex items-center gap-2 border-t-2 border-ink bg-white px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// Inline confirmation

/** First click arms it (red, for 4 s), second click runs it. No blocking dialog for reversible-but-costly actions. */
export function ConfirmButton(props: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<unknown>;
  icon?: ReactNode;
  size?: Size;
  variant?: Variant;
  className?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  /** Show the label from the xl breakpoint only (narrow side panels). */
  compact?: boolean;
}) {
  const { label, confirmLabel, onConfirm, icon, size = 'sm', variant = 'ghost', className, disabled, iconOnly, compact } = props;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const run = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      // already reported
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  return (
    <Button
      size={size}
      variant={armed ? 'danger' : variant}
      icon={icon}
      loading={busy}
      disabled={disabled}
      onClick={run}
      onBlur={() => setArmed(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation();
          setArmed(false);
        }
      }}
      aria-label={armed ? confirmLabel : label}
      title={compact || iconOnly ? label : undefined}
      square={iconOnly && !armed}
      className={className}
    >
      {armed ? confirmLabel : iconOnly ? null : compact ? <span className="hidden xl:inline">{label}</span> : label}
    </Button>
  );
}

// Fields

/** Field look without size: combine it with a height, a width and a text size (two utilities of one property conflict). */
export const fieldBase =
  'border-2 border-ink bg-white px-2.5 text-ink placeholder:text-ink-4 outline-none focus:border-now disabled:border-track disabled:bg-wash disabled:text-ink-4';
export const inputClass = `${fieldBase} h-8 w-full text-[13px]`;

export function Field(props: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={clsx('flex flex-col gap-1.5', props.className)}>
      <label htmlFor={props.htmlFor} className="label-caps text-[11px] text-ink-2">
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="text-xs text-ink-3">{props.hint}</p>}
    </div>
  );
}

export function Select({
  className,
  children,
  quiet,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { className?: string; quiet?: boolean }) {
  return (
    <span className={clsx('relative inline-flex', className)}>
      <select
        {...rest}
        className={clsx(
          'focus-ring h-7 w-full appearance-none border-2 py-0 pr-7 pl-2 text-[13px] font-semibold text-ink disabled:text-ink-4',
          quiet
            ? 'border-transparent bg-transparent hover:bg-wash'
            : 'border-ink bg-white disabled:border-track disabled:bg-wash',
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-ink" aria-hidden />
    </span>
  );
}

export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={clsx('flex items-start gap-2.5 select-none', props.disabled && 'opacity-50', props.className)}>
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        className="focus-ring mt-0.5 size-4 shrink-0 accent-ink"
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink">{props.label}</span>
        {props.description && <span className="mt-0.5 block text-xs text-ink-3">{props.description}</span>}
      </span>
    </label>
  );
}

/** A fader: the value follows the drag, onRelease fires once the pointer, a key or the focus lets go. */
export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange: (value: number) => void;
  onRelease: () => void;
}) {
  const fill = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <input
      type="range"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      aria-label={props.label}
      onChange={(e) => props.onChange(Number(e.target.value))}
      onPointerUp={props.onRelease}
      onKeyUp={props.onRelease}
      onBlur={props.onRelease}
      // WebKit has no part for the slot's filled side: the stylesheet inks the track up to --fill.
      style={{ '--fill': `${fill}%` } as CSSProperties}
      className="focus-ring w-full min-w-0 flex-1"
    />
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="display-caps text-[15px] text-ink">{children}</h3>
      {action}
    </div>
  );
}

export function EmptyState(props: { icon: ReactNode; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-10 text-center', props.className)}>
      <div className="mb-3 text-ink-3">{props.icon}</div>
      <p className="display-caps text-base text-ink">{props.title}</p>
      {props.children && <div className="mt-1 max-w-72 text-[13px] text-ink-3">{props.children}</div>}
    </div>
  );
}

/** Tiny aspect-ratio glyph for a format id ("16:9" draws a wide rectangle). */
export function FormatGlyph({ format, className }: { format: string; className?: string }) {
  const [w, h] = format.split(':').map(Number);
  const scale = 12 / Math.max(w, h);
  return (
    <span
      aria-hidden
      className={clsx('inline-block shrink-0 border-[1.5px] border-current', className)}
      style={{ width: Math.round(w * scale) + 1, height: Math.round(h * scale) + 1 }}
    />
  );
}
