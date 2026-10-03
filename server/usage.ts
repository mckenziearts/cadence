import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_IDS,
  type AgentId,
  type UsageCount,
  type UsageEntry,
  type UsageSummary,
  type UsageTokens,
  type UsageTotals,
} from '../src/shared/types';
import type { CadenceConfig, UsageLog } from './contracts';
import { m } from './i18n';

export const NO_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TOKEN_KEYS = Object.keys(NO_TOKENS) as (keyof UsageTokens)[];
const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * What a run added to its session. Claude Code reports running totals and starts a resumed session from the totals it
 * saved, so a resumed run subtracts what the previous run of the session reported.
 */
export function addedSince(totals: UsageCount, before: UsageCount | undefined): UsageCount {
  if (!before) return totals;
  const tokens = { ...NO_TOKENS };
  for (const key of TOKEN_KEYS) tokens[key] = Math.max(0, totals.tokens[key] - before.tokens[key]);
  return { costUsd: roundUsd(Math.max(0, totals.costUsd - before.costUsd)), tokens };
}

/** Every Claude Code run Cadence starts, one JSON line each in <root>/.cadence/usage.jsonl (append only). */
export class FileUsageLog implements UsageLog {
  private file: string;

  constructor(config: CadenceConfig) {
    this.file = path.join(config.stateDir, 'usage.jsonl');
  }

  async record(entry: UsageEntry): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      // One small write in append mode per line: runs that end together never mix their lines.
      await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`);
    } catch (e) {
      console.error(m().core.usage.notSaved, e);
    }
  }

  async summary(agent?: AgentId): Promise<UsageSummary> {
    const text = await fs.readFile(this.file, 'utf8').catch(() => '');
    const totals = { chat: emptyTotals(), brand: emptyTotals() };
    let since: string | null = null;
    for (const line of text.split('\n')) {
      const entry = parseLine(line);
      if (!entry) continue;
      if (agent && entry.agent !== agent) continue;
      since ??= entry.at;
      const sum = totals[entry.kind];
      sum.runs += 1;
      sum.costUsd = roundUsd(sum.costUsd + entry.costUsd);
      for (const key of TOKEN_KEYS) sum.tokens[key] += entry.tokens[key];
    }
    return { since, chats: totals.chat, brands: totals.brand };
  }
}

function emptyTotals(): UsageTotals {
  return { runs: 0, costUsd: 0, tokens: { ...NO_TOKENS } };
}

/** The file is append only: a line cut by a crash, or edited by hand, is skipped. */
function parseLine(line: string): UsageEntry | null {
  try {
    const entry = JSON.parse(line) as UsageEntry;
    const known = entry.kind === 'chat' || entry.kind === 'brand';
    if (!known || typeof entry.costUsd !== 'number' || !TOKEN_KEYS.every((key) => typeof entry.tokens?.[key] === 'number')) {
      return null;
    }
    // Lines written before usage was tracked per agent are Claude Code's.
    if (!AGENT_IDS.includes(entry.agent)) entry.agent = 'claude-code';
    return entry;
  } catch {
    return null;
  }
}
