import { AGENT_NAMES, DEFAULT_FEATURES, agentName, type AgentId } from '../../shared/types';
import { useStore } from '../store';

export type AgentSpec = {
  id: AgentId;
  name: string;
  cli: string;
  installCmd: string;
  loginCmd: string;
  docs: string;
  soon?: boolean;
};

/** The assistants Cadence can drive, each through its own CLI. claude-code and codex are wired; the rest land later. */
export const AGENTS: AgentSpec[] = [
  {
    id: 'claude-code',
    name: AGENT_NAMES['claude-code'],
    cli: 'claude',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude',
    docs: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  {
    id: 'codex',
    name: AGENT_NAMES.codex,
    cli: 'codex',
    installCmd: 'npm install -g @openai/codex',
    loginCmd: 'codex login',
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'grok',
    name: AGENT_NAMES.grok,
    cli: 'grok',
    installCmd: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    loginCmd: 'grok',
    docs: 'https://docs.x.ai/build/overview',
    soon: true,
  },
  {
    id: 'gemini',
    name: AGENT_NAMES.gemini,
    cli: 'gemini',
    installCmd: 'npm install -g @google/gemini-cli',
    loginCmd: 'gemini',
    docs: 'https://github.com/google-gemini/gemini-cli',
    soon: true,
  },
];

/** The active agent's name for the texts, or null when the host hides the agent choice (the texts then say "our AI"). */
export function useAgentName(): string | null {
  return useStore((s) => agentName(s.app?.settings.agent ?? 'claude-code', s.app?.features ?? DEFAULT_FEATURES));
}

/** Claude Code's own hints (its subscription, its dollar costs) show only while it runs and the texts may name it. */
export const useClaudeCodeHints = () => useAgentName() === AGENT_NAMES['claude-code'];
