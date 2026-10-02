import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FORMAT_IDS, ID_PATTERN, type ProjectTemplateMeta, type SceneTemplateMeta } from '../../src/shared/types';
import type { CadenceConfig, TemplateStore } from '../contracts';
import { language, m } from '../i18n';
import { HttpError, assertId } from '../util';

const CATEGORIES = ['intro', 'title', 'ui', 'feature', 'data', 'transition', 'outro'] as const;

const sceneTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.enum(CATEGORIES),
  bars: z.number().positive(),
  formats: z.array(z.enum(FORMAT_IDS)).min(1),
  tags: z.array(z.string()).default([]),
  customize: z.array(z.string()).default([]),
  /** The same texts in English, for an English interface. */
  en: z
    .object({ name: z.string().min(1), description: z.string(), tags: z.array(z.string()), customize: z.array(z.string()) })
    .optional(),
});

const projectTemplateSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    fps: z.literal([24, 30, 60]),
    formats: z.array(z.enum(FORMAT_IDS)).min(1),
    bpm: z.number().min(30).max(300),
    scenes: z
      .array(z.object({ template: z.string().regex(ID_PATTERN), name: z.string().min(1), bars: z.number().positive() }))
      .min(1),
    /** The same texts in English, for an English interface; `scenes` names the scenes in order. */
    en: z.object({ name: z.string().min(1), description: z.string(), scenes: z.array(z.string().min(1)) }).optional(),
  })
  .refine((t) => !t.en || t.en.scenes.length === t.scenes.length, {
    path: ['en', 'scenes'],
    error: () => m().api.templates.sceneNames,
  });

/** Scene templates (templates/scenes/<id>/) and campaign templates (templates/projects/<id>/). */
export class FileTemplateStore implements TemplateStore {
  constructor(private config: CadenceConfig) {}

  async scenes(): Promise<SceneTemplateMeta[]> {
    const out: SceneTemplateMeta[] = [];
    for (const id of await this.ids('scenes')) {
      try {
        out.push((await this.sceneTemplate(id)).meta);
      } catch (e) {
        console.warn(m().api.templates.sceneSkipped((e as Error).message));
      }
    }
    return out.sort(
      (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name, 'fr'),
    );
  }

  async projects(): Promise<ProjectTemplateMeta[]> {
    const out: ProjectTemplateMeta[] = [];
    for (const id of await this.ids('projects')) {
      try {
        const { artDirection: _, ...meta } = await this.projectTemplate(id);
        out.push(meta);
      } catch (e) {
        console.warn(m().api.templates.projectSkipped((e as Error).message));
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async sceneTemplate(id: string): Promise<{ meta: SceneTemplateMeta; code: string }> {
    const dir = this.dir('scenes', id);
    const raw = await readTemplateJson(dir, m().api.templates.sceneNotFound(id));
    const { en, ...meta } = validate(sceneTemplateSchema, raw, `templates/scenes/${id}/template.json`);
    const code = await fs.readFile(path.join(dir, 'scene.tsx'), 'utf8').catch(() => {
      throw new HttpError(500, m().api.templates.missingCode(`templates/scenes/${id}/scene.tsx`));
    });
    return { meta: { id, ...meta, ...(language() === 'en' ? en : {}) }, code };
  }

  async projectTemplate(id: string): Promise<ProjectTemplateMeta & { artDirection: string | null }> {
    const dir = this.dir('projects', id);
    const raw = await readTemplateJson(dir, m().api.templates.projectNotFound(id));
    const { en, ...meta } = validate(projectTemplateSchema, raw, `templates/projects/${id}/template.json`);
    const artDirection = await fs.readFile(path.join(dir, 'art-direction.md'), 'utf8').catch(() => null);
    const english =
      language() === 'en' && en
        ? { name: en.name, description: en.description, scenes: meta.scenes.map((s, i) => ({ ...s, name: en.scenes[i] })) }
        : {};
    return { id, ...meta, ...english, artDirection };
  }

  async describe(): Promise<string> {
    const [scenes, projects] = await Promise.all([this.scenes(), this.projects()]);
    const lines = [
      '# Templates',
      '',
      '## Scene templates',
      '',
      'Insert one with `create_scene` and its template id. Templates only use the brand kit (`useBrand()`) and',
      '`useFormat()`, so they work with every brand and format. Edit the constants at the top (`COPY`…) after inserting.',
    ];
    if (!scenes.length) lines.push('', 'No scene templates installed yet.');
    for (const category of CATEGORIES) {
      const group = scenes.filter((s) => s.category === category);
      if (!group.length) continue;
      lines.push('', `### ${category}`, '');
      for (const s of group) {
        const extra = [
          s.customize.length ? `Customize: ${s.customize.join('; ')}.` : '',
          s.tags.length ? `Tags: ${s.tags.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' ');
        lines.push(
          `- \`${s.id}\`: **${s.name}** · ${s.bars} bars · ${s.formats.join(', ')}. ${s.description}${extra ? ` ${extra}` : ''}`,
        );
      }
    }
    lines.push('', '## Campaign templates', '');
    if (!projects.length) lines.push('No campaign templates installed yet.');
    for (const p of projects) {
      const flow = p.scenes.map((s) => `${s.template} "${s.name}" (${s.bars} bars)`).join(' → ');
      lines.push(
        `- \`${p.id}\`: **${p.name}** · ${p.fps} fps · ${p.formats.join(', ')} · ${p.bpm} BPM. ${p.description} Scenes: ${flow}.`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  private dir(kind: 'scenes' | 'projects', id: string): string {
    return path.join(this.config.templatesDir, kind, assertId(id, m().api.ids.template));
  }

  private async ids(kind: 'scenes' | 'projects'): Promise<string[]> {
    const entries = await fs.readdir(path.join(this.config.templatesDir, kind), { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && ID_PATTERN.test(e.name)).map((e) => e.name);
  }
}

async function readTemplateJson(dir: string, notFound: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, 'template.json'), 'utf8');
  } catch {
    throw new HttpError(404, notFound);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(500, m().api.unreadableFile(`${path.basename(dir)}/template.json`, (e as Error).message));
  }
}

function validate<T extends z.ZodType>(schema: T, raw: unknown, label: string): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ');
    throw new HttpError(500, m().api.invalidFile(label, issues));
  }
  return parsed.data;
}
