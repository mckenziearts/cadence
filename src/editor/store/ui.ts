import { get, memory, set, type Modal, type Toast } from '.';
import { t } from '../i18n';

let toastSeq = 0;

export function toast(text: string, tone: Toast['tone'] = 'info', ms = tone === 'error' ? 7000 : 3500): void {
  const id = ++toastSeq;
  // The same message twice in a row (a burst of failing requests) shows once.
  if (get().toasts.some((t) => t.text === text)) return;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openModal(modal: Modal): void {
  set({ modal, playing: false });
}

export function closeModal(): void {
  set({ modal: null });
}

/** A finished brand build its window has shown leaves the top bar, across reloads too (the last 20 are remembered). */
export function markBuildSeen(id: string): void {
  const seen = get().seenBuilds;
  if (seen.includes(id)) return;
  const next = [...seen, id].slice(-20);
  memory.set('seen-builds', next.join(' '));
  set({ seenBuilds: next });
}

/** Copy to the clipboard (127.0.0.1 is a secure context), with a textarea fallback. */
export async function copyText(text: string, done = t().shell.clipboard.copied): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) return toast(t().shell.clipboard.failed, 'error');
  }
  toast(done, 'success', 2200);
}
