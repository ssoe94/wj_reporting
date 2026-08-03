import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installOperationalApiMocks,
  installPageIssueGuard,
} from '../helpers/operational';

test.describe('production dashboard operational scenario', () => {
  test('opens the unplanned production form in the visible viewport and creates a complete plan', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page, { unplannedRunning: true });
    await installDevSession(page, 'ko');
    const planRequests: Array<Record<string, unknown>> = [];
    const cavityRequests: Array<Record<string, unknown>> = [];

    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      if (request.url().includes('/api/production/plans/')) {
        planRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
      if (request.url().includes('/api/production/part-cavity/')) {
        cavityRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await page.route('**/production-modal-host', async (route) => {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html>
            <head><style>html,body{margin:0}.host-spacer{height:420px}iframe{display:block;width:100%;height:3400px;border:0}</style></head>
            <body><div class="host-spacer"></div><iframe id="production-app" src="/production"></iframe></body>
          </html>`,
      });
    });
    await page.goto('/production-modal-host');
    const app = page.frameLocator('#production-app');
    await app.locator('input[type="date"]').fill('2026-05-18');

    const unplannedMachine = app.locator('.production-progress-row').filter({ hasText: '850T-8' }).first();
    await unplannedMachine.getByRole('button', { name: '제품/계획 입력' }).click();

    const dialog = app.getByRole('dialog', { name: '생산 제품·계획 등록' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('850T-8');
    await expect(dialog).toContainText('2026-05-18');

    const dialogBox = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(Math.abs((dialogBox!.y + dialogBox!.height / 2) - viewport!.height / 2)).toBeLessThan(80);

    await dialog.getByLabel(/Part No/).fill('NEWPART0001');
    await dialog.getByLabel(/모델명/).fill('MODEL-NEW');
    await dialog.getByLabel(/계획 수량/).fill('1200');
    await dialog.getByLabel(/Lot No/).fill('LOT-01');
    await dialog.getByLabel(/개별 캐비티/).fill('2');
    await dialog.getByLabel(/비고/).fill('현장 확인 후 등록');
    await dialog.getByRole('button', { name: '계획 등록' }).click();

    await expect(dialog).toBeHidden();
    expect(planRequests).toHaveLength(1);
    expect(planRequests[0]).toMatchObject({
      plan_date: '2026-05-18',
      plan_type: 'injection',
      machine_name: '850T-8',
      part_no: 'NEWPART0001',
      model_name: 'MODEL-NEW',
      lot_no: 'LOT-01',
      planned_quantity: 1200,
    });
    expect(cavityRequests).toEqual([expect.objectContaining({ part_no: 'NEWPART0001', cavity_pattern: '1x2' })]);

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('separates planned output from unplanned machine shots', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    await page.goto('/production');
    await page.locator('input[type="date"]').fill('2026-05-18');

    const injectionKpi = page.getByRole('button', { name: /사출 계획 및 실행율/ });
    await expect(injectionKpi.locator('.stat-card__hint')).toContainText('계획 7대 완료 100.6%');
    const unplannedKpi = page.getByRole('button', { name: /무계획가동/ });
    await expect(unplannedKpi.locator('.stat-card__value')).toContainText('18회 / 2대');
    await expect(unplannedKpi.locator('.stat-card__hint')).toContainText('7호기 6회 · 8호기 12회');
    await unplannedKpi.click();

    const unplannedDetail = page.locator('.production-kpi-detail--unplanned');
    await expect(unplannedDetail).toContainText('무계획가동 상세');
    await expect(unplannedDetail).toContainText('18회');
    await expect(unplannedDetail).toContainText('2대');
    const unplannedMachine = unplannedDetail.locator('.production-kpi-rank__card').filter({ hasText: '850T-8' });
    await expect(unplannedMachine).toContainText('무계획');
    await expect(unplannedMachine).toContainText('형합수');
    await expect(unplannedMachine).toContainText('12회');
    await expect(unplannedMachine).not.toContainText('0 / 0');

    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('allocates repeated cavity groups to later plans only after the earlier group is complete', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installOperationalApiMocks(page);
    await installDevSession(page, 'ko');

    const date = '2026-05-18';
    const cavityGroup = 'CAVITY-A+CAVITY-B';
    const planRecords = [
      { id: 101, sequence: 1, part_no: 'CAVITY-A', model_name: 'MODEL-A', lot_no: 'A1' },
      { id: 102, sequence: 2, part_no: 'CAVITY-B', model_name: 'MODEL-B', lot_no: 'B1' },
      { id: 103, sequence: 3, part_no: 'CAVITY-A', model_name: 'MODEL-A', lot_no: 'A2' },
      { id: 104, sequence: 4, part_no: 'CAVITY-B', model_name: 'MODEL-B', lot_no: 'B2' },
    ].map((record) => ({
      ...record,
      machine_name: '850T-1',
      planned_quantity: 100,
      cavity: 2,
      cavity_pattern: '2x2',
      parts_per_shot: 2,
      cavity_group: cavityGroup,
      total_cavity: 4,
    }));

    await page.unroute('**/api/production/plan-summary/**');
    await page.route('**/api/production/plan-summary/**', async (route) => {
      const requestedDate = new URL(route.request().url()).searchParams.get('date') ?? date;
      const isTargetDate = requestedDate === date;
      await route.fulfill({
        json: {
          plan_date: requestedDate,
          latest_updated_at: '2026-05-18T08:00:00+08:00',
          injection: {
            records: isTargetDate ? planRecords : [],
            machine_summary: isTargetDate
              ? [{ machine_name: '850T-1', plan_qty: 400, plan_date: requestedDate }]
              : [],
            model_summary: isTargetDate
              ? [
                { model_name: 'MODEL-A', plan_qty: 200, plan_date: requestedDate },
                { model_name: 'MODEL-B', plan_qty: 200, plan_date: requestedDate },
              ]
              : [],
            daily_totals: [{ date: requestedDate, plan_qty: isTargetDate ? 400 : 0 }],
          },
          machining: {
            records: [],
            machine_summary: [],
            model_summary: [],
            daily_totals: [{ date: requestedDate, plan_qty: 0 }],
          },
        },
      });
    });

    await page.unroute('**/api/production/status/**');
    await page.route('**/api/production/status/**', async (route) => {
      await route.fulfill({
        json: {
          injection: [{
            machine_name: '850T-1',
            total_planned: 400,
            total_actual: 240,
            progress: 60,
            parts: [
              {
                part_no: 'CAVITY-A',
                model_name: 'MODEL-A',
                planned_quantity: 200,
                actual_quantity: 120,
                progress: 60,
              },
              {
                part_no: 'CAVITY-B',
                model_name: 'MODEL-B',
                planned_quantity: 200,
                actual_quantity: 120,
                progress: 60,
              },
            ],
          }],
          machining: [],
        },
      });
    });

    await page.unroute('**/api/injection/production-matrix/**');
    await page.route('**/api/injection/production-matrix/**', async (route) => {
      await route.fulfill({
        json: {
          timestamp: '2026-05-18T10:00:00+08:00',
          interval_type: '2min',
          columns: 1,
          time_slots: [{
            hour_offset: 0,
            time: '2026-05-18T10:00:00+08:00',
            label: '10:00',
            interval_minutes: 2,
          }],
          machines: [{
            machine_number: 1,
            machine_name: '1호기',
            tonnage: '850T',
            display_name: '850T-1',
          }],
          cumulative_production_matrix: { '1호기': [60] },
          actual_production_matrix: { '1호기': [60] },
          oil_temperature_matrix: { '1호기': [35] },
          power_kwh_matrix: { '1호기': [1] },
          power_usage_matrix: { '1호기': [1] },
          mes_source: true,
        },
      });
    });

    await page.goto('/production');
    await page.locator('input[type="date"]').fill(date);

    const machineRow = page.locator('.production-progress-row').filter({ hasText: '850T-1' }).first();
    await expect(machineRow).toBeVisible();
    const graph = machineRow.locator('.production-part-track');
    await expect(graph.locator('.production-part-segment')).toHaveCount(4);
    await expect(graph.locator('.production-part-segment--completed')).toHaveCount(2);
    await expect(graph.locator('.production-part-segment--in_progress')).toHaveCount(2);
    await expect(graph.locator('.production-part-segment--pending')).toHaveCount(0);

    await machineRow.getByRole('button', { name: /850T-1 상세/ }).click();
    const detailDialog = page.getByRole('dialog');
    await expect(detailDialog.getByRole('heading', { name: '850T-1' })).toBeVisible();
    await expect(detailDialog.locator('.production-progress-modal__summary')).toContainText('60');

    const rows = detailDialog.locator('.production-progress-modal__row');
    await expect(rows).toHaveCount(4);
    const expectedQuantities = ['100 / 100', '100 / 100', '20 / 100', '20 / 100'];
    for (let index = 0; index < expectedQuantities.length; index += 1) {
      await expect(rows.nth(index).locator(':scope > span').first()).toHaveText(String(index + 1));
      await expect(rows.nth(index)).toContainText(expectedQuantities[index]);
    }
    await expect(detailDialog.locator('.production-progress-chip--completed')).toHaveCount(2);
    await expect(detailDialog.locator('.production-progress-chip--active')).toHaveCount(2);
    await expect(detailDialog.locator('.production-progress-chip--pending')).toHaveCount(0);

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
    await expect(injectionKpi.locator('.stat-card__hint')).toContainText('계획 7대 완료 100.6%');
    const unplannedKpi = page.getByRole('button', { name: /무계획가동/ });
    await expect(unplannedKpi.locator('.stat-card__value')).toContainText('18회 / 2대');
    await expect(page.getByText('기준일 2026-05-18 사출 완료율은 95%입니다.')).toBeVisible();
    await expect(page.getByRole('heading', { name: '실시간 프로그레스' })).toBeVisible();
    await expect(page.getByText('사출 실시간 진행')).toBeVisible();
    const mesOnlyMachine = page.locator('.production-progress-row').filter({ hasText: '850T-8' }).first();
    await expect(mesOnlyMachine).toBeVisible();
    await expect(mesOnlyMachine).toContainText('형합수');
    await injectionKpi.click();
    const injectionDetail = page.locator('.production-kpi-detail--injection');
    await expect(injectionDetail).toContainText('계획 실적 / 계획');
    await expect(injectionDetail).not.toContainText('무계획가동');
    await expect(injectionDetail).not.toContainText('850T-8');
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
