import path from 'node:path';
import type { CadenceConfig, CaptureHostStore } from '../contracts';
import { m } from '../i18n';
import { HttpError, KeyedMutex, readJsonOr, writeJsonAtomic } from '../util';

/**
 * The hosts the person approved for the agent's captures, per project, in <root>/.cadence/capture-hosts.json: outside the
 * project folder, which the agent can write, and outside its archives.
 */
export class FileCaptureHosts implements CaptureHostStore {
  private file: string;
  private mutex = new KeyedMutex();

  constructor(config: Pick<CadenceConfig, 'stateDir'>) {
    this.file = path.join(config.stateDir, 'capture-hosts.json');
  }

  async list(projectId: string): Promise<string[]> {
    return (await this.read()).get(projectId) ?? [];
  }

  async approve(projectId: string, host: string): Promise<string[]> {
    // As URL.host writes it, so that it matches the URLs of the agent's captures.
    if (URL.parse(`http://${host}`)?.host !== host) throw new HttpError(400, m().api.routes.captureHost(host));
    return this.change(projectId, (hosts) => (hosts.includes(host) ? hosts : [...hosts, host]));
  }

  async drop(projectId: string): Promise<void> {
    await this.change(projectId, () => []);
  }

  private change(projectId: string, next: (hosts: string[]) => string[]): Promise<string[]> {
    return this.mutex.run('hosts', async () => {
      const all = await this.read();
      const hosts = next(all.get(projectId) ?? []);
      if (hosts.length) all.set(projectId, hosts);
      else all.delete(projectId);
      await writeJsonAtomic(this.file, Object.fromEntries(all));
      return hosts;
    });
  }

  /** A Map: a project id may be an Object.prototype key (`constructor`). */
  private async read(): Promise<Map<string, string[]>> {
    return new Map(Object.entries(await readJsonOr<Record<string, string[]>>(this.file, {})));
  }
}
