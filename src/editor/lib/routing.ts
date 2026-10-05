// The editor's hash router: #/<project>/<scene>, #/@<page>, or the home. Page ids start with @, which no project id
// can (ID_PATTERN), so a page never shadows a project.
import type { ComponentType } from 'react';

/** Screens a host app adds to the editor (or core ones it replaces), by page id: `#/@compte` opens `pages['@compte']`. */
export type Pages = Record<`@${string}`, ComponentType>;

export interface Route {
  page: string | null;
  projectId: string | null;
  sceneId: string | null;
}

export function parseHash(hash: string): Route {
  const [first, sceneId] = decodeURIComponent(hash.replace(/^#\/?/, '')).split('/');
  if (first.startsWith('@')) return { page: first, projectId: null, sceneId: null };
  return { page: null, projectId: first || null, sceneId: sceneId || null };
}

/** The screen a page id opens: the host's first, then the core's; null when neither has it. */
export function resolvePage(id: string, pages: Pages | undefined, core: Pages): ComponentType | null {
  const key = id as keyof Pages;
  return pages?.[key] ?? core[key] ?? null;
}
