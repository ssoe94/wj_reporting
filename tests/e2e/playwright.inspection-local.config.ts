import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const baseURL = 'http://127.0.0.1:5193';

/** Local fixture acceptance only. The spec rejects every unmatched API/external request. */
export default defineConfig({
  testDir: './operational',
  testMatch: 'inspection-requests.spec.ts',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: '../../test-results/inspection-local',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    launchOptions: process.env.WJ_INSPECTION_CHROME
      ? { executablePath: process.env.WJ_INSPECTION_CHROME } : {},
  },
  projects: [
    { name: 'ko-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } },
    { name: 'zh-mobile', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 843 } } },
  ],
  webServer: {
    cwd: path.resolve(__dirname, '../..'),
    command: "WJ_STATIC_ROOT=output/inspection-fixture-dist WJ_STATIC_HOST=127.0.0.1 WJ_STATIC_PORT=5193 WJ_STATIC_API_PROXY='' node scripts/serve-render-static.mjs",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
