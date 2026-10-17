// Each project and each brand gets its own frame origin, so scene or kit code never shares an origin (storage,
// same-origin frames) with another project's or brand's. The editor and the server both derive it from the id here.
// One label right under localhost: with `<label>.project.localhost`, every project would be one site,
// `project.localhost`, and a cookie set for that domain would reach all of them.

export type FrameKind = 'project' | 'brand';

/**
 * The first 32 hex characters of SHA-256 of the id: an id may be 64 characters and start with `xn--`, a DNS label
 * neither. Async because the editor only has WebCrypto.
 */
export async function frameLabel(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `http://p-<label>.localhost:<port>` (`b-` for a brand) from the base, `CadenceConfig.frameOrigin`. */
export async function frameOriginOf(base: string, kind: FrameKind, id: string): Promise<string> {
  const { protocol, host } = new URL(base);
  return `${protocol}//${kind === 'project' ? 'p' : 'b'}-${await frameLabel(id)}.${host}`;
}

/** The kind and label a frame origin's host (`p-<label>.localhost:<port>`, `b-` for a brand) names, else null. */
export function frameSite(base: string, host: string): { kind: FrameKind; label: string } | null {
  const match = /^([pb])-([0-9a-f]{32})\.(.+)$/.exec(host.toLowerCase());
  return match && match[3] === new URL(base).host ? { kind: match[1] === 'p' ? 'project' : 'brand', label: match[2] } : null;
}
