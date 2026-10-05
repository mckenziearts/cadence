// A host app keeps projects and brands outside the core: scenes there still import the core's dependencies, and the
// terminal guide written next to them names no path that only exists inside the core.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ViteDevServer } from 'vite';
import { writeProjectsGuide } from '../../server/agent/guide';
import { loadConfig } from '../../server/config';
import type { CadenceConfig } from '../../server/contracts';
import { createVite } from '../../server/frames/vite';
import { isInside } from '../../server/util';
import { nextEvent } from './helpers';

const repo = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
let config: CadenceConfig;
let vite: ViteDevServer;

async function write(file: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

/** Where each import of a transformed module points: `/@fs/<abs>` or a URL under the Vite root. */
function importedFiles(code: string): string[] {
  const specifiers = [...code.matchAll(/(?:^|;)\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
  return specifiers.map((s) => (s.startsWith('/@fs/') ? s.slice('/@fs'.length) : path.join(repo, s)).replace(/\?.*$/, ''));
}

before(async () => {
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(repo, 'node_modules/.vite-e2e/outside-root');
  // Real paths: on macOS the temp dir is a symlink, and Vite reports importers by their real path.
  const [projectsDir, brandsDir, templatesDir, stateDir] = await Promise.all(
    ['projects', 'brands', 'templates', 'state'].map(async (name) =>
      fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `cadence-${name}-`))),
    ),
  );
  dirs.push(projectsDir, brandsDir, templatesDir, stateDir);
  config = loadConfig({ root: repo, projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0 });
  vite = await createVite({ config });
});

after(async () => {
  await vite?.close();
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test('scenes and brand kits outside the core resolve bare imports from the core', async () => {
  const scene = await write(
    path.join(config.projectsDir, 'demo/scenes/intro.tsx'),
    [
      "import { useMemo } from 'react';",
      "import clsx from 'clsx';",
      "import { Play } from 'lucide-react';",
      "import { CheckIcon } from '@heroicons/react/16/solid';",
      'export default function Intro() {',
      '  const name = useMemo(() => clsx("a", "b"), []);',
      '  return <div className={name}><Play /><CheckIcon /></div>;',
      '}',
      '',
    ].join('\n'),
  );
  const kit = await write(
    path.join(config.brandsDir, 'acme/kit.tsx'),
    "import { IconBolt } from '@tabler/icons-react';\nexport const Bolt = () => <IconBolt />;\n",
  );
  for (const [file, packages] of [
    [scene, ['react', 'clsx', 'lucide-react', '@heroicons/react']],
    [kit, ['@tabler/icons-react']],
  ] as const) {
    const result = await vite.environments.client.transformRequest(`/@fs${file}`);
    assert.ok(result, file);
    const imported = importedFiles(result.code);
    for (const name of packages) {
      const dep = name.replace('/', '_');
      assert.ok(
        imported.some((target) => target.includes(`/${name}/`) || target.includes(`/deps/${dep}`)),
        `${name} in ${imported.join(', ')}`,
      );
    }
    for (const target of imported) assert.ok(isInside(repo, target), `${target} is under the core`);
  }
});

test('projects/CLAUDE.md outside the core names no path relative to the core', async () => {
  await writeProjectsGuide(config);
  const guide = await fs.readFile(path.join(config.projectsDir, 'CLAUDE.md'), 'utf8');
  assert.match(guide, /## Scope: terminal session/);
  assert.doesNotMatch(guide, /(^|[\s`(])(projects|src|brands|templates)\//m);
});

test('the watcher reports edits outside the core, and leaves out renders and soundtracks', async () => {
  const project = path.join(config.projectsDir, 'watched');
  const reported: string[] = [];
  const onFile = (_event: string, file: string) => reported.push(file);
  vite.watcher.on('all', onFile);
  try {
    // Folders added after the start take the watcher a moment: write until it reports the file.
    const notes = path.join(project, 'art-direction.md');
    for (let attempt = 0; !reported.includes(notes); attempt++) {
      assert.ok(attempt < 50, `no event for ${notes}`);
      await write(path.join(project, 'renders', 'final.mp4'), String(attempt));
      await write(path.join(project, 'music', 'track.wav'), String(attempt));
      await write(path.join(config.projectsDir, '.trash', 'old', 'project.json'), String(attempt));
      await write(notes, `# ${attempt}\n`);
      await sleep(200);
    }
    // Written well after the skipped files: once it is reported, so would they have been.
    const kit = path.join(config.brandsDir, 'acme', 'KIT.md');
    const brand = nextEvent(vite.watcher, 'all', 10_000, (_event, file) => file === kit);
    await write(kit, 'notes');
    await brand;
    // Only this projectsDir: the watcher also sees the core's own projects/, where other test files render in parallel.
    assert.deepEqual(
      reported.filter((file) => isInside(config.projectsDir, file) && /[/\\](renders|music|\.trash)([/\\]|$)/.test(file)),
      [],
    );
  } finally {
    vite.watcher.off('all', onFile);
  }
});
