// Preloaded (NODE_OPTIONS) into the Chromium host process of a test: the host closes its Chromium when the server lets
// it go, then never exits, like a host stuck in its own cleanup.
process.exit = () => undefined;
setInterval(() => undefined, 60_000);
