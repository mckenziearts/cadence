// fetchPinned() against a local server, with the strict policy unless a test widens it: the injected lookup answers for
// made-up public names, and the injected createConnection dials the local server whatever address the pinned lookup
// gives, then shows the socket under that verified address. Nothing leaves the machine.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dns, { type LookupAddress } from 'node:dns';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import tls from 'node:tls';
import { promisify } from 'node:util';
import {
  Budget,
  CAPTURE_BYTES,
  CAPTURE_REQUESTS,
  type Connect,
  CONNECTIONS,
  fetchPinned,
  network,
  type PinnedDeps,
  Refused,
  RESOLVERS,
  RESOURCE_BYTES,
} from '../../server/capture/pinned';
import { STRICT } from '../../server/capture/policy';

const PUBLIC = '93.184.216.34';
let port = 0;
let held: (() => void)[] = [];
let holding = false;
const seen: string[] = [];
const accepted: net.Socket[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  seen.push(`${req.headers.host}${req.url}`);
  const hop = /^\/hops\/(\d+)$/.exec(url.pathname);
  if (hop) {
    const left = Number(hop[1]);
    if (left === 0) return void res.end('arrived');
    return void res.writeHead(302, { location: `/hops/${left - 1}` }).end();
  }
  switch (url.pathname) {
    case '/':
      res.setHeader('set-cookie', ['session=secret; HttpOnly', 'other=1']);
      res.setHeader('content-type', 'text/html');
      return void res.end('<h1>home</h1>');
    case '/to-loopback':
      return void res.writeHead(302, { location: 'http://127.0.0.1/' }).end();
    case '/to-metadata':
      return void res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    case '/to-query':
      return void res.writeHead(302, { location: '/small?from=redirect&x=a%20b' }).end();
    case '/to-same-host':
      return void res.writeHead(307, { location: '/' }).end();
    case '/to-cdn':
      return void res.writeHead(302, { location: 'http://cdn.test/small' }).end();
    case '/to-https':
      return void res.writeHead(302, { location: 'https://site.test/small' }).end();
    case '/to-port':
      return void res.writeHead(302, { location: 'http://site.test:8080/' }).end();
    case '/to-ftp':
      return void res.writeHead(302, { location: 'ftp://site.test/' }).end();
    case '/to-nowhere':
      return void res.writeHead(302, { location: 'http://[oops/' }).end();
    case '/to-credentials':
      return void res.writeHead(302, { location: 'http://user:pass@site.test/' }).end();
    case '/see-other':
      return void res.writeHead(303, { location: '/small' }).end();
    case '/permanent':
      return void res.writeHead(308, { location: '/small' }).end();
    case '/headers':
      res.writeHead(200, {
        'content-type': 'text/css',
        'content-language': 'fr',
        'access-control-allow-origin': '*',
        'content-encoding': 'gzip',
        link: '<http://10.0.0.1/>; rel=preconnect',
        refresh: '0; url=http://10.0.0.1/',
        'alt-svc': 'h3=":443"',
      });
      return void res.end(`accept-encoding: ${req.headers['accept-encoding']}`);
    case '/echo':
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify(req.headers));
    case '/located':
      return void res.writeHead(200, { location: '/small' }).end('here');
    case '/large': {
      const chunk = Buffer.alloc(64 * 1024, 'a');
      let sent = 0;
      const write = () => {
        while (sent < 9 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', write);
        }
        res.end();
      };
      res.on('error', () => undefined);
      return write();
    }
    case '/small':
      return void res.end(Buffer.alloc(100, 'b'));
    case '/silent':
      return;
    case '/stalls':
      res.writeHead(200);
      return void res.write('first bytes');
    case '/held':
      if (!holding) return void res.end('free');
      return void held.push(() => res.end('released'));
  }
  res.writeHead(404).end();
});
server.on('connection', (socket) => accepted.push(socket));

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Made-up names answered like `dns.lookup(name, { all: true })`; an IP literal answers itself. */
function deps(names: Record<string, string[] | (() => string[])>) {
  const lookups: string[] = [];
  const connections: { host: string; all: string[]; first: string }[] = [];
  const dials: Omit<Connect, 'lookup'>[] = [];
  const pinned: PinnedDeps = {
    lookup: async (hostname) => {
      lookups.push(hostname);
      const entry = names[hostname];
      const answer = net.isIP(hostname) ? [hostname] : typeof entry === 'function' ? entry() : (entry ?? []);
      return answer.map((address): LookupAddress => ({ address, family: net.isIP(address) }));
    },
    createConnection: (options) => {
      let all: string[] = [];
      let first = '';
      options.lookup(options.host, { all: true }, (_err, addresses) => {
        all = (addresses as LookupAddress[]).map((a) => a.address);
      });
      options.lookup(options.host, {}, (_err, address) => {
        first = address as string;
      });
      connections.push({ host: options.host, all, first });
      const { lookup: _lookup, ...dial } = options;
      dials.push(dial);
      const socket = net.connect(port, '127.0.0.1');
      Object.defineProperty(socket, 'remoteAddress', { value: first });
      return socket;
    },
  };
  return { pinned, lookups, connections, dials };
}

const budget = (ms = 2_000) => new Budget(AbortSignal.timeout(ms));

/** A refusal for `reason` that names the URL it refused. */
const refusedAt = (reason: string, href: string) => (e: unknown) =>
  e instanceof Refused && e.reason === reason && e.href === href;

async function until(done: () => boolean, what: () => string, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Makes /held answer only on release; released after the test whatever its outcome. */
function hold(t: TestContext) {
  holding = true;
  held = [];
  const release = () => {
    holding = false;
    held.splice(0).forEach((end) => end());
  };
  t.after(release);
  return release;
}

test('a page comes back with its status, headers and body, without Set-Cookie', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const page = await fetchPinned('http://site.test/', budget(), d.pinned);
  assert.equal(page.status, 200);
  assert.equal(page.url, 'http://site.test/');
  assert.equal(page.body.toString(), '<h1>home</h1>');
  assert.equal(page.headers['content-type'], 'text/html');
  assert.equal('set-cookie' in page.headers, false);
  assert.deepEqual(d.connections, [{ host: 'site.test', all: [PUBLIC], first: PUBLIC }]);
});

test('only the headers a page reads its body with come back, and the body is asked for unencoded', async () => {
  const page = await fetchPinned('http://site.test/headers', budget(), deps({ 'site.test': [PUBLIC] }).pinned);
  assert.equal(page.body.toString(), 'accept-encoding: identity');
  assert.deepEqual(page.headers, { 'content-type': 'text/css', 'content-language': 'fr', 'access-control-allow-origin': '*' });
});

test('a refused URL or address opens no socket', async () => {
  const d = deps({ 'site.test': [PUBLIC], 'lan.test': ['192.168.1.10'], 'mixed.test': [PUBLIC, '10.0.0.1'] });
  const refused = async (href: string, reason: string) =>
    assert.rejects(fetchPinned(href, budget(), d.pinned), refusedAt(reason, href));
  await refused('http://127.0.0.1/', 'private');
  await refused('http://[::1]/', 'private');
  await refused('http://lan.test/', 'private');
  await refused('http://mixed.test/', 'private');
  await refused('http://nowhere.test/', 'unresolved');
  await refused('http://site.test:8080/', 'port');
  await refused('ftp://site.test/', 'protocol');
  await refused('http://user:pass@site.test/', 'credentials');
  assert.deepEqual(d.connections, []);
});

test('a redirect to 127.0.0.1 is refused before its socket', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  await assert.rejects(
    fetchPinned('http://site.test/to-loopback', budget(), d.pinned),
    refusedAt('private', 'http://127.0.0.1/'),
  );
  assert.equal(d.connections.length, 1);
});

test('a Location to 169.254.169.254 is refused before its socket', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  await assert.rejects(
    fetchPinned('http://site.test/to-metadata', budget(), d.pinned),
    refusedAt('private', 'http://169.254.169.254/latest/meta-data/'),
  );
  assert.equal(d.connections.length, 1);
});

test('each redirect target goes through the URL policy again', async () => {
  for (const [path, reason, location] of [
    ['/to-port', 'port', 'http://site.test:8080/'],
    ['/to-ftp', 'protocol', 'ftp://site.test/'],
    ['/to-credentials', 'credentials', 'http://user:pass@site.test/'],
  ]) {
    const d = deps({ 'site.test': [PUBLIC] });
    const before = seen.length;
    await assert.rejects(fetchPinned(`http://site.test${path}`, budget(), d.pinned), refusedAt(reason, location));
    assert.equal(d.connections.length, 1, path);
    assert.deepEqual(seen.slice(before), [`site.test${path}`]);
  }
});

test("the budget's policy decides every hop: a widened one reaches loopback on another port, through a redirect", async () => {
  const allowed = new net.BlockList();
  allowed.addSubnet('127.0.0.0', 8);
  const local = () => new Budget(AbortSignal.timeout(2_000), { allowsPort: (p) => p === 80 || p === 8080, allowed });
  const d = deps({ 'dev.test': ['127.0.0.1'], 'lan.test': ['192.168.1.10'] });
  const before = seen.length;
  const page = await fetchPinned('http://dev.test:8080/to-loopback', local(), d.pinned);
  assert.equal(page.url, 'http://127.0.0.1/');
  assert.equal(page.body.toString(), '<h1>home</h1>');
  assert.deepEqual(seen.slice(before), ['dev.test:8080/to-loopback', '127.0.0.1/']);
  assert.deepEqual(
    d.dials.map(({ host, port }) => `${host}:${port}`),
    ['dev.test:8080', '127.0.0.1:80'],
  );

  await assert.rejects(
    fetchPinned('http://lan.test:8080/', local(), d.pinned),
    (e: unknown) => e instanceof Refused && e.reason === 'private',
  );
  await assert.rejects(
    fetchPinned('http://dev.test:9000/', local(), d.pinned),
    (e: unknown) => e instanceof Refused && e.reason === 'port',
  );
  assert.equal(d.dials.length, 2);
});

test("a resource's redirects stay on its origin: one to another origin or scheme is refused before its socket", async () => {
  const d = deps({ 'site.test': [PUBLIC], 'cdn.test': [PUBLIC] });
  const same = await fetchPinned('http://site.test/see-other', budget(), d.pinned, { sameOrigin: true });
  assert.equal(same.url, 'http://site.test/small');
  for (const [path, location] of [
    ['/to-cdn', 'http://cdn.test/small'],
    ['/to-https', 'https://site.test/small'],
  ]) {
    const before = seen.length;
    await assert.rejects(
      fetchPinned(`http://site.test${path}`, budget(), d.pinned, { sameOrigin: true }),
      refusedAt('redirects', location),
    );
    assert.deepEqual(seen.slice(before), [`site.test${path}`]);
  }
  assert.ok(!d.lookups.includes('cdn.test'), d.lookups.join());
  const page = await fetchPinned('http://site.test/to-cdn', budget(), d.pinned);
  assert.equal(page.url, 'http://cdn.test/small');
});

test('a page answered from a public address takes the private ranges away from its capture, from that hop on', async () => {
  const allowed = new net.BlockList();
  allowed.addSubnet('127.0.0.0', 8);
  allowed.addSubnet('192.168.0.0', 16);
  const local = () => new Budget(AbortSignal.timeout(2_000), { allowsPort: () => true, allowed });
  const d = deps({
    'site.test': [PUBLIC],
    'mixed.test': ['192.168.1.20', PUBLIC],
    'dev.test': ['127.0.0.1'],
    'lan.test': ['192.168.1.10'],
  });
  // A local page keeps the person's networks, through its redirects and for its resources.
  const dev = local();
  assert.equal((await fetchPinned('http://dev.test/to-loopback', dev, d.pinned, { navigation: true })).url, 'http://127.0.0.1/');
  assert.equal((await fetchPinned('http://lan.test/small', dev, d.pinned)).body.length, 100);
  // A public page, even one with a private answer among its public ones, neither redirects nor reaches there; its ports
  // stay the policy's.
  for (const host of ['site.test', 'mixed.test']) {
    const page = local();
    await assert.rejects(
      fetchPinned(`http://${host}/to-loopback`, page, d.pinned, { navigation: true }),
      refusedAt('private', 'http://127.0.0.1/'),
    );
    await assert.rejects(fetchPinned('http://lan.test/small', page, d.pinned), refusedAt('private', 'http://lan.test/small'));
    assert.equal((await fetchPinned('http://site.test:8080/small', page, d.pinned)).body.length, 100, host);
  }
  // A public resource is not the page: it changes nothing.
  const resources = local();
  await fetchPinned('http://site.test/small', resources, d.pinned);
  assert.equal((await fetchPinned('http://lan.test/small', resources, d.pinned)).body.length, 100);
});

test('a redirect whose Location is not a URL is refused before its socket', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  await assert.rejects(fetchPinned('http://site.test/to-nowhere', budget(), d.pinned), refusedAt('invalid', 'http://[oops/'));
  assert.equal(d.connections.length, 1);
});

test('303 and 308 are followed; a Location on another status is not', async () => {
  for (const path of ['/see-other', '/permanent']) {
    const page = await fetchPinned(`http://site.test${path}`, budget(), deps({ 'site.test': [PUBLIC] }).pinned);
    assert.equal(page.url, 'http://site.test/small', path);
    assert.equal(page.body.length, 100);
  }

  const d = deps({ 'site.test': [PUBLIC] });
  const before = seen.length;
  const page = await fetchPinned('http://site.test/located', budget(), d.pinned);
  assert.equal(page.status, 200);
  assert.equal(page.url, 'http://site.test/located');
  assert.equal(page.body.toString(), 'here');
  assert.deepEqual(seen.slice(before), ['site.test/located']);
  assert.equal(d.connections.length, 1);
});

test('rebinding: a capture resolves a host once and dials that checked answer for every hop and fetch after it', async () => {
  let calls = 0;
  const d = deps({ 'rebind.test': () => (calls++ === 0 ? [PUBLIC] : ['10.0.0.1']) });
  const b = budget();
  const before = seen.length;
  const page = await fetchPinned('http://rebind.test/to-same-host', b, d.pinned);
  assert.equal(page.body.toString(), '<h1>home</h1>');
  await fetchPinned('http://rebind.test/small', b, d.pinned);
  assert.deepEqual(seen.slice(before), ['rebind.test/to-same-host', 'rebind.test/', 'rebind.test/small']);
  assert.deepEqual(d.lookups, ['rebind.test']);
  assert.ok(
    d.connections.every(({ all, first }) => all.join() === PUBLIC && first === PUBLIC),
    JSON.stringify(d.connections),
  );
});

test('the pinned lookup gives the whole checked list when asked for all, the first address otherwise', async () => {
  const other = '2606:4700::1111';
  const d = deps({ 'two.test': [PUBLIC, other] });
  await fetchPinned('http://two.test/', budget(), d.pinned);
  assert.deepEqual(d.connections, [{ host: 'two.test', all: [PUBLIC, other], first: PUBLIC }]);
});

test('a socket whose remote address is not one of the checked ones is destroyed', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const unpinned: PinnedDeps = { ...d.pinned, createConnection: () => net.connect(port, '127.0.0.1') };
  const before = seen.length;
  const from = accepted.length;
  await assert.rejects(
    fetchPinned('http://site.test/', budget(), unpinned),
    (e: unknown) => e instanceof Refused && e.reason === 'private',
  );
  const sockets = () => accepted.slice(from);
  await until(
    () => sockets().length === 1 && sockets()[0].destroyed,
    () => `${sockets().length} accepted, destroyed: ${sockets().map((s) => s.destroyed)}`,
  );
  assert.equal(sockets()[0].bytesRead, 0);
  assert.equal(seen.length, before);
});

test('over https, a socket dialed elsewhere than the checked answers sends nothing, not even the ClientHello', async () => {
  const elsewhere: Connect['lookup'] = (_hostname, options, callback) =>
    options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
  const d = deps({ 'site.test': [PUBLIC] });
  const unpinned: PinnedDeps = {
    ...d.pinned,
    createConnection: (options) => network.createConnection({ ...options, port, lookup: elsewhere }),
  };
  const from = accepted.length;
  await assert.rejects(
    fetchPinned('https://site.test/', budget(), unpinned),
    (e: unknown) => e instanceof Refused && e.reason === 'private',
  );
  const sockets = () => accepted.slice(from);
  await until(
    () => sockets().length === 1 && sockets()[0].destroyed,
    () => `${sockets().length} accepted, destroyed: ${sockets().map((s) => s.destroyed)}`,
  );
  assert.equal(sockets()[0].bytesRead, 0);
});

test('a slot freed by a failed fetch serves the next fetch', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const unpinned: PinnedDeps = { ...d.pinned, createConnection: () => net.connect(port, '127.0.0.1') };
  const b = budget();
  for (let i = 0; i <= CONNECTIONS; i++) {
    await assert.rejects(fetchPinned('http://site.test/', b, unpinned), (e: unknown) => e instanceof Refused);
  }
  const page = await fetchPinned('http://site.test/small', b, d.pinned);
  assert.equal(page.body.length, 100);
});

test('the query string is sent, the fragment is not', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const page = await fetchPinned('http://site.test/small?v=3&x=a%20b#frag', budget(), d.pinned);
  assert.equal(seen.at(-1), 'site.test/small?v=3&x=a%20b');
  assert.equal(page.url, 'http://site.test/small?v=3&x=a%20b#frag');

  const redirected = await fetchPinned('http://site.test/to-query', budget(), d.pinned);
  assert.deepEqual(seen.slice(-2), ['site.test/to-query', 'site.test/small?from=redirect&x=a%20b']);
  assert.equal(redirected.url, 'http://site.test/small?from=redirect&x=a%20b');
});

test('the request headers a capture passes are sent; the body is still asked for unencoded', async () => {
  const page = await fetchPinned('http://site.test/echo', budget(), deps({ 'site.test': [PUBLIC] }).pinned, {
    headers: {
      'user-agent': 'Capture/1.0',
      accept: 'text/html',
      'accept-language': 'fr-FR',
      'accept-encoding': 'gzip, br',
    },
  });
  const sent = JSON.parse(page.body.toString());
  assert.deepEqual(
    [sent['user-agent'], sent.accept, sent['accept-language'], sent['accept-encoding']],
    ['Capture/1.0', 'text/html', 'fr-FR', 'identity'],
  );
});

test('a capture that ends while its lookup answers dials nothing, even an IP literal', async () => {
  for (const host of ['site.test', PUBLIC]) {
    const d = deps({ 'site.test': [PUBLIC] });
    const controller = new AbortController();
    const ending: PinnedDeps = {
      ...d.pinned,
      lookup: async (hostname, signal) => {
        controller.abort();
        return d.pinned.lookup(hostname, signal);
      },
    };
    await assert.rejects(
      fetchPinned(`http://${host}/`, new Budget(controller.signal), ending),
      (e: unknown) => (e as Error).name === 'AbortError',
      host,
    );
    assert.deepEqual(d.connections, [], host);
  }
});

test('the production createConnection trusts the certificates the system trusts too, through one shared context', async () => {
  // In a process of its own: the context is built once per process, maybe already by an https test above.
  const script = `
import net from 'node:net';
import tls from 'node:tls';
const built = [];
const create = tls.createSecureContext;
tls.createSecureContext = (options) => (built.push(options?.ca ?? []), create(options));
const connects = [];
tls.connect = (options) => (connects.push(options), new net.Socket());
const { network } = await import(${JSON.stringify(new URL('../../server/capture/pinned.ts', import.meta.url).href)});
for (let i = 0; i < 3; i++) network.createConnection({ protocol: 'https:', host: 'site.test', port: 443, servername: 'site.test', lookup: () => {} });
const trusted = new Set(built[0]);
console.log(JSON.stringify({
  built: built.length,
  shared: connects.every((options) => options.secureContext !== undefined && options.secureContext === connects[0].secureContext),
  system: [...tls.getCACertificates('default'), ...tls.getCACertificates('system')].every((cert) => trusted.has(cert)),
}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
  assert.deepEqual(JSON.parse(stdout), { built: 1, shared: true, system: true });
});

test('a lookup that fails gives unresolved and opens no socket', async () => {
  const d = deps({});
  const failing: PinnedDeps = {
    ...d.pinned,
    lookup: () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
  };
  await assert.rejects(
    fetchPinned('http://gone.test/', budget(), failing),
    (e: unknown) => e instanceof Refused && e.reason === 'unresolved',
  );
  assert.deepEqual(d.connections, []);
});

test('a slow lookup is cut by the budget', async () => {
  const d = deps({});
  const slow: PinnedDeps = {
    ...d.pinned,
    lookup: () => new Promise((resolve) => setTimeout(resolve, 2_000, [{ address: PUBLIC, family: 4 }]).unref()),
  };
  const started = Date.now();
  await assert.rejects(fetchPinned('http://slow-dns.test/', budget(200), slow));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 1_000, `took ${elapsed} ms`);
  assert.deepEqual(d.connections, []);
});

test('five redirects are followed, the sixth is refused before its socket', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const page = await fetchPinned('http://site.test/hops/5', budget(), d.pinned);
  assert.equal(page.url, 'http://site.test/hops/0');
  assert.equal(page.body.toString(), 'arrived');
  assert.equal(d.lookups.length, 1);

  const e = deps({ 'site.test': [PUBLIC] });
  const before = seen.length;
  await assert.rejects(
    fetchPinned('http://site.test/hops/6', budget(), e.pinned),
    refusedAt('redirects', 'http://site.test/hops/0'),
  );
  assert.equal(e.lookups.length, 1);
  assert.equal(e.connections.length, 1);
  assert.deepEqual(
    seen.slice(before),
    ['6', '5', '4', '3', '2', '1'].map((n) => `site.test/hops/${n}`),
  );
});

test('the fetches of one capture reuse their connection to a host, closed when the budget ends', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const sockets: net.Socket[] = [];
  const kept: PinnedDeps = {
    ...d.pinned,
    createConnection: (options) => {
      const socket = d.pinned.createConnection(options);
      sockets.push(socket);
      return socket;
    },
  };
  const controller = new AbortController();
  const b = new Budget(controller.signal);
  for (let i = 0; i < 5; i++) await fetchPinned('http://site.test/small', b, kept);
  assert.equal(sockets.length, 1);

  await fetchPinned('http://site.test/small', budget(), kept);
  assert.equal(sockets.length, 2);

  controller.abort();
  assert.equal(sockets[0].destroyed, true);
});

test('idle connections to past hosts are closed so no more than 8 stay open', async () => {
  const hosts = Array.from({ length: CONNECTIONS + 4 }, (_, i) => `h${i}.test`);
  const d = deps(Object.fromEntries(hosts.map((host) => [host, [PUBLIC]])));
  const sockets: net.Socket[] = [];
  const counted: PinnedDeps = {
    ...d.pinned,
    createConnection: (options) => {
      const socket = d.pinned.createConnection(options);
      sockets.push(socket);
      return socket;
    },
  };
  const b = budget();
  for (const host of hosts) {
    await fetchPinned(`http://${host}/small`, b, counted);
    const open = sockets.filter((socket) => !socket.destroyed).length;
    assert.ok(open <= CONNECTIONS, `${open} sockets open after ${host}`);
  }
  assert.equal(sockets.length, hosts.length);
  await fetchPinned(`http://${hosts.at(-1)}/small`, b, counted);
  assert.equal(sockets.length, hosts.length);
});

test('an https URL dials port 443 with the host as servername', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const page = await fetchPinned('https://site.test/', budget(), d.pinned);
  assert.equal(page.body.toString(), '<h1>home</h1>');
  assert.deepEqual(d.dials, [{ protocol: 'https:', host: 'site.test', port: 443, servername: 'site.test' }]);
});

test('an https IP literal gets no servername', async () => {
  const d = deps({});
  await fetchPinned(`https://${PUBLIC}/`, budget(), d.pinned);
  assert.deepEqual(d.dials, [{ protocol: 'https:', host: PUBLIC, port: 443 }]);
});

test('the production network resolves, dials and checks a real socket', async () => {
  const allowed = new net.BlockList();
  allowed.addSubnet('127.0.0.0', 8);
  const local = new Budget(AbortSignal.timeout(2_000), { allowsPort: (p) => p === port, allowed });
  const before = seen.length;
  const page = await fetchPinned(`http://127.0.0.1:${port}/`, local);
  assert.equal(page.status, 200);
  assert.equal(page.body.toString(), '<h1>home</h1>');
  assert.deepEqual(seen.slice(before), [`127.0.0.1:${port}/`]);
});

test('the production createConnection dials the pinned answer for http and https', async () => {
  const lookup: Connect['lookup'] = (_hostname, options, callback) =>
    options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
  for (const protocol of ['http:', 'https:'] as const) {
    const socket = network.createConnection({ protocol, host: 'pinned.invalid', port, lookup });
    await once(socket, 'connect');
    socket.on('error', () => undefined);
    assert.equal(socket.remoteAddress, '127.0.0.1', protocol);
    socket.destroy();
  }
});

test('over https, the production createConnection speaks TLS, sends the name as SNI and verifies the certificate', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cadence-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    await promisify(execFile)('openssl', [
      ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1'],
      ...['-subj', '/CN=site.test', '-addext', 'subjectAltName=DNS:site.test', '-keyout', key, '-out', cert],
    ]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    assert.ok(!process.env.CI, 'openssl missing in CI: the runner image must provide it');
    return t.skip('openssl missing');
  }
  const context = tls.createSecureContext({ key: await readFile(key), cert: await readFile(cert) });
  const names: string[] = [];
  const requests: string[] = [];
  const secure = https.createServer(
    {
      SNICallback: (name, callback) => {
        names.push(name);
        callback(null, context);
      },
    },
    (req, res) => {
      requests.push(req.url ?? '');
      res.end('reached');
    },
  );
  await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    secure.closeAllConnections();
    secure.close();
  });
  const tlsPort = (secure.address() as AddressInfo).port;
  const allowed = new net.BlockList();
  allowed.addSubnet('127.0.0.0', 8);
  const local = new Budget(AbortSignal.timeout(2_000), { allowsPort: (p) => p === tlsPort, allowed });
  const d = deps({ 'site.test': ['127.0.0.1'] });

  await assert.rejects(
    fetchPinned(`https://site.test:${tlsPort}/`, local, { ...d.pinned, createConnection: network.createConnection }),
    (e: unknown) => (e as NodeJS.ErrnoException).code === 'DEPTH_ZERO_SELF_SIGNED_CERT',
  );
  assert.deepEqual(names, ['site.test']);
  assert.deepEqual(requests, []);
});

test('a 9 MB body is aborted at 8 MB', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const b = budget();
  await assert.rejects(fetchPinned('http://site.test/large', b, d.pinned), refusedAt('too-large', 'http://site.test/large'));
  assert.ok(b.bytes > RESOURCE_BYTES && b.bytes < 9 * 1024 * 1024, `${b.bytes} bytes read`);
});

test('the bytes and requests of one capture are capped', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const full = budget();
  full.bytes = CAPTURE_BYTES - 10;
  await assert.rejects(
    fetchPinned('http://site.test/small', full, d.pinned),
    (e: unknown) => e instanceof Refused && e.reason === 'too-large',
  );

  const spent = budget();
  spent.requests = CAPTURE_REQUESTS;
  let connections = d.connections.length;
  await assert.rejects(
    fetchPinned('http://site.test/', spent, d.pinned),
    (e: unknown) => e instanceof Refused && e.reason === 'budget',
  );
  assert.equal(d.connections.length, connections);

  const drained = budget();
  drained.bytes = CAPTURE_BYTES;
  connections = d.connections.length;
  const requests = seen.length;
  await assert.rejects(
    fetchPinned('http://site.test/small', drained, d.pinned),
    (e: unknown) => e instanceof Refused && e.reason === 'budget',
  );
  assert.equal(d.connections.length, connections);
  assert.equal(seen.length, requests);
});

test('each hop of a fetch counts as one request of the capture', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const b = budget();
  await fetchPinned('http://site.test/hops/2', b, d.pinned);
  assert.equal(b.requests, 3);

  const almost = budget();
  almost.requests = CAPTURE_REQUESTS - 1;
  await assert.rejects(
    fetchPinned('http://site.test/hops/2', almost, d.pinned),
    (e: unknown) => e instanceof Refused && e.reason === 'budget',
  );
  assert.equal(almost.requests, CAPTURE_REQUESTS);
  assert.equal(d.connections.length, 2);
});

test('a slow server is cut by the budget', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  for (const path of ['/silent', '/stalls']) {
    const started = Date.now();
    await assert.rejects(fetchPinned(`http://site.test${path}`, budget(200), d.pinned));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 150 && elapsed < 1_500, `${path} took ${elapsed} ms`);
  }
});

test('an expired budget opens no socket', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  await assert.rejects(fetchPinned('http://site.test/', new Budget(AbortSignal.abort()), d.pinned));
  assert.deepEqual(d.connections, []);
});

test('at most 8 connections are in flight per budget', async (t) => {
  const d = deps({ 'site.test': [PUBLIC] });
  const b = budget(5_000);
  const release = hold(t);
  const pages = Array.from({ length: CONNECTIONS * 3 }, () => fetchPinned('http://site.test/held', b, d.pinned));
  await until(
    () => held.length >= CONNECTIONS,
    () => `${held.length} held`,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(CONNECTIONS, 8);
  assert.equal(held.length, CONNECTIONS);
  assert.equal(d.connections.length, CONNECTIONS);
  release();
  const bodies = (await Promise.all(pages)).map((page) => page.body.toString());
  assert.equal(bodies.length, CONNECTIONS * 3);
  assert.equal(bodies.filter((body) => body === 'released').length, CONNECTIONS);
});

test('the 8 connections are shared by every host of the budget', async (t) => {
  const d = deps({ 'a.test': [PUBLIC], 'b.test': [PUBLIC], 'c.test': [PUBLIC] });
  const b = budget(5_000);
  const release = hold(t);
  const pages = ['a.test', 'b.test', 'c.test'].flatMap((host) =>
    Array.from({ length: CONNECTIONS }, () => fetchPinned(`http://${host}/held`, b, d.pinned)),
  );
  await until(
    () => held.length >= CONNECTIONS,
    () => `${held.length} held`,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(held.length, CONNECTIONS);
  assert.equal(d.connections.length, CONNECTIONS);
  release();
  assert.equal((await Promise.all(pages)).length, CONNECTIONS * 3);
});

test('one capture resolves each host once, whatever number of fetches and hops ask for it', async () => {
  const d = deps({ 'site.test': [PUBLIC], 'cdn.test': [PUBLIC] });
  const b = budget();
  await Promise.all([
    fetchPinned('http://site.test/small', b, d.pinned),
    fetchPinned('http://site.test/see-other', b, d.pinned),
    fetchPinned('http://cdn.test/small', b, d.pinned),
  ]);
  await fetchPinned('http://site.test/to-cdn', b, d.pinned);
  assert.deepEqual(d.lookups.toSorted(), ['cdn.test', 'site.test']);
  await fetchPinned('http://site.test/small', budget(), d.pinned);
  assert.equal(d.lookups.length, 3, 'another capture resolves again');
});

test('a fetch waiting for a connection resolves its host only once it holds one', async (t) => {
  const d = deps({ 'site.test': [PUBLIC], 'later.test': [PUBLIC] });
  const b = budget(5_000);
  const release = hold(t);
  const holders = Array.from({ length: CONNECTIONS }, () => fetchPinned('http://site.test/held', b, d.pinned));
  await until(
    () => held.length >= CONNECTIONS,
    () => `${held.length} held`,
  );
  const waiting = Array.from({ length: 4 }, () => fetchPinned('http://later.test/small', b, d.pinned));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    d.lookups.filter((host) => host === 'later.test'),
    [],
  );
  release();
  await Promise.all([...holders, ...waiting]);
  assert.deepEqual(
    d.lookups.filter((host) => host === 'later.test'),
    ['later.test'],
  );
});

test('the production lookup runs at most 2 resolutions at once across captures, a failed one frees its turn', async (t) => {
  const pending: { resolve: () => void; reject: () => void }[] = [];
  const lookup = t.mock.method(
    dns.promises,
    'lookup',
    () =>
      new Promise((resolve, reject) =>
        pending.push({
          resolve: () => resolve([{ address: PUBLIC, family: 4 }]),
          reject: () => reject(new Error('getaddrinfo ENOTFOUND')),
        }),
      ),
  );
  const signal = new AbortController().signal;
  const settled = Promise.allSettled(Array.from({ length: 5 }, (_, i) => network.lookup(`host${i}.test`, signal)));
  const started = (count: number) =>
    until(
      () => lookup.mock.callCount() === count,
      () => `${lookup.mock.callCount()} lookups`,
    );
  await started(RESOLVERS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(RESOLVERS, 2);
  assert.equal(lookup.mock.callCount(), RESOLVERS);
  pending.shift()?.reject();
  await started(RESOLVERS + 1);
  while (pending.length > 0) {
    pending.shift()?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(lookup.mock.callCount(), 5);
  assert.deepEqual(
    (await settled).map(({ status }) => status),
    ['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
  );
});

test('a capture that ends leaves the resolution queue at once: the next capture resolves at the first free turn', async (t) => {
  const pending: (() => void)[] = [];
  const lookup = t.mock.method(
    dns.promises,
    'lookup',
    () => new Promise((resolve) => pending.push(() => resolve([{ address: PUBLIC, family: 4 }]))),
  );
  await assert.rejects(network.lookup('gone.test', AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(lookup.mock.callCount(), 0);

  const ended = new AbortController();
  const running = Array.from({ length: RESOLVERS }, (_, i) => network.lookup(`s${i}.evil.test`, ended.signal));
  const queued = Promise.allSettled(Array.from({ length: 6 }, (_, i) => network.lookup(`q${i}.evil.test`, ended.signal)));
  await until(
    () => lookup.mock.callCount() === RESOLVERS,
    () => `${lookup.mock.callCount()} lookups`,
  );
  // An IP literal needs no getaddrinfo, so it never waits for a turn.
  assert.deepEqual(await network.lookup('203.0.113.9', ended.signal), [{ address: '203.0.113.9', family: 4 }]);
  const next = network.lookup('legit.test', new AbortController().signal);
  ended.abort();
  assert.deepEqual(
    (await queued).map(({ status }) => status),
    Array(6).fill('rejected'),
  );
  assert.equal(lookup.mock.callCount(), RESOLVERS);
  pending.shift()?.();
  await until(
    () => lookup.mock.callCount() === RESOLVERS + 1,
    () => `${lookup.mock.callCount()} lookups`,
  );
  assert.equal(lookup.mock.calls[RESOLVERS].arguments[0], 'legit.test');
  pending.splice(0).forEach((resolve) => resolve());
  assert.deepEqual(await next, [{ address: PUBLIC, family: 4 }]);
  assert.equal((await Promise.all(running)).length, RESOLVERS);
});

test('a response that stops sending gives its connection back before the budget runs out', async () => {
  const d = deps({ 'site.test': [PUBLIC] });
  const b = new Budget(AbortSignal.timeout(2_000), STRICT, 300);
  const stalled = Promise.allSettled(
    Array.from({ length: CONNECTIONS }, () => fetchPinned('http://site.test/stalls', b, d.pinned)),
  );
  const page = await fetchPinned('http://site.test/small', b, d.pinned);
  assert.equal(page.body.length, 100);
  assert.deepEqual(
    (await stalled).map((fetch) => fetch.status === 'rejected' && fetch.reason instanceof Refused && fetch.reason.reason),
    Array(CONNECTIONS).fill('slow'),
  );
});

test('fetches waiting for a connection give up when the budget runs out', async (t) => {
  const d = deps({ 'site.test': [PUBLIC] });
  const release = hold(t);
  const b = budget(200);
  const started = Date.now();
  const pages = Array.from({ length: CONNECTIONS * 3 }, () => fetchPinned('http://site.test/held', b, d.pinned));
  const settled = await Promise.race([
    Promise.allSettled(pages),
    new Promise<'pending'>((resolve) => setTimeout(resolve, 1_000, 'pending').unref()),
  ]);
  release();
  assert.notEqual(settled, 'pending');
  assert.ok(Date.now() - started < 1_500);
  assert.deepEqual(new Set((settled as PromiseSettledResult<unknown>[]).map(({ status }) => status)), new Set(['rejected']));
});

test('fetches whose lookup answers as the budget runs out still reject', async (t) => {
  const d = deps({ 'site.test': [PUBLIC] });
  const controller = new AbortController();
  const b = new Budget(controller.signal);
  const release = hold(t);
  const holders = Array.from({ length: CONNECTIONS }, () => fetchPinned('http://site.test/held', b, d.pinned));
  await until(
    () => held.length >= CONNECTIONS,
    () => `${held.length} held`,
  );
  const late: PinnedDeps = {
    ...d.pinned,
    lookup: () =>
      new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve([{ address: PUBLIC, family: 4 }]))),
  };
  const latecomers = Array.from({ length: 12 }, () => fetchPinned('http://site.test/held', b, late));
  controller.abort();
  const settled = await Promise.race([
    Promise.allSettled([...holders, ...latecomers]),
    new Promise<'pending'>((resolve) => setTimeout(resolve, 1_000, 'pending').unref()),
  ]);
  release();
  assert.notEqual(settled, 'pending');
  assert.deepEqual(new Set((settled as PromiseSettledResult<unknown>[]).map(({ status }) => status)), new Set(['rejected']));
});
