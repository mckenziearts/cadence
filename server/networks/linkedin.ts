// LinkedIn through its two self-serve products: "Sign In with LinkedIn using OpenID Connect" names the member, "Share on
// LinkedIn" posts a video on their own profile (versioned Videos and Posts APIs). Such apps get neither PKCE (LinkedIn
// turns it on per app, on request) nor refresh tokens: the app's secret proves the code exchange, and the member connects
// again when the 60-day token ends.
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PublishFields, Visibility } from '../../src/shared/types';
import type { Fetch, Network, NetworkApp, NetworkIdentity, NetworkTokens } from '../contracts';
import { m } from '../i18n';
import { HttpError } from '../util';

const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const VIDEOS_URL = 'https://api.linkedin.com/rest/videos';
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
/** Asking a member for other scopes ends all their earlier tokens: keep this string as it is. */
const SCOPES = 'openid profile w_member_social';
/** LinkedIn serves each version for a year (202609 until 2027-09-15), then answers 426. */
const VERSION = '202609';
/** LinkedIn takes a few minutes to process a video; the polls space out to spare the member's daily calls. */
const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const PROCESSING_MINUTES = 15;
/** The post's text, counted once escaped (little text format). */
const TEXT_MAX = 3000;
/** expires_in of every LinkedIn access token: 60 days. */
const TOKEN_SECONDS = 5_184_000;

interface UploadInstruction {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}

export class LinkedInNetwork implements Network {
  readonly id = 'linkedin' as const;
  readonly label = 'LinkedIn';
  readonly fields: PublishFields = {
    title: null,
    text: TEXT_MAX,
    textRequired: true,
    visibilities: ['connections', 'public'],
  };
  /** LinkedIn matches the redirect exactly, and its own sample registers an http://localhost one. */
  readonly redirectHost = 'localhost' as const;

  constructor(
    private readonly http: Fetch = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<unknown> = (ms) => delay(ms),
  ) {}

  authorizeUrl(app: NetworkApp, input: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      scope: SCOPES,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async connect(
    app: NetworkApp,
    input: { redirectUri: string; code: string },
  ): Promise<{ identity: NetworkIdentity; tokens: NetworkTokens }> {
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: input.redirectUri,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_client') throw new HttpError(400, m().linkedin.badKeys);
      throw new HttpError(
        502,
        m().linkedin.codeRefused(data.error_description ?? data.error ?? m().linkedin.httpStatus(res.status)),
      );
    }
    // An app without "Share on LinkedIn" may still get a token, without the right to post: say it now, not after an upload.
    if (data.scope && !data.scope.split(/[\s,]+/).includes('w_member_social')) {
      throw new HttpError(400, m().linkedin.noShare);
    }
    const { identity } = await this.member(data.access_token);
    return {
      identity,
      tokens: { access: data.access_token, refresh: null, expiresAt: Date.now() + (data.expires_in ?? TOKEN_SECONDS) * 1000 },
    };
  }

  async refresh(): Promise<NetworkTokens> {
    throw new HttpError(401, m().linkedin.expired);
  }

  /** LinkedIn documents no revocation: Cadence forgets the token, the member removes the app in their LinkedIn settings. */
  async revoke(): Promise<void> {}

  async publish(input: {
    tokens: NetworkTokens;
    file: string;
    size: number;
    description: string;
    visibility: Visibility;
    onProgress(sent: number): void;
  }): Promise<{ url: string | null; visibility: Visibility }> {
    // LinkedIn counts the escaped text: refuse it here rather than after the upload.
    const commentary = little(input.description);
    if (commentary.length > TEXT_MAX) throw new HttpError(400, m().linkedin.textTooLong(TEXT_MAX));
    const { sub } = await this.member(input.tokens.access);
    const owner = `urn:li:person:${sub}`;
    const headers = {
      Authorization: `Bearer ${input.tokens.access}`,
      'LinkedIn-Version': VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    };
    const send = (url: string, body: unknown) =>
      this.http(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const start = await send(`${VIDEOS_URL}?action=initializeUpload`, {
      initializeUploadRequest: { owner, fileSizeBytes: input.size, uploadCaptions: false, uploadThumbnail: false },
    });
    if (!start.ok) throw await linkedinError(start, m().linkedin.videoRefused);
    const { value: upload } = (await start.json()) as {
      value: { video: string; uploadToken: string; uploadInstructions: UploadInstruction[] };
    };

    const partIds: string[] = [];
    const handle = await fs.open(input.file, 'r');
    try {
      let sent = 0;
      for (const part of upload.uploadInstructions) {
        // Inclusive ranges, the last one possibly past the end of the file (as in LinkedIn's sample): send what was read.
        const chunk = Buffer.alloc(part.lastByte - part.firstByte + 1);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, part.firstByte);
        // A signed address: the access token is not sent there.
        const res = await this.http(part.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk.subarray(0, bytesRead),
        });
        if (!res.ok) throw new HttpError(502, m().linkedin.uploadFailed(res.status));
        partIds.push((res.headers.get('etag') ?? '').replaceAll('"', ''));
        sent += bytesRead;
        input.onProgress(sent);
      }
    } finally {
      await handle.close();
    }

    const finish = await send(`${VIDEOS_URL}?action=finalizeUpload`, {
      finalizeUploadRequest: { video: upload.video, uploadToken: upload.uploadToken, uploadedPartIds: partIds },
    });
    if (!finish.ok) throw await linkedinError(finish, m().linkedin.videoRefused);
    await this.processed(upload.video, headers);

    const post = await send(POSTS_URL, {
      author: owner,
      commentary,
      // Cadence's connections and public are LinkedIn's CONNECTIONS and PUBLIC.
      visibility: input.visibility.toUpperCase(),
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: upload.video } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    if (!post.ok) throw await linkedinError(post, m().linkedin.postRefused);
    const postUrn = post.headers.get('x-restli-id');
    // The post is out: an error now would have the person post it twice.
    return { url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : null, visibility: input.visibility };
  }

  /** Who the token belongs to; `sub` is the person id that owns the video and signs the post. */
  private async member(access: string): Promise<{ sub: string; identity: NetworkIdentity }> {
    const res = await this.http(USERINFO_URL, { headers: { Authorization: `Bearer ${access}` } });
    if (!res.ok) throw await linkedinError(res, m().linkedin.profileUnavailable);
    const data = (await res.json()) as { sub: string; name: string; picture?: string };
    // The public profile address needs a scope self-serve apps do not get: the name opens the member's own feed.
    return { sub: data.sub, identity: { name: data.name, url: 'https://www.linkedin.com/feed/', avatar: data.picture ?? null } };
  }

  /** Posting before LinkedIn has processed the video would hide a failed processing: wait for it, about 15 minutes at most. */
  private async processed(video: string, headers: Record<string, string>): Promise<void> {
    let waited = 0;
    for (let wait = FIRST_POLL_MS; waited < PROCESSING_MINUTES * 60_000; wait = Math.min(wait * 2, MAX_POLL_MS)) {
      await this.sleep(wait);
      waited += wait;
      const res = await this.http(`${VIDEOS_URL}/${encodeURIComponent(video)}`, { headers });
      if (!res.ok) throw await linkedinError(res, m().linkedin.videoRefused);
      const { status, processingFailureReason } = (await res.json()) as { status?: string; processingFailureReason?: string };
      if (status === 'AVAILABLE') return;
      if (status === 'PROCESSING_FAILED') {
        throw new HttpError(422, m().linkedin.processingFailed(processingFailureReason ?? status));
      }
    }
    throw new HttpError(504, m().linkedin.stillProcessing(PROCESSING_MINUTES));
  }
}

/** LinkedIn's "little" text format: every reserved character is escaped, except the # that starts a hashtag. */
function little(text: string): string {
  // A # inside a word or a link (guide#export, C#9) is no hashtag.
  return text.replace(/[|{}@[\]()<>\\*_~]|(?<=[\p{L}\p{N}/])#|#(?![\p{L}\p{N}])/gu, '\\$&');
}

/** LinkedIn's error in the interface language: what someone can act on, else LinkedIn's own words. */
async function linkedinError(res: Response, what: (detail: string) => string): Promise<HttpError> {
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  const detail = data?.message ?? m().linkedin.httpStatus(res.status);
  if (res.status === 401) return new HttpError(401, m().linkedin.expired);
  if (res.status === 403) return new HttpError(403, m().linkedin.forbidden(detail));
  if (res.status === 426) return new HttpError(502, m().linkedin.outdated);
  if (res.status === 429) return new HttpError(429, m().linkedin.quota);
  return new HttpError(502, what(detail));
}
