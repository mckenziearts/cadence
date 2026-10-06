// Chat slice: scene and project conversations, streamed over SSE (`chat` = full state, `chat-message` = the running
// reply, `chat-delta` = its text).
import { api, ignore } from '../api';
import {
  agentPicks,
  sceneIdFromChatKey,
  type ChatKey,
  type ChatMessage,
  type ChatState,
  type Effort,
  type ModelSpec,
  type Playhead,
  type Settings,
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

/** The model and effort for a chat scope: the active agent's stored choice, or the catalogue's first model as a default. */
export function resolvePick(
  settings: Settings | undefined,
  models: ModelSpec[],
  scope: ChatKind,
): { model: string; effort: Effort } {
  const base = settings ? agentPicks(settings, scope) : { model: '', effort: 'medium' as Effort };
  const model = base.model && models.some((m) => m.id === base.model) ? base.model : (models[0]?.id ?? base.model);
  const spec = models.find((m) => m.id === model);
  const effort =
    spec?.efforts && !spec.efforts.includes(base.effort) ? (spec.defaultEffort ?? spec.efforts[0] ?? base.effort) : base.effort;
  return { model, effort };
}

export function modelChoice(kind: ChatKind): { model: string; effort: Effort } {
  const s = get();
  return s.picks[kind] ?? resolvePick(s.app?.settings, s.app?.models ?? [], kind);
}

export async function sendMessage(key: ChatKey, text: string): Promise<boolean> {
  const id = get().project?.id;
  if (!id || !text.trim()) return false;
  const { model, effort } = modelChoice(kindOf(key));
  const supportsEffort = get().app?.models.find((m) => m.id === model)?.supportsEffort !== false;
  // A host that hides the choice sets the models in the settings, outside the editor's catalog too: the server runs those.
  const pick = get().app?.features.modelPicker === false ? {} : { model, ...(supportsEffort ? { effort } : {}) };
  try {
    const state = await api.send(id, key, { text: text.trim(), ...pick, playhead: playheadFor(key) });
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
