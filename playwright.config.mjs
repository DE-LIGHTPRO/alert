import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test-e2e",
  testMatch: "**/*.spec.mjs",
  // Writes are serialised against one anvil, and the amount binding refuses two open
  // escrows that share a figure, so parallel workers would collide on purpose-built
  // state rather than on a bug.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./test-e2e/global-setup.mjs",
  globalTeardown: "./test-e2e/global-teardown.mjs",
  use: {
    baseURL: "http://127.0.0.1:5173",
    // CI downloads Playwright's own Chromium, which is the browser this suite is meant
    // to run on. Set PW_CHANNEL=chrome to drive an installed Google Chrome instead,
    // which is the way to get a run locally when the 190MB download will not complete
    // on the connection available. It is an escape hatch, not the default: a pass
    // against a different browser build is weaker evidence than a pass against the
    // pinned one, so CI never takes this path.
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    // The whole point is to catch what unit tests cannot, so keep the evidence when it
    // fails: a screenshot of the actual screen and the steps that led there.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test-e2e/serve.mjs",
    url: "http://127.0.0.1:5173/app.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
