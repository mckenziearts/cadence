// TikTok through Login Kit for Desktop (loopback redirect, PKCE) and the Content Posting API: the video lands in the
// person's TikTok inbox as a draft, which they finish and post in the TikTok app. Posting straight to the profile needs
// TikTok's audit, whose guidelines turn down "a utility tool to help upload contents to the account(s) you or your team
// manages": a Sandbox app sending drafts is what a team can set up on its own.
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PublishFields, Visibility } from '../../src/shared/types';
import type { Fetch, Network, NetworkApp, NetworkIdentity, NetworkTokens } from '../contracts';
import { m } from '../i18n';
import { HttpError } from '../util';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=display_name,avatar_url';
const INBOX_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const SCOPES = 'user.info.basic,video.upload';
/** user.info.basic gives no address for the profile (its username needs user.info.profile). */
const ACCOUNT_URL = 'https://www.tiktok.com/';
/** TikTok's own example size: chunks hold 5 to 64 MB, the last one up to 128 MB. */
const CHUNK_BYTES = 10_000_000;
/** status/fetch takes 30 calls a minute per token: every 5 s leaves room for a second upload. */
const POLL_MS = 5_000;
/** TikTok processes 1 GB in about a minute and 4 GB, its limit, in over two: past ten minutes, stop waiting. */
const PROCESSING_MS = 10 * 60_000;
const CHUNK_RETRIES = 2;
/** 10 MB on a slow uplink; an API call gets 30 s. */
const CHUNK_TIMEOUT_MS = 5 * 60_000;
const API_TIMEOUT_MS = 30_000;

export class TikTokNetwork implements Network {
  readonly id = 'tiktok' as const;
  readonly label = 'TikTok';
  /** A video draft takes no text: the caption and who may watch are chosen in the TikTok app. */
  readonly fields: PublishFields = { title: null, text: null, visibilities: ['draft'] };

  constructor(
    private readonly http: Fetch = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<unknown> = delay,
  ) {}

  authorizeUrl(app: NetworkApp, input: { redirectUri: string; state: string; challenge: string }): string {
    const params = new URLSearchParams({
      client_key: app.clientId,
      response_type: 'code',
      scope: SCOPES,
      redirect_uri: input.redirectUri,
      state: input.state,
      // TikTok wants the verifier's SHA-256 in hex where RFC 7636 writes it in base64url: the same digest.
      code_challenge: Buffer.from(input.challenge, 'base64url').toString('hex'),
      code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async connect(
    app: NetworkApp,
    input: { redirectUri: string; code: string; verifier: string },
  ): Promise<{ identity: NetworkIdentity; tokens: NetworkTokens }> {
    const { tokens, scope } = await this.token(app, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    });
    // The consent page lets the person untick a permission.
    if (!scope.split(',').includes('video.upload')) throw new HttpError(403, m().tiktok.reasons.scope_not_authorized);
    return { identity: await this.account(tokens.access), tokens };
  }

  async refresh(app: NetworkApp, tokens: NetworkTokens): Promise<NetworkTokens> {
    if (!tokens.refresh) throw new HttpError(401, m().tiktok.expired);
    const { tokens: next } = await this.token(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh });
    return { ...next, refresh: next.refresh ?? tokens.refresh };
  }

  async revoke(app: NetworkApp, tokens: NetworkTokens): Promise<void> {
    // TikTok revokes through the access token, which lasts a day: most disconnections come after it ran out.
    const { access } = tokens.expiresAt > Date.now() ? tokens : await this.refresh(app, tokens);
    await this.http(REVOKE_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_key: app.clientId, client_secret: app.clientSecret, token: access }),
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
    const { size } = input;
    // One request under 20 MB, as TikTok's whole upload does. Above, total_chunk_count is the size divided by
    // chunk_size rounded down: the last chunk carries the remainder.
    const chunkSize = size < 2 * CHUNK_BYTES ? size : CHUNK_BYTES;
    const count = Math.floor(size / chunkSize);
    const draft = await this.api<{ publish_id: string; upload_url: string }>(
      input.tokens.access,
      INBOX_URL,
      m().tiktok.videoRefused,
      { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count } },
    );

    const handle = await fs.open(input.file, 'r');
    try {
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        const end = i === count - 1 ? size : start + chunkSize;
        const chunk = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
        // The upload address carries its own token: the person's access token is not sent there.
        const put = () =>
          this.http(draft.upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end - 1}/${size}` },
            body: chunk.subarray(0, bytesRead),
            signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
          });
        // TikTok's media transfer guide: a 5xx on a chunk is retried.
        let res = await put();
        for (let retry = 0; retry < CHUNK_RETRIES && res.status >= 500; retry++) res = await put();
        if (!res.ok) throw new HttpError(502, m().tiktok.stalled(res.status));
        input.onProgress(end);
      }
    } finally {
      await handle.close();
    }
    await this.delivered(input.tokens, draft.publish_id);
    return { url: null, visibility: 'draft' };
  }

  /** TikTok checks the video once it has all of it: the draft reaches the inbox after that. */
  private async delivered(tokens: NetworkTokens, publishId: string): Promise<void> {
    // Not past the access token's end: a refused poll would read as a lost connection, the draft may still come.
    for (let waited = 0; waited < PROCESSING_MS && Date.now() + POLL_MS < tokens.expiresAt; waited += POLL_MS) {
      await this.sleep(POLL_MS);
      const { status, fail_reason } = await this.api<{ status: string; fail_reason?: string }>(
        tokens.access,
        STATUS_URL,
        m().tiktok.videoRefused,
        { publish_id: publishId },
      );
      // PUBLISH_COMPLETE: the person already posted it from the inbox.
      if (status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE') return;
      if (status === 'FAILED') {
        const lost = fail_reason === 'auth_removed';
        throw new HttpError(lost ? 401 : 502, said(fail_reason) ?? m().tiktok.videoRefused(fail_reason ?? status));
      }
    }
    throw new HttpError(504, m().tiktok.stillProcessing);
  }

  private async token(app: NetworkApp, grant: Record<string, string>): Promise<{ tokens: NetworkTokens; scope: string }> {
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_key: app.clientId, client_secret: app.clientSecret, ...grant }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (res.ok && data.access_token) {
      return {
        tokens: {
          access: data.access_token,
          refresh: data.refresh_token ?? null,
          expiresAt: Date.now() + (data.expires_in ?? 86_400) * 1000,
        },
        scope: data.scope ?? '',
      };
    }
    const texts = m().tiktok;
    if (data.error === 'invalid_grant') {
      throw new HttpError(401, grant.grant_type === 'refresh_token' ? texts.expired : texts.codeRefused);
    }
    if (data.error === 'invalid_client' || data.error === 'unauthorized_client') throw new HttpError(400, texts.badKeys);
    throw new HttpError(502, texts.tiktokSaid(data.error_description || data.error || texts.httpStatus(res.status)));
  }

  private async account(access: string): Promise<NetworkIdentity> {
    const { user } = await this.api<{ user: { display_name: string; avatar_url?: string } }>(
      access,
      USER_URL,
      m().tiktok.accountUnavailable,
    );
    return { name: user.display_name, url: ACCOUNT_URL, avatar: user.avatar_url ?? null };
  }

  /** A call to TikTok's API v2: it worked only when error.code is "ok", as some refusals come with a 200. */
  private async api<T>(access: string, url: string, what: (detail: string) => string, body?: object): Promise<T> {
    const auth = { Authorization: `Bearer ${access}` };
    const res = await this.http(
      url,
      body
        ? {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
          }
        : { headers: auth, signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    const reply = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
    const code = reply.error?.code;
    if (res.ok && code === 'ok') return reply.data as T;
    throw new HttpError(
      res.status === 401 ? 401 : 502,
      said(code) ?? what(reply.error?.message || code || m().tiktok.httpStatus(res.status)),
    );
  }
}

/** What TikTok's code means for the person, in the interface language, when they can act on it. */
function said(code: string | undefined): string | null {
  const reasons = m().tiktok.reasons;
  return code && Object.hasOwn(reasons, code) ? reasons[code as keyof typeof reasons] : null;
}
