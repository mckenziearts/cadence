// The CLI writes into the repository's projects/ folder: the project gets an e2e-* id and is removed after.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('`new` creates the project with its initial version', async (t) => {
  const id = `e2e-cli-${randomBytes(4).toString('hex')}`;
  const dir = path.join(ROOT, 'projects', id);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'bin/cadence.ts', 'new', id], {
    cwd: ROOT,
    env: { ...process.env, CADENCE_LANGUAGE: 'fr' },
  });
  assert.match(stdout, new RegExp(`Projet « ${id} » créé`));
  const versions = JSON.parse(await fs.readFile(path.join(dir, '.cadence', 'versions', 'index.json'), 'utf8'));
  assert.deepEqual(
    versions.map((v: { id: string; source: string; label: string }) => [v.id, v.source, v.label]),
    [['v0001', 'baseline', 'État initial']],
  );
});
