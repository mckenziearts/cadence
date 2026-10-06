// Typed client of the editor API. Mutating requests carry the per-start token the server put in the page; every
// failure becomes a toast in the interface language (the server already answers `{ error }` in it) and then rejects.
import type {
  AgentId,
  AgentStatus,
  AppState,
  AssetInfo,
  BrandBuild,
  CaptureRefInput,
  ChatKey,
  ChatState,
  CreateProjectInput,
  CreateSceneInput,
  ElevenLabsModel,
  ElevenLabsVoice,
  FormatId,
  GitAccount,
  GitHost,
  ModelSpec,
  MusicAnalysis,
  MusicSettingsPatch,
  NetworkId,
  ProjectState,
  Publications,
  PublishJob,
  PublishRequest,
  RenderFile,
  RenderJob,
  RenderRequest,
  RepoListing,
  SceneState,
  SceneVoiceOver,
  SeamResult,
  SendMessageInput,
  Settings,
  SnapGrid,
  StartBrandBuildInput,
  UpdateProjectInput,
  UsageSummary,
  VersionEntry,
  BrandFile,
  VoiceInfo,
  VoicesState,
} from '../shared/types';
import { t } from './i18n';
import { set } from './store';
import { toast } from './store/ui';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const token = document.querySelector<HTMLMetaElement>('meta[name="cadence-token"]')?.content ?? '';

interface Options {
  /** Don't toast the error (the caller shows it its own way, or it is expected). */
  quiet?: boolean;
}

async function request<T>(method: string, url: string, body?: unknown, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET' && method !== 'HEAD') headers['X-Cadence-Token'] = token;
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let error: ApiError;
  try {
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data as T;
    const { error: message, code } = (data ?? {}) as { error?: unknown; code?: unknown };
    error = new ApiError(typeof message === 'string' ? message : t().shell.api.failed(res.status, method, url), res.status);
    // A restarted server has a new token that only a fresh page carries.
    if (code === 'token') {
      set({ stale: true });
      throw error;
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    error = new ApiError(t().shell.api.down, 0);
  }
  if (!options.quiet) toast(error.message, 'error');
  throw error;
}

const get = <T>(url: string, options?: Options) => request<T>('GET', url, undefined, options);
const post = <T>(url: string, body?: unknown, options?: Options) => request<T>('POST', url, body ?? {}, options);
const put = <T>(url: string, body: unknown, options?: Options) => request<T>('PUT', url, body, options);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const q = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};

function upload(file: File): FormData {
  const form = new FormData();
  form.append('file', file, file.name);
  return form;
}

/** Swallows a rejection already reported by a toast. */
export const ignore = (): void => undefined;

export const api = {
  state: (options?: Options) => get<AppState>('/api/state', options),

  project: (id: string, options?: Options) => get<ProjectState>(p(id), options),
  createProject: (input: CreateProjectInput) => post<ProjectState>('/api/projects', input),
  updateProject: (id: string, input: UpdateProjectInput) => patch<ProjectState>(p(id), input),
  deleteProject: (id: string) => del<{ ok: true }>(p(id)),
  artDirection: (id: string) => get<{ text: string }>(`${p(id)}/art-direction`),
  saveArtDirection: (id: string, text: string) => put<{ text: string }>(`${p(id)}/art-direction`, { text }),

  createScene: (id: string, input: CreateSceneInput) => post<SceneState>(`${p(id)}/scenes`, input),
  updateScene: (id: string, sceneId: string, input: { name?: string; duration?: number; voiceOver?: SceneVoiceOver | null }) =>
    patch<ProjectState>(`${p(id)}/scenes/${sceneId}`, input),
  duplicateScene: (id: string, sceneId: string) => post<SceneState>(`${p(id)}/scenes/${sceneId}/duplicate`),
  deleteScene: (id: string, sceneId: string) => del<ProjectState>(`${p(id)}/scenes/${sceneId}`),
  reorder: (id: string, ids: string[]) => put<ProjectState>(`${p(id)}/order`, { ids }),
  thumbnailUrl: (id: string, sceneId: string, format: FormatId, version: string) =>
    `${p(id)}/scenes/${sceneId}/thumbnail${q({ format, v: version })}`,

  seams: (id: string) => get<SeamResult[]>(`${p(id)}/seams`, { quiet: true }),
  checkSeams: (id: string, input: { sceneId?: string; format?: FormatId }) => post<SeamResult[]>(`${p(id)}/seams`, input),
  seamDetail: (id: string, from: string, to: string, format: FormatId) =>
    get<{ result: SeamResult; fromUrl: string; toUrl: string; diffUrl: string }>(
      `${p(id)}/seams/detail${q({ from, to, format })}`,
    ),

  tracks: (id: string) => get<{ file: string; size: number; analysed: boolean }[]>(`${p(id)}/music/tracks`),
  // The file itself as the body: the server writes it to disk as it arrives.
  uploadMusic: (id: string, file: File) => post<ProjectState>(`${p(id)}/music${q({ name: file.name })}`, file),
  selectTrack: (id: string, file: string) => put<ProjectState>(`${p(id)}/music/select`, { file }),
  updateMusic: (id: string, input: MusicSettingsPatch) => patch<ProjectState>(`${p(id)}/music`, input),
  removeMusic: (id: string) => del<ProjectState>(`${p(id)}/music`),
  analysis: (id: string) => get<MusicAnalysis | null>(`${p(id)}/music/analysis`, { quiet: true }),
  snap: (id: string, grid: SnapGrid, opts: { keepBars?: boolean } = {}) =>
    post<ProjectState>(`${p(id)}/music/snap`, { grid, ...opts }),

  voices: () => get<VoicesState>('/api/voices', { quiet: true }),
  downloadVoice: (voice: string) => post<VoiceInfo>(`/api/voices/${encodeURIComponent(voice)}/download`),
  syncVoiceOver: (id: string) => post<ProjectState>(`${p(id)}/voice-over/sync`),
  /** Quiet: the Voice panel and the Profile show the failure under their fields. */
  elevenLabs: () => get<{ voices: ElevenLabsVoice[]; models: ElevenLabsModel[] }>('/api/voices/elevenlabs', { quiet: true }),
  saveElevenLabsKey: (key: string) => put<{ configured: true }>('/api/voices/elevenlabs/key', { key }, { quiet: true }),
  removeElevenLabsKey: () => del<{ configured: false }>('/api/voices/elevenlabs/key'),

  versions: (id: string, sceneId?: string | null) => get<VersionEntry[]>(`${p(id)}/versions${q({ scene: sceneId })}`),
  saveVersion: (id: string, label: string) => post<VersionEntry | null>(`${p(id)}/versions`, { label }),
  restoreVersion: (id: string, versionId: string, sceneId?: string | null) =>
    post<VersionEntry>(`${p(id)}/versions/${versionId}/restore`, sceneId ? { sceneId } : {}),

  chat: (id: string, key: ChatKey) => get<ChatState>(`${p(id)}/chats/${key}`),
  send: (id: string, key: ChatKey, input: SendMessageInput) => post<ChatState>(`${p(id)}/chats/${key}/messages`, input),
  stop: (id: string, key: ChatKey) => post<{ ok: true }>(`${p(id)}/chats/${key}/stop`),
  clearChat: (id: string, key: ChatKey) => del<ChatState>(`${p(id)}/chats/${key}`),
  cost: (id: string) => get<{ totalUsd: number }>(`${p(id)}/cost`, { quiet: true }),

  renders: (id: string) => get<{ jobs: RenderJob[]; files: RenderFile[] }>(`${p(id)}/renders`, { quiet: true }),
  startRender: (id: string, input: RenderRequest) => post<RenderJob[]>(`${p(id)}/renders`, input),
  cancelRender: (jobId: string) => del<{ ok: true }>(`/api/renders/${encodeURIComponent(jobId)}`),
  deleteRender: (id: string, name: string) => del<{ ok: true }>(`${p(id)}/renders/${encodeURIComponent(name)}`),
  repos: (host: GitHost) => get<RepoListing>(`/api/brand-sources/${host}`),
  startBrandBuild: (input: StartBrandBuildInput) => post<BrandBuild>('/api/brand-builds', input),
  cancelBrandBuild: (id: string) => del<{ ok: true }>(`/api/brand-builds/${encodeURIComponent(id)}`),

  assets: (id: string) => get<AssetInfo[]>(`${p(id)}/assets`),
  uploadAsset: (id: string, file: File) => post<AssetInfo>(`${p(id)}/assets`, upload(file)),
  deleteAsset: (id: string, assetPath: string) => del<{ ok: true }>(`${p(id)}/assets${q({ path: assetPath })}`),
  captureRef: (id: string, input: CaptureRefInput) => post<AssetInfo>(`${p(id)}/refs`, input),

  brand: (id: string) => get<BrandFile>(`/api/brands/${encodeURIComponent(id)}`),
  deleteBrand: (id: string) => del<{ ok: true }>(`/api/brands/${encodeURIComponent(id)}`),
  logoUrl: (id: string, variant: 'mark' | 'full' = 'mark') => `/api/brands/${encodeURIComponent(id)}/logo?variant=${variant}`,
  saveSettings: (input: Partial<Settings>) => put<Settings>('/api/settings', input),

  /** Quiet: the Profile page shows the failure on its cards. */
  gitAccounts: () => get<Record<GitHost, GitAccount>>('/api/git-accounts', { quiet: true }),
  agentAccounts: () => get<Record<AgentId, AgentStatus>>('/api/agent-accounts', { quiet: true }),
  agentModels: (agent: AgentId) => get<ModelSpec[]>(`/api/agent-models?agent=${agent}`, { quiet: true }),
  usage: (agent: AgentId) => get<UsageSummary>(`/api/usage?agent=${agent}`, { quiet: true }),
  saveNetworkApp: (id: NetworkId, app: { clientId: string; clientSecret: string }) =>
    put<{ ok: true }>(`/api/networks/${id}/app`, app),
  connectNetwork: (id: NetworkId) => post<{ url: string }>(`/api/networks/${id}/connect`),
  disconnectNetwork: (id: NetworkId) => del<{ ok: true }>(`/api/networks/${id}`),
  publications: (id: string) => get<Publications>(`${p(id)}/publications`, { quiet: true }),
  publish: (id: string, input: PublishRequest) => post<PublishJob>(`${p(id)}/publications`, input),
};
