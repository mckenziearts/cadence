// Keyboard rules of the editor that a test can prove without a browser: text fields, the undo keys and their guard.
import type { EditorState } from '../store';

/** Focus in a field that takes text: the browser owns the keys there (Space, arrows, its own undo). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(type);
}

/**
 * Cmd-Z (Ctrl-Z) undoes, with Shift it redoes. The letter comes from `e.key`: `e.code` names the physical key, which
 * an AZERTY layout puts elsewhere. Nothing in a text field, whose typing the browser undoes.
 */
export function undoKey(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z' || isTyping(e.target)) return null;
  return e.shiftKey ? 'redo' : 'undo';
}

/** Undo and redo act on the open project's scenes, never behind a modal or the presentation. */
export function undoAllowed(s: Pick<EditorState, 'project' | 'view' | 'modal' | 'presenting'>): boolean {
  return s.project !== null && s.view === 'scenes' && s.modal === null && !s.presenting;
}

/**
 * Runs `step` unless its previous call is still running, and says whether it ran: a press made meanwhile is dropped, so
 * a held key sends its next request only once the previous one has answered.
 */
export function oneAtATime<A extends unknown[]>(step: (...args: A) => Promise<void>): (...args: A) => Promise<boolean> {
  let running = false;
  return async (...args) => {
    if (running) return false;
    running = true;
    try {
      await step(...args);
      return true;
    } finally {
      running = false;
    }
  };
}
