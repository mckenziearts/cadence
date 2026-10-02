// Chat slice: scene and project conversations, streamed over SSE (`chat` = full state, `chat-message` = the running
// reply, `chat-delta` = its text).
import { api, ignore } from '../api';
import {
  sceneIdFromChatKey,
  type ChatKey,
  type ChatMessage,
  type ChatState,
  type Effort,
  type Playhead,
} from '../../shared/types';
import { clamp, currentScene, get, set, type ChatKind } from '.';
import { loadCost, selectScene } from './project';

export const kindOf = (key: ChatKey): ChatKind => (key === 'project' ? 'project' : 'scene');

export async function loadChat(key: ChatKey): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  const state = await api.chat(id, key);
  if (get().project?.id === id) applyChat(state);
}

export function applyChat(state: ChatState): void {
  set((s) => ({ chats: { ...s.chats, [state.key]: state } }));
}

export function applyMessage(key: ChatKey, message: ChatMessage): void {
  patchMessage(key, message.id, () => message);
}

export function applyDelta(key: ChatKey, messageId: string, text: string): void {
  patchMessage(key, messageId, (message) => ({ ...message, text: message.text + text }));
}

/** The other messages keep their objects, so their memoized components skip the render. */
function patchMessage(key: ChatKey, messageId: string, patch: (message: ChatMessage) => ChatMessage): void {
  const chat = get().chats[key];
  const index = chat?.messages.findIndex((m) => m.id === messageId) ?? -1;
  if (!chat || index < 0) return;
  const messages = chat.messages.slice();
  messages[index] = patch(messages[index]);
  set((s) => ({ chats: { ...s.chats, [key]: { ...chat, messages } } }));
}

/** What the user is looking at, in the chat's terms (scene-local time for a scene chat). */
export function playheadFor(key: ChatKey): Playhead {
  const s = get();
  const round = (t: number) => Math.round(Math.max(0, t) * 1000) / 1000;
  const sceneId = sceneIdFromChatKey(key);
  if (sceneId) {
    const scene = s.project?.scenes.find((x) => x.id === sceneId);
    const local = s.mode === 'scene' || !scene ? s.time : clamp(s.time - scene.start, 0, scene.duration);
    return { sceneId, t: round(local), format: s.format };
  }
  if (s.mode === 'scene') return { sceneId: currentScene(s)?.id ?? null, t: round(s.time), format: s.format };
  return { sceneId: null, t: round(s.time), format: s.format };
}

export function modelChoice(kind: ChatKind): { model: string; effort: Effort } {
  const s = get();
  const pick = s.picks[kind];
  if (pick) return pick;
  const settings = s.app?.settings;
  return kind === 'scene'
    ? { model: settings?.sceneModel ?? 'claude-opus-5-5', effort: settings?.sceneEffort ?? 'medium' }
    : { model: settings?.projectModel ?? 'claude-opus-5-5', effort: settings?.projectEffort ?? 'high' };
}

export async function sendMessage(key: ChatKey, text: string): Promise<boolean> {
  const id = get().project?.id;
  if (!id || !text.trim()) return false;
  const { model, effort } = modelChoice(kindOf(key));
  const supportsEffort = get().app?.models.find((m) => m.id === model)?.supportsEffort !== false;
  try {
    const state = await api.send(id, key, {
      text: text.trim(),
      model,
      ...(supportsEffort ? { effort } : {}),
      playhead: playheadFor(key),
    });
    // The events may have brought this turn already, even its end: this answer is older then.
    const reply = state.messages.at(-1)?.id;
    const seen = get().chats[key]?.messages.some((m) => m.id === reply);
    if (get().project?.id === id && !seen) applyChat(state);
    return true;
  } catch {
    return false;
  }
}

export function stopChat(key: ChatKey): void {
  const id = get().project?.id;
  if (id) api.stop(id, key).catch(ignore);
}

export async function clearChat(key: ChatKey): Promise<void> {
  const id = get().project?.id;
  if (!id) return;
  const state = await api.clearChat(id, key);
  if (get().project?.id === id) applyChat(state);
  loadCost();
}

/** Put text in a composer (and show that chat). */
export function prefill(key: ChatKey, text: string): void {
  const sceneId = sceneIdFromChatKey(key);
  // Another scene starts from its first frame (the one a seam fix is about); the same scene keeps its playhead.
  if (sceneId && sceneId !== currentScene()?.id) selectScene(sceneId);
  set((s) => ({ panel: sceneId ? 'scene' : 'project', fill: { key, text, nonce: (s.fill?.nonce ?? 0) + 1 } }));
}

const DRAFTS_KEY = 'cadence:drafts';
let draftTimer: ReturnType<typeof setTimeout> | undefined;

export const draftKey = (projectId: string, key: ChatKey) => `${projectId}/${key}`;

export function setDraft(key: ChatKey, text: string): void {
  const id = get().project?.id;
  if (!id) return;
  set((s) => ({ drafts: { ...s.drafts, [draftKey(id, key)]: text } }));
  clearTimeout(draftTimer);
  // Unsent prompts survive reloads: a restarted server reloads the page (Vite client).
  draftTimer = setTimeout(() => {
    try {
      const drafts = Object.fromEntries(Object.entries(get().drafts).filter(([, value]) => value.trim()));
      sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // not kept across reloads, that's all
    }
  }, 300);
}

export function restoreDrafts(): void {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') as unknown;
    if (saved && typeof saved === 'object') set({ drafts: saved as Record<string, string> });
  } catch {
    // nothing to restore
  }
}
