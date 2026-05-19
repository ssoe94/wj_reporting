import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('frontend-next operational shell', () => {
  test('dev session can open production routes and switch Korean/Chinese UI', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production');

    await expect(page.getByRole('heading', { name: '생산 대시보드' })).toBeVisible();
    await expect(page.locator('a[href="/production/plans"]')).toContainText('생산 계획');
    await expect(page.locator('a[href="/mes/monitoring"]')).toContainText('MES 모니터링');
    await expect(page.locator('a[href="/analysis"]')).toContainText('분석');
    await expect(page.locator('a[href="/inventory"]')).toContainText('재고');
    await expectNoUndefinedOrNaN(page);

    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.getByRole('heading', { name: '生产看板' })).toBeVisible();
    await expect(page.locator('a[href="/production/plans"]')).toContainText('生产计划');
    await expectNoUndefinedOrNaN(page);

    await page.getByRole('button', { name: '한국어' }).click();
    await page.locator('a[href="/production/plans"]').click();
    await expect(page.getByRole('heading', { name: '생산 계획 업데이트' })).toBeVisible();
    await expectNoUndefinedOrNaN(page);

    guard.assertClean();
  });

  test('protected routes redirect unauthenticated users to login', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);

    await page.goto('/production/plans');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
    await expectNoUndefinedOrNaN(page);

    guard.assertClean();
  });
});
