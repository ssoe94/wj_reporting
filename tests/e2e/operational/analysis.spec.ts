import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('analytics operational scenario', () => {
  test('renders production analytics overview, exceptions, equipment progress, and evidence', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/analysis');

    await expect(page.getByRole('heading', { name: '분석 센터' })).toBeVisible();
    await expect(page.getByText('생산 분석 Overview')).toBeVisible();
    await expect(page.getByText('우선 확인 예외')).toBeVisible();
    await expect(page.getByText('설비/라인 진행')).toBeVisible();
    await expect(page.getByText('데이터 근거')).toBeVisible();
    await page.getByText('사용 데이터').click();
    await expect(page.getByText('ProductionPlan: 2')).toBeVisible();
    await expect(page.getByText('A라인 PART-B 계획만 있음')).toBeVisible();
    await expectNoUndefinedOrNaN(page);

    guard.assertClean();
  });
});
