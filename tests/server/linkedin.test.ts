// LinkedIn's OAuth, multipart video upload and post against a fake fetch: no request leaves the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Network } from '../../server/contracts';
import { LinkedInNetwork } from '../../server/networks/linkedin';
import type { Visibility } from '../../src/shared/types';
import { rejectsWithStatus } from './helpers';

const app = { clientId: 'client-1', clientSecret: 'secret-1' };
const tokens = { access: 'a1', refresh: null, expiresAt: Date.now() + 3_600_000 };
const REDIRECT = 'http://localhost:5310/oauth/linkedin/callback';
const USERINFO = 'https://api.linkedin.com/v2/userinfo';
const VIDEO = 'urn:li:video:C5505AQH';
/** LinkedIn's parts are 4 MiB: this file needs two, the second one 1000 bytes. */
const PART = 4 * 1024 * 1024;
const SIZE = PART + 1000;

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
}

function linkedin(respond: (req: Sent) => Response) {
  const sent: Sent[] = [];
  const waits: number[] = [];
  // Typed as the contract: called the way the accounts and the publisher call it.
  const network: Network = new LinkedInNetwork(
    async (url, init = {}) => {
      const req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body };
      sent.push(req);
      return respond(req);
    },
    async (ms) => void waits.push(ms),
  );
  return { network, sent, waits };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const form = (body: RequestInit['body']) => Object.fromEntries(body as URLSearchParams);
const apiError = (status: number, code: string, message: string) => json({ status, code, message }, status);
const isPoll = (req: Sent) => req.url.startsWith('https://api.linkedin.com/rest/videos/');

/**
 * LinkedIn as its docs show it: the last part reaching past the end of the file (as in its own sample), the video
 * processed after the given statuses, the post's id in x-restli-id.
 */
function api(statuses = ['PROCESSING', 'AVAILABLE'], postId: string | null = 'urn:li:share:7001') {
  return (req: Sent): Response => {
    if (req.url === USERINFO) return json({ sub: 'p1', name: 'Ada Lovelace', picture: 'https://media.licdn.test/ada.jpg' });
    if (req.url.endsWith('?action=initializeUpload')) {
      return json({
        value: {
          video: VIDEO,
          uploadToken: 'up-1',
          uploadUrlsExpireAt: 1_633_234_498_985,
          uploadInstructions: [
            { uploadUrl: 'https://upload.test/part-1', firstByte: 0, lastByte: PART - 1 },
            { uploadUrl: 'https://upload.test/part-2', firstByte: PART, lastByte: 2 * PART - 1 },
          ],
        },
      });
    }
    if (req.url === 'https://upload.test/part-1') return new Response(null, { headers: { ETag: '"etag-1"' } });
    if (req.url === 'https://upload.test/part-2')
      return new Response(null, { headers: { ETag: '/ambry-video/signedId/AQ2.bin' } });
    if (req.url.endsWith('?action=finalizeUpload')) return new Response(null);
    if (isPoll(req)) return json({ id: VIDEO, status: statuses.shift() });
    if (req.url === 'https://api.linkedin.com/rest/posts') {
      return new Response(null, { status: 201, headers: postId ? { 'x-restli-id': postId } : {} });
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  };
}

let dir: string;
let file: string;
let bytes: Buffer;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-linkedin-'));
  file = path.join(dir, 'teaser.mp4');
  bytes = Buffer.alloc(SIZE, 1).fill(2, PART);
  await fs.writeFile(file, bytes);
});

after(() => fs.rm(dir, { recursive: true, force: true }));

function publish(network: Network, description = 'Le teaser.', visibility: Visibility = 'connections', progress: number[] = []) {
  return network.publish({
    tokens,
    file,
    size: SIZE,
    title: '',
    description,
    visibility,
    onProgress: (sent) => void progress.push(sent),
  });
}

test('asks for the consent without PKCE, back to the localhost address', () => {
  const { network } = linkedin(() => json({}));
  assert.equal(network.redirectHost, 'localhost');
  const url = new URL(network.authorizeUrl(app, { redirectUri: REDIRECT, state: 's1', challenge: 'c1' }));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    state: 's1',
    scope: 'openid profile w_member_social',
  });
});

test('trades the code with the secret, then names the member', async () => {
  const { network, sent } = linkedin((req) =>
    req.url === USERINFO
      ? api()(req)
      : json({ access_token: 'a1', expires_in: 5_184_000, scope: 'email,openid,profile,w_member_social', id_token: 'jwt' }),
  );
  const before = Date.now();
  const result = await network.connect(app, { redirectUri: REDIRECT, code: 'c', verifier: 'v' });
  assert.deepEqual(result.identity, {
    name: 'Ada Lovelace',
    url: 'https://www.linkedin.com/feed/',
    avatar: 'https://media.licdn.test/ada.jpg',
  });
  assert.equal(result.tokens.access, 'a1');
  assert.equal(result.tokens.refresh, null);
  assert.ok(result.tokens.expiresAt >= before + 60 * 86_400_000);
  assert.equal(sent[0].url, 'https://www.linkedin.com/oauth/v2/accessToken');
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(form(sent[0].body), {
    grant_type: 'authorization_code',
    code: 'c',
    client_id: 'client-1',
    client_secret: 'secret-1',
    redirect_uri: REDIRECT,
  });
  assert.equal(sent[1].url, USERINFO);
  assert.equal(sent[1].headers.get('authorization'), 'Bearer a1');
});

test('an app without "Share on LinkedIn" is named before any upload', async () => {
  const { network, sent } = linkedin(() => json({ access_token: 'a1', expires_in: 5_184_000, scope: 'openid profile' }));
  await rejectsWithStatus(
    network.connect(app, { redirectUri: REDIRECT, code: 'c', verifier: 'v' }),
    400,
    /produit « Share on LinkedIn »/,
  );
  assert.equal(sent.length, 1);
});

test('wrong keys and a refused code say what to do', async () => {
  const keys = linkedin(() => json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401));
  await rejectsWithStatus(
    keys.network.connect(app, { redirectUri: REDIRECT, code: 'c', verifier: 'v' }),
    400,
    /vérifiez le Client ID et le Client Secret/,
  );
  const code = linkedin(() =>
    json(
      { error: 'invalid_redirect_uri', error_description: 'Unable to retrieve access token: authorization code expired' },
      400,
    ),
  );
  await rejectsWithStatus(
    code.network.connect(app, { redirectUri: REDIRECT, code: 'c', verifier: 'v' }),
    502,
    /authorization code expired\) : relancez-la depuis le Profil/,
  );
});

test('no refresh token: the end of the 60 days asks to reconnect', async () => {
  const { network, sent } = linkedin(() => json({}));
  await rejectsWithStatus(
    network.refresh(app, tokens),
    401,
    /reconnectez votre compte dans le Profil \(LinkedIn la limite à 60 jours\)/,
  );
  assert.equal(sent.length, 0);
});

test('uploads the parts LinkedIn asks for, waits for the processing, then posts the escaped text', async () => {
  const { network, sent, waits } = linkedin(api());
  const progress: number[] = [];
  const result = await publish(
    network,
    'Lancement (v2) #motion C# a_b @x [y] {z} <w> *g* ~s~ |p \\ # cadence.dev/guide#export',
    'connections',
    progress,
  );
  assert.deepEqual(result, { url: 'https://www.linkedin.com/feed/update/urn:li:share:7001/', visibility: 'connections' });

  const [me, start, first, second, finish, poll1, poll2, post] = sent;
  assert.equal(sent.length, 8);
  assert.equal(me.url, USERINFO);

  assert.equal(start.url, 'https://api.linkedin.com/rest/videos?action=initializeUpload');
  for (const req of [start, finish, poll1, post]) {
    assert.equal(req.headers.get('authorization'), 'Bearer a1');
    assert.equal(req.headers.get('linkedin-version'), '202609');
    assert.equal(req.headers.get('x-restli-protocol-version'), '2.0.0');
  }
  assert.equal(start.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(start.body as string), {
    initializeUploadRequest: { owner: 'urn:li:person:p1', fileSizeBytes: SIZE, uploadCaptions: false, uploadThumbnail: false },
  });

  assert.equal(first.url, 'https://upload.test/part-1');
  assert.equal(first.method, 'PUT');
  assert.equal(first.headers.get('content-type'), 'application/octet-stream');
  assert.equal(first.headers.get('authorization'), null);
  assert.ok((first.body as Buffer).equals(bytes.subarray(0, PART)));
  assert.equal(second.url, 'https://upload.test/part-2');
  assert.ok((second.body as Buffer).equals(bytes.subarray(PART)));
  assert.equal((second.body as Buffer).length, 1000);
  assert.deepEqual(progress, [PART, SIZE]);

  assert.equal(finish.url, 'https://api.linkedin.com/rest/videos?action=finalizeUpload');
  assert.deepEqual(JSON.parse(finish.body as string), {
    finalizeUploadRequest: { video: VIDEO, uploadToken: 'up-1', uploadedPartIds: ['etag-1', '/ambry-video/signedId/AQ2.bin'] },
  });

  assert.equal(poll1.url, 'https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3AC5505AQH');
  assert.equal(poll2.url, poll1.url);
  assert.deepEqual(waits, [5_000, 10_000]);

  assert.equal(post.url, 'https://api.linkedin.com/rest/posts');
  assert.deepEqual(JSON.parse(post.body as string), {
    author: 'urn:li:person:p1',
    commentary:
      'Lancement \\(v2\\) #motion C\\# a\\_b \\@x \\[y\\] \\{z\\} \\<w\\> \\*g\\* \\~s\\~ \\|p \\\\ \\# cadence.dev/guide\\#export',
    visibility: 'CONNECTIONS',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { id: VIDEO } },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  });
});

test('a public post without an id in the answer is still a success', async () => {
  const { network, sent } = linkedin(api(['AVAILABLE'], null));
  assert.deepEqual(await publish(network, '', 'public'), { url: null, visibility: 'public' });
  const post = JSON.parse(sent.at(-1)!.body as string);
  assert.equal(post.visibility, 'PUBLIC');
  assert.equal(post.commentary, '');
});

test('a failed processing gives the reason LinkedIn sent, and nothing is posted', async () => {
  const linkedinApi = api();
  const { network, sent } = linkedin((req) =>
    isPoll(req) ? json({ status: 'PROCESSING_FAILED', processingFailureReason: 'unsupported file format' }) : linkedinApi(req),
  );
  await rejectsWithStatus(publish(network), 422, /n’a pas pu traiter la vidéo : unsupported file format/);
  assert.ok(!sent.some((req) => req.url.endsWith('/rest/posts')));
});

test('stops waiting after about 15 minutes of processing, in 32 polls', async () => {
  const { network, sent, waits } = linkedin(api(Array(100).fill('PROCESSING')));
  await rejectsWithStatus(publish(network), 504, /traite encore la vidéo au bout de 15 minutes/);
  assert.equal(sent.filter(isPoll).length, 32);
  assert.deepEqual(waits.slice(0, 5), [5_000, 10_000, 20_000, 30_000, 30_000]);
  const total = waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 15 * 60_000 && total < 16 * 60_000);
  assert.ok(!sent.some((req) => req.url.endsWith('/rest/posts')));
});

test('an expired token, a missing product, the quota and an old API version read as what to do', async () => {
  const failing = (match: (req: Sent) => boolean, answer: Response) => {
    const linkedinApi = api();
    return linkedin((req) => (match(req) ? answer : linkedinApi(req))).network;
  };
  const initialize = (req: Sent) => req.url.endsWith('?action=initializeUpload');
  await rejectsWithStatus(
    publish(failing((req) => req.url === USERINFO, apiError(401, 'INVALID_ACCESS_TOKEN', 'Invalid access token'))),
    401,
    /reconnectez votre compte/,
  );
  await rejectsWithStatus(
    publish(failing(initialize, apiError(403, 'ACCESS_DENIED', 'Not enough permissions to access: POST /videos'))),
    403,
    /Not enough permissions to access: POST \/videos\) : vérifiez que l’app a les produits « Share on LinkedIn »/,
  );
  await rejectsWithStatus(publish(failing(initialize, apiError(429, 'TOO_MANY_REQUESTS', 'throttled'))), 429, /réessayez demain/);
  await rejectsWithStatus(
    publish(failing(initialize, apiError(426, 'NONEXISTENT_VERSION', 'Requested version 20260901 is not active'))),
    502,
    /mettez Cadence à jour/,
  );
  await rejectsWithStatus(
    publish(failing(initialize, apiError(400, 'INVALID_URN_TYPE', 'owner value must be a person URN'))),
    502,
    /LinkedIn a refusé la vidéo : owner value must be a person URN/,
  );
  await rejectsWithStatus(
    publish(failing((req) => req.url === 'https://upload.test/part-2', new Response(null, { status: 500 }))),
    502,
    /L’envoi de la vidéo à LinkedIn a échoué \(erreur 500\)/,
  );
  await rejectsWithStatus(
    publish(failing((req) => req.url.endsWith('/rest/posts'), apiError(422, 'UNPROCESSABLE_ENTITY', 'Content is a duplicate'))),
    502,
    /LinkedIn a refusé le post : Content is a duplicate/,
  );
});

test('revoking sends nothing: LinkedIn has no endpoint for it', async () => {
  const { network, sent } = linkedin(() => json({}));
  await network.revoke(app, tokens);
  assert.equal(sent.length, 0);
});
