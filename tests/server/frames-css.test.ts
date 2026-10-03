// The build-time guard that keeps @plugin/@config out of project, brand and template CSS: Tailwind would otherwise
// load and run that module in the server process when it compiles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { brandProblems } from '../../server/brands/check';
import { assertNoCssCodeExec } from '../../server/frames/vite';
import { makeRoot } from './helpers';

const managed = (root: string) => ['projects', 'brands', 'templates'].map((d) => path.join(root, d));

async function write(root: string, rel: string, content: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('clean managed CSS passes', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/acme/theme.css', "@import 'tailwindcss';\n@theme { --color-brand: #f08; }\n");
    await write(root, 'projects/p/scenes/s.css', '.title { color: var(--color-brand); }\n');
    await assertNoCssCodeExec(managed(root));
  } finally {
    await cleanup();
  }
});

test('refuses @plugin and @config, and names every offender', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/acme/theme.css', "@import 'tailwindcss';\n@plugin './evil.ts';\n");
    await write(root, 'projects/p/components/c.css', '@config "../../../../etc/passwd";\n');
    await assert.rejects(assertNoCssCodeExec(managed(root)), (e: Error) => {
      assert.match(e.message, /brands\/acme\/theme\.css/);
      assert.match(e.message, /projects\/p\/components\/c\.css/);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('catches @plugin reached only through a two-hop @import, not just the entry', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    // entry is clean; Tailwind inlines these @imports itself, so the leaf must still be caught.
    await write(root, 'brands/acme/theme.css', "@import 'tailwindcss';\n@import './a.css';\n");
    await write(root, 'brands/acme/a.css', "@import './b.css';\n");
    await write(root, 'brands/acme/b.css', "@plugin './evil.ts';\n");
    await assert.rejects(assertNoCssCodeExec(managed(root)), /brands\/acme\/b\.css/);
  } finally {
    await cleanup();
  }
});

test('does not match @plugins or @configure (word boundary)', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/acme/theme.css', '.x { --plugins: 1; }\n/* @configure nothing */\n@media screen { .y {} }\n');
    await assertNoCssCodeExec(managed(root));
  } finally {
    await cleanup();
  }
});

test('catches @plugin in a dir named like an infra dir (components/renders) that the agent can write', async () => {
  // The attack: a dir basename-matching the old skip set, but import-reachable because components/ is agent-writable.
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/components/renders/evil.css', "@plugin './pwn.js';\n");
    await write(root, 'projects/p/scenes/s.tsx', "import '../components/renders/evil.css';\n");
    await assert.rejects(assertNoCssCodeExec(managed(root)), /components\/renders\/evil\.css/);
  } finally {
    await cleanup();
  }
});

test('still skips .git and node_modules (never agent-writable, no managed stylesheet)', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/node_modules/dep/x.css', "@plugin './evil.ts';\n");
    await write(root, 'brands/cadence/.git/x.css', "@config './evil.ts';\n");
    await assertNoCssCodeExec(managed(root));
  } finally {
    await cleanup();
  }
});

test('brandProblems flags @plugin inside the brand folder', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/cadence/extras/x.css', "@plugin './evil.ts';\n");
    const problems = await brandProblems(path.join(root, 'brands/cadence'), root);
    assert.ok(
      problems.some((p) => p.includes('@plugin') && p.includes('x.css')),
      `expected a @plugin problem, got: ${problems.join(' | ')}`,
    );
  } finally {
    await cleanup();
  }
});
