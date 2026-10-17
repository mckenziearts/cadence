// One frame origin per project and per brand: the label the editor and the server derive from an id, and its parsing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { frameLabel, frameOriginOf, frameSite } from '../../src/shared/frameOrigin';

const sha = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);

test('the label is the first 32 hex characters of SHA-256 of the id, a DNS label for any id', async () => {
  const longest = `xn--${'a'.repeat(60)}`;
  for (const id of ['demo', 'cadence', longest]) {
    const label = await frameLabel(id);
    assert.equal(label, sha(id));
    assert.match(label, /^[0-9a-f]{32}$/);
  }
  assert.notEqual(await frameLabel('demo'), await frameLabel('demo2'));
});

test('a project and a brand with the same id get different origins on the frame port', async () => {
  const base = 'http://localhost:5311';
  assert.equal(await frameOriginOf(base, 'project', 'demo'), `http://p-${sha('demo')}.localhost:5311`);
  assert.equal(await frameOriginOf(base, 'brand', 'demo'), `http://b-${sha('demo')}.localhost:5311`);
});

test('a host names a site only with a full label, a known kind and the base host', () => {
  const base = 'http://localhost:5311';
  const label = sha('demo');
  assert.deepEqual(frameSite(base, `p-${label}.localhost:5311`), { kind: 'project', label });
  assert.deepEqual(frameSite(base, `B-${label.toUpperCase()}.LOCALHOST:5311`), { kind: 'brand', label });
  for (const host of [
    'localhost:5311',
    '127.0.0.1:5311',
    `p-${label}.localhost:5312`,
    `p-${label}.localhost`,
    `s-${label}.localhost:5311`,
    `p${label}.localhost:5311`,
    `p-${label.slice(1)}.localhost:5311`,
    `p-${label}0.localhost:5311`,
    `x.p-${label}.localhost:5311`,
    `${label}.project.localhost:5311`,
    `p-${label}.evil.test:5311`,
    `p-${label}.localhost:5311.evil.test`,
    '',
  ]) {
    assert.equal(frameSite(base, host), null, host);
  }
});

test("a cookie set on a frame origin, for any of its parent domains, never reaches another project's or brand's", async (t) => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    if (!/Executable doesn't exist/i.test((e as Error).message)) throw e;
    assert.ok(!process.env.CI, 'Chromium missing in CI: the workflow must run npm run setup');
    return t.skip('Chromium missing (npm run setup)');
  }
  try {
    const context = await browser.newContext();
    // No server: every request gets an empty page, what is tested is how the browser scopes cookies to these hosts.
    await context.route('**', (route) => route.fulfill({ contentType: 'text/html', body: '' }));
    const page = await context.newPage();
    const base = 'http://localhost:5311';
    await page.goto(`${await frameOriginOf(base, 'project', 'a')}/`);
    const set = await page.evaluate(() => {
      const labels = location.hostname.split('.');
      labels.forEach((_, i) => (document.cookie = `c${i}=1; domain=${labels.slice(i).join('.')}; path=/; max-age=60`));
      return document.cookie;
    });
    assert.match(set, /c0=1/, 'the origin keeps its own cookie');
    assert.doesNotMatch(set, /c1=/, 'no cookie for all of localhost, the editor included');
    for (const [kind, id] of [
      ['project', 'b'],
      ['brand', 'a'],
      ['brand', 'b'],
    ] as const) {
      await page.goto(`${await frameOriginOf(base, kind, id)}/`);
      assert.equal(await page.evaluate(() => document.cookie), '', `${kind} ${id}`);
    }
  } finally {
    await browser.close();
  }
});
