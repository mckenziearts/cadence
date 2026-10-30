// The client side of an asset upload: the file itself as the body, its name in the query, the start token.
// node --import tsx --test tests/editor/api.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The api module reads its token <meta>, and the store <html lang>, when they load: a stand-in document is all they need.
(globalThis as { document?: unknown }).document = {
  documentElement: { lang: 'fr' },
  querySelector: (selector: string) => (selector === 'meta[name="cadence-token"]' ? { content: 'jeton' } : null),
};
const { api } = await import('../../src/editor/api');

test('uploadAsset posts the file as the raw body, named in the query, with the token and no JSON type', async (t) => {
  const answer = { path: 'mon-clip.mp4' };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(answer)));
  const file = new File([new Uint8Array([1, 2, 3])], 'Mon clip (v2).mp4', { type: 'video/mp4' });
  assert.deepEqual(await api.uploadAsset('mon projet', file), answer);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, '/api/projects/mon%20projet/assets?name=Mon+clip+%28v2%29.mp4');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, file);
  assert.deepEqual(init.headers, { 'X-Cadence-Token': 'jeton' });
});
