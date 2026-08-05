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
    const cavityRequests: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/production/part-cavity/') && request.method() === 'POST') {
        cavityRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await page.goto('/production/plans');

    await expect(page.getByRole('heading', { name: '생산 계획 업데이트' })).toBeVisible();
    await expect(page.getByText('2026-05-18 생산 계획 현황')).toBeVisible();
    const initialPlanRow = page.locator('[data-order-key="injection:850T-1"] [data-record-key="id:1"]').first();
    await expect(initialPlanRow).toBeVisible();
    await expect(initialPlanRow).toContainText('PART-A');
    await expect(initialPlanRow.getByText('Cavity')).toBeVisible();
    await expect(page.getByText('계획 수량')).toBeVisible();
    await expect(initialPlanRow.getByText('100')).toBeVisible();
    await expect(initialPlanRow.getByRole('button', { name: '수정' })).toHaveText('');
    await expect(initialPlanRow.getByRole('button', { name: '저장' })).toHaveCount(0);

    await page.getByRole('button', { name: '생산계획 업로드' }).click();
    const uploadDialog = page.getByRole('dialog');
    await expect(uploadDialog).toBeVisible();
    await uploadDialog.getByRole('button', { name: '계획 업데이트' }).click();
    await expect(uploadDialog.getByText('사출 또는 가공 계획 파일을 하나 이상 선택해주세요.')).toBeVisible();
    await uploadDialog.getByRole('button', { name: '닫기' }).click();

    const planRow = page.locator('[data-order-key="injection:850T-1"] [data-record-key="id:1"]').first();
    await planRow.getByRole('button', { name: '수정' }).click();
    await expect(planRow.getByRole('button', { name: '취소' })).toBeVisible();
    await expect(planRow.getByRole('button', { name: '저장' })).toBeVisible();
    await planRow.getByRole('button', { name: '취소' }).click();
    await expect(planRow.getByRole('button', { name: '저장' })).toHaveCount(0);

    await planRow.getByRole('button', { name: '수정' }).click();
    await planRow.locator('input').nth(3).fill('120');
    const cavityEditor = planRow.locator('.cavity-inline-editor');
    await cavityEditor.getByLabel('Cavity part count').fill('1');
    await cavityEditor.getByLabel('Cavity count').fill('3');
    const saveButton = planRow.getByRole('button', { name: '저장' });
    await saveButton.click();
    await expect.poll(() => cavityRequests).toContainEqual(expect.objectContaining({
      part_nos: ['PART-A'],
      cavity_pattern: '1x3',
    }));
    await expect(planRow).not.toHaveClass(/schedule-job--editing/);
    await page.waitForLoadState('networkidle');
    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('loads a local sample plan without uploading a workbook', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production/plans');
    await page.getByRole('button', { name: '샘플 계획 보기' }).click();

    await expect(page.getByText('로컬 샘플 생산계획을 표시했습니다.')).toBeVisible();
    const sampleMachine = page.locator('[data-order-key="injection:650T-10"]');
    await expect(sampleMachine).toBeVisible();
    await expect(sampleMachine).toContainText('65UQ79');
    await expect(sampleMachine).toContainText('AAN30078444');
    await expect(sampleMachine).toContainText('Cavity');
    await expect(sampleMachine).toContainText('2 Part 동시');
    await expect(sampleMachine).not.toContainText('선택한 Part No.가 동일 사출 사이클에서 함께 생산됩니다.');

    const groupedSampleRow = page.locator('[data-order-key="injection:650T-10"] [data-record-key="id:900004"]');
    await groupedSampleRow.getByRole('button', { name: '수정' }).click();
    await expect(groupedSampleRow).toContainText('저장 시 묶인 Part No. 모두 2x2 Cavity로 저장됩니다.');
    await expect(groupedSampleRow).toContainText('AAN30078443 · 2x2 · 수량 2,520');
    await expect(groupedSampleRow).toContainText('AAN30078444 · 2x2 · 수량 2,520');
    await expect(groupedSampleRow).toContainText('동시생산 품목은 계획 수량과 순서를 같은 사출기 내에서 맞춰주세요.');
    await groupedSampleRow.getByRole('button', { name: '저장' }).click();
    await expect(groupedSampleRow).not.toHaveClass(/schedule-job--editing/);
    await expect(sampleMachine.locator('[data-record-key="id:900005"]')).toContainText('2 Part 동시');

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('shows grouped cavity details and warns only for a cross-machine group', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');
    const cavityRequests: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/production/part-cavity/') && request.method() === 'POST') {
        cavityRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    const baseRecord = {
      lot_no: 'A01',
      model_name: 'MODEL-A',
      part_spec: 'B/C 完',
      planned_quantity: 100,
      cavity: 2,
      cavity_pattern: '2x2',
      parts_per_shot: 2,
      total_cavity: 4,
      sequence: 1,
      created_at: '2026-05-18T08:00:00+08:00',
      updated_at: '2026-05-18T08:00:00+08:00',
    };
    const groupedRecords = [
      { ...baseRecord, id: 101, machine_name: '850T-1', part_no: 'PART-A', cavity_group: 'PART-A+PART-B' },
      { ...baseRecord, id: 102, machine_name: '850T-1', part_no: 'PART-B', cavity_group: 'PART-A+PART-B', sequence: 2 },
      { ...baseRecord, id: 103, machine_name: '850T-2', part_no: 'PART-C', cavity_group: 'PART-C+PART-D' },
      { ...baseRecord, id: 104, machine_name: '850T-3', part_no: 'PART-D', cavity_group: 'PART-C+PART-D' },
    ];

    await page.route('**/api/production/plans/**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: groupedRecords });
        return;
      }
      await route.fallback();
    });

    await page.goto('/production/plan');

    const validGroupRow = page.locator('[data-order-key="injection:850T-1"] [data-record-key="id:101"]');
    await expect(validGroupRow).toContainText('Cavity');
    await expect(validGroupRow).toContainText('2 Part 동시');
    await expect(validGroupRow).toContainText('함께 생산 Part No.');
    await expect(validGroupRow).toContainText('PART-B');
    await expect(validGroupRow).not.toContainText('동일 사출 사이클에서 함께 생산됩니다.');
    await expect(validGroupRow.getByText('같은 사출기 내 Part No.를 선택하세요.')).toHaveCount(0);
    await expect(validGroupRow.getByRole('button', { name: '저장' })).toHaveCount(0);
    await validGroupRow.getByRole('button', { name: '수정' }).click();
    const groupedCavitySaveButton = validGroupRow.getByRole('button', { name: '저장' });
    await groupedCavitySaveButton.click();
    await expect.poll(() => cavityRequests).toContainEqual(expect.objectContaining({
      part_nos: ['PART-A', 'PART-B'],
      cavity_pattern: '2x2',
    }));
    await expect(validGroupRow).not.toHaveClass(/schedule-job--editing/);
    await page.waitForLoadState('networkidle');

    const invalidGroupRow = page.locator('[data-order-key="injection:850T-2"] [data-record-key="id:103"]');
    await invalidGroupRow.getByRole('button', { name: '수정' }).click();
    await expect(invalidGroupRow.getByRole('alert')).toHaveText('같은 사출기 내 Part No.를 선택하세요.');
    await expect(invalidGroupRow.getByRole('button', { name: '저장' })).toBeDisabled();

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });
});
