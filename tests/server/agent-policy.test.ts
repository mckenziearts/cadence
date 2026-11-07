import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFiles, deniedFiles, denyRules } from '../../server/agent/chat';
import { claudeRules } from '../../server/agent/policy';

const STATE = '/r/.cadence';
const DIRS = { brand: '/r/brands/orbit', templates: '/r/templates', runtime: '/r/src/runtime' };
const PROJECT = '/r/projects/demo';

// Expected arrays are what v0.14.0 gave Claude Code and Codex: a change here changes what those agents may touch.
const CHAT_READS = [
  'Read(//r/projects/demo/**)',
  'Read(//r/brands/orbit/**)',
  'Read(//r/templates/**)',
  'Read(//r/src/runtime/**)',
  'Glob',
  'Grep',
];
const DENY = ['Read(//r/.cadence/accounts.json)', 'Read(//r/.cadence/elevenlabs.json)'];

test('a scene turn gets the v0.14.0 rules, its write list holds the exact scene file', () => {
  const files = chatFiles(PROJECT, 'intro', DIRS, deniedFiles(STATE));
  assert.deepEqual(files, {
    read: ['/r/projects/demo/**', '/r/brands/orbit/**', '/r/templates/**', '/r/src/runtime/**'],
    write: ['/r/projects/demo/scenes/intro.tsx'],
    deny: ['/r/.cadence/accounts.json', '/r/.cadence/elevenlabs.json'],
  });
  assert.deepEqual(claudeRules(files), {
    allow: [...CHAT_READS, 'Edit(//r/projects/demo/scenes/intro.tsx)', 'Write(//r/projects/demo/scenes/intro.tsx)'],
    deny: DENY,
  });
});

test('a project turn gets the v0.14.0 rules', () => {
  const files = chatFiles(PROJECT, null, DIRS, deniedFiles(STATE));
  assert.deepEqual(files.write, [
    '/r/projects/demo/scenes/**',
    '/r/projects/demo/components/**',
    '/r/projects/demo/art-direction.md',
  ]);
  assert.deepEqual(claudeRules(files), {
    allow: [
      ...CHAT_READS,
      'Edit(//r/projects/demo/scenes/**)',
      'Write(//r/projects/demo/scenes/**)',
      'Edit(//r/projects/demo/components/**)',
      'Write(//r/projects/demo/components/**)',
      'Edit(//r/projects/demo/art-direction.md)',
      'Write(//r/projects/demo/art-direction.md)',
    ],
    deny: DENY,
  });
});

test('denyRules keeps the Read rules Codex parses', () => {
  assert.deepEqual(denyRules(STATE), DENY);
});

test('a brand build gets the v0.14.0 rules', () => {
  const repo = '/r/.cadence/brand-sources/b1';
  const brand = '/r/brands/acme';
  const shared = '/r/src/shared';
  const files = { read: [`${repo}/**`, `${brand}/**`, `${shared}/**`], write: [`${brand}/**`], deny: deniedFiles(STATE) };
  assert.deepEqual(claudeRules(files), {
    allow: [
      'Read(//r/.cadence/brand-sources/b1/**)',
      'Read(//r/brands/acme/**)',
      'Read(//r/src/shared/**)',
      'Glob',
      'Grep',
      'Edit(//r/brands/acme/**)',
      'Write(//r/brands/acme/**)',
    ],
    deny: DENY,
  });
});
