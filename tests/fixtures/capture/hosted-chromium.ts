// Run by tests/e2e/capture.test.ts as a server process that dies: launches the capture Chromium, prints its pid, waits.
import { launchChromium } from '../../../server/capture/capture';

const browser = await launchChromium();
const session = await browser.newBrowserCDPSession();
const { processInfo } = await session.send('SystemInfo.getProcessInfo');
console.log(JSON.stringify({ browser: processInfo.find((info) => info.type === 'browser')!.id }));
setInterval(() => undefined, 60_000);
