import { defineConfig, devices } from '@playwright/test';

/**
 * The docs site's browser pass: the specs under e2e/ drive the static export (`pnpm --filter @simulci/docs build`
 * first) as e2e/serve.ts serves it, with vercel.json's clean URLs and headers, in headless Chromium. The port is not
 * the web app's (4173), so both passes can run on one machine, and it must be free: a server already on it is never
 * the one tested.
 */

const PORT = Number(process.env.PORT ?? 4183);
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: CI,
  reporter: CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
