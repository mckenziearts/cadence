// TikTok's OAuth and inbox upload against a fake fetch and a fake clock: no request leaves the machine.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { TikTokNetwork } from '../../server/networks/tiktok';
import { rejectsWithStatus } from './helpers';

const app = { clientId: 'key-1', clientSecret: 'secret-1' };
const tokens = { access: 'a1', refresh: 'r1', expiresAt: Date.now() + 3_600_000 };
const MB = 1_000_000;
/** Three 10 MB chunks, the last one with the 1000 bytes left over. */
const BIG = 30 * MB + 1000;
const SMALL = 3 * MB;
const UPLOAD_URL = 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t1';
const REDIRECT = 'http://127.0.0.1:5310/oauth/tiktok/callback';

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
}

function tiktok(respond: (req: Sent, index: number) => Response) {
  const sent: Sent[] = [];
  const naps: number[] = [];
  const network = new TikTokNetwork(
    async (url, init = {}) => {
      const req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body };
      sent.push(req);
      return respond(req, sent.length - 1);
    },
    async (ms) => void naps.push(ms),
  );
  return { network, sent, naps };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
/** TikTok's API v2 answers. */
const ok = (data: unknown) => json({ data, error: { code: 'ok', message: '', log_id: 'log-1' } });
const refused = (status: number, code: string, message = '') => json({ error: { code, message, log_id: 'log-1' } }, status);
const granted = (access: string, refresh: string, scope = 'user.info.basic,video.upload') =>
  json({ access_token: access, refresh_token: refresh, expires_in: 86_400, refresh_expires_in: 31_536_000, scope });
const drafted = () => ok({ publish_id: 'v_inbox_file~v2.1', upload_url: UPLOAD_URL });
const stored = (status: number) => new Response(null, { status });
const state = (status: string, more: object = {}) => ok({ status, ...more });
const form = (body: RequestInit['body']) => Object.fromEntries(body as URLSearchParams);

let dir: string;
let big: string;
let small: string;
/** Random bytes: a chunk read at the wrong offset cannot match. */
const bytes = randomBytes(BIG);

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-tiktok-'));
  big = path.join(dir, 'big.mp4');
  small = path.join(dir, 'small.mp4');
  await fs.writeFile(big, bytes);
  await fs.writeFile(small, bytes.subarray(0, SMALL));
});

after(() => fs.rm(dir, { recursive: true, force: true }));

function publish(network: TikTokNetwork, file: string, size: number, progress: number[] = []) {
  return network.publish({
    tokens,
    file,
    size,
    title: '',
    description: '',
    visibility: 'draft',
    onProgress: (sent) => void progress.push(sent),
  });
}

/** Init, one PUT, then the status TikTok gives. */
const uploaded = (status: () => Response) =>
  tiktok((req, i) => (i === 0 ? drafted() : req.method === 'PUT' ? stored(201) : status()));

test('asks for the consent with PKCE, its challenge in hex as TikTok wants it, back to the given address', () => {
  const { network } = tiktok(() => json({}));
  const verifier = 'v'.repeat(64);
  const url = new URL(
    network.authorizeUrl(app, {
      redirectUri: REDIRECT,
      state: 's1',
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_key: 'key-1',
    response_type: 'code',
    scope: 'user.info.basic,video.upload',
    redirect_uri: REDIRECT,
    state: 's1',
    code_challenge: createHash('sha256').update(verifier).digest('hex'),
    code_challenge_method: 'S256',
  });
});

test('trades the code and its verifier for tokens, then names the account', async () => {
  const { network, sent } = tiktok((req) =>
    req.url === 'https://open.tiktokapis.com/v2/oauth/token/'
      ? granted('a1', 'r1')
      : ok({ user: { display_name: 'Lumen', avatar_url: 'https://p16.tiktokcdn.test/a.jpeg' } }),
  );
  const before = Date.now();
  const result = await network.connect(app, { redirectUri: REDIRECT, code: 'c', verifier: 'v' });
  assert.deepEqual(result.identity, {
    name: 'Lumen',
    url: 'https://www.tiktok.com/',
    avatar: 'https://p16.tiktokcdn.test/a.jpeg',
  });
  assert.equal(result.tokens.access, 'a1');
  assert.equal(result.tokens.refresh, 'r1');
  assert.ok(result.tokens.expiresAt >= before + 86_400_000);
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(form(sent[0].body), {
    client_key: 'key-1',
    client_secret: 'secret-1',
    grant_type: 'authorization_code',
    code: 'c',
    code_verifier: 'v',
    redirect_uri: REDIRECT,
  });
  assert.equal(sent[1].url, 'https://open.tiktokapis.com/v2/user/info/?fields=display_name,avatar_url');
  assert.equal(sent[1].method, 'GET');
  assert.equal(sent[1].headers.get('authorization'), 'Bearer a1');
});

test('a consent without the upload permission is refused before naming the account', async () => {
  const { network, sent } = tiktok(() => granted('a1', 'r1', 'user.info.basic'));
  await rejectsWithStatus(
    network.connect(app, { redirectUri: REDIRECT, code: 'c', verifier: 'v' }),
    403,
    /ajoutez le scope video\.upload/,
  );
  assert.equal(sent.length, 1);
});

test('wrong keys, a refused code and other sign-in errors say what to do', async () => {
  const answers = [
    json({ error: 'invalid_client', error_description: 'Client key or secret is incorrect.' }, 401),
    // Whatever the HTTP status, the body decides.
    json({ error: 'invalid_grant', error_description: 'Authorization code is expired.' }),
    json({ error: 'invalid_request', error_description: 'Redirect_uri is not matched with the uri when requesting code.' }, 400),
    new Response('<html>Bad gateway</html>', { status: 502 }),
  ];
  const { network } = tiktok((_req, i) => answers[i]);
  const input = { redirectUri: REDIRECT, code: 'c', verifier: 'v' };
  await rejectsWithStatus(network.connect(app, input), 400, /vérifiez la Client key/);
  await rejectsWithStatus(network.connect(app, input), 401, /relancez la connexion/);
  await rejectsWithStatus(network.connect(app, input), 502, /TikTok a répondu : Redirect_uri is not matched/);
  await rejectsWithStatus(network.connect(app, input), 502, /TikTok a répondu : erreur 502/);
});

test('a refresh keeps the refresh token TikTok sends back; a revoked one asks to reconnect', async () => {
  const { network, sent } = tiktok((_req, i) =>
    i === 0
      ? granted('a2', 'r2')
      : json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' }, 400),
  );
  const next = await network.refresh(app, tokens);
  assert.equal(next.access, 'a2');
  assert.equal(next.refresh, 'r2');
  assert.deepEqual(form(sent[0].body), {
    client_key: 'key-1',
    client_secret: 'secret-1',
    grant_type: 'refresh_token',
    refresh_token: 'r1',
  });
  await rejectsWithStatus(network.refresh(app, tokens), 401, /reconnectez votre compte dans le Profil/);
  await rejectsWithStatus(network.refresh(app, { ...tokens, refresh: null }), 401, /reconnectez/);
  assert.equal(sent.length, 2);
});

test('sends 10 MB chunks, the remainder on the last one, then waits until the draft is in the inbox', async () => {
  const { network, sent, naps } = tiktok((req, i) => {
    if (i === 0) return drafted();
    if (req.method === 'PUT') return stored(i === 3 ? 201 : 206);
    return state(i === 4 ? 'PROCESSING_UPLOAD' : 'SEND_TO_USER_INBOX', { uploaded_bytes: BIG });
  });
  const progress: number[] = [];
  assert.deepEqual(await publish(network, big, BIG, progress), { url: null, visibility: 'draft' });

  const [init, ...rest] = sent;
  assert.equal(init.url, 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.get('authorization'), 'Bearer a1');
  assert.equal(init.headers.get('content-type'), 'application/json; charset=UTF-8');
  assert.deepEqual(JSON.parse(init.body as string), {
    source_info: { source: 'FILE_UPLOAD', video_size: BIG, chunk_size: 10 * MB, total_chunk_count: 3 },
  });

  const puts = rest.slice(0, 3);
  assert.deepEqual(
    puts.map((put) => put.headers.get('content-range')),
    [`bytes 0-${10 * MB - 1}/${BIG}`, `bytes ${10 * MB}-${20 * MB - 1}/${BIG}`, `bytes ${20 * MB}-${BIG - 1}/${BIG}`],
  );
  for (const [i, put] of puts.entries()) {
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, UPLOAD_URL);
    assert.equal(put.headers.get('content-type'), 'video/mp4');
    assert.equal(put.headers.get('authorization'), null, 'the upload address carries its own token');
    assert.ok((put.body as Buffer).equals(bytes.subarray(i * 10 * MB, i === 2 ? BIG : (i + 1) * 10 * MB)), `chunk ${i}`);
  }
  assert.deepEqual(progress, [10 * MB, 20 * MB, BIG]);

  const polls = rest.slice(3);
  assert.equal(polls.length, 2);
  for (const poll of polls) {
    assert.equal(poll.url, 'https://open.tiktokapis.com/v2/post/publish/status/fetch/');
    assert.equal(poll.headers.get('authorization'), 'Bearer a1');
    assert.deepEqual(JSON.parse(poll.body as string), { publish_id: 'v_inbox_file~v2.1' });
  }
  assert.deepEqual(naps, [5000, 5000]);
});

test('a small video goes whole in one request; a draft already posted counts as delivered', async () => {
  const { network, sent } = uploaded(() => state('PUBLISH_COMPLETE'));
  const progress: number[] = [];
  assert.deepEqual(await publish(network, small, SMALL, progress), { url: null, visibility: 'draft' });
  assert.deepEqual(JSON.parse(sent[0].body as string).source_info, {
    source: 'FILE_UPLOAD',
    video_size: SMALL,
    chunk_size: SMALL,
    total_chunk_count: 1,
  });
  assert.equal(sent[1].headers.get('content-range'), `bytes 0-${SMALL - 1}/${SMALL}`);
  assert.ok((sent[1].body as Buffer).equals(bytes.subarray(0, SMALL)));
  assert.deepEqual(progress, [SMALL]);
  assert.equal(sent.length, 3);
});

test('plans the chunks the way TikTok counts them, from a few bytes to its 4 GB limit', async () => {
  const plans: { chunk_size: number; total_chunk_count: number }[] = [];
  const { network } = tiktok((req) => {
    plans.push(JSON.parse(req.body as string).source_info);
    return refused(400, 'invalid_param', 'stop here');
  });
  for (const size of [1000, 4 * 1024 * 1024, 20 * MB - 1, 20 * MB, 4 * 1024 ** 3]) {
    await rejectsWithStatus(publish(network, small, size), 502, /stop here/);
  }
  assert.deepEqual(
    plans.map((plan) => [plan.chunk_size, plan.total_chunk_count]),
    [
      [1000, 1],
      [4 * 1024 * 1024, 1],
      [20 * MB - 1, 1],
      [10 * MB, 2],
      // The last of the 429 chunks holds 14,967,296 bytes: under TikTok's 128 MB.
      [10 * MB, 429],
    ],
  );
});

test("TikTok's refusals read as what to do, else in its own words", async () => {
  const cases: [() => Response, number, RegExp][] = [
    [() => refused(401, 'access_token_invalid', 'Access token is invalid'), 401, /reconnectez votre compte dans le Profil/],
    [() => refused(401, 'scope_not_authorized'), 401, /ajoutez le scope video\.upload/],
    [() => refused(403, 'spam_risk_too_many_pending_share'), 502, /5 brouillons en attente/],
    [() => refused(403, 'spam_risk_user_banned_from_posting'), 502, /interdit pour le moment/],
    [() => refused(429, 'rate_limit_exceeded'), 502, /réessayez dans une minute/],
    [() => refused(500, 'internal_error'), 502, /problème de son côté/],
    // TikTok answers some refusals with a 200: only error.code "ok" means it worked.
    [() => refused(200, 'spam_risk_too_many_posts'), 502, /trop de vidéos/],
    [() => refused(400, 'invalid_param', 'Chunk size is invalid.'), 502, /TikTok a refusé la vidéo : Chunk size is invalid\./],
    [() => new Response('upstream down', { status: 503 }), 502, /TikTok a refusé la vidéo : erreur 503/],
  ];
  for (const [answer, status, message] of cases) {
    const { network, sent } = tiktok(answer);
    await rejectsWithStatus(publish(network, small, SMALL), status, message);
    assert.equal(sent.length, 1, String(message));
  }
});

test('a video TikTok turns down after the upload says why', async () => {
  const failed = (reason: string) => uploaded(() => state('FAILED', { fail_reason: reason })).network;
  await rejectsWithStatus(publish(failed('frame_rate_check_failed'), small, SMALL), 502, /de 23 à 60 images par seconde/);
  await rejectsWithStatus(publish(failed('picture_size_check_failed'), small, SMALL), 502, /de 360 à 4096 pixels/);
  await rejectsWithStatus(publish(failed('auth_removed'), small, SMALL), 401, /reconnectez votre compte/);
  await rejectsWithStatus(publish(failed('spam_risk_text'), small, SMALL), 502, /TikTok a refusé la vidéo : spam_risk_text/);
  // A status call TikTok refuses ends the wait too.
  await rejectsWithStatus(
    publish(uploaded(() => refused(401, 'access_token_invalid')).network, small, SMALL),
    401,
    /reconnectez/,
  );
});

test('stops waiting after 10 minutes of processing, and says the draft may still come', async () => {
  const { network, sent, naps } = uploaded(() => state('PROCESSING_UPLOAD', { uploaded_bytes: SMALL }));
  await rejectsWithStatus(publish(network, small, SMALL), 504, /au bout de 10 minutes : si elle n’arrive pas/);
  assert.equal(naps.length, 120);
  assert.equal(
    naps.reduce((total, ms) => total + ms, 0),
    10 * 60_000,
  );
  assert.equal(sent.length, 2 + 120);
});

test('stops waiting when the access token ends during the upload: a refused poll would read as a lost connection', async () => {
  const { network, naps } = uploaded(() => state('PROCESSING_UPLOAD'));
  const ending = { ...tokens, expiresAt: Date.now() + 1000 };
  await rejectsWithStatus(
    network.publish({
      tokens: ending,
      file: small,
      size: SMALL,
      title: '',
      description: '',
      visibility: 'draft',
      onProgress() {},
    }),
    504,
    /si elle n’arrive pas/,
  );
  assert.deepEqual(naps, []);
});

test('a chunk TikTok fails on its side is sent again', async () => {
  const replies = [drafted(), stored(503), stored(201), state('SEND_TO_USER_INBOX')];
  const { network, sent } = tiktok((_req, i) => replies[i]);
  assert.deepEqual(await publish(network, small, SMALL), { url: null, visibility: 'draft' });
  assert.equal(sent.filter((r) => r.method === 'PUT').length, 2);
});

test('a chunk TikTok does not take stops the upload, with nothing to wait for', async () => {
  const { network, sent, naps } = tiktok((_req, i) => (i === 0 ? drafted() : stored(i === 1 ? 206 : 403)));
  const progress: number[] = [];
  await rejectsWithStatus(publish(network, big, BIG, progress), 502, /erreur 403\) : relancez la publication/);
  assert.equal(sent.length, 3);
  assert.deepEqual(progress, [10 * MB]);
  assert.deepEqual(naps, []);
});

test('revokes with the access token, renewed first once it has run out', async () => {
  const live = tiktok(() => new Response(null));
  await live.network.revoke(app, tokens);
  assert.equal(live.sent.length, 1);
  assert.equal(live.sent[0].url, 'https://open.tiktokapis.com/v2/oauth/revoke/');
  assert.equal(live.sent[0].method, 'POST');
  assert.deepEqual(form(live.sent[0].body), { client_key: 'key-1', client_secret: 'secret-1', token: 'a1' });

  const stale = tiktok((_req, i) => (i === 0 ? granted('a2', 'r2') : new Response(null)));
  await stale.network.revoke(app, { ...tokens, expiresAt: Date.now() - 1000 });
  assert.equal(stale.sent[0].url, 'https://open.tiktokapis.com/v2/oauth/token/');
  assert.equal(form(stale.sent[0].body).refresh_token, 'r1');
  assert.deepEqual(form(stale.sent[1].body), { client_key: 'key-1', client_secret: 'secret-1', token: 'a2' });
});
