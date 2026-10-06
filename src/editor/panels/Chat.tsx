// Scene and project conversations: messages streamed over SSE, agent activity with the frames it rendered, composer.
import clsx from 'clsx';
import { AlertTriangle, Brain, ChevronRight, Clock, GitCommitVertical, MessageSquarePlus, Square } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_FEATURES,
  EFFORTS,
  sceneIdFromChatKey,
  type ChatActivity,
  type ChatKey,
  type ChatMessage,
  type Effort,
} from '../../shared/types';
import { ignore } from '../api';
import { BeatPills, Button, ConfirmButton, Select } from '../components/ui';
import { useT } from '../i18n';
import { Markdown } from '../lib/markdown';
import { elapsed, secsLabel, usd } from '../lib/format';
import { set, useStore, type ChatKind, NONE } from '../store';
import { clearChat, draftKey, kindOf, loadChat, modelChoice, sendMessage, setDraft, stopChat } from '../store/chat';
import { openModal } from '../store/ui';

export function Chat({ chatKey, header }: { chatKey: ChatKey; header?: ReactNode }) {
  const t = useT();
  const chat = useStore((s) => s.chats[chatKey]);
  const agent = useStore((s) => s.app?.agent);
  // Opening another project empties the chats: the same key (every blank project starts on « titre ») must reload.
  const projectId = useStore((s) => s.project?.id);
  const firstScene = useStore((s) => s.project?.scenes[0]?.id === sceneIdFromChatKey(chatKey));
  const kind = kindOf(chatKey);
  const list = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    stick.current = true;
    if (!useStore.getState().chats[chatKey]) void loadChat(chatKey).catch(ignore);
  }, [chatKey, projectId]);

  // Stay pinned to the bottom while content grows (streamed text, thumbnails loading), unless the user scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    const content = inner.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const messages = chat?.messages ?? [];
  const busy = Boolean(chat?.running || chat?.queued);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {agent && !agent.ok && (
        <div role="alert" className="flex shrink-0 gap-2.5 border-b border-warn/30 bg-warn/8 px-4 py-3 text-[13px] text-warn-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">{t.conversation.chat.agentDown(agent.label)}</p>
            {agent.detail && <p className="mt-0.5 text-warn-ink/90">{agent.detail}</p>}
          </div>
        </div>
      )}
      <div
        ref={list}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div ref={inner} className="flex flex-col gap-4 px-4 py-4">
          {!chat && (
            <div className="space-y-3" aria-label={t.conversation.chat.loading}>
              <div className="skeleton ml-auto h-10 w-2/3" />
              <div className="skeleton h-24 w-full" />
            </div>
          )}
          {chat && messages.length === 0 && <EmptyChat chatKey={chatKey} kind={kind} firstScene={firstScene} />}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage key={m.id} message={m} queued={Boolean(chat?.queued) && i === messages.length - 1} />
            ),
          )}
        </div>
      </div>
      <Composer chatKey={chatKey} kind={kind} busy={busy} queued={Boolean(chat?.queued)} />
    </div>
  );
}

export function ChatHeaderActions({ chatKey }: { chatKey: ChatKey }) {
  const t = useT();
  const chat = useStore((s) => s.chats[chatKey]);
  const busy = Boolean(chat?.running || chat?.queued);
  const empty = !chat || chat.messages.length === 0;
  return (
    <ConfirmButton
      label={t.conversation.chat.newChat}
      confirmLabel={t.conversation.chat.clearConfirm}
      icon={<MessageSquarePlus className="size-3.5" />}
      disabled={busy || empty}
      compact
      onConfirm={() => clearChat(chatKey)}
    />
  );
}

function EmptyChat({ chatKey, kind, firstScene }: { chatKey: ChatKey; kind: ChatKind; firstScene: boolean }) {
  const texts = useT().conversation.chat;
  return (
    <div className="pt-4">
      <div className="mb-5">
        <p className="text-[13px] text-ink-2">{texts.intro[kind]}</p>
      </div>
      <p className="display-caps mb-2 text-[17px] text-ink">{texts.suggestionsTitle}</p>
      <div className="flex flex-col gap-2.5">
        {texts.suggestions[kind]
          // The first scene has no previous scene to match.
          .filter((text) => !(firstScene && text === texts.seamSuggestion))
          .map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => set((s) => ({ fill: { key: chatKey, text, nonce: (s.fill?.nonce ?? 0) + 1 } }))}
              className="focus-ring press border-2 border-ink bg-white px-3 py-2 text-left text-[13px] font-medium text-ink hover:bg-wash"
            >
              {text}
            </button>
          ))}
      </div>
    </div>
  );
}

// Messages

// Memoized: a streamed token changes one message object, and the others then skip the render.
const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  const t = useT();
  const playhead = message.playhead;
  return (
    <div className="flex flex-col items-end gap-1 pl-8">
      <div className="border-2 border-ink bg-white px-3 py-2 text-[14px]/[22px] whitespace-pre-wrap text-ink shadow-hard-sm [overflow-wrap:anywhere]">
        {message.text}
      </div>
      {playhead && (
        <span className="inline-flex items-center gap-1.5 pt-0.5 text-[11px] font-semibold text-ink-3">
          <span
            className="relative h-3 w-0.5 rounded-full bg-now before:absolute before:-top-0.5 before:left-1/2 before:size-1.5 before:-translate-x-1/2 before:rounded-full before:bg-now"
            aria-hidden
          />
          {t.conversation.chat.playheadAt(secsLabel(playhead.t))} · {playhead.format}
        </span>
      )}
    </div>
  );
});

function useElapsedSince(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return iso ? Math.max(0, now - new Date(iso).getTime()) : 0;
}

const AssistantMessage = memo(function AssistantMessage({ message, queued }: { message: ChatMessage; queued: boolean }) {
  const t = useT();
  const models = useStore((s) => s.app?.models);
  const agentName = useStore((s) => s.app?.agent.label);
  const tempo = useStore((s) => s.project?.tempo);
  const { costs } = useStore((s) => s.app?.features ?? DEFAULT_FEATURES);
  const streaming = message.status === 'streaming';
  const activity = message.activity ?? [];
  const notes = message.notes ?? [];
  const since = useElapsedSince(streaming && !queued ? message.createdAt : null);
  const running = activity.findLast((a) => a.status === 'running');
  const model = models?.find((m) => m.id === message.model)?.label ?? message.model;

  return (
    <article className="text-ink-2">
      <p className="label-caps mb-1.5 text-[10px] text-ink-3">{agentName ?? 'Claude'}</p>
      {activity.length > 0 && <Activity items={activity} streaming={streaming} />}
      {notes.length > 0 && <Reasoning notes={notes} />}
      {message.text ? (
        <div className={clsx((activity.length > 0 || notes.length > 0) && 'mt-2.5')}>
          <Markdown text={message.text} />
          {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-caret bg-ink" aria-hidden />}
        </div>
      ) : streaming && queued ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-3">
          <Clock className="size-3.5" aria-hidden />
          {t.conversation.chat.queued}
        </div>
      ) : streaming ? (
        <div
          className={clsx(
            'flex items-center gap-2 text-[13px] text-ink-3',
            (activity.length > 0 || notes.length > 0) && 'mt-2.5',
          )}
        >
          <BeatPills tempo={tempo} className="text-ink" />
          <span className="truncate">
            {running ? t.conversation.chat.working : activity.length ? t.conversation.chat.writing : t.conversation.chat.thinking}
          </span>
          <span className="ml-auto text-xs font-semibold">{elapsed(since)}</span>
        </div>
      ) : null}
      {message.status === 'error' && (
        <div className="mt-2.5 flex gap-2 border-2 border-alert bg-white px-3 py-2 text-[13px] text-alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
          <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message.error ?? t.conversation.chat.failed}</p>
        </div>
      )}
      {!streaming && (
        <footer className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] font-semibold text-ink-3">
          {message.status === 'stopped' && (
            <span className="label-caps bg-ink px-1.5 py-0.5 text-[10px] text-white">{t.conversation.chat.stopped}</span>
          )}
          {message.durationMs !== undefined && <span className="tabular-nums">{elapsed(message.durationMs)}</span>}
          {costs && message.costUsd !== undefined && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{usd(message.costUsd)}</span>
            </>
          )}
          {model && (
            <>
              <span aria-hidden>·</span>
              <span>{model}</span>
            </>
          )}
          {message.versionId && (
            <button
              type="button"
              onClick={() => set({ panel: 'versions', focusVersion: message.versionId ?? null })}
              className="focus-ring ml-auto inline-flex items-center gap-1 border-2 border-ink bg-white px-1.5 font-mono text-[11px] text-ink hover:bg-now"
              title={t.conversation.chat.showVersion}
            >
              <GitCommitVertical className="size-3" aria-hidden />
              {message.versionId}
            </button>
          )}
        </footer>
      )}
    </article>
  );
});

function Activity({ items, streaming }: { items: ChatActivity[]; streaming: boolean }) {
  const texts = useT().conversation.chat.activity;
  const tempo = useStore((s) => s.project?.tempo);
  const [open, setOpen] = useState(false);
  const expanded = open || streaming;
  const images = items.flatMap((a) => a.images ?? []);
  const errors = items.filter((a) => a.status === 'error').length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={expanded}
        disabled={streaming}
        className="focus-ring label-caps -mx-1 flex items-center gap-1 px-1 text-[10px] text-ink-3 hover:text-ink disabled:hover:text-ink-3"
      >
        <ChevronRight className={clsx('size-3.5 transition-transform', expanded && 'rotate-90')} aria-hidden />
        {texts.actions(items.length)}
        {images.length > 0 && ` · ${texts.checkedImages(images.length)}`}
        {errors > 0 && <span className="text-alert"> · {texts.failed(errors)}</span>}
      </button>
      {expanded ? (
        <ol className="mt-1.5 space-y-1">
          {items.map((a) => (
            <li key={a.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className="flex h-5 w-3.5 shrink-0 items-center">
                  {a.status === 'running' ? (
                    <span role="img" aria-label={texts.running}>
                      <BeatPills tempo={tempo} className="text-ink" />
                    </span>
                  ) : a.status === 'error' ? (
                    <span role="img" aria-label={texts.error} className="size-2 bg-alert" />
                  ) : (
                    <span role="img" aria-label={texts.ok} className="size-2 bg-ok" />
                  )}
                </span>
                <span
                  className={clsx(
                    'min-w-0 leading-5 [overflow-wrap:anywhere]',
                    a.status === 'running' ? 'text-ink' : 'text-ink-2',
                  )}
                >
                  {a.label}
                </span>
              </div>
              {a.detail && (
                <pre className="mt-1 ml-5.5 max-h-32 overflow-auto border border-ink bg-white px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-ink-2">
                  {a.detail}
                </pre>
              )}
              {a.images && a.images.length > 0 && <Frames images={a.images} all={images} className="mt-1.5 ml-5.5" />}
            </li>
          ))}
        </ol>
      ) : (
        images.length > 0 && <Frames images={images.slice(-6)} all={images} className="mt-2" />
      )}
    </div>
  );
}

function Frames({ images, all, className }: { images: string[]; all: string[]; className?: string }) {
  const t = useT();
  return (
    <div className={clsx('flex flex-wrap gap-1.5', className)}>
      {images.map((src) => (
        <button
          key={src}
          type="button"
          onClick={() => openModal({ kind: 'lightbox', images: all, index: all.indexOf(src) })}
          className="focus-ring overflow-hidden border-2 border-ink bg-wash transition-transform hover:-translate-y-0.5"
          aria-label={t.conversation.chat.activity.enlarge}
        >
          <img src={src} alt="" loading="lazy" className="h-10 w-auto max-w-24 object-cover" />
        </button>
      ))}
    </div>
  );
}

function Reasoning({ notes }: { notes: string[] }) {
  const t = useT();
  return (
    <details className="group mt-2 border-2 border-ink bg-white">
      <summary className="focus-ring label-caps flex list-none items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
        <Brain className="size-3.5" aria-hidden />
        {t.conversation.chat.reasoning}
        <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <div className="space-y-2 border-t border-rule px-2.5 py-2 text-xs text-ink-2">
        {notes.map((note, i) => (
          <Markdown key={i} text={note} />
        ))}
      </div>
    </details>
  );
}

// Composer

function Composer({ chatKey, kind, busy, queued }: { chatKey: ChatKey; kind: ChatKind; busy: boolean; queued: boolean }) {
  const t = useT();
  const texts = t.conversation.chat.composer;
  const draft = useStore((s) => (s.project ? (s.drafts[draftKey(s.project.id, chatKey)] ?? '') : ''));
  const tempo = useStore((s) => s.project?.tempo);
  const fill = useStore((s) => s.fill);
  const models = useStore((s) => s.app?.models ?? NONE);
  const language = useStore((s) => s.language);
  const { modelPicker } = useStore((s) => s.app?.features ?? DEFAULT_FEATURES);
  // Select stable pieces; modelChoice() builds a fresh object.
  useStore((s) => s.picks[kind]);
  useStore((s) => s.app?.settings);
  const choice = modelChoice(kind);
  const area = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const spec = models.find((m) => m.id === choice.model);

  useEffect(() => {
    if (!fill || fill.key !== chatKey) return;
    setDraft(chatKey, fill.text);
    set({ fill: null });
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [fill, chatKey]);

  // Grow with the text up to a cap.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, Math.max(76, el.scrollHeight))}px`;
  }, [draft]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || sending) return;
    setSending(true);
    setDraft(chatKey, '');
    const ok = await sendMessage(chatKey, text);
    setSending(false);
    if (!ok) setDraft(chatKey, text);
  };

  const pick = (patch: Partial<{ model: string; effort: Effort }>) =>
    set((s) => ({ picks: { ...s.picks, [kind]: { ...choice, ...patch } } }));

  return (
    <div className="shrink-0 border-t-2 border-ink bg-paper p-3">
      {queued && (
        <p className="mb-2.5 flex items-center gap-2 border-2 border-ink bg-white px-3 py-2 text-[13px] text-ink-2">
          <BeatPills tempo={tempo} className="text-ink" />
          {texts.waiting}
        </p>
      )}
      <div className="border-2 border-ink bg-white shadow-hard focus-within:shadow-[3px_3px_0_0_var(--color-now)]">
        <textarea
          ref={area}
          value={draft}
          onChange={(e) => setDraft(chatKey, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          aria-label={texts.label[kind]}
          placeholder={texts.placeholder[kind]}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[14px]/[22px] text-ink outline-none placeholder:text-ink-4"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {modelPicker && (
            <>
              <Select
                aria-label={texts.model}
                quiet
                value={choice.model}
                onChange={(e) => {
                  const next = models.find((m) => m.id === e.target.value);
                  pick({ model: e.target.value, effort: next?.defaultEffort ?? next?.efforts?.[0] ?? choice.effort });
                }}
                className="w-[104px]"
              >
                {!spec && choice.model && <option value={choice.model}>{choice.model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint[language]}>
                    {m.label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={texts.effort}
                quiet
                value={spec?.supportsEffort === false ? '' : choice.effort}
                disabled={spec?.supportsEffort === false}
                onChange={(e) => pick({ effort: e.target.value as Effort })}
                className="w-[132px]"
                title={spec?.supportsEffort === false ? texts.noEffort(spec.label) : texts.effortHint}
              >
                {spec?.supportsEffort === false && <option value="">{texts.effortNone}</option>}
                {(spec?.efforts ?? EFFORTS).map((effort) => (
                  <option key={effort} value={effort}>
                    {t.common.efforts[effort]}
                  </option>
                ))}
              </Select>
            </>
          )}
          <span className="ml-auto hidden font-mono text-[11px] text-ink-3 xl:inline">⌘↵</span>
          {busy ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Square className="size-3 fill-current" />}
              onClick={() => stopChat(chatKey)}
            >
              {texts.stop}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              loading={sending}
              disabled={!draft.trim()}
              onClick={() => void send()}
              className="ml-auto xl:ml-0"
            >
              {texts.send}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
