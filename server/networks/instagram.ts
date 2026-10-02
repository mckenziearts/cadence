// Instagram through the Instagram API with Facebook Login: Facebook Login for Business, then a Reel sent from the disk to
// rupload.facebook.com. The Instagram Login variant only takes a public video_url that Meta downloads, which a video on
// this machine does not have.
import fs, { type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PublishFields, Visibility } from '../../src/shared/types';
import type { Fetch, Network, NetworkApp, NetworkIdentity, NetworkTokens } from '../contracts';
import { m } from '../i18n';
import { HttpError } from '../util';

const GRAPH = 'https://graph.facebook.com/v26.0';
const DIALOG_URL = 'https://www.facebook.com/v26.0/dialog/oauth';
/** What "API setup with Facebook login" adds to the app for content management. */
const SCOPES = [
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
  'pages_read_engagement',
  'pages_show_list',
];
/** Meta's usual answer when the long-lived exchange omits expires_in. */
const LONG_LIVED_S = 60 * 24 * 3600;
/** Reels spec: 300 MB at most. */
const MAX_BYTES = 300_000_000;
/** Small reads keep the progress within a chunk and a socket buffer of what Meta has received. */
const CHUNK_BYTES = 1024 * 1024;
/** rupload answers 400s that pass on the next try. */
const UPLOAD_ATTEMPTS = 3;
/** Meta's guide polls once a minute for 5 minutes; one Reel at a time can ask every 10 s, and a 15-minute one may need longer. */
const POLL_MS = 10_000;
const PROCESSING_MS = 10 * 60_000;

/** A Graph API error: `code` gives the kind, `error_subcode` the Instagram reason. */
interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
}

interface InstagramAccount {
  id: string;
  username: string;
  profile_picture_url?: string;
}

export class InstagramNetwork implements Network {
  readonly id = 'instagram' as const;
  readonly label = 'Instagram';
  /** The API publishes a Reel right away and public: no draft, no private post. */
  readonly fields: PublishFields = { title: null, text: 2200, visibilities: ['public'] };
  /** Meta lets http://localhost redirects through while the app is in development mode, not 127.0.0.1. */
  readonly redirectHost = 'localhost' as const;

  constructor(
    private readonly http: Fetch = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<unknown> = delay,
  ) {}

  authorizeUrl(app: NetworkApp, input: { redirectUri: string; state: string; challenge: string }): string {
    // No PKCE: Meta documents it only for its OIDC flow, still in testing. The app secret guards the code exchange.
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(','),
      state: input.state,
      // Without it, the dialog never asks again for a permission the person declined once.
      auth_type: 'rerequest',
    });
    return `${DIALOG_URL}?${params}`;
  }

  async connect(
    app: NetworkApp,
    input: { redirectUri: string; code: string; verifier: string },
  ): Promise<{ identity: NetworkIdentity; tokens: NetworkTokens }> {
    const short = await this.token(app, { redirect_uri: input.redirectUri, code: input.code });
    const tokens = await this.token(app, { grant_type: 'fb_exchange_token', fb_exchange_token: short.access });
    const { data: permissions = [] } = await this.graph<{ data?: { permission: string; status: string }[] }>(
      `${GRAPH}/me/permissions`,
      { headers: { Authorization: `Bearer ${tokens.access}` } },
      m().instagram.accountUnavailable,
    );
    // Said now rather than after a 300 MB upload.
    const declined = SCOPES.filter((scope) => !permissions.some((p) => p.permission === scope && p.status === 'granted'));
    if (declined.length) throw new HttpError(403, m().instagram.declined(declined.join(', ')));
    const account = await this.account(tokens.access);
    return {
      identity: {
        name: `@${account.username}`,
        url: `https://www.instagram.com/${account.username}/`,
        avatar: account.profile_picture_url ?? null,
      },
      // Publishing goes to this account, the one the Profile shows, whatever order Meta lists the Pages in later.
      tokens: { ...tokens, account: account.id },
    };
  }

  /** Facebook Login gives no refresh token: once the 60 days are up, the person connects again. */
  async refresh(): Promise<NetworkTokens> {
    throw new HttpError(401, m().instagram.expired);
  }

  async revoke(_app: NetworkApp, tokens: NetworkTokens): Promise<void> {
    // Withdraws what the person granted: their tokens for this app stop working.
    await this.http(`${GRAPH}/me/permissions`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokens.access}` },
      signal: AbortSignal.timeout(15_000),
    });
  }

  async publish(input: {
    tokens: NetworkTokens;
    file: string;
    size: number;
    title: string;
    description: string;
    visibility: Visibility;
    onProgress(sent: number): void;
  }): Promise<{ url: string | null; visibility: Visibility }> {
    if (input.size > MAX_BYTES) throw new HttpError(400, m().instagram.tooBig);
    const auth = { Authorization: `Bearer ${input.tokens.access}` };
    // Connected before the account was kept with the tokens: connecting again picks it.
    const user = input.tokens.account;
    if (!user) throw new HttpError(401, m().instagram.expired);
    // As Meta's resumable sample: share_to_feed is not among the parameters it lists for this upload.
    const reel = new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable' });
    if (input.description) reel.set('caption', input.description);
    const container = await this.graph<{ id: string; uri: string }>(
      `${GRAPH}/${user}/media`,
      { method: 'POST', headers: auth, body: reel },
      m().instagram.videoRefused,
    );
    await this.upload(container, input);
    await this.processed(container.id, auth);
    const media = await this.graph<{ id: string }>(
      `${GRAPH}/${user}/media_publish`,
      { method: 'POST', headers: auth, body: new URLSearchParams({ creation_id: container.id }) },
      m().instagram.videoRefused,
    );
    // The Reel is online from here: missing its address must not turn the publication into a failure.
    const link = await this.http(`${GRAPH}/${media.id}?fields=permalink`, { headers: auth })
      .then((res) => res.json() as Promise<{ permalink?: string }>)
      .catch(() => ({ permalink: undefined }));
    return { url: link.permalink ?? null, visibility: 'public' };
  }

  /** One POST per try, the file streamed from where Meta stands: rupload answers only once a POST has ended. */
  private async upload(
    container: { id: string; uri: string },
    input: { tokens: NetworkTokens; file: string; size: number; onProgress(sent: number): void },
  ): Promise<void> {
    const handle = await fs.open(input.file, 'r');
    try {
      let offset = 0;
      for (let attempt = 1; ; attempt++) {
        // An object apart: the DOM's RequestInit does not list `duplex`, which Node requires for a streamed body.
        const init = {
          method: 'POST',
          headers: {
            Authorization: `OAuth ${input.tokens.access}`,
            offset: String(offset),
            file_size: String(input.size),
            'Content-Length': String(input.size - offset),
          },
          body: fileStream(handle, offset, input.size, input.onProgress),
          duplex: 'half',
        };
        const res = await this.http(container.uri, init).catch((e: Error) => e);
        if (res instanceof Response && res.ok) {
          input.onProgress(input.size);
          return;
        }
        const failure = await uploadFailure(res);
        if (attempt === UPLOAD_ATTEMPTS || !failure.retriable)
          throw new HttpError(502, m().instagram.uploadFailed(failure.detail));
        offset = await this.received(container.id, input.tokens.access);
      }
    } finally {
      await handle.close();
    }
  }

  /** What Meta kept of an interrupted upload; asking Graph also tells a dead token from a hiccup. */
  private async received(container: string, access: string): Promise<number> {
    const { video_status } = await this.graph<{ video_status?: { uploading_phase?: { bytes_transferred?: number } } }>(
      `${GRAPH}/${container}?fields=video_status`,
      { headers: { Authorization: `Bearer ${access}` } },
      m().instagram.uploadFailed,
    );
    return video_status?.uploading_phase?.bytes_transferred ?? 0;
  }

  private async processed(container: string, auth: Record<string, string>): Promise<void> {
    for (let waited = 0; waited < PROCESSING_MS; waited += POLL_MS) {
      await this.sleep(POLL_MS);
      const { status_code: code, status } = await this.graph<{ status_code?: string; status?: string }>(
        `${GRAPH}/${container}?fields=status_code,status`,
        { headers: auth },
        m().instagram.videoRefused,
      );
      if (code === 'FINISHED') return;
      // On ERROR, `status` carries Instagram's subcode: 2207026 is a format it does not take.
      if (code === 'ERROR' || code === 'EXPIRED') {
        throw new HttpError(400, status?.includes('2207026') ? m().instagram.format : m().instagram.videoRefused(status || code));
      }
    }
    throw new HttpError(504, m().instagram.slow);
  }

  /** The first Instagram professional account linked to a Page the person granted: the Profile shows which one. */
  private async account(access: string): Promise<InstagramAccount> {
    const query = new URLSearchParams({ fields: 'instagram_business_account{id,username,profile_picture_url}', limit: '100' });
    const { data = [] } = await this.graph<{ data?: { instagram_business_account?: InstagramAccount }[] }>(
      `${GRAPH}/me/accounts?${query}`,
      { headers: { Authorization: `Bearer ${access}` } },
      m().instagram.accountUnavailable,
    );
    const account = data.find((page) => page.instagram_business_account)?.instagram_business_account;
    if (!account) throw new HttpError(400, m().instagram.noAccount);
    return account;
  }

  private async token(app: NetworkApp, grant: Record<string, string>): Promise<NetworkTokens> {
    const params = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...grant });
    const res = await this.http(`${GRAPH}/oauth/access_token?${params}`);
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: GraphError };
    if (res.ok && data.access_token) {
      return { access: data.access_token, refresh: null, expiresAt: Date.now() + (data.expires_in ?? LONG_LIVED_S) * 1000 };
    }
    const error = data.error ?? {};
    // 101: unknown app ID. A wrong secret comes as code 1, told only by its message.
    if (error.code === 101 || /client secret/i.test(error.message ?? '')) throw new HttpError(400, m().instagram.badKeys);
    if (error.code === 100)
      throw new HttpError(400, m().instagram.codeRefused(error.message ?? m().instagram.httpStatus(res.status)));
    throw graphError(error, res.status, m().instagram.metaSaid);
  }

  private async graph<T>(url: string, init: RequestInit, what: (detail: string) => string): Promise<T> {
    const res = await this.http(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
    if (res.ok) return data;
    throw graphError(data.error ?? {}, res.status, what);
  }
}

/** The file from `start` on, a chunk at a time. With no read-ahead (highWaterMark 0), fetch asks for a chunk once the
 * previous one went out to the socket: the position then counts what it has handed to the network. */
function fileStream(handle: FileHandle, start: number, size: number, onProgress: (sent: number) => void) {
  let position = start;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (position >= size) return controller.close();
        if (position > start) onProgress(position);
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        // Cut short meanwhile: the body ends early and fetch fails on its Content-Length.
        if (bytesRead === 0) return controller.close();
        position += bytesRead;
        controller.enqueue(chunk.subarray(0, bytesRead));
      },
    },
    { highWaterMark: 0 },
  );
}

/** Meta's error in the interface language when someone can act on it, else in Meta's words. */
function graphError(error: GraphError, status: number, what: (detail: string) => string): HttpError {
  const t = m().instagram;
  const { code, error_subcode: subcode } = error;
  // 190: expired, revoked or password changed; 102: session gone.
  if (code === 190 || code === 102) return new HttpError(401, t.expired);
  if (subcode === 2207042) return new HttpError(429, t.quota);
  // 2207051 (code 4): activity restricted as possible spam, Meta's words say what to do.
  const throttled = [4, 17, 32, 613, 80002].includes(code ?? 0) && subcode !== 2207051;
  if (throttled) return new HttpError(429, t.throttled);
  // Not in Meta's table: measured on media_publish when nobody has access to the Instagram account in its business portfolio.
  if (subcode === 2207085) return new HttpError(403, t.assetAccess);
  const detail = error.error_user_msg ?? error.message ?? t.httpStatus(status);
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return new HttpError(403, t.permission(detail));
  return new HttpError(502, what(detail));
}

/** rupload's failure: debug_info (which says when a retry is pointless), Graph's error shape, or no answer at all. */
async function uploadFailure(res: Response | Error): Promise<{ detail: string; retriable: boolean }> {
  if (res instanceof Error) return { detail: res.message, retriable: true };
  const data = (await res.json().catch(() => null)) as {
    debug_info?: { message?: string; retriable?: boolean };
    error?: GraphError;
  } | null;
  return {
    detail: data?.debug_info?.message ?? data?.error?.message ?? m().instagram.httpStatus(res.status),
    retriable: data?.debug_info?.retriable !== false,
  };
}
