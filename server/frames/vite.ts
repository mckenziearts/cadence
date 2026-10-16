// The one Vite dev server (middleware mode): frame modules (runtime, brands, scenes) on the frame origin, and the editor's
// own modules with `npm run dev` (server/editor.ts). Cadence reloads frames itself, so HMR is off.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import fs from 'node:fs/promises';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {
  createServer,
  isFileLoadingAllowed,
  mergeConfig,
  type DevEnvironment,
  type EnvironmentModuleNode,
  type InlineConfig,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import { ID_PATTERN } from '../../src/shared/types';
import type { CadenceConfig } from '../contracts';
import { m } from '../i18n';
import { DEFAULT_BRAND } from '../store/brands';
import { CssCodeScan, foldName, isInside, isResolverInput, readFileNoFollow, realPath } from '../util';

export async function createVite({
  config,
  overrides = {},
}: {
  config: CadenceConfig;
  /** Tests only: e.g. a stub `cadence` runtime and an isolated dependency cache. */
  overrides?: InlineConfig;
}): Promise<ViteDevServer> {
  const managed = [config.projectsDir, config.brandsDir, config.templatesDir];
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
          // Vite names a module by the real path its import resolved to, so a dir reached through a link (`/var` on
          // macOS) is allowed under both names.
          ...new Set([...managed, ...(await Promise.all(managed.map(realPath)))]),
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
    // of assertCssStaysHome: a `.module.css` compiles as plain CSS.
    css: { modules: false },
    plugins: [cadencePlugin(managed, config), react(), tailwindcss()],
  };
  const server = await createServer(mergeConfig(base, overrides) as InlineConfig);
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
// whoever wrote the file there. Everything else is read:
// Tailwind inlines @import itself and honours neither this set nor Vite's server.fs rules, so a @plugin in any
// import-reachable .css runs code at compile time. A name-based skip of e.g. `renders` was a bypass, because a dir
// named `renders` under the agent-writable components/ is import-reachable (components/renders/evil.css).
const SKIP_WALK = new Set(['.git']);
// What a bare or `#` specifier resolves through (isResolverInput): Tailwind's fallback resolver (enhanced-resolve)
// follows node_modules and package.json `imports` to a file of any extension, which the walk never reads. It looks for
// them only in the folders above the importing stylesheet: one in a folder holding no stylesheet is out of its reach.
// No project, brand or template needs either, archives leave them out, and outside the managed dirs only the app's own
// are found.

/**
 * Refuse any CSS under the managed dirs that carries `@plugin` or `@config`: Tailwind would load and run that module
 * in this process when it compiles. The whole subtree is scanned (not just the imported entry) because Tailwind
 * resolves @import itself, so a leaf reached through @import hops, in any directory, would otherwise slip past. CSS
 * compiles are infrequent (brand themes, scene-imported CSS), so walking the managed dirs each time stays cheap.
 */
export async function assertNoCssCodeExec(managedDirs: string[], brandsDir: string): Promise<void> {
  const offenders = await cssCodeOffenders(managedDirs, brandsDir);
  if (offenders.length) {
    throw new Error(
      `CSS @plugin/@config runs code at build time and is not allowed here, nor node_modules or package.json, through which an @import reaches unchecked files:\n${offenders.join('\n')}`,
    );
  }
}

/**
 * The files and folders under `dirs` that assertNoCssCodeExec refuses. `brandsDir` is where the `@brands` alias points.
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
// `tailwindcss`, `@fontsource-variable/inter/standard.css`: no scheme, query, fragment or dot segment.
const PACKAGE = /^(@[\w-][\w.-]*\/)?[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;

/**
 * Tailwind reads what a stylesheet imports as CSS whatever its extension, and its fallback resolver opens more than
 * Vite would (`file:` URLs, `?` and `#` as part of a file name). So only two kinds of import pass. A package name, which
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

/**
 * Refuse a stylesheet of a project, a brand or the templates that imports or links a file outside its home: its own
 * folder, its project's brand, the templates, and packages by name. Tailwind inlines what @import and @reference name,
 * and Vite what url() names with `?inline`, wherever that file is: a project's stylesheet would otherwise carry another
 * project's or brand's files into its frame. Compared by real path; an imported stylesheet is read in turn.
 */
export async function assertCssStaysHome(entry: string, config: CadenceConfig): Promise<void> {
  const home = await cssHome(entry, config);
  if (!home) return;
  const dirs = [path.dirname(await realPath(entry))];
  const seen = new Set<string>();
  const read = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [ref, imported] of cssReferences(await fs.readFile(file, 'utf8'))) {
      // Tailwind rebases the url() of what it inlines on the entry's folder.
      const files = await referencedFiles(ref, imported, [path.dirname(file), ...dirs], config);
      if (!files) throw new Error(`${file}: ${ref} cannot be followed here`);
      for (const candidate of files) {
        const real = await realPath(candidate).catch(() => null);
        const stat = real ? await fs.stat(real).catch(() => null) : null;
        if (!real || !home.some((dir) => isInside(dir, real)) || stat?.isDirectory() || (imported && !stat?.isFile())) {
          throw new Error(`${file}: ${ref} is outside this stylesheet's project, brand and the templates`);
        }
        if (imported) await read(real);
      }
    }
  };
  await read(await realPath(entry));
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
 * projects and brands, what Vite serves at all (app, packages, templates). Through links, as Vite reads it. A folder
 * never: Vite would answer with a file it picks inside (an index, a package.json entry).
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
    if (!real || (await fs.stat(real).catch(() => null))?.isDirectory()) return false;
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
async function referencedFiles(ref: string, imported: boolean, dirs: string[], config: CadenceConfig): Promise<string[] | null> {
  if (!ref || ref.startsWith('#')) return imported ? null : [];
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
 * Project, brand and template files are reloaded by Cadence (see ProjectStore.syncCode), never by Vite's HMR.
 *
 * Frames import scenes and brands with `?g=<generation>` so the browser loads each generation afresh. Vite keeps one
 * module per file anyway: a new `?g=` URL resolves to the plain id and re-transforms it. One module per generation
 * would keep one Tailwind compiler per brand theme per generation alive (about 1 MB each).
 */
function cadencePlugin(managedDirs: string[], config: CadenceConfig): Plugin {
  // Vite names a module by the URL's path, or by its real path once an import resolved it.
  const isManaged = async (file: string) =>
    [...managedDirs, ...(await Promise.all(managedDirs.map(realDir)))].some((dir) => isInside(dir, file));
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
              async load(id) {
                if (await isManaged(id.replace(/[?#].*$/, ''))) {
                  throw new Error(`The dependency optimizer reads no project, brand or template file: ${id}`);
                }
                return null;
              },
            },
          ],
        },
      },
    }),
    async resolveId(source, importer, options) {
      // Vite looks a package up from the importer's folder, and its dependency optimizer bundles what that package
      // imports with none of the frame's checks: a managed file gets the packages the runtime gets.
      if (importer && /^[\w@#]/.test(source) && (await isManaged(importer.replace(/[?#].*$/, '')))) {
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
      // Last, so only for a file no other plugin loads. Vite would read it itself, then fill the map a `sourceMappingURL`
      // comment names with every file its `sources` list, wherever they are, and serve that with the module.
      order: 'post',
      async handler(id) {
        const file = id.replace(/[?#].*$/, '');
        if (id.startsWith('\0') || !(await isManaged(file))) return null;
        if (!isFileLoadingAllowed(this.environment.getTopLevelConfig(), file)) return null;
        const code = await fs.readFile(file, 'utf8').catch(() => null);
        return code === null ? null : { code, map: null };
      },
    },
    hotUpdate({ file }) {
      if (managedDirs.some((dir) => isInside(dir, file))) return [];
    },
    async transform(code, id) {
      // HMR is off, yet in middleware mode Vite's client still dials ws://<host>:24678: an uncaught error on every
      // page, or another app's dev server. A string patch: if Vite renames the call, only that error comes back.
      if (id.endsWith('/vite/dist/client/client.mjs')) return code.replace(VITE_CLIENT_CONNECT, '');
      // `cadence` runs before `@tailwindcss/vite` (see createVite's plugin order), so this throws before Tailwind
      // compiles any CSS that would run code. Tailwind inlines @import itself, so a check on this one file would miss
      // a two-hop @import to @plugin: scan the whole managed set instead.
      const file = id.replace(/[?#].*$/, '');
      if (!COMPILED_AS_CSS.test(id) || !(await isManaged(file))) return;
      if (!file.endsWith('.css')) throw new Error(`Only a .css file is compiled as CSS here: ${file}`);
      await assertNoCssCodeExec(managedDirs, config.brandsDir);
      await assertCssStaysHome(file, config);
    },
  };
}

/**
 * The ids @tailwindcss/vite compiles (its transform filter): a query ending in `.css`, `&lang.css` or `index=<n>.css`
 * makes it compile a file of any extension, which the walk never reads.
 */
const COMPILED_AS_CSS = /\.css(?:\?.*)?$|&lang\.css|[?&]index=\d+\.css$/;

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
