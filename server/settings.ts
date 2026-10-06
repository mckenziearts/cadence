import path from 'node:path';
import {
  AGENT_IDS,
  EFFORTS,
  MODEL_ID_PATTERN,
  type AgentId,
  type AgentPrefs,
  type DefaultVoice,
  type Effort,
  type Settings,
} from '../src/shared/types';
import type { CadenceConfig, SettingsStore } from './contracts';
import { isLanguage, m, setLanguage } from './i18n';
import { HttpError, KeyedMutex, readJsonOr, writeJsonAtomic } from './util';
import { ELEVENLABS_MODEL_PATTERN, ELEVENLABS_VOICE_PATTERN } from './voiceover/elevenlabs';

const PREF_FIELDS = ['sceneModel', 'sceneEffort', 'projectModel', 'projectEffort'] as const;

/** Global editor settings in <root>/.cadence/settings.json; missing or invalid values fall back to the config defaults. */
export class FileSettingsStore implements SettingsStore {
  private file: string;
  private mutex = new KeyedMutex();

  constructor(private config: CadenceConfig) {
    this.file = path.join(config.stateDir, 'settings.json');
  }

  async get(): Promise<Settings> {
    const stored = await readJsonOr<Partial<Settings>>(this.file, {});
    const defaultVoice = cleanDefaultVoice(stored.defaultVoice);
    const defaults: Settings = {
      sceneModel: this.config.defaultModel,
      sceneEffort: this.config.defaultEffort,
      projectModel: this.config.defaultModel,
      projectEffort: 'high',
      language: null,
      agent: 'claude-code',
    };
    return {
      sceneModel: isModel(stored.sceneModel) ? stored.sceneModel : defaults.sceneModel,
      sceneEffort: isEffort(stored.sceneEffort) ? stored.sceneEffort : defaults.sceneEffort,
      projectModel: isModel(stored.projectModel) ? stored.projectModel : defaults.projectModel,
      projectEffort: isEffort(stored.projectEffort) ? stored.projectEffort : defaults.projectEffort,
      language: isLanguage(stored.language) ? stored.language : defaults.language,
      agent: isAgent(stored.agent) ? stored.agent : defaults.agent,
      agentPrefs: cleanPrefs(stored.agentPrefs),
      // Absent for Piper: the files written before this setting read as they did.
      ...(defaultVoice ? { defaultVoice } : {}),
    };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    for (const key of ['sceneModel', 'projectModel'] as const) {
      if (patch[key] !== undefined && !isModel(patch[key])) throw new HttpError(400, m().core.settings.model(patch[key]));
    }
    for (const key of ['sceneEffort', 'projectEffort'] as const) {
      if (patch[key] !== undefined && !isEffort(patch[key])) throw new HttpError(400, m().core.settings.effort(patch[key]));
    }
    if (patch.language !== undefined && !isLanguage(patch.language))
      throw new HttpError(400, m().core.settings.language(patch.language));
    if (patch.agent !== undefined && !isAgent(patch.agent)) throw new HttpError(400, m().core.settings.agent(patch.agent));
    const defaultVoice = patch.defaultVoice ? cleanDefaultVoice(patch.defaultVoice) : patch.defaultVoice;
    if (patch.defaultVoice && !defaultVoice) throw new HttpError(400, m().core.settings.defaultVoice);
    return this.mutex.run('settings', async () => {
      const current = await this.get();
      const next: Settings = { ...current, agentPrefs: { ...current.agentPrefs } };
      if (patch.language !== undefined) next.language = patch.language;
      if (patch.agent !== undefined) next.agent = patch.agent;
      if (defaultVoice) next.defaultVoice = defaultVoice;
      else if (defaultVoice === null) delete next.defaultVoice;
      // The model/effort of this update belong to the agent in force after it (Claude Code keeps the flat fields).
      const agent = patch.agent ?? current.agent;
      const given: Partial<AgentPrefs> = {};
      for (const key of PREF_FIELDS) if (patch[key] !== undefined) given[key] = patch[key] as never;
      if (Object.keys(given).length) {
        if (agent === 'claude-code') Object.assign(next, given);
        else next.agentPrefs = { ...next.agentPrefs, [agent]: { ...next.agentPrefs?.[agent], ...given } };
      }
      await writeJsonAtomic(this.file, next);
      if (next.language) setLanguage(next.language);
      return next;
    });
  }
}

/** Keep only the per-agent model/effort values that are valid; drop the rest so a bad stored value never breaks a turn. */
function cleanPrefs(stored: unknown): Partial<Record<AgentId, Partial<AgentPrefs>>> {
  const out: Partial<Record<AgentId, Partial<AgentPrefs>>> = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const agent of AGENT_IDS) {
    const raw = (stored as Record<string, unknown>)[agent];
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const entry: Partial<AgentPrefs> = {};
    if (isModel(p.sceneModel)) entry.sceneModel = p.sceneModel;
    if (isEffort(p.sceneEffort)) entry.sceneEffort = p.sceneEffort;
    if (isModel(p.projectModel)) entry.projectModel = p.projectModel;
    if (isEffort(p.projectEffort)) entry.projectEffort = p.projectEffort;
    if (Object.keys(entry).length) out[agent] = entry;
  }
  return out;
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

function isEffort(value: unknown): value is Effort {
  return EFFORTS.includes(value as Effort);
}

function isAgent(value: unknown): value is AgentId {
  return AGENT_IDS.includes(value as AgentId);
}

/** A valid ElevenLabs default with its own fields only, or undefined. */
function cleanDefaultVoice(value: unknown): DefaultVoice | undefined {
  const { engine, voice, model } = (value ?? {}) as Partial<DefaultVoice>;
  if (engine !== 'elevenlabs' || typeof voice !== 'string' || typeof model !== 'string') return undefined;
  return ELEVENLABS_VOICE_PATTERN.test(voice) && ELEVENLABS_MODEL_PATTERN.test(model) ? { engine, voice, model } : undefined;
}
