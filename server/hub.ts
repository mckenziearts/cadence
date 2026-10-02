// Adapted from saeedvaziry/caleb-video-editor (MIT)
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerEvent } from '../src/shared/types';
import type { Hub } from './contracts';

const PING_MS = 20_000;

/** Server-to-editor events over Server-Sent Events. */
export class SseHub implements Hub {
  private clients = new Set<ServerResponse>();

  send(event: ServerEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(data);
  }

  handleSse(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    // res, not req: an IncomingMessage may close as soon as its (empty) body has been read.
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }
}
