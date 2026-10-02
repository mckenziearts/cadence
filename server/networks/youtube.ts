// YouTube through the Data API v3: Google's OAuth for installed apps (loopback redirect, PKCE), then a resumable upload.
// A Short is no separate API: YouTube files a vertical video of 3 minutes or less as one by itself.
import fs from 'node:fs/promises';
import type { PublishFields, Visibility } from '../../src/shared/types';
import type { Fetch, Network, NetworkApp, NetworkIdentity, NetworkTokens } from '../contracts';
import { m } from '../i18n';
import { HttpError } from '../util';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
/** youtube.readonly names the connected channel. */
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
/** Resumable upload chunks must be multiples of 256 KiB. */
const CHUNK_BYTES = 32 * 256 * 1024;
/** People & Blogs, YouTube's own default for uploads. */
const CATEGORY = '22';

export class YouTubeNetwork implements Network {
  readonly id = 'youtube' as const;
  readonly label = 'YouTube';
  readonly fields: PublishFields = { title: 100, text: 5000, visibilities: ['private', 'unlisted', 'public'] };

  constructor(private readonly http: Fetch = (input, init) => fetch(input, init)) {}

  authorizeUrl(app: NetworkApp, input: { redirectUri: string; state: string; challenge: string }): string {
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      // Google sends a refresh token only with a consent: ask for it at every connection.
      access_type: 'offline',
      prompt: 'consent',
      state: input.state,
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async connect(
    app: NetworkApp,
    input: { redirectUri: string; code: string; verifier: string },
  ): Promise<{ identity: NetworkIdentity; tokens: NetworkTokens }> {
    const tokens = await this.token(app, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    });
    return { identity: await this.channel(tokens.access), tokens };
  }

  async refresh(app: NetworkApp, tokens: NetworkTokens): Promise<NetworkTokens> {
    if (!tokens.refresh) throw new HttpError(401, m().youtube.expired);
    const next = await this.token(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh });
    return { ...next, refresh: next.refresh ?? tokens.refresh };
  }

  async revoke(_app: NetworkApp, tokens: NetworkTokens): Promise<void> {
    // Revoking the refresh token ends the access tokens issued from it.
    await this.http(REVOKE_URL, {
      method: 'POST',
      body: new URLSearchParams({ token: tokens.refresh ?? tokens.access }),
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
  }): Promise<{ url: string; visibility: Visibility }> {
    if (/[<>]/.test(input.title + input.description)) {
      throw new HttpError(400, m().youtube.angleBrackets);
    }
    const auth = { Authorization: `Bearer ${input.tokens.access}` };
    const start = await this.http(UPLOAD_URL, {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(input.size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: { title: input.title, description: input.description, categoryId: CATEGORY },
        status: { privacyStatus: input.visibility, selfDeclaredMadeForKids: false },
      }),
    });
    const session = start.headers.get('location');
    if (!start.ok || !session) throw await youtubeError(start, m().youtube.videoRefused);

    const handle = await fs.open(input.file, 'r');
    try {
      let sent = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, input.size - sent));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, sent);
        const res = await this.http(session, {
          method: 'PUT',
          headers: { ...auth, 'Content-Range': `bytes ${sent}-${sent + bytesRead - 1}/${input.size}` },
          body: chunk.subarray(0, bytesRead),
        });
        if (res.status === 308) {
          // Resume after what Google kept (no Range header: it kept nothing).
          const kept = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
          const next = kept ? Number(kept[1]) + 1 : 0;
          if (next <= sent) throw new HttpError(502, m().youtube.stalled);
          sent = next;
          input.onProgress(sent);
          continue;
        }
        if (!res.ok) throw await youtubeError(res, m().youtube.videoRefused);
        const video = (await res.json()) as { id: string; status?: { privacyStatus?: Visibility } };
        input.onProgress(input.size);
        return { url: `https://youtu.be/${video.id}`, visibility: video.status?.privacyStatus ?? input.visibility };
      }
    } finally {
      await handle.close();
    }
  }

  private async token(app: NetworkApp, grant: Record<string, string>): Promise<NetworkTokens> {
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...grant }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (res.ok && data.access_token) {
      return {
        access: data.access_token,
        refresh: data.refresh_token ?? null,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
    }
    if (data.error === 'invalid_grant') {
      throw new HttpError(401, grant.grant_type === 'refresh_token' ? m().youtube.expired : m().youtube.codeRefused);
    }
    if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
      throw new HttpError(400, m().youtube.badKeys);
    }
    throw new HttpError(502, m().youtube.googleSaid(data.error_description ?? data.error ?? m().youtube.httpStatus(res.status)));
  }

  private async channel(access: string): Promise<NetworkIdentity> {
    const res = await this.http(CHANNEL_URL, { headers: { Authorization: `Bearer ${access}` } });
    if (!res.ok) throw await youtubeError(res, m().youtube.channelUnavailable);
    const data = (await res.json()) as {
      items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }[];
    };
    const channel = data.items?.[0];
    if (!channel) throw new HttpError(400, m().youtube.noChannel);
    return {
      name: channel.snippet.title,
      url: `https://www.youtube.com/${channel.snippet.customUrl ?? `channel/${channel.id}`}`,
      avatar: channel.snippet.thumbnails?.default?.url ?? null,
    };
  }
}

/** Google's error in the interface language: the reasons someone can act on, else Google's own words. */
async function youtubeError(res: Response, what: (detail: string) => string): Promise<HttpError> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
  const reason = data?.error?.errors?.[0]?.reason;
  if (res.status === 401) return new HttpError(401, m().youtube.expired);
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
    return new HttpError(429, m().youtube.quota);
  }
  if (reason === 'youtubeSignupRequired') return new HttpError(400, m().youtube.noChannel);
  if (reason === 'accessNotConfigured') return new HttpError(400, m().youtube.apiDisabled);
  return new HttpError(502, what(data?.error?.message ?? m().youtube.httpStatus(res.status)));
}
