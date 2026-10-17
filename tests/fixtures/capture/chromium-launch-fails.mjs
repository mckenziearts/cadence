// Preloaded (NODE_OPTIONS) into the Chromium host process of a test: its launch fails with CADENCE_TEST_LAUNCH_ERROR.
import { chromium } from 'playwright';

chromium.launchServer = async () => {
  throw new Error(process.env.CADENCE_TEST_LAUNCH_ERROR);
};
