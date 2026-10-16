// The core's Chromium host process (browser-host.ts forks it): serveChromium() with the options it gets, its endpoint
// sent over IPC, and Chromium closed once the server lets go of the channel.
import fs from 'node:fs';
import { serveChromium } from './serve-chromium.mjs';

// Ctrl+C, a closed terminal and a SIGTERM sent to the process group reach this process too: it lives as long as the
// server keeps its IPC channel open, so the server stops its renders before Chromium goes.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);
process.on('SIGHUP', () => undefined);

try {
  const { wsEndpoint, dir, close } = await serveChromium(JSON.parse(process.argv[2]));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const end = () => void close().finally(() => process.exit(0));
  if (process.connected) {
    process.on('disconnect', end);
    process.send({ wsEndpoint, dir });
  } else end();
} catch (e) {
  // Chromium may run already (launchServer failed after starting it): exiting closes its pipe, which ends it too.
  process.exitCode = 1;
  if (process.connected) process.send({ error: e instanceof Error ? e.message : String(e) }, () => process.exit());
  else process.exit();
}
