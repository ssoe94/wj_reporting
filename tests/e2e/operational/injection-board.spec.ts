import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('injection office board', () => {
  test('renders from the nested static index entry used by production', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/injection-board/index.html');
    await expect(page.locator('.injection-board__grid')).toBeVisible();
    await expect(page.locator('.injection-board-card')).toHaveCount(17);

    guard.assertClean();
  });

  test('renders three summaries and machines 1 through 17 in one 4K screen', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');
    await page.setViewportSize({ width: 3840, height: 2160 });

    await page.goto('/production/injection-board');
    await expect(page.getByRole('heading', { name: '사출 실시간 현황판' })).toBeVisible();
    await expect(page.getByText('1분 자동 갱신')).toBeVisible();
    await expect(page.locator('.injection-board-summary').first().getByText('전체 가동 현황')).toBeVisible();
    await expect(page.locator('.injection-board-summary').nth(1).getByText('계획 생산 진도')).toBeVisible();
    await expect(page.locator('.injection-board-summary').nth(2).getByText('즉시 확인 필요')).toBeVisible();

    const boardItems = page.locator('.injection-board__grid > article');
    await expect(boardItems).toHaveCount(20);
    await expect(page.locator('.injection-board-card')).toHaveCount(17);
    for (let machineNumber = 1; machineNumber <= 17; machineNumber += 1) {
      await expect(page.locator(`.injection-board-card[data-machine="${machineNumber}"]`)).toBeVisible();
    }
    await expect(page.locator('.injection-board-card').first()).toContainText('현재 C/T');
    await expect(page.locator('.injection-board-card').first()).toContainText('계획대비');
    await expect(page.locator('.injection-board-card').first()).toContainText('MODEL-A');
    await expect(page.locator('.injection-board-card').first()).not.toContainText('필요 C/T');

    const finalCard = page.locator('.injection-board-card[data-machine="17"]');
    const finalCardBox = await finalCard.boundingBox();
    expect(finalCardBox).not.toBeNull();
    expect((finalCardBox?.y ?? 0) + (finalCardBox?.height ?? 0)).toBeLessThanOrEqual(2160);

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('opens from the visible launcher below the production KPI cards', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production');
    const launcher = page.getByRole('button', { name: '사출 현황판 열기' });
    await expect(launcher).toBeInViewport();
    const popupPromise = page.waitForEvent('popup');
    await launcher.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await expect(popup).toHaveURL(/\/production\/injection-board$/);
    await expect(popup.getByRole('heading', { name: '사출 실시간 현황판' })).toBeVisible();

    await popup.close();
    guard.assertClean();
  });

  test('shares the Korean and Chinese language preference', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/injection-board');
    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.getByRole('heading', { name: '注塑实时看板' })).toBeVisible();
    await expect(page.locator('.injection-board-card[data-machine="1"]')).toContainText('1号机');
    expect(await page.evaluate(() => window.localStorage.getItem('lang'))).toBe('zh');

    guard.assertClean();
  });
});
