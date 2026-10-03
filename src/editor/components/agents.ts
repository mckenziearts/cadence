import type { AgentId } from '../../shared/types';

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
    name: 'Claude Code',
    cli: 'claude',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude',
    docs: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  {
    id: 'codex',
    name: 'Codex',
    cli: 'codex',
    installCmd: 'npm install -g @openai/codex',
    loginCmd: 'codex login',
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'grok',
    name: 'Grok',
    cli: 'grok',
    installCmd: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    loginCmd: 'grok',
    docs: 'https://docs.x.ai/build/overview',
    soon: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    cli: 'gemini',
    installCmd: 'npm install -g @google/gemini-cli',
    loginCmd: 'gemini',
    docs: 'https://github.com/google-gemini/gemini-cli',
    soon: true,
  },
];
