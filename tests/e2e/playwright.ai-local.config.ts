import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const baseURL = 'http://127.0.0.1:5189';

/** Fixture-only AI acceptance: requests are intercepted and unmatched API/external traffic is blocked. */
export default defineConfig({
  testDir: './operational',
  testMatch: 'production-ai-daily.spec.ts',
  timeout: 45_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/ai-daily-local',
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  projects: [
    { name: 'ko-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } },
    { name: 'zh-mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    cwd: path.resolve(__dirname, '../..'),
    command: 'VITE_ENABLE_DEV_LOGIN=true VITE_USE_REMOTE_PRODUCTION_API=true VITE_API_BASE_URL=http://127.0.0.1:5189/api npm --prefix frontend run dev -- --host 127.0.0.1 --port 5189 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
