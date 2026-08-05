import { expect, test, type Page } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

async function installAnalysisReportMock(page: Page) {
  await page.route('**/api/injection/reports/**', async (route) => {
    await route.fulfill({
      json: {
        count: 2,
        next: null,
        previous: null,
        results: [
          {
            id: 1,
            date: '2026-05-17',
            tonnage: '850T',
            machine_no: 1,
            model: 'MODEL-A',
            section: 'injection',
            plan_qty: 1000,
            actual_qty: 900,
            reported_defect: 20,
            actual_defect: 20,
            operation_time: 18000,
            total_time: 24480,
            part_no: 'PART-A',
            note: '금형교체 30분',
            start_datetime: '2026-05-17T08:00:00+08:00',
            end_datetime: '2026-05-18T08:00:00+08:00',
          },
          {
            id: 2,
            date: '2026-05-18',
            tonnage: '1050T',
            machine_no: 2,
            model: 'MODEL-B',
            section: 'injection',
            plan_qty: 1000,
            actual_qty: 950,
            reported_defect: 10,
            actual_defect: 10,
            operation_time: 19000,
            total_time: 24480,
            part_no: 'PART-B',
            note: '자재대기 15분',
            start_datetime: '2026-05-18T08:00:00+08:00',
            end_datetime: '2026-05-19T08:00:00+08:00',
          },
        ],
      },
    });
  });
}

test.describe('analytics operational scenario', () => {
  test('renders injection OEE and downtime analytics from production reports', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installAnalysisReportMock(page);
    await installDevSession(page, 'ko');

    await page.goto('/analysis');

    await expect(page.getByRole('heading', { name: '생산성 분석' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '사출생산' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '가공생산' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'OEE (설비 종합 효율성)' })).toBeVisible();
    await expect(page.getByText('가동률 (A)', { exact: true })).toBeVisible();
    await expect(page.getByText('성능률 (P)', { exact: true })).toBeVisible();
    await expect(page.getByText('품질률 (Q)', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'OEE 트렌드' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '다운타임 분석' })).toBeVisible();
    await expect(page.getByText('15분', { exact: true })).toBeVisible();

    const downtimeViewToggle = page.getByRole('button', { name: '상세 보기' });
    await expect(downtimeViewToggle).toBeVisible();
    await downtimeViewToggle.click();
    await expect(page.getByRole('button', { name: '도넛 보기' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SPC & 조기경보' })).toBeVisible();
    await expectNoUndefinedOrNaN(page);

    guard.assertClean();
  });
});
