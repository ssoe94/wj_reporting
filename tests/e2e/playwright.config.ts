import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.FRONTEND_URL || 'http://127.0.0.1:5174';
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === '1';

export default defineConfig({
  testDir: '.',
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html'],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: skipWebServer
    ? undefined
    : {
      command: 'cd ../.. && npm --prefix frontend-next run dev:render',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
});
