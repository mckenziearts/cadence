// One GET for a capture, under its budget's policy. Each hop checks its URL, resolves its host once and refuses it if any
// answer is forbidden; the connection can only dial those checked answers (no second resolution, so no
// DNS rebinding) and its remote address is checked again once connected. Redirects are followed here: the browser only
// sees a 3xx that has no Location.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { addressRefusal, type AddressRefusal, type Policy, portOf, STRICT, urlRefusal, type UrlRefusal } from './policy';

// ponytail: fixed caps for one capture; a setting the day a real site needs more.
export const CONNECTIONS = 8;
export const RESOURCE_BYTES = 8 * 1024 * 1024;
export const CAPTURE_BYTES = 64 * 1024 * 1024;
export const CAPTURE_REQUESTS = 400;
export const REDIRECTS = 5;
// ponytail: a response idle this long gives its connection back, so 8 stalled ones cannot hold the capture to its deadline.
export const IDLE_MS = 10_000;
// ponytail: getaddrinfo holds one of libuv's 4 threads until the resolver gives up and cannot be cancelled; 2 at a time,
// across captures, leave the others to fs, zlib and crypto. c-ares (dns.Resolver) could cancel, but skips the system's
// own resolution (hosts file, per-domain resolvers).
export const RESOLVERS = 2;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The response headers handed back. Content-Encoding, Content-Length and Transfer-Encoding describe the bytes on the
 * socket: the body is asked for unencoded and handed over as received, so a page cannot have the browser inflate past
 * the byte caps. The others (Set-Cookie, Link, Refresh, Alt-Svc...) would act in the browser.
 */
const READABLE = (name: string) => name === 'content-type' || name === 'content-language' || name.startsWith('access-control-');

export type PinnedRefusal = UrlRefusal | AddressRefusal | 'redirects' | 'too-large' | 'budget' | 'slow';

export class Refused extends Error {
  /** `href` is the URL refused: a redirect's target, or a resource of the page. */
  constructor(
    readonly reason: PinnedRefusal,
    readonly href: string,
  ) {
    super(reason);
    this.name = 'Refused';
  }
}

/** The policy, deadline, caps and counters of one capture: every fetch of that capture shares it. */
export class Budget {
  requests = 0;
  bytes = 0;
  /**
   * Each host's answers, resolved once per capture: every hop and fetch to it dials what was checked then, and a page
   * with hundreds of resources to a few hosts does not queue as many lookups.
   */
  readonly lookups = new Map<string, Promise<dns.LookupAddress[]>>();
  /** Keep-alive per host for the capture. A socket is only ever dialed by its hop's pinned createConnection. */
  readonly agents = {
    'http:': dialedByRequest(new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS })),
    'https:': dialedByRequest(new https.Agent({ keepAlive: true, maxSockets: CONNECTIONS })),
  };
  private open = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly sockets = new Set<net.Socket>();

  constructor(
    readonly signal: AbortSignal,
    public policy: Policy = STRICT,
    readonly idle = IDLE_MS,
  ) {
    const end = () => {
      this.waiting.splice(0).forEach((wake) => wake());
      this.agents['http:'].destroy();
      this.agents['https:'].destroy();
    };
    signal.addEventListener('abort', end, { once: true });
  }

  /**
   * Drops the private ranges the policy allowed and keeps its ports: once a page is served from a public address, its
   * redirects and resources may not reach the person's networks either.
   */
  narrow(): void {
    this.policy = { allowsPort: this.policy.allowsPort };
  }

  /** Waits for one of the CONNECTIONS slots; the caller runs the returned release once done. */
  async connection(): Promise<() => void> {
    for (;;) {
      this.signal.throwIfAborted();
      if (this.open < CONNECTIONS) break;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.open++;
    return () => {
      this.open--;
      this.waiting.shift()?.();
    };
  }

  /**
   * Opens a socket for a fetch holding a slot. The CONNECTIONS slots bound the fetches in flight; idle keep-alive
   * sockets to other hosts are closed first, so open sockets stay within CONNECTIONS too.
   */
  dial(open: () => net.Socket): net.Socket {
    const idle = [this.agents['http:'], this.agents['https:']].flatMap((agent) =>
      Object.values(agent.freeSockets).flatMap((sockets) => sockets ?? []),
    );
    for (const socket of idle) {
      if (this.sockets.size < CONNECTIONS) break;
      this.sockets.delete(socket);
      socket.destroy();
    }
    const socket = open();
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }
}

function dialedByRequest<A extends http.Agent>(agent: A): A {
  agent.createConnection = (options) => options.createConnection?.(options, () => undefined);
  return agent;
}

export interface Connect {
  protocol: 'http:' | 'https:';
  host: string;
  port: number;
  servername?: string;
  /** Answers with the checked addresses only. */
  lookup: net.LookupFunction;
}

export interface PinnedDeps {
  /** `signal` is the capture's: once it aborts, a lookup still waiting for its turn gives it up. */
  lookup: (hostname: string, signal: AbortSignal) => Promise<dns.LookupAddress[]>;
  createConnection: (options: Connect) => net.Socket;
}

let resolving = 0;
const resolvers: (() => void)[] = [];

/** Waits for a turn, or leaves the queue when `signal` aborts so an ended capture holds no turn after it. */
function turn(signal: AbortSignal): Promise<void> {
  if (resolving < RESOLVERS) {
    resolving++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const wake = () => {
      signal.removeEventListener('abort', leave);
      resolve();
    };
    // Only runs while `wake` is still queued: handing a turn shifts and calls it in the same tick.
    const leave = () => {
      resolvers.splice(resolvers.indexOf(wake), 1);
      reject(signal.reason);
    };
    resolvers.push(wake);
    signal.addEventListener('abort', leave, { once: true });
  });
}

export const network: PinnedDeps = {
  lookup: async (hostname, signal) => {
    const family = net.isIP(hostname);
    if (family !== 0) return [{ address: hostname, family }];
    signal.throwIfAborted();
    await turn(signal);
    try {
      signal.throwIfAborted();
      return await dns.promises.lookup(hostname, { all: true });
    } finally {
      // The turn goes to the next one waiting, so the count only drops when nobody is.
      const next = resolvers.shift();
      if (next) next();
      else resolving--;
    }
  },
  createConnection: (options) =>
    options.protocol === 'https:' ? tls.connect({ ...options, secureContext: trusted() }) : net.createConnection(options),
};

let context: tls.SecureContext | undefined;
/**
 * Node's own list and the system's, like a browser: a local dev site's certificate comes from a local CA that its tool
 * added to the system store (mkcert, Valet). Built once: parsing a few hundred certificates per connection would cost
 * more than the request.
 */
function trusted(): tls.SecureContext {
  context ??= tls.createSecureContext({
    ca: [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])],
  });
  return context;
}

export interface Pinned {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  /** Only the ones a page reads the body with: see READABLE. */
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface FetchOptions {
  /** Sent with each hop, except Accept-Encoding: the body is always asked for unencoded. */
  headers?: Record<string, string>;
  /**
   * Refuses a redirect to another origin. The browser files the body under the URL it asked for, so a page would read
   * another origin's answer as its own.
   */
  sameOrigin?: boolean;
  /** The page itself: a hop answered from a public address narrows the budget (see Budget.narrow). */
  navigation?: boolean;
}

export async function fetchPinned(
  href: string,
  budget: Budget,
  deps: PinnedDeps = network,
  { headers = {}, sameOrigin = false, navigation = false }: FetchOptions = {},
): Promise<Pinned> {
  const origin = URL.parse(href)?.origin;
  for (let redirects = 0; ; redirects++) {
    const response = await hop(href, budget, deps, headers, navigation);
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.location : undefined;
    if (location === undefined) {
      return { ...response, headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => READABLE(name))) };
    }
    const next = URL.parse(location, href);
    if (!next) throw new Refused('invalid', location);
    if (redirects === REDIRECTS || (sameOrigin && next.origin !== origin)) throw new Refused('redirects', next.href);
    href = next.href;
  }
}

async function hop(
  href: string,
  budget: Budget,
  deps: PinnedDeps,
  headers: Record<string, string>,
  navigation: boolean,
): Promise<Pinned> {
  const refusal = urlRefusal(href, budget.policy);
  if (refusal) throw new Refused(refusal, href);
  budget.signal.throwIfAborted();
  if (budget.requests >= CAPTURE_REQUESTS || budget.bytes >= CAPTURE_BYTES) throw new Refused('budget', href);
  budget.requests++;
  const url = new URL(href);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  // The slot is taken before the lookup, so a page cannot start more resolutions than it may open connections.
  const release = await budget.connection();
  try {
    let lookup = budget.lookups.get(host);
    if (!lookup) {
      lookup = deps.lookup(host, budget.signal).catch((): dns.LookupAddress[] => []);
      budget.lookups.set(host, lookup);
    }
    const answers = await beforeDeadline(lookup, budget.signal);
    // An abort before beforeDeadline listened (inside the lookup) never fires its listener.
    budget.signal.throwIfAborted();
    const addresses = answers.map(({ address }) => address);
    const refused = addressRefusal(addresses, budget.policy);
    if (refused) throw new Refused(refused, href);
    // Any public answer counts: the server could have dialed that one.
    if (navigation && addresses.some((address) => addressRefusal([address], STRICT) === null)) budget.narrow();
    return await get(url, host, answers, budget, deps, headers);
  } finally {
    release();
  }
}

/** Rejects with the signal's reason once it aborts, so a slow lookup cannot outlive the budget. */
function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', stop));
}

function get(
  url: URL,
  host: string,
  answers: dns.LookupAddress[],
  budget: Budget,
  deps: PinnedDeps,
  headers: Record<string, string>,
): Promise<Pinned> {
  const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  const lookup: net.LookupFunction = (_hostname, options, callback) =>
    options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family);
  const connect: Connect = {
    protocol,
    host,
    port: portOf(url),
    ...(protocol === 'https:' && !net.isIP(host) ? { servername: host } : {}),
    lookup,
  };
  return new Promise((resolve, reject) => {
    const request = (protocol === 'https:' ? https : http).request(
      {
        protocol,
        host,
        port: connect.port,
        path: url.pathname + url.search,
        headers: { ...headers, 'accept-encoding': 'identity' },
        signal: budget.signal,
        timeout: budget.idle,
        agent: budget.agents[protocol],
        createConnection: () => {
          const socket = budget.dial(() => deps.createConnection(connect));
          // Prepended: tls.connect already listens to 'connect' to send its ClientHello, which must not leave first.
          socket.prependOnceListener('connect', () => {
            if (!answers.some(({ address }) => address === socket.remoteAddress))
              socket.destroy(new Refused('private', url.href));
          });
          return socket;
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          budget.bytes += chunk.length;
          if (size > RESOURCE_BYTES || budget.bytes > CAPTURE_BYTES) response.destroy(new Refused('too-large', url.href));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({ url: url.href, status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Refused('slow', url.href)));
    request.on('error', reject);
    request.end();
  });
}
