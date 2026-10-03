import type { AgentId } from '../../src/shared/types';
import type { AgentProvider, SettingsStore } from '../contracts';
import type { AgentEvent, AgentTurn } from './types';

/**
 * Picks the provider named by settings.agent for each turn, so the chat and brand builds follow the assistant chosen in
 * the Profile. Providers with no running integration (or an unknown id) fall back to Claude Code.
 */
export class RoutingProvider implements AgentProvider {
  readonly id = 'router';
  readonly label = 'Agent';

  constructor(
    private providers: Partial<Record<AgentId, AgentProvider>>,
    private settings: SettingsStore,
    private fallback: AgentId,
  ) {}

  private async pick(): Promise<AgentProvider> {
    const { agent } = await this.settings.get();
    return this.providers[agent] ?? this.providers[this.fallback]!;
  }

  async status() {
    return (await this.pick()).status();
  }

  async *run(turn: AgentTurn): AsyncGenerator<AgentEvent> {
    yield* (await this.pick()).run(turn);
  }
}
