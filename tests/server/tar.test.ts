// tar streams: what writeTar produces, and every archive readTar refuses (hostile headers are built by hand).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { createGunzip, createGzip } from 'node:zlib';
import { readTar, writeTar, type ReadTarOptions } from '../../server/archive/tar';

const MiB = 1024 * 1024;
const timed = { timeout: 10_000 };

interface RawHeader {
  name?: string;
  type?: string;
  size?: number;
  prefix?: string;
  sizeField?: Buffer;
}

function rawHeader({ name = '', type = '0', size = 0, prefix = '', sizeField }: RawHeader): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  if (sizeField) sizeField.copy(block, 124);
  else block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write(type, 156);
  block.write('ustar\x0000', 257);
  block.write(prefix, 345, 155);
  block.fill(' ', 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0`, 148);
  return block;
}

const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
const END = Buffer.alloc(1024);

function fileEntry(name: string, content = '', type = '0'): Buffer {
  const data = Buffer.from(content);
  return Buffer.concat([rawHeader({ name, type, size: data.length }), padded(data)]);
}

function paxEntry(records: Record<string, string>, type = 'x'): Buffer {
  const data = Buffer.from(
    Object.entries(records)
      .map(([key, value]) => {
        const base = Buffer.byteLength(` ${key}=${value}\n`);
        let length = base;
        while (String(length).length + base !== length) length = String(length).length + base;
        return `${length} ${key}=${value}\n`;
      })
      .join(''),
  );
  return rawPax(data, type);
}

const rawPax = (data: Buffer | string, type = 'x') =>
  Buffer.concat([rawHeader({ name: 'PaxHeader', type, size: Buffer.byteLength(data) }), padded(Buffer.from(data))]);

const archive = (...parts: Buffer[]) => Buffer.concat([...parts, END]);

async function read(input: Buffer | Readable, options: Partial<ReadTarOptions> = {}): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  await readTar(Buffer.isBuffer(input) ? Readable.from([input]) : input, {
    maxBytes: 64 * MiB,
    maxEntries: 1000,
    maxBuffered: MiB,
    onFile: async (entry) => void files.set(entry.path, await buffer(entry.stream)),
    ...options,
  });
  return files;
}

/** `count` zero chunks of 64 KiB, produced only when asked for; `produced()` tells how many bytes went out. */
function lazyZeros(count: number) {
  let produced = 0;
  const stream = Readable.from(
    (function* () {
      for (let i = 0; i < count; i++) {
        produced += 64 * 1024;
        yield Buffer.alloc(64 * 1024);
      }
    })(),
  );
  return { stream, produced: () => produced };
}

async function tempDir(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-tar-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const LONG_SPLIT = `deep/${'d'.repeat(60)}/${'f'.repeat(70)}.bin`;
const LONG_PAX = `${'p'.repeat(150)}/${'q'.repeat(149)}`;

test('a tree goes through writeTar + gzip and comes back byte for byte through gunzip + readTar', timed, async (t) => {
  const dir = await tempDir(t);
  const binary = Buffer.alloc(MiB);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 7919) % 256;
  const tree = new Map<string, Buffer>([
    ['empty.txt', Buffer.alloc(0)],
    [LONG_SPLIT, Buffer.from('split name')],
    [LONG_PAX, Buffer.from('pax name')],
    ['media/noise.bin', binary],
    ['scènes/été 日本.tsx', Buffer.from('export const titre = "Été";\n')],
  ]);
  for (const [rel, content] of tree) {
    await fs.mkdir(path.join(dir, 'src', path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', rel), content);
  }
  assert.equal(LONG_SPLIT.length, 140);

  const entries = [
    { path: 'music', directory: true as const },
    ...[...tree.keys()].map((rel) => ({ path: rel, file: path.join(dir, 'src', rel) })),
  ];
  const gzipped = await buffer(writeTar(entries).pipe(createGzip()));
  assert.deepEqual(await read(Readable.from([gzipped]).pipe(createGunzip())), tree);

  const file = path.join(dir, 'tree.tar.gz');
  await fs.writeFile(file, gzipped);
  const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listed, ['music/', ...tree.keys()].sort());
});

test(
  'writeTar headers: ustar name/prefix split, pax path when it does not fit, fixed modes, mtime 0, two end blocks',
  timed,
  async (t) => {
    const dir = await tempDir(t);
    const source = path.join(dir, 'a.txt');
    await fs.writeFile(source, 'abc');
    const tar = await buffer(
      writeTar([
        { path: LONG_SPLIT, file: source },
        { path: 'scenes', directory: true },
        { path: LONG_PAX, file: source },
      ]),
    );
    const field = (offset: number, start: number, length: number) =>
      tar.toString('utf8', offset + start, offset + start + length).replace(/\0+$/, '');

    assert.equal(field(0, 156, 1), '0');
    assert.equal(`${field(0, 345, 155)}/${field(0, 0, 100)}`, LONG_SPLIT);
    assert.equal(field(0, 100, 8), '0000644');
    assert.equal(field(0, 136, 12), '00000000000');
    assert.equal(field(0, 257, 8), 'ustar\x0000');
    assert.equal(field(1024, 0, 100), 'scenes/');
    assert.equal(field(1024, 156, 1), '5');
    assert.equal(field(1024, 100, 8), '0000755');
    assert.equal(field(1536, 156, 1), 'x');
    assert.ok(tar.toString('utf8', 2048, 2560).includes(` path=${LONG_PAX}\n`));
    assert.equal(tar.length, 512 * 9);
    assert.ok(tar.subarray(-1024).every((byte) => byte === 0));
  },
);

test('writeTar measures paths in bytes and sends what ustar cannot hold through pax', timed, async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'a.txt');
  await fs.writeFile(source, 'abc');
  const cases: [string, boolean][] = [
    ['n'.repeat(100), false],
    ['é'.repeat(60), true],
    [`${'a'.repeat(160)}/b.txt`, true],
  ];
  for (const [rel, pax] of cases) {
    const tar = await buffer(writeTar([{ path: rel, file: source }]));
    assert.equal(String.fromCharCode(tar[156]), pax ? 'x' : '0', rel);
    assert.deepEqual(await read(tar), new Map([[rel, Buffer.from('abc')]]), rel);
  }
  assert.deepEqual(await read(await buffer(writeTar([{ path: 'd'.repeat(120), directory: true }]))), new Map());
});

test('writeTar pulls a 50 MB file as it is read, never all at once', timed, async (t) => {
  const dir = await tempDir(t);
  const big = path.join(dir, 'big.bin');
  await fs.writeFile(big, '');
  await fs.truncate(big, 50 * MiB);
  const before = process.memoryUsage().arrayBuffers;
  let received = 0;
  for await (const chunk of writeTar([{ path: 'big.bin', file: big }])) {
    received += (chunk as Buffer).length;
    if (received > MiB) break;
  }
  const grown = process.memoryUsage().arrayBuffers - before;
  assert.ok(grown < 16 * MiB, `${grown} bytes allocated for the first MiB`);
  let total = 0;
  for await (const chunk of writeTar([{ path: 'big.bin', file: big }])) total += (chunk as Buffer).length;
  assert.equal(total, 512 + 50 * MiB + 1024);
});

test('writeTar refuses a directory source, and a symlink even when it replaces a file after the listing', timed, async (t) => {
  const dir = await tempDir(t);
  await fs.symlink('/etc/hosts', path.join(dir, 'link'));
  await assert.rejects(buffer(writeTar([{ path: 'dir', file: dir }])), /not a regular file/);
  await assert.rejects(buffer(writeTar([{ path: 'link', file: path.join(dir, 'link') }])), /ELOOP/);
});

test('writeTar refuses a file that shrinks while it is archived', timed, async (t) => {
  const dir = await tempDir(t);
  const big = path.join(dir, 'big.bin');
  await fs.writeFile(big, '');
  await fs.truncate(big, 50 * MiB);
  const chunks = writeTar([{ path: 'big.bin', file: big }])[Symbol.asyncIterator]();
  await chunks.next();
  await fs.truncate(big, MiB);
  await assert.rejects(
    (async () => {
      while (!(await chunks.next()).done);
    })(),
    /changed while it was archived/,
  );
});

test('readTar skips global pax headers and directory entries, and reads past a file onFile left unread', timed, async () => {
  const seen: string[] = [];
  await readTar(
    Readable.from([
      archive(paxEntry({ comment: 'hi' }, 'g'), fileEntry('dir/', '', '5'), fileEntry('a', 'A'), fileEntry('b', 'B')),
    ]),
    {
      maxBytes: MiB,
      maxEntries: 10,
      maxBuffered: MiB,
      onFile: async (entry) => {
        seen.push(entry.path);
        if (entry.path === 'b') assert.equal((await entry.buffer()).toString(), 'B');
      },
    },
  );
  assert.deepEqual(seen, ['a', 'b']);
});

test('readTar reads a type NUL entry as a regular file and ignores a path in a global pax header', timed, async () => {
  assert.deepEqual(await read(archive(fileEntry('a', 'A', '\0'))), new Map([['a', Buffer.from('A')]]));
  assert.deepEqual(await read(archive(paxEntry({ path: 'evil' }, 'g'), fileEntry('a', 'A'))), new Map([['a', Buffer.from('A')]]));
});

test('readTar refuses malformed pax records', timed, async () => {
  for (const data of ['6 a=b\n x\n', '6 a=bc', '99 a=b\n', 'xx a=b\n']) {
    await assert.rejects(read(archive(rawPax(data), fileEntry('a'))), /malformed pax/, JSON.stringify(data));
  }
});

test('readTar refuses a directory entry with a size', timed, async () => {
  await assert.rejects(read(archive(fileEntry('d/', 'xx', '5'))), /"d" has a size/);
});

test('readTar refuses links, devices, fifos and unknown types, naming the entry', timed, async () => {
  for (const type of ['1', '2', '3', '4', '6', '7', 'L', 'K']) {
    await assert.rejects(read(archive(fileEntry(`entry-${type}`, '', type))), new RegExp(`entry-${type}`), type);
  }
});

test('readTar refuses unsafe paths', timed, async () => {
  const unsafe = ['/etc/passwd', '../x', 'a/../x', 'a/..', './a', 'a/./b', 'a//b', 'a\\b', 'a\0b', '', 'a/'.repeat(512) + 'b'];
  for (const name of unsafe) {
    const header = Buffer.byteLength(name) <= 100 && !name.includes('\0') ? [] : [paxEntry({ path: name })];
    await assert.rejects(read(archive(...header, fileEntry(header.length ? 'x' : name))), /unsafe path/i, JSON.stringify(name));
  }
  await assert.rejects(read(archive(fileEntry('a/../', '', '5'))), /unsafe path/i);
  const longest = `${'a'.repeat(9)}/`.repeat(102) + 'b'.repeat(4);
  assert.equal(longest.length, 1024);
  assert.ok((await read(archive(paxEntry({ path: longest }), fileEntry('x')))).has(longest));
});

test('readTar refuses a duplicate path, also when it differs only by case or Unicode normalization', timed, async () => {
  await assert.rejects(read(archive(fileEntry('a', '1'), fileEntry('a', '2'))), /duplicate.*"a"/i);
  await assert.rejects(read(archive(fileEntry('a/', '', '5'), fileEntry('a', '2'))), /duplicate.*"a"/i);
  await assert.rejects(read(archive(fileEntry('Readme.md', '1'), fileEntry('README.MD', '2'))), /duplicate.*"README.MD"/i);
  await assert.rejects(read(archive(fileEntry('café', '1'), fileEntry('café', '2'))), /duplicate/i);
});

test('readTar refuses more entries than maxEntries, directories included', timed, async () => {
  const three = archive(fileEntry('a'), fileEntry('b'), fileEntry('c'));
  assert.equal((await read(three, { maxEntries: 3 })).size, 3);
  await assert.rejects(read(three, { maxEntries: 2 }), /more than 2 entries/);
  await assert.rejects(
    read(archive(fileEntry('a/', '', '5'), fileEntry('b/', '', '5'), fileEntry('c')), { maxEntries: 2 }),
    /more than 2 entries/,
  );
});

test('readTar refuses an entry whose declared size is over maxBytes before calling onFile', timed, async () => {
  let called = false;
  await assert.rejects(
    read(archive(rawHeader({ name: 'big', size: 8 * MiB }), Buffer.alloc(512)), {
      maxBytes: 4 * MiB,
      onFile: async () => void (called = true),
    }),
    /over 4194304 bytes/,
  );
  assert.equal(called, false);
});

test('readTar stops a gzip of zeros claiming 5 GiB at the cap', timed, async () => {
  const zeros = lazyZeros(80_000);
  const input = Readable.from(
    (async function* () {
      yield rawHeader({ name: 'bomb', size: 5 * 1024 * MiB });
      yield* zeros.stream;
    })(),
  );
  await assert.rejects(read(input.pipe(createGzip()).pipe(createGunzip()), { maxBytes: 4 * MiB }), /over 4194304 bytes/);
  assert.ok(zeros.produced() < 64 * MiB, `${zeros.produced()} bytes produced`);
});

test('readTar counts every unpacked byte, trailing ones included, while streaming', timed, async () => {
  const zeros = lazyZeros(80_000);
  const input = Readable.from(
    (async function* () {
      yield archive(fileEntry('a', 'A'));
      yield* zeros.stream;
    })(),
  );
  await assert.rejects(read(input.pipe(createGzip()).pipe(createGunzip()), { maxBytes: 4 * MiB }), /over 4194304 bytes/);
  assert.ok(zeros.produced() < 64 * MiB, `${zeros.produced()} bytes produced`);
});

test('readTar refuses a bad checksum, a truncated entry, a missing end and a base-256 size', timed, async () => {
  const corrupt = fileEntry('a', 'A');
  corrupt[0] = 'b'.charCodeAt(0);
  await assert.rejects(read(archive(corrupt)), /checksum/i);
  await assert.rejects(read(fileEntry('a', 'x'.repeat(1000)).subarray(0, 900)), /truncated/i);
  await assert.rejects(read(fileEntry('a', 'A')), /truncated/i);
  await assert.rejects(read(Buffer.concat([fileEntry('a', 'A'), Buffer.alloc(512)])), /truncated/i);
  const base256 = Buffer.alloc(12);
  base256[0] = 0x80;
  base256[11] = 1;
  await assert.rejects(read(archive(rawHeader({ name: 'a', sizeField: base256 }), Buffer.alloc(512))), /size/i);
  await assert.rejects(read(Buffer.concat([Buffer.alloc(512), fileEntry('a', 'A'), END])), /damaged end/i);
  await assert.rejects(read(fileEntry('a', 'A').subarray(0, 600)), /truncated/i);
  await assert.rejects(read(paxEntry({ path: 'a' }).subarray(0, 520)), /truncated/i);
});

test('readTar destroys its input after a refusal', timed, async () => {
  const corrupt = fileEntry('a', 'A');
  corrupt[0] = 'b'.charCodeAt(0);
  const input = Readable.from([archive(corrupt), Buffer.alloc(512)]);
  await assert.rejects(read(input), /checksum/i);
  assert.equal(input.destroyed, true);
});

test('readTar ends the stream of an entry the archive cuts short, so onFile settles', timed, async () => {
  let settled = false;
  await assert.rejects(
    read(fileEntry('a', 'x'.repeat(100_000)).subarray(0, 40_000), {
      onFile: async (entry) => {
        await assert.rejects(buffer(entry.stream));
        settled = true;
      },
    }),
    /truncated/i,
  );
  assert.equal(settled, true);
});

test('readTar keeps memory bounded while onFile reads a 50 MB entry slowly', timed, async () => {
  const zeros = lazyZeros(800);
  const input = Readable.from(
    (async function* () {
      yield rawHeader({ name: 'big', size: 50 * MiB });
      yield* zeros.stream;
      yield END;
    })(),
  );
  let ahead = 0;
  await read(input, {
    onFile: async (entry) => {
      let consumed = 0;
      for await (const chunk of entry.stream) {
        ahead = Math.max(ahead, zeros.produced() - consumed);
        consumed += (chunk as Buffer).length;
        await new Promise(setImmediate);
      }
      assert.equal(consumed, 50 * MiB);
    },
  });
  assert.ok(ahead < 8 * MiB, `${ahead} bytes read ahead of onFile`);
});

test('pax headers: an x header over 64 KiB is refused, a g header of any size is skipped', timed, async () => {
  await assert.rejects(read(archive(paxEntry({ comment: 'a'.repeat(70_000) }), fileEntry('x'))), /over 65536 bytes/);
  assert.equal(
    (await read(archive(paxEntry({ comment: 'a'.repeat(2 * MiB) }, 'g'), fileEntry('x')), { maxBuffered: 512 })).size,
    1,
  );
});

test('maxBuffered caps entry.buffer()', timed, async () => {
  const big = archive(fileEntry('manifest.json', 'x'.repeat(600)));
  const buffered = (maxBuffered: number) =>
    readTar(Readable.from([big]), {
      maxBytes: MiB,
      maxEntries: 10,
      maxBuffered,
      onFile: (entry) => entry.buffer().then(() => {}),
    });
  await buffered(600);
  await assert.rejects(buffered(599), /"manifest.json" is over 599 bytes/);
});

test('an error thrown by onFile stops the read', timed, async () => {
  await assert.rejects(
    readTar(Readable.from([archive(fileEntry('a', 'x'.repeat(100_000)), fileEntry('b'))]), {
      maxBytes: MiB,
      maxEntries: 10,
      maxBuffered: MiB,
      onFile: async () => {
        throw new Error('refused by the caller');
      },
    }),
    /refused by the caller/,
  );
});
