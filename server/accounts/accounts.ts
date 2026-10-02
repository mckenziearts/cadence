// The accounts Cadence uses on this machine: Git hosts through their CLI (Cadence keeps no token for them), networks
// through the developer app the team created on each. Keys and tokens live in .cadence/accounts.json (mode 600): never
// sent to the browser, and out of reach of Claude's tools, which work inside a project or a brand folder.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { NETWORK_IDS, type GitAccount, type GitHost, type NetworkAccount, type NetworkId } from '../../src/shared/types';
import type {
  AccountService,
  BrandSource,
  CadenceConfig,
  Hub,
  Network,
  NetworkApp,
  NetworkIdentity,
  NetworkTokens,
} from '../contracts';
import { m } from '../i18n';
import { HttpError, KeyedMutex, nowIso, randomToken, readJsonOr, writeFileAtomic } from '../util';

const STATE_TTL_MS = 10 * 60_000;
/** Tokens this close to their end are refreshed first: an upload takes a while. */
const REFRESH_MARGIN_MS = 5 * 60_000;

interface StoredNetwork {
  app?: NetworkApp;
  account?: NetworkIdentity & { connectedAt: string; tokens: NetworkTokens };
}
type AccountsFile = Partial<Record<NetworkId, StoredNetwork>>;

export class FileAccountService implements AccountService {
  private file: string;
  private mutex = new KeyedMutex();
  /** OAuth states waiting for their redirect: single use. */
  private pending = new Map<string, { network: NetworkId; verifier: string; expires: number }>();

  constructor(
    private readonly deps: {
      config: CadenceConfig;
      hub: Hub;
      networks: Record<NetworkId, Network>;
      git: Record<GitHost, Pick<BrandSource, 'account'>>;
    },
  ) {
    this.file = path.join(deps.config.stateDir, 'accounts.json');
  }

  async networks(): Promise<NetworkAccount[]> {
    const stored = await this.read();
    return NETWORK_IDS.map((id) => {
      const { app, account } = stored[id] ?? {};
      return {
        id,
        label: this.deps.networks[id].label,
        clientId: app?.clientId ?? null,
        redirectUri: this.redirectUri(id),
        account: account
          ? { name: account.name, url: account.url, avatar: account.avatar, connectedAt: account.connectedAt }
          : null,
        fields: this.deps.networks[id].fields,
      };
    });
  }

  async git(): Promise<Record<GitHost, GitAccount>> {
    const [github, gitlab] = await Promise.all([this.deps.git.github.account(), this.deps.git.gitlab.account()]);
    return { github, gitlab };
  }

  async saveApp(id: NetworkId, app: NetworkApp): Promise<void> {
    await this.update((all) => {
      const current = all[id];
      const same = current?.app?.clientId === app.clientId && current.app.clientSecret === app.clientSecret;
      all[id] = { app, account: same ? current?.account : undefined };
    });
    this.deps.hub.send({ type: 'accounts-changed' });
  }

  async connect(id: NetworkId): Promise<{ url: string }> {
    const network = this.deps.networks[id];
    const app = (await this.read())[id]?.app;
    if (!app) throw new HttpError(409, m().accounts.saveKeysFirst(network.label));
    const now = Date.now();
    for (const [key, value] of this.pending) if (value.expires < now) this.pending.delete(key);
    const state = randomToken();
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { network: id, verifier, expires: now + STATE_TTL_MS });
    return { url: network.authorizeUrl(app, { redirectUri: this.redirectUri(id), state, challenge }) };
  }

  async callback(name: string, params: URLSearchParams): Promise<{ ok: boolean; title: string; detail: string }> {
    const state = params.get('state') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.network !== name || pending.expires < Date.now()) {
      return { ok: false, title: m().accounts.callback.expired, detail: m().accounts.callback.expiredDetail };
    }
    const id = pending.network;
    const network = this.deps.networks[id];
    const refused = params.get('error');
    if (refused) {
      return {
        ok: false,
        title: m().accounts.callback.refused(network.label),
        detail:
          // LinkedIn says a person cancelled with its own codes; the description says more than a code.
          ['access_denied', 'user_cancelled_login', 'user_cancelled_authorize'].includes(refused)
            ? m().accounts.callback.accessDenied
            : m().accounts.callback.answered(network.label, (params.get('error_description') ?? refused).slice(0, 200)),
      };
    }
    try {
      const app = (await this.read())[id]?.app;
      const code = params.get('code');
      if (!app || !code) throw new HttpError(400, m().accounts.callback.noCode);
      const { identity, tokens } = await network.connect(app, {
        redirectUri: this.redirectUri(id),
        code,
        verifier: pending.verifier,
      });
      await this.update((all) => {
        all[id] = { app, account: { ...identity, connectedAt: nowIso(), tokens } };
      });
      this.deps.hub.send({ type: 'accounts-changed' });
      return {
        ok: true,
        title: m().accounts.callback.connected(network.label),
        detail: m().accounts.callback.linked(identity.name),
      };
    } catch (e) {
      return { ok: false, title: m().accounts.callback.failed(network.label), detail: (e as Error).message };
    }
  }

  async disconnect(id: NetworkId): Promise<void> {
    const { app, account } = (await this.read())[id] ?? {};
    // Revoked on the network when it answers; forgotten here in any case.
    if (app && account) await this.deps.networks[id].revoke(app, account.tokens).catch(() => undefined);
    await this.update((all) => {
      delete all[id]?.account;
    });
    this.deps.hub.send({ type: 'accounts-changed' });
  }

  tokens(id: NetworkId): Promise<NetworkTokens> {
    return this.mutex.run(`tokens:${id}`, async () => {
      const network = this.deps.networks[id];
      const { app, account } = (await this.read())[id] ?? {};
      if (!app || !account) throw new HttpError(409, m().accounts.connectFirst(network.label));
      if (account.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return account.tokens;
      try {
        const tokens = await network.refresh(app, account.tokens);
        await this.update((all) => {
          const current = all[id]?.account;
          if (current) current.tokens = tokens;
        });
        return tokens;
      } catch (e) {
        // Revoked or expired for good: the Profile page shows it disconnected.
        if (e instanceof HttpError && e.status === 401) {
          await this.update((all) => {
            delete all[id]?.account;
          });
          this.deps.hub.send({ type: 'accounts-changed' });
        }
        throw e;
      }
    });
  }

  private redirectUri(id: NetworkId): string {
    const { config, networks } = this.deps;
    return `http://${networks[id].redirectHost ?? config.host}:${config.editorPort}/oauth/${id}/callback`;
  }

  private read(): Promise<AccountsFile> {
    return readJsonOr<AccountsFile>(this.file, {});
  }

  private update(change: (all: AccountsFile) => void): Promise<void> {
    return this.mutex.run('file', async () => {
      const all = await this.read();
      change(all);
      // Its tokens post on the person's behalf: only their user may read it.
      await writeFileAtomic(this.file, `${JSON.stringify(all, null, 2)}\n`, 0o600);
    });
  }
}
