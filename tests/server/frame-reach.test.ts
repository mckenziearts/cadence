// What one frame origin may read, without a server: realPath's bound, homeOf and frameReach.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { ViteDevServer } from 'vite';
import { loadConfig } from '../../server/config';
import { frameReach, homeOf } from '../../server/frames/vite';
import { realPath } from '../../server/util';
import { makeRoot } from './helpers';

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** A temp root also reached through a link to it, as `/var` is on macOS. */
async function linkedRoot() {
  const { root, config, cleanup } = await makeRoot();
  const link = `${root}-link`;
  await fs.symlink(root, link);
  const real = await fs.realpath(root);
  return {
    config,
    real,
    link,
    linked: loadConfig({ root: link, editorPort: 5299, framePort: 5300 }),
    cleanup: async () => {
      await fs.rm(link);
      await cleanup();
    },
  };
}

test('realPath follows links and keeps a missing tail, up to 32 missing folders', async () => {
  const { real, link, cleanup } = await linkedRoot();
  try {
    const missing = (n: number) => Array<string>(n).fill('a');
    assert.equal(await realPath(path.join(link, 'projects', 'p', 'x.tsx')), path.join(real, 'projects', 'p', 'x.tsx'));
    assert.equal(await realPath(path.join(link, 'projects', ...missing(32))), path.join(real, 'projects', ...missing(32)));
    // A request URL or a stylesheet reference may name thousands of folders: each would cost one more lookup.
    await assert.rejects(realPath(path.join(link, 'projects', ...missing(33))), /too many missing folders/);
  } finally {
    await cleanup();
  }
});

test("a project's home is its folder and the brand its project.json names, the default brand when it names none", async () => {
  const { config, real, cleanup } = await linkedRoot();
  try {
    const scene = path.join(config.projectsDir, 'a', 'scenes', 'x.tsx');
    await write(scene, '');
    const home = async (file = scene) => (await homeOf(file, config))?.map((dir) => path.relative(real, dir));
    const brand = (value: unknown) =>
      fs.writeFile(path.join(config.projectsDir, 'a', 'project.json'), JSON.stringify({ brand: value }));
    await brand('orbit');
    assert.deepEqual(await home(), ['projects/a', 'brands/orbit']);
    for (const value of [null, undefined]) {
      await brand(value);
      assert.deepEqual(await home(), ['projects/a', 'brands/cadence'], String(value));
    }
    // project.json is written by the agent: a brand that is not an id must not lead out of the brands.
    for (const value of ['..', '../projects/b', '.', 3]) {
      await brand(value);
      assert.deepEqual(await home(), ['projects/a'], String(value));
    }
    assert.deepEqual(await home(path.join(config.brandsDir, 'orbit', 'theme.css')), ['brands/orbit']);
    assert.equal(await home(path.join(config.templatesDir, 'scenes', 'x.tsx')), undefined);
  } finally {
    await cleanup();
  }
});

test('a frame reads its project, its brand, the templates and the app, never another project or brand, a folder or a link out', async () => {
  const { config, cleanup } = await linkedRoot();
  try {
    const { projectsDir, brandsDir, templatesDir, root } = config;
    const vite = {
      config: { server: { fs: { allow: [path.join(root, 'src'), projectsDir, brandsDir, templatesDir] } } },
    } as unknown as ViteDevServer;
    await write(path.join(projectsDir, 'a', 'project.json'), JSON.stringify({ brand: 'orbit' }));
    await write(path.join(projectsDir, 'a', 'scenes', 'x.tsx'), '');
    await write(path.join(projectsDir, 'b', 'scenes', 'y.tsx'), '');
    await write(path.join(root, 'src', 'app.ts'), '');
    await write(path.join(root, 'secret.txt'), '');
    await fs.symlink(path.join(projectsDir, 'b', 'scenes', 'y.tsx'), path.join(projectsDir, 'a', 'scenes', 'link.tsx'));
    const readable = await frameReach(vite, config, path.join(projectsDir, 'a'));
    const cases: [string, boolean][] = [
      [path.join(projectsDir, 'a', 'scenes', 'x.tsx'), true],
      [path.join(brandsDir, 'orbit', 'brand.json'), true],
      [path.join(templatesDir, 'scenes', 'logo-reveal', 'scene.tsx'), true],
      [path.join(root, 'src', 'app.ts'), true],
      [path.join(projectsDir, 'b', 'scenes', 'y.tsx'), false],
      [path.join(brandsDir, 'cadence', 'brand.json'), false],
      [path.join(projectsDir, 'a', 'scenes', 'link.tsx'), false],
      // Vite would answer a folder with a file it picks inside.
      [path.join(projectsDir, 'a', 'scenes'), false],
      [path.join(projectsDir, 'b'), false],
      [path.join(root, 'secret.txt'), false],
      [path.join(projectsDir, 'a', ...Array<string>(200).fill('a')), false],
    ];
    for (const [file, expected] of cases) assert.equal(await readable(file), expected, path.relative(root, file).slice(0, 80));
  } finally {
    await cleanup();
  }
});
