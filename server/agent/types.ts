import type { ChatKey, ChatMessage, UsageCount } from '../../src/shared/types';

export type { AgentEvent, AgentProvider, AgentTurn } from '../contracts';

/** A chat as persisted in projects/<id>/.cadence/chats/<key>.json. */
export interface ChatFile {
  key: ChatKey;
  /** Claude Code session this chat resumes; null until the first turn starts one. */
  sessionId: string | null;
  /** Hash of the brand notes + art direction already sent in this session (they are resent when they change). */
  briefHash: string | null;
  messages: ChatMessage[];
  /** The session's running totals as its last run reported them: the next resumed run records only what it adds. */
  sessionUsage?: UsageCount;
}
