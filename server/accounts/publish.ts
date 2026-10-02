// « Publier »: an exported MP4 goes to a connected network in the background, one job per click. What the networks
// received stays with the project (.cadence/publications.json), so the render page still shows it after a restart.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NetworkId, Publication, Publications, PublishJob, PublishRequest } from '../../src/shared/types';
import type { AccountService, Hub, Network, NetworkTokens, ProjectStore, PublishService, RenderService } from '../contracts';
import { m } from '../i18n';
import { HttpError, KeyedMutex, nowIso, randomToken, readJsonOr, writeJsonAtomic } from '../util';

export class Publisher implements PublishService {
  private jobs = new Map<string, PublishJob>();
  private mutex = new KeyedMutex();

  constructor(
    private readonly deps: {
      store: ProjectStore;
      renders: RenderService;
      accounts: AccountService;
      networks: Record<NetworkId, Network>;
      hub: Hub;
    },
  ) {}

  async start(projectId: string, req: PublishRequest): Promise<PublishJob> {
    const network = this.deps.networks[req.network];
    const file = this.deps.renders.resolveFile(projectId, req.file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw new HttpError(404, m().accounts.publish.missingVideo(req.file));
    const twin = [...this.jobs.values()].some(
      (j) => j.status === 'uploading' && j.projectId === projectId && j.file === req.file && j.network === req.network,
    );
    if (twin) throw new HttpError(409, m().accounts.publish.alreadySending(network.label));
    const { fields } = network;
    const texts = m().accounts.publish;
    if (fields.title !== null && !req.title) throw new HttpError(400, texts.titleRequired(network.label));
    if (fields.title !== null && req.title.length > fields.title) throw new HttpError(400, texts.tooLong('title', fields.title));
    if (fields.text !== null && req.description.length > fields.text)
      throw new HttpError(400, texts.tooLong('text', fields.text));
    if (fields.textRequired && !req.description.trim()) throw new HttpError(400, texts.textRequired(network.label));
    if (!fields.visibilities.includes(req.visibility))
      throw new HttpError(400, texts.visibilityRefused(network.label, req.visibility));
    // Not connected, or connected for good no more: say it now rather than in a failed job.
    const tokens = await this.deps.accounts.tokens(req.network);
    const job: PublishJob = {
      id: randomToken(9),
      projectId,
      file: req.file,
      network: req.network,
      status: 'uploading',
      progress: 0,
      createdAt: nowIso(),
    };
    this.jobs.set(job.id, job);
    this.deps.hub.send({ type: 'publish', job: { ...job } });
    void this.run(job, req, { path: file, size: stat.size, tokens });
    return { ...job };
  }

  async list(projectId: string): Promise<Publications> {
    const jobs = [...this.jobs.values()]
      .filter((j) => j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs, publications: await readJsonOr<Publication[]>(this.file(projectId), []) };
  }

  busy(projectId: string, file?: string): boolean {
    return [...this.jobs.values()].some(
      (j) => j.projectId === projectId && j.status === 'uploading' && (file === undefined || j.file === file),
    );
  }

  private async run(
    job: PublishJob,
    req: PublishRequest,
    video: { path: string; size: number; tokens: NetworkTokens },
  ): Promise<void> {
    let shown = 0;
    try {
      const sent = await this.deps.networks[req.network].publish({
        tokens: video.tokens,
        file: video.path,
        size: video.size,
        title: req.title,
        description: req.description,
        visibility: req.visibility,
        onProgress: (bytes) => {
          const progress = bytes / video.size;
          // Every 2 %: a smooth bar, few events.
          if (progress < 1 && progress - shown < 0.02) return;
          shown = progress;
          this.update(job, { progress });
        },
      });
      const publication: Publication = {
        file: req.file,
        network: req.network,
        title: req.title,
        url: sent.url,
        visibility: sent.visibility,
        requested: req.visibility,
        publishedAt: nowIso(),
      };
      // The video is out: a history that cannot be written (a damaged publications.json, which the list reports) must
      // not turn the job into a failure someone would retry.
      await this.record(job.projectId, publication).catch(() => undefined);
      this.update(job, { status: 'done', progress: 1, publication, finishedAt: nowIso() });
    } catch (e) {
      const error = e instanceof HttpError ? e.message : m().accounts.publish.interrupted((e as Error).message);
      // Without a refresh token the connection is gone for good: the Profile must show it, as the message says.
      if (e instanceof HttpError && e.status === 401 && !video.tokens.refresh) {
        await this.deps.accounts.disconnect(req.network).catch(() => undefined);
      }
      this.update(job, { status: 'error', error, finishedAt: nowIso() });
    }
  }

  private update(job: PublishJob, patch: Partial<PublishJob>): void {
    Object.assign(job, patch);
    this.deps.hub.send({ type: 'publish', job: { ...job } });
  }

  private file(projectId: string): string {
    return path.join(this.deps.store.dir(projectId), '.cadence', 'publications.json');
  }

  private record(projectId: string, publication: Publication): Promise<void> {
    return this.mutex.run(projectId, async () => {
      // Deleted meanwhile from outside Cadence: writing would bring back an empty project folder.
      if (!(await this.deps.store.exists(projectId))) return;
      const file = this.file(projectId);
      await writeJsonAtomic(file, [publication, ...(await readJsonOr<Publication[]>(file, []))]);
    });
  }
}
