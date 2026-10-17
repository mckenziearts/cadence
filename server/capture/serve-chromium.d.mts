import type { ChromiumOptions } from '../contracts';

export interface ServedChromium {
  /** What the server passes to `chromium.connect()`: `ws+unix:<socket>:<path>`. */
  wsEndpoint: string;
  /** The 0700 folder holding the socket; close() removes it, so does whoever outlives a process that died without it. */
  dir: string;
  /** Closes Chromium and removes `dir`. */
  close(): Promise<void>;
}

export function serveChromium(options: ChromiumOptions): Promise<ServedChromium>;
