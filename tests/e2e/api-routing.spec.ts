import { expect, test } from '@playwright/test';

const runApiRouting = process.env.RUN_API_ROUTING === '1';

test.describe('deployed API routing', () => {
  test.skip(!runApiRouting, 'Set RUN_API_ROUTING=1 and FRONTEND_URL to run deployed API routing checks.');

  test('returns JSON for health, production, MES, AI, and API 404 routes', async ({ request, baseURL }) => {
    const rootUrl = baseURL || process.env.FRONTEND_URL || 'https://wj-reporting.onrender.com';
    const checks = [
      { path: '/api/health/', status: 200 },
      { path: '/api/production/plan-summary/?date=2026-05-18', status: 200 },
      { path: '/api/production/mes-report-stats/?date=2026-05-18&plan_type=machining', status: 200 },
      { path: '/api/production/ai/briefing/?date=2026-05-18&language=ko', status: 200 },
      { path: '/api/_operational_qa_missing_endpoint', status: 404 },
    ];

    for (const check of checks) {
      const response = await request.get(new URL(check.path, rootUrl).toString());
      expect(response.status(), check.path).toBe(check.status);
      expect(response.headers()['content-type'], check.path).toContain('application/json');
      const body = await response.text();
      expect(body, check.path).not.toContain('<html');
      expect(() => JSON.parse(body), check.path).not.toThrow();
    }
  });

  test('serves index.html for frontend routes', async ({ page }) => {
    const response = await page.goto('/production');

    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
    await expect(page.locator('#root')).toBeAttached();
  });
});
