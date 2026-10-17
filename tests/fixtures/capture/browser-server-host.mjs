// A host app's own Chromium process (StartOptions.browserServer), standing in for its utility process: serveChromium()
// with the core's options, the endpoint and socket folder sent over IPC, Chromium closed when the host lets go.
import { serveChromium } from '../../../server/capture/serve-chromium.mjs';

try {
  const { wsEndpoint, dir, close } = await serveChromium(JSON.parse(process.argv[2]));
  process.on('disconnect', () => void close().finally(() => process.exit(0)));
  process.send({ wsEndpoint, dir });
} catch (e) {
  process.send({ error: e instanceof Error ? e.message : String(e) }, () => process.exit(1));
}
