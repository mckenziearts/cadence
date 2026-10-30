// The text walk of the frame audit (src/frame/audit.ts) on a fixed stage in Chromium, without the frame harness, so these
// run in CI: runtime decor (motion blur copies) is skipped whole and outside the text node budget.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Browser, Page } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build, type Rolldown } from 'vite';
import { launchChromium } from '../../server/capture/capture';
import { MotionBlur } from '../../src/runtime/motionBlur';
import type { AuditFinding } from '../../src/shared/frameProtocol';
import { FORMATS } from '../../src/shared/types';

let browser: Browser | undefined;
let page: Page;
let script: string;

before(async () => {
  const built = [
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(import.meta.dirname, '../../src/frame/audit.ts'), formats: ['iife'], name: 'cadenceAudit' },
      },
    }),
  ].flat()[0] as Rolldown.RolldownOutput;
  script = built.output[0].code;
  try {
    browser = await launchChromium();
  } catch (e) {
    if (!/Executable doesn't exist/i.test((e as Error).message)) throw e;
    return;
  }
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
});

after(async () => {
  await browser?.close();
});

/** Skips a test that needs Chromium, except in CI, where the workflow installs it and a skip would hide the check. */
function needsChromium(t: TestContext): boolean {
  if (browser) return true;
  assert.ok(!process.env.CI, 'Chromium missing in CI: the workflow must run npm run setup');
  t.skip('Chromium missing (npm run setup)');
  return false;
}

const line = (top: number, text: string) =>
  `<p style="position:absolute;left:1700px;top:${top}px;margin:0;font-size:40px;white-space:nowrap">${text}</p>`;
/** Small labels inside the safe area, each in `depth` nested elements. */
const labels = (count: number, depth = 1) =>
  Array.from(
    { length: count },
    (_, i) =>
      `<span style="position:absolute;left:${200 + (i % 30) * 50}px;top:${200 + Math.floor(i / 30) * 30}px;font-size:16px">` +
      '<b>'.repeat(depth - 1) +
      i +
      '</b>'.repeat(depth - 1) +
      '</span>',
  ).join('');

async function audit(stage: string): Promise<string[]> {
  await page.setContent(
    `<body style="margin:0"><div data-cadence-stage style="position:relative;width:1920px;height:1080px;overflow:hidden;background:#ffffff;color:#111111">${stage}</div></body>`,
  );
  await page.addScriptTag({ content: script });
  const findings = await page.evaluate(
    (spec) =>
      (Reflect.get(window, 'cadenceAudit') as typeof import('../../src/frame/audit')).auditStage(
        document.querySelector<HTMLElement>('[data-cadence-stage]')!,
        spec,
      ),
    FORMATS['16:9'],
  );
  return findings.map((f: AuditFinding) => `${f.kind} ${f.text}`);
}

test('skips the text of runtime decor whole, and keeps it out of the 500 text node budget', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const decor = `<div data-cadence-decor="" style="position:absolute;inset:0">${line(100, 'Decor past the edge')}${labels(600)}</div>`;
  assert.deepEqual(await audit(`${decor}${line(900, 'Scene past the edge')}`), ['offCanvas Scene past the edge']);
});

test('judges the text under a MotionBlur once, from the copy at t', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  const title = () =>
    createElement(
      'p',
      { style: { position: 'absolute', left: 1700, top: 900, margin: 0, fontSize: 40, whiteSpace: 'nowrap' } },
      'Blurred title past the edge',
    );
  const blurred = renderToStaticMarkup(createElement(MotionBlur, { t: 1, fps: 30, children: title }));
  assert.deepEqual(await audit(blurred), ['offCanvas Blurred title past the edge']);
});

test('judges the 500th text node and stops after it', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  assert.deepEqual(await audit(`${labels(499)}${line(900, 'Scene past the edge')}`), ['offCanvas Scene past the edge']);
  assert.deepEqual(await audit(`${labels(500)}${line(900, 'Scene past the edge')}`), []);
});

test('counts text nodes toward the budget, not the elements around them', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  // 450 labels in 3 elements each: 1800 nodes, 450 of them text.
  assert.deepEqual(await audit(`${labels(450, 3)}${line(900, 'Scene past the edge')}`), ['offCanvas Scene past the edge']);
});

test('still judges scene text hidden from assistive tech', { timeout: 30_000 }, async (t) => {
  if (!needsChromium(t)) return;
  assert.deepEqual(await audit(`<div aria-hidden="true">${line(900, 'Hidden from readers, past the edge')}</div>`), [
    'offCanvas Hidden from readers, past the edge',
  ]);
});
