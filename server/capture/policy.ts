// The network policy of a capture: which URLs it may request and which resolved addresses it may reach. STRICT is public
// addresses on the default ports; a caller widens it with its own ports and allowed ranges. Pure: the caller resolves
// and connects.
import net from 'node:net';

export type UrlRefusal = 'invalid' | 'protocol' | 'port' | 'credentials';
export type AddressRefusal = 'unresolved' | 'private';

export interface Policy {
  /** Whether a URL may use this port: the one it names, or its scheme's default. */
  allowsPort: (port: number) => boolean;
  /** Ranges of PRIVATE this policy reaches anyway. */
  allowed?: net.BlockList;
}

export const STRICT: Policy = { allowsPort: (port) => port === 80 || port === 443 };

/** The port a request to `url` dials. */
export function portOf(url: URL): number {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

/** Why a capture may not request `href`, or null. */
export function urlRefusal(href: string, policy: Policy = STRICT): UrlRefusal | null {
  const url = URL.parse(href);
  if (!url) return 'invalid';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'protocol';
  if (!policy.allowsPort(portOf(url))) return 'port';
  if (url.username || url.password) return 'credentials';
  return null;
}

/**
 * Never reached unless a policy allows it. No `::ffff:0:0/96` rule: BlockList already checks an IPv4-mapped address
 * against the IPv4 rules, and that rule would block the public ones too. 198.18.0.0/15 is also where fake-IP proxies
 * answer every name, then resolve it again behind this check. The IPv6 transition ranges (IPv4-compatible, SIIT, local
 * NAT64, Teredo) can lead to the LAN on a host that routes them.
 */
export const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('0.0.0.0', 8);
PRIVATE.addSubnet('10.0.0.0', 8);
PRIVATE.addSubnet('100.64.0.0', 10);
PRIVATE.addSubnet('127.0.0.0', 8);
PRIVATE.addSubnet('169.254.0.0', 16);
PRIVATE.addSubnet('172.16.0.0', 12);
PRIVATE.addSubnet('192.0.0.0', 24);
PRIVATE.addSubnet('192.0.2.0', 24);
PRIVATE.addSubnet('192.168.0.0', 16);
PRIVATE.addSubnet('198.18.0.0', 15);
PRIVATE.addSubnet('198.51.100.0', 24);
PRIVATE.addSubnet('203.0.113.0', 24);
PRIVATE.addSubnet('224.0.0.0', 3);
PRIVATE.addSubnet('::', 96, 'ipv6');
PRIVATE.addSubnet('::ffff:0:0:0', 96, 'ipv6');
PRIVATE.addSubnet('64:ff9b:1::', 48, 'ipv6');
PRIVATE.addSubnet('100::', 64, 'ipv6');
PRIVATE.addSubnet('2001::', 32, 'ipv6');
PRIVATE.addSubnet('2001:db8::', 32, 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');
PRIVATE.addSubnet('fec0::', 10, 'ipv6');
PRIVATE.addSubnet('ff00::', 8, 'ipv6');

/** Why a host that resolves to `addresses` may not be reached, or null: one forbidden address refuses them all. */
export function addressRefusal(addresses: readonly string[], policy: Policy = STRICT): AddressRefusal | null {
  if (addresses.length === 0) return 'unresolved';
  return addresses.some((address) => forbidden(address, policy)) ? 'private' : null;
}

function forbidden(scoped: string, { allowed }: Policy): boolean {
  // BlockList never matches an address with a zone (fe80::1%en0).
  const address = scoped.split('%')[0];
  const family = net.isIP(address);
  if (family === 0) return true;
  const forms: [string, 'ipv4' | 'ipv6'][] = [[address, family === 4 ? 'ipv4' : 'ipv6']];
  const ipv4 = family === 6 ? embeddedIpv4(address) : null;
  if (ipv4 !== null) forms.push([ipv4, 'ipv4']);
  return forms.some(([form, type]) => PRIVATE.check(form, type) && !allowed?.check(form, type));
}

/** The IPv4 inside NAT64 (64:ff9b::/96) and 6to4 (2002::/16): on a network with a local NAT64, they lead to the LAN. */
function embeddedIpv4(address: string): string | null {
  const groups = hextets(address);
  const ipv4 = (high: number, low: number) => [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return ipv4(groups[6], groups[7]);
  }
  if (groups[0] === 0x2002) return ipv4(groups[1], groups[2]);
  return null;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function hextets(address: string): number[] {
  // The URL parser writes a dotted IPv4 tail in hex: 64:ff9b::10.0.0.1 becomes 64:ff9b::a00:1.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail] = canonical.split('::');
  const groups = (part: string) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  if (tail === undefined) return groups(head);
  const left = groups(head);
  const right = groups(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}
