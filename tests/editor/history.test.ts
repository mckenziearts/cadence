// undo() and redo() of the store, as Cmd-Z and a host menu call them: the guard, one request at a time, the toast and
// the refetch after each step.
// node --import tsx --test tests/editor/history.test.ts
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import type { ProjectState, VersionEntry } from '../../src/shared/types';

// The store reads <html lang> and the api module its token <meta> when they load: a stand-in document is all they need.
(globalThis as { document?: unknown }).document = { documentElement: { lang: 'fr' }, querySelector: () => null };
const { api } = await import('../../src/editor/api');
const { get, set } = await import('../../src/editor/store');
const { redo, undo } = await import('../../src/editor/store/project');

const open = { project: { id: 'p' } as ProjectState, view: 'scenes', modal: null, presenting: false } as const;
const step = (label: string) => ({ entry: { label } as VersionEntry });

/** The undo, redo and refetch calls; the refetch fails, which leaves the state as it is (applying it needs a page). */
function mockApi(t: TestContext, answer: () => Promise<{ entry: VersionEntry | null }> = async () => ({ entry: null })) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return {
    undo: t.mock.method(api, 'undo', answer),
    redo: t.mock.method(api, 'redo', answer),
    project: t.mock.method(api, 'project', async () => {
      throw new Error('offline');
    }),
  };
}

const toasts = () => get().toasts.map((toast) => toast.text);

beforeEach(() => set({ ...open, toasts: [] }));

test('undo() and redo() send nothing without a project, on the render view, behind a modal or while presenting', async (t) => {
  const calls = mockApi(t);
  for (const closed of [{ project: null }, { view: 'render' }, { modal: { kind: 'settings' } }, { presenting: true }] as const) {
    set({ ...open, ...closed });
    await undo();
    await redo();
    assert.equal(calls.undo.mock.callCount() + calls.redo.mock.callCount(), 0, JSON.stringify(closed));
  }
  assert.equal(calls.project.mock.callCount(), 0);
  set(open);
  await undo();
  assert.equal(calls.undo.mock.callCount(), 1);
});

test('undo() and redo() post to their own route, for the open project', async (t) => {
  const calls = mockApi(t);
  await redo();
  assert.deepEqual(
    calls.redo.mock.calls.map((call) => call.arguments),
    [['p']],
  );
  assert.equal(calls.undo.mock.callCount(), 0);
  await undo();
  assert.deepEqual(
    calls.undo.mock.calls.map((call) => call.arguments),
    [['p']],
  );
  assert.equal(calls.redo.mock.callCount(), 1);
});

test('an undo and a redo pressed together send one request, then one refetch', async (t) => {
  let answer!: () => void;
  const calls = mockApi(t, () => new Promise((resolve) => (answer = () => resolve(step('Annulé : Durée')))));
  const first = undo();
  await redo();
  await undo();
  assert.equal(calls.undo.mock.callCount(), 1);
  assert.equal(calls.redo.mock.callCount(), 0);
  assert.equal(calls.project.mock.callCount(), 0, 'a dropped press refetches nothing');
  answer();
  await first;
  assert.equal(calls.project.mock.callCount(), 1);
  assert.equal(calls.project.mock.calls[0].arguments[0], 'p');
});

test('the toast shows the step, or that there is nothing to undo or redo', async (t) => {
  const calls = mockApi(t);
  await undo();
  await redo();
  assert.deepEqual(toasts(), ['Rien à annuler', 'Rien à rétablir']);
  set({ toasts: [] });
  calls.undo.mock.mockImplementation(async () => step('Annulé : Durée'));
  await undo();
  assert.deepEqual(toasts(), ['Annulé : Durée']);
});

test('a refused undo (a running turn answers 409) resolves, adds no toast of its own and still refetches', async (t) => {
  const calls = mockApi(t, async () => {
    throw new Error('Agent factice travaille sur ce projet');
  });
  await undo();
  assert.deepEqual(toasts(), []);
  assert.equal(calls.project.mock.callCount(), 1);
  await undo();
  assert.equal(calls.undo.mock.callCount(), 2, 'the next press goes through');
});
