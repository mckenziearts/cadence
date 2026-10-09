import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { subtitleCues, toSrt, toVtt } from '../../src/shared/subtitles';
import {
  AGENT_IDS,
  EFFORTS,
  FORMAT_IDS,
  ID_PATTERN,
  LANGUAGES,
  MODEL_ID_PATTERN,
  NETWORK_IDS,
  VISIBILITIES,
  agentName,
  chatKeyForScene,
  isFormatId,
  type AgentId,
  type AgentStatus,
  type AppState,
  type ChatKey,
  type FormatId,
  type NetworkId,
} from '../../src/shared/types';
import type { ApiDeps } from '../contracts';
import { language, m } from '../i18n';
import { DEFAULT_BRAND } from '../store/brands';
import { elevenLabsSpeakersSchema, piperSpeakersSchema, sceneVoiceOverInputSchema } from '../store/projects';
import { HttpError, pathExists, resolveInside } from '../util';
import { ELEVENLABS_MODEL_PATTERN, ELEVENLABS_VOICE_PATTERN } from '../voiceover/elevenlabs';
import { VOICES } from '../voiceover/voices';
import { dataUrl, sendFile, sendImage } from './files';

const MB = 1024 * 1024;
const JSON_LIMIT = 2 * MB;
const MUSIC_LIMIT = 201 * MB;
const ASSET_LIMIT = 51 * MB;
/** POST routes that take a multipart file with their own, larger body limit. */
const UPLOAD_ROUTE = /^\/api\/projects\/[^/]+\/(music|assets)$/;
/** Two lines of 42 characters, the usual limit of subtitle files. */
const SUBTITLE_MAX_CHARS = 84;
const ZOD_LOCALES = { fr: z.locales.fr(), en: z.locales.en() };

const idSchema = z.string().regex(ID_PATTERN);
const formatSchema = z.enum(FORMAT_IDS);
const fpsSchema = z.literal([24, 30, 60]);
const languageSchema = z.enum(['fr', 'en']).nullable();
const effortSchema = z.enum(EFFORTS);
const modelSchema = z.string().regex(MODEL_ID_PATTERN);
const voiceOverSchema = z.discriminatedUnion('engine', [
  z.object({
    engine: z.literal('piper').optional(),
    voice: z.enum(VOICES.map((v) => v.id) as [string, ...string[]]),
    speed: z.number().min(0.5).max(2),
    musicLevel: z.number().min(0).max(1),
    speakers: piperSpeakersSchema.optional(),
  }),
  // ElevenLabs' own speed range.
  z.object({
    engine: z.literal('elevenlabs'),
    voice: z.string().regex(ELEVENLABS_VOICE_PATTERN),
    model: z.string().regex(ELEVENLABS_MODEL_PATTERN),
    speed: z.number().min(0.7).max(1.2),
    musicLevel: z.number().min(0).max(1),
    speakers: elevenLabsSpeakersSchema.optional(),
  }),
]);

const schemas = {
  createProject: z.object({
    name: z.string().min(1).max(120),
    id: idSchema.optional(),
    brand: idSchema.nullable(),
    formats: z.array(formatSchema).min(1),
    fps: fpsSchema,
    template: idSchema.nullish(),
    language: languageSchema.optional(),
  }),
  updateProject: z.object({
    name: z.string().min(1).max(120).optional(),
    brand: idSchema.nullable().optional(),
    formats: z.array(formatSchema).min(1).optional(),
    fps: fpsSchema.optional(),
    tempo: z.number().min(30).max(300).optional(),
    language: languageSchema.optional(),
    voiceOver: voiceOverSchema.nullable().optional(),
    captions: z.boolean().optional(),
  }),
  text: z.object({ text: z.string().max(200_000) }),
  createScene: z.object({
    name: z.string().min(1).max(120),
    after: idSchema.nullish(),
    template: idSchema.nullish(),
    code: z.string().max(MB).optional(),
    duration: z.number().positive().max(600).optional(),
  }),
  updateScene: z.object({
    name: z.string().min(1).max(120).optional(),
    duration: z.number().positive().max(600).optional(),
    voiceOver: sceneVoiceOverInputSchema.nullable().optional(),
  }),
  order: z.object({ ids: z.array(idSchema) }),
  checkSeams: z.object({ sceneId: idSchema.optional(), format: formatSchema.optional() }),
  selectMusic: z.object({ file: z.string().min(1).max(300) }),
  brandBuild: z.object({ repo: z.string().min(1).max(300), name: z.string().trim().min(1).max(60) }),
  updateMusic: z.object({
    start: z.number().min(0).optional(),
    volume: z.number().min(0).max(1).optional(),
    // null resets an override to the detected value; the service enforces the exact ranges (barOffset < beatsPerBar).
    bpm: z.number().min(40).max(240).nullable().optional(),
    beatsPerBar: z.literal([3, 4, 6]).nullable().optional(),
    barOffset: z.number().int().min(0).max(5).nullable().optional(),
    gridOffset: z.number().min(-0.25).max(0.25).nullable().optional(),
  }),
  snap: z.object({ grid: z.enum(['beat', 'bar', 'phrase']), keepBars: z.boolean().optional() }),
  saveVersion: z.object({ label: z.string().max(200).optional() }),
  restore: z.object({ sceneId: idSchema.nullish() }),
  message: z.object({
    text: z.string().trim().min(1).max(50_000),
    model: modelSchema.optional(),
    effort: effortSchema.optional(),
    playhead: z.object({ sceneId: idSchema.nullable(), t: z.number().min(0), format: formatSchema }).optional(),
  }),
  render: z.object({
    formats: z.array(formatSchema).min(1),
    fps: fpsSchema.optional(),
    scale: z.literal([0.5, 1, 2]).optional(),
    quality: z.enum(['draft', 'standard', 'master']),
    supersample: z.boolean().optional(),
    range: z
      .object({ from: z.number().min(0), to: z.number().positive() })
      .refine((r) => r.to > r.from, { error: () => m().api.routes.rangeOrder })
      .optional(),
  }),
  captureRef: z.object({
    url: z.string().min(1).max(2000),
    device: z.enum(['desktop', 'mobile']),
    fullPage: z.boolean().optional(),
    name: z.string().max(80).optional(),
  }),
  elevenLabsKey: z.object({ key: z.string().trim().min(1).max(256).regex(/^\S+$/) }),
  networkApp: z.object({ clientId: z.string().trim().min(1).max(300), clientSecret: z.string().trim().min(1).max(300) }),
  publish: z.object({
    file: z.string().min(1).max(300),
    network: z.enum(NETWORK_IDS),
    title: z.string().trim().max(100),
    description: z.string().max(5000),
    visibility: z.enum(VISIBILITIES),
  }),
  settings: z.object({
    sceneModel: modelSchema.optional(),
    sceneEffort: effortSchema.optional(),
    projectModel: modelSchema.optional(),
    projectEffort: effortSchema.optional(),
    language: z.enum(LANGUAGES).optional(),
    agent: z.enum(AGENT_IDS).optional(),
    defaultVoice: z
      .object({
        engine: z.literal('elevenlabs'),
        voice: z.string().regex(ELEVENLABS_VOICE_PATTERN),
        model: z.string().regex(ELEVENLABS_MODEL_PATTERN),
      })
      .nullable()
      .optional(),
  }),
};

/** REST API under /api (see ARCHITECTURE.md "REST API"). Errors are JSON `{ error }` in the interface language. */
export function createApi(deps: ApiDeps) {
  const { config, store, brands, templates, versions, assets, capture, seams, renders, music, chats, settings, hub } = deps;
  const app = new Hono<{ Bindings: HttpBindings }>().basePath('/api');

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: m().api.routes.fileNotFound }, 404);
    console.error(m().api.routes.errorLog, err);
    return c.json({ error: m().api.internalError(err.message) }, 500);
  });
  app.notFound((c) => c.json({ error: m().api.routes.unknownRoute(c.req.method, c.req.path) }, 404));

  // Bodies are small JSON, whatever their content type; the two upload routes set their own limit.
  const jsonLimit = bodyLimit({ maxSize: JSON_LIMIT, onError: (c) => c.json({ error: m().api.routes.tooLarge }, 413) });
  app.use('*', (c, next) => (c.req.method === 'POST' && UPLOAD_ROUTE.test(c.req.path) ? next() : jsonLimit(c, next)));

  // State & events
  app.get('/state', async (c) => {
    const [projects, brandList, sceneTemplates, projectTemplates, currentSettings, agent, networks] = await Promise.all([
      store.list(),
      brands.list(),
      templates.scenes(),
      templates.projects(),
      settings.get(),
      deps.agentStatus().catch((e: Error): AgentStatus => ({ ok: false, label: 'Claude Code', detail: e.message })),
      deps.accounts.networks(),
    ]);
    const state: AppState = {
      projects,
      brands: brandList,
      templates: { scenes: sceneTemplates, projects: projectTemplates },
      settings: currentSettings,
      agent,
      frameOrigin: config.frameOrigin,
      models: await deps.models(currentSettings.agent),
      brandBuilds: deps.brandBuilds.list(),
      networks,
      features: deps.features,
    };
    return c.json(state);
  });

  app.get('/events', (c) => {
    if (!c.env?.outgoing) throw new HttpError(500, m().api.routes.eventsUnavailable);
    hub.handleSse(c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  });

  // Projects
  app.get('/projects/:id', async (c) => c.json(await store.get(c.req.param('id'))));
  app.post('/projects', async (c) => {
    const project = await store.create({
      ...(await body(c, schemas.createProject)),
      voiceOver: (await settings.get()).defaultVoice,
    });
    await versions
      .snapshot(project.id, { label: m().api.versions.initial, source: 'baseline' })
      .catch((e: Error) => console.warn(m().api.versions.notSaved(e.message)));
    return c.json(project);
  });
  app.patch('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const patch = await body(c, schemas.updateProject);
    const project = await store.update(id, patch);
    if ([patch.formats, patch.brand, patch.tempo, patch.language].some((v) => v !== undefined)) seams.recheck(id);
    return c.json(project);
  });
  app.delete('/projects/:id', async (c) => {
    const id = await idle(c.req.param('id'));
    const rendering = renders.jobs(id).some((j) => j.status === 'queued' || j.status === 'rendering' || j.status === 'encoding');
    if (rendering) throw new HttpError(409, m().api.routes.rendering);
    if (deps.publisher.busy(id)) throw new HttpError(409, m().api.routes.publishing);
    await store.remove(id);
    return c.json({ ok: true });
  });
  app.get('/projects/:id/art-direction', async (c) => c.json({ text: await store.readArtDirection(c.req.param('id')) }));
  app.put('/projects/:id/art-direction', async (c) => {
    const { text } = await body(c, schemas.text);
    await store.writeArtDirection(c.req.param('id'), text);
    return c.json({ text });
  });

  // Scenes
  app.post('/projects/:id/scenes', async (c) => {
    const id = c.req.param('id');
    const input = await body(c, schemas.createScene);
    const scene = await store.createScene(id, input);
    // During a turn this would take Claude's half-done edits along; the turn's own version picks the new scene up.
    if (input.template && input.code === undefined && !chats.busy(id)) {
      await versions
        .snapshot(id, { label: m().api.versions.templateInserted(scene.name), source: 'template' })
        .catch((e: Error) => console.warn(m().api.versions.notSaved(e.message)));
    }
    return c.json(scene);
  });
  app.patch('/projects/:id/scenes/:sid', async (c) => {
    const id = c.req.param('id');
    const patch = await body(c, schemas.updateScene);
    const project = await store.updateScene(id, c.req.param('sid'), patch);
    if (patch.duration !== undefined) seams.recheck(id);
    return c.json(project);
  });
  app.post('/projects/:id/scenes/:sid/duplicate', async (c) =>
    c.json(await store.duplicateScene(c.req.param('id'), c.req.param('sid'))),
  );
  app.delete('/projects/:id/scenes/:sid', async (c) => {
    const id = await idle(c.req.param('id'));
    const project = await store.deleteScene(id, c.req.param('sid'));
    seams.recheck(id);
    return c.json(project);
  });
  app.put('/projects/:id/order', async (c) => {
    const id = c.req.param('id');
    const project = await store.reorderScenes(id, (await body(c, schemas.order)).ids);
    seams.recheck(id);
    return c.json(project);
  });

  app.get('/projects/:id/scenes/:sid/thumbnail', async (c) => {
    const { id, sid } = await existingScene(c);
    const image = await capture.thumbnail(id, sid, { t: queryNumber(c, 't'), format: queryFormat(c) });
    return sendImage(c, image);
  });
  app.get('/projects/:id/scenes/:sid/diagnostics', async (c) => {
    const { id, sid } = await existingScene(c);
    const error = await deps.diagnose(store.sceneFile(id, sid));
    // Paths relative to the project read better in the editor.
    return c.json({ error: error ? error.split(`${store.dir(id)}${path.sep}`).join('') : null });
  });

  // Seams
  app.get('/projects/:id/seams', async (c) => {
    await existingProject(c);
    return c.json(seams.cached(c.req.param('id')));
  });
  app.post('/projects/:id/seams', async (c) => c.json(await seams.check(c.req.param('id'), await body(c, schemas.checkSeams))));
  app.get('/projects/:id/seams/detail', async (c) => {
    const detail = await seams.detail(c.req.param('id'), requiredQuery(c, 'from'), requiredQuery(c, 'to'), queryFormat(c));
    return c.json({
      result: detail.result,
      fromUrl: dataUrl(detail.fromImage),
      toUrl: dataUrl(detail.toImage),
      diffUrl: dataUrl(detail.diffImage),
    });
  });

  // Music
  app.get('/projects/:id/music/tracks', async (c) => c.json(await music.tracks(c.req.param('id'))));
  // The body is the audio file itself (its name in the query): it goes to disk as it arrives, never whole in memory.
  app.post('/projects/:id/music', uploadLimit(MUSIC_LIMIT, 200), async (c) => {
    const body = c.req.raw.body ? Readable.fromWeb(c.req.raw.body as WebReadableStream<Uint8Array>) : [];
    return c.json(await music.upload(c.req.param('id'), { name: requiredQuery(c, 'name'), body }));
  });
  app.put('/projects/:id/music/select', async (c) =>
    c.json(await music.select(c.req.param('id'), (await body(c, schemas.selectMusic)).file)),
  );
  app.patch('/projects/:id/music', async (c) =>
    c.json(await music.update(c.req.param('id'), await body(c, schemas.updateMusic))),
  );
  app.delete('/projects/:id/music', async (c) => c.json(await music.remove(c.req.param('id'))));
  app.get('/projects/:id/music/audio', async (c) => {
    const file = await music.audioPath(c.req.param('id'));
    if (!file) throw new HttpError(404, m().api.routes.noMusic);
    return sendFile(c, file);
  });
  app.get('/projects/:id/music/analysis', async (c) => c.json(await music.analysis(c.req.param('id'))));
  app.post('/projects/:id/music/snap', async (c) => {
    const id = c.req.param('id');
    const { grid, keepBars } = await body(c, schemas.snap);
    // Every duration may change at once: keep the way back (during a turn, the turn's own versions do).
    if (!chats.busy(id)) await versions.snapshot(id, { label: m().api.versions.beforeSnap, source: 'external' });
    const project = await music.snapCuts(id, grid, { keepBars });
    seams.recheck(id);
    return c.json(project);
  });

  // Voice-overs
  app.get('/voices', async (c) => c.json(await deps.voiceOver.voices()));
  app.post('/voices/:voice/download', async (c) => c.json(await deps.voiceOver.download(c.req.param('voice'))));
  app.get('/voices/elevenlabs', async (c) => c.json(await deps.voiceOver.elevenLabs()));
  app.put('/voices/elevenlabs/key', async (c) => {
    await deps.voiceOver.setElevenLabsKey((await body(c, schemas.elevenLabsKey)).key);
    return c.json({ configured: true });
  });
  app.delete('/voices/elevenlabs/key', async (c) => {
    await deps.voiceOver.setElevenLabsKey(null);
    // Without the key, new projects start on Piper again (the ones already made keep their voice and answer "no key").
    await settings.update({ defaultVoice: null });
    return c.json({ configured: false });
  });
  /** Speak what is missing now, even sentences Piper failed on before (the editor's "Try again"). */
  app.post('/projects/:id/voice-over/sync', async (c) => {
    const id = await existingProject(c);
    await deps.voiceOver.sync(id);
    return c.json(await store.get(id));
  });
  app.get('/projects/:id/voice-over/audio', async (c) => {
    const track = await deps.voiceOver.track(await existingProject(c));
    if (!track) throw new HttpError(404, m().media.voiceOver.noTrack);
    return sendFile(c, track.file, 'audio/wav');
  });
  app.get('/projects/:id/subtitles', async (c) => {
    const format = c.req.query('format') ?? '';
    if (format !== 'srt' && format !== 'vtt') throw new HttpError(400, m().api.routes.invalidParam('format', format));
    // Never speaks: with ElevenLabs a sync bills the person (a Piper read may try its missing sentences, like any read).
    const project = await store.get(await existingProject(c));
    if (project.voiceOverPending.length) throw new HttpError(409, m().media.voiceOver.notSpoken);
    if (!project.voiceOverLines.length) throw new HttpError(404, m().media.voiceOver.noTrack);
    const cues = subtitleCues(project.voiceOverLines, { maxChars: SUBTITLE_MAX_CHARS, speakers: project.voiceOver.speakers });
    // As scenes read it: the project's on-screen language, else its brand's.
    const language = project.language ?? (await brands.get(project.brand ?? DEFAULT_BRAND).catch(() => null))?.language ?? 'fr';
    return c.body(format === 'srt' ? toSrt(cues, language) : toVtt(cues), 200, {
      'Content-Type': format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
      'Content-Disposition': `attachment; filename="${project.id}.${format}"`,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // Versions
  app.get('/projects/:id/versions', async (c) =>
    c.json(await versions.list(c.req.param('id'), { sceneId: c.req.query('scene') || undefined })),
  );
  app.post('/projects/:id/versions', async (c) => {
    const { label } = await body(c, schemas.saveVersion);
    return c.json(
      await versions.snapshot(c.req.param('id'), { label: label?.trim() || m().api.versions.manual, source: 'manual' }),
    );
  });
  app.post('/projects/:id/versions/:vid/restore', async (c) => {
    const id = await idle(c.req.param('id'));
    const { sceneId } = await body(c, schemas.restore);
    return c.json(await versions.restore(id, c.req.param('vid'), sceneId ? { sceneId } : {}));
  });

  // Chats
  app.get('/projects/:id/chats/:key', async (c) => c.json(await chats.get(c.req.param('id'), chatKey(c))));
  app.post('/projects/:id/chats/:key/messages', async (c) =>
    c.json(await chats.send(c.req.param('id'), chatKey(c), await body(c, schemas.message))),
  );
  app.post('/projects/:id/chats/:key/stop', (c) => {
    chats.stop(c.req.param('id'), chatKey(c));
    return c.json({ ok: true });
  });
  app.delete('/projects/:id/chats/:key', async (c) => c.json(await chats.clear(c.req.param('id'), chatKey(c))));
  app.get('/projects/:id/agent-frames/:name', async (c) => {
    const name = c.req.param('name');
    // JPEG normally; the MCP tool may save PNG frames too.
    if (!/^[\w.-]+\.(jpe?g|png)$/.test(name)) throw new HttpError(400, m().api.routes.imageName(name));
    return sendFile(c, path.join(store.dir(c.req.param('id')), '.cadence', 'frames', name));
  });
  app.get('/projects/:id/cost', async (c) => c.json({ totalUsd: await chats.totalCost(c.req.param('id')) }));

  // Renders
  app.post('/projects/:id/renders', async (c) => c.json(await renders.start(c.req.param('id'), await body(c, schemas.render))));
  app.get('/projects/:id/renders', async (c) => {
    const id = c.req.param('id');
    await existingProject(c);
    return c.json({ jobs: renders.jobs(id), files: await renders.files(id) });
  });
  app.delete('/renders/:jobId', (c) => {
    renders.cancel(c.req.param('jobId'));
    return c.json({ ok: true });
  });
  app.get('/projects/:id/renders/:name', async (c) =>
    sendFile(c, renders.resolveFile(c.req.param('id'), c.req.param('name')), 'video/mp4'),
  );
  app.delete('/projects/:id/renders/:name', async (c) => {
    const id = c.req.param('id');
    const name = c.req.param('name');
    if (deps.publisher.busy(id, name)) throw new HttpError(409, m().api.routes.videoSending);
    await renders.remove(id, name);
    return c.json({ ok: true });
  });

  // Brand builds
  app.get('/brand-sources/:host', async (c) => {
    const host = c.req.param('host');
    if (host !== 'github' && host !== 'gitlab') throw new HttpError(404, m().api.routes.gitHost(host));
    return c.json(await deps.brandSources[host].repos());
  });
  app.post('/brand-builds', async (c) => c.json(await deps.brandBuilds.start(await body(c, schemas.brandBuild))));
  app.delete('/brand-builds/:id', (c) => {
    deps.brandBuilds.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Accounts & publishing
  app.get('/git-accounts', async (c) => c.json(await deps.accounts.git()));
  // Live CLI status for the Profile's agent cards, re-checked on each visit like /git-accounts.
  app.get('/agent-accounts', async (c) => {
    const fallback =
      (label: string) =>
      (e: Error): AgentStatus => ({ ok: false, label, reason: 'error', detail: e.message });
    const [claudeCode, codex, grok, gemini] = await Promise.all([
      deps.agentStatus().catch(fallback('Claude Code')),
      deps.codexStatus().catch(fallback('Codex')),
      deps.grokStatus().catch(fallback('Grok')),
      deps.geminiStatus().catch(fallback('Gemini')),
    ]);
    return c.json({ 'claude-code': claudeCode, codex, grok, gemini } satisfies Record<AgentId, AgentStatus>);
  });
  // The model catalogue of an agent (default: the active one), so the chat picker follows the selected assistant.
  app.get('/agent-models', async (c) => {
    const q = c.req.query('agent');
    const agent: AgentId = AGENT_IDS.includes(q as AgentId) ? (q as AgentId) : (await settings.get()).agent;
    return c.json(await deps.models(agent));
  });
  app.put('/networks/:network/app', async (c) => {
    await deps.accounts.saveApp(networkId(c), await body(c, schemas.networkApp));
    return c.json({ ok: true });
  });
  app.post('/networks/:network/connect', async (c) => c.json(await deps.accounts.connect(networkId(c))));
  app.delete('/networks/:network', async (c) => {
    await deps.accounts.disconnect(networkId(c));
    return c.json({ ok: true });
  });
  app.get('/projects/:id/publications', async (c) => c.json(await deps.publisher.list(await existingProject(c))));
  app.post('/projects/:id/publications', async (c) =>
    c.json(await deps.publisher.start(await existingProject(c), await body(c, schemas.publish))),
  );

  // Assets
  app.get('/projects/:id/assets', async (c) => c.json(await assets.list(c.req.param('id'))));
  app.post('/projects/:id/assets', uploadLimit(ASSET_LIMIT, 50), async (c) =>
    c.json(await assets.upload(c.req.param('id'), await uploadedFile(c))),
  );
  app.delete('/projects/:id/assets', async (c) => {
    await assets.remove(c.req.param('id'), requiredQuery(c, 'path'));
    return c.json({ ok: true });
  });
  app.get('/projects/:id/assets/file', async (c) => sendFile(c, assets.resolve(c.req.param('id'), requiredQuery(c, 'path'))));
  app.post('/projects/:id/refs', async (c) =>
    c.json(await assets.captureReference(c.req.param('id'), await body(c, schemas.captureRef))),
  );

  // Brands & settings
  app.get('/brands/:id', async (c) => c.json(await brands.get(c.req.param('id'))));
  app.get('/brands/:id/logo', async (c) => {
    const id = c.req.param('id');
    const variant = c.req.query('variant') ?? 'mark';
    if (variant !== 'mark' && variant !== 'full') throw new HttpError(400, m().api.routes.logoVariant(variant));
    const brand = await brands.get(id);
    return sendFile(c, resolveInside(brands.dir(id), brand.logo[variant]));
  });
  // New brands start from the neutral kit, and a project without its brand would no longer load its kit.
  app.delete('/brands/:id', async (c) => {
    const id = c.req.param('id');
    if (id === DEFAULT_BRAND) throw new HttpError(400, m().api.routes.defaultBrand);
    const users = (await store.list()).filter((p) => p.brand === id).map((p) => p.name);
    if (users.length) throw new HttpError(409, m().api.routes.brandInUse(users));
    await brands.remove(id);
    hub.send({ type: 'brands-changed' });
    return c.json({ ok: true });
  });
  app.get('/settings', async (c) => c.json(await settings.get()));
  app.get('/usage', async (c) => {
    const q = c.req.query('agent');
    const agent: AgentId = AGENT_IDS.includes(q as AgentId) ? (q as AgentId) : (await settings.get()).agent;
    return c.json(await deps.usage.summary(agent));
  });
  app.put('/settings', async (c) => {
    const before = (await settings.get()).language;
    const next = await settings.update(await body(c, schemas.settings));
    if (next.language && next.language !== before) hub.send({ type: 'language-changed', language: next.language });
    return c.json(next);
  });

  // Host routes: after the built-in ones, under a name none of them uses. Without its own onError, a host app's errors
  // land in the handler above.
  const builtIn = new Set(app.routes.map((route) => route.path.split('/')[2]));
  for (const [name, routes] of Object.entries(deps.hostApi ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(m().core.hostApi.name(name));
    if (builtIn.has(name)) throw new Error(m().core.hostApi.taken(name));
    app.route(`/${name}`, routes);
  }

  return app;

  /**
   * Restores and deletions wait for the agent: its Edit and Write land in the files without the project lock, so they
   * would be overwritten, or recreate a moved folder.
   */
  async function idle(id: string): Promise<string> {
    if (chats.busy(id)) {
      throw new HttpError(409, m().api.routes.agentBusy(agentName((await settings.get()).agent, deps.features)));
    }
    return id;
  }

  async function existingProject(c: Context): Promise<string> {
    const id = c.req.param('id')!;
    if (!(await store.exists(id))) throw new HttpError(404, m().api.projectNotFound(id));
    return id;
  }

  /** Cheap check (thumbnails are requested often): the scene's file exists. */
  async function existingScene(c: Context): Promise<{ id: string; sid: string }> {
    const id = await existingProject(c);
    const sid = c.req.param('sid')!;
    if (!(await pathExists(store.sceneFile(id, sid)))) throw new HttpError(404, m().api.sceneNotFound(sid));
    return { id, sid };
  }
}

/** Parse and validate a JSON body; an empty body counts as `{}` (optional-only bodies). */
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const text = await c.req.text();
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(400, m().api.routes.invalidJson);
    }
  }
  const parsed = schema.safeParse(data, { error: ZOD_LOCALES[language()].localeError });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) =>
      i.path.length ? m().api.routes.issue(i.path.join('.'), i.message) : i.message,
    );
    throw new HttpError(400, m().api.routes.invalidBody(issues));
  }
  return parsed.data;
}

/** `mb` is the limit people are told; `maxSize` leaves room for the multipart envelope. */
function uploadLimit(maxSize: number, mb: number) {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: m().api.routes.fileTooLarge(mb) }, 413) });
}

async function uploadedFile(c: Context): Promise<{ name: string; data: Buffer }> {
  const form = await c.req.parseBody().catch(() => {
    throw new HttpError(400, m().api.routes.invalidUpload);
  });
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, m().api.routes.noFile);
  return { name: file.name, data: Buffer.from(await file.arrayBuffer()) };
}

function chatKey(c: Context): ChatKey {
  const key = c.req.param('key')!;
  if (key === 'project') return 'project';
  const sceneId = key.startsWith('scene:') ? key.slice('scene:'.length) : '';
  if (!ID_PATTERN.test(sceneId)) throw new HttpError(400, m().api.routes.unknownChat(key));
  return chatKeyForScene(sceneId);
}

function networkId(c: Context): NetworkId {
  const id = c.req.param('network')!;
  if (!(NETWORK_IDS as readonly string[]).includes(id)) throw new HttpError(404, m().api.routes.unknownNetwork(id));
  return id as NetworkId;
}

function requiredQuery(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value) throw new HttpError(400, m().api.routes.missingParam(name));
  return value;
}

function queryNumber(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new HttpError(400, m().api.routes.invalidParam(name, raw));
  return value;
}

function queryFormat(c: Context): FormatId | undefined {
  const raw = c.req.query('format');
  if (!raw) return undefined;
  if (!isFormatId(raw)) throw new HttpError(400, m().api.unknownFormat(raw));
  return raw;
}
