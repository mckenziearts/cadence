// The network policy of a capture: which URLs and which resolved addresses it may reach, strict by default and widened
// by its ports and allowed ranges. Pure, no network.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { addressRefusal, type Policy, PRIVATE, STRICT, urlRefusal } from '../../server/capture/policy';

test('a public http or https URL on the default ports is admitted', () => {
  for (const href of [
    'https://example.com/',
    'http://example.com/about?x=1',
    'https://example.com:443/',
    'http://example.com:80/',
    'https://example.com:80/',
    'http://[2606:4700::1111]/',
  ]) {
    assert.equal(urlRefusal(href), null, href);
  }
});

test('another scheme, another port, credentials or no host are refused', () => {
  assert.equal(urlRefusal('ftp://example.com/'), 'protocol');
  assert.equal(urlRefusal('file:///etc/passwd'), 'protocol');
  assert.equal(urlRefusal('javascript:alert(1)'), 'protocol');
  assert.equal(urlRefusal('https://example.com:8080/'), 'port');
  assert.equal(urlRefusal('http://example.com:22/'), 'port');
  assert.equal(urlRefusal('https://user:pass@example.com/'), 'credentials');
  assert.equal(urlRefusal('https://user@example.com/'), 'credentials');
  assert.equal(urlRefusal('https://:pass@example.com/'), 'credentials');
  assert.equal(urlRefusal('http://'), 'invalid');
  assert.equal(urlRefusal('example.com'), 'invalid');
  assert.equal(urlRefusal(''), 'invalid');
});

const LAST = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff';

// The neighbours just outside each range: null when there is none, or when it belongs to another range of the table.
const ranges: [range: string, first: string, last: string, below: string | null, above: string | null][] = [
  ['0.0.0.0/8', '0.0.0.0', '0.255.255.255', null, '1.0.0.0'],
  ['10.0.0.0/8', '10.0.0.0', '10.255.255.255', '9.255.255.255', '11.0.0.0'],
  ['100.64.0.0/10', '100.64.0.0', '100.127.255.255', '100.63.255.255', '100.128.0.0'],
  ['127.0.0.0/8', '127.0.0.0', '127.255.255.255', '126.255.255.255', '128.0.0.0'],
  ['169.254.0.0/16', '169.254.0.0', '169.254.255.255', '169.253.255.255', '169.255.0.0'],
  ['172.16.0.0/12', '172.16.0.0', '172.31.255.255', '172.15.255.255', '172.32.0.0'],
  ['192.0.0.0/24', '192.0.0.0', '192.0.0.255', '191.255.255.255', '192.0.1.0'],
  ['192.0.2.0/24', '192.0.2.0', '192.0.2.255', '192.0.1.255', '192.0.3.0'],
  ['192.168.0.0/16', '192.168.0.0', '192.168.255.255', '192.167.255.255', '192.169.0.0'],
  ['198.18.0.0/15', '198.18.0.0', '198.19.255.255', '198.17.255.255', '198.20.0.0'],
  ['198.51.100.0/24', '198.51.100.0', '198.51.100.255', '198.51.99.255', '198.51.101.0'],
  ['203.0.113.0/24', '203.0.113.0', '203.0.113.255', '203.0.112.255', '203.0.114.0'],
  ['224.0.0.0/3', '224.0.0.0', '255.255.255.255', '223.255.255.255', null],
  ['::/96', '::', '::ffff:ffff', null, '::1:0:0'],
  ['::ffff:0:0:0/96', '::ffff:0:0:0', '::ffff:0:ffff:ffff', '::fffe:ffff:ffff:ffff', '::ffff:1:0:0'],
  ['64:ff9b:1::/48', '64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '64:ff9b:2::'],
  ['100::/64', '100::', '100::ffff:ffff:ffff:ffff', `ff:${LAST}`, '100:0:0:1::'],
  ['2001::/32', '2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff', `2000:${LAST}`, '2001:1::'],
  [
    '2001:db8::/32',
    '2001:db8::',
    '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db9::',
  ],
  ['fc00::/7', 'fc00::', `fdff:${LAST}`, `fbff:${LAST}`, 'fe00::'],
  ['fe80::/10', 'fe80::', `febf:${LAST}`, `fe7f:${LAST}`, null],
  ['fec0::/10', 'fec0::', `feff:${LAST}`, null, null],
  ['ff00::/8', 'ff00::', `ffff:${LAST}`, null, null],
];

test('the range table holds every range of PRIVATE, and only those', () => {
  const rules = PRIVATE.rules.map((rule) => rule.replace(/^\w+: IPv[46] /, '').replace(/^([^/]+)$/, '$1/128'));
  assert.deepEqual(new Set(rules), new Set(ranges.map(([range]) => range)));
});

for (const [range, first, last, below, above] of ranges) {
  test(`${range}: its first and last addresses are refused, the ones just outside are admitted`, () => {
    assert.equal(addressRefusal([first]), 'private', first);
    assert.equal(addressRefusal([last]), 'private', last);
    for (const outside of [below, above]) {
      if (outside !== null) assert.equal(addressRefusal([outside]), null, outside);
    }
  });
}

test('public addresses are admitted', () => {
  for (const address of ['8.8.8.8', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(addressRefusal([address]), null, address);
  }
});

test('an empty answer is refused, and one forbidden address refuses them all', () => {
  assert.equal(addressRefusal([]), 'unresolved');
  assert.equal(addressRefusal(['8.8.8.8', '10.0.0.1']), 'private');
  assert.equal(addressRefusal(['2606:4700::1111', '::1']), 'private');
  assert.equal(addressRefusal(['8.8.8.8', '2606:4700::1111']), null);
});

test('an IPv4-mapped IPv6 address is checked against the IPv4 rules', () => {
  assert.equal(addressRefusal(['::ffff:10.0.0.1']), 'private');
  assert.equal(addressRefusal(['::ffff:a00:1']), 'private');
  assert.equal(addressRefusal(['::ffff:169.254.169.254']), 'private');
  assert.equal(addressRefusal(['::ffff:8.8.8.8']), null);
});

test('the IPv4 inside NAT64 (64:ff9b::/96) and 6to4 (2002::/16) is extracted and checked', () => {
  assert.equal(addressRefusal(['64:ff9b::10.0.0.1']), 'private');
  assert.equal(addressRefusal(['64:ff9b::c0a8:101']), 'private');
  assert.equal(addressRefusal(['64:ff9b::8.8.8.8']), null);
  assert.equal(addressRefusal(['2002:c0a8:101::1']), 'private');
  assert.equal(addressRefusal(['2002:a9fe:a9fe:1:2:3:4:5']), 'private');
  assert.equal(addressRefusal(['2002:808:808::1']), null);
});

test('a scoped address is checked without its zone, and anything that is not an address is refused', () => {
  assert.equal(addressRefusal(['fe80::1%en0']), 'private');
  assert.equal(addressRefusal(['2606:4700::1111%en0']), null);
  assert.equal(addressRefusal(['example.com']), 'private');
  assert.equal(addressRefusal(['']), 'private');
});

test('a policy decides its ports, the scheme default included when the URL names none', () => {
  const devServer: Policy = { allowsPort: (port) => port === 5173 };
  assert.equal(urlRefusal('http://localhost:5173/', devServer), null);
  assert.equal(urlRefusal('http://localhost/', devServer), 'port');
  assert.equal(urlRefusal('https://example.com/', devServer), 'port');

  const notOurs: Policy = { allowsPort: (port) => port !== 4321 };
  assert.equal(urlRefusal('http://localhost:8080/', notOurs), null);
  assert.equal(urlRefusal('http://localhost:4321/', notOurs), 'port');
  assert.equal(urlRefusal('ftp://localhost:8080/', notOurs), 'protocol');
  assert.equal(urlRefusal('http://user@localhost:8080/', notOurs), 'credentials');
});

test('allowed ranges open part of PRIVATE, in every IPv6 form of their IPv4 addresses, and nothing else', () => {
  const allowed = new net.BlockList();
  allowed.addSubnet('127.0.0.0', 8);
  allowed.addAddress('::1', 'ipv6');
  const loopback: Policy = { allowsPort: STRICT.allowsPort, allowed };
  for (const address of ['127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1']) {
    assert.equal(addressRefusal([address], loopback), null, address);
  }
  for (const address of ['10.0.0.1', '::ffff:192.168.1.1', '64:ff9b::a00:1', 'fe80::1', '::']) {
    assert.equal(addressRefusal([address], loopback), 'private', address);
  }
  assert.equal(addressRefusal(['127.0.0.1', '10.0.0.1'], loopback), 'private');
  assert.equal(addressRefusal(['127.0.0.1', '8.8.8.8'], loopback), null);
  assert.equal(addressRefusal([], loopback), 'unresolved');
  assert.equal(addressRefusal(['example.com'], loopback), 'private');
});
