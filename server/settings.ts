import path from 'node:path';
import { EFFORTS, MODEL_ID_PATTERN, type Effort, type Settings } from '../src/shared/types';
import type { CadenceConfig, SettingsStore } from './contracts';
import { isLanguage, m, setLanguage } from './i18n';
import { HttpError, KeyedMutex, readJsonOr, writeJsonAtomic } from './util';

/** Global editor settings in <root>/.cadence/settings.json; missing or invalid values fall back to the config defaults. */
export class FileSettingsStore implements SettingsStore {
  private file: string;
  private mutex = new KeyedMutex();

  constructor(private config: CadenceConfig) {
    this.file = path.join(config.stateDir, 'settings.json');
  }

  async get(): Promise<Settings> {
    const stored = await readJsonOr<Partial<Settings>>(this.file, {});
    const defaults: Settings = {
      sceneModel: this.config.defaultModel,
      sceneEffort: this.config.defaultEffort,
      projectModel: this.config.defaultModel,
      projectEffort: 'high',
      language: null,
    };
    return {
      sceneModel: isModel(stored.sceneModel) ? stored.sceneModel : defaults.sceneModel,
      sceneEffort: isEffort(stored.sceneEffort) ? stored.sceneEffort : defaults.sceneEffort,
      projectModel: isModel(stored.projectModel) ? stored.projectModel : defaults.projectModel,
      projectEffort: isEffort(stored.projectEffort) ? stored.projectEffort : defaults.projectEffort,
      language: isLanguage(stored.language) ? stored.language : defaults.language,
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
    return this.mutex.run('settings', async () => {
      const next: Settings = { ...(await this.get()) };
      for (const key of ['sceneModel', 'sceneEffort', 'projectModel', 'projectEffort', 'language'] as const) {
        if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
      }
      await writeJsonAtomic(this.file, next);
      if (next.language) setLanguage(next.language);
      return next;
    });
  }
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

function isEffort(value: unknown): value is Effort {
  return EFFORTS.includes(value as Effort);
}
