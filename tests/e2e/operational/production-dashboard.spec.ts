import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('production dashboard operational scenario', () => {
  test('separates planned output from unplanned machine shots', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production');
    await page.locator('input[type="date"]').fill('2026-05-18');

    const injectionKpi = page.getByRole('button', { name: /사출 계획 및 실행율/ });
    await expect(injectionKpi.locator('.stat-card__hint')).toContainText('계획 7대 완료 100.6% - 무계획가동 18회/2대');
    await injectionKpi.click();

    const injectionDetail = page.locator('.production-kpi-detail--injection');
    await expect(injectionDetail).toContainText('계획 실적 / 계획');
    await expect(injectionDetail).toContainText('무계획가동 18회 · 2대');
    const unplannedMachine = injectionDetail.locator('.production-kpi-rank__card').filter({ hasText: '850T-8' });
    await expect(unplannedMachine).toContainText('무계획');
    await expect(unplannedMachine).toContainText('형합수');
    await expect(unplannedMachine).toContainText('12회');
    await expect(unplannedMachine).not.toContainText('0 / 0');

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('renders deterministic plan, MES progress, and AI briefing evidence', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production');
    await page.locator('input[type="date"]').fill('2026-05-18');

    await expect(page.getByRole('heading', { name: '생산 대시보드' })).toBeVisible();
    const injectionKpi = page.getByRole('button', { name: /사출 계획 및 실행율/ });
    await expect(injectionKpi.locator('.stat-card__value')).toContainText('/');
    await expect(injectionKpi.locator('.stat-card__hint')).toContainText('계획 7대 완료 100.6% - 무계획가동 18회/2대');
    await expect(page.getByText('기준일 2026-05-18 사출 완료율은 95%입니다.')).toBeVisible();
    await expect(page.getByRole('heading', { name: '실시간 프로그레스' })).toBeVisible();
    await expect(page.getByText('사출 실시간 진행')).toBeVisible();
    const mesOnlyMachine = page.locator('.production-progress-row').filter({ hasText: '850T-8' }).first();
    await expect(mesOnlyMachine).toBeVisible();
    await expect(mesOnlyMachine).toContainText('형합수');
    await injectionKpi.click();
    const injectionDetail = page.locator('.production-kpi-detail--injection');
    await expect(injectionDetail).toContainText('계획 실적 / 계획');
    await expect(injectionDetail).toContainText('무계획가동 18회 · 2대');
    const unplannedMachine = injectionDetail.locator('.production-kpi-rank__card').filter({ hasText: '850T-8' });
    await expect(unplannedMachine).toContainText('무계획');
    await expect(unplannedMachine).toContainText('형합수');
    await expect(unplannedMachine).toContainText('12회');
    await expect(unplannedMachine).not.toContainText('0 / 0');
    await expect(page.getByText('MES 미등록 수기 40').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: '사출 정지/전환 분석' })).toBeVisible();
    const transitionPanel = page.locator('.injection-transition-panel');
    await expect(transitionPanel.getByText('생산 중지').first()).toBeVisible();
    await expect(transitionPanel.getByText('금형 교체').first()).toBeVisible();
    await expect(transitionPanel.getByText('코어 교체').first()).toBeVisible();
    await expect(transitionPanel.getByText('사출조건준비').first()).toBeVisible();
    await expect(transitionPanel.getByText('초과 생산 확인 필요').first()).toBeVisible();
    await expect(transitionPanel.getByText('선행 생산 가능성').first()).toBeVisible();
    await expect(transitionPanel.locator('.injection-transition-event').filter({ hasText: '일반 정지' })).toHaveCount(0);
    await expect(transitionPanel).not.toContainText('1300T-3');
    await expect(transitionPanel).not.toContainText('1400T-5');
    await expect(transitionPanel).not.toContainText('Cavity');

    const machiningLine = page.locator('.production-progress-row').filter({ hasText: 'B라인' }).first();
    await machiningLine.locator('.production-part-track').hover();
    await expect(machiningLine.locator('.production-progress-hover-card')).toBeVisible();
    await expect(machiningLine.locator('.production-progress-hover-card')).toContainText('기기 요약');
    await expect(machiningLine.locator('.production-progress-hover-card')).toContainText('완성도');
    await expect(machiningLine.locator('.production-progress-hover-card')).toContainText('PART-PLAN-ONLY');
    await expect(machiningLine.locator('.production-progress-hover-card')).not.toContainText('Cavity');

    await page.getByRole('button', { name: /B라인 수기 보정/ }).click();
    const manualDialog = page.getByRole('dialog');
    await expect(manualDialog.getByRole('heading', { name: '가공 수기 보정' })).toBeVisible();
    await expect(manualDialog.getByLabel('양품 수량')).toHaveValue('40');
    await manualDialog.getByLabel('양품 수량').fill('12');
    await manualDialog.getByRole('button', { name: '보정 저장' }).click();
    await expect(manualDialog).toBeHidden();

    await page.getByText('사용한 데이터').click();
    await expect(page.getByText('ProductionPlan: 1')).toBeVisible();
    await page.getByText('계산 기준').click();
    await expect(page.getByText('기준일은 08:00 ~ 익일 08:00 기준입니다.')).toBeVisible();

    await page.getByRole('button', { name: /850T-1 상세/ }).click();
    const detailDialog = page.getByRole('dialog');
    await expect(detailDialog).toBeVisible();
    await expect(detailDialog.getByRole('heading', { name: '850T-1' })).toBeVisible();
    await expect(detailDialog.getByText('PART-A')).toBeVisible();
    await expect(detailDialog.getByText('120 / 100')).toBeVisible();
    await expect(detailDialog.getByText('806 / 100')).toBeVisible();
    await detailDialog.getByRole('button', { name: '닫기' }).click();

    await page.getByRole('button', { name: /850T-2 상세/ }).click();
    await expect(detailDialog).toBeVisible();
    await expect(detailDialog.getByRole('heading', { name: '850T-2' })).toBeVisible();
    await expect(detailDialog.getByText('ABJ76507604')).toBeVisible();
    await expect(detailDialog.getByText('ABJ76507601')).toBeVisible();
    await expect(detailDialog.getByText('198 / 198')).toBeVisible();
    await expect(detailDialog.getByText('281 / 539')).toBeVisible();
    await detailDialog.getByRole('button', { name: '닫기' }).click();

    await page.getByRole('button', { name: /850T-2 상세/ }).click();
    await expect(detailDialog).toBeVisible();
    await expect(detailDialog.getByRole('heading', { name: '850T-2' })).toBeVisible();
    await expect(detailDialog.getByText('ABJ76507604')).toBeVisible();
    await expect(detailDialog.getByText('ABJ76507601')).toBeVisible();
    await expect(detailDialog.getByText('198 / 198')).toBeVisible();
    await expect(detailDialog.getByText('281 / 539')).toBeVisible();
    await detailDialog.getByRole('button', { name: '닫기' }).click();

    await page.getByRole('button', { name: /1050T-16 상세/ }).click();
    await expect(detailDialog).toBeVisible();
    await expect(detailDialog.getByRole('heading', { name: '1050T-16' })).toBeVisible();
    await expect(detailDialog.getByText('ACQ30854203')).toBeVisible();
    await expect(detailDialog.getByText('37 / 37')).toBeVisible();
    await expect(detailDialog.getByText('1,415 / 1,475')).toBeVisible();
    await detailDialog.getByRole('button', { name: '닫기' }).click();

    await page.getByRole('button', { name: /2500T-6 상세/ }).click();
    await expect(detailDialog).toBeVisible();
    await expect(detailDialog.getByRole('heading', { name: '2500T-6' })).toBeVisible();
    await expect(detailDialog.getByText('ACQ30776309')).toHaveCount(2);
    await expect(detailDialog.getByText('1,000 / 1,000')).toBeVisible();
    await expect(detailDialog.getByText('974 / 920')).toBeVisible();

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });
});
