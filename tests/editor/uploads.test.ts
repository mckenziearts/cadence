// uploadAssets() and dismissUpload() of the store, as Médias calls them: one file at a time, a row per file, the reason
// of a refused one on its row instead of a toast.
// node --import tsx --test tests/editor/uploads.test.ts
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import type { ProjectState } from '../../src/shared/types';

// The store reads <html lang> and the api module its token <meta> when they load: a stand-in document is all they need.
(globalThis as { document?: unknown }).document = { documentElement: { lang: 'fr' }, querySelector: () => null };
const { get, set } = await import('../../src/editor/store');
const { dismissUpload, uploadAssets } = await import('../../src/editor/store/project');

const file = (name: string) => new File([new Uint8Array([1])], name);
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function mockFetch(t: TestContext, reply: () => Promise<Response>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return t.mock.method(globalThis, 'fetch', reply);
}

beforeEach(() => set({ project: { id: 'p' } as ProjectState, uploads: [], toasts: [], assetsTick: 0 }));

test('a refused file keeps its row with the server reason and no toast, until dismissUpload removes it', async (t) => {
  const reason = "« faux.mp4 » n'est pas une vidéo que ffmpeg sait lire";
  mockFetch(t, async () => answer(422, { error: reason }));
  await uploadAssets([file('faux.mp4')]);
  const [row] = get().uploads;
  assert.deepEqual(get().uploads, [{ id: row.id, projectId: 'p', name: 'faux.mp4', error: reason }]);
  assert.deepEqual(get().toasts, [], 'said on its row only');
  assert.equal(get().assetsTick, 0);
  dismissUpload(row.id);
  assert.deepEqual(get().uploads, []);
});

test('a file that went through leaves no row and refreshes the asset list once', async (t) => {
  mockFetch(t, async () => answer(200, { path: 'clip.mp4' }));
  await uploadAssets([file('clip.mp4')]);
  assert.deepEqual(get().uploads, []);
  assert.equal(get().assetsTick, 1);
});

test('files go up one after the other, each with its row from the start', async (t) => {
  const pending: ((res: Response) => void)[] = [];
  const fetch = mockFetch(t, () => new Promise<Response>((resolve) => pending.push(resolve)));
  const done = uploadAssets([file('a.png'), file('b.json')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 1, 'the second waits for the first');
  assert.deepEqual(
    get().uploads.map((row) => [row.name, row.error]),
    [
      ['a.png', null],
      ['b.json', null],
    ],
  );
  pending[0](answer(200, { path: 'a.png' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(
    get().uploads.map((row) => row.name),
    ['b.json'],
  );
  pending[1](answer(413, { error: 'Fichier trop volumineux' }));
  await done;
  assert.deepEqual(
    get().uploads.map((row) => [row.name, row.error]),
    [['b.json', 'Fichier trop volumineux']],
  );
});

test('uploadAssets sends nothing without an open project', async (t) => {
  const fetch = mockFetch(t, async () => answer(200, {}));
  set({ project: null });
  await uploadAssets([file('a.png')]);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(get().uploads, []);
});
