// Environment checks: `npm run doctor`. Exit code 1 while something required is missing.
// Adapted from saeedvaziry/caleb-video-editor (MIT)
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { ClaudeCodeProvider } from './agent/claudeCode';
import type { CadenceConfig } from './contracts';
import { m } from './i18n';

const run = promisify(execFile);

interface Check {
  /** fail: Cadence cannot work until it is fixed; warn: works, with a caveat. */
  level: 'ok' | 'fail' | 'warn';
  label: string;
  fix?: string;
}

const MARKS = { ok: '✓', fail: '✗', warn: '!' };
const PLATFORMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };
const COLORS = { ok: 32, fail: 31, warn: 33 };

/** Print every check with its fix; resolves to true when nothing required is missing. */
export async function runDoctor(config: CadenceConfig): Promise<boolean> {
  const t = m().media.doctor;
  console.log(`\n${t.title}\n`);
  const [tools, ports] = await Promise.all([
    Promise.all([
      checkPlatform(),
      checkNode(),
      checkFfmpeg(config.ffmpegPath),
      checkFfprobe(config.ffprobePath),
      checkChromium(),
      checkClaude(config),
    ]),
    Promise.all([
      checkPort(config.editorPort, config.host, t.editor, 'CADENCE_PORT'),
      checkPort(config.framePort, config.host, t.frames, 'CADENCE_FRAME_PORT'),
    ]),
  ]);
  const checks = [...tools, ...ports];
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  for (const check of checks) {
    console.log(`  ${paint(COLORS[check.level], MARKS[check.level])} ${check.label}`);
    if (check.fix) console.log(`    ${paint(90, '→')} ${check.fix}`);
  }
  const failed = checks.filter((c) => c.level === 'fail').length;
  // A taken port is most often Cadence itself, already running.
  const ready = ports.some((c) => c.level === 'warn') ? t.readyBusy(config.editorOrigin) : t.ready(config.editorOrigin);
  console.log(failed ? `\n${t.failed(failed)}\n` : `\n${ready}\n`);
  return failed === 0;
}

function checkPlatform(): Check {
  return process.platform === 'win32'
    ? { level: 'fail', label: m().core.windows }
    : { level: 'ok', label: `${PLATFORMS[process.platform] ?? process.platform} (${process.arch})` };
}

function checkNode(): Check {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12)
    ? { level: 'ok', label: `Node.js ${process.versions.node}` }
    : { level: 'fail', label: m().media.doctor.nodeOld(process.versions.node), fix: m().media.doctor.nodeFix };
}

async function checkFfmpeg(bin: string): Promise<Check> {
  let version: string;
  try {
    version = (await run(bin, ['-version'])).stdout.match(/ffmpeg version (\S+)/)?.[1] ?? '';
  } catch {
    return { level: 'fail', label: m().media.doctor.ffmpegMissing(bin), fix: m().media.doctor.ffmpegFix };
  }
  // Renders are H.264 + AAC.
  const { stdout } = await run(bin, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024 });
  const missing = ['libx264', 'aac'].filter((name) => !new RegExp(`\\s${name}\\s`).test(stdout));
  return missing.length
    ? { level: 'fail', label: m().media.doctor.encoders(version, missing), fix: m().media.doctor.encodersFix }
    : { level: 'ok', label: `ffmpeg ${version} (libx264, aac)` };
}

async function checkFfprobe(bin: string): Promise<Check> {
  try {
    const version = (await run(bin, ['-version'])).stdout.match(/ffprobe version (\S+)/)?.[1] ?? '';
    return { level: 'ok', label: `ffprobe ${version}` };
  } catch {
    return { level: 'fail', label: m().media.doctor.ffprobeMissing(bin), fix: m().media.doctor.ffprobeFix };
  }
}

async function checkChromium(): Promise<Check> {
  try {
    // Imported here: Playwright throws at import on a Node.js too old, and checkNode() must still report it.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const version = browser.version();
    await browser.close();
    return { level: 'ok', label: `Chromium ${version} (Playwright)` };
  } catch (e) {
    const message = (e as Error).message;
    if (/Executable doesn't exist/i.test(message))
      return { level: 'fail', label: m().media.doctor.chromiumMissing, fix: 'npm run setup' };
    return {
      level: 'fail',
      label: m().media.doctor.chromiumFailed(message.split('\n')[0]),
      fix: process.platform === 'linux' ? m().media.doctor.chromiumLibraries : 'npm run setup',
    };
  }
}

async function checkClaude(config: CadenceConfig): Promise<Check> {
  // The check the editor shows above its chat: both always agree, an API key allowed by CADENCE_USE_API_KEY included.
  const status = await new ClaudeCodeProvider(config).status();
  const t = m().media.doctor;
  if (!status.version) return { level: 'fail', label: t.claudeMissing(config.claudePath), fix: t.claudeInstall };
  if (!status.ok) return { level: 'fail', label: t.claudeLoggedOut(status.version), fix: t.claudeLogin };
  return { level: 'ok', label: t.claudeReady(status.version, status.detail) };
}

async function checkPort(port: number, host: string, role: string, variable: string): Promise<Check> {
  const free = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
  const t = m().media.doctor;
  return free
    ? { level: 'ok', label: t.portFree(port, role) }
    : { level: 'warn', label: t.portBusy(port, role), fix: t.portFix(variable) };
}
