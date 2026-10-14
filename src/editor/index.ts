// What a host app imports to build its own editor page (StartOptions.editorRoot). Every export is public contract.
import { openModal } from './store/ui';

export { App } from './App';
export { Profile } from './components/Profile';
export type { Pages } from './lib/routing';
export { api, ApiError } from './api';
export { useStore } from './store';
export { useT } from './i18n';

/** The core's "New brand" window: the repository picker, or the progress of the build `buildId`. */
export function openNewBrand(buildId?: string): void {
  openModal({ kind: 'new-brand', buildId });
}
