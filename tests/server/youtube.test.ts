// YouTube's OAuth and resumable upload against a fake fetch: no request leaves the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { YouTubeNetwork } from '../../server/networks/youtube';
import { rejectsWithStatus } from './helpers';

const app = { clientId: 'client-1', clientSecret: 'secret-1' };
const tokens = { access: 'a1', refresh: 'r1', expiresAt: Date.now() + 3_600_000 };
const MIB = 1024 * 1024;
/** One chunk is 8 MiB: this file needs two. */
const BIG = 8 * MIB + 1000;

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
}

function youtube(respond: (req: Sent, index: number) => Response) {
  const sent: Sent[] = [];
  const network = new YouTubeNetwork(async (url, init = {}) => {
    const req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body };
    sent.push(req);
    return respond(req, sent.length - 1);
  });
  return { network, sent };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const resume = (range?: string) => new Response(null, { status: 308, headers: range ? { Range: range } : {} });
const form = (body: RequestInit['body']) => Object.fromEntries(body as URLSearchParams);

let dir: string;
let big: string;
let small: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-youtube-'));
  big = path.join(dir, 'big.mp4');
  small = path.join(dir, 'small.mp4');
  await fs.writeFile(big, Buffer.alloc(BIG, 7));
  await fs.writeFile(small, Buffer.alloc(2 * MIB, 3));
});

after(() => fs.rm(dir, { recursive: true, force: true }));

function publish(network: YouTubeNetwork, file: string, size: number, progress: number[] = []) {
  return network.publish({
    tokens,
    file,
    size,
    title: 'Lumen teaser',
    description: 'Le teaser.',
    visibility: 'public',
    onProgress: (sent) => void progress.push(sent),
  });
}

test('asks for an offline consent with PKCE, back to the given address', () => {
  const { network } = youtube(() => json({}));
  const url = new URL(
    network.authorizeUrl(app, { redirectUri: 'http://127.0.0.1:5310/oauth/youtube/callback', state: 's1', challenge: 'c1' }),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(
    { ...params, scope: params.scope.split(' ') },
    {
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:5310/oauth/youtube/callback',
      response_type: 'code',
      scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
      access_type: 'offline',
      prompt: 'consent',
      state: 's1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    },
  );
});

test('trades the code and its verifier for tokens, then names the channel', async () => {
  const { network, sent } = youtube((req) =>
    req.url.startsWith('https://oauth2.googleapis.com/token')
      ? json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
      : json({
          items: [
            {
              id: 'UC1',
              snippet: { title: 'Lumen', customUrl: '@lumen', thumbnails: { default: { url: 'https://yt3.test/a.jpg' } } },
            },
          ],
        }),
  );
  const before = Date.now();
  const result = await network.connect(app, {
    redirectUri: 'http://127.0.0.1:5310/oauth/youtube/callback',
    code: 'c',
    verifier: 'v',
  });
  assert.deepEqual(result.identity, {
    name: 'Lumen',
    url: 'https://www.youtube.com/@lumen',
    avatar: 'https://yt3.test/a.jpg',
  });
  assert.equal(result.tokens.access, 'a1');
  assert.equal(result.tokens.refresh, 'r1');
  assert.ok(result.tokens.expiresAt >= before + 3_600_000);
  assert.deepEqual(form(sent[0].body), {
    client_id: 'client-1',
    client_secret: 'secret-1',
    grant_type: 'authorization_code',
    code: 'c',
    code_verifier: 'v',
    redirect_uri: 'http://127.0.0.1:5310/oauth/youtube/callback',
  });
  assert.equal(sent[1].headers.get('authorization'), 'Bearer a1');
});

test('a Google account without a channel is told to create one', async () => {
  const { network } = youtube((req) =>
    req.url.includes('/token') ? json({ access_token: 'a1', expires_in: 3600 }) : json({ items: [] }),
  );
  await rejectsWithStatus(
    network.connect(app, { redirectUri: 'http://x/cb', code: 'c', verifier: 'v' }),
    400,
    /pas de chaîne YouTube/,
  );
});

test('wrong keys and a refused code say what to do', async () => {
  const { network } = youtube((_req, i) => json({ error: i === 0 ? 'invalid_client' : 'invalid_grant' }, 400));
  await rejectsWithStatus(
    network.connect(app, { redirectUri: 'http://x/cb', code: 'c', verifier: 'v' }),
    400,
    /vérifiez l’ID client/,
  );
  await rejectsWithStatus(
    network.connect(app, { redirectUri: 'http://x/cb', code: 'c', verifier: 'v' }),
    401,
    /relancez la connexion/,
  );
});

test('a refresh keeps the refresh token; a revoked one asks to reconnect', async () => {
  const { network, sent } = youtube((_req, i) =>
    i === 0 ? json({ access_token: 'a2', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400),
  );
  const next = await network.refresh(app, tokens);
  assert.equal(next.access, 'a2');
  assert.equal(next.refresh, 'r1');
  assert.deepEqual(form(sent[0].body), {
    client_id: 'client-1',
    client_secret: 'secret-1',
    grant_type: 'refresh_token',
    refresh_token: 'r1',
  });
  await rejectsWithStatus(network.refresh(app, tokens), 401, /reconnectez votre chaîne dans le Profil/);
  await rejectsWithStatus(network.refresh(app, { ...tokens, refresh: null }), 401, /reconnecte/);
});

test('uploads in 8 MiB chunks after a resumable session, with the title and the visibility', async () => {
  const { network, sent } = youtube((req, i) => {
    if (i === 0) return new Response(null, { status: 200, headers: { Location: 'https://upload.test/session-1' } });
    if (i === 1) return resume(`bytes=0-${8 * MIB - 1}`);
    return json({ id: 'vid1', status: { privacyStatus: 'private' } });
  });
  const progress: number[] = [];
  const result = await publish(network, big, BIG, progress);
  assert.deepEqual(result, { url: 'https://youtu.be/vid1', visibility: 'private' });

  const [start, first, second] = sent;
  assert.equal(start.url, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status');
  assert.equal(start.headers.get('authorization'), 'Bearer a1');
  assert.equal(start.headers.get('x-upload-content-length'), String(BIG));
  assert.equal(start.headers.get('x-upload-content-type'), 'video/mp4');
  assert.deepEqual(JSON.parse(start.body as string), {
    snippet: { title: 'Lumen teaser', description: 'Le teaser.', categoryId: '22' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
  });
  assert.equal(first.url, 'https://upload.test/session-1');
  assert.equal(first.method, 'PUT');
  assert.equal(first.headers.get('content-range'), `bytes 0-${8 * MIB - 1}/${BIG}`);
  assert.equal((first.body as Buffer).length, 8 * MIB);
  assert.equal(second.headers.get('content-range'), `bytes ${8 * MIB}-${BIG - 1}/${BIG}`);
  assert.equal((second.body as Buffer).length, 1000);
  assert.deepEqual(progress, [8 * MIB, BIG]);
});

test('resumes after what Google kept, and stops when it keeps nothing', async () => {
  const partial = youtube((_req, i) => {
    if (i === 0) return new Response(null, { headers: { Location: 'https://upload.test/s' } });
    if (i === 1) return resume(`bytes=0-${MIB - 1}`);
    return json({ id: 'vid2', status: { privacyStatus: 'public' } });
  });
  assert.deepEqual(await publish(partial.network, small, 2 * MIB), { url: 'https://youtu.be/vid2', visibility: 'public' });
  assert.equal(partial.sent[2].headers.get('content-range'), `bytes ${MIB}-${2 * MIB - 1}/${2 * MIB}`);

  const stuck = youtube((_req, i) =>
    i === 0 ? new Response(null, { headers: { Location: 'https://upload.test/s' } }) : resume(),
  );
  await rejectsWithStatus(publish(stuck.network, small, 2 * MIB), 502, /ne reçoit plus la vidéo/);
  assert.equal(stuck.sent.length, 2);
});

test('the daily quota, an expired connection and a disabled API read as what to do', async () => {
  const error = (status: number, reason: string) =>
    json({ error: { code: status, message: reason, errors: [{ reason }] } }, status);
  await rejectsWithStatus(publish(youtube(() => error(403, 'quotaExceeded')).network, small, 2 * MIB), 429, /Quota/);
  await rejectsWithStatus(publish(youtube(() => error(401, 'authError')).network, small, 2 * MIB), 401, /reconnecte/);
  await rejectsWithStatus(publish(youtube(() => error(403, 'accessNotConfigured')).network, small, 2 * MIB), 400, /activez-la/);
  await rejectsWithStatus(publish(youtube(() => error(400, 'invalidTitle')).network, small, 2 * MIB), 502, /invalidTitle/);
});

test('refuses < and > before sending anything', async () => {
  const { network, sent } = youtube(() => json({}));
  await rejectsWithStatus(
    network.publish({
      tokens,
      file: small,
      size: 2 * MIB,
      title: 'a <b>',
      description: '',
      visibility: 'private',
      onProgress() {},
    }),
    400,
    /< et >/,
  );
  assert.equal(sent.length, 0);
});

test('revokes the refresh token', async () => {
  const { network, sent } = youtube(() => new Response(null));
  await network.revoke(app, tokens);
  assert.equal(sent[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.deepEqual(form(sent[0].body), { token: 'r1' });
});
