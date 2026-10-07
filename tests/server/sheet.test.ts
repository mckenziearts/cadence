import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Browser } from 'playwright';
import { PNG } from 'pngjs';
import { launchChromium } from '../../server/capture/capture';
import { contactSheet } from '../../server/capture/sheet';

const GREY = [128, 128, 128];

function tile(width: number, height: number, paint: (x: number, y: number) => number[]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) png.data.set([...paint(x, y), 255], (y * width + x) * 4);
  return PNG.sync.write(png);
}

/** A busy frame: a gradient under film grain, a hard-edged card and 1 px lines, worse than most scenes for JPEG. */
function textured(width: number, height: number, seed: number): Buffer {
  let state = seed;
  const grain = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) % 33) - 16;
  return tile(width, height, (x, y) => {
    if (x > width * 0.2 && x < width * 0.6 && y > height * 0.3 && y < height * 0.7)
      return y % 4 === 0 ? [20, 20, 20] : [245, 240, 230];
    return [(x * 255) / width + grain(), (y * 255) / height + grain(), ((x + y + seed) % 64) * 4];
  });
}

/** First luminance quantizer: Chromium's libjpeg tables give 6 at quality 82, 10 at 70 and 14 at 55. */
function quality(jpeg: Buffer): number {
  return jpeg[jpeg.indexOf(Buffer.from([0xff, 0xdb])) + 5];
}

function near(actual: number[], expected: number[], tolerance: number): boolean {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);
}

describe('contactSheet', () => {
  let browser: Browser | null = null;

  before(async () => {
    browser = await launchChromium().catch(() => null);
  });

  after(async () => {
    await browser?.close();
  });

  /** The sheet's size and the colour at each point, decoded by Chromium. */
  async function read(jpeg: Buffer, points: [number, number][]) {
    const page = await browser!.newPage();
    try {
      return await page.evaluate(
        async ({ data, points }) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          const colours = points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
          return { width: bitmap.width, height: bitmap.height, colours };
        },
        { data: jpeg.toString('base64'), points },
      );
    } finally {
      await page.close();
    }
  }

  test('lays tiles out in reading order at their exact origins, grey gaps, the last row short, as one JPEG', async (t) => {
    if (!browser) return t.skip('Chromium missing (npm run setup)');
    // Grey tiles and gaps on JPEG's 8 px blocks decode almost exactly: an origin off by a pixel shows.
    const levels = [0, 40, 210, 250, 90];
    const sheet = await contactSheet(
      browser,
      levels.map((v) => tile(24, 24, () => [v, v, v])),
      { columns: 3, gap: 8 },
    );
    assert.deepEqual([...sheet.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
    assert.equal(quality(sheet), 6, 'flat tiles keep quality 82');

    const origins = levels.map((_, i): [number, number] => [(i % 3) * 32, Math.floor(i / 3) * 32]);
    const corners = origins.flatMap(([x, y]): [number, number][] => [
      [x, y],
      [x + 23, y + 23],
    ]);
    const gaps: [number, number][] = [
      [31, 0],
      [0, 31],
      [63, 32],
      [70, 40],
    ];
    const { width, height, colours } = await read(sheet, [...corners, ...gaps]);
    assert.deepEqual([width, height], [3 * 24 + 2 * 8, 2 * 24 + 8]);
    levels.forEach((v, i) => {
      assert.ok(near(colours[2 * i], [v, v, v], 2), `tile ${i} at its origin: ${colours[2 * i]}`);
      assert.ok(near(colours[2 * i + 1], [v, v, v], 2), `tile ${i} last pixel: ${colours[2 * i + 1]}`);
    });
    colours.slice(corners.length).forEach((rgb, i) => assert.ok(near(rgb, GREY, 2), `gap or empty cell ${gaps[i]} grey: ${rgb}`));
  });

  test('fewer tiles than columns make a single row as wide as the tiles', async (t) => {
    if (!browser) return t.skip('Chromium missing (npm run setup)');
    const sheet = await contactSheet(browser, [tile(30, 20, () => [10, 20, 200]), tile(30, 20, () => [200, 20, 10])], {
      columns: 4,
      gap: 4,
    });
    const { width, height, colours } = await read(sheet, [
      [15, 10],
      [34 + 15, 10],
    ]);
    assert.deepEqual([width, height], [2 * 30 + 4, 20]);
    assert.ok(near(colours[0], [10, 20, 200], 12) && near(colours[1], [200, 20, 10], 12), String(colours));
  });

  test('24 textured quarter-size tiles drop below quality 82 to stay under 1 MB in base64, landscape and portrait', async (t) => {
    if (!browser) return t.skip('Chromium missing (npm run setup)');
    for (const [width, height, columns] of [
      [480, 270, 4],
      [270, 480, 6],
    ]) {
      const tiles = Array.from({ length: 24 }, (_, i) => textured(width, height, i + 1));
      const sheet = await contactSheet(browser, tiles, { columns, gap: 4 });
      const base64 = sheet.toString('base64').length;
      assert.ok(base64 < 1024 * 1024, `${width}x${height}: ${base64} bytes in base64`);
      assert.ok([10, 14].includes(quality(sheet)), `quality 70 or 55, table ${quality(sheet)}`);
      const read24 = await read(sheet, []);
      assert.deepEqual(
        [read24.width, read24.height],
        [columns * width + (columns - 1) * 4, (24 / columns) * height + (24 / columns - 1) * 4],
      );
    }
  });

  test('noise that fits at no quality still comes back, at 55 and well under the 5 MB Claude Code accepts', async (t) => {
    if (!browser) return t.skip('Chromium missing (npm run setup)');
    let state = 7;
    const noise = () => (state = (state * 1103515245 + 12345) % 2 ** 31) >> 23;
    const tiles = Array.from({ length: 24 }, () => tile(480, 270, () => [noise(), noise(), noise()]));
    const sheet = await contactSheet(browser, tiles, { columns: 4, gap: 4 });
    const base64 = sheet.toString('base64').length;
    assert.equal(quality(sheet), 14);
    assert.ok(base64 > 1024 * 1024 && base64 < 5 * 1024 * 1024, `${base64} bytes in base64`);
  });
});
