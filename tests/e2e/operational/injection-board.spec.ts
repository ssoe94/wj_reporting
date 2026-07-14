import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('injection office board', () => {
  test('keeps the previous business date until the 08:00 cutoff', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await page.clock.setFixedTime(new Date('2026-05-19T07:59:00+08:00'));
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/injection-board');
    await expect(page.locator('.injection-board__meta > div').first()).toContainText('2026-05-18');
    guard.assertClean();
  });

  test('uses the new business date from 08:00', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await page.clock.setFixedTime(new Date('2026-05-19T08:00:00+08:00'));
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/injection-board');
    await expect(page.locator('.injection-board__meta > div').first()).toContainText('2026-05-19');
    guard.assertClean();
  });

  test('renders from the nested static index entry used by production', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/injection-board/index.html');
    await expect(page.locator('.injection-board__grid')).toBeVisible();
    await expect(page.locator('.injection-board-card')).toHaveCount(17);

    guard.assertClean();
  });

  test('returns a direct board bookmark to the board after login', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await page.route('**/api/token/', async (route) => {
      await route.fulfill({ json: { access: 'board-access-token', refresh: 'board-refresh-token' } });
    });

    await page.goto('/production/injection-board/index.html');
    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/production/injection-board/index.html');

    await page.reload();
    await page.locator('input[autocomplete="username"]').fill('board-user');
    await page.locator('input[autocomplete="current-password"]').fill('board-password');
    await page.locator('form').getByRole('button').click();

    await expect(page).toHaveURL(/\/production\/injection-board\/index\.html$/);
    await expect(page.locator('.injection-board__grid')).toBeVisible();
    await expect(page.locator('.injection-board-card')).toHaveCount(17);
    guard.assertClean();
  });

  test('renders three summaries and machines 1 through 17 in one 4K screen', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await page.clock.setFixedTime(new Date('2026-05-18T10:10:00+08:00'));
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
    await expect(page.locator('.injection-board-card__timeline')).toHaveCount(17);
    await expect(page.locator('.injection-board-card__timeline > span')).not.toHaveCount(0);
    for (let machineNumber = 1; machineNumber <= 17; machineNumber += 1) {
      await expect(page.locator(`.injection-board-card[data-machine="${machineNumber}"]`)).toBeVisible();
    }
    await expect(page.locator('.injection-board-card').first()).toContainText('현재 C/T');
    await expect(page.locator('.injection-board-card').first()).toContainText('최근 60분 기준');
    await expect(page.locator('.injection-board-card').first()).toContainText('달성률');
    await expect(page.locator('.injection-board-card').first()).toContainText('MODEL-B');
    await expect(page.locator('.injection-board-card').first()).not.toContainText('필요 C/T');
    await expect(page.getByText('계획없음', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('무계획', { exact: true })).toHaveCount(0);

    const typography = await page.locator('.injection-board').evaluate((board) => {
      const summaryMetric = board.querySelector<HTMLElement>('.injection-board-summary__metrics > span');
      const machineMetrics = Array.from(board.querySelectorAll<HTMLElement>('.injection-board-card__metrics > div'));
      const machineValues = machineMetrics.map((metric) => metric.querySelector<HTMLElement>('strong'));
      const detail = board.querySelector<HTMLElement>('.injection-board-card__metrics small');
      return {
        summaryAlignment: summaryMetric ? window.getComputedStyle(summaryMetric).textAlign : '',
        machineAlignments: machineMetrics.map((metric) => window.getComputedStyle(metric).textAlign),
        machineValueSizes: machineValues.map((value) => value ? window.getComputedStyle(value).fontSize : ''),
        detailWeight: detail ? Number(window.getComputedStyle(detail).fontWeight) : 0,
      };
    });
    expect(typography.summaryAlignment).toBe('center');
    expect(new Set(typography.machineAlignments)).toEqual(new Set(['center']));
    expect(new Set(typography.machineValueSizes).size).toBe(1);
    expect(typography.detailWeight).toBeGreaterThanOrEqual(700);

    const finalCard = page.locator('.injection-board-card[data-machine="17"]');
    const finalCardBox = await finalCard.boundingBox();
    expect(finalCardBox).not.toBeNull();
    expect((finalCardBox?.y ?? 0) + (finalCardBox?.height ?? 0)).toBeLessThanOrEqual(2160);

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('shows the previous business-day summary in a smaller floating layer and closes on one click', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await page.clock.setFixedTime(new Date('2026-05-19T09:00:00+08:00'));
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');
    await page.setViewportSize({ width: 1920, height: 1080 });

    await page.goto('/production/injection-board');
    const cacheKey = 'injection-board:previous-summary:2026-05-18';
    await expect.poll(() => page.evaluate((key) => Boolean(window.localStorage.getItem(key)), cacheKey)).toBe(true);
    const cached = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), cacheKey);
    expect(cached.businessDate).toBe('2026-05-18');
    expect(cached.expiresAt).toBe(new Date('2026-05-20T08:00:00+08:00').getTime());
    expect(Object.keys(cached.timelines)).toHaveLength(17);

    await page.getByRole('button', { name: '전일 생산 요약' }).click();

    const history = page.locator('.injection-board-history');
    const panel = page.locator('.injection-board-history__panel');
    await expect(history).toBeVisible();
    await expect(panel).toContainText('전일 사출 생산 요약');
    await expect(panel).toContainText('2026-05-18');
    await expect(panel.locator('.injection-board-history__kpi')).toHaveCount(4);
    await expect(panel).toContainText('계획 달성률');
    await expect(panel).toContainText('총 생산수량');
    await expect(panel.locator('.injection-board-history-card')).toHaveCount(17);
    await expect(panel.locator('.injection-board-history-card__timeline')).toHaveCount(17);
    await expect(panel.locator('.injection-board-history-card__timeline > span')).not.toHaveCount(0);
    const shotLabels = await panel.locator('.injection-board-history-card__shots strong').allTextContents();
    expect(shotLabels.every((label) => /^\d[\d,]*회$/.test(label))).toBe(true);
    await expect(panel.locator('.injection-board-history__kpi--outside strong')).not.toContainText('.5');

    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox?.width ?? 0).toBeLessThan(1920);
    expect(panelBox?.height ?? 0).toBeLessThan(1080);
    const overflowingHistoryCards = await panel.locator('.injection-board-history-card').evaluateAll((cards) => (
      cards
        .filter((card) => card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1)
        .map((card) => card.getAttribute('data-machine'))
    ));
    expect(overflowingHistoryCards).toEqual([]);

    await panel.click({ position: { x: 12, y: 12 } });
    await expect(history).toBeHidden();
    await expect(page.locator('.injection-board__grid')).toBeVisible();
    guard.assertClean();
  });

  test('fits the full board without clipped card content on a 1280 by 720 field display', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'zh');
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto('/production/injection-board');
    await expect(page.locator('.injection-board-card')).toHaveCount(17);

    const layout = await page.locator('.injection-board').evaluate((board) => {
      const cards = Array.from(board.querySelectorAll<HTMLElement>('.injection-board-card, .injection-board-summary'));
      return {
        boardWidth: board.clientWidth,
        boardHeight: board.clientHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        overflowingCards: cards
          .filter((card) => card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1)
          .map((card) => card.getAttribute('data-machine') || card.className),
        wrappedBadges: cards
          .map((card) => card.querySelector<HTMLElement>('.injection-board-card__header em'))
          .filter((badge): badge is HTMLElement => Boolean(badge))
          .filter((badge) => badge.scrollHeight > badge.clientHeight + 1)
          .length,
      };
    });

    expect(layout.boardWidth).toBe(layout.viewportWidth);
    expect(layout.boardHeight).toBe(layout.viewportHeight);
    expect(layout.overflowingCards).toEqual([]);
    expect(layout.wrappedBadges).toBe(0);
    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('opens from the visible launcher below the production KPI cards', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production');
    const launcher = page.getByRole('button', { name: '사출 현황판 열기' });
    await launcher.scrollIntoViewIfNeeded();
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
