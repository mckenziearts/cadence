// The editor that embeds a frame or kit page. The server names the origins it may have (127.0.0.1 and localhost on the
// editor port); a message posted to an origin other than the parent's is dropped with a console warning, so each message
// goes to the parent's origin alone when the browser tells it (ancestorOrigins, else the referrer).
export const editorOrigins = (document.querySelector<HTMLMetaElement>('meta[name="cadence-editor-origin"]')?.content ?? '')
  .split(/\s+/)
  .filter(Boolean);

const parent = location.ancestorOrigins?.[0] ?? (document.referrer ? new URL(document.referrer).origin : '');
const targets = editorOrigins.includes(parent) ? [parent] : editorOrigins;

export function postToEditor(message: unknown): void {
  for (const origin of targets) window.parent.postMessage(message, origin);
}
