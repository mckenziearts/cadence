// The one Vite dev server (middleware mode): frame modules (runtime, brands, scenes) on the frame origin, and the editor's
// own modules with `npm run dev` (server/editor.ts). Cadence reloads frames itself, so HMR is off.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { compile } from 'tailwindcss';
import {
  createIdResolver,
  createServer,
  isCSSRequest,
  isFileLoadingAllowed,
  mergeConfig,
  type DevEnvironment,
  type EnvironmentModuleNode,
  type InlineConfig,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import { ID_PATTERN } from '../../src/shared/types';
import { contentType, parseRange } from '../api/files';
import type { CadenceConfig } from '../contracts';
import { m } from '../i18n';
import { DEFAULT_BRAND } from '../store/brands';
import { CssCodeScan, foldName, isInside, isResolverInput, openFileNoFollow, PACKAGE, readFileNoFollow, realPath } from '../util';

export async function createVite({
  config,
  overrides = {},
}: {
  config: CadenceConfig;
  /** Tests only: e.g. a stub `cadence` runtime and an isolated dependency cache. */
  overrides?: InlineConfig;
}): Promise<ViteDevServer> {
  const managed = [config.projectsDir, config.brandsDir, config.templatesDir];
  // A module is named by the path its URL or import names (preserveSymlinks), so a dir reached through a link (`/var` on
  // macOS) is known under both names.
  const managedNames = [...new Set([...managed, ...(await Promise.all(managed.map(realPath)))])];
  const cacheDir = process.env.CADENCE_VITE_CACHE_DIR;
  const { dependencies } = JSON.parse(await fs.readFile(path.join(config.root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const base: InlineConfig = {
    root: config.root,
    configFile: false,
    envDir: false,
    appType: 'custom',
    clearScreen: false,
    logLevel: 'warn',
    server: {
      middlewareMode: true,
      hmr: false,
      // No HMR websocket at all: otherwise every Cadence server (app, CLI render, tests) fights for port 24678.
      ws: false,
      // Nothing is fetched cross-origin: the editor and the frame each load modules from their own origin.
      cors: false,
      fs: {
        // What the two origins load (apps and runtime, scenes, brands, templates, packages), not the whole repository:
        // scene code runs on the frame origin and must not read server/, bin/, tests/ or the root config files.
        allow: [
          path.join(config.root, 'src'),
          ...managedNames,
          path.join(config.root, 'node_modules'),
          ...(cacheDir ? [cacheDir] : []),
        ],
        // Replaces Vite's default list, so its entries are repeated here.
        deny: ['.env*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.cadence/**'],
      },
      // This watcher also feeds ProjectStore.watch(). What only piles up stays out (versions, chats and thumbnails under
      // .cadence/, renders, soundtracks, trashed projects, imports being staged): on Linux each watched file holds an
      // inotify watch.
      watch: {
        ignored: ['**/.cadence/**', (file: string) => pilesUp(config, file)],
      },
    },
    resolve: {
      alias: { cadence: path.join(config.root, 'src/runtime/index.ts'), '@brands': config.brandsDir },
      // Vite resolves a bare import from the importer's folder, and managed dirs may live outside the core (a host app's
      // own folders) with no node_modules: deduped ids resolve from `root` instead, so scenes get the core's packages.
      dedupe: Object.keys(dependencies),
      // Else Vite resolves a URL again after the frame handler checked it, to where a link there leads by then: a file
      // swapped for a link to another project's. The load hooks read the path it names without following a link.
      preserveSymlinks: true,
    },
    // Several Cadence servers (tests, CLI renders) may run side by side: each can get its own dependency cache.
    ...(cacheDir ? { cacheDir } : {}),
    optimizeDeps: {
      entries: ['index.html', 'frame.html'],
      // Brand kits are imported dynamically, out of sight of `entries`: the icon sets of the brands already here are
      // bundled now, so their first import never waits for one. A brand built later gets its own on first import, which
      // pages already open take in their stride (one React). Bundling every set always made a cold start 0.9 s instead
      // of 0.2 s, and 983 MB of memory instead of 509.
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'lucide-react',
        'clsx',
        ...(await brandIconSets(config.brandsDir)),
      ],
    },
    // Else each file compiles with the tsconfig.json found above it, and a project's may extend any JSON file: its
    // compiler options would reach the frame and the diagnostics in the code and the errors Vite gives back.
    tsconfig: path.join(config.root, 'tsconfig.json'),
    // postcss-modules inlines what `composes: ... from` and `@value ... from` name, wherever that file is, out of reach
    // of compileStylesheet's checks: a `.module.css` compiles as plain CSS. postcss reads the `.map` file a stylesheet
    // names, even in a string, through any link and with a read that waits forever on a pipe: it reads no map.
    css: { modules: false, postcss: { map: false } },
    // Vite reads an SVG a URL names to inline it as a data: URL, through any link: it reads it still, inlines it never.
    build: { assetsInlineLimit: 0 },
    plugins: [
      cadencePlugin(managedNames, config),
      cadenceAssets(managedNames),
      react(),
      // The editor's own stylesheets (`npm run dev`); managed ones are compiled by compileStylesheet.
      ...skipManaged(tailwindcss(), managedNames),
    ],
  };
  const server = await createServer(mergeConfig(base, overrides) as InlineConfig);
  // Vite's file servers follow links: a managed file swapped for one after frameReach's check would be served.
  const stack = server.middlewares.stack;
  const rawFs = stack.findIndex(({ handle }) => typeof handle === 'function' && handle.name === 'viteServeRawFsMiddleware');
  if (rawFs < 0)
    throw new Error("Vite's raw file middleware (viteServeRawFsMiddleware) is gone: managed files would be served by it");
  stack.splice(rawFs, 0, { route: '', handle: serveManagedFile(server, managedNames) });
  // Vite watches its root only: managed dirs a host app keeps elsewhere are added, so an edit made from a terminal
  // session or by hand reaches ProjectStore.watch() there too.
  server.watcher.add(managed.filter((dir) => !isInside(config.root, dir)));
  return server;
}

/** Renders, soundtracks, trashed projects, staged imports: by path rather than glob, so it holds wherever the dirs live. */
function pilesUp({ projectsDir, brandsDir }: CadenceConfig, file: string): boolean {
  if (isInside(brandsDir, file)) return path.relative(brandsDir, file).split(path.sep)[0] === '.import';
  if (!isInside(projectsDir, file)) return false;
  const [project, folder] = path.relative(projectsDir, file).split(path.sep);
  return project === '.trash' || project === '.import' || folder === 'renders' || folder === 'music';
}

const ICON_SET = /['"](@heroicons\/react\/\d+\/(?:solid|outline)|@tabler\/icons-react)['"]/g;

/** The heavy icon sets the brands import, read from their code. */
async function brandIconSets(brandsDir: string): Promise<string[]> {
  const sets = new Set<string>();
  for (const file of await fs.readdir(brandsDir, { recursive: true }).catch(() => [] as string[])) {
    if (!/\.[jt]sx?$/.test(file)) continue;
    for (const [, set] of (await fs.readFile(path.join(brandsDir, file), 'utf8')).matchAll(ICON_SET)) sets.add(set);
  }
  return [...sets].sort();
}

// Only infra that never holds a managed stylesheet; an import that reaches into it is refused (importsOtherThanCss),
// whoever wrote the file there.
const SKIP_WALK = new Set(['.git']);

/**
 * What an archive may not bring under `dirs`: a stylesheet that carries `@plugin` or `@config` or imports what is not a
 * managed .css file or a package, and the node_modules and package.json (isResolverInput) beside a stylesheet.
 * compileStylesheet refuses the first and never reads the others. `brandsDir` is where the `@brands` alias points.
 * `moves` maps a staging folder to the folder it is about to be moved into: a stylesheet's path imports are then read
 * from where it lands, and what they reach under a destination is looked up in the staging folder too.
 */
export async function cssCodeOffenders(
  dirs: string[],
  brandsDir: string,
  moves: [staged: string, target: string][] = [],
): Promise<string[]> {
  const offenders: string[] = [];
  const roots = await Promise.all(
    [...dirs, ...moves.map(([, target]) => target)].map((dir) => fs.realpath(dir).catch(() => dir)),
  );
  // Where the walk reads every stylesheet: a destination of `moves` is walked by the frame build before any compile.
  const scanned = (real: string) =>
    roots.some(
      (root) =>
        isInside(root, real) &&
        path
          .relative(root, real)
          .split(path.sep)
          .every((s) => !SKIP_WALK.has(s)),
    );
  /** Whether the folder holds a stylesheet, at any depth. */
  const walk = async (dir: string): Promise<boolean> => {
    const reachable: string[] = [];
    let styled = false;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(dir, entry.name);
      if (isResolverInput(entry.name)) reachable.push(child);
      if (entry.isDirectory()) {
        if (!SKIP_WALK.has(entry.name) && (await walk(child))) styled = true;
      } else if (foldName(entry.name).endsWith('.css')) {
        // A case-insensitive disk opens `a.CSS` for a request of `a.css`.
        styled = true;
        const scan = new CssCodeScan();
        const text = scan.push(await fs.readFile(child, 'utf8').catch(() => ''));
        if (scan.end() || (await importsOtherThanCss(child, text, { brandsDir, moves, scanned }))) offenders.push(child);
      }
    }
    if (styled) offenders.push(...reachable);
    return styled;
  };
  await Promise.all(dirs.map(walk));
  return offenders.sort();
}

// The lookahead consumes nothing, so a string holding `@import "` cannot swallow the import that follows it.
const CSS_IMPORT = /@(?:import|reference)(?=\s*("[^"]*"|'[^']*'))/gi;

/**
 * compileStylesheet reads a path import as CSS whatever its extension; an archive's stylesheet may carry only what it
 * will compile from where it lands. So only two kinds of import pass. A package name, which
 * resolves to the app's node_modules (one under the managed dirs is refused by the walk). A path (`./`, `../`, `/`) or
 * the `@brands` alias, which must name a .css file the walk reads: not a folder, not a link to another kind of file, not
 * under `.git` or a linked folder that leads out of the managed dirs.
 */
async function importsOtherThanCss(
  file: string,
  text: string,
  { brandsDir, moves, scanned }: { brandsDir: string; moves: [string, string][]; scanned: (real: string) => boolean },
): Promise<boolean> {
  const from = path.dirname(relocate(file, moves));
  for (const [, quoted] of text.matchAll(CSS_IMPORT)) {
    const uri = quoted.slice(1, -1);
    const alias = uri === '@brands' || uri.startsWith('@brands/');
    if (!alias && !/^[./]/.test(uri)) {
      if (PACKAGE.test(uri)) continue;
      return true;
    }
    if (/[?#]/.test(uri)) return true;
    const resolved = alias ? path.join(brandsDir, uri.slice('@brands'.length)) : path.resolve(from, uri);
    const staged = relocate(
      resolved,
      moves.map(([stage, target]) => [target, stage]),
    );
    for (const candidate of new Set([resolved, staged])) {
      // Missing: Tailwind cannot open it either.
      const real = await fs.realpath(candidate).catch(() => null);
      if (!(real ?? candidate).endsWith('.css')) return true;
      if (real && (!scanned(real) || (await fs.stat(real)).isDirectory())) return true;
    }
  }
  return false;
}

const CSS_AT_IMPORT = /@(?:import|reference)\s*(?:url\(\s*)?("[^"]*"|'[^']*'|[^\s'";)]+)/gi;
const CSS_URL = /url\(\s*("[^"]*"|'[^']*'|(?:\\.|[^'")\\])+)\s*\)/gi;
const CSS_IMAGE_SET = /image-set\(([^;}]*)/gi;
const CSS_STRING = /"[^"]*"|'[^']*'/g;

const OUTSIDE = "is outside this stylesheet's project, brand and the templates";
// Features.Utilities: a const enum, which isolatedModules cannot read from Tailwind's declaration file.
const UTILITIES = 16;
const { Scanner } = createRequire(import.meta.url)('@tailwindcss/oxide') as typeof import('@tailwindcss/oxide');

/**
 * Compile a stylesheet of a project, a brand or the templates, Tailwind reading no file itself. What it imports is read
 * here without following a link: a file of its home (cssHome) or a package of the app. Its classes come from the files
 * of that home, and a brand theme compiled for a project (`project=<id>`) takes that project's too. No module runs
 * (`@plugin`, `@config`), and no url() leaves the home or asks to be inlined: Vite would read that file through any link.
 */
async function compileStylesheet(
  code: string,
  id: string,
  config: CadenceConfig,
  resolvePackage: (id: string) => Promise<string | undefined>,
): Promise<string> {
  const file = id.replace(/[?#].*$/, '');
  const entry = await realPath(file);
  const entryDir = path.dirname(entry);
  const home = (await cssHome(file, config)) ?? [];
  const projects = new Set(new URLSearchParams(id.slice(file.length)).getAll('project'));
  if (projects.size > 1) throw new Error(`${file}: compiled for more than one project`);
  let scanned = home;
  for (const project of projects) {
    const own = ID_PATTERN.test(project) ? await homeOf(path.join(config.projectsDir, project, 'project.json'), config) : null;
    if (!own?.some((dir) => isInside(dir, entry)))
      throw new Error(`${file}: compiled for ${project}, not a project of this brand`);
    scanned = [...own, await realDir(config.templatesDir)];
  }
  await assertLinksStayHome(file, code, [entryDir], home, config);
  const nodeModules = await realDir(path.join(config.root, 'node_modules'));
  const compiler = await compile(code, {
    base: entryDir,
    loadModule: async (module) => {
      throw new Error(`${file}: a stylesheet runs no module here (${module})`);
    },
    loadStylesheet: async (imported, base) => {
      const fromPackage = isInside(nodeModules, base);
      const alias = imported === '@brands' || imported.startsWith('@brands/');
      let real: string;
      let content: string;
      if (!fromPackage && (alias || /^[./]/.test(imported))) {
        const named = alias ? path.join(config.brandsDir, imported.slice('@brands'.length)) : path.resolve(base, imported);
        real = await realPath(named).catch(() => '');
        const dir = home.find((dir) => isInside(dir, real));
        if (!dir) throw new Error(`${file}: ${imported} ${OUTSIDE}`);
        content = await readFileNoFollow(dir, real, 'utf8').catch(() => {
          throw new Error(`${file}: ${imported} is not a file`);
        });
        // Its url() are rebased on the entry's folder, where Vite resolves them.
        await assertLinksStayHome(file, content, [path.dirname(real), entryDir], home, config);
      } else {
        const named = fromPackage && /^\.\.?\//.test(imported) ? path.resolve(base, imported) : await resolvePackage(imported);
        real = named ? await realPath(named).catch(() => '') : '';
        if (!isInside(nodeModules, real)) throw new Error(`${file}: ${imported} cannot be followed here`);
        content = await fs.readFile(real, 'utf8');
      }
      return { path: real, base: path.dirname(real), content: rebaseUrls(content, path.dirname(real), entryDir) };
    },
  });
  const css = compiler.build(compiler.features & UTILITIES ? await candidatesIn(scanned) : []);
  // Tailwind leaves an `@import url()` or a remote one to the browser.
  if (/@import\b/i.test(css)) throw new Error(`${file}: only a file of its own or a package can be imported here`);
  for (const [ref] of cssReferences(css)) {
    if (/^(?:data|https?):|^\/\//i.test(ref)) continue;
    let decoded: string[] = [];
    try {
      decoded = [ref, decodeURI(ref), decodeURIComponent(ref)];
    } catch {}
    // Vite inlines such a file, which it reads through any link.
    if (!decoded.length || decoded.some((s) => /[?&]inline\b/i.test(s)))
      throw new Error(`${file}: ${ref} cannot be followed here`);
  }
  return css;
}

/** Refuse a url() of `text` that names a file outside `home`, read from any of `dirs`, or that no path check can follow. */
async function assertLinksStayHome(
  file: string,
  text: string,
  dirs: string[],
  home: string[],
  config: CadenceConfig,
): Promise<void> {
  for (const [ref, imported] of cssReferences(text)) {
    if (imported) continue;
    const files = await referencedFiles(ref, dirs, config);
    if (!files) throw new Error(`${file}: ${ref} cannot be followed here`);
    for (const candidate of files) {
      const real = await realPath(candidate).catch(() => '');
      const outside = !home.some((dir) => isInside(dir, real)) || (await fs.stat(real).catch(() => null))?.isDirectory();
      if (outside) throw new Error(`${file}: ${ref} ${OUTSIDE}`);
    }
  }
}

const SCANNED = /\.(?:[cm]?[jt]sx?|json|mdx?|html?|svg|txt)$/i;
const NOT_SCANNED = new Set(['.git', '.cadence', 'node_modules']);
// ponytail: a bigger file (a log, a data dump) gives no class and is never read; scan it in chunks if one ever must.
const SCAN_LIMIT = 1 << 20;

/** The class candidates of the files under `dirs`, read without following a link. */
async function candidatesIn(dirs: string[]): Promise<string[]> {
  const files: { content: string; extension: string }[] = [];
  const walk = async (root: string, dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_SCANNED.has(entry.name)) await walk(root, child);
      } else if (entry.isFile() && SCANNED.test(entry.name)) {
        const content = await openFileNoFollow(root, child).then(
          async (handle) => {
            try {
              return (await handle.stat()).size <= SCAN_LIMIT ? await handle.readFile('utf8') : null;
            } finally {
              await handle.close();
            }
          },
          () => null,
        );
        if (content !== null) files.push({ content, extension: path.extname(entry.name).slice(1) });
      }
    }
  };
  await Promise.all(dirs.map((dir) => walk(dir, dir)));
  return new Scanner({ sources: [] }).scanFiles(files);
}

// @tailwindcss/node's, which rebases the url() of a stylesheet it inlines; `compile` alone leaves them as written.
const CSS_URL_TOKEN = /(?<!@import\s+)(?<=^|[^\w\-\u0080-\uffff])url\((\s*('[^']+'|"[^"]+")\s*|[^'")]+)\)/g;

/** The relative url() of a stylesheet read from `from`, made relative to `to` as @tailwindcss/node does. */
function rebaseUrls(css: string, from: string, to: string): string {
  if (from === to) return css;
  return css.replace(CSS_URL_TOKEN, (token, inner: string) => {
    let url = inner.trim();
    let quote = url[0] === '"' || url[0] === "'" ? url[0] : '';
    if (quote) url = url.slice(1, -1);
    if (/^([a-z]+:)?\/\/|^\s*data:/i.test(url) || !/^[.\w]/.test(url) || /^[A-Z_][.\w-]*\(/i.test(url) || url.startsWith('/')) {
      return token;
    }
    let rebased = path.posix.relative(to, path.posix.join(from, url));
    if (!rebased.startsWith('.')) rebased = `./${rebased}`;
    if (!quote && rebased !== encodeURI(rebased)) quote = '"';
    if (quote === "'" && rebased.includes("'")) quote = '"';
    if (quote === '"') rebased = rebased.replace(/(?<!\\)"/g, '\\"');
    return `url(${quote}${rebased}${quote})`;
  });
}

/** The folders a stylesheet may import and link from: its home and the templates; null outside them. */
async function cssHome(file: string, config: CadenceConfig): Promise<string[] | null> {
  const templates = await realDir(config.templatesDir);
  if (isInside(config.templatesDir, file) || isInside(templates, file)) return [templates];
  const home = await homeOf(file, config);
  return home && [...home, templates];
}

const realDirs = new Map<string, Promise<string>>();
/** The real path of a configured folder: they stay put while the server runs, and every frame request needs them. */
function realDir(dir: string): Promise<string> {
  if (!realDirs.has(dir)) realDirs.set(dir, realPath(dir));
  return realDirs.get(dir)!;
}

/**
 * The real folders of the project or brand that holds `file`, a project's brand folder too; null outside the projects
 * and brands. By where `file` is named, not where a link on its way leads.
 */
export async function homeOf(file: string, config: CadenceConfig): Promise<string[] | null> {
  const [projects, brands] = await Promise.all([config.projectsDir, config.brandsDir].map(realDir));
  const top = (dir: string, real: string) => {
    const from = isInside(dir, file) ? dir : isInside(real, file) ? real : null;
    return from && path.join(real, path.relative(from, file).split(path.sep)[0]);
  };
  const brand = top(config.brandsDir, brands);
  if (brand) return [brand];
  const project = top(config.projectsDir, projects);
  if (!project) return null;
  const brandId = await brandOf(project);
  return [project, ...(typeof brandId === 'string' && ID_PATTERN.test(brandId) ? [path.join(brands, brandId)] : [])];
}

const projectBrands = new Map<string, { stamp: string; brand: Promise<unknown> }>();
/**
 * The `brand` of a project's project.json, read again only once the file changed: every module of a frame asks, and
 * the file grows with the project's voice-over.
 */
async function brandOf(project: string): Promise<unknown> {
  const file = path.join(project, 'project.json');
  const stat = await fs.lstat(file).catch(() => null);
  const stamp = stat ? `${stat.ino} ${stat.size} ${stat.mtimeMs} ${stat.ctimeMs}` : '';
  let cached = projectBrands.get(project);
  if (cached?.stamp !== stamp) {
    const brand = readFileNoFollow(project, file, 'utf8')
      .then((text) => (JSON.parse(text) as { brand?: unknown }).brand ?? DEFAULT_BRAND)
      .catch(() => null);
    projectBrands.set(project, (cached = { stamp, brand }));
  }
  return cached.brand;
}

/**
 * What a frame of the project or brand that holds `entry` may load: what is in its home (homeOf) and, outside the
 * projects and brands, what Vite serves at all (app, packages, templates). By the real path, so a link leads nowhere
 * its target may not. What exists must be a regular file: for a folder Vite would answer with a file it picks inside
 * (an index, a package.json entry), and its read of a pipe would wait for a writer. A missing file is Vite's 404.
 */
export async function frameReach(
  vite: ViteDevServer,
  config: CadenceConfig,
  entry: string,
): Promise<(file: string) => Promise<boolean>> {
  const home = (await homeOf(entry, config)) ?? [];
  const [projects, brands, ...served] = await Promise.all(
    [config.projectsDir, config.brandsDir, ...vite.config.server.fs.allow].map(realDir),
  );
  return async (file) => {
    const real = await realPath(file).catch(() => null);
    const stat = real && (await fs.stat(real).catch(() => null));
    if (!real || (stat && !stat.isFile())) return false;
    const within = (dir: string) => dir === real || isInside(dir, real);
    return home.some((dir) => isInside(dir, real)) || (!within(projects) && !within(brands) && served.some(within));
  };
}

/** Each file reference of a stylesheet, and whether it is imported (@import, @reference) rather than linked. */
function* cssReferences(text: string): Generator<[ref: string, imported: boolean]> {
  const unquote = (s: string) => (/^(["']).*\1$/s.test(s) ? s.slice(1, -1) : s.trim());
  for (const css of new Set([text, text.replace(/\/\*[\s\S]*?\*\//g, '')])) {
    for (const [, ref] of css.matchAll(CSS_AT_IMPORT)) yield [unquote(ref), true];
    for (const [, ref] of css.matchAll(CSS_URL)) yield [unquote(ref.trim()), false];
    for (const [, set] of css.matchAll(CSS_IMAGE_SET)) for (const [ref] of set.matchAll(CSS_STRING)) yield [unquote(ref), false];
  }
}

/**
 * The files `ref` may name from a stylesheet resolved against `dirs`: with and without its query or fragment, as is and
 * decoded, as Vite and Tailwind may each read it. Empty for what names no file (an external URL, a fragment); null for
 * what no path check can follow (another scheme, a backslash, a package name with dot segments).
 */
async function referencedFiles(ref: string, dirs: string[], config: CadenceConfig): Promise<string[] | null> {
  if (!ref || ref.startsWith('#')) return [];
  if (/^(?:data|https?):|^\/\//i.test(ref)) return [];
  let decoded: string[];
  try {
    decoded = [ref, decodeURI(ref), decodeURIComponent(ref)];
  } catch {
    return null;
  }
  const files: string[] = [];
  for (const variant of new Set(decoded.flatMap((s) => [s, s.replace(/#.*$/s, ''), s.replace(/[?#].*$/s, '')]))) {
    if (!variant || /^[a-z][a-z0-9+.-]*:|[\\\0]/i.test(variant)) return null;
    if (variant === '@brands' || variant.startsWith('@brands/')) {
      files.push(path.join(config.brandsDir, variant.slice('@brands'.length)));
    } else if (variant.startsWith('/')) {
      files.push(path.join(config.root, variant), variant);
    } else {
      // A package name resolves from the app's node_modules, where dot segments would climb back to the managed dirs.
      const bare = !variant.startsWith('.');
      if (bare && !PACKAGE.test(variant.replace(/[?#].*$/s, ''))) return null;
      for (const dir of dirs) {
        const file = path.resolve(dir, variant);
        // Relative first, as CSS reads it; a package name that names nothing here is the package.
        if (!bare || (await fs.lstat(file).catch(() => null))) files.push(file);
      }
    }
  }
  return files;
}

/** `file` under the first `from` folder that holds it, moved under its `to`. */
function relocate(file: string, moves: [from: string, to: string][]): string {
  const move = moves.find(([from]) => isInside(from, file));
  return move ? path.join(move[1], path.relative(move[0], file)) : file;
}

const GENERATION_PARAM = /([?&])g=[^&]*&?/;

/**
 * Project, brand and template files are reloaded by Cadence (see ProjectStore.syncCode), never by Vite's HMR, and their
 * stylesheets are compiled by compileStylesheet.
 *
 * Frames import scenes and brands with `?g=<generation>` so the browser loads each generation afresh. Vite keeps one
 * module per file anyway: a new `?g=` URL resolves to the plain id and re-transforms it. One module per generation
 * would keep every generation's module alive.
 */
function cadencePlugin(managedNames: string[], config: CadenceConfig): Plugin {
  const isManaged = (file: string) => Boolean(rootOf(managedNames, file));
  let resolveCss: ReturnType<typeof createIdResolver>;
  return {
    name: 'cadence',
    enforce: 'pre',
    config: () => ({
      optimizeDeps: {
        rolldownOptions: {
          plugins: [
            {
              name: 'cadence:deps',
              // The dependency optimizer bundles a package with what it imports, read with none of the frame's checks,
              // and an alias or a link can still lead it to a managed file.
              load(id) {
                if (isManaged(id.replace(/[?#].*$/, ''))) {
                  throw new Error(`The dependency optimizer reads no project, brand or template file: ${id}`);
                }
                return null;
              },
            },
          ],
        },
      },
    }),
    configResolved(resolved) {
      // Vite's own resolver for CSS imports, from the app's packages only (see resolveId).
      resolveCss = createIdResolver(resolved, {
        extensions: ['.css'],
        mainFields: ['style'],
        conditions: ['style', 'development|production'],
        tryIndex: false,
        preferRelative: false,
      });
      // Vite shows the lines around a postcss error from the file the error names, read again through any link. Without
      // that name, it shows them from the CSS this plugin compiled.
      const css = resolved.plugins.find(({ name }) => name === 'vite:css');
      if (!css?.transform) throw new Error("Vite's CSS plugin (vite:css) is gone: its errors would show a linked file");
      const hook = typeof css.transform === 'function' ? { handler: css.transform } : css.transform;
      css.transform = {
        ...hook,
        async handler(code, id, options) {
          try {
            return await hook.handler.call(this, code, id, options);
          } catch (error) {
            const { loc } = error as { loc?: { file?: string } };
            if (loc && isManaged(id.replace(/[?#].*$/, ''))) delete loc.file;
            throw error;
          }
        },
      };
    },
    async resolveId(source, importer, options) {
      // Vite looks a package up from the importer's folder, and its dependency optimizer bundles what that package
      // imports with none of the frame's checks: a managed file gets the packages the runtime gets.
      if (importer && /^[\w@#]/.test(source) && isManaged(importer.replace(/[?#].*$/, ''))) {
        const resolved = await this.resolve(source, path.join(config.root, 'src/runtime/index.ts'), {
          ...options,
          skipSelf: true,
        });
        // Else the plugins after this one would look it up from the importer's folder.
        return resolved ?? this.error(`Failed to resolve import "${source}": not a package of the app`);
      }
      if (!GENERATION_PARAM.test(source)) return null;
      const resolved = await this.resolve(source.replace(GENERATION_PARAM, '$1').replace(/[?&]$/, ''), importer, {
        ...options,
        skipSelf: true,
      });
      // Vite remembers the module of each URL it resolved, so this only runs for an unseen URL: a new generation.
      const graph = (this.environment as DevEnvironment).moduleGraph;
      const mod = resolved && graph?.getModuleById(resolved.id);
      if (mod) graph.invalidateModule(mod);
      return resolved;
    },
    load: {
      // Last, so only for a file no other plugin loads. Vite would read it through any link, then fill the map a
      // `sourceMappingURL` comment names with every file its `sources` list, wherever they are, and serve that too.
      order: 'post',
      async handler(id) {
        const file = id.replace(/[?#].*$/, '');
        const root = rootOf(managedNames, file);
        if (!root || !isFileLoadingAllowed(this.environment.getTopLevelConfig(), file)) return null;
        return { code: await readFileNoFollow(root, file, 'utf8'), map: null };
      },
    },
    hotUpdate({ file }) {
      if (isManaged(file)) return [];
    },
    async transform(code, id) {
      // HMR is off, yet in middleware mode Vite's client still dials ws://<host>:24678: an uncaught error on every
      // page, or another app's dev server. A string patch: if Vite renames the call, only that error comes back.
      if (id.endsWith('/vite/dist/client/client.mjs')) return code.replace(VITE_CLIENT_CONNECT, '');
      // What Vite's CSS plugin compiles after this one: a query ending in `.css` makes it compile a file of any kind.
      const file = id.replace(/[?#].*$/, '');
      if (!isCSSRequest(id) || SPECIAL_QUERY.test(id) || !isManaged(file)) return;
      if (!file.endsWith('.css')) throw new Error(`Only a .css file is compiled as CSS here: ${file}`);
      const runtime = path.join(config.root, 'src/runtime/index.ts');
      const resolvePackage = (imported: string) => resolveCss(this.environment, imported, runtime);
      return { code: await compileStylesheet(code, id, config, resolvePackage), map: null };
    },
  };
}

// Vite's SPECIAL_QUERY_RE: a `?raw`, `?url` or worker import of a stylesheet is no stylesheet.
const SPECIAL_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;
const RAW_QUERY = /[?&]raw(?:&|$)/;
const INLINE_QUERY = /[?&]inline\b/;
// Vite's urlRE: with `inline`, its asset plugin reads any file into a data: URL, whatever the extension.
const URL_QUERY = /[?&]url(?:&|$)/;
// Vite's wasmDirectRE and wasmInstanceRE: its wasm plugin reads such a module through any link, for its import and export
// names. A module's `?url` and `?init` only give its URL.
const WASM_MODULE = /(?<![?#].*)\.wasm$|[?&]vite-wasm-instance(?:&|$)/;

/**
 * The managed folder (by the name it is reached under) that holds `file`. Compared folded: a file system that ignores
 * case or normalization (macOS) reaches the folder under other names too, which frameReach's real paths let through. The
 * no-follow reads then refuse such a name, since it is not inside the folder's own.
 */
function rootOf(managedNames: string[], file: string): string | undefined {
  return managedNames.find((dir) => isInside(foldName(dir), foldName(file)));
}

/**
 * `?raw`, `?inline` and `?url&inline` imports of a project, brand or template file, which Vite reads through any link:
 * read here without following one. A stylesheet's `?inline` is its compiled CSS (cadencePlugin's transform). An svg
 * gets Vite's dev URL without the read Vite makes to inline it, which `assetsInlineLimit: 0` never does. A WebAssembly
 * module is refused, its URL is not.
 */
function cadenceAssets(managedNames: string[]): Plugin {
  return {
    name: 'cadence:assets',
    enforce: 'pre',
    async load(id) {
      const file = id.replace(/[?#].*$/, '');
      const root = rootOf(managedNames, file);
      if (root && WASM_MODULE.test(id)) throw new Error(`A WebAssembly module loads here by its URL only (?url, ?init): ${file}`);
      const config = this.environment.getTopLevelConfig();
      if (!root || !isFileLoadingAllowed(config, file)) return null;
      let value: string;
      if (RAW_QUERY.test(id)) value = await readFileNoFollow(root, file, 'utf8');
      else if (INLINE_QUERY.test(id) && (URL_QUERY.test(id) || config.assetsInclude(file))) {
        value = `data:${contentType(file)};base64,${(await readFileNoFollow(root, file)).toString('base64')}`;
      } else if (file.endsWith('.svg')) {
        value = path.posix.join(config.base, isInside(config.root, file) ? path.relative(config.root, file) : `@fs${file}`);
      } else return null;
      return { code: `export default ${JSON.stringify(value)}`, map: { mappings: '' }, moduleType: 'js' };
    },
  };
}

/** `plugins` with their transform skipped for a project, brand or template file. */
function skipManaged(plugins: Plugin[], managedNames: string[]): Plugin[] {
  return plugins.map((plugin) => {
    const { transform } = plugin;
    if (!transform) return plugin;
    const hook = typeof transform === 'function' ? { handler: transform } : transform;
    return {
      ...plugin,
      transform: {
        ...hook,
        handler(code, id, options) {
          return rootOf(managedNames, id.replace(/[?#].*$/, '')) ? undefined : hook.handler.call(this, code, id, options);
        },
      },
    };
  });
}

/** The file a request names, as Vite's raw (`/@fs/`) and static file servers read it; null for what they skip. */
function servedFile(url: string, root: string): string | null {
  if (url.startsWith('//')) return null;
  try {
    const pathname = decodeURI(new URL(url, 'http://vite').pathname);
    return path.resolve(root, pathname.startsWith('/@fs/') ? pathname.slice('/@fs'.length) : pathname.slice(1));
  } catch {
    return null;
  }
}

/** A project, brand or template file Vite's file servers would serve, opened without following a link. */
function serveManagedFile(vite: ViteDevServer, managedNames: string[]) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const file = servedFile(req.url ?? '', vite.config.root);
    const root = file && rootOf(managedNames, file);
    if (!file || !root) return next();
    if (!isFileLoadingAllowed(vite.config, file)) return res.writeHead(403).end();
    const handle = await openFileNoFollow(root, file).catch(() => null);
    if (!handle) return res.writeHead(404).end();
    try {
      const { size } = await handle.stat();
      const range = parseRange(req.headers.range, size);
      res.setHeader('Content-Type', contentType(file));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
      if (range === 'unsatisfiable') return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      const { start, end } = range ?? { start: 0, end: size - 1 };
      res.writeHead(range ? 206 : 200, {
        'Content-Length': size && end - start + 1,
        ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
      });
      if (req.method === 'HEAD' || !size) return res.end();
      await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(404).end();
    } finally {
      await handle.close();
    }
  };
}

const VITE_CLIENT_CONNECT = 'transport.connect(createHMRHandler(handleMessage));';

let lastTimestamp = 0;

/**
 * Drop Vite's cached transforms for every module under `dirs` and stamp them (and their importers) with a fresh HMR
 * timestamp: modules that import them then get a new `?t=` URL, so the next import in the browser is fresh.
 */
export function invalidateDirs(vite: ViteDevServer, dirs: string[]): void {
  const graph = vite.environments.client.moduleGraph;
  // Strictly increasing: two syncs in the same millisecond must still produce distinct URLs.
  const timestamp = (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));
  const seen = new Set<EnvironmentModuleNode>();
  for (const mod of graph.idToModuleMap.values()) {
    if (mod.file && dirs.some((dir) => isInside(dir, mod.file!))) graph.invalidateModule(mod, seen, timestamp, true);
  }
}

/**
 * Compile a file and the local files it imports through Vite's pipeline; returns the first error (message + code
 * frame, no ANSI colors) or null. The browser only says "Failed to fetch dynamically imported module". A file the frame
 * may not load (`readable`) is reported, not compiled.
 */
export async function diagnoseFile(
  vite: ViteDevServer,
  file: string,
  readable: (file: string) => Promise<boolean>,
): Promise<string | null> {
  const env = vite.environments.client;
  const seen = new Set<string>();
  const visit = async (url: string, file: string): Promise<string | null> => {
    if (seen.has(url)) return null;
    seen.add(url);
    if (!(await readable(file))) return m().api.frames.notServed(file);
    try {
      await env.transformRequest(url);
    } catch (e) {
      const err = e as { message?: string; frame?: string };
      // Without the terminal colors Vite puts in its code frame.
      return [err.message, err.frame]
        .filter(Boolean)
        .join('\n')
        .replace(/\u001b\[[0-9;]*m/g, '');
    }
    const mod = await env.moduleGraph.getModuleByUrl(url);
    for (const dep of mod?.importedModules ?? []) {
      if (dep.type !== 'js' || !dep.file || dep.file.includes('/node_modules/')) continue;
      const error = await visit(dep.url, dep.file);
      if (error) return error;
    }
    return null;
  };
  return visit(`/@fs${file}`, file);
}
