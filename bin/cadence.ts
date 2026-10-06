// Cadence CLI: `npm run cadence -- <command>` (see media.cli.help in server/i18n).
import { parseArgs } from 'node:util';
import { FORMAT_IDS, isFormatId, type FormatId, type RenderJob, type RenderQuality } from '../src/shared/types';
import { loadConfig } from '../server/config';
import { cliLanguage, m, setLanguage } from '../server/i18n';
import { FileSettingsStore } from '../server/settings';
import { FileBrandStore } from '../server/store/brands';
import { FileProjectStore } from '../server/store/projects';
import { FileTemplateStore } from '../server/store/templates';
import { FileVersionStore } from '../server/store/versions';
import { formatSeconds } from '../server/util';

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  // The terminal's language first: loadConfig() reports a bad CADENCE_PORT before the settings can be read.
  setLanguage(cliLanguage(null));
  setLanguage(cliLanguage((await new FileSettingsStore(loadConfig()).get()).language));
  switch (command) {
    case 'start':
      return start(args);
    case 'render':
      return render(args);
    case 'analyze':
      return analyze(args);
    case 'soundtracks':
      return soundtracks(args);
    case 'new':
      return create(args);
    case 'list':
      return list(args);
    case 'doctor': {
      parse(args, {});
      // Heavy modules load only for the commands that need them, so `doctor` works even when one is broken.
      const { runDoctor } = await import('../server/doctor');
      return (await runDoctor(loadConfig())) ? 0 : 1;
    }
    case 'mcp':
      return mcp(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(m().media.cli.help);
      return 0;
    default:
      throw new UsageError(m().media.cli.unknownCommand(command));
  }
}

async function start(args: string[]): Promise<number> {
  const { values } = parse(args, { port: { type: 'string' }, 'frame-port': { type: 'string' }, dev: { type: 'boolean' } });
  const { startServer } = await import('../server/index');
  const server = await startServer({ editorPort: port(values.port), framePort: port(values['frame-port']), dev: values.dev });
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    // Closing the terminal: without this, Cadence kept running on its ports.
    process.once('SIGHUP', stop);
  });
  console.log(`\n${m().media.cli.stopping}`);
  await server.close();
  return 0;
}

async function render(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      formats: { type: 'string' },
      quality: { type: 'string' },
      scale: { type: 'string' },
      fps: { type: 'string' },
      supersample: { type: 'boolean' },
    },
    true,
  );
  const projectId = positionals[0];
  if (!projectId) throw new UsageError(m().media.cli.noProject);
  const quality = (values.quality ?? 'standard') as RenderQuality;
  const scale = values.scale === undefined ? undefined : Number(values.scale);
  const fps = values.fps === undefined ? undefined : Number(values.fps);
  if (!['draft', 'standard', 'master'].includes(quality)) throw new UsageError(m().media.cli.unknownQuality(quality));
  if (scale !== undefined && ![0.5, 1, 2].includes(scale)) throw new UsageError(m().media.invalidScale(values.scale));
  if (fps !== undefined && ![24, 30, 60].includes(fps)) throw new UsageError(m().media.invalidFps(values.fps));

  const { startServer } = await import('../server/index');
  const server = await startServer({ editorPort: 0, framePort: 0, quiet: true });
  const { store, renders } = server.services;
  let jobs: RenderJob[] = [];
  const cancel = () => jobs.forEach((job) => renders.cancel(job.id));
  process.once('SIGINT', cancel);
  const progress = setInterval(() => {
    const line = m().media.cli.progress(
      renders
        .jobs(projectId)
        .filter((job) => jobs.some((j) => j.id === job.id))
        .map((job) => ({ format: job.format, percent: Math.round(job.progress * 100) })),
    );
    if (process.stdout.isTTY) process.stdout.write(`\r  ${line}   `);
  }, 500);
  try {
    const project = await store.get(projectId);
    const formats = values.formats ? formatList(values.formats) : project.formats;
    console.log(m().media.cli.exporting(project.name, formatSeconds(project.duration), formats.join(', '), quality));
    jobs = await renders.start(projectId, { formats, quality, scale, fps, supersample: values.supersample });
    let failed = 0;
    for (const job of jobs) {
      const done = await renders.wait(job.id);
      const t = m().media.cli;
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (done.status === 'done') console.log(`  ${t.done(done.format, `${store.dir(projectId)}/renders/${done.file}`)}`);
      else {
        failed++;
        console.log(`  ${t.failed(done.format, done.status === 'cancelled' ? t.cancelled : (done.error ?? t.failure))}`);
      }
    }
    return failed ? 1 : 0;
  } finally {
    clearInterval(progress);
    process.off('SIGINT', cancel);
    await server.close();
  }
}

async function analyze(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } }, true);
  if (!positionals[0]) throw new UsageError(m().media.cli.noAudio);
  const { runAnalyzeCli } = await import('../server/music/cli');
  await runAnalyzeCli(positionals[0], { json: values.json, ffmpegPath: loadConfig().ffmpegPath });
  return 0;
}

async function soundtracks(args: string[]): Promise<number> {
  const { positionals } = parse(args, {}, true);
  const { writeSoundtracks } = await import('../server/music/soundtracks');
  const config = loadConfig();
  await writeSoundtracks(`${config.root}/src/editor/soundtracks`, config.ffmpegPath, positionals);
  return 0;
}

async function create(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    { brand: { type: 'string' }, template: { type: 'string' }, formats: { type: 'string' }, fps: { type: 'string' } },
    true,
  );
  const name = positionals.join(' ').trim();
  if (!name) throw new UsageError(m().media.cli.noName);
  const config = loadConfig();
  const templates = new FileTemplateStore(config);
  const store = new FileProjectStore(config, { templates, brands: new FileBrandStore(config) });
  const template = values.template ? await templates.projectTemplate(values.template) : null;
  const project = await store.create({
    name,
    brand: values.brand ?? null,
    template: template?.id ?? null,
    formats: values.formats ? formatList(values.formats) : (template?.formats ?? ['16:9']),
    fps: values.fps ? Number(values.fps) : (template?.fps ?? 60),
    voiceOver: (await new FileSettingsStore(config).get()).defaultVoice,
  });
  const t = m().media.cli;
  await new FileVersionStore(store)
    .snapshot(project.id, { label: m().api.versions.initial, source: 'baseline' })
    .catch((e: Error) => console.warn(t.versionNotSaved(e.message)));
  console.log(t.created(project.name, t.scenes(project.scenes.length), project.dir));
  return 0;
}

async function list(args: string[]): Promise<number> {
  parse(args, {});
  const config = loadConfig();
  const projects = await new FileProjectStore(config).list();
  const t = m().media.cli;
  if (!projects.length) {
    console.log(t.empty);
    return 0;
  }
  for (const p of projects) {
    const scenes = t.scenes(p.sceneCount);
    console.log(
      `${p.id.padEnd(28)} ${p.name.padEnd(32)} ${(p.brand ?? 'cadence').padEnd(10)} ${scenes.padEnd(10)} ${formatSeconds(p.duration)}`,
    );
  }
  return 0;
}

async function mcp(args: string[]): Promise<number> {
  const { values } = parse(args, { port: { type: 'string' } });
  const config = loadConfig({ editorPort: port(values.port) });
  const { McpTokens } = await import('../server/mcp/tokens');
  const token = await new McpTokens(config).terminalToken();
  console.log(`${m().media.cli.mcp}\n`);
  console.log(`claude mcp add --transport http cadence ${config.mcpUrl} --header "Authorization: Bearer ${token}"\n`);
  return 0;
}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

function parse<T extends Options>(args: string[], options: T, positionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals, strict: true });
  } catch (e) {
    const { code, message } = e as Error & { code?: string };
    const subject = /'([^']+)'/.exec(message)?.[1];
    const errors: Record<string, (subject: string) => string> = m().media.cli.parseErrors;
    const describe = code ? errors[code] : undefined;
    throw new UsageError(describe && subject ? describe(subject) : message);
  }
}

function port(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(m().media.cli.invalidPort(value));
  return n;
}

function formatList(value: string): FormatId[] {
  const formats = value.split(',').map((f) => f.trim());
  for (const f of formats) {
    if (!isFormatId(f)) throw new UsageError(m().media.cli.unknownFormat(f, FORMAT_IDS.join(', ')));
  }
  return formats as FormatId[];
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    console.error(e instanceof UsageError ? `${e.message}\n\n${m().media.cli.help}` : e.message);
    process.exitCode = 1;
  },
);
