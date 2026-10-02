// Instagram through Facebook Login and rupload against a fake fetch: no request leaves the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { getRequestListener } from '@hono/node-server';
import { InstagramNetwork } from '../../server/networks/instagram';
import { rejectsWithStatus } from './helpers';

const GRAPH = 'https://graph.facebook.com/v26.0';
const UPLOAD = 'https://rupload.facebook.com/ig-api-upload/v26.0/c1';
const app = { clientId: 'app-1', clientSecret: 'secret-1' };
const tokens = { access: 'a1', refresh: null, expiresAt: Date.now() + 3_600_000, account: '1780' };
const MIB = 1024 * 1024;
/** Chunks are 1 MiB: this file needs three. */
const BIG = 2 * MIB + 1000;
const SCOPES = [
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
  'pages_read_engagement',
  'pages_show_list',
];

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  /** Sizes of the chunks of a streamed body, and its first byte. */
  chunks: number[];
  first?: number;
}

function instagram(respond: (req: Sent, index: number) => Response) {
  const sent: Sent[] = [];
  const waits: number[] = [];
  const network = new InstagramNetwork(
    async (url, init = {}) => {
      const req: Sent = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, chunks: [] };
      if (init.body instanceof ReadableStream) {
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          req.first ??= read.value[0];
          req.chunks.push(read.value.length);
        }
      }
      sent.push(req);
      return respond(req, sent.length - 1);
    },
    async (ms) => void waits.push(ms),
  );
  return { network, sent, waits };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const graphError = (code: number, message: string, subcode?: number) =>
  json({ error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'f1' } }, 400);
const form = (body: RequestInit['body']) => Object.fromEntries(body as URLSearchParams);
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const pages = (...usernames: string[]) =>
  json({
    data: [
      { id: 'p0' },
      ...usernames.map((username, i) => ({
        id: `p${i + 1}`,
        instagram_business_account: { id: `178${i}`, username, profile_picture_url: `https://cdn.test/${username}.jpg` },
      })),
    ],
  });
const granted = (...declined: string[]) =>
  json({ data: SCOPES.map((permission) => ({ permission, status: declined.includes(permission) ? 'declined' : 'granted' })) });

/** The happy path of a publication, request by request; `override` swaps one answer. */
function flow(override: Record<number, Response | (() => Response)> = {}) {
  const answers: (() => Response)[] = [
    () => json({ id: 'c1', uri: UPLOAD }),
    () => json({ success: true, message: 'Upload successful.' }),
    () => json({ id: 'c1', status_code: 'IN_PROGRESS', status: 'In Progress' }),
    () =>
      json({ id: 'c1', status_code: 'FINISHED', status: 'Finished: Media has been uploaded and it is ready to be published.' }),
    () => json({ id: 'm1' }),
    () => json({ permalink: 'https://www.instagram.com/reel/DcY8KVBCml7/', id: 'm1' }),
  ];
  return (_req: Sent, i: number) => {
    const answer = override[i] ?? answers[i];
    return typeof answer === 'function' ? answer() : answer;
  };
}

let dir: string;
let big: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-instagram-'));
  big = path.join(dir, 'big.mp4');
  // Each byte tells its position: a resumed body shows where it starts.
  const bytes = Buffer.alloc(BIG);
  for (let i = 0; i < BIG; i++) bytes[i] = i % 251;
  await fs.writeFile(big, bytes);
});

after(() => fs.rm(dir, { recursive: true, force: true }));

function publish(network: InstagramNetwork, progress: number[] = [], size = BIG) {
  return network.publish({
    tokens,
    file: big,
    size,
    title: '',
    description: 'Le teaser. #lumen',
    visibility: 'public',
    onProgress: (sent) => void progress.push(sent),
  });
}

test('asks Facebook Login for the Instagram permissions, back to localhost', () => {
  const { network } = instagram(() => json({}));
  assert.equal(network.redirectHost, 'localhost');
  const url = new URL(
    network.authorizeUrl(app, { redirectUri: 'http://localhost:5310/oauth/instagram/callback', state: 's1', challenge: 'c1' }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(
    { ...params, scope: params.scope.split(',') },
    {
      client_id: 'app-1',
      redirect_uri: 'http://localhost:5310/oauth/instagram/callback',
      response_type: 'code',
      scope: SCOPES,
      state: 's1',
      auth_type: 'rerequest',
    },
  );
});

test('trades the code for a long-lived token, then names the first Instagram account of the granted Pages', async () => {
  const { network, sent } = instagram((req, i) => {
    if (i === 0) return json({ access_token: 'short', token_type: 'bearer', expires_in: 5000 });
    if (i === 1) return json({ access_token: 'long', token_type: 'bearer', expires_in: 5_183_944 });
    return req.url.includes('/me/permissions') ? granted() : pages('lumen', 'autre');
  });
  const start = Date.now();
  const result = await network.connect(app, {
    redirectUri: 'http://localhost:5310/oauth/instagram/callback',
    code: 'code-1',
    verifier: 'v',
  });
  assert.deepEqual(result.identity, {
    name: '@lumen',
    url: 'https://www.instagram.com/lumen/',
    avatar: 'https://cdn.test/lumen.jpg',
  });
  assert.equal(result.tokens.access, 'long');
  assert.equal(result.tokens.refresh, null);
  // The account publishing goes to, whatever order Meta lists the Pages in later.
  assert.equal(result.tokens.account, '1780');
  assert.ok(result.tokens.expiresAt >= start + 5_183_944_000);

  const [code, exchange, permissions, accounts] = sent;
  assert.equal(code.url.split('?')[0], `${GRAPH}/oauth/access_token`);
  assert.deepEqual(query(code.url), {
    client_id: 'app-1',
    client_secret: 'secret-1',
    redirect_uri: 'http://localhost:5310/oauth/instagram/callback',
    code: 'code-1',
  });
  assert.deepEqual(query(exchange.url), {
    client_id: 'app-1',
    client_secret: 'secret-1',
    grant_type: 'fb_exchange_token',
    fb_exchange_token: 'short',
  });
  assert.equal(permissions.url, `${GRAPH}/me/permissions`);
  assert.equal(permissions.headers.get('authorization'), 'Bearer long');
  assert.equal(accounts.url.split('?')[0], `${GRAPH}/me/accounts`);
  assert.equal(query(accounts.url).fields, 'instagram_business_account{id,username,profile_picture_url}');
  assert.equal(accounts.headers.get('authorization'), 'Bearer long');
});

test('a declined permission or no linked account say what to do', async () => {
  const connect = (respond: (req: Sent, index: number) => Response) =>
    instagram(respond).network.connect(app, { redirectUri: 'http://x/cb', code: 'c', verifier: 'v' });
  const tokensFirst = (rest: (req: Sent) => Response) => (req: Sent, i: number) =>
    i < 2 ? json({ access_token: `t${i}`, expires_in: 5000 }) : rest(req);
  await rejectsWithStatus(
    connect(tokensFirst(() => granted('instagram_content_publish', 'pages_show_list'))),
    403,
    /refusées.*instagram_content_publish, pages_show_list/,
  );
  await rejectsWithStatus(
    connect(tokensFirst((req) => (req.url.includes('/me/permissions') ? granted() : pages()))),
    400,
    /Aucun compte Instagram professionnel/,
  );
});

test('wrong keys and a used code say what to do', async () => {
  const connect = (answer: Response) =>
    instagram(() => answer).network.connect(app, { redirectUri: 'http://x/cb', code: 'c', verifier: 'v' });
  await rejectsWithStatus(connect(graphError(101, 'Error validating application. Invalid application ID.')), 400, /clé secrète/);
  await rejectsWithStatus(connect(graphError(1, 'Error validating client secret.')), 400, /vérifiez l’ID de l’app/);
  await rejectsWithStatus(
    connect(graphError(100, 'This authorization code has been used.', 36009)),
    400,
    /code has been used.*relancez la connexion/,
  );
});

test('no refresh token: a connection at its end asks to reconnect, without a request', async () => {
  const { network, sent } = instagram(() => json({}));
  await rejectsWithStatus(network.refresh(), 401, /reconnectez le compte dans le Profil/);
  assert.equal(sent.length, 0);
});

test('publishes a Reel: resumable container, the file streamed in 1 MiB chunks, processing polled, then its link', async () => {
  const { network, sent, waits } = instagram(flow());
  const progress: number[] = [];
  assert.deepEqual(await publish(network, progress), {
    url: 'https://www.instagram.com/reel/DcY8KVBCml7/',
    visibility: 'public',
  });

  const [container, upload, processing, finished, published, link] = sent;
  assert.ok(!sent.some((req) => req.url.includes('/me/accounts')));
  assert.equal(container.url, `${GRAPH}/1780/media`);
  assert.equal(container.method, 'POST');
  assert.equal(container.headers.get('authorization'), 'Bearer a1');
  assert.deepEqual(form(container.body), {
    media_type: 'REELS',
    upload_type: 'resumable',
    caption: 'Le teaser. #lumen',
  });
  assert.equal(upload.url, UPLOAD);
  assert.equal(upload.method, 'POST');
  assert.equal(upload.headers.get('authorization'), 'OAuth a1');
  assert.equal(upload.headers.get('offset'), '0');
  assert.equal(upload.headers.get('file_size'), String(BIG));
  assert.equal(upload.headers.get('content-length'), String(BIG));
  assert.deepEqual(upload.chunks, [MIB, MIB, 1000]);
  for (const check of [processing, finished]) {
    assert.equal(check.url, `${GRAPH}/c1?fields=status_code,status`);
    assert.equal(check.headers.get('authorization'), 'Bearer a1');
  }
  assert.deepEqual(waits, [10_000, 10_000]);
  assert.equal(published.url, `${GRAPH}/1780/media_publish`);
  assert.deepEqual(form(published.body), { creation_id: 'c1' });
  assert.equal(link.url, `${GRAPH}/m1?fields=permalink`);
  assert.deepEqual(progress, [MIB, 2 * MIB, BIG]);
});

test("counts rupload's 200 once Hono has swapped the global Response, as in the running server", async () => {
  const native = { Request, Response };
  getRequestListener(() => new native.Response(null));
  try {
    const answer = flow();
    // fetch keeps answering with Node's own Response, a class `instanceof Response` no longer matches.
    const { network } = instagram((req, i) => {
      const res = answer(req, i);
      return new native.Response(res.body, res);
    });
    assert.deepEqual(await publish(network), { url: 'https://www.instagram.com/reel/DcY8KVBCml7/', visibility: 'public' });
  } finally {
    for (const [name, value] of Object.entries(native)) Object.defineProperty(globalThis, name, { value });
  }
});

test('no caption sends none, and a lost link still counts as published', async () => {
  const { network, sent } = instagram(flow({ 5: json({ error: { code: 1, message: 'An unknown error occurred' } }, 500) }));
  const result = await network.publish({
    tokens,
    file: big,
    size: BIG,
    title: '',
    description: '',
    visibility: 'public',
    onProgress() {},
  });
  assert.deepEqual(result, { url: null, visibility: 'public' });
  assert.equal(form(sent[0].body).caption, undefined);
});

test('resumes after what Meta kept when rupload fails, and stops after three tries', async () => {
  const kept = (bytes: number) =>
    json({ id: 'c1', video_status: { uploading_phase: { status: 'in_progress', bytes_transferred: bytes } } });
  const refused = () => json({ debug_info: { retriable: true, type: 'ProcessingFailedError', message: 'Partial upload' } }, 400);
  const resumed = instagram((req, i) => {
    if (i === 1) return refused();
    if (i === 2) return kept(MIB);
    return flow()(req, i - 2 * Number(i > 2));
  });
  const progress: number[] = [];
  await publish(resumed.network, progress);
  const check = resumed.sent[2];
  const again = resumed.sent[3];
  assert.equal(check.url, `${GRAPH}/c1?fields=video_status`);
  assert.equal(again.url, UPLOAD);
  assert.equal(again.headers.get('offset'), String(MIB));
  assert.equal(again.headers.get('file_size'), String(BIG));
  assert.equal(again.headers.get('content-length'), String(MIB + 1000));
  assert.deepEqual(again.chunks, [MIB, 1000]);
  assert.equal(again.first, MIB % 251);
  assert.equal(progress.at(-1), BIG);

  const stuck = instagram((req, i) => (i === 0 ? flow()(req, i) : req.url === UPLOAD ? refused() : kept(0)));
  await rejectsWithStatus(publish(stuck.network), 502, /n’a pas reçu la vidéo \(Partial upload\)/);
  assert.equal(stuck.sent.filter((req) => req.url === UPLOAD).length, 3);

  // rupload says a new try would fail the same way: no second 300 MB.
  const final = json({ debug_info: { retriable: false, type: 'ProcessingFailedError', message: 'Unsupported file' } }, 400);
  const once = instagram((req, i) => (i === 0 ? flow()(req, i) : final));
  await rejectsWithStatus(publish(once.network), 502, /Unsupported file/);
  assert.equal(once.sent.filter((req) => req.url === UPLOAD).length, 1);
});

test('a token that died during the upload asks to reconnect', async () => {
  const { network } = instagram((req, i) =>
    i < 1 ? flow()(req, i) : req.url === UPLOAD ? json({}, 401) : graphError(190, 'Error validating access token', 463),
  );
  await rejectsWithStatus(publish(network), 401, /reconnectez le compte/);
});

test('waits 10 minutes at most for the processing, and tells a refused format', async () => {
  const slow = instagram((req, i) => (i < 2 ? flow()(req, i) : json({ id: 'c1', status_code: 'IN_PROGRESS' })));
  await rejectsWithStatus(publish(slow.network), 504, /10 minutes/);
  assert.equal(slow.waits.length, 60);
  assert.equal(slow.sent.filter((req) => req.url.endsWith('c1?fields=status_code,status')).length, 60);

  const format = instagram(
    flow({ 2: json({ status_code: 'ERROR', status: 'Error: Media upload has failed with error code 2207026' }) }),
  );
  await rejectsWithStatus(publish(format.network), 400, /H\.264 ou du HEVC/);
  const other = instagram(flow({ 2: json({ status_code: 'ERROR', status: 'Error: 2207053' }) }));
  await rejectsWithStatus(publish(other.network), 400, /refusé la vidéo : Error: 2207053/);
});

test('quota, permission, portfolio access and unknown errors read as what to do', async () => {
  const at = (index: number, answer: Response) => publish(instagram(flow({ [index]: answer })).network);
  await rejectsWithStatus(at(0, graphError(190, 'Error validating access token', 460)), 401, /reconnectez/);
  await rejectsWithStatus(
    at(0, graphError(10, 'Application does not have permission for this action')),
    403,
    /permission for this action/,
  );
  await rejectsWithStatus(at(4, graphError(9, 'Application request limit reached', 2207042)), 429, /24 heures/);
  await rejectsWithStatus(at(0, graphError(4, 'Application request limit reached')), 429, /quelques minutes/);
  await rejectsWithStatus(at(4, graphError(1, 'An unexpected error has occurred', 2207085)), 403, /portefeuille business/);
  await rejectsWithStatus(at(0, graphError(100, 'Invalid parameter')), 502, /refusé la vidéo : Invalid parameter/);
  // Meta's spam restriction is Meta's to explain.
  await rejectsWithStatus(at(0, graphError(4, 'Your account is restricted', 2207051)), 502, /Your account is restricted/);
  // Connected before the account was kept: connecting again picks it.
  const old = instagram(flow());
  await rejectsWithStatus(
    old.network.publish({
      ...{ tokens: { ...tokens, account: undefined } },
      file: big,
      size: BIG,
      title: '',
      description: '',
      visibility: 'public',
      onProgress() {},
    }),
    401,
    /reconnectez/,
  );
  assert.equal(old.sent.length, 0);
});

test('refuses a file over 300 MB before sending anything', async () => {
  const { network, sent } = instagram(() => json({}));
  await rejectsWithStatus(publish(network, [], 300_000_001), 400, /300 Mo/);
  assert.equal(sent.length, 0);
});

test('revokes what the person granted', async () => {
  const { network, sent } = instagram(() => json({ success: true }));
  await network.revoke(app, tokens);
  assert.equal(sent[0].method, 'DELETE');
  assert.equal(sent[0].url, `${GRAPH}/me/permissions`);
  assert.equal(sent[0].headers.get('authorization'), 'Bearer a1');
});

test("streams the file with Node's own fetch: a fixed length, no chunked encoding, and a resume after a cut", async () => {
  const cut = 2 * MIB + 7;
  const uploads: { headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  let kept = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    const reply = (value: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/rupload') {
      const chunks: Buffer[] = [];
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        // The first try loses its connection midway, as a flaky uplink would.
        if (uploads.length === 0 && kept === 0 && received >= cut) {
          kept = cut;
          req.socket.destroy();
        }
      });
      req.on('end', () => {
        uploads.push({ headers: req.headers, body: Buffer.concat(chunks) });
        reply({ success: true });
      });
      return;
    }
    const fields = url.searchParams.get('fields');
    if (url.pathname.endsWith('/1780/media')) return reply({ id: 'c1', uri: `http://127.0.0.1:${port}/rupload` });
    if (fields === 'video_status') return reply({ id: 'c1', video_status: { uploading_phase: { bytes_transferred: kept } } });
    if (fields === 'status_code,status') return reply({ id: 'c1', status_code: 'FINISHED' });
    if (url.pathname.endsWith('/1780/media_publish')) return reply({ id: 'm1' });
    reply({ permalink: 'https://www.instagram.com/reel/x/' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const network = new InstagramNetwork(
      (url, init) => fetch(url.replace(GRAPH, `http://127.0.0.1:${port}`), init),
      async () => undefined,
    );
    assert.deepEqual(await publish(network), { url: 'https://www.instagram.com/reel/x/', visibility: 'public' });
    const resumed = uploads.at(-1)!;
    assert.equal(resumed.headers['content-length'], String(BIG - cut));
    assert.equal(resumed.headers['transfer-encoding'], undefined);
    assert.equal(resumed.headers.offset, String(cut));
    assert.equal(resumed.headers.file_size, String(BIG));
    assert.ok(resumed.body.equals((await fs.readFile(big)).subarray(cut)));
  } finally {
    server.close();
  }
});
