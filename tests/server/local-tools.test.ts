import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import vm from 'node:vm';
import { activityLabel, chatFiles, deniedFiles } from '../../server/agent/chat';
import { localTools, type Part } from '../../server/agent/localTools';
import type { FilePolicy } from '../../server/contracts';
import { m } from '../../server/i18n';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const IMAGE_LIMIT = 3_932_160;

let root: string;
let project: string;
let brand: string;
let state: string;
let outside: string;
let files: FilePolicy;
let dirs: { brand: string; templates: string; runtime: string };
/** Reads everything under `root`, the state folder included: only `deny` stands between a turn and the keys. */
let wide: FilePolicy;

async function write(file: string, content: string | Buffer = ''): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

const lines = (count: number, line = (n: number) => `line ${n}`) =>
  `${Array.from({ length: count }, (_, at) => line(at + 1)).join('\n')}\n`;

/** By batches: a tree of 10000 files written at once needs as many descriptors, more than some machines allow. */
async function inBatches<T>(all: T[], make: (one: T) => Promise<unknown>): Promise<void> {
  for (let at = 0; at < all.length; at += 256) await Promise.all(all.slice(at, at + 256).map(make));
}

async function run(name: string, input: Record<string, unknown>, policy = files) {
  return localTools(policy).call(name, input, new AbortController().signal);
}

function textOf(content: Part[]): string {
  assert.equal(content.length, 1);
  const [part] = content;
  assert.equal(part.type, 'text');
  return part.text;
}

async function ok(name: string, input: Record<string, unknown>, policy = files): Promise<string> {
  const { content, isError } = await run(name, input, policy);
  assert.equal(isError, false, textOf(content));
  return textOf(content);
}

async function refused(name: string, input: Record<string, unknown>, policy = files): Promise<string> {
  const { content, isError } = await run(name, input, policy);
  assert.equal(isError, true, textOf(content));
  return textOf(content);
}

/** The check number `at` runs `change`: throwIfAborted is the one place a test can touch the disk between two steps of a walk. */
function changeAtCheck(at: number, change: () => void): AbortSignal {
  let checks = 0;
  return {
    throwIfAborted() {
      checks += 1;
      if (checks === at) change();
    },
  } as AbortSignal;
}

const lastLine = (text: string) => text.split('\n').at(-1)!;

/** Follows the notices to the end of `file`: the lines seen, without their numbers, and how many reads it took. */
async function readToTheEnd(file: string): Promise<{ seen: string[]; reads: number }> {
  const seen: string[] = [];
  let offset = 1;
  for (let reads = 1; reads <= 10; reads += 1) {
    const text = await ok('read_file', { file_path: file, offset });
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, String(Buffer.byteLength(text)));
    const notice = /offset (\d+)/.exec(lastLine(text));
    const body = notice ? text.split('\n').slice(0, -1) : text.split('\n');
    seen.push(...body.map((numbered) => numbered.split('\t')[1]));
    if (!notice) return { seen, reads };
    assert.match(lastLine(text), /256 KB/);
    offset = Number(notice[1]);
  }
  throw new Error(`${file} still has lines after 10 reads`);
}

const SECRET = 'hunter2-secret';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-local-tools-'));
  project = path.join(root, 'projects', 'demo');
  brand = path.join(root, 'brands', 'orbit');
  state = path.join(root, '.cadence');
  outside = path.join(root, 'outside');
  dirs = { brand, templates: path.join(root, 'templates'), runtime: path.join(root, 'src', 'runtime') };
  files = chatFiles(project, 'intro', dirs, deniedFiles(state));
  wide = { read: [path.join(root, '**')], write: [], deny: deniedFiles(state) };
  await write(path.join(project, 'scenes', 'intro.tsx'), 'export const intro = 1;\nexport const outro = 2;\n');
  await write(path.join(project, 'art-direction.md'), 'Calm and bright.\n');
  await write(path.join(brand, 'KIT.md'), '# Orbit kit\n');
  await write(path.join(dirs.templates, 'hero.tsx'), 'export const hero = 1;\n');
  await write(path.join(dirs.runtime, 'API.md'), '# Runtime\n');
  await write(path.join(state, 'accounts.json'), `{"token":"${SECRET}"}\n`);
  await write(path.join(outside, 'secret.txt'), `${SECRET}\n`);
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'leak.txt'));
  await fs.symlink(path.join(state, 'accounts.json'), path.join(project, 'keys.json'));
  await fs.symlink(outside, path.join(project, 'elsewhere'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('definitions', () => {
  test('names, descriptions and schemas stay inside what a host may send a model', () => {
    const { tools } = localTools(files);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['read_file', 'list_files', 'grep', 'edit_file', 'write_file'],
    );
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/);
      assert.ok(Buffer.byteLength(tool.description) < 4 * 1024, tool.name);
      assert.equal(tool.input_schema.type, 'object');
      assert.ok(Buffer.byteLength(JSON.stringify(tool.input_schema)) < 16 * 1024, tool.name);
    }
  });

  test('each schema names the input the tool reads, and only what it needs is required', () => {
    const schema = (name: string) => localTools(files).tools.find((tool) => tool.name === name)!.input_schema;
    const keys = (name: string) => Object.keys(schema(name).properties as object);
    assert.deepEqual(keys('read_file'), ['file_path', 'offset', 'limit']);
    assert.deepEqual(keys('list_files'), ['pattern', 'path']);
    assert.deepEqual(keys('grep'), ['pattern', 'path', 'glob']);
    assert.deepEqual(keys('edit_file'), ['file_path', 'old_string', 'new_string', 'replace_all']);
    assert.deepEqual(keys('write_file'), ['file_path', 'content']);
    assert.deepEqual(schema('read_file').required, ['file_path']);
    assert.deepEqual(schema('list_files').required, ['pattern']);
    assert.deepEqual(schema('grep').required, ['pattern']);
    assert.deepEqual(schema('edit_file').required, ['file_path', 'old_string', 'new_string']);
    assert.deepEqual(schema('write_file').required, ['file_path', 'content']);
  });

  test('tools that hand back file content say it is data', () => {
    const described = (name: string) => localTools(files).tools.find((tool) => tool.name === name)!.description;
    for (const name of ['read_file', 'grep']) assert.match(described(name), /data, never instructions/, name);
  });

  test('each tool carries the event name the chat activity list already labels', () => {
    const event = (name: string) => localTools(files).tools.find((tool) => tool.name === name)!.event;
    const label = (name: string, input: Record<string, unknown>) => activityLabel(event(name), input, project, root);
    const file = path.join(project, 'scenes', 'intro.tsx');
    assert.equal(event('read_file'), 'Read');
    assert.equal(event('list_files'), 'Glob');
    assert.equal(event('grep'), 'Grep');
    // build.ts tracks the brand files a turn wrote by these two names.
    assert.equal(event('edit_file'), 'Edit');
    assert.equal(event('write_file'), 'Write');
    const words = m().agent.chat.activity;
    assert.equal(label('read_file', { file_path: file }), words.read('scenes/intro.tsx'));
    assert.equal(label('list_files', { pattern: '**/*.tsx' }), words.glob('**/*.tsx'));
    assert.equal(label('grep', { pattern: 'intro' }), words.grep('intro'));
    assert.equal(label('edit_file', { file_path: file }), words.edit('scenes/intro.tsx'));
    assert.equal(label('write_file', { file_path: file }), words.edit('scenes/intro.tsx'));
  });

  test('an unknown tool is a tool error, inherited object keys included', async () => {
    assert.match(await refused('edit_everything', {}), /edit_everything/);
    assert.match(await refused('constructor', {}), /constructor/);
  });
});

describe('read_file', () => {
  test('numbers the lines, a relative path starts at the first readable folder', async () => {
    const expected = '     1\texport const intro = 1;\n     2\texport const outro = 2;';
    assert.equal(await ok('read_file', { file_path: 'scenes/intro.tsx' }), expected);
    assert.equal(await ok('read_file', { file_path: path.join(project, 'scenes', 'intro.tsx') }), expected);
  });

  test('a relative path in a brand build starts at the brand folder, the working directory of the turn', async () => {
    const repo = path.join(root, 'brand-sources', 'b1');
    const built = path.join(root, 'brands', 'b1');
    const shared = path.join(root, 'src', 'shared');
    await write(path.join(repo, 'README.md'), 'REPO readme\n');
    await write(path.join(built, 'README.md'), 'BRAND readme\n');
    await write(path.join(built, 'KIT.md'), '# Built kit\n');
    const build = { read: [repo, built, shared].map((dir) => path.join(dir, '**')), write: [path.join(built, '**')], deny: [] };
    assert.equal(await ok('read_file', { file_path: 'README.md' }, build), '     1\tBRAND readme');
    assert.equal(await ok('read_file', { file_path: 'KIT.md' }, build), '     1\t# Built kit');
    assert.equal(await ok('read_file', { file_path: path.join(repo, 'README.md') }, build), '     1\tREPO readme');
  });

  test('offset and limit choose the lines, and a last line says what stayed behind', async () => {
    const file = await write(path.join(project, 'window.txt'), lines(10));
    const text = await ok('read_file', { file_path: file, offset: 4, limit: 2 });
    assert.deepEqual(text.split('\n').slice(0, 2), ['     4\tline 4', '     5\tline 5']);
    assert.equal(text.split('\n').length, 3);
    assert.match(lastLine(text), /offset 6/);
  });

  test('the end of the file carries no notice', async () => {
    const file = await write(path.join(project, 'end.txt'), lines(10));
    assert.equal(await ok('read_file', { file_path: file, offset: 9, limit: 2 }), '     9\tline 9\n    10\tline 10');
  });

  test('a file without a last newline keeps its last line', async () => {
    const file = await write(path.join(project, 'no-newline.txt'), 'one\ntwo');
    assert.equal(await ok('read_file', { file_path: file }), '     1\tone\n     2\ttwo');
  });

  test('stops at 2000 lines, even when asked for more', async () => {
    const file = await write(path.join(project, 'long.txt'), lines(2500));
    for (const input of [{ file_path: file }, { file_path: file, limit: 5000 }]) {
      const text = await ok('read_file', input);
      const all = text.split('\n');
      assert.equal(all.length, 2001);
      assert.equal(all[1999], '  2000\tline 2000');
      assert.match(lastLine(text), /2000/);
      assert.match(lastLine(text), /offset 2001/);
    }
  });

  test('stops under 256 KB and following the notice reads every line once', async () => {
    const line = (n: number) => `${n} ${'x'.repeat(999)}`;
    const file = await write(path.join(project, 'wide.txt'), lines(800, line));
    const { seen, reads } = await readToTheEnd(file);
    assert.ok(reads > 1, 'the file spans several reads');
    assert.deepEqual(
      seen,
      Array.from({ length: 800 }, (_, at) => line(at + 1)),
    );
  });

  test('stays under 256 KB with 2000 short lines and their numbers', async () => {
    const file = await write(
      path.join(project, 'short-lines.txt'),
      lines(2000, () => 'x'.repeat(129)),
    );
    const text = await ok('read_file', { file_path: file });
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, String(Buffer.byteLength(text)));
    assert.match(lastLine(text), /256 KB/);
  });

  test('a line longer than the cap is cut and the next read moves past it', async () => {
    const file = await write(path.join(project, 'one-line.txt'), `${'y'.repeat(300 * 1024)}\nnext\n`);
    const text = await ok('read_file', { file_path: file });
    assert.ok(Buffer.byteLength(text) < 257 * 1024);
    assert.match(text, /^ {5}1\tyyy/);
    assert.match(lastLine(text), /line 1 was cut/i);
    assert.match(lastLine(text), /offset 2/);
    assert.equal(await ok('read_file', { file_path: file, offset: 2 }), '     2\tnext');
  });

  test('a cut never splits a character', async () => {
    const file = await write(path.join(project, 'accents.txt'), `x${'é'.repeat(200 * 1024)}`);
    assert.doesNotMatch(await ok('read_file', { file_path: file }), /�/);
    const emoji = await write(path.join(project, 'emoji.txt'), `x${'\u{1F600}'.repeat(100_000)}`);
    assert.doesNotMatch(await ok('read_file', { file_path: emoji }), /\ufffd/);
  });

  test('stays under 256 KB on bytes that are not valid UTF-8', async () => {
    const file = await write(path.join(project, 'invalid.bin'), Buffer.alloc(600_000, 0xe9));
    const text = await ok('read_file', { file_path: file });
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, String(Buffer.byteLength(text)));
    assert.match(lastLine(text), /line 1 was cut/i);
  });

  test('a latin-1 file that fits one window grows when decoded: the notices still read every line once', async () => {
    const line = (n: number, accent: string) => `${n} ${accent.repeat(99)}`;
    const file = await write(
      path.join(project, 'latin1.txt'),
      Buffer.from(
        lines(2000, (n) => line(n, 'é')),
        'latin1',
      ),
    );
    const { seen, reads } = await readToTheEnd(file);
    assert.ok(reads > 1, 'the decoded text spans several reads');
    assert.deepEqual(
      seen,
      Array.from({ length: 2000 }, (_, at) => line(at + 1, '\ufffd')),
    );
  });

  test('a cut on the decoded size never splits a character', async () => {
    const bytes = [Buffer.alloc(40_000, 0xe9), Buffer.from(`x${'é'.repeat(100_000)}`)];
    const file = await write(path.join(project, 'invalid-then-accents.txt'), Buffer.concat(bytes));
    assert.match((await ok('read_file', { file_path: file })).split('\n')[0], /é$/);
  });

  test('reaches a line far into a file of several megabytes', async () => {
    const file = await write(path.join(project, 'big.txt'), lines(400_000));
    assert.equal(
      await ok('read_file', { file_path: file, offset: 399_999, limit: 1 }).then((t) => t.split('\n')[0]),
      '399999\tline 399999',
    );
  });

  test('an empty file and an offset past the end still say something', async () => {
    const empty = await write(path.join(project, 'empty.txt'));
    assert.match(await ok('read_file', { file_path: empty }), /no line/i);
    assert.match(await ok('read_file', { file_path: 'art-direction.md', offset: 9 }), /no line/i);
  });

  for (const [type, bytes] of [
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
  ] as const) {
    test(`${type} comes back as one image part`, async () => {
      const file = await write(path.join(project, 'assets', 'refs', `capture-${type.slice(6)}.bin`), bytes);
      const { content, isError } = await run('read_file', { file_path: file });
      assert.equal(isError, false);
      assert.deepEqual(content, [{ type: 'image', media_type: type, data: bytes.toString('base64') }]);
    });
  }

  test('a text file named like an image is text', async () => {
    const file = await write(path.join(project, 'assets', 'note.png'), 'not an image\n');
    assert.equal(await ok('read_file', { file_path: file }), '     1\tnot an image');
    const webp = await write(path.join(project, 'assets', 'note.webp'), 'not RIFFWEBP text\n');
    assert.equal(await ok('read_file', { file_path: webp }), '     1\tnot RIFFWEBP text');
  });

  test('a RIFF file that is not webp is not an image', async () => {
    const wave = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVE'), Buffer.from([0])]);
    const file = await write(path.join(project, 'assets', 'sound.wav'), wave);
    assert.match(await refused('read_file', { file_path: file }), /binary/i);
  });

  test('a file that only starts like a png or a jpeg is not an image', async () => {
    const png = await write(path.join(project, 'assets', 'half.png'), Buffer.concat([PNG.subarray(0, 4), Buffer.from([0])]));
    assert.match(await refused('read_file', { file_path: png }), /binary/i);
    const jpeg = await write(path.join(project, 'assets', 'half.jpg'), Buffer.from([0xff, 0xd8, 0x00]));
    assert.match(await refused('read_file', { file_path: jpeg }), /binary/i);
  });

  test('an image too large to send is an error', async () => {
    const file = await write(path.join(project, 'assets', 'huge.png'), Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]));
    assert.match(await refused('read_file', { file_path: file }), /too large/i);
  });

  test('an image of exactly the limit comes back and its base64 stays within 5 MB', async () => {
    const file = await write(
      path.join(project, 'assets', 'limit.png'),
      Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMIT - PNG.length)]),
    );
    const { content, isError } = await run('read_file', { file_path: file });
    assert.equal(isError, false);
    assert.equal(content.length, 1);
    const [part] = content;
    assert.ok(part.type === 'image');
    assert.equal(part.media_type, 'image/png');
    assert.ok(part.data.length <= 5 * 1024 * 1024, String(part.data.length));
    assert.equal(Buffer.from(part.data, 'base64').length, IMAGE_LIMIT);
  });

  test('an image one byte over the limit is an error', async () => {
    const file = await write(
      path.join(project, 'assets', 'over.png'),
      Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMIT - PNG.length + 1)]),
    );
    assert.match(await refused('read_file', { file_path: file }), /too large/i);
  });

  test('other binary files are an error, wherever the first NUL sits', async () => {
    const file = await write(
      path.join(project, 'assets', 'clip.mp4'),
      Buffer.concat([Buffer.alloc(100_000, 0x61), Buffer.from([0])]),
    );
    assert.match(await refused('read_file', { file_path: file }), /binary/i);
  });

  test('an offset never reads around what makes a file binary', async () => {
    const head = await write(
      path.join(project, 'assets', 'binary-head.dat'),
      Buffer.concat([Buffer.from([0x7f, 0, 0x0a]), Buffer.from(lines(5))]),
    );
    assert.match(await refused('read_file', { file_path: head, offset: 3 }), /binary/i);
    const middle = await write(
      path.join(project, 'assets', 'binary-middle.dat'),
      Buffer.concat([Buffer.from(lines(50_000)), Buffer.from([0, 0x0a]), Buffer.from(lines(5))]),
    );
    assert.match(await refused('read_file', { file_path: middle, offset: 50_003 }), /binary/i);
    assert.match(await refused('read_file', { file_path: head, offset: 99 }), /binary/i);
  });

  test('a binary over what a Buffer holds is refused without loading it', async () => {
    const file = await write(path.join(project, 'assets', 'render.mov'));
    await fs.truncate(file, 3 * 1024 ** 3);
    assert.match(await refused('read_file', { file_path: file }), /binary/i);
  });

  test('refuses a folder, a missing file and input of the wrong type', async () => {
    await refused('read_file', { file_path: path.join(project, 'scenes') });
    await refused('read_file', { file_path: path.join(project, 'nope.txt') });
    assert.match(await refused('read_file', {}), /file_path/);
    assert.match(await refused('read_file', { file_path: 3 }), /file_path/);
    assert.match(await refused('read_file', { file_path: 'art-direction.md', offset: 0 }), /offset/);
    assert.match(await refused('read_file', { file_path: 'art-direction.md', limit: 1.5 }), /limit/);
  });
});

describe('policy', () => {
  test('a brand file is readable in a chat turn', async () => {
    assert.equal(await ok('read_file', { file_path: path.join(brand, 'KIT.md') }), '     1\t# Orbit kit');
  });

  test('accounts.json is refused, even from a turn that may read the state folder', async () => {
    const file = path.join(state, 'accounts.json');
    assert.doesNotMatch(await refused('read_file', { file_path: file }), new RegExp(SECRET));
    assert.doesNotMatch(await refused('read_file', { file_path: file }, wide), new RegExp(SECRET));
  });

  test('a deny entry holds on a path spelled with dot-dot, absolute or relative', async () => {
    const absolute = `${project}/../../.cadence/accounts.json`;
    for (const file_path of [absolute, 'projects/demo/../../.cadence/accounts.json']) {
      const text = await refused('read_file', { file_path }, wide);
      assert.match(text, /^Refused/);
      assert.doesNotMatch(text, new RegExp(SECRET));
    }
    const text = await refused('grep', { pattern: 'token', path: absolute }, wide);
    assert.match(text, /^Refused/);
    assert.doesNotMatch(text, new RegExp(SECRET));
  });

  test('deny holds on a disk that folds case and on a Unicode spelling of the name', async () => {
    assert.match(await refused('read_file', { file_path: path.join(state, 'ACCOUNTS.json') }, wide), /^Refused/);
    assert.match(await refused('read_file', { file_path: path.join(state, 'account\u017F.json') }, wide), /^Refused/);
    assert.match(await refused('read_file', { file_path: path.join(state, 'acc\u200Counts.json') }, wide), /^Refused/);
    assert.match(await refused('read_file', { file_path: path.join(state, 'accounts\uF029json') }, wide), /^Refused/);
  });

  test('a deny entry can be a subtree', async () => {
    const policy = { ...wide, deny: [path.join(project, 'scenes', '**')] };
    await refused('read_file', { file_path: path.join(project, 'scenes', 'intro.tsx') }, policy);
    await refused('list_files', { pattern: '*', path: path.join(project, 'scenes') }, policy);
    assert.doesNotMatch(await ok('list_files', { pattern: '**', path: project }, policy), /intro/);
  });

  test('a file outside every root is refused the same way as a missing one out there', async () => {
    const one = await refused('read_file', { file_path: path.join(outside, 'secret.txt') });
    const other = await refused('read_file', { file_path: path.join(outside, 'missing.txt') });
    assert.equal(one.replace('secret', 'missing'), other);
    await refused('read_file', { file_path: '../../outside/secret.txt' });
    await refused('list_files', { pattern: '*', path: outside });
    await refused('grep', { pattern: 'hunter', path: outside });
  });

  test('a folder whose name only starts like a root is outside it', async () => {
    const file = await write(`${project}-evil/x.txt`, 'x\n');
    await refused('read_file', { file_path: file });
  });

  test('a link inside the project pointing outside is refused', async () => {
    for (const name of ['leak.txt', 'keys.json', path.join('elsewhere', 'secret.txt')]) {
      const text = await refused('read_file', { file_path: path.join(project, name) });
      assert.doesNotMatch(text, new RegExp(SECRET));
    }
    await refused('list_files', { pattern: '*', path: path.join(project, 'elsewhere') });
    await refused('list_files', { pattern: '*', path: path.join(project, 'elsewhere', 'secret.txt') });
    await refused('grep', { pattern: 'hunter', path: path.join(project, 'elsewhere') });
    await refused('grep', { pattern: 'hunter', path: path.join(project, 'leak.txt') });
  });

  test('a name behind a link is refused the same way whether it exists or not', async () => {
    await write(path.join(outside, 'sub', 'x.txt'));
    const message = (text: string, name: string) => text.replaceAll(name, 'NAME').replace(/fd\/\d+/, 'fd/N');
    for (const [tool, key, input] of [
      ['read_file', 'file_path', {}],
      ['list_files', 'path', { pattern: '*' }],
      ['grep', 'path', { pattern: 'hunter' }],
    ] as const) {
      const refusal = async (name: string) => {
        const text = await refused(tool, { ...input, [key]: path.join(project, 'elsewhere', name) });
        return message(text, name);
      };
      const missing = await refusal('missing.txt');
      assert.equal(await refusal('secret.txt'), missing);
      assert.equal(await refusal('sub'), missing);
    }
  });

  test('grep never follows a file swapped for a link after the walk', async () => {
    const dir = path.join(root, 'swapped');
    const file = await write(path.join(dir, 'notes.txt'), 'hunter was here\n');
    const signal = changeAtCheck(3, () => {
      rmSync(file);
      symlinkSync(path.join(outside, 'secret.txt'), file);
    });
    const policy = { read: [path.join(dir, '**')], write: [], deny: [] };
    const result = await localTools(policy).call('grep', { pattern: 'hunter' }, signal);
    assert.equal(textOf(result.content), 'No match.\n[Skipped entries that could not be read: 1.]');
  });

  test('a folder swapped for a link during the walk is not listed: the outside names stay out', async () => {
    const dir = path.join(root, 'walk');
    const top = path.join(dir, 'top');
    const away = path.join(root, 'walk-away');
    await write(path.join(top, 'a.txt'));
    await write(path.join(top, 'sub', 'b.txt'));
    await write(path.join(away, 'sub', 'secret-name.txt'));
    // The parent is swapped: throwIfAborted runs before the lstat of `sub`, which a link at `sub` itself would stop.
    const signal = changeAtCheck(4, () => {
      renameSync(top, `${top}.old`);
      symlinkSync(away, top);
    });
    const policy = { read: [path.join(dir, '**')], write: [], deny: [] };
    const result = await localTools(policy).call('list_files', { pattern: '**' }, signal);
    assert.equal(textOf(result.content), `${path.join(top, 'a.txt')}\n[Skipped entries that could not be read: 1.]`);
  });

  test('a folder swapped for a link above an exact write entry stays refused', async () => {
    const own = path.join(root, 'projects', 'swapped-scenes');
    const away = path.join(root, 'away');
    await write(path.join(away, 'intro.tsx'), `${SECRET}\n`);
    await fs.mkdir(own);
    await fs.symlink(away, path.join(own, 'scenes'));
    const dirs = { brand, templates: path.join(root, 'templates'), runtime: path.join(root, 'src', 'runtime') };
    const policy = chatFiles(own, 'intro', dirs, []);
    assert.doesNotMatch(await refused('read_file', { file_path: 'scenes/intro.tsx' }, policy), new RegExp(SECRET));
  });

  test('a root reached through a link is read, its links below stay refused', async () => {
    const linked = path.join(root, 'linked-project');
    await fs.symlink(project, linked);
    const policy = { read: [path.join(linked, '**')], write: [], deny: [] };
    assert.match(await ok('read_file', { file_path: 'art-direction.md' }, policy), /Calm/);
    assert.match(await ok('list_files', { pattern: '*.md' }, policy), /art-direction/);
    await refused('read_file', { file_path: 'leak.txt' }, policy);
  });

  test('an exact entry covers that file and no neighbour, in read as in write', async () => {
    const scene = path.join(project, 'scenes', 'intro.tsx');
    const other = await write(path.join(project, 'scenes', 'other.tsx'), 'other\n');
    const base = path.join(brand, '**');
    assert.match(await ok('read_file', { file_path: scene }, { read: [base], write: [scene], deny: [] }), /intro/);
    assert.match(await ok('read_file', { file_path: scene }, { read: [base, scene], write: [], deny: [] }), /intro/);
    await refused('read_file', { file_path: other }, { read: [base], write: [scene], deny: [] });
  });

  test('a link is never walked: no name, no content', async () => {
    const listed = await ok('list_files', { pattern: '**', path: project });
    assert.doesNotMatch(listed, /leak\.txt|keys\.json|elsewhere/);
    assert.match(await ok('grep', { pattern: 'hunter', path: project }), /no match/i);
  });

  test('a session file stays out of every tool, however it is spelled and wherever a walk starts', async () => {
    const chats = path.join(project, '.cadence', 'chats');
    const sessions = path.join(chats, 'sessions');
    const file = await write(path.join(sessions, 'abc.json'), `{"text":"${SECRET}"}\n`);
    const chat = await write(path.join(chats, 'project.json'), '{"messages":[]}\n');
    const spellings = [
      file,
      '.cadence/chats/sessions/abc.json',
      '.cadence/chats/archive/../sessions/abc.json',
      path.join(project, '.CADENCE', 'Chats', 'SESSIONS', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'se\u1E9Eions', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'sess\u200Cions', 'abc.json'),
      path.join(project, '.ca\u200Cdence', 'chats', 'sessions', 'abc.json'),
      path.join(project, '.cadence', 'chats', '\uFEFFsessions', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'sessions\uF000', 'abc.json'),
      path.join(project, '\uF029cadence', 'chats', 'sessions', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'sessions\uF000x', 'abc.json'),
      path.join(project, '.cadence', 'chats', '\uFEFF.', 'sessions', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'archive', '\uFEFF..', 'sessions', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'sessions.', 'abc.json'),
      path.join(project, '.cadence', 'chats', 'sess\u034Fions', 'abc.json'),
      path.join(project, 'CADENC~1', 'chats', 'sessions', 'abc.json'),
    ];
    for (const file_path of spellings) assert.match(await refused('read_file', { file_path }), /^Refused/);
    for (const named of [file, sessions, `${sessions}.`]) {
      assert.match(await refused('list_files', { pattern: '*', path: named }), /^Refused/);
      assert.match(await refused('grep', { pattern: 'hunter', path: named }), /^Refused/);
    }
    for (const start of [chats, path.dirname(chats)]) {
      assert.equal(await ok('list_files', { pattern: '**/*.json', path: start }), chat);
      assert.equal(await ok('grep', { pattern: 'hunter', path: start }), 'No match.');
    }
    assert.match(await ok('read_file', { file_path: chat }), /messages/);
  });

  test('a name a disk may read another way is refused and never walked, and folders above the root may hold one', async () => {
    const folder = path.join(root, 'unseen', 'pro\u200Dject');
    const plain = await write(path.join(folder, 'plain.txt'), 'hunter\n');
    const marked = await write(path.join(folder, 'mar\u00ADked.txt'), 'hunter\n');
    const trailing = await write(path.join(folder, 'trailing.'), 'hunter\n');
    const alias = await write(path.join(folder, 'PLAIN~1.TXT'), 'hunter\n');
    const ignorable = await write(path.join(folder, 'pla\u034Fin.txt'), 'hunter\n');
    const hidden = path.join(folder, 'hid\uF000den');
    await write(path.join(hidden, 'inside.txt'), 'hunter\n');
    const policy = { read: [path.join(folder, '**')], write: [], deny: [] };

    assert.match(await ok('read_file', { file_path: plain }, policy), /hunter/);
    assert.equal(await ok('list_files', { pattern: '**', path: folder }, policy), plain);
    assert.equal((await ok('grep', { pattern: 'hunter', path: folder }, policy)).split('\n').length, 1);
    for (const file_path of [
      marked,
      trailing,
      alias,
      ignorable,
      path.join(folder, '\uFEFF..', 'plain.txt'),
      path.join(folder, '\uFEFF.', 'plain.txt'),
    ])
      assert.match(await refused('read_file', { file_path }, policy), /^Refused/);
    assert.match(await refused('list_files', { pattern: '*', path: hidden }, policy), /^Refused/);
    assert.match(await refused('grep', { pattern: 'hunter', path: hidden }, policy), /^Refused/);
  });

  test('a denied file is neither listed nor searched', async () => {
    const policy = { ...wide, read: [path.join(state, '**')] };
    assert.doesNotMatch(await ok('list_files', { pattern: '**' }, policy), /accounts/);
    assert.match(await ok('grep', { pattern: 'hunter' }, policy), /no match/i);
  });
});

describe('descriptors', () => {
  const open = () => readdirSync('/dev/fd').length;

  test('a call leaves none open, whatever it ends in', async () => {
    const dir = path.join(root, 'descriptors');
    const scene = await write(path.join(dir, 'scene.txt'), 'needle\n');
    const image = await write(path.join(dir, 'image.png'), PNG);
    const hugeImage = await write(path.join(dir, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMIT)]));
    const blob = await write(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2]));
    const big = await write(path.join(dir, 'big.txt'), 'a'.repeat(1024 * 1024 + 1));
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const taken = path.join(dir, 'taken');
    await fs.mkdir(taken);
    const policy = { read: [], write: [path.join(dir, '**')], deny: [] };
    for (const [tool, input] of [
      ['read_file', { file_path: scene }],
      ['read_file', { file_path: image }],
      ['read_file', { file_path: hugeImage }],
      ['read_file', { file_path: blob }],
      ['read_file', { file_path: path.join(dir, 'missing.txt') }],
      ['read_file', { file_path: dir }],
      ['read_file', { file_path: fifo }],
      ['grep', { pattern: 'needle', path: dir }],
      ['grep', { pattern: 'needle', path: scene }],
      ['list_files', { pattern: '*', path: scene }],
      ['edit_file', { file_path: scene, old_string: 'needle', new_string: 'needle' }],
      ['edit_file', { file_path: scene, old_string: 'absent', new_string: 'x' }],
      ['edit_file', { file_path: blob, old_string: 'a', new_string: 'b' }],
      ['edit_file', { file_path: big, old_string: 'a', new_string: 'b' }],
      ['edit_file', { file_path: fifo, old_string: 'a', new_string: 'b' }],
      ['write_file', { file_path: path.join(dir, 'written.txt'), content: 'x' }],
      ['write_file', { file_path: taken, content: 'x' }],
    ] as const) {
      await run(tool, input, policy);
      const before = open();
      await run(tool, input, policy);
      // What the calls before left can still close between the two counts; a leak only ever adds one.
      assert.ok(open() <= before, `${tool} ${JSON.stringify(input)}`);
    }
  });
});

describe('list_files', () => {
  let tree: string;
  let policy: FilePolicy;
  const names = (text: string) => text.split('\n').map((file) => path.relative(tree, file));

  before(async () => {
    tree = path.join(root, 'tree');
    policy = { read: [path.join(tree, '**')], write: [path.join(tree, 'a', '**')], deny: [] };
    await Promise.all(
      ['a/one.tsx', 'a/two.ts', 'a/deep/three.tsx', 'b.c', 'bxc', 'top.tsx', 'a/deep/x[1].tsx'].map((file) =>
        write(path.join(tree, file)),
      ),
    );
    await Promise.all(
      ['.git/config', 'node_modules/pkg/index.js', '.cadence/chats/x.tsx', 'a/node_modules/y.tsx'].map((file) =>
        write(path.join(tree, file)),
      ),
    );
  });

  test('* stops at a folder, ** crosses them, ? is one character', async () => {
    assert.deepEqual(names(await ok('list_files', { pattern: '*.tsx' }, policy)), ['top.tsx']);
    assert.deepEqual(names(await ok('list_files', { pattern: 'a/*.ts' }, policy)), ['a/two.ts']);
    assert.deepEqual(names(await ok('list_files', { pattern: '**/*.tsx' }, policy)), [
      'a/deep/three.tsx',
      'a/deep/x[1].tsx',
      'a/one.tsx',
      'top.tsx',
    ]);
    assert.deepEqual(names(await ok('list_files', { pattern: 'a/**' }, policy)), [
      'a/deep/three.tsx',
      'a/deep/x[1].tsx',
      'a/one.tsx',
      'a/two.ts',
    ]);
    assert.deepEqual(names(await ok('list_files', { pattern: 'a/t?o.ts' }, policy)), ['a/two.ts']);
  });

  test('regex characters in a pattern are plain characters', async () => {
    assert.deepEqual(names(await ok('list_files', { pattern: 'b.c' }, policy)), ['b.c']);
    assert.deepEqual(names(await ok('list_files', { pattern: '**/x[1].tsx' }, policy)), ['a/deep/x[1].tsx']);
    const signs = path.join(root, 'signs');
    const literal = ['shot (1).png', 'a+b.txt', '$id.tsx', 'x|y.md', 'x{1}.md', 'x^y.md', 'x\\y.md'];
    await Promise.all([...literal, 'aab.txt', 'shot 1.png', 'x.md', 'y.md'].map((name) => write(path.join(signs, name))));
    const signsPolicy = { read: [path.join(signs, '**')], write: [], deny: [] };
    for (const name of literal) {
      assert.equal(await ok('list_files', { pattern: name }, signsPolicy), path.join(signs, name));
    }
  });

  test('path starts the walk and the pattern is relative to it', async () => {
    const text = await ok('list_files', { pattern: '*.tsx', path: path.join(tree, 'a') }, policy);
    assert.deepEqual(names(text), ['a/one.tsx']);
    assert.deepEqual(names(await ok('list_files', { pattern: '*', path: 'a/deep' }, policy)), [
      'a/deep/three.tsx',
      'a/deep/x[1].tsx',
    ]);
  });

  test('a relative path starts at the main folder of a turn with several folders', async () => {
    const scene = path.join(project, 'scenes', 'intro.tsx');
    assert.equal(await ok('list_files', { pattern: 'intro.tsx', path: 'scenes' }), scene);
    assert.equal(await ok('grep', { pattern: 'const intro', path: 'scenes' }), `${scene}:1:export const intro = 1;`);
  });

  test('without path it walks every readable folder once', async () => {
    const text = await ok('list_files', { pattern: '**/*.md' });
    const found = text.split('\n').map((file) => path.relative(root, file));
    assert.deepEqual(found, ['projects/demo/art-direction.md', 'brands/orbit/KIT.md', 'src/runtime/API.md']);
    assert.equal(names(await ok('list_files', { pattern: 'a/one.tsx' }, policy)).length, 1);
    const twice = { read: [path.join(tree, '**'), path.join(tree, '**')], write: [], deny: [] };
    assert.equal(names(await ok('list_files', { pattern: 'a/one.tsx' }, twice)).length, 1);
  });

  test('a readable folder that does not exist is passed over unless named', async () => {
    const missing = path.join(root, 'gone');
    const gone = { read: [path.join(tree, '**'), path.join(missing, '**')], write: [], deny: [] };
    assert.deepEqual(names(await ok('list_files', { pattern: 'top.tsx' }, gone)), ['top.tsx']);
    assert.doesNotMatch(await refused('list_files', { pattern: '*', path: missing }, gone), /outside/);
  });

  test('.git, node_modules and .cadence stay out of a walk, unless the walk starts there', async () => {
    const text = await ok('list_files', { pattern: '**' }, policy);
    assert.doesNotMatch(text, /\.git|node_modules|\.cadence/);
    const inside = await ok('list_files', { pattern: '**', path: path.join(tree, 'node_modules') }, policy);
    assert.deepEqual(names(inside), ['node_modules/pkg/index.js']);
  });

  test('the clips and renders folders of a root stay out of a walk, unless the walk starts there', async () => {
    const framed = path.join(root, 'framed');
    await write(path.join(framed, 'clips', 'key', 'frame.txt'), 'needle\n');
    await write(path.join(framed, 'renders', 'sequence', '000001.txt'), 'needle\n');
    await write(path.join(framed, 'scenes', 'clips', 'name.txt'), 'needle\n');
    await write(path.join(framed, 'scenes', 'renders', 'name.txt'), 'needle\n');
    const framedPolicy = { read: [path.join(framed, '**')], write: [], deny: [] };
    const scenes = ['clips', 'renders'].map((name) => path.join(framed, 'scenes', name, 'name.txt'));
    assert.equal(await ok('list_files', { pattern: '**' }, framedPolicy), scenes.join('\n'));
    assert.equal(await ok('grep', { pattern: 'needle' }, framedPolicy), scenes.map((scene) => `${scene}:1:needle`).join('\n'));
    assert.match(await ok('list_files', { pattern: '**', path: 'clips' }, framedPolicy), /frame\.txt/);
    assert.match(await ok('grep', { pattern: 'needle', path: 'clips' }, framedPolicy), /frame\.txt/);
    assert.match(await ok('list_files', { pattern: '**', path: 'renders' }, framedPolicy), /000001\.txt/);
    assert.match(await ok('grep', { pattern: 'needle', path: 'renders' }, framedPolicy), /000001\.txt/);
  });

  test('an entry gone between the listing and its lstat is skipped and counted', async () => {
    const dir = path.join(root, 'vanishing');
    const kept = await write(path.join(dir, 'a.txt'));
    const gone = await write(path.join(dir, 'b.txt'));
    const signal = changeAtCheck(2, () => rmSync(gone));
    const vanishing = { read: [path.join(dir, '**')], write: [], deny: [] };
    const result = await localTools(vanishing).call('list_files', { pattern: '*' }, signal);
    assert.equal(result.isError, false, textOf(result.content));
    assert.equal(textOf(result.content), `${kept}\n[Skipped entries that could not be read: 1.]`);
  });

  test('a folder that cannot be listed is skipped and counted, and stays an error when asked for by name', async () => {
    const readable = path.join(root, 'partly', 'readable');
    const lockedRoot = path.join(root, 'partly', 'locked-root');
    const lockedFolder = path.join(readable, 'zz');
    const kept = await write(path.join(readable, 'a.txt'));
    await write(path.join(lockedFolder, 'b.txt'));
    await write(path.join(lockedRoot, 'c.txt'));
    await fs.chmod(lockedFolder, 0);
    await fs.chmod(lockedRoot, 0);
    try {
      const partly = { read: [path.join(readable, '**'), path.join(lockedRoot, '**')], write: [], deny: [] };
      const skipped = '[Skipped entries that could not be read: 2.]';
      assert.equal(await ok('list_files', { pattern: '**' }, partly), `${kept}\n${skipped}`);
      assert.equal(await ok('grep', { pattern: 'x' }, partly), `No match.\n${skipped}`);
      await refused('list_files', { pattern: '*', path: lockedFolder }, partly);
      await refused('list_files', { pattern: '*', path: lockedRoot }, partly);
    } finally {
      await fs.chmod(lockedFolder, 0o755);
      await fs.chmod(lockedRoot, 0o755);
    }
  });

  test('no match says so', async () => {
    assert.match(await ok('list_files', { pattern: 'nothing' }, policy), /no file/i);
  });

  test('stops at 1000 entries with a notice, and exactly 1000 carries none', async () => {
    const full = path.join(root, 'full');
    await inBatches(
      Array.from({ length: 1001 }, (_, at) => path.join(full, `f${String(at).padStart(4, '0')}.txt`)),
      (file) => write(file),
    );
    const wideOpen = { read: [path.join(full, '**')], write: [], deny: [] };
    const text = await ok('list_files', { pattern: '*' }, wideOpen);
    assert.equal(text.split('\n').length, 1001);
    assert.match(lastLine(text), /1000/);
    await fs.rm(path.join(full, 'f0000.txt'));
    assert.equal((await ok('list_files', { pattern: '*' }, wideOpen)).split('\n').length, 1000);
  });

  test('a huge tree stops the walk with a notice, whatever the pattern matches', async () => {
    const huge = path.join(root, 'huge');
    const folders = ['a', 'b', 'c', 'd'].map((name) => path.join(huge, name));
    await Promise.all(folders.map((folder) => fs.mkdir(folder, { recursive: true })));
    // Spread over folders, 10001 entries with them: the cap holds for the walk, not for each folder.
    const names = Array.from({ length: 9_997 }, (_, at) => path.join(folders[at % 4], `f${at}`));
    await inBatches(names, (file) => fs.writeFile(file, ''));
    const hugePolicy = { read: [path.join(huge, '**')], write: [], deny: [] };
    assert.match(await ok('list_files', { pattern: 'nothing' }, hugePolicy), /10000 entries/);
    assert.match(await ok('grep', { pattern: 'x', glob: 'nothing' }, hugePolicy), /10000 entries/);
    await fs.rm(names[0]);
    assert.equal(await ok('list_files', { pattern: 'nothing' }, hugePolicy), 'No file matches.');
    await fs.rm(huge, { recursive: true });
  });

  test('a path longer than any disk takes is refused before folding, which is quadratic on combining marks', async (t) => {
    const named = (length: number) => path.join(project, 'a'.repeat(length - project.length - 1));
    const folded = t.mock.method(String.prototype, 'normalize');
    for (const [tool, input] of [
      ['read_file', { file_path: named(4097) }],
      ['list_files', { pattern: '*', path: named(4097) }],
      ['grep', { pattern: 'x', path: named(4097) }],
    ] as const) {
      assert.equal(await refused(tool, input), 'Refused: this path is too long.');
    }
    assert.equal(folded.mock.callCount(), 0);
    assert.notEqual(await refused('read_file', { file_path: named(4096) }), 'Refused: this path is too long.');
  });

  test('a walk stops at its deadline, across readable folders, and a walk that ends before says nothing', async (t) => {
    const timed = path.join(root, 'timed');
    const first = path.join(timed, 'first');
    const second = path.join(timed, 'second');
    const found = await Promise.all(['a', 'b'].map((name) => write(path.join(first, name, 'found.txt'))));
    await write(path.join(second, 'c', 'found.txt'));
    const within = (...folders: string[]) => ({ read: folders.map((folder) => path.join(folder, '**')), write: [], deny: [] });
    let now = 0;
    // Read once when the walk starts, then before each folder: the third folder lands on the 12 seconds.
    t.mock.method(performance, 'now', () => (now += 4000));
    assert.deepEqual((await ok('list_files', { pattern: '**/*.txt' }, within(first))).split('\n').sort(), found);
    const seen = (await ok('list_files', { pattern: '**/*.txt' }, within(first, second))).split('\n');
    assert.equal(seen.at(-1), '[Stopped after walking for 12 seconds: some folders were not searched. Narrow the path.]');
    assert.deepEqual(seen.slice(0, -1).sort(), found);
    await fs.rm(timed, { recursive: true });
  });

  test('the entries cap holds across readable folders', async () => {
    const both = path.join(root, 'two-roots');
    const folders = ['a', 'b'].map((name) => path.join(both, name));
    const names = folders.flatMap((folder) => Array.from({ length: 5001 }, (_, at) => path.join(folder, `f${at}`)));
    await inBatches(names, (file) => write(file));
    const twoRoots = { read: folders.map((folder) => path.join(folder, '**')), write: [], deny: [] };
    assert.match(await ok('list_files', { pattern: 'nothing' }, twoRoots), /10000 entries/);
    await fs.rm(both, { recursive: true });
  });

  test('a capped walk with an unreadable folder keeps both notices', async () => {
    const capped = path.join(root, 'capped');
    const locked = path.join(capped, 'a-locked');
    await fs.mkdir(locked, { recursive: true });
    await inBatches(
      Array.from({ length: 10_001 }, (_, at) => path.join(capped, `f${at}`)),
      (file) => fs.writeFile(file, ''),
    );
    await fs.chmod(locked, 0);
    try {
      const text = await ok('list_files', { pattern: 'nothing' }, { read: [path.join(capped, '**')], write: [], deny: [] });
      assert.deepEqual(text.split('\n').slice(1), [
        '[Stopped after walking 10000 entries: some folders were not searched. Narrow the path.]',
        '[Skipped entries that could not be read: 1.]',
      ]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  test('a pattern built to backtrack ends with an error instead of freezing the server', async () => {
    const name = 'a'.repeat(200);
    await write(path.join(tree, 'slow', name));
    const pattern = `${'*a'.repeat(30)}b`;
    assert.match(await refused('list_files', { pattern, path: path.join(tree, 'slow') }, policy), /too slow/i);
  });

  test('stops when the signal aborts mid-walk', async () => {
    const controller = new AbortController();
    const pending = localTools(policy).call('list_files', { pattern: '**' }, controller.signal);
    controller.abort();
    assert.equal((await pending).isError, true);
  });

  test('refuses a turn already aborted before touching a file', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await localTools(files).call('read_file', { file_path: 'art-direction.md' }, controller.signal);
    assert.equal(result.isError, true);
  });

  test('refuses input of the wrong type', async () => {
    assert.match(await refused('list_files', {}), /pattern/);
    assert.match(await refused('list_files', { pattern: '*', path: 3 }), /path/);
  });
});

describe('grep', () => {
  const SLOW_PATTERN = '(a+)+$';
  const SLOW_LINE = `${'a'.repeat(40)}b\n`;
  let tree: string;
  let policy: FilePolicy;
  const relative = (text: string) => text.replaceAll(`${tree}${path.sep}`, '');

  before(async () => {
    tree = path.join(root, 'search');
    policy = { read: [path.join(tree, '**')], write: [], deny: [] };
    await write(path.join(tree, 'a.tsx'), 'one\nneedle here\nthree\nneedle again\n');
    await write(path.join(tree, 'deep', 'b.tsx'), 'needle deep\n');
    await write(path.join(tree, 'deep', 'c.md'), 'needle doc\n');
  });

  test('gives file, line number and line, a pattern is a regular expression', async () => {
    const text = await ok('grep', { pattern: '^needle (here|deep)$' }, policy);
    assert.equal(relative(text), 'a.tsx:2:needle here\ndeep/b.tsx:1:needle deep');
  });

  test('path narrows the search to a folder or one file', async () => {
    assert.equal(relative(await ok('grep', { pattern: 'needle', path: 'deep/b.tsx' }, policy)), 'deep/b.tsx:1:needle deep');
    const text = await ok('grep', { pattern: 'needle', path: path.join(tree, 'deep') }, policy);
    assert.equal(relative(text), 'deep/b.tsx:1:needle deep\ndeep/c.md:1:needle doc');
  });

  test('a single file as path is matched by its name, in list_files and in grep with a glob', async () => {
    const file = path.join(tree, 'deep', 'b.tsx');
    assert.equal(await ok('list_files', { pattern: '*.tsx', path: file }, policy), file);
    assert.match(await ok('list_files', { pattern: '*.md', path: file }, policy), /no file/i);
    assert.equal(
      relative(await ok('grep', { pattern: 'needle', path: file, glob: '*.tsx' }, policy)),
      'deep/b.tsx:1:needle deep',
    );
    assert.match(await ok('grep', { pattern: 'needle', path: file, glob: '*.md' }, policy), /no match/i);
  });

  test('a glob without a slash matches a file name at any depth, one with a slash the whole path', async () => {
    assert.equal(relative(await ok('grep', { pattern: 'needle', glob: '*.md' }, policy)), 'deep/c.md:1:needle doc');
    assert.equal(relative(await ok('grep', { pattern: 'needle', glob: 'deep/*.md' }, policy)), 'deep/c.md:1:needle doc');
    assert.match(await ok('grep', { pattern: 'needle', glob: 'c.md/*' }, policy), /no match/i);
    await write(path.join(tree, 'nested', 'x', 'deep', 'd.md'), 'needle nested\n');
    await write(path.join(tree, 'nested', 'deep', 'e.md'), 'needle top\n');
    const text = await ok('grep', { pattern: 'needle', path: path.join(tree, 'nested'), glob: 'deep/*.md' }, policy);
    assert.equal(relative(text), 'nested/deep/e.md:1:needle top');
    await fs.rm(path.join(tree, 'nested'), { recursive: true });
  });

  test('stops at 200 matches with a notice, and exactly 200 carries none', async () => {
    const file = await write(
      path.join(tree, 'many', 'many.txt'),
      lines(201, () => 'hit'),
    );
    const text = await ok('grep', { pattern: 'hit', path: path.dirname(file) }, policy);
    assert.equal(text.split('\n').length, 201);
    assert.match(lastLine(text), /200 matches/);
    await write(
      file,
      lines(200, () => 'hit'),
    );
    assert.equal((await ok('grep', { pattern: 'hit', path: path.dirname(file) }, policy)).split('\n').length, 200);
  });

  test('the match cap holds across files', async () => {
    const dir = path.join(tree, 'spread');
    await write(
      path.join(dir, 'a.txt'),
      lines(150, () => 'hit'),
    );
    await write(
      path.join(dir, 'b.txt'),
      lines(150, () => 'hit'),
    );
    const text = await ok('grep', { pattern: 'hit', path: dir }, policy);
    assert.equal(text.split('\n').length, 201);
  });

  test('skips files over 1 MB and says how many', async () => {
    const dir = path.join(tree, 'heavy');
    await write(path.join(dir, 'big.txt'), `findme\n${'x'.repeat(1024 * 1024)}`);
    await write(path.join(dir, 'exact.txt'), `findme\n`.padEnd(1024 * 1024, 'x'));
    const text = await ok('grep', { pattern: 'findme', path: dir }, policy);
    assert.equal(relative(text).split('\n')[0], 'heavy/exact.txt:1:findme');
    assert.match(lastLine(text), /1 file over 1 MB/);
  });

  test('skips binary files', async () => {
    const dir = path.join(tree, 'binary');
    await write(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from('needle\n'), Buffer.from([0])]));
    assert.match(await ok('grep', { pattern: 'needle', path: dir }, policy), /no match/i);
  });

  test('cuts a very long matching line', async () => {
    const dir = path.join(tree, 'minified');
    await write(path.join(dir, 'bundle.js'), `needle${'z'.repeat(100_000)}`);
    const text = await ok('grep', { pattern: 'needle', path: dir }, policy);
    assert.ok(text.length < 2000);
    assert.ok(text.endsWith('...'));
  });

  test('a bad regular expression is a tool error', async () => {
    await refused('grep', { pattern: '(' }, policy);
  });

  test('a file the pattern takes too long on is skipped and counted, the others still searched', async () => {
    const dir = path.join(tree, 'redos');
    await write(path.join(dir, 'a.txt'), SLOW_LINE);
    const kept = await write(path.join(dir, 'b.txt'), 'aaa\n');
    const started = Date.now();
    const text = await ok('grep', { pattern: SLOW_PATTERN, path: dir }, policy);
    assert.equal(text, `${kept}:1:aaa\n[Skipped 1 file where the pattern took too long.]`);
    assert.ok(Date.now() - started < 10_000);
  });

  test('a third slow file stops the search with what it found, unless it was the last file', async () => {
    const dir = path.join(tree, 'redos-many');
    const kept = await write(path.join(dir, 'a.txt'), 'aaa\n');
    await Promise.all(['b.txt', 'c.txt', 'd.txt'].map((name) => write(path.join(dir, name), SLOW_LINE)));
    const hit = `${kept}:1:aaa`;
    const input = { pattern: SLOW_PATTERN, path: dir };
    assert.equal(await ok('grep', input, policy), `${hit}\n[Skipped 3 files where the pattern took too long.]`);
    await write(path.join(dir, 'e.txt'), 'aaa\n');
    const started = Date.now();
    const text = await ok('grep', input, policy);
    assert.equal(
      text,
      `${hit}\n[Stopped after 3 seconds on this pattern: the other files were not searched. Narrow the path or simplify the pattern.]`,
    );
    assert.ok(Date.now() - started < 10_000);
  });

  test('the budget adds up files that stay under the timeout, and a last file ends the search without a notice', async (t) => {
    const dir = path.join(tree, 'redos-budget');
    const found = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => write(path.join(dir, name), 'aaa\n')));
    const hits = found.map((file) => `${file}:1:aaa`).join('\n');
    let now = 0;
    // Read before and after each file: a file costs a second.
    t.mock.method(performance, 'now', () => (now += 1000));
    assert.equal(await ok('grep', { pattern: 'aaa', path: dir }, policy), hits);
    await write(path.join(dir, 'd.txt'), 'aaa\n');
    assert.equal(
      await ok('grep', { pattern: 'aaa', path: dir }, policy),
      `${hits}\n[Stopped after 3 seconds on this pattern: the other files were not searched. Narrow the path or simplify the pattern.]`,
    );
  });

  test('a search makes one vm context, whatever the files: one each would spend the budget on a plain pattern', async (t) => {
    const dir = path.join(tree, 'one-context');
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => write(path.join(dir, name), 'hay\n')));
    const created = t.mock.method(vm, 'createContext');
    assert.equal(await ok('grep', { pattern: 'needle', path: dir }, policy), 'No match.');
    assert.equal(created.mock.callCount(), 1);
  });

  test('a glob built to backtrack ends with an error instead of freezing the server', async () => {
    const dir = path.join(tree, 'slow-glob');
    await write(path.join(dir, 'a'.repeat(200)), 'needle\n');
    const started = Date.now();
    assert.match(await refused('grep', { pattern: 'needle', path: dir, glob: `${'*a'.repeat(30)}b` }, policy), /too slow/i);
    assert.ok(Date.now() - started < 10_000);
  });

  test('stops between two files when the signal aborts', async () => {
    let checks = 0;
    // Passes the top of the call and the walk of b.tsx and c.md, then fails on the first file searched.
    const signal = {
      throwIfAborted() {
        checks += 1;
        if (checks > 3) throw new Error('aborted');
      },
    } as AbortSignal;
    const dir = path.join(tree, 'deep');
    const result = await localTools(policy).call('grep', { pattern: 'needle', path: dir }, signal);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'aborted' }], isError: true });
  });

  test('a file gone between the walk and its opening is skipped and counted, the others still searched', async () => {
    const dir = path.join(tree, 'going');
    const gone = await write(path.join(dir, 'a.txt'), 'needle\n');
    await write(path.join(dir, 'b.txt'), 'needle\n');
    const signal = changeAtCheck(4, () => rmSync(gone));
    const result = await localTools(policy).call('grep', { pattern: 'needle', path: dir }, signal);
    assert.equal(result.isError, false, textOf(result.content));
    assert.equal(relative(textOf(result.content)), 'going/b.txt:1:needle\n[Skipped entries that could not be read: 1.]');
  });

  test('refuses input of the wrong type', async () => {
    assert.match(await refused('grep', {}), /pattern/);
    assert.match(await refused('grep', { pattern: 'x', glob: 3 }), /glob/);
  });
});

describe('edit_file', () => {
  let own: string;
  let policy: FilePolicy;

  before(() => {
    own = path.join(root, 'projects', 'edits');
    policy = chatFiles(own, null, dirs, deniedFiles(state));
  });

  const scene = (name: string, content: string | Buffer) => write(path.join(own, 'scenes', name), content);

  test('replaces the one occurrence of old_string, a relative path starts at the project', async () => {
    const file = await scene('one.tsx', 'const a = 1;\nconst b = 2;\n');
    const input = { file_path: file, old_string: 'b = 2', new_string: 'b = 3' };
    assert.equal(await ok('edit_file', input, policy), `Edited ${file}: 1 occurrence replaced.`);
    await ok('edit_file', { file_path: 'scenes/one.tsx', old_string: 'a = 1', new_string: 'a = 0' }, policy);
    assert.equal(await fs.readFile(file, 'utf8'), 'const a = 0;\nconst b = 3;\n');
  });

  test('an absent or repeated old_string is an error that gives the count, and the file stays as it was', async () => {
    const file = await scene('twice.tsx', 'x = 1;\nx = 1;\n');
    const absent = await refused('edit_file', { file_path: file, old_string: 'y = 1', new_string: 'z' }, policy);
    assert.match(absent, /old_string occurs 0 times/);
    const repeated = await refused('edit_file', { file_path: file, old_string: 'x = 1', new_string: 'z' }, policy);
    assert.match(repeated, /old_string occurs 2 times[^\n]*replace_all/);
    const input = { file_path: file, old_string: 'y', new_string: 'z', replace_all: true };
    assert.match(await refused('edit_file', input, policy), /old_string occurs 0 times/);
    assert.equal(await fs.readFile(file, 'utf8'), 'x = 1;\nx = 1;\n');
  });

  test('replace_all replaces every occurrence, a single one too, and says how many', async () => {
    const file = await scene('all.tsx', 'x = 1;\nx = 1;\ny = 1;\n');
    const input = { file_path: file, old_string: 'x = 1', new_string: 'x = 2', replace_all: true };
    assert.equal(await ok('edit_file', input, policy), `Edited ${file}: 2 occurrences replaced.`);
    await ok('edit_file', { file_path: file, old_string: 'y = 1', new_string: 'y = 2', replace_all: false }, policy);
    const single = { file_path: file, old_string: 'y = 2', new_string: 'y = 3', replace_all: true };
    assert.equal(await ok('edit_file', single, policy), `Edited ${file}: 1 occurrence replaced.`);
    assert.equal(await fs.readFile(file, 'utf8'), 'x = 2;\nx = 2;\ny = 3;\n');
  });

  test('new_string is written as it is, never as a replacement pattern, and an empty one deletes', async () => {
    const file = await scene('dollars.tsx', 'a: 10\nb: 10\nc: 20\n');
    const patterns = "$& $1 $$ $` $'";
    await ok('edit_file', { file_path: file, old_string: '20', new_string: patterns }, policy);
    await ok('edit_file', { file_path: file, old_string: '10', new_string: patterns, replace_all: true }, policy);
    await ok('edit_file', { file_path: file, old_string: 'a: ', new_string: '' }, policy);
    assert.equal(await fs.readFile(file, 'utf8'), `${patterns}\nb: ${patterns}\nc: ${patterns}\n`);
  });

  test('only UTF-8 text up to 1 MB, before and after the edit, is edited; the file stays as it was', async () => {
    const limit = 1024 * 1024;
    const binary = Buffer.from([0x61, 0, 0x62, 0x0a]);
    const latin = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' au lait\n')]);
    const blob = await scene('blob.bin', binary);
    const accented = await scene('latin.txt', latin);
    const big = await scene('big.txt', `${'a'.repeat(limit)}b`);
    const full = await scene('full.txt', `${'a'.repeat(limit - 1)}b`);
    const many = await scene('many.txt', 'x\n'.repeat(1000));
    assert.match(await refused('edit_file', { file_path: blob, old_string: 'a', new_string: 'c' }, policy), /binary/);
    assert.match(await refused('edit_file', { file_path: accented, old_string: 'au', new_string: 'with' }, policy), /UTF-8/);
    assert.match(
      await refused('edit_file', { file_path: big, old_string: 'b', new_string: '' }, policy),
      /big\.txt is over 1 MB/,
    );
    const blowUp = { file_path: many, old_string: 'x', new_string: 'y'.repeat(2000), replace_all: true };
    assert.match(await refused('edit_file', blowUp, policy), /would make .*many\.txt over 1 MB/);
    assert.deepEqual(await fs.readFile(blob), binary);
    assert.deepEqual(await fs.readFile(accented), latin);
    assert.equal((await fs.stat(big)).size, limit + 1);
    assert.equal(await fs.readFile(many, 'utf8'), 'x\n'.repeat(1000));
    await ok('edit_file', { file_path: full, old_string: 'b', new_string: 'c' }, policy);
    assert.equal((await fs.readFile(full, 'utf8')).at(-1), 'c');
  });

  test('the 1 MB cap after an edit counts UTF-8 bytes, not characters', async () => {
    // 400 000 euro signs or accented letters stay under a million characters and pass 1 MB in UTF-8.
    const short = await scene('short.txt', 'x\n');
    const accented = await scene('accented.txt', `${'\u00E9'.repeat(400_000)}x\n`);
    const euros = { file_path: short, old_string: 'x', new_string: '\u20AC'.repeat(400_000) };
    assert.match(await refused('edit_file', euros, policy), /would make .*short\.txt over 1 MB/);
    const longer = { file_path: accented, old_string: 'x', new_string: 'y'.repeat(300_000) };
    assert.match(await refused('edit_file', longer, policy), /would make .*accented\.txt over 1 MB/);
    assert.equal(await fs.readFile(short, 'utf8'), 'x\n');
    assert.equal((await fs.stat(accented)).size, 800_002);
  });

  test('refuses a missing file, a folder and input of the wrong type', async () => {
    const file = await scene('typed.tsx', 'a\n');
    await fs.mkdir(path.join(own, 'scenes', 'nested.tsx'));
    const missing = { file_path: path.join(own, 'scenes', 'missing.tsx'), old_string: 'a', new_string: 'b' };
    assert.match(await refused('edit_file', missing, policy), /ENOENT/);
    const folder = { file_path: path.join(own, 'scenes', 'nested.tsx'), old_string: 'a', new_string: 'b' };
    assert.match(await refused('edit_file', folder, policy), /nested\.tsx is not a regular file/);
    for (const [input, error] of [
      [{ old_string: 'a', new_string: 'b' }, /file_path must be a non-empty string/],
      [{ file_path: file, old_string: '', new_string: 'b' }, /old_string must be a non-empty string/],
      [{ file_path: file, old_string: 'a' }, /new_string must be a string/],
      [{ file_path: file, old_string: 'a', new_string: 1 }, /new_string must be a string/],
      [{ file_path: file, old_string: 'a', new_string: 'b', replace_all: 'yes' }, /replace_all must be true or false/],
    ] as const) {
      assert.match(await refused('edit_file', input, policy), error);
    }
    assert.equal(await fs.readFile(file, 'utf8'), 'a\n');
  });
});

describe('write_file', () => {
  let own: string;
  let policy: FilePolicy;

  before(async () => {
    own = path.join(root, 'projects', 'writes');
    policy = chatFiles(own, null, dirs, deniedFiles(state));
    await fs.mkdir(own, { recursive: true });
  });

  test('creates a file and its missing folders, and replaces a file whole', async () => {
    const file = path.join(own, 'components', 'deep', 'card.tsx');
    assert.equal(await ok('write_file', { file_path: file, content: 'export const card = 1;\n' }, policy), `Wrote ${file}.`);
    assert.equal(await fs.readFile(file, 'utf8'), 'export const card = 1;\n');
    await ok('write_file', { file_path: 'components/deep/card.tsx', content: '' }, policy);
    assert.equal(await fs.readFile(file, 'utf8'), '');
  });

  test('refuses a folder and input of the wrong type, and leaves no temp file behind', async () => {
    const folder = path.join(own, 'scenes', 'folder.tsx');
    await fs.mkdir(folder, { recursive: true });
    await refused('write_file', { file_path: folder, content: 'x' }, policy);
    assert.ok((await fs.stat(folder)).isDirectory());
    assert.deepEqual(readdirSync(path.dirname(folder)), ['folder.tsx']);
    for (const [input, error] of [
      [{ content: 'x' }, /file_path must be a non-empty string/],
      [{ file_path: path.join(own, 'scenes', 'a.tsx') }, /content must be a string/],
      [{ file_path: path.join(own, 'scenes', 'a.tsx'), content: 1 }, /content must be a string/],
    ] as const) {
      assert.match(await refused('write_file', input, policy), error);
    }
  });
});

describe('write policy', () => {
  const unchanged = async (file: string, content: string) => assert.equal(await fs.readFile(file, 'utf8'), content);

  test('a scene turn writes its scene file and nothing else', async () => {
    const own = path.join(root, 'projects', 'scene-writes');
    const scene = await write(path.join(own, 'scenes', 'intro.tsx'), 'export const intro = 1;\n');
    const art = await write(path.join(own, 'art-direction.md'), 'Calm.\n');
    const policy = chatFiles(own, 'intro', dirs, deniedFiles(state));
    await ok('write_file', { file_path: 'scenes/intro.tsx', content: 'export const intro = 2;\n' }, policy);
    await ok('edit_file', { file_path: scene, old_string: '2', new_string: '3' }, policy);
    await unchanged(scene, 'export const intro = 3;\n');
    const others = [
      path.join(own, 'scenes', 'other.tsx'),
      path.join(own, 'scenes', 'INTRO.tsx'),
      path.join(own, 'components', 'card.tsx'),
      path.join(own, 'project.json'),
      art,
      path.join(brand, 'KIT.md'),
    ];
    for (const file_path of others) {
      const text = await refused('write_file', { file_path, content: SECRET }, policy);
      assert.equal(text, `Refused: this turn may not write ${file_path}.`);
    }
    assert.match(await refused('edit_file', { file_path: art, old_string: 'Calm', new_string: 'Loud' }, policy), /^Refused/);
    await unchanged(art, 'Calm.\n');
    await unchanged(path.join(brand, 'KIT.md'), '# Orbit kit\n');
    await unchanged(scene, 'export const intro = 3;\n');
    assert.deepEqual(readdirSync(own).sort(), ['art-direction.md', 'scenes']);
    assert.deepEqual(readdirSync(path.join(own, 'scenes')), ['intro.tsx']);
  });

  test('a folder a write rule opens is never replaced by a file', async () => {
    const own = path.join(root, 'projects', 'folder-writes');
    await fs.mkdir(own, { recursive: true });
    const policy = chatFiles(own, null, dirs, deniedFiles(state));
    for (const file_path of ['components', 'components/', path.join(own, 'scenes')]) {
      const text = await refused('write_file', { file_path, content: 'flat' }, policy);
      assert.equal(text, `Refused: this turn may not write ${path.resolve(own, file_path)}.`);
    }
    assert.deepEqual(readdirSync(own), []);
    await ok('write_file', { file_path: 'components/card.tsx', content: 'x' }, policy);
    assert.ok((await fs.stat(path.join(own, 'components'))).isDirectory());
  });

  test('a session file is refused in every scope, however it is spelled', async () => {
    const own = path.join(root, 'projects', 'session-writes');
    const built = path.join(root, 'brands', 'session-writes');
    const sessions = [own, built].map((dir) => path.join(dir, '.cadence', 'chats', 'sessions'));
    for (const folder of sessions) await write(path.join(folder, 'x.json'), '{}\n');
    const scopes = [
      chatFiles(own, 'intro', dirs, deniedFiles(state)),
      chatFiles(own, null, dirs, deniedFiles(state)),
      { read: [], write: [path.join(own, '**')], deny: [] },
      { read: [path.join(root, 'src', 'shared', '**')], write: [path.join(built, '**')], deny: deniedFiles(state) },
    ];
    const spellings = [
      '.cadence/chats/sessions/x.json',
      '.cadence/chats/archive/../sessions/x.json',
      '.CADENCE/Chats/SESSIONS/x.json',
      '.cadence/chats/se\u1E9Eions/x.json',
      '.cadence/chats/sess\u200Cions/x.json',
      '.cadence/chats/sessions/new.json',
    ];
    for (const policy of scopes) {
      for (const file_path of [...spellings, ...sessions.map((folder) => path.join(folder, 'x.json'))]) {
        assert.match(await refused('write_file', { file_path, content: SECRET }, policy), /^Refused/);
        assert.match(await refused('edit_file', { file_path, old_string: '{}', new_string: SECRET }, policy), /^Refused/);
      }
    }
    for (const folder of sessions) {
      await unchanged(path.join(folder, 'x.json'), '{}\n');
      assert.deepEqual(readdirSync(path.dirname(folder)), ['sessions']);
      assert.deepEqual(readdirSync(folder), ['x.json']);
    }
  });

  test('a brand build writes only under its brand folder', async () => {
    const repo = path.join(root, 'brand-sources', 'w1');
    const built = path.join(root, 'brands', 'w1');
    const shared = path.join(root, 'src', 'shared');
    const readme = await write(path.join(repo, 'README.md'), 'REPO readme\n');
    await write(path.join(built, 'KIT.md'), '# Starter kit\n');
    const build = {
      read: [repo, built, shared].map((dir) => path.join(dir, '**')),
      write: [path.join(built, '**')],
      deny: deniedFiles(state),
    };
    await ok('write_file', { file_path: 'KIT.md', content: '# W1 kit\n' }, build);
    await ok('write_file', { file_path: 'components/Logo.tsx', content: 'export const Logo = 1;\n' }, build);
    await ok('edit_file', { file_path: path.join(built, 'KIT.md'), old_string: 'W1', new_string: 'Wave' }, build);
    await unchanged(path.join(built, 'KIT.md'), '# Wave kit\n');
    await unchanged(path.join(built, 'components', 'Logo.tsx'), 'export const Logo = 1;\n');
    for (const file_path of [
      readme,
      path.join(repo, 'new.md'),
      path.join(shared, 'brandKit.ts'),
      path.join(root, 'brands', 'w2', 'KIT.md'),
      '../w2/KIT.md',
      `${built}-evil/KIT.md`,
      path.join(state, 'accounts.json'),
    ]) {
      assert.match(await refused('write_file', { file_path, content: SECRET }, build), /^Refused/);
    }
    assert.match(await refused('edit_file', { file_path: readme, old_string: 'REPO', new_string: SECRET }, build), /^Refused/);
    await unchanged(readme, 'REPO readme\n');
    assert.deepEqual(readdirSync(repo), ['README.md']);
    assert.deepEqual(
      readdirSync(path.join(root, 'brands')).filter((name) => name.startsWith('w')),
      ['w1'],
    );
  });

  test('writes refuse what reads refuse: a denied file and a name a disk may read another way', async () => {
    const policy = { read: [], write: [path.join(root, '**')], deny: deniedFiles(state) };
    const keys = `{"token":"${SECRET}"}\n`;
    for (const name of ['accounts.json', 'ACCOUNTS.json', 'account\u017F.json', 'acc\u200Counts.json']) {
      const file_path = path.join(state, name);
      assert.match(await refused('write_file', { file_path, content: '{}' }, policy), /^Refused/);
      assert.match(await refused('edit_file', { file_path, old_string: SECRET, new_string: 'x' }, policy), /^Refused/);
    }
    await unchanged(path.join(state, 'accounts.json'), keys);
    const own = path.join(root, 'projects', 'ambiguous-writes');
    for (const name of ['mar\u00ADked.tsx', 'trailing.', 'PLAIN~1.TSX', 'pla\u034Fin.tsx', path.join('\uFEFF..', 'x.tsx')]) {
      const file_path = path.join(own, 'scenes', name);
      assert.match(await refused('write_file', { file_path, content: 'x' }, policy), /^Refused/);
    }
    assert.equal(existsSync(own), false);
  });

  test('a link is never written through: the write lands inside the root, the target stays as it was', async () => {
    const own = path.join(root, 'projects', 'linked-writes');
    await fs.mkdir(own, { recursive: true });
    const leak = path.join(own, 'leak.txt');
    await fs.symlink(path.join(outside, 'secret.txt'), leak);
    await fs.symlink(outside, path.join(own, 'elsewhere'));
    const policy = { read: [], write: [path.join(own, '**')], deny: [] };
    assert.match(await refused('edit_file', { file_path: leak, old_string: 'hunter', new_string: 'x' }, policy), /leak/);
    for (const name of ['secret.txt', 'new.txt']) {
      const file_path = path.join(own, 'elsewhere', name);
      await refused('write_file', { file_path, content: 'x' }, policy);
      await refused('edit_file', { file_path, old_string: 'hunter', new_string: 'x' }, policy);
    }
    await ok('write_file', { file_path: leak, content: 'mine\n' }, policy);
    assert.ok((await fs.lstat(leak)).isFile());
    await unchanged(leak, 'mine\n');
    await unchanged(path.join(outside, 'secret.txt'), `${SECRET}\n`);
    assert.equal(existsSync(path.join(outside, 'new.txt')), false);
  });

  test('a folder swapped for a link above an exact write entry stays refused', async () => {
    const own = path.join(root, 'projects', 'swapped-writes');
    const away = path.join(root, 'away-writes');
    await write(path.join(away, 'intro.tsx'), 'away\n');
    await fs.mkdir(own);
    await fs.symlink(away, path.join(own, 'scenes'));
    const policy = chatFiles(own, 'intro', dirs, []);
    await refused('write_file', { file_path: 'scenes/intro.tsx', content: SECRET }, policy);
    await refused('edit_file', { file_path: 'scenes/intro.tsx', old_string: 'away', new_string: SECRET }, policy);
    await unchanged(path.join(away, 'intro.tsx'), 'away\n');
    assert.deepEqual(readdirSync(away), ['intro.tsx']);
  });
});
