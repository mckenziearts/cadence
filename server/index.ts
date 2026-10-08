import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import { FileAccountService } from './accounts/accounts';
import { Publisher } from './accounts/publish';
import { ChatManager } from './agent/chat';
import { ClaudeCodeProvider } from './agent/claudeCode';
import { geminiStatus, grokStatus } from './agent/cliAgents';
import { CodexProvider, codexModels } from './agent/codex';
import { RoutingProvider } from './agent/router';
import { writeProjectsGuide } from './agent/guide';
import { createApi } from './api';
import { BrandBuilder } from './brands/build';
import { GitHubSource, GitLabSource } from './brands/source';
import { PlaywrightCapture } from './capture/capture';
import { FfmpegRenderService } from './capture/render';
import { PixelSeamService } from './capture/seams';
import { loadConfig } from './config';
import {
  DEFAULT_FEATURES,
  agentName,
  MODELS,
  type AgentId,
  type Effort,
  type Features,
  type GitHost,
  type ModelSpec,
  type NetworkId,
} from '../src/shared/types';
import type { AgentProvider, BrandSource, CadenceConfig, ElevenLabsApi, HostApi, Network, SpeechEngine } from './contracts';
import { builtEditor, devEditor } from './editor';
import { createFrameHandler } from './frames/frameServer';
import { createVite, diagnoseFile, invalidateDirs } from './frames/vite';
import { createEditorHandler } from './http';
import { isLanguage, m, setLanguage } from './i18n';
import { SseHub } from './hub';
import { createMcpHandler } from './mcp/server';
import { McpTokens } from './mcp/tokens';
import { InstagramNetwork } from './networks/instagram';
import { LinkedInNetwork } from './networks/linkedin';
import { TikTokNetwork } from './networks/tiktok';
import { YouTubeNetwork } from './networks/youtube';
import { LocalMusicService } from './music/service';
import { FileSettingsStore } from './settings';
import { FileAssetStore } from './store/assets';
import { FileBrandStore } from './store/brands';
import { FileProjectStore } from './store/projects';
import { FileTemplateStore } from './store/templates';
import { FileVersionStore } from './store/versions';
import { FileUsageLog } from './usage';
import { randomToken } from './util';
import { ElevenLabsClient } from './voiceover/elevenlabs';
import { PiperEngine } from './voiceover/piper';
import { LocalVoiceOverService } from './voiceover/service';

export type StartOptions = Partial<CadenceConfig> & {
  quiet?: boolean;
  /** `npm run dev`: the editor from Vite's dev server and React's development build, for work on Cadence itself. */
  dev?: boolean;
  /** A host app's folder with its own index.html, built instead of the core's (production build only, not with `dev`). */
  editorRoot?: string;
  provider?: AgentProvider;
  /** Where brand builds get repositories (tests: fakes that never call gh, glab or git). */
  brandSources?: Partial<Record<GitHost, BrandSource>>;
  /** Where « Publier » sends videos (tests: fakes that never reach a network). */
  networks?: Partial<Record<NetworkId, Network>>;
  /** Who speaks voice-overs (tests: a fake that never runs Piper). */
  speech?: SpeechEngine;
  /** Where ElevenLabs voice-overs go (tests: a fake that never reaches the network). */
  elevenLabs?: ElevenLabsApi;
  /** A host app's routes: each entry is served under /api/<name>; a name must be a lowercase slug free in /api. */
  api?: HostApi;
  /** Editor sections a host app hides; a missing key stays on. UI only, see ARCHITECTURE.md "Embedding Cadence". */
  features?: Partial<Features>;
};

export interface Services {
  hub: SseHub;
  brands: FileBrandStore;
  templates: FileTemplateStore;
  store: FileProjectStore;
  settings: FileSettingsStore;
  usage: FileUsageLog;
  vite: ViteDevServer;
  capture: PlaywrightCapture;
  seams: PixelSeamService;
  music: LocalMusicService;
  voiceOver: LocalVoiceOverService;
  renders: FfmpegRenderService;
  versions: FileVersionStore;
  assets: FileAssetStore;
  tokens: McpTokens;
  provider: AgentProvider;
  chats: ChatManager;
  brandBuilds: BrandBuilder;
  accounts: FileAccountService;
  publisher: Publisher;
}

export interface RunningServer {
  /** With the real ports and origins (ports may be 0 in the options). */
  config: CadenceConfig;
  services: Services;
  /** Value of the X-Cadence-Token header mutating API requests need (tests, scripts). */
  editorToken: string;
  close(): Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Start Cadence: both HTTP servers on 127.0.0.1, the Vite dev server and every service. */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const {
    quiet = false,
    dev = false,
    editorRoot,
    provider: customProvider,
    brandSources: customSources,
    networks: customNetworks,
    speech,
    elevenLabs,
    api: hostApi,
    features,
    ...overrides
  } = options;
  if (dev && editorRoot) throw new Error(m().core.editorRootDev);
  // Scene URLs are /@fs<absolute path>, which a Windows path never matches: no scene would load.
  if (process.platform === 'win32') throw new Error(m().core.windows);
  // Vite reads NODE_ENV, and sets it when unset, once per process: set before any Vite call, it decides the React build
  // of the editor bundle and of the frames, whatever the order of the two.
  process.env.NODE_ENV = dev ? 'development' : 'production';
  const initial = loadConfig(overrides);
  for (const dir of [initial.projectsDir, initial.brandsDir, initial.stateDir]) await fs.mkdir(dir, { recursive: true });

  // Listen first (ports may be 0), then build everything that needs the real origins.
  let editorHandler: Handler = unavailable;
  let frameHandler: Handler = unavailable;
  const editorServer = http.createServer((req, res) => editorHandler(req, res));
  const frameServer = http.createServer((req, res) => frameHandler(req, res));
  let vite: ViteDevServer | null = null;
  let store: FileProjectStore | null = null;
  let capture: PlaywrightCapture | null = null;
  try {
    const editorPort = await listen(editorServer, initial.editorPort, initial.host);
    const framePort = await listen(frameServer, initial.framePort, initial.host);
    const config = loadConfig({ ...overrides, editorPort, framePort });

    const hub = new SseHub();
    const brands = new FileBrandStore(config);
    const templates = new FileTemplateStore(config);
    store = new FileProjectStore(config, { templates, brands });
    const settings = new FileSettingsStore(config);
    const usage = new FileUsageLog(config);
    // CADENCE_LANGUAGE (tests, the CLI) wins; else the setting; else whatever the process already speaks.
    const forced = process.env.CADENCE_LANGUAGE;
    const chosen = isLanguage(forced) ? forced : (await settings.get()).language;
    if (chosen) setLanguage(chosen);
    const built = dev ? null : await builtEditor(editorRoot ?? config.root);
    vite = await createVite({ config });
    const editor = built ?? devEditor(vite, config.root);
    capture = new PlaywrightCapture({ config, store });
    const seams = new PixelSeamService({ store, capture, hub });
    const music = new LocalMusicService({ config, store, hub });
    const engine = speech ?? new PiperEngine(config.piperPath);
    const voiceOver = new LocalVoiceOverService({
      config,
      store,
      brands,
      hub,
      engine,
      elevenLabs: elevenLabs ?? new ElevenLabsClient(),
    });
    const renders = new FfmpegRenderService({ config, store, music, voiceOver, hub });
    const versions = new FileVersionStore(store);
    const assets = new FileAssetStore(store, capture);
    const tokens = new McpTokens(config);
    // Key by key rather than a spread: an undefined flag stays on, and a key the editor does not know is not served.
    const activeFeatures = Object.fromEntries(
      Object.entries(DEFAULT_FEATURES).map(([key, on]) => [key, features?.[key as keyof Features] ?? on]),
    ) as Features;
    const claudeCode = new ClaudeCodeProvider(config, agentName('claude-code', activeFeatures));
    const codex = new CodexProvider(config, agentName('codex', activeFeatures));
    // One agent at a time: the Profile picks it, the router sends each turn to it (Claude Code when nothing is selected).
    const provider = customProvider ?? new RoutingProvider({ 'claude-code': claudeCode, codex }, settings, 'claude-code');
    const claudeEfforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    const claudeCatalog: ModelSpec[] = MODELS.map((model) => ({
      ...model,
      efforts: model.supportsEffort ? claudeEfforts : [],
      defaultEffort: model.supportsEffort ? config.defaultEffort : undefined,
    }));
    const models = (agent: AgentId): Promise<ModelSpec[]> =>
      agent === 'codex' ? codexModels(config) : Promise.resolve(claudeCatalog);
    const chats = new ChatManager({
      config,
      store,
      brands,
      templates,
      versions,
      capture,
      seams,
      music,
      assets,
      hub,
      provider,
      tokens,
      settings,
      usage,
      features: activeFeatures,
    });

    const viteServer = vite;
    const diagnose = (file: string) => diagnoseFile(viteServer, file);
    const brandSources = { github: new GitHubSource(), gitlab: new GitLabSource(), ...customSources };
    const brandBuilds = new BrandBuilder({
      config,
      brands,
      sources: brandSources,
      provider,
      tokens,
      settings,
      capture,
      hub,
      usage,
      features: activeFeatures,
      diagnose,
    });
    await brandBuilds.sweep();
    const networks: Record<NetworkId, Network> = {
      youtube: new YouTubeNetwork(),
      linkedin: new LinkedInNetwork(),
      instagram: new InstagramNetwork(),
      tiktok: new TikTokNetwork(),
      ...customNetworks,
    };
    const accounts = new FileAccountService({ config, hub, networks, git: brandSources });
    const publisher = new Publisher({ store, renders, accounts, networks, hub });
    store.setModuleInvalidator((dirs) => invalidateDirs(viteServer, dirs));
    store.setMusicGridProvider((id) => music.grid(id));
    store.setVoiceOverProvider(voiceOver.provider);
    store.events.on('list-changed', () => hub.send({ type: 'projects-changed' }));
    store.events.on('changed', (projectId: string) => hub.send({ type: 'project-changed', projectId }));
    store.events.on('code-changed', (projectId: string, generation: number) =>
      hub.send({ type: 'code-changed', projectId, generation }),
    );
    store.events.on('versions-changed', (projectId: string) => hub.send({ type: 'versions', projectId }));
    store.events.on('assets-changed', (projectId: string) => hub.send({ type: 'assets', projectId }));

    const api = createApi({
      config,
      store,
      brands,
      templates,
      versions,
      assets,
      capture,
      seams,
      renders,
      music,
      voiceOver,
      chats,
      settings,
      usage,
      hub,
      brandSources,
      brandBuilds,
      accounts,
      publisher,
      agentStatus: () => provider.status(),
      codexStatus: () => codex.status(),
      grokStatus: () => grokStatus(config),
      geminiStatus: () => geminiStatus(config),
      models,
      diagnose,
      hostApi,
      features: activeFeatures,
    });
    const mcp = createMcpHandler({
      config,
      store,
      brands,
      templates,
      versions,
      capture,
      seams,
      music,
      voiceOver,
      assets,
      tokens,
      diagnose,
    });
    const editorToken = randomToken();
    editorHandler = createEditorHandler({ config, editorToken, tokens, accounts, api, mcp, editor });
    frameHandler = createFrameHandler({ config, vite, store, brands });

    store.watch(vite.watcher);
    await writeProjectsGuide(config);
    if (!quiet) void banner(config, provider);

    const services: Services = {
      hub,
      brands,
      templates,
      store,
      settings,
      usage,
      vite,
      capture,
      seams,
      music,
      voiceOver,
      renders,
      versions,
      assets,
      tokens,
      provider,
      chats,
      brandBuilds,
      accounts,
      publisher,
    };
    let closing: Promise<void> | null = null;
    const close = () =>
      (closing ??= (async () => {
        for (const job of renders.jobs()) if (!['done', 'error', 'cancelled'].includes(job.status)) renders.cancel(job.id);
        // Claude processes would otherwise outlive the server (and keep writing into projects).
        await chats.stopAll().catch((e: Error) => console.warn(m().api.server.stopChats(e.message)));
        await brandBuilds.close().catch((e: Error) => console.warn(m().api.server.stopBrandBuilds(e.message)));
        await shutdown(editorServer, frameServer, services.store, services.capture, services.vite);
      })());
    return { config, services, editorToken, close };
  } catch (e) {
    await shutdown(editorServer, frameServer, store, capture, vite);
    throw e;
  }
}

function unavailable(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
  res.end(m().api.server.starting);
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(m().api.server.portInUse(port)) : e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function shutdown(
  editorServer: http.Server,
  frameServer: http.Server,
  store: FileProjectStore | null,
  capture: PlaywrightCapture | null,
  vite: ViteDevServer | null,
): Promise<void> {
  store?.close();
  await Promise.all(
    [editorServer, frameServer].map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          // SSE streams and keep-alive sockets would hold close() open forever.
          server.closeAllConnections();
        }),
    ),
  );
  await capture?.close().catch((e: Error) => console.warn(m().api.server.closeChromium(e.message)));
  await vite?.close().catch((e: Error) => console.warn(m().api.server.closeVite(e.message)));
}

async function banner(config: CadenceConfig, provider: AgentProvider): Promise<void> {
  const status = await provider
    .status()
    .catch((e: Error) => ({ ok: false, label: provider.label, detail: e.message, version: undefined }));
  const text = m().api.server;
  const agent = status.ok
    ? `${status.label}${status.version ? ` ${status.version}` : ''}`
    : text.agentUnavailable(status.detail ?? status.label);
  console.log(
    [
      '',
      `  Cadence   ${config.editorOrigin}`,
      '',
      `  ${text.projects.padEnd(10)}${config.projectsDir}`,
      `  Agent     ${agent}`,
      `  MCP       ${config.mcpUrl}  ${text.mcpHint}`,
      '',
    ].join('\n'),
  );
}
