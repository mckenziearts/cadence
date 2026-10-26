// The editor's undo keys: which press undoes or redoes, when the editor lets it, one request at a time, and the scene
// that takes the place of one a step removes.
// node --import tsx --test tests/editor/shortcuts.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectState } from '../../src/shared/types';
import en from '../../src/editor/i18n/en/timeline';
import fr from '../../src/editor/i18n/fr/timeline';
import { isTyping, oneAtATime, sceneInPlace, undoAllowed, undoKey } from '../../src/editor/lib/shortcuts';

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, target?: object) =>
  ({
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    target: (target ?? { tagName: 'DIV', isContentEditable: false }) as EventTarget,
  }) as KeyboardEvent;

test('Cmd-Z and Ctrl-Z undo, with Shift they redo', () => {
  assert.equal(undoKey(press('z', { meta: true })), 'undo');
  assert.equal(undoKey(press('z', { ctrl: true })), 'undo');
  assert.equal(undoKey(press('z', { meta: true, shift: true })), 'redo');
  assert.equal(undoKey(press('Z', { ctrl: true, shift: true })), 'redo');
});

test('the key is read from e.key, so Z works wherever the layout places it', () => {
  // AZERTY: the physical key under the letter Z is KeyW; e.key still says z.
  assert.equal(undoKey({ ...press('z', { meta: true }), code: 'KeyW' } as KeyboardEvent), 'undo');
  assert.equal(undoKey({ ...press('Z', { meta: true }), code: 'KeyW' } as KeyboardEvent), 'undo');
  assert.equal(undoKey({ ...press('w', { meta: true }), code: 'KeyZ' } as KeyboardEvent), null);
});

test('Z alone, or with Alt, is no undo', () => {
  assert.equal(undoKey(press('z')), null);
  assert.equal(undoKey(press('z', { shift: true })), null);
  assert.equal(undoKey(press('z', { meta: true, alt: true })), null);
  assert.equal(undoKey(press('z', { ctrl: true, shift: true, alt: true })), null);
  assert.equal(undoKey(press('y', { meta: true })), null);
});

test('in a text field, the browser undoes the typing: no undo key', () => {
  for (const field of [
    { tagName: 'INPUT', type: 'text' },
    { tagName: 'INPUT', type: 'number' },
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true },
  ]) {
    assert.equal(isTyping(field as unknown as EventTarget), true, JSON.stringify(field));
    assert.equal(undoKey(press('z', { meta: true }, field)), null, JSON.stringify(field));
    assert.equal(undoKey(press('z', { meta: true, shift: true }, field)), null, JSON.stringify(field));
  }
  for (const control of [
    { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'INPUT', type: 'range' },
    { tagName: 'INPUT', type: 'button' },
    { tagName: 'INPUT', type: 'submit' },
    { tagName: 'BUTTON' },
  ]) {
    assert.equal(isTyping(control as unknown as EventTarget), false, JSON.stringify(control));
    assert.equal(undoKey(press('z', { meta: true }, control)), 'undo', JSON.stringify(control));
  }
  assert.equal(isTyping(null), false);
});

const open = { project: { id: 'p' } as ProjectState, view: 'scenes', modal: null, presenting: false } as const;

test('undo runs on the scenes view of an open project, without a modal or the presentation', () => {
  assert.equal(undoAllowed(open), true);
  assert.equal(undoAllowed({ ...open, project: null }), false);
  assert.equal(undoAllowed({ ...open, view: 'render' }), false);
  assert.equal(undoAllowed({ ...open, modal: { kind: 'settings' } }), false);
  assert.equal(undoAllowed({ ...open, presenting: true }), false);
});

test('a press while a request is in flight is dropped, so a held key never queues requests', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const step = oneAtATime(async (direction: string) => {
    calls.push(direction);
    await new Promise<void>((resolve) => (finish = resolve));
  });
  const first = step('undo');
  assert.equal(await step('undo'), false);
  assert.equal(await step('redo'), false);
  assert.deepEqual(calls, ['undo']);
  finish();
  assert.equal(await first, true);
  const next = step('redo');
  assert.deepEqual(calls, ['undo', 'redo']);
  finish();
  assert.equal(await next, true);
});

test('a failed request lets the next press through', async () => {
  let calls = 0;
  const step = oneAtATime(async () => {
    calls++;
    throw new Error('down');
  });
  await assert.rejects(step(), /down/);
  await assert.rejects(step(), /down/);
  assert.equal(calls, 2);
});

test('the shortcuts help lists undo and redo, in French and English', () => {
  for (const [dict, shift] of [
    [fr, 'Maj'],
    [en, 'Shift'],
  ] as const) {
    const label = (keys: string) => dict.shortcuts.list.find((row) => row.keys.join(' ') === keys)?.label;
    assert.ok(label('\u2318 Z'), shift);
    assert.ok(label(`${shift} \u2318 Z`), shift);
  }
});

test('a step that removes a scene hands its place to the next scene still there, else to the one before it', () => {
  const before = ['intro', 'copie', 'milieu', 'fin'];
  assert.equal(sceneInPlace(before, ['intro', 'milieu', 'fin'], 'copie'), 'milieu');
  assert.equal(sceneInPlace(before, ['intro', 'fin'], 'copie'), 'fin', 'two scenes gone: the first one left after them');
  assert.equal(sceneInPlace(before, ['intro', 'copie'], 'fin'), 'copie', 'the last scene gone: the one before it');
  assert.equal(sceneInPlace(before, ['milieu', 'intro', 'fin'], 'copie'), 'milieu', 'by the old order, whatever the new one');
  assert.equal(sceneInPlace(before, before, 'copie'), null, 'still there: nothing moves');
  assert.equal(sceneInPlace(before, ['autre'], 'copie'), null, 'none of the old scenes left');
});
