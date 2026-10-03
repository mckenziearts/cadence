import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentId, AgentStatus } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { useStore } from '../store';
import { setAgent } from '../store/project';
import { AGENTS } from './agents';
import { AGENT_LOGOS } from './logos';

/**
 * Which assistant drives this project or brand. The pick is the one global setting, surfaced at creation and pre-filled
 * with the current agent; agents not wired yet show as "soon", and one Cadence cannot reach stays disabled.
 */
export function AgentPicker() {
  const t = useT();
  const selected = useStore((s) => s.app?.settings.agent ?? 'claude-code');
  const [status, setStatus] = useState<Partial<Record<AgentId, AgentStatus>>>({});

  useEffect(() => {
    api.agentAccounts().then(setStatus, () => undefined);
  }, []);

  return (
    <div className="flex flex-wrap gap-1.5">
      {AGENTS.map((agent) => {
        const Logo = AGENT_LOGOS[agent.id];
        const on = selected === agent.id;
        // Before the status lands, only the current agent is known reachable; soon agents never are.
        const reachable = !agent.soon && (status[agent.id]?.ok ?? on);
        return (
          <button
            key={agent.id}
            type="button"
            aria-pressed={on}
            disabled={on || !reachable}
            onClick={() => void setAgent(agent.id)}
            className={clsx(
              'focus-ring flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium ring-1 ring-inset transition-colors',
              on
                ? 'bg-ink text-white ring-ink'
                : reachable
                  ? 'bg-white text-ink-2 ring-rule hover:ring-track'
                  : 'cursor-not-allowed text-ink-4 ring-rule',
            )}
          >
            <Logo className="size-4" aria-hidden />
            {agent.name}
            {agent.soon && <span className="label-caps text-[10px] text-ink-4">{t.profile.agents.soon}</span>}
            {on && <Check className="ml-0.5 size-3.5" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
