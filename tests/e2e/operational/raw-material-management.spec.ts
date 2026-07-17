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
      inventory_detail: { status: 'ok', cached: false, record_count: 6 },
      inventory_change_log: { status: 'ok', cached: false, record_count: 5 },
    },
    warning_details: [
      { code: 'unexpected_unit', params: { count: 1, units: ['L'] } },
    ],
    warnings: [
      'Skipped 1 raw-material record(s) with explicit non-kg unit(s): L',
    ],
  },
  warehouse_options: [
    { id: 'warehouse-rm-01', code: 'RM-01', name: '원재료 창고', is_raw_material_candidate: true },
  ],
  selected_warehouses: [
    { id: 'warehouse-rm-01', code: 'RM-01', name: '원재료 창고', is_raw_material_candidate: true },
  ],
  units: ['UN001'],
  summary: {
    material_count: 8,
    inventory_record_count: 8,
    reorder_count: 1,
    critical_count: 1,
    watch_count: 0,
    quantities: [
      {
        unit: 'UN001',
        current: 6120,
        previous_current: 6320,
        change_24h: -200,
        usable: 5615,
        restricted: 505,
        unclassified: 0,
        inbound: 2400,
        outbound: 3060,
        consumption: 2880,
        transfer_out: 180,
        external_production_supply: 2880,
        internal_injection_supply: 180,
        production_outbound: 3060,
        estimated_production_usage: 3060,
        adjustment: -180,
        recommended_order: 1500,
        recommendation_unavailable_count: 0,
      },
    ],
    material_composition: [
      { family: 'abs', unit: 'UN001', current: 3790, material_count: 2 },
      { family: 'pp', unit: 'UN001', current: 1000, material_count: 1 },
      { family: 'pc_abs', unit: 'UN001', current: 980, material_count: 1 },
      { family: 'pc', unit: 'UN001', current: 100, material_count: 1 },
      { family: 'hips', unit: 'UN001', current: 100, material_count: 1 },
      { family: 'pbt', unit: 'UN001', current: 50, material_count: 1 },
      { family: 'other', unit: 'UN001', current: 100, material_count: 1 },
    ],
  },
  trend: [
    {
      date: '2026-07-10',
      values: [
        { unit: 'UN001', inbound: 800, outbound: 920, consumption: 860, transfer_out: 60, external_production_supply: 860, internal_injection_supply: 60, production_outbound: 920, estimated_production_usage: 920, adjustment: -60, net_change: -120, estimated_closing_stock: 6660 },
      ],
      family_values: [
        { family: 'abs', unit: 'UN001', inbound: 800, outbound: 920, consumption: 860, transfer_out: 60, external_production_supply: 860, internal_injection_supply: 60, production_outbound: 920, estimated_production_usage: 920, adjustment: -60, net_change: -120 },
      ],
    },
    {
      date: '2026-07-11',
      values: [
        { unit: 'UN001', inbound: 0, outbound: 680, consumption: 640, transfer_out: 40, external_production_supply: 640, internal_injection_supply: 40, production_outbound: 680, estimated_production_usage: 680, adjustment: -40, net_change: -680, estimated_closing_stock: 5980 },
      ],
      family_values: [
        { family: 'abs', unit: 'UN001', inbound: 0, outbound: 680, consumption: 640, transfer_out: 40, external_production_supply: 640, internal_injection_supply: 40, production_outbound: 680, estimated_production_usage: 680, adjustment: -40, net_change: -680 },
      ],
    },
    {
      date: '2026-07-12',
      values: [
        { unit: 'UN001', inbound: 1000, outbound: 740, consumption: 700, transfer_out: 40, external_production_supply: 700, internal_injection_supply: 40, production_outbound: 740, estimated_production_usage: 740, adjustment: -40, net_change: 260, estimated_closing_stock: 6240 },
      ],
      family_values: [
        { family: 'abs', unit: 'UN001', inbound: 1000, outbound: 740, consumption: 700, transfer_out: 40, external_production_supply: 700, internal_injection_supply: 40, production_outbound: 740, estimated_production_usage: 740, adjustment: -40, net_change: 260 },
      ],
    },
    {
      date: '2026-07-13',
      values: [
        { unit: 'UN001', inbound: 0, outbound: 420, consumption: 400, transfer_out: 20, external_production_supply: 400, internal_injection_supply: 20, production_outbound: 420, estimated_production_usage: 420, adjustment: -20, net_change: -420, estimated_closing_stock: 5820 },
      ],
      family_values: [
        { family: 'abs', unit: 'UN001', inbound: 0, outbound: 420, consumption: 400, transfer_out: 20, external_production_supply: 400, internal_injection_supply: 20, production_outbound: 420, estimated_production_usage: 420, adjustment: -20, net_change: -420 },
      ],
    },
    {
      date: '2026-07-14',
      values: [
        { unit: 'UN001', inbound: 600, outbound: 300, consumption: 280, transfer_out: 20, external_production_supply: 280, internal_injection_supply: 20, production_outbound: 300, estimated_production_usage: 300, adjustment: -20, net_change: 300, estimated_closing_stock: 6120 },
      ],
      family_values: [
        { family: 'abs', unit: 'UN001', inbound: 600, outbound: 300, consumption: 280, transfer_out: 20, external_production_supply: 280, internal_injection_supply: 20, production_outbound: 300, estimated_production_usage: 300, adjustment: -20, net_change: 300 },
      ],
    },
  ],
  materials: [
    {
      group_key: 'code:abs ha641 18388',
      material_id: 'material-abs-ha641-01',
      material_ids: ['material-abs-ha641-01', 'material-abs-ha641-02', 'material-abs-ha641-03'],
      material_code: 'ABS HA641 18388',
      material_name: 'ABS HA641 18388',
      material_family: 'abs',
      manufacturer: 'LG화학',
      color: 'Natural',
      specification: 'Natural',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'kg',
      current_quantity: 290,
      previous_quantity: 290,
      quantity_change_24h: 0,
      usable_quantity: 215,
      previous_usable_quantity: 215,
      usable_change_24h: 0,
      restricted_quantity: 75,
      unclassified_quantity: 0,
      inbound_quantity: 0,
      outbound_quantity: 0,
      consumption_quantity: 0,
      transfer_out_quantity: 0,
      external_production_supply_quantity: 0,
      internal_injection_supply_quantity: 0,
      production_outbound_quantity: 0,
      estimated_production_usage_quantity: 0,
      avg_daily_consumption: 0,
      avg_daily_estimated_production_usage: 0,
      safety_stock: 0,
      reorder_point: 0,
      target_stock: 0,
      recommended_order: 0,
      days_of_cover: null,
      risk: 'no_usage',
      recommendation_available: true,
      stock_detail_count: 3,
    },
    {
      material_code: 'ABS-HF380-BK',
      material_name: 'ABS HF380 Black',
      material_family: 'abs',
      manufacturer: 'LG화학',
      color: 'Black',
      specification: '난연 / Black',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'UN001',
      current_quantity: 3500,
      previous_quantity: 3800,
      quantity_change_24h: -150,
      usable_quantity: 3350,
      previous_usable_quantity: 3600,
      usable_change_24h: -100,
      restricted_quantity: 150,
      unclassified_quantity: 0,
      inbound_quantity: 1200,
      outbound_quantity: 1740,
      consumption_quantity: 1620,
      transfer_out_quantity: 80,
      external_production_supply_quantity: 1620,
      internal_injection_supply_quantity: 80,
      production_outbound_quantity: 1700,
      estimated_production_usage_quantity: 1700,
      avg_daily_consumption: 81,
      avg_daily_estimated_production_usage: 85,
      safety_stock: 1200,
      reorder_point: 1767,
      target_stock: 3000,
      recommended_order: 0,
      days_of_cover: 43.21,
      risk: 'healthy',
    },
    {
      material_code: 'PP-GF40-LGK1400M',
      material_name: 'PP-GF40 LGK-1400M',
      material_family: 'pp',
      manufacturer: 'LG화학',
      color: 'Black',
      specification: 'GF40 / Black',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'UN001',
      current_quantity: 1000,
      previous_quantity: 1000,
      quantity_change_24h: 0,
      usable_quantity: 1000,
      previous_usable_quantity: 1000,
      usable_change_24h: 0,
      restricted_quantity: 0,
      unclassified_quantity: 0,
      inbound_quantity: 0,
      outbound_quantity: 0,
      consumption_quantity: 0,
      transfer_out_quantity: 0,
      avg_daily_consumption: 0,
      safety_stock: 0,
      reorder_point: 0,
      target_stock: 0,
      recommended_order: 0,
      days_of_cover: null,
      risk: 'no_usage',
      recommendation_available: true,
    },
    {
      material_code: 'PC1201',
      material_name: 'PC1201 Clear',
      material_family: 'pc',
      manufacturer: '롯데케미칼',
      color: 'Transparent',
      specification: 'Transparent',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'KG',
      current_quantity: 100,
      previous_quantity: 100,
      quantity_change_24h: 0,
      usable_quantity: 100,
      previous_usable_quantity: 100,
      usable_change_24h: 0,
      restricted_quantity: 0,
      unclassified_quantity: 0,
      inbound_quantity: 0,
      outbound_quantity: 0,
      consumption_quantity: 0,
      transfer_out_quantity: 0,
      avg_daily_consumption: 0,
      safety_stock: 0,
      reorder_point: 0,
      target_stock: 0,
      recommended_order: 0,
      days_of_cover: null,
      risk: 'no_usage',
      recommendation_available: true,
    },
    {
      material_code: 'POM-F20',
      material_name: 'POM F20',
      material_family: 'other',
      manufacturer: 'KEP',
      color: 'Natural',
      specification: 'Natural',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'kg',
      current_quantity: 100,
      previous_quantity: 100,
      quantity_change_24h: 0,
      usable_quantity: 100,
      previous_usable_quantity: 100,
      usable_change_24h: 0,
      restricted_quantity: 0,
      unclassified_quantity: 0,
      inbound_quantity: 0,
      outbound_quantity: 0,
      consumption_quantity: 0,
      transfer_out_quantity: 0,
      avg_daily_consumption: 0,
      safety_stock: 0,
      reorder_point: 0,
      target_stock: 0,
      recommended_order: 0,
      days_of_cover: null,
      risk: 'no_usage',
      recommendation_available: true,
    },
    {
      material_code: 'HIPS-825-BK',
      material_name: 'HIPS 825 Black',
      material_family: 'hips',
      manufacturer: '금호석유화학',
      color: 'Black',
      specification: 'Black',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'kg',
      current_quantity: 100,
      previous_quantity: 100,
      quantity_change_24h: 0,
      usable_quantity: 100,
      restricted_quantity: 0,
      unclassified_quantity: 0,
      inbound_quantity: 0,
      outbound_quantity: 0,
      consumption_quantity: 0,
      transfer_out_quantity: 0,
      external_production_supply_quantity: 0,
      internal_injection_supply_quantity: 0,
      production_outbound_quantity: 0,
      estimated_production_usage_quantity: 0,
      avg_daily_consumption: 0,
      avg_daily_estimated_production_usage: 0,
      risk: 'no_usage',
      recommendation_available: true,
    },
    {
      material_code: 'PBT-1100-NC',
      material_name: 'PBT 1100 NC',
      material_family: 'pbt',
      manufacturer: '듀폰',
      color: 'NC',
      specification: 'NC',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'kg',
      current_quantity: 50,
      previous_quantity: 50,
      quantity_change_24h: 0,
      usable_quantity: 50,
      restricted_quantity: 0,
      unclassified_quantity: 0,
      inbound_quantity: 0,
      outbound_quantity: 0,
      consumption_quantity: 0,
      transfer_out_quantity: 0,
      external_production_supply_quantity: 0,
      internal_injection_supply_quantity: 0,
      production_outbound_quantity: 0,
      estimated_production_usage_quantity: 0,
      avg_daily_consumption: 0,
      avg_daily_estimated_production_usage: 0,
      risk: 'no_usage',
      recommendation_available: true,
    },
    {
      material_code: 'PCABS-FR3010-GY',
      material_name: 'PC/ABS FR3010 Gray',
      material_family: 'pc_abs',
      manufacturer: 'LG화학',
      color: 'Gray',
      specification: 'V-0 / Gray',
      warehouse_code: 'RM-01',
      warehouse_name: '원재료 창고',
      unit: 'KG',
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
      external_production_supply_quantity: 1260,
      internal_injection_supply_quantity: 100,
      production_outbound_quantity: 1360,
      estimated_production_usage_quantity: 1360,
      avg_daily_consumption: 74,
      avg_daily_estimated_production_usage: 76,
      safety_stock: 800,
      reorder_point: 1318,
      target_stock: 2200,
      recommended_order: 1500,
      days_of_cover: 9.46,
      risk: 'critical',
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
      unit: 'UN001',
      after_quantity: 980,
      material_id: 'material-pcabs-fr3010-gy',
      material_code: 'PCABS-FR3010-GY',
      material_name: 'PC/ABS FR3010 Gray',
      material_family: 'pc_abs',
      manufacturer: 'LG화학',
      color: 'Gray',
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
      unit: 'KG',
      material_code: 'ABS-HF380-BK',
      material_name: 'ABS HF380 Black',
      material_family: 'abs',
      manufacturer: 'LG화학',
      color: 'Black',
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
      unit: '千克',
      after_quantity: 4850,
      material_id: 'material-abs-hf380-bk',
      material_code: 'ABS-HF380-BK',
      material_name: 'ABS HF380 Black',
      material_family: 'abs',
      manufacturer: 'LG화학',
      color: 'Black',
      specification: '난연 / Black',
      warehouse_name: '원재료 창고',
      storage_location: 'A-01-01',
      batch_no: 'LOT-260714-01',
      operator: '김창고',
      supplier_name: 'LG화학',
      is_consumption: false,
    },
  ],
};

const rawMaterialDetails = {
  group_key: 'code:abs ha641 18388',
  unit: 'kg',
  stock_detail_count: 3,
  total_quantity: 290,
  page: 1,
  page_size: 100,
  total_pages: 1,
  stock_details: [
    {
      inventory_id: 'inventory-ha641-a',
      material_id: 'material-abs-ha641-01',
      quantity: 90,
      unit: 'kg',
      batch_no: 'LOT-A',
      supplier_batch_no: 'SUP-A',
      inbound_at: '2026-07-10T09:00:00+08:00',
      qc_status_code: 1,
      qc_status_label: '合格',
      storage_location: 'A-01',
      qr_code: 'QR-A',
      inbound_order_numbers: ['IN-1001'],
    },
    {
      inventory_id: 'inventory-ha641-c',
      material_id: 'material-abs-ha641-03',
      quantity: 75,
      unit: 'kg',
      batch_no: 'LOT-C',
      inbound_at: '2026-07-12T14:30:00+08:00',
      qc_status_code: 4,
      qc_status_label: '不合格',
      storage_location: 'A-03',
      inbound_order_numbers: ['IN-1003'],
    },
    {
      inventory_id: 'inventory-ha641-b',
      material_id: 'material-abs-ha641-02',
      quantity: 125,
      unit: 'kg',
      batch_no: 'LOT-B',
      supplier_batch_no: '',
      inbound_at: null,
      qc_status_code: 2,
      qc_status_label: '让步合格',
      storage_location: 'A-02',
      qr_code: 'QR-B',
      inbound_order_numbers: [],
    },
  ],
};

test.describe('raw material management operational scenario', () => {
  test('shows a fixed raw-material kg dashboard with localized warnings and manual sync', async ({ page }) => {
    const guard = installPageIssueGuard(page);
    await installDevSession(page, 'ko');
    let overviewRequests = 0;
    const overviewLookbacks: string[] = [];
    let detailRequests = 0;
    let syncStarted = false;
    let syncPostRequests = 0;
    let syncStatusRequests = 0;

    await page.route(/\/api\/inventory\/raw-materials\/overview\/(?:\?.*)?$/, async (route) => {
      overviewRequests += 1;
      overviewLookbacks.push(new URL(route.request().url()).searchParams.get('lookback_days') || '');
      await route.fulfill({ json: rawMaterialOverview });
    });
    await page.route(/\/api\/inventory\/raw-materials\/details\/(?:\?.*)?$/, async (route) => {
      detailRequests += 1;
      const requestUrl = new URL(route.request().url());
      expect(requestUrl.searchParams.get('group_key')).toBe('code:abs ha641 18388');
      expect(requestUrl.searchParams.get('unit')).toBe('kg');
      expect(requestUrl.searchParams.get('page')).toBe('1');
      expect(requestUrl.searchParams.get('page_size')).toBe('100');
      await route.fulfill({ json: rawMaterialDetails });
    });
    await page.route(/\/api\/inventory\/raw-materials\/sync\/(?:\?.*)?$/, async (route) => {
      if (route.request().method() === 'POST') {
        syncPostRequests += 1;
        if (syncPostRequests > 1) {
          await route.fulfill({
            status: 200,
            json: {
              status: 'cooldown',
              trigger: 'manual',
              message: '서버 부하 방지를 위해 잠시 후 다시 시도해주세요.',
              finished_at: '2026-07-14T10:40:02+08:00',
              updated_at: '2026-07-14T10:40:03+08:00',
            },
          });
          return;
        }
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
    await expect(page.locator('.raw-kpi-grid')).toHaveCount(0);
    const compositionPanel = page.locator('.raw-composition-panel');
    await expect(compositionPanel.getByRole('heading', { name: '수지군별 현재고 구성', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '저장 현재고 건전성', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '발주 위험 분포', exact: true })).toHaveCount(0);
    await expect(compositionPanel.getByRole('listitem')).toHaveCount(7);
    const familyCards = compositionPanel.locator('.raw-family-card');
    await expect(familyCards).toHaveCount(7);
    await expect(familyCards).toHaveText([/ABS/, /PC-ABS/, /PP/, /PC/, /HIPS/, /PBT/, /기타·미분류/]);
    const familyCardPositions = await familyCards.evaluateAll((cards) => cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top };
    }));
    expect(Math.max(...familyCardPositions.map(({ top }) => top)) - Math.min(...familyCardPositions.map(({ top }) => top))).toBeLessThanOrEqual(2);
    familyCardPositions.slice(1).forEach((position, index) => {
      expect(position.left).toBeGreaterThanOrEqual(familyCardPositions[index].right - 1);
    });
    await expect(compositionPanel.getByText('6,120 kg', { exact: true })).toBeVisible();
    await expect(compositionPanel.getByText('3,790 kg', { exact: true })).toBeVisible();
    await expect(compositionPanel.getByRole('img', { name: /ABS 3,790 kg 61.9%.*PC-ABS 980 kg 16%.*PP 1,000 kg 16.3%/ })).toBeVisible();

    const absFamilyCard = page.getByTestId('raw-family-card-abs');
    await expect(absFamilyCard).toHaveAttribute('aria-expanded', 'false');
    await absFamilyCard.click();
    const familyDialog = page.getByRole('dialog', { name: 'ABS 원료 상세' });
    await expect(familyDialog).toBeVisible();
    await expect(absFamilyCard).toHaveAttribute('aria-expanded', 'true');
    await expect(familyDialog.getByText('3,790 kg', { exact: true })).toBeVisible();
    await expect(familyDialog.getByText('2종 원료', { exact: true })).toBeVisible();
    await expect(familyDialog.getByTestId('raw-family-detail-row')).toHaveCount(2);
    await expect(familyDialog.getByText('ABS HF380 Black', { exact: true })).toBeVisible();
    await expect(familyDialog.getByText('ABS HA641 18388', { exact: true }).first()).toBeVisible();
    await expect(familyDialog.getByRole('heading', { name: '색상별 현재고 구성', exact: true })).toBeVisible();
    await expect(familyDialog.getByText('Black', { exact: true }).first()).toBeVisible();
    await expect(familyDialog.getByText('Natural', { exact: true }).first()).toBeVisible();
    await expect(familyDialog.getByText('LG화학', { exact: true }).first()).toBeVisible();
    await expect(familyDialog.getByText('PP-GF40 LGK-1400M', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
    await expect(familyDialog).toHaveCount(0);
    await expect(absFamilyCard).toBeFocused();

    const pcAbsFamilyCard = page.getByTestId('raw-family-card-pc_abs');
    await pcAbsFamilyCard.click();
    await expect(page.getByRole('dialog', { name: 'PC-ABS 원료 상세' })).toContainText('PC/ABS FR3010 Gray');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(pcAbsFamilyCard).toBeFocused();

    const trendPanel = page.locator('.raw-trend-panel');
    await expect(trendPanel.getByRole('heading', { name: '수지군별 입출고 변동 추이', exact: true })).toBeVisible();
    await expect(page.getByTestId('raw-trend-family-filter').getByRole('button', { name: 'HIPS', exact: true })).toBeVisible();
    await expect(page.getByTestId('raw-trend-family-filter').getByRole('button', { name: 'PBT', exact: true })).toBeVisible();
    await expect(page.getByTestId('raw-trend-period-filter').getByRole('button', { name: '30 일', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('raw-trend-period-filter').getByRole('button', { name: '7 일', exact: true }).click();
    await expect.poll(() => overviewLookbacks).toContain('7');
    await expect(page.getByTestId('raw-trend-period-filter').getByRole('button', { name: '7 일', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('raw-trend-family-filter').getByRole('button', { name: 'ABS', exact: true }).click();
    await expect(trendPanel.getByRole('img', { name: /일별 생산 관련 입출고 · ABS · 7 일/ })).toBeVisible();
    await expect(trendPanel.getByText('협력사 생산 공급(出库)', { exact: true }).first()).toBeVisible();
    await expect(trendPanel.getByText('사내 사출 생산 공급(转移出库)', { exact: true }).first()).toBeVisible();
    await expect(trendPanel.getByText('추정 소요', { exact: true })).toBeVisible();
    await expect(trendPanel).not.toContainText('판매');
    await expect(page.getByText('원재료창고', { exact: true })).toBeVisible();
    await expect(page.getByText('kg', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('매일 08:00 자동 업데이트', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '수량 단위' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '원재료 후보 자동 선택' })).toHaveCount(0);
    await expect(page.getByText('고급 분석 조건', { exact: true })).toHaveCount(0);
    await expect(page.getByText('UN001', { exact: true })).toHaveCount(0);
    await expect(page.locator('.raw-table-panel .raw-material-search')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: '원재료 검색' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('kg가 아닌 재고(L)는 합계와 분석에서 제외했습니다 (1건).');
    await expect(page.getByText(/Skipped 1 raw-material record/)).toHaveCount(0);

    await expect(page.getByText('ABS HF380 Black', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('PC/ABS FR3010 Gray', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('LOT-260714-02', { exact: true })).toBeVisible();
    await expect(page.getByText('협력사 생산 공급(出库)', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('사내 사출 생산 공급(转移出库)', { exact: true }).last()).toBeVisible();

    const materialSearch = page.getByRole('searchbox', { name: '원재료 검색' });
    await materialSearch.fill('LOT-A');
    await expect(page.getByText('선택한 조건에 맞는 원재료가 없습니다.', { exact: true })).toBeVisible();
    expect(detailRequests).toBe(0);
    await materialSearch.clear();

    const inventoryTable = page.locator('.raw-inventory-table');
    const groupedRow = inventoryTable.locator('tbody tr.raw-inventory-summary-row').filter({ hasText: 'ABS HA641 18388' });
    await expect(groupedRow).toHaveCount(1);
    await expect(groupedRow).toContainText('290');
    expect(detailRequests).toBe(0);
    const detailToggle = groupedRow.getByRole('button', { name: /ABS HA641 18388 · 재고 상세 펼치기/ });
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    await groupedRow.locator('td').nth(2).click();
    await expect(groupedRow.getByRole('button', { name: /ABS HA641 18388 · 재고 상세 접기/ })).toHaveAttribute('aria-expanded', 'true');
    const detailPanel = page.getByRole('region', { name: 'ABS HA641 18388 현재고 상세' });
    await expect(detailPanel).toBeVisible();
    await expect.poll(() => detailRequests).toBe(1);
    await expect(detailPanel).toContainText('상세 합계 290 kg');
    await expect(detailPanel).toContainText('LOT-A');
    await expect(detailPanel).toContainText('LOT-B');
    await expect(detailPanel).toContainText('LOT-C');
    await expect(detailPanel).toContainText(/2026.*07.*10/);
    await expect(detailPanel).toContainText('미수집');
    await groupedRow.locator('td').nth(2).click();
    await expect(detailPanel).toHaveCount(0);
    await groupedRow.locator('td').nth(2).click();
    await expect(page.getByRole('region', { name: 'ABS HA641 18388 현재고 상세' })).toBeVisible();
    expect(detailRequests).toBe(1);
    await groupedRow.locator('td').nth(2).click();

    const tables = page.locator('table.raw-table');
    await expect(tables).toHaveCount(2);
    await expect(inventoryTable).toContainText('1,500');
    await expect(page.locator('.raw-movement-table')).toContainText('300');
    await expect(page.locator('.raw-material-page svg')).not.toHaveCount(0);

    await page.getByRole('button', { name: '수동 MES 업데이트' }).click();
    await expect(page.getByText('MES 데이터를 한 번만 수집해 새 보고서를 만드는 중입니다. 완료되면 화면이 자동으로 갱신됩니다.')).toBeVisible();
    await expect(page.getByText('수동 MES 업데이트가 완료되어 저장된 보고서를 갱신했습니다.')).toBeVisible({ timeout: 6_000 });
    await expect.poll(() => overviewRequests).toBeGreaterThan(1);

    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.getByRole('heading', { name: '原材料管理', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '按树脂类别查看当前库存', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '按树脂类别查看出入库趋势', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '订货风险分布', exact: true })).toHaveCount(0);
    await expect(page.getByText('其他/未分类', { exact: true }).first()).toBeVisible();
    await page.getByTestId('raw-family-card-pc_abs').click();
    const chineseFamilyDialog = page.getByRole('dialog', { name: 'PC-ABS 原材料明细' });
    await expect(chineseFamilyDialog).toBeVisible();
    await expect(chineseFamilyDialog).toContainText('查看归入同一树脂类别的原材料厂家、颜色与当前库存。');
    await page.getByRole('button', { name: '关闭明细', exact: true }).click();
    await expect(chineseFamilyDialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('非 kg 库存（L）已从合计和分析中排除（1 条）。');
    await expect(page.getByRole('combobox', { name: '数量单位' })).toHaveCount(0);
    await expect(page.getByText('外协生产供料（出库）', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('内部注塑生产供料（转移出库）', { exact: true }).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('销售');
    const chineseGroupedRow = page.locator('.raw-inventory-table tbody tr.raw-inventory-summary-row').filter({ hasText: 'ABS HA641 18388' });
    await chineseGroupedRow.locator('td').nth(2).click();
    await expect(page.getByRole('region', { name: 'ABS HA641 18388 当前库存明细' })).toContainText('未采集');
    await expect.poll(() => detailRequests).toBeGreaterThan(1);
    await page.getByRole('button', { name: '手动更新 MES' }).click();
    await expect(page.getByText('刚完成一次 MES 更新。为避免增加服务器负载，请稍后重试。', { exact: true })).toBeVisible();
    await expect(page.getByText('手动 MES 更新失败。', { exact: true })).toHaveCount(0);

    expect(overviewRequests).toBeGreaterThan(0);
    expect(syncStatusRequests).toBeGreaterThan(1);
    await expectNoUndefinedOrNaN(page);
    guard.assertClean();
  });

  test('centers the family detail in the currently visible embedded viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installDevSession(page, 'ko');
    await page.route(/\/api\/inventory\/raw-materials\/overview\/(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: rawMaterialOverview });
    });
    await page.route(/\/api\/inventory\/raw-materials\/sync\/(?:\?.*)?$/, async (route) => {
      await route.fulfill({ json: { status: 'idle', trigger: '', message: '' } });
    });

    await page.goto('/inventory/raw-materials');
    await expect(page.getByTestId('raw-family-card-abs')).toBeVisible();
    await page.evaluate(() => {
      document.body.innerHTML = '<iframe id="raw-material-embed-test" src="/index.html?view=raw-materials&amp;embed=1&amp;frameId=e2e-raw-material" style="display:block;width:100%;height:3600px;border:0"></iframe>';
      document.body.style.margin = '0';
    });

    const embedded = page.frameLocator('#raw-material-embed-test');
    await expect(embedded.getByTestId('raw-family-card-abs')).toBeVisible();
    await embedded.getByTestId('raw-family-card-abs').click();
    const dialog = embedded.getByRole('dialog', { name: 'ABS 원료 상세' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - 360)).toBeLessThan(90);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await embedded.getByRole('button', { name: '상세 닫기', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  });
});
