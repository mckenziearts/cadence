// The build-time guard that keeps @plugin/@config out of project, brand and template CSS: Tailwind would otherwise
// load and run that module in the server process when it compiles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import type { ViteDevServer } from 'vite';
import { brandProblems } from '../../server/brands/check';
import { loadConfig } from '../../server/config';
import { m } from '../../server/i18n';
import { createFrameHandler } from '../../server/frames/frameServer';
import { assertNoCssCodeExec, createVite } from '../../server/frames/vite';
import { CssCodeScan } from '../../server/util';
import { frameGet, makeRoot, writeCompleteBrand } from './helpers';

const managed = (root: string) =>
  [['projects', 'brands', 'templates'].map((d) => path.join(root, d)), path.join(root, 'brands')] as const;

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
    await assertNoCssCodeExec(...managed(root));
  } finally {
    await cleanup();
  }
});

test('refuses @plugin and @config, and names every offender', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/acme/theme.css', "@import 'tailwindcss';\n@plugin './evil.ts';\n");
    await write(root, 'projects/p/components/c.css', '@config "../../../../etc/passwd";\n');
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
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
    await assert.rejects(assertNoCssCodeExec(...managed(root)), /brands\/acme\/b\.css/);
  } finally {
    await cleanup();
  }
});

test('catches a directive split by a comment, also after a string holding a comment start', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    // Tailwind drops comments but reads `"/*"` as a string: both files load ./p.mjs when compiled.
    await write(root, 'brands/acme/a.css', '@plu/**/gin "./p.mjs";\n');
    await write(root, 'brands/acme/b.css', '.a { content: "/*"; }\n@plu/**/gin "./p.mjs";\n/* */\n');
    // An escaped star does not end Tailwind's comment: the comment is `/* \*/ x */`.
    await write(root, 'brands/acme/c.css', '@plu/* \\*/ x */gin "./p.mjs";\n');
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      assert.match(e.message, /brands\/acme\/a\.css/);
      assert.match(e.message, /brands\/acme\/b\.css/);
      assert.match(e.message, /brands\/acme\/c\.css/);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('a stream scan gives the answer of a whole-text scan wherever the pieces are cut', () => {
  const cases: [string, boolean][] = [
    ['@plugin "x";', true],
    ['@config "x"', true],
    ['.a { content: "/*"; }\n@plu/**/gin "x";\n/* */', true],
    ["a { b: '\\'' } @co/* x */nfig 'y';", true],
    ['/* @plugin "x"; */', true],
    ['x @plugin', true],
    ['@plugins x; @configure y;', false],
    ['/* @plu */gin x; @plu/* unclosed gin', false],
    ['a { content: "@plu" "gin"; }', false],
    // Tailwind skips the character after a backslash in a comment, so `\*/` does not close it.
    ['@plu/* \\*/ x */gin "x";', true],
    // The same text read with the other comment rule: either rule revealing the directive refuses it.
    ['@plu/* \\*/gin "x"; /* */', true],
    ['/* C:\\fonts\\ */ .a { color: red; }', false],
  ];
  const scan = (pieces: string[]) => {
    const s = new CssCodeScan();
    for (const piece of pieces) s.push(piece);
    return s.end();
  };
  for (const [css, expected] of cases) {
    for (let cut = 0; cut <= css.length; cut++) {
      for (let second = cut; second <= css.length; second++) {
        const pieces = [css.slice(0, cut), css.slice(cut, second), css.slice(second)];
        assert.equal(scan(pieces), expected, `${css} cut as ${JSON.stringify(pieces)}`);
      }
    }
  }
});

test('refuses a stylesheet importing by path a file that is not a stylesheet, which Tailwind would read as CSS', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/components/logo.png', '@plugin "./x.mjs";');
    await write(root, 'projects/p/components/a.css', "@import './logo.png';\n");
    await write(root, 'brands/acme/notes.txt', 'x');
    await write(root, 'brands/acme/b.css', '@imp/**/ort "./notes.txt" layer(x);\n');
    await write(root, 'templates/t/folder.css/package.json', '{ "style": "../logo.png" }');
    await write(root, 'templates/t/c.css', '@reference "./folder.css";\n');
    await fs.symlink(path.join(root, 'brands/acme/notes.txt'), path.join(root, 'brands/acme/linked.css'));
    await write(root, 'brands/acme/d.css', "@import './linked.css?x=1';\n");
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      for (const file of ['projects/p/components/a.css', 'brands/acme/b.css', 'templates/t/c.css', 'brands/acme/d.css']) {
        assert.ok(e.message.includes(path.join(root, file)), file);
      }
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('refuses an import with a query or a fragment, which Tailwind reads as part of a file name the walk never scans', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/components/evil.css', '.a {}\n');
    await write(root, 'projects/p/components/evil.css?.png', '@plugin "./x.mjs";');
    await write(root, 'projects/p/components/a.css', '@import "./evil.css?.png";\n');
    await write(root, 'brands/acme/x.css', '.a {}\n');
    await write(root, 'brands/acme/x.css#.png', '@plugin "./x.mjs";');
    await write(root, 'brands/acme/b.css', "@reference './x.css#.png';\n");
    await write(root, 'templates/t/c.css', '@import "@brands/acme/x.css?.png";\n');
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      for (const file of ['projects/p/components/a.css', 'brands/acme/b.css', 'templates/t/c.css']) {
        assert.ok(e.message.includes(path.join(root, file)), file);
      }
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('checks each import on its own, also after a string that holds the start of one', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    for (const dir of ['projects/p/components', 'brands/acme', 'templates/t']) {
      await write(root, `${dir}/evil.png`, '@plugin "./x.mjs";');
      await write(root, `${dir}/x.css`, '.a {}\n');
    }
    await write(root, 'projects/p/components/a.css', `.a { content: '@import "'; }\n@import "./evil.png";\n`);
    await write(root, 'brands/acme/b.css', `.a { content: "@reference '"; }\n@reference './evil.png';\n`);
    await write(root, 'templates/t/c.css', `@import "./x.css" layer('@import "');\n@import "./evil.png";\n`);
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      for (const file of ['projects/p/components/a.css', 'brands/acme/b.css', 'templates/t/c.css']) {
        assert.ok(e.message.includes(path.join(root, file)), file);
      }
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('refuses an import that is neither a path, the @brands alias nor a package name', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/components/evil.png', '@plugin "./x.mjs";');
    const specifiers = [
      `file://${path.join(root, 'projects/p/components/evil.png')}`,
      "data:text/css,@plugin './x.mjs';",
      'https://example.com/x.css',
      'tailwindcss/../../projects/p/components/evil.png',
      '@scope/.hidden/x.css',
    ];
    for (const [i, specifier] of specifiers.entries()) {
      await write(root, `projects/p/components/s${i}.css`, `@import "${specifier}";\n`);
    }
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      for (const i of specifiers.keys())
        assert.ok(e.message.includes(path.join(root, `projects/p/components/s${i}.css`)), specifiers[i]);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('refuses an import into a folder the walk skips or never enters: .git, a linked folder', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/components/.git/evil.css', '@plugin "./x.mjs";');
    await write(root, 'projects/p/components/a.css', '@import "./.git/evil.css";\n');
    await write(root, 'brands/acme/.git/evil.css', '@plugin "./x.mjs";');
    await write(root, 'templates/t/c.css', '@import "@brands/acme/.git/evil.css";\n');
    await write(root, 'outside/evil.css', '@plugin "./x.mjs";');
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'projects/p/components/linked'));
    await write(root, 'projects/p/components/b.css', '@import "./linked/evil.css";\n');
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'brands/acme/linked'));
    await write(root, 'templates/t/d.css', '@import "@brands/acme/linked/evil.css";\n');
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      const refused = ['projects/p/components/a.css', 'templates/t/c.css', 'projects/p/components/b.css', 'templates/t/d.css'];
      for (const file of refused) {
        assert.ok(e.message.includes(path.join(root, file)), file);
      }
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('imports of stylesheets by path, of packages and through the @brands alias pass', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/acme/fonts.css', '.a {}\n');
    await write(
      root,
      'brands/acme/theme.css',
      "@import 'tailwindcss' source(none);\n@import './fonts.css';\n@import '@fontsource-variable/inter/standard.css';\n",
    );
    await write(
      root,
      'projects/p/components/s.css',
      "@import '@brands/acme/fonts.css';\n@import '../../../brands/acme/fonts.css';\n@import './acme/fonts.css';\n",
    );
    // A linked folder that stays inside the managed dirs reaches only what the walk reads.
    await fs.symlink(path.join(root, 'brands/acme'), path.join(root, 'projects/p/components/acme'));
    await assertNoCssCodeExec(...managed(root));
  } finally {
    await cleanup();
  }
});

test('does not match @plugins or @configure (word boundary)', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/acme/theme.css', '.x { --plugins: 1; }\n/* @configure nothing */\n@media screen { .y {} }\n');
    await assertNoCssCodeExec(...managed(root));
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
    await assert.rejects(assertNoCssCodeExec(...managed(root)), /components\/renders\/evil\.css/);
  } finally {
    await cleanup();
  }
});

test('still skips .git, which holds no managed stylesheet and no import may reach', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/cadence/.git/x.css', "@config './evil.ts';\n");
    await assertNoCssCodeExec(...managed(root));
  } finally {
    await cleanup();
  }
});

test('refuses node_modules and package.json, through which a bare or #import specifier reaches files the walk never reads', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    // Tailwind's resolver falls back to enhanced-resolve, which follows package.json `imports` and node_modules and keeps
    // a result of any extension: each of these loads ./evil.mjs when compiled.
    await write(root, 'projects/p/components/package.json', '{ "imports": { "#x": "./x.png" } }');
    await write(root, 'projects/p/components/x.png', '@plugin "./evil.mjs";');
    await write(root, 'projects/p/components/e.css', '@import "#x";\n');
    await write(root, 'projects/q/components/node_modules/x.png', '@plugin "./evil.mjs";');
    await write(root, 'projects/q/components/f.css', '@import "x.png";\n');
    await write(root, 'brands/acme/node_modules/evil/index.css', '@plugin "./evil.mjs";');
    await write(root, 'brands/acme/g.css', '@import "evil";\n');
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      for (const rel of [
        'projects/p/components/package.json',
        'projects/q/components/node_modules',
        'brands/acme/node_modules',
      ]) {
        assert.ok(e.message.includes(path.join(root, rel)), rel);
      }
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('scans a stylesheet under any name a case-insensitive disk opens for a .css request', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'projects/p/scenes/a.CSS', '@plugin "./x.mjs";\n');
    await write(root, 'projects/q/scenes/b.c\u017fs', '@plugin "./x.mjs";\n');
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      assert.ok(e.message.includes(path.join(root, 'projects/p/scenes/a.CSS')));
      assert.ok(e.message.includes(path.join(root, 'projects/q/scenes/b.c\u017fs')));
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('refuses node_modules and package.json under any name a case-insensitive disk takes for them', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    // On APFS, the resolver's stat of components/node_modules opens Node_Modules: the bare specifier reaches x.png.
    // One project each: on such a disk the names are one folder.
    const names = ['Node_Modules', 'NODE_MODULES', 'node_module\u017f', 'Package.json', 'pac\u212Aage.json'];
    for (const [i, name] of names.entries()) {
      await write(root, `projects/p${i}/components/a.css`, '@import "evil/x.png";\n');
      await write(root, `projects/p${i}/components/${name}/evil/x.png`, '@plugin "./p.mjs";');
    }
    await assert.rejects(assertNoCssCodeExec(...managed(root)), (e: Error) => {
      for (const [i, name] of names.entries()) {
        assert.ok(e.message.includes(path.join(root, `projects/p${i}/components`, name)), name);
      }
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('node_modules or package.json where no stylesheet can reach it blocks no compile', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    // The resolver only looks in the folders above the stylesheet: project a has none, so project b still compiles.
    await write(root, 'projects/a/package.json', '{ "imports": { "#x": "./x.png" } }');
    await write(root, 'projects/a/node_modules/evil/x.png', '@plugin "./evil.mjs";');
    await write(root, 'projects/a/scenes/s.tsx', 'export default () => null;\n');
    await write(root, 'projects/b/components/c.css', '.c { color: red; }\n');
    await write(root, 'brands/acme/assets/package.json', '{}');
    await write(root, 'brands/acme/theme.css', '.t {}\n');
    await assertNoCssCodeExec(...managed(root));
  } finally {
    await cleanup();
  }
});

test('a stylesheet compiles, a file of another kind requested as CSS through the query is refused', async () => {
  const { root, cleanup } = await makeRoot();
  const repo = path.resolve(import.meta.dirname, '../..');
  process.env.CADENCE_VITE_CACHE_DIR ??= path.join(repo, 'node_modules/.vite-e2e/frames-css');
  let vite: ViteDevServer | undefined;
  try {
    const real = await fs.realpath(root);
    const [[projectsDir, brandsDir, templatesDir]] = managed(real);
    const stateDir = path.join(real, 'state');
    vite = await createVite({
      config: loadConfig({ root: repo, projectsDir, brandsDir, templatesDir, stateDir, editorPort: 0, framePort: 0 }),
    });
    await write(real, 'brands/acme/theme.css', '.title { color: #f08; }\n');
    await write(real, 'projects/p/scenes/s.css', '.title { color: #f08; }\n');
    for (const url of [`${brandsDir}/acme/theme.css?g=3`, `${projectsDir}/p/scenes/s.css`]) {
      const compiled = await vite.environments.client.transformRequest(`/@fs${url}`);
      assert.match(compiled?.code ?? '', /#f08/, url);
    }
    // Tailwind compiles an id holding `&lang.css` or `index=<n>.css` whatever the file's extension.
    await write(real, 'projects/p/notes.md', '@plugin "./x.mjs";\n');
    await write(
      real,
      'projects/p/x.mjs',
      "import fs from 'node:fs';\nfs.writeFileSync(new URL('./PWNED', import.meta.url), 'x');\nexport default {};\n",
    );
    for (const query of ['?x&lang.css', '?x&index=0.css']) {
      await assert.rejects(
        vite.environments.client.transformRequest(`/@fs${projectsDir}/p/notes.md${query}`),
        /Only a \.css file/,
        query,
      );
    }
    assert.equal(await fs.stat(path.join(projectsDir, 'p/PWNED')).catch(() => null), null);
  } finally {
    await vite?.close();
    await cleanup();
  }
});

test('the frame origin answers 404 to a query that would make Tailwind compile a file as CSS', async () => {
  const { config, cleanup } = await makeRoot();
  const reached: string[] = [];
  const vite = {
    middlewares: (req: http.IncomingMessage, res: http.ServerResponse) => {
      reached.push(req.url!);
      res.end('vite');
    },
  } as unknown as ViteDevServer;
  let handle: ReturnType<typeof createFrameHandler> = () => undefined;
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const framePort = (server.address() as AddressInfo).port;
  const frameOrigin = `http://localhost:${framePort}`;
  const brands = { exists: async (id: string) => id === 'cadence' } as never;
  handle = createFrameHandler({ config: { ...config, framePort, frameOrigin }, vite, store: {} as never, brands });
  try {
    const status = async (url: string) => (await frameGet(frameOrigin, { kind: 'brand', id: 'cadence' }, url)).status;
    for (const query of ['?x&lang.css', '?html-proxy&index=0.css', '?x%26lang%2Ecss', '?index=%30.css', '?%E0']) {
      assert.equal(await status(`/@fs/p/notes.md${query}`), 404, query);
    }
    assert.equal(await status('/@fs/p/theme.css?g=3'), 200);
    assert.deepEqual(reached, ['/@fs/p/theme.css?g=3']);
  } finally {
    server.close();
    await cleanup();
  }
});

test('brandProblems flags @plugin inside the brand folder, also split by a comment', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await write(root, 'brands/cadence/extras/x.css', "@plugin './evil.ts';\n");
    await write(root, 'brands/cadence/extras/y.css', "@plu/**/gin './evil.ts';\n");
    const problems = await brandProblems(path.join(root, 'brands/cadence'), root);
    for (const file of ['x.css', 'y.css']) {
      assert.ok(
        problems.some((p) => p.includes('@plugin') && p.includes(file)),
        `expected a @plugin problem for ${file}, got: ${problems.join(' | ')}`,
      );
    }
  } finally {
    await cleanup();
  }
});

test('brandProblems reads nothing through a link the build turn could plant: a stylesheet counts as code, brand.json as missing', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    const dir = path.join(root, 'brands/cadence');
    await write(root, 'outside/clean.css', ':root { --x: 1px; }\n');
    await fs.symlink(path.join(root, 'outside/clean.css'), path.join(dir, 'linked.css'));
    const problems = await brandProblems(dir, root);
    assert.ok(
      problems.some((p) => p.includes('@plugin') && p.includes('linked.css')),
      `expected linked.css refused, got: ${problems.join(' | ')}`,
    );

    await fs.rename(path.join(dir, 'brand.json'), path.join(root, 'outside/brand.json'));
    await fs.symlink(path.join(root, 'outside/brand.json'), path.join(dir, 'brand.json'));
    assert.deepEqual(await brandProblems(dir, root), [m().media.brands.check.missing('brand.json')]);
  } finally {
    await cleanup();
  }
});

test('brandProblems counts a linked logo as missing and a linked font file as a theme problem', async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await writeCompleteBrand(root, 'orbit');
    const dir = path.join(root, 'brands/orbit');
    assert.deepEqual(await brandProblems(dir, root), []);
    for (const rel of ['assets/logo-mark.svg', 'fonts/orbit.woff2']) {
      await fs.rename(path.join(dir, rel), path.join(root, path.basename(rel)));
      await fs.symlink(path.join(root, path.basename(rel)), path.join(dir, rel));
    }
    const t = m().media.brands.check;
    const problems = await brandProblems(dir, root);
    assert.ok(problems.includes(t.logoMissing('mark', 'assets/logo-mark.svg')), problems.join(' | '));
    assert.ok(problems.includes(t.themeFile('./fonts/orbit.woff2')), problems.join(' | '));
  } finally {
    await cleanup();
  }
});
