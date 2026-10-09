// The projects home in pages. The first holds the new-project card and 11 projects, the next ones 12 projects: every page
// fills 12 cells, whole rows at 2, 3 or 4 cards a row.
const FIRST = 11;
const NEXT = 12;

/** The projects of `page` (from 1, past the last one shows the last), the page they are on and the page count. */
export function projectsPage<T>(projects: readonly T[], page: number): { projects: T[]; page: number; pages: number } {
  const pages = projects.length <= FIRST ? 1 : 1 + Math.ceil((projects.length - FIRST) / NEXT);
  const shown = Math.min(page, pages);
  const start = shown === 1 ? 0 : FIRST + (shown - 2) * NEXT;
  return { projects: projects.slice(start, shown === 1 ? FIRST : start + NEXT), page: shown, pages };
}
