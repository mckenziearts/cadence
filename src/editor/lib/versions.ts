// What the versions panel lists out of a project's history.
import type { VersionEntry, VersionSource } from '../../shared/types';

/** Undo steps: one per editor write, plus the undos and redos that walk them. Cmd-Z reaches them, the list stays readable. */
const HIDDEN: ReadonlySet<VersionSource> = new Set(['edit', 'undo', 'redo']);

/**
 * The listed entries, newest first. `latest` is the newest of the whole history: a row older than a hidden step is not
 * the current state, so it keeps its restore button.
 */
export function shownVersions(entries: VersionEntry[]): { entry: VersionEntry; latest: boolean }[] {
  return entries.filter((entry) => !HIDDEN.has(entry.source)).map((entry) => ({ entry, latest: entry === entries[0] }));
}
