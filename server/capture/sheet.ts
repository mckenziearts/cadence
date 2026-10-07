// Contact sheets: frames of the same size side by side in one JPEG, so the agent sees a motion in a single image.
// JPEG like the single frames: a lossless sheet of 24 tiles goes past the 5 MB Claude Code accepts per image.
import type { Browser } from 'playwright';

/** Tried in turn until the sheet fits: grain or a photo behind every frame needs the lower ones. */
const QUALITIES = [82, 70, 55];
/** Base64 bytes a sheet stays under when a quality allows, far from the 5 MB limit. */
const MAX_BASE64 = 1024 * 1024;
/** Neutral grey between tiles, visible on dark and light frames. */
const BACKGROUND = '#808080';

/**
 * PNG tiles of one size in reading order, `columns` per row, `gap` px apart. The page holds only data URLs, runs no
 * script and has every request refused: it loads nothing and is not the frame origin.
 */
export async function contactSheet(browser: Browser, tiles: Buffer[], layout: { columns: number; gap: number }): Promise<Buffer> {
  // Width and height of a PNG, big-endian in its IHDR chunk.
  const width = tiles[0].readUInt32BE(16);
  const height = tiles[0].readUInt32BE(20);
  const columns = Math.min(layout.columns, tiles.length);
  const rows = Math.ceil(tiles.length / columns);
  const context = await browser.newContext({
    viewport: { width: columns * width + (columns - 1) * layout.gap, height: rows * height + (rows - 1) * layout.gap },
    javaScriptEnabled: false,
  });
  try {
    await context.route('**', (route) => route.abort().catch(() => undefined));
    const page = await context.newPage();
    const images = tiles.map((tile) => `<img src="data:image/png;base64,${tile.toString('base64')}">`).join('');
    await page.setContent(
      `<!doctype html><style>body{margin:0;display:grid;grid-template-columns:repeat(${columns},${width}px);` +
        `grid-auto-rows:${height}px;gap:${layout.gap}px;background:${BACKGROUND}}img{display:block}</style>${images}`,
    );
    let sheet: Buffer = Buffer.alloc(0);
    for (const quality of QUALITIES) {
      sheet = await page.screenshot({ type: 'jpeg', quality });
      if (Math.ceil(sheet.length / 3) * 4 <= MAX_BASE64) break;
    }
    return sheet;
  } finally {
    await context.close().catch(() => undefined);
  }
}
