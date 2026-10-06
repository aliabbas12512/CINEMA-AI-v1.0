import { defineConfig, devices } from "@playwright/test";

/**
 * Critical UI flow tests against a running app + worker:
 *   npm run build && npm start   (and)   npm run worker
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
