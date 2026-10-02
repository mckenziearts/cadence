// The music analysis off the server's thread (LocalMusicService): its signal processing would hold the server for about
// 1 s per 10 minutes of audio, and the memory it peaks at goes away with the worker. JavaScript, so that it loads tsx
// itself: Node 22.12 starts a worker's entry file without the --import hooks the server runs with.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { setLanguage } = await import('../i18n/index.ts');
const { analyzeMusic } = await import('./analyze.ts');
// A worker loads its own modules: its error messages follow the server's language only once told.
setLanguage(workerData.language);
parentPort.postMessage(await analyzeMusic(workerData.file, workerData.ffmpegPath));
