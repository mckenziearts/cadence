// The agent's capture of a host the person has not approved: the ask the editor shows, until they allow or dismiss it.
import type { ServerEvent } from '../../shared/types';
import type { CaptureHostAsk, EditorState } from '../store';

type Asks = Pick<EditorState, 'captureAsk' | 'captureIgnored'>;

/**
 * The ask an event raises in the open project, or null. The first ask stays until the person answers: a later one would
 * swap the host under their click. The agent asks again in a later turn.
 */
export function raisedAsk(
  asks: Asks,
  event: Extract<ServerEvent, { type: 'capture-host' }>,
  projectId: string | undefined,
): CaptureHostAsk | null {
  if (event.projectId !== projectId || asks.captureAsk || asks.captureIgnored.includes(event.host)) return null;
  return { projectId, host: event.host, local: event.local };
}

/** Null once `ask` is gone: another project was opened while the approval was on its way, maybe with its own ask. */
export function allowedAsk(asks: Asks, ask: CaptureHostAsk): Pick<Asks, 'captureAsk'> | null {
  return asks.captureAsk === ask ? { captureAsk: null } : null;
}

/** A dismissed host is not asked again while the project stays open. */
export function dismissedAsk(asks: Asks, ask: CaptureHostAsk): Asks {
  return { captureAsk: null, captureIgnored: [...asks.captureIgnored, ask.host] };
}
