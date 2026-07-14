import { expect, test } from '@playwright/test';
import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installPageIssueGuard,
} from '../helpers/operational';

const rawMaterialOverview = {
  status: 'ok',
  meta: {
    generated_at: '2026-07-14T08:03:00+08:00',
    inventory_source_latest_at: '2026-07-14T08:00:00+08:00',
    change_log_source_latest_at: '2026-07-14T08:00:00+08:00',
    data_mode: 'stored',
    snapshot_synced_at: '2026-07-14T08:03:00+08:00',
    sync_required: false,
    comparison_available: true,
    comparison_start_at: '2026-07-13T08:00:00+08:00',
    comparison_end_at: '2026-07-14T08:00:00+08:00',
    comparison_hours: 24,
    timezone: 'Asia/Shanghai',
    lookback_days: 30,
    lead_time_days: 7,
    review_period_days: 14,
    range_start: '2026-06-15',
    range_end: '2026-07-14',
    assumptions: ['최근 출고량을 사용량으로 간주합니다.'],
    recommendations_available: true,
    sources: {
      inventory_detail: { status: 'ok', cached: false, record_count: 3 },
      inventory_change_log: { status: 'ok', cached: false, record_count: 5 },
    },
    warnings: [],
  },
  warehouse_options: [
    { id: 'warehouse-rm-01', code: 'RM-01', name: '원재료 창고', is_raw_material_candidate: true },
    { id: 'warehouse-chem-01', code: 'CHEM-01', name: '부자재 창고', is_raw_material_candidate: true },
  ],
  selected_warehouses: [
    { id: 'warehouse-rm-01', code: 'RM-01', name: '원재료 창고', is_raw_material_candidate: true },
    { id: 'warehouse-chem-01', code: 'CHEM-01', name: '부자재 창고', is_raw_material_candidate: true },
  ],
  units: ['kg', 'L'],
  summary: {
    material_count: 3,
    inventory_record_count: 3,
    reorder_count: 1,
    critical_count: 1,
    watch_count: 0,
    quantities: [
      {
        unit: 'kg',
        current: 5830,
        previous_current: 6030,
        change_24h: -200,
        usable: 5400,
        restricted: 430,
        unclassified: 0,
        inbound: 2400,
        outbound: 3060,
        consumption: 2880,
        transfer_out: 180,
        adjustment: -180,
        recommended_order: 1500,
        recommendation_unavailable_count: 0,
      },
      {
        unit: 'L',
        current: 420,
        previous_current: 405,
        change_24h: 15,
        usable: 400,
        restricted: 20,
        unclassified: 0,
        inbound: 180,
        outbound: 135,
        consumption: 120,
        transfer_out: 15,
        adjustment: -15,
        recommended_order: 0,
        recommendation_unavailable_count: 1,
      },
    ],
  },
  trend: [
    {
      date: '2026-07-10',
      values: [
        { unit: 'kg', inbound: 800, outbound: 920, consumption: 860, transfer_out: 60, adjustment: -60, net_change: -120, estimated_closing_stock: 6370 },
        { unit: 'L', inbound: 60, outbound: 45, consumption: 40, transfer_out: 5, adjustment: -5, net_change: 15, estimated_closing_stock: 390 },
      ],
    },
    {
      date: '2026-07-11',
      values: [
        { unit: 'kg', inbound: 0, outbound: 680, consumption: 640, transfer_out: 40, adjustment: -40, net_change: -680, estimated_closing_stock: 5690 },
        { unit: 'L', inbound: 0, outbound: 30, consumption: 28, transfer_out: 2, adjustment: -2, net_change: -30, estimated_closing_stock: 360 },
      ],
    },
    {
      date: '2026-07-12',
      values: [
        { unit: 'kg', inbound: 1000, outbound: 740, consumption: 700, transfer_out: 40, adjustment: -40, net_change: 260, estimated_closing_stock: 5950 },
        { unit: 'L', inbound: 120, outbound: 25, consumption: 22, transfer_out: 3, adjustment: -3, net_change: 95, estimated_closing_stock: 455 },
      ],
    },
    {
      date: '2026-07-13',
      values: [
        { unit: 'kg', inbound: 0, outbound: 420, consumption: 400, transfer_out: 20, adjustment: -20, net_change: -420, estimated_closing_stock: 5530 },
        { unit: 'L', inbound: 0, outbound: 20, consumption: 18, transfer_out: 2, adjustment: -2, net_change: -20, estimated_closing_stock: 435 },
      ],
    },
    {
      date: '2026-07-14',
      values: [
        { unit: 'kg', inbound: 600, outbound: 300, consumption: 280, transfer_out: 20, adjustment: -20, net_change: 300, estimated_closing_stock: 5830 },
        { unit: 'L', inbound: 0, outbound: 15, consumption: 12, transfer_out: 3, adjustment: -3, net_change: -15, estimated_closing_stock: 420 },
      ],
    },
  ],
  materials: [
    {
      material_code: 'ABS-HF380-BK',
      material_name: 'ABS HF380 Black',
      specification: '난연 / Black',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'kg',
      current_quantity: 4850,
      previous_quantity: 5000,
      quantity_change_24h: -150,
      usable_quantity: 4700,
      previous_usable_quantity: 4800,
      usable_change_24h: -100,
      restricted_quantity: 150,
      unclassified_quantity: 0,
      inbound_quantity: 1200,
      outbound_quantity: 1740,
      consumption_quantity: 1620,
      transfer_out_quantity: 80,
      avg_daily_consumption: 81,
      safety_stock: 1200,
      reorder_point: 1767,
      target_stock: 3000,
      recommended_order: 0,
      days_of_cover: 58,
      risk: 'healthy',
    },
    {
      material_code: 'PCABS-FR3010-GY',
      material_name: 'PC/ABS FR3010 Gray',
      specification: 'V-0 / Gray',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'kg',
      current_quantity: 980,
      previous_quantity: 1030,
      quantity_change_24h: -50,
      usable_quantity: 700,
      previous_usable_quantity: 760,
      usable_change_24h: -60,
      restricted_quantity: 280,
      unclassified_quantity: 0,
      inbound_quantity: 1200,
      outbound_quantity: 1320,
      consumption_quantity: 1260,
      transfer_out_quantity: 100,
      avg_daily_consumption: 74,
      safety_stock: 800,
      reorder_point: 1318,
      target_stock: 2200,
      recommended_order: 1500,
      days_of_cover: 9.46,
      risk: 'critical',
    },
    {
      material_code: 'RA-550',
      material_name: '이형제 RA-550',
      specification: '20 L / CAN',
      warehouse_code: 'CHEM-01',
      warehouse_name: '부자재 창고',
      unit: 'L',
      current_quantity: 420,
      previous_quantity: 405,
      quantity_change_24h: 15,
      usable_quantity: 400,
      previous_usable_quantity: 390,
      usable_change_24h: 10,
      restricted_quantity: 20,
      unclassified_quantity: 0,
      inbound_quantity: 180,
      outbound_quantity: 135,
      consumption_quantity: 120,
      transfer_out_quantity: 15,
      avg_daily_consumption: 6,
      safety_stock: 100,
      reorder_point: 142,
      target_stock: 240,
      recommended_order: 0,
      days_of_cover: 66.67,
      risk: 'healthy',
      recommendation_available: false,
      recommendation_status: 'insufficient_data',
    },
  ],
  recent_transactions: [
    {
      id: 'tx-260714-03',
      created_at: '2026-07-14T09:42:00+08:00',
      action_code: 'out',
      action_label: '생산 출고(추정 소요)',
      direction: 'out',
      quantity: 300,
      unit: 'kg',
      after_quantity: 980,
      material_id: 'material-pcabs-fr3010-gy',
      material_code: 'PCABS-FR3010-GY',
      material_name: 'PC/ABS FR3010 Gray',
      specification: 'V-0 / Gray',
      warehouse_name: '원재료 창고',
      storage_location: 'A-02-03',
      batch_no: 'LOT-260714-02',
      operator: 'MES 자동연동',
      supplier_name: 'LG화학',
      is_consumption: true,
      is_transfer_out: false,
    },
    {
      id: 'tx-260714-transfer',
      created_at: '2026-07-14T09:00:00+08:00',
      action_code: 'issue',
      action_label: '이동 출고',
      direction: 'out',
      quantity: 20,
      unit: 'kg',
      material_code: 'ABS-HF380-BK',
      material_name: 'ABS HF380 Black',
      warehouse_name: '원재료 창고',
      batch_no: 'LOT-260714-T1',
      operator: 'MES 자동연동',
      is_consumption: false,
      is_transfer_out: true,
    },
    {
      id: 'tx-260714-02',
      created_at: '2026-07-14T08:15:00+08:00',
      action_code: 'purchase_receipt',
      action_label: '구매 입고',
      direction: 'in',
      quantity: 600,
      unit: 'kg',
      after_quantity: 4850,
      material_id: 'material-abs-hf380-bk',
      material_code: 'ABS-HF380-BK',
      material_name: 'ABS HF380 Black',
      specification: '난연 / Black',
      warehouse_name: '원재료 창고',
      storage_location: 'A-01-01',
      batch_no: 'LOT-260714-01',
      operator: '김창고',
      supplier_name: 'LG화학',
      is_consumption: false,
    },
    {
      id: 'tx-260713-01',
      created_at: '2026-07-13T16:30:00+08:00',
      action_code: 'amount_adjust',
      action_label: '재고 조정',
      direction: 'out',
      quantity: 3,
      unit: 'L',
      after_quantity: 420,
      material_id: 'material-ra-550',
      material_code: 'RA-550',
      material_name: '이형제 RA-550',
      specification: '20 L / CAN',
      warehouse_name: '부자재 창고',
      storage_location: 'C-01-02',
      batch_no: 'LOT-260701-05',
      operator: '박자재',
      supplier_name: '한국케미칼',
      is_consumption: false,
    },
  ],
};

test.describe('raw material management operational scenario', () => {
  test('shows unit-separated stock, movement trends, ordering risk, and transaction evidence', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installDevSession(page, 'ko');
    let overviewRequests = 0;
    let syncStarted = false;
    let syncStatusRequests = 0;

    await page.route(/\/api\/inventory\/raw-materials\/overview\/(?:\?.*)?$/, async (route) => {
      overviewRequests += 1;
      await route.fulfill({ json: rawMaterialOverview });
    });
    await page.route(/\/api\/inventory\/raw-materials\/sync\/(?:\?.*)?$/, async (route) => {
      if (route.request().method() === 'POST') {
        syncStarted = true;
        await route.fulfill({
          status: 202,
          json: {
            status: 'running',
            trigger: 'manual',
            message: '동기화 중',
            started_at: '2026-07-14T10:40:00+08:00',
            updated_at: '2026-07-14T10:40:00+08:00',
          },
        });
        return;
      }
      syncStatusRequests += 1;
      await route.fulfill({
        json: syncStarted
          ? {
              status: 'completed',
              trigger: 'manual',
              message: '완료',
              started_at: '2026-07-14T10:40:00+08:00',
              finished_at: '2026-07-14T10:40:02+08:00',
              updated_at: '2026-07-14T10:40:02+08:00',
            }
          : { status: 'idle', trigger: '', message: '' },
      });
    });

    await page.goto('/inventory/raw-materials');

    await expect(page.locator('.raw-material-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: '원재료 관리', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '24시간 재고 변화', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '원재료 재고 현황', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '최근 입출고 기록', exact: true })).toBeVisible();

    await expect(page.getByText('ABS HF380 Black', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('PC/ABS FR3010 Gray', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('LOT-260714-02', { exact: true })).toBeVisible();
    await expect(page.getByText('생산 출고(추정 소요)', { exact: true })).toBeVisible();
    await expect(page.getByText('이동 출고', { exact: true }).first()).toBeVisible();

    const tables = page.getByRole('table');
    await expect(tables).toHaveCount(2);
    await expect(tables.first()).toContainText('1,500');
    await expect(tables.last()).toContainText('300');
    await expect(page.locator('.raw-material-page svg')).not.toHaveCount(0);
    await page.getByLabel('수량 단위').selectOption('L');
    await expect(page.getByText('이형제 RA-550', { exact: true }).first()).toBeVisible();
    await expect(tables.last()).toContainText('재고 조정');
    await expect(tables.last()).toContainText('−3 L');
    await expect(page.getByText('사용 이력이나 완료 영업일 데이터가 부족해 발주 권고를 산정할 수 없습니다.').first()).toBeVisible();

    await page.getByRole('button', { name: '수동 MES 업데이트' }).click();
    await expect(page.getByText('MES 데이터를 한 번만 수집해 새 보고서를 만드는 중입니다. 완료되면 화면이 자동으로 갱신됩니다.')).toBeVisible();
    await expect(page.getByText('수동 MES 업데이트가 완료되어 저장된 보고서를 갱신했습니다.')).toBeVisible({ timeout: 6_000 });
    await expect.poll(() => overviewRequests).toBeGreaterThan(1);

    expect(overviewRequests).toBeGreaterThan(0);
    expect(syncStatusRequests).toBeGreaterThan(1);
    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });
});
