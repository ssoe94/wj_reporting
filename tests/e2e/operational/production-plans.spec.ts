import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('production plans operational scenario', () => {
  test('renders plan rows, validates empty upload, and saves an edited injection row', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/plans');

    await expect(page.getByRole('heading', { name: '생산 계획 업데이트' })).toBeVisible();
    await expect(page.getByText('2026-05-18 생산 계획 현황')).toBeVisible();
    const initialPlanRow = page.locator('[data-order-key="injection:850T-1"] [data-record-key="id:1"]').first();
    await expect(initialPlanRow).toBeVisible();
    await expect(initialPlanRow).toContainText('PART-A');
    await expect(page.getByText('계획 수량')).toBeVisible();
    await expect(initialPlanRow.getByText('100')).toBeVisible();

    await page.getByRole('button', { name: '생산계획 업로드' }).click();
    const uploadDialog = page.getByRole('dialog');
    await expect(uploadDialog).toBeVisible();
    await uploadDialog.getByRole('button', { name: '계획 업데이트' }).click();
    await expect(uploadDialog.getByText('사출 또는 가공 계획 파일을 하나 이상 선택해주세요.')).toBeVisible();
    await uploadDialog.getByRole('button', { name: '닫기' }).click();

    const planRow = page.locator('[data-order-key="injection:850T-1"] [data-record-key="id:1"]').first();
    await planRow.getByRole('button', { name: '수정' }).click();
    await planRow.locator('input').nth(3).fill('120');
    await planRow.locator('input').nth(4).fill('3');
    await planRow.getByRole('button', { name: '저장' }).click();

    await expect(planRow).not.toHaveClass(/schedule-job--editing/);
    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });
});
