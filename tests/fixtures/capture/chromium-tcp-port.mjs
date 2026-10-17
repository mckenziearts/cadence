// Preloaded (NODE_OPTIONS) into the Chromium host process of a test: its server listens on a TCP port, not its socket.
import { chromium } from 'playwright';

const launchServer = chromium.launchServer.bind(chromium);
chromium.launchServer = (options) => launchServer({ ...options, port: 0 });
