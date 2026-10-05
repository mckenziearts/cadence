// The editor's hash router: what a hash names, and which screen a page id opens (host pages first).
// node --import tsx --test tests/editor/routing.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHash, resolvePage, type Pages } from '../../src/editor/lib/routing';

const home = { page: null, projectId: null, sceneId: null };

test('a hash names a page, a project and its scene, or the home', () => {
  assert.deepEqual(parseHash('#/@profil'), { page: '@profil', projectId: null, sceneId: null });
  assert.deepEqual(parseHash('#/@compte'), { page: '@compte', projectId: null, sceneId: null });
  assert.deepEqual(parseHash('#/proj'), { page: null, projectId: 'proj', sceneId: null });
  assert.deepEqual(parseHash('#/proj/scene'), { page: null, projectId: 'proj', sceneId: 'scene' });
  assert.deepEqual(parseHash('#/'), home);
  assert.deepEqual(parseHash('#'), home);
  assert.deepEqual(parseHash(''), home);
});

test('encoded characters are decoded before the hash is split', () => {
  assert.deepEqual(parseHash('#/%40compte'), { page: '@compte', projectId: null, sceneId: null });
  assert.deepEqual(parseHash('#/proj/sc%C3%A8ne'), { page: null, projectId: 'proj', sceneId: 'scène' });
});

const Profile = () => null;
const Account = () => null;
const HostProfile = () => null;
const core: Pages = { '@profil': Profile };

test('a host page wins, and a host may replace a core page', () => {
  assert.equal(resolvePage('@compte', { '@compte': Account }, core), Account);
  assert.equal(resolvePage('@profil', { '@profil': HostProfile }, core), HostProfile);
  assert.equal(resolvePage('@profil', { '@compte': Account }, core), Profile);
});

test('without host pages, @profil is the core Profile', () => {
  assert.equal(resolvePage('@profil', undefined, core), Profile);
});

test('an unknown page id resolves to nothing', () => {
  assert.equal(resolvePage('@nope', undefined, core), null);
  assert.equal(resolvePage('@nope', { '@compte': Account }, core), null);
});
