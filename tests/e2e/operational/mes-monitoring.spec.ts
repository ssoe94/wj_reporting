import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('MES monitoring operational scenario', () => {
  test('renders historical injection date, machine rail, utilization modal, and machining rows', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/mes/monitoring');

    await expect(page.getByRole('heading', { name: 'MES 데이터 모니터링' })).toBeVisible();
    await expect(page.getByText('생산 정보').first()).toBeVisible();
    await expect(page.getByText('재고 정보').first()).toBeVisible();
    await expect(page.getByLabel('기준일')).toHaveValue('2026-05-18');
    await expect(page.getByRole('heading', { name: '전체 사출기 총합 생산현황' })).toBeVisible();
    await expect(page.getByText('설비별 생산 분포')).toBeVisible();
    await expect(page.getByText('생산구간 UPH')).toBeVisible();
    await expect(page.getByText('UPH').first()).toBeVisible();
    await expect(page.getByText('79.00 kWh').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: '사출기 실시간 현황' })).toBeVisible();
    await expect(page.locator('.mes-machine-tile')).toHaveCount(17);
    await expect(page.getByText('선택 설비: 1호기')).toBeVisible();
    await expect(page.getByRole('heading', { name: '사출 정지/전환 분석' })).toBeVisible();
    const transitionPanel = page.locator('.injection-transition-panel');
    await expect(transitionPanel.getByText('생산 중지').first()).toBeVisible();
    await expect(transitionPanel.getByText('금형 교체').first()).toBeVisible();
    await expect(transitionPanel.getByText('코어 교체').first()).toBeVisible();
    await expect(transitionPanel.getByText('사출조건준비').first()).toBeVisible();
    await expect(transitionPanel.getByText('초과 생산 확인 필요').first()).toBeVisible();
    await expect(transitionPanel.getByText('선행 생산 가능성').first()).toBeVisible();
    await expect(transitionPanel.getByText('사출과 확인 필요').first()).toBeVisible();
    await expect(transitionPanel.locator('.injection-transition-event').filter({ hasText: '일반 정지' })).toHaveCount(0);
    await expect(transitionPanel).not.toContainText('1300T-3');
    await expect(transitionPanel).not.toContainText('1400T-5');
    await expect(transitionPanel).not.toContainText('Cavity');
    await expect(page.getByRole('heading', { name: 'MES 입고 / 형합수 비교' })).toBeVisible();
    const zsReceiptTable = page.locator('.mes-injection-receipt-table');
    await expect(zsReceiptTable.getByText('PART-A', { exact: true })).toBeVisible();
    await expect(zsReceiptTable.getByText('PART-B', { exact: true })).toBeVisible();
    await expect(zsReceiptTable.locator('tbody tr')).toHaveCount(7);
    await expect(zsReceiptTable.getByText('SEMI-PART-A')).toBeVisible();
    await expect(zsReceiptTable.getByText('수량 일치').first()).toBeVisible();
    await expect(zsReceiptTable.getByText('MES 입고 부족')).toHaveCount(1);
    await expect(zsReceiptTable.getByText('매칭 기준 모델/품번 후보')).toHaveCount(1);
    await expect(zsReceiptTable.getByText('매칭 기준 설비 보정')).toHaveCount(1);
    await expect(zsReceiptTable.getByText('MES 설비 850T-2')).toBeVisible();
    const sameLengthCoreFirstRow = zsReceiptTable.locator('tbody tr').filter({ hasText: 'ABJ76507604' });
    await expect(sameLengthCoreFirstRow).toContainText('198');
    await expect(sameLengthCoreFirstRow).toContainText('형합수 198');
    const sameLengthCoreSecondRow = zsReceiptTable.locator('tbody tr').filter({ hasText: 'ABJ76507601' });
    await expect(sameLengthCoreSecondRow).toContainText('539');
    await expect(sameLengthCoreSecondRow).toContainText('형합수 281');
    const firstRolloverRow = zsReceiptTable.locator('tbody tr').filter({ hasText: 'ACQ30854203' });
    await expect(firstRolloverRow).toContainText('37');
    await expect(firstRolloverRow).toContainText('형합수 37');
    const secondRolloverRow = zsReceiptTable.locator('tbody tr').filter({ hasText: 'ACQ30854211' });
    await expect(secondRolloverRow).toContainText('1,475');
    await expect(secondRolloverRow).toContainText('형합수 1,415');
    const duplicatePartRow = zsReceiptTable.locator('tbody tr').filter({ hasText: 'ACQ30776309' });
    await expect(duplicatePartRow).toContainText('1,920');
    await expect(duplicatePartRow).toContainText('형합수 1,974');
    await expect(page.getByText('형합수 추정').first()).toBeVisible();
    await expect(page.getByText('MES 입고').first()).toBeVisible();

    await page.getByRole('button', { name: '가동률 상세 분석' }).click();
    const utilizationDialog = page.getByRole('dialog', { name: '가동률 상세 분석' });
    await expect(utilizationDialog).toBeVisible();
    await expect(utilizationDialog.getByText('가동률').first()).toBeVisible();
    await page.getByRole('button', { name: '닫기' }).click();

    await expect(page.getByText('저장된 스냅샷 조회 중').first()).toBeVisible();

    await expect(page.getByRole('heading', { name: '가공 생산보고 모니터링' })).toBeVisible();
    const machiningTable = page.locator('.mes-machining-table');
    await expect(machiningTable.getByText('PART-MATCHED')).toBeVisible();
    await expect(machiningTable.getByText('PART-PLAN-ONLY')).toBeVisible();
    await expect(machiningTable.getByText('PART-MES-ONLY')).toBeVisible();
    await expect(machiningTable.getByText('매칭', { exact: true })).toBeVisible();
    await expect(machiningTable.getByText('미보고', { exact: true })).toBeVisible();
    await expect(machiningTable.getByText('계획 없음', { exact: true })).toBeVisible();

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });
});
