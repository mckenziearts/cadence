// Adapted from saeedvaziry/caleb-video-editor (MIT)
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FORMAT_IDS, FORMATS, type FormatId, type ProjectState, type SceneState, type SeamResult } from '../../src/shared/types';
import type {
  AssetStore,
  BrandStore,
  CadenceConfig,
  CaptureService,
  McpScope,
  McpTokenIssuer,
  MusicService,
  ProjectStore,
  SeamService,
  TemplateStore,
  VersionStore,
  VoiceOverService,
} from '../contracts';
import { barSeconds, projectOverview, sceneTable, voiceOverSummary } from '../agent/prompts';
import { m } from '../i18n';
import { HttpError, assertId, roundMs } from '../util';
import { BRAND_TOOLS, registerBrandTools } from './brandTools';

export interface McpDeps {
  config: CadenceConfig;
  store: ProjectStore;
  brands: BrandStore;
  templates: TemplateStore;
  versions: VersionStore;
  capture: CaptureService;
  seams: SeamService;
  music: MusicService;
  voiceOver: VoiceOverService;
  assets: AssetStore;
  tokens: McpTokenIssuer;
  /** Compile a file through Vite and return the error text, or null. */
  diagnose: (file: string) => Promise<string | null>;
}

/** Registers one tool when the scope allows it (see createToolServer). */
export type ToolRegistrar = <Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  run: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
  readOnly?: boolean,
) => void;

/** Tools of a scene chat; the project chat and terminal sessions get every tool. Also used for --allowedTools. */
export const SCENE_TOOLS = [
  'get_project',
  'get_brand',
  'get_music_context',
  'list_templates',
  'render_frames',
  'check_seams',
  'set_scene_duration',
  'set_voice_over',
  'save_version',
];
export const PROJECT_TOOLS = [
  ...SCENE_TOOLS,
  'create_scene',
  'duplicate_scene',
  'delete_scene',
  'move_scene',
  'rename_scene',
  'snap_cuts_to_music',
  'capture_reference',
];

const MAX_FRAMES = 8;
const QUALITY_SCALE = { low: 0.25, normal: 0.5, high: 1 } as const;
/** Percent of pixels from which a cut shows (every shipped template cut is under it): send the frames to look at. */
const SEAM_IMAGE_THRESHOLD = 0.05;

type Content = CallToolResult['content'][number];

export interface ToolContext {
  deps: McpDeps;
  scope: McpScope;
  token: string;
  /** Unique file name for a frame saved in .cadence/frames/. */
  frameName: (ext: string) => string;
}

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

function image(data: Buffer, mimeType?: string): Content {
  const type = mimeType ?? (data[0] === 0x89 && data[1] === 0x50 ? 'image/png' : 'image/jpeg');
  return { type: 'image', data: data.toString('base64'), mimeType: type };
}

function errorText(e: unknown): string {
  return e instanceof HttpError ? e.message : m().agent.internalError((e as Error)?.message ?? String(e));
}

function findScene(p: ProjectState, sceneId: string): SceneState {
  const scene = p.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    const ids = p.scenes.map((s) => s.id);
    throw new HttpError(404, m().agent.mcpTools.noScene(sceneId, p.id, ids));
  }
  return scene;
}

function describeSeam(r: SeamResult): string {
  const d = r.diffPercent;
  const verdict = d < SEAM_IMAGE_THRESHOLD ? 'invisible' : d < 5 ? 'a small visible jump' : 'a visible cut';
  return `${r.from} → ${r.to} (${r.format}): ${d.toFixed(2)} % of pixels differ, ${verdict}${r.error ? ` (error: ${r.error})` : ''}`;
}

function instructions(scope: McpScope): string {
  if (scope.kind === 'brand') return `Cadence tools for building the brand "${scope.brandId}" from the cloned repository.`;
  if (scope.kind === 'scene') {
    return `Cadence tools for scene "${scope.sceneId}" of project "${scope.projectId}": projectId and sceneId default to them.`;
  }
  if (scope.kind === 'project') return `Cadence tools for project "${scope.projectId}": projectId defaults to it.`;
  return 'Cadence motion-design studio. Pass projectId (the folder name under projects/) to every tool; start with get_project.';
}

/** A fresh MCP server bound to one token's scope. Tools outside the scope are not registered at all. */
export function createToolServer(ctx: ToolContext): McpServer {
  const { deps, scope, token } = ctx;
  const server = new McpServer({ name: 'cadence', version: '1.0.0' }, { instructions: instructions(scope) });
  const allowed = new Set(scope.kind === 'brand' ? BRAND_TOOLS : scope.kind === 'scene' ? SCENE_TOOLS : PROJECT_TOOLS);

  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
    readOnly = false,
  ) {
    if (!allowed.has(name)) return;
    const handler = async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      try {
        return await run(args);
      } catch (e) {
        return { content: [{ type: 'text', text: errorText(e) }], isError: true };
      }
    };
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, handler as never);
  }

  if (scope.kind === 'brand') {
    registerBrandTools(tool, scope, deps);
    return server;
  }

  async function project(projectId: string | undefined): Promise<ProjectState> {
    if (scope.kind === 'scene' || scope.kind === 'project') {
      if (projectId && projectId !== scope.projectId) {
        throw new HttpError(403, m().agent.mcpTools.otherProject(scope.projectId));
      }
      return deps.store.get(scope.projectId);
    }
    if (!projectId) {
      const ids = (await deps.store.list()).map((p) => p.id);
      throw new HttpError(400, m().agent.mcpTools.projectIdNeeded(ids));
    }
    return deps.store.get(assertId(projectId, m().api.ids.project));
  }

  /** The scene a tool acts on: a scene chat is bound to its own scene; other scopes must name one. */
  function targetScene(p: ProjectState, sceneId: string | undefined, denied: string): SceneState {
    if (scope.kind === 'scene') {
      if (sceneId && sceneId !== scope.sceneId) {
        throw new HttpError(403, m().agent.mcpTools.otherScene(scope.sceneId, denied));
      }
      return findScene(p, scope.sceneId);
    }
    if (!sceneId) throw new HttpError(400, m().agent.mcpTools.sceneIdNeeded(p.scenes.map((s) => s.id)));
    return findScene(p, sceneId);
  }

  const projectId = z
    .string()
    .optional()
    .describe(
      scope.kind === 'open'
        ? 'Project id: its folder name under projects/. Required.'
        : 'Project id. Optional: defaults to this chat’s project.',
    );
  const sceneId = z
    .string()
    .optional()
    .describe(scope.kind === 'scene' ? 'Scene id. Optional: defaults to this chat’s scene.' : 'Scene id (file scenes/<id>.tsx).');
  const format = z
    .enum(FORMAT_IDS as [FormatId, ...FormatId[]])
    .optional()
    .describe('Format to render; default: the project’s primary format.');

  tool(
    'get_project',
    'Structure of a project: formats, fps, tempo, every scene in order with start, duration, length in bars, and the file paths. Call it first when you need the structure.',
    { projectId },
    async (args) => text(projectOverview(await project(args.projectId))),
    true,
  );

  tool(
    'get_brand',
    'The project’s brand: colors, fonts, radii, voice, kit components, extras (with how to import them) and real product copy.',
    { projectId },
    async (args) => {
      const p = await project(args.projectId);
      return text(`${await deps.brands.describe(p.brand)}\n\nBrand folder (read-only): ${deps.brands.dir(p.brand ?? 'cadence')}`);
    },
    true,
  );

  tool(
    'get_music_context',
    'Tempo, beats, bars, phrases, sections and accents of the soundtrack, and the cuts. With a scene, times are that scene’s local seconds. Use it to key animations and durations to the music.',
    { projectId, sceneId },
    async (args) => {
      const p = await project(args.projectId);
      const target = args.sceneId ?? (scope.kind === 'scene' ? scope.sceneId : null);
      if (target) findScene(p, target);
      return text(await deps.music.context(p.id, target));
    },
    true,
  );

  tool(
    'list_templates',
    'Scene templates (create_scene with `template`) and campaign templates, with what to customize in each.',
    {},
    async () => text(await deps.templates.describe()),
    true,
  );

  tool(
    'render_frames',
    `Render frames exactly as the final video shows them, and look at them. Check every change: t = 0, t = duration and each moment you changed. Times are scene-local seconds (0 … duration); with wholeVideo they are video seconds and each frame shows the scene playing then. Up to ${MAX_FRAMES} frames per call.`,
    {
      projectId,
      sceneId,
      wholeVideo: z.boolean().optional().describe('Render video times instead of one scene.'),
      times: z.array(z.number().min(0)).min(1).max(MAX_FRAMES).describe('Seconds, e.g. [0, 0.8, 1.6, 3.32]'),
      format,
      quality: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe('low = quarter size (quick overview), normal = half size (default), high = full size (fine lines, small text)'),
    },
    async (args) => {
      const p = await project(args.projectId);
      if (args.wholeVideo && args.sceneId) throw new HttpError(400, m().agent.mcpTools.sceneOrVideo);
      const scene = args.wholeVideo ? null : targetScene(p, args.sceneId, m().agent.mcpTools.renderOwnScene);
      const chosen = args.format ?? p.formats[0];
      const scale = QUALITY_SCALE[args.quality ?? 'normal'];
      const limit = scene ? scene.duration : p.duration;
      const times = args.times.map((t) => roundMs(Math.min(t, limit)));
      const frames = await deps.capture.frames(p.id, {
        sceneId: scene?.id ?? null,
        times,
        format: chosen,
        scale,
        imageFormat: 'jpeg',
        quality: 82,
      });

      const dir = path.join(p.dir, '.cadence', 'frames');
      await fs.mkdir(dir, { recursive: true });
      const urls: string[] = [];
      for (const frame of frames) {
        const name = ctx.frameName(frame.mime === 'image/png' ? 'png' : 'jpg');
        await fs.writeFile(path.join(dir, name), frame.image);
        urls.push(`/api/projects/${p.id}/agent-frames/${name}`);
      }
      deps.tokens.reportActivity(token, { type: 'frames', sceneId: scene?.id ?? null, times, urls });

      const size = `${Math.round(FORMATS[chosen].width * scale)}×${Math.round(FORMATS[chosen].height * scale)}`;
      const what = scene
        ? `scene ${scene.id} "${scene.name}" (${scene.duration.toFixed(3)} s)`
        : `the whole video (${p.duration.toFixed(3)} s)`;
      const errors = [...new Set(frames.flatMap((f) => f.errors))];
      const summary = `Rendered ${frames.length} frame${frames.length === 1 ? '' : 's'} of ${what} in ${chosen} at ${size}.${
        errors.length ? `\nRender errors:\n${errors.join('\n\n')}` : ''
      }`;
      const content: Content[] = [{ type: 'text', text: summary }];
      for (const f of frames) {
        const label = scene
          ? `t = ${f.t.toFixed(3)} s`
          : `video t = ${f.t.toFixed(3)} s → scene ${f.sceneId ?? '?'} at ${f.localTime.toFixed(3)} s`;
        content.push({ type: 'text', text: label }, image(f.image, f.mime));
      }
      return { content, isError: frames.length > 0 && frames.every((f) => f.errors.length > 0) };
    },
    true,
  );

  tool(
    'check_seams',
    `Pixel-compare cuts: the last frame of a scene (t = duration) against the first frame of the next (t = 0), in every format of the project. Under ${SEAM_IMAGE_THRESHOLD} % of pixels a cut is invisible; above, it shows and comes back with both frames and a diff image. With a scene: the cuts into and out of it; without: every cut.`,
    { projectId, sceneId, format: format.describe('Format to check; default: every project format.') },
    async (args) => {
      const p = await project(args.projectId);
      const target =
        scope.kind === 'scene'
          ? targetScene(p, args.sceneId, m().agent.mcpTools.checkOwnSeams).id
          : args.sceneId
            ? findScene(p, args.sceneId).id
            : undefined;
      const results = await deps.seams.check(p.id, { sceneId: target, format: args.format });
      deps.tokens.reportActivity(token, { type: 'seams', results });
      if (!results.length) return text('No cut to check: the project has a single scene.');
      const content: Content[] = [{ type: 'text', text: results.map(describeSeam).join('\n') }];
      for (const r of results) {
        if (r.diffPercent < SEAM_IMAGE_THRESHOLD) continue;
        try {
          const d = await deps.seams.detail(p.id, r.from, r.to, r.format);
          content.push(
            { type: 'text', text: `${r.from} → ${r.to}: last frame of ${r.from}` },
            image(d.fromImage),
            { type: 'text', text: `first frame of ${r.to}` },
            image(d.toImage),
            { type: 'text', text: 'diff (changed pixels highlighted)' },
            image(d.diffImage),
          );
        } catch (e) {
          content.push({ type: 'text', text: `${r.from} → ${r.to}: images unavailable (${errorText(e)})` });
        }
      }
      return { content };
    },
    true,
  );

  tool(
    'set_scene_duration',
    'Change how long a scene lasts, in seconds with millisecond precision (min 0.1). Later scenes shift. A scene chat can only change its own scene.',
    { projectId, sceneId, seconds: z.number().min(0.1).max(3600).describe('New duration, e.g. 3.32') },
    async (args) => {
      const p = await project(args.projectId);
      const before = targetScene(p, args.sceneId, m().agent.mcpTools.setOwnDuration);
      const next = await deps.store.updateScene(p.id, before.id, { duration: roundMs(args.seconds) });
      const after = findScene(next, before.id);
      const barCount = Math.round((after.duration / barSeconds(next)) * 100) / 100;
      // Where every cut now falls against the soundtrack's bar lines (later cuts moved too).
      const cuts = (await deps.music.context(p.id).catch(() => '')).split('\n').find((line) => line.startsWith('Cuts:'));
      return text(
        `${after.id} now lasts ${after.duration.toFixed(3)} s (${barCount} bars; was ${before.duration.toFixed(3)} s). The video lasts ${next.duration.toFixed(3)} s.${cuts ? `\n${cuts}` : ''}`,
      );
    },
  );

  tool(
    'set_voice_over',
    'Set what the voice-over says over a scene, from `at` seconds into it; an empty text removes it. Cadence speaks it with the project voice (Piper) and answers when each sentence starts and ends, in scene seconds: key the animations to them (props.voiceOver.lines) and keep the scene at least as long as the voice. A scene chat can only change its own scene.',
    {
      projectId,
      sceneId,
      text: z.string().max(2000).describe('What the voice says: one or more sentences, in the video language. Empty removes it.'),
      at: z
        .number()
        .min(0)
        .max(600)
        .optional()
        .describe('Seconds into the scene where the voice starts, e.g. 0.5. Left out, the start stays (0 for a new voice-over).'),
    },
    async (args) => {
      const p = await project(args.projectId);
      const scene = targetScene(p, args.sceneId, m().agent.mcpTools.setOwnVoiceOver);
      const at = roundMs(args.at ?? scene.voiceOver?.at ?? 0);
      await deps.store.updateScene(p.id, scene.id, { voiceOver: { text: args.text, at } });
      if (!args.text.trim()) return text(`${scene.id} has no voice-over any more.`);
      try {
        await deps.voiceOver.sync(p.id);
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: `The text is saved, but the voice could not be generated: ${errorText(e)}. The user sees why in the Voice tab; do not retry until they fix it.`,
            },
          ],
          isError: true,
        };
      }
      return text(voiceOverSummary(await deps.store.get(p.id), scene.id));
    },
  );

  tool(
    'save_version',
    'Save the current state of the project as a named version (the user can restore it).',
    { projectId, label: z.string().trim().min(1).max(120) },
    async (args) => {
      const p = await project(args.projectId);
      const entry = await deps.versions.snapshot(p.id, { label: args.label, source: 'manual' });
      return text(
        entry
          ? `Saved version ${entry.id} "${entry.label}" (${entry.files.length} file${entry.files.length === 1 ? '' : 's'} changed since the previous one).`
          : 'Nothing changed since the latest version: no new version was needed.',
      );
    },
  );

  tool(
    'create_scene',
    'Add a scene from a scene template id (see list_templates) or from your own TSX `code`, after `after` (default: at the end). Then edit its file.',
    {
      projectId,
      name: z.string().trim().min(1).max(80),
      after: z.string().optional().describe('Insert after this scene id; default: at the end.'),
      template: z.string().optional().describe('Scene template id.'),
      code: z.string().max(200_000).optional().describe('Full TSX source (default export); overrides template.'),
      duration: z.number().min(0.1).max(3600).optional().describe('Seconds; default: the template’s bars at the tempo, else 3.'),
    },
    async (args) => {
      const p = await project(args.projectId);
      if (args.after) findScene(p, args.after);
      const scene = await deps.store.createScene(p.id, {
        name: args.name,
        after: args.after ?? null,
        template: args.template ?? null,
        code: args.code,
        duration: args.duration === undefined ? undefined : roundMs(args.duration),
      });
      return text(
        `Created scene ${scene.id} "${scene.name}" at position ${scene.index + 1}, ${scene.duration.toFixed(3)} s → ${scene.file}`,
      );
    },
  );

  tool(
    'duplicate_scene',
    'Copy a scene (code and duration) right after itself.',
    { projectId, sceneId: z.string() },
    async (args) => {
      const p = await project(args.projectId);
      const copy = await deps.store.duplicateScene(p.id, findScene(p, args.sceneId).id);
      return text(`Duplicated ${args.sceneId} as ${copy.id} → ${copy.file}`);
    },
  );

  tool(
    'delete_scene',
    'Remove a scene from the video. Its file moves to the project trash; the change is versioned.',
    { projectId, sceneId: z.string() },
    async (args) => {
      const p = await project(args.projectId);
      const next = await deps.store.deleteScene(p.id, findScene(p, args.sceneId).id);
      return text(`Removed ${args.sceneId}. Order: ${next.scenes.map((s) => s.id).join(' → ') || 'no scene left'}`);
    },
  );

  tool(
    'move_scene',
    'Move a scene to a new position (1 = first).',
    { projectId, sceneId: z.string(), position: z.number().int().min(1) },
    async (args) => {
      const p = await project(args.projectId);
      const moved = findScene(p, args.sceneId);
      const ids = p.scenes.map((s) => s.id).filter((id) => id !== moved.id);
      ids.splice(Math.min(args.position, p.scenes.length) - 1, 0, moved.id);
      const next = await deps.store.reorderScenes(p.id, ids);
      return text(`Order: ${next.scenes.map((s) => s.id).join(' → ')}`);
    },
  );

  tool(
    'rename_scene',
    'Rename a scene (the display name; the file name stays).',
    { projectId, sceneId: z.string(), name: z.string().trim().min(1).max(80) },
    async (args) => {
      const p = await project(args.projectId);
      await deps.store.updateScene(p.id, findScene(p, args.sceneId).id, { name: args.name });
      return text(`Renamed ${args.sceneId} to "${args.name}".`);
    },
  );

  tool(
    'snap_cuts_to_music',
    'Move every cut to the nearest beat, bar line or phrase start of the soundtrack (each scene keeps at least 0.4 s). With keepBars, every scene keeps its length in bars instead and the cuts land on the bar lines: the right choice for projects made from a campaign template, whose scenes are sized in bars and animated in beats.',
    {
      projectId,
      grid: z.enum(['beat', 'bar', 'phrase']).optional().describe('Default: bar. Ignored with keepBars.'),
      keepBars: z
        .boolean()
        .optional()
        .describe(
          'Keep each scene’s bar count (at the project tempo) and put the cuts on the bar lines of the track; the lead-in before bar 1 joins the first scene.',
        ),
    },
    async (args) => {
      const p = await project(args.projectId);
      const grid = args.grid ?? 'bar';
      const next = await deps.music.snapCuts(p.id, grid, { keepBars: args.keepBars });
      const done = args.keepBars
        ? 'Cuts moved to the bar lines, every scene keeping its bar count.'
        : `Cuts snapped to the ${grid} grid.`;
      return text(`${done}\n\n${sceneTable(next)}`);
    },
  );

  tool(
    'capture_reference',
    'Screenshot a web page (http or https) into assets/refs/ as reference material. Read the saved file to look at it.',
    {
      projectId,
      url: z.string(),
      device: z.enum(['desktop', 'mobile']).optional().describe('Default: desktop'),
      fullPage: z.boolean().optional(),
      name: z.string().optional().describe('File name without extension; derived from the URL by default.'),
    },
    async (args) => {
      const p = await project(args.projectId);
      let protocol = '';
      try {
        protocol = new URL(args.url).protocol;
      } catch {
        // invalid URL: rejected below
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new HttpError(400, m().agent.mcpTools.badUrl(args.url));
      }
      const info = await deps.assets.captureReference(p.id, {
        url: args.url,
        device: args.device ?? 'desktop',
        fullPage: args.fullPage,
        name: args.name,
      });
      return text(`Saved assets/${info.path} → ${deps.assets.resolve(p.id, info.path)}. Read that file to look at it.`);
    },
  );

  return server;
}
