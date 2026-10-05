// The one Vite dev server (middleware mode): frame modules (runtime, brands, scenes) on the frame origin, and the editor's
// own modules with `npm run dev` (server/editor.ts). Cadence reloads frames itself, so HMR is off.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import fs from 'node:fs/promises';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {
  createServer,
  mergeConfig,
  type DevEnvironment,
  type EnvironmentModuleNode,
  type InlineConfig,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import type { CadenceConfig } from '../contracts';
import { CSS_CODE_EXEC, isInside } from '../util';

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
          ...managed,
          path.join(config.root, 'node_modules'),
          ...(cacheDir ? [cacheDir] : []),
        ],
        // Replaces Vite's default list, so its entries are repeated here.
        deny: ['.env*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.cadence/**'],
      },
      // This watcher also feeds ProjectStore.watch(). What only piles up stays out (versions, chats and thumbnails under
      // .cadence/, renders, soundtracks, trashed projects): on Linux each watched file holds an inotify watch.
      watch: {
        ignored: ['**/.cadence/**', (file: string) => pilesUp(config.projectsDir, file)],
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
    plugins: [cadencePlugin(managed), react(), tailwindcss()],
  };
  const server = await createServer(mergeConfig(base, overrides) as InlineConfig);
  // Vite watches its root only: managed dirs a host app keeps elsewhere are added, so an edit made from a terminal
  // session or by hand reaches ProjectStore.watch() there too.
  server.watcher.add(managed.filter((dir) => !isInside(config.root, dir)));
  return server;
}

/** Renders, soundtracks and trashed projects: by path rather than glob, so it holds wherever projectsDir lives. */
function pilesUp(projectsDir: string, file: string): boolean {
  if (!isInside(projectsDir, file)) return false;
  const [project, folder] = path.relative(projectsDir, file).split(path.sep);
  return project === '.trash' || folder === 'renders' || folder === 'music';
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

// Only infra the agent can never write into, and that never holds a managed stylesheet. Everything else is read:
// Tailwind inlines @import itself and honours neither this set nor Vite's server.fs rules, so a @plugin in any
// import-reachable .css runs code at compile time. A name-based skip of e.g. `renders` was a bypass, because a dir
// named `renders` under the agent-writable components/ is import-reachable (components/renders/evil.css).
const SKIP_WALK = new Set(['.git', 'node_modules']);

/**
 * Refuse any CSS under the managed dirs that carries `@plugin` or `@config`: Tailwind would load and run that module
 * in this process when it compiles. The whole subtree is scanned (not just the imported entry) because Tailwind
 * resolves @import itself, so a leaf reached through @import hops, in any directory, would otherwise slip past. CSS
 * compiles are infrequent (brand themes, scene-imported CSS), so walking the managed dirs each time stays cheap.
 */
export async function assertNoCssCodeExec(managedDirs: string[]): Promise<void> {
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        if (!SKIP_WALK.has(entry.name)) await walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.css')) {
        const file = path.join(dir, entry.name);
        if (CSS_CODE_EXEC.test(await fs.readFile(file, 'utf8').catch(() => ''))) offenders.push(file);
      }
    }
  };
  await Promise.all(managedDirs.map(walk));
  if (offenders.length) {
    throw new Error(`CSS @plugin/@config runs code at build time and is not allowed here:\n${offenders.join('\n')}`);
  }
}

const GENERATION_PARAM = /([?&])g=[^&]*&?/;

/**
 * Project, brand and template files are reloaded by Cadence (see ProjectStore.syncCode), never by Vite's HMR.
 *
 * Frames import scenes and brands with `?g=<generation>` so the browser loads each generation afresh. Vite keeps one
 * module per file anyway: a new `?g=` URL resolves to the plain id and re-transforms it. One module per generation
 * would keep one Tailwind compiler per brand theme per generation alive (about 1 MB each).
 */
function cadencePlugin(managedDirs: string[]): Plugin {
  return {
    name: 'cadence',
    enforce: 'pre',
    async resolveId(source, importer, options) {
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
      if (file.endsWith('.css') && managedDirs.some((dir) => isInside(dir, file))) await assertNoCssCodeExec(managedDirs);
    },
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
 * frame, no ANSI colors) or null. The browser only says "Failed to fetch dynamically imported module".
 */
export async function diagnoseFile(vite: ViteDevServer, file: string): Promise<string | null> {
  const env = vite.environments.client;
  const seen = new Set<string>();
  const visit = async (url: string): Promise<string | null> => {
    if (seen.has(url)) return null;
    seen.add(url);
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
      const error = await visit(dep.url);
      if (error) return error;
    }
    return null;
  };
  return visit(`/@fs${file}`);
}
