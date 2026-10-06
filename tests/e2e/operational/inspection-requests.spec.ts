import type { MesReadItem, MesReadItemSource, MesReadObservation, MesReadRecord } from '../../../frontend/src/pages/quality/inspection-requests/mesReadObservation';
import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import type { InspectionCapabilities, InspectionDataMode, InspectionRequest } from '../../../frontend/src/pages/quality/inspection-requests/model';
import type { InspectionKanban } from '../../../frontend/src/pages/quality/inspection-requests/kanban';

const path = '/quality/inspection-requests';
const apiPath = '/api/quality/inspection-requests/';
const now = '2026-09-30T03:00:00.000Z';

function syntheticSourceItems(): MesReadItem[] {
  const source: MesReadItemSource = { config_row_id: '10000000000001001', master_check_item_id: '10000000000002001',
    config_version_id: '10000000000003001', serial_no: 5, outer_group_name: 'SYNTHETIC', nested_group_name: null,
    unit: { id: null, code: null, name: 'mm' }, minimum: '19.1000000000', maximum: '21.9000000000', base: null,
    logic: { code: 1, message: '区间' }, scale: 2, execute_item_type: { code: 1, message: '数值' },
    value_type: { code: 2, message: '数值区间' }, required_type: { code: 1, message: '必填' }, options: [],
    check_count: '1.0000000000', task_check_count: '1.0000000000', total_report_count: 2, required_report_count: null, filled_report_count: 2 };
  const record: MesReadRecord = { record_id: '10000000000004001', config_row_id: source.config_row_id,
    outer_group_name: 'SYNTHETIC', seq: 1, result: null, minimum: '20.0000000000', maximum: null,
    option: null, single_judgment: 1, task_check_count: '1.0000000000', timestamps: {}, write_check_item_id: null, write_mapping_verified: false };
  return [{ ordinal: 0, label: 'SYNTHETIC weight', unit: 'mm', minimum: '19.1', maximum: '21.9',
    required: true, recorded_value: null, write_mapping_verified: false, source,
    records: [record, { ...record, record_id: '10000000000004002', seq: 2, result: '20.5000000000', minimum: null }] },
  { ordinal: 1, label: 'SYNTHETIC deformation', unit: 'mm', minimum: null, maximum: null,
    required: true, recorded_value: null, write_mapping_verified: false,
    source: { ...source, config_row_id: '10000000000001002', minimum: null, maximum: null, base: '7.0000000000', logic: { code: 5, message: '<=' }, scale: 1 }, records: [] },
  { ordinal: 2, label: 'SYNTHETIC choice', unit: null, minimum: null, maximum: null, required: false,
    recorded_value: null, write_mapping_verified: false,
    source: { ...source, config_row_id: '10000000000001003', minimum: null, maximum: null, options: ['合格', '不合格'],
      logic: { code: null, message: null }, value_type: { code: null, message: null }, execute_item_type: { code: 4, message: '单选项' }, scale: null }, records: [] }];
}

function labels(info: TestInfo) {
  return info.project.name === 'zh-mobile' ? {
    language: 'zh' as const, title: '检验管理', quality: '品质', board: '按设备查看检验申请',
    local: 'WJ 检验申请', preview: '合成预览 · 测试数据 · MES 未连接',
    plans: 'WJ 生产计划', manual: 'WJ 手工输入', previewPlans: '合成生产计划', previewRequests: '合成检验申请',
    back: '返回看板', create: '登记手工检验申请', cancel: '取消', notes: '检验备注',
    save: '保存草稿', submit: '提交检验结果', saved: '已保存 WJ Reporting 草稿与审计记录。',
    reload: '加载服务器最新内容', retry: '确认结果·重试同一请求',
    refreshMes: '重新查询 MES 状态', syncMes: '保存 MES 检验值', finishMes: '完成 QC 检验', mes: 'MES 检验完成状态',
    notComplete: '尚未完成', conflict: '服务器上已有其他修改', openMenu: '打开菜单', closeMenu: '关闭菜单',
    routeDirty: '是否切换到其他页面？', routeLocked: '请先确认请求结果',
    routeStay: '留在当前页面', routeLeave: '切换页面', restore: '恢复输入',
  } : {
    language: 'ko' as const, title: '검사관리', quality: '품질', board: '설비별 검사요청',
    local: 'WJ 검사요청', preview: '합성 미리보기 · 시험 데이터 · MES 미연결',
    plans: 'WJ 생산계획', manual: 'WJ 수동입력', previewPlans: '합성 생산계획', previewRequests: '합성 검사요청',
    back: '칸반으로', create: '수동 검사요청 등록', cancel: '취소', notes: '검사 메모',
    save: '초안 저장', submit: '검사 결과 제출', saved: 'WJ Reporting 초안과 감사기록을 저장했습니다.',
    reload: '서버 최신 내용 불러오기', retry: '동일 요청 결과 확인·재시도',
    refreshMes: 'MES 상태 재조회', syncMes: 'MES 검사값 저장', finishMes: 'QC 검사 완료', mes: 'MES 검사 완료 상태',
    notComplete: '완료 전', conflict: '서버에 다른 변경이 저장되었습니다', openMenu: '메뉴 열기', closeMenu: '메뉴 닫기',
    routeDirty: '다른 화면으로 이동할까요?', routeLocked: '요청 결과를 먼저 확인하세요',
    routeStay: '현재 화면에 머무르기', routeLeave: '이동하기', restore: '입력 복구',
  };
}

function inspection(id = 1): InspectionRequest {
  return {
    id, source_kind: 'local_manual', work_order_ref: `SYNTHETIC-WO-${id}`,
    task_ref: `SYNTHETIC-TASK-${id}`, part_no: `SYNTHETIC-PART-${id}`,
    equipment_ref: `imm0${id}`, inspection_type: 'first', target_quantity: '10.000',
    uom: 'EA', warehouse_ref: 'SYNTHETIC-WAREHOUSE', lot_ref: 'SYNTHETIC-LOT',
    work_started_at: '2026-09-30T01:00:00.000Z', quantity_mode: 'not_recorded',
    judgement_policy: 'strict_items', require_evidence: false,
    inspection_items: [{ id: 'dimension', label: '치수 / 尺寸', kind: 'number', unit: 'mm',
      minimum: '9.5', maximum: '10.5', required: true, evidence_required: false }],
    measurements: [{ item_id: 'dimension', value: '10.0', judgement: 'pass', evidence_url: '' }],
    evidence: [], inspected_quantity: '0.000', accepted_quantity: '0.000', rejected_quantity: '0.000',
    judgement: 'pass', notes: '', parent: null, assigned_to: 11, assigned_to_name: 'fixture-superuser',
    status: 'draft', version: 2, submitted_by: null, submitted_at: null,
    reviewed_by: null, reviewed_at: null, review_reason: '', sync_status: 'not_synced',
    mes_completion_status: 'not_completed', injection_receipt_readiness: 'not_verified',
    mes_checked_at: null, external_result_id: '', last_error_code: '',
    mes_state: { task_status: null, qc_status: null, state_version: null, receipt_allowed: null },
    created_at: '2026-09-30T01:10:00.000Z', updated_at: now, audit: [], operations: [],
    capabilities: { can_edit: true, can_submit: true, can_review: false,
      can_reinspect: false, can_sync: false, can_refresh: false },
  };
}

function kanban(records: InspectionRequest[], date: string): InspectionKanban {
  return {
    schema_version: 'inspection-kanban.v1', business_date: date,
    day_start: `${date}T08:00:00+08:00`, day_end: '2026-10-01T08:00:00+08:00', generated_at: now,
    plan_snapshot: { source: 'ProductionPlan', version: 'SYNTHETIC-PLAN-VERSION',
      latest_changed_at: now, shift_stored: false, work_task_binding_available: false,
      complete: true, freshness_verified: false },
    machines: Array.from({ length: 17 }, (_, index) => {
      const number = index + 1;
      const requests = records.filter((item) => item.equipment_ref === `imm${String(number).padStart(2, '0')}`);
      return {
        machine_number: number, station_id: `imm${String(number).padStart(2, '0')}`, mapping_status: 'mapped',
        plan_status: number < 3 ? 'present' : 'missing',
        plans: number < 3 ? [{ id: number, machine_name: `imm0${number}`, part_no: `SYNTHETIC-PART-${number}`,
          lot_no: 'SYNTHETIC-LOT', sequence: 1, planned_quantity: '500.000', updated_at: now, execution_status: 'running' }] : [],
        requests: requests.map(({ audit: _audit, operations: _operations, ...item }) => ({ ...item,
          plan_alignment: { status: 'part_listed', matching_plan_ids: [number], task_binding_verified: false } })),
        request_count: requests.length, requests_truncated: false,
        dry_run: { enabled: false, mode: 'dry_run', candidate: 'none', recommendation: 'none',
          blocking_reasons: ['mes_disconnected'], plan_version: 'SYNTHETIC-PLAN-VERSION',
          requires_new_first_inspection_on_resume: 'unknown' },
      };
    }),
    unmapped_requests: [], unmapped_plans: [], requests_truncated: false,
    plans_truncated: false, executions_truncated: false,
    counts: { requests_displayed: records.length, plans_displayed: 2, unmapped_requests: 0, unmapped_plans: 0 },
  };
}

type Mutation = { method: string; pathname: string; key: string | undefined; body: Record<string, unknown> };
type FixtureOptions = { superuser?: boolean; active?: boolean; dataMode?: InspectionDataMode; mesObservations?: boolean; mesSourceRecords?: boolean };

async function installFixtures(page: Page, baseURL: string, info: TestInfo, options: FixtureOptions = {}) {
  const localOrigin = new URL(baseURL).origin;
  const blocked: string[] = [];
  const pageErrors: string[] = [];
  let authReads = 0;
  const inspectionReads: string[] = [];
  const mutations: Mutation[] = [];
  const records = [inspection(1), inspection(2)];
  let mutationHandler: ((route: Route, mutation: Mutation) => Promise<void>) | null = null;
  const superuser = options.superuser ?? true;
  const active = options.active ?? true;
  const dataMode = options.dataMode ?? 'wj_local_beta';
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.setFixedTime(new Date(now));

  // Synthetic, unsigned test token: only the local fixture validates this identity.
  // The normal /user/me/ branch is tested instead of the dev-login superuser shortcut.
  const fixtureToken = (kind: 'access' | 'refresh', lifetime: number) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
    user_id: 11, token_type: kind, exp: Math.floor(Date.parse(now) / 1000) + lifetime,
    fixture_only: true,
  })).toString('base64url')}.synthetic-local-only`;
  const access = fixtureToken('access', 3600);
  const refresh = fixtureToken('refresh', 86400);
  await page.addInitScript(({ access, refresh, language }) => {
    // A normal session is one complete pair, with both rolling-deploy mirrors.
    // Access-only storage is intentionally treated as logged out by auth-storage.
    localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'inspection-fixture-session', access, refresh }));
    localStorage.setItem('access_token', access);
    localStorage.setItem('wj_next_access_token', access);
    localStorage.setItem('refresh_token', refresh);
    localStorage.setItem('wj_next_refresh_token', refresh);
    localStorage.setItem('lang', language);
    localStorage.setItem('wj_next_language', language);
  }, { access, refresh, language: labels(info).language });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== localOrigin) {
      // No font request leaves the local test browser.
      if (url.hostname === 'fonts.googleapis.com') { await route.fulfill({ contentType: 'text/css', body: '' }); return; }
      blocked.push(`${request.method()} ${request.url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    if (request.method() === 'GET' && url.pathname === '/api/injection/user/me/') {
      authReads += 1;
      await route.fulfill({ json: {
        id: 11, username: 'fixture-superuser', email: 'fixture@example.invalid',
        is_staff: true, is_superuser: superuser, is_active: active,
        groups: ['fixture-admin-group'], department: 'fixture-only',
        permissions: { is_admin: true, can_view_quality: true, can_edit_quality: true,
          can_view_injection: true, can_edit_injection: true, can_view_assembly: true,
          can_edit_assembly: true, can_view_sales: true, can_edit_sales: true,
          can_view_development: true, can_edit_development: true },
      } });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/production/status/') {
      await route.fulfill({ json: { injection: [], machining: [] } }); return;
    }
    // Explicit empty-state fixtures for the access-denied redirect destination.
    if (request.method() === 'GET' && ['/api/production/overview-board/', '/api/analytics/field-operations/'].includes(url.pathname)) {
      await route.fulfill({ status: 503, json: { detail: 'Synthetic redirect destination has no business data.' } });
      return;
    }
    if (url.pathname.startsWith(apiPath)) {
      if (request.method() === 'GET') {
        inspectionReads.push(url.pathname);
        if (url.pathname === `${apiPath}capabilities/`) {
          const caps: InspectionCapabilities = { data_mode: dataMode, can_view: true, can_manage: true,
            can_submit: true, can_review: true,
            mes: { enabled: false, reason_code: 'mes_contract_unverified', message: 'Synthetic disconnected adapter',
              can_refresh: false, can_sync: false } };
          await route.fulfill({ json: caps }); return;
        }
        if (url.pathname === `${apiPath}kanban/`) {
          const result = kanban(records, url.searchParams.get('date') || '2026-09-30');
          if (options.mesObservations) {
            const observations: MesReadObservation[] = ['first', 'first', 'periodic'].map((kind, index) => ({
              observation_key: `SYNTHETIC-QC:${index}`, identity: `SYNTHETIC-QC:${index}`,
              qc_id: `1000000000000000${index + 1}`, qc_code: `SYNTHETIC-QC-${index + 1}`,
              work_order_id: '10000000000000100', production_task_id: '10000000000000200', equipment_id: '10000000000000300',
              snapshot_id: `1000000000000040${index}`, plan_name: 'SYNTHETIC 巡检',
              kind: kind as MesReadObservation['kind'], lifecycle: { code: 2, message: '已结束' }, judgement: { code: 1, message: '合格' },
              observed_at: now, source_updated_at: '2001-02-01 00:00:00', evidence_kind: 'synthetic_contract_fixture',
              warnings: kind === 'first' ? ['plan_name_type_mismatch'] : [], binding_status: 'explicit_fixture_relation',
              read_only: true, current_state_verified: false, physical_operation_verified: false,
              items: [{ ordinal: 0, label: 'SYNTHETIC width', unit: 'mm', minimum: '9.500', maximum: '10.500',
                required: null, recorded_value: '10.000', write_mapping_verified: false }],
            }));
            if (options.mesSourceRecords) observations[0].items = syntheticSourceItems();
            result.machines[0].mes_observations = observations;
            result.mes_read_snapshot = { availability: 'fixture_observations', displayed: 3, complete: false, current_state_verified: false };
          }
          await route.fulfill({ json: result }); return;
        }
        if (url.pathname === apiPath) {
          await route.fulfill({ json: { count: records.length, next: null, previous: null,
            results: records, work_groups: [], work_groups_truncated: false } }); return;
        }
        const id = Number(url.pathname.slice(apiPath.length).replace(/\/$/, ''));
        const record = records.find((item) => item.id === id);
        if (record) { await route.fulfill({ json: record }); return; }
      } else if (['PATCH', 'POST'].includes(request.method())) {
        const mutation: Mutation = { method: request.method(), pathname: url.pathname,
          key: request.headers()['idempotency-key'], body: request.postDataJSON() as Record<string, unknown> };
        mutations.push(mutation);
        if (mutationHandler) { await mutationHandler(route, mutation); return; }
      }
    }
    blocked.push(`${request.method()} ${request.url()}`);
    await route.abort('blockedbyclient');
  });

  return {
    records, mutations, inspectionReads,
    onMutation(handler: (route: Route, mutation: Mutation) => Promise<void>) { mutationHandler = handler; },
    assertClean() {
      expect(authReads, 'normal current-user API must authenticate; no dev-login or static-auth shortcut').toBeGreaterThan(0);
      expect(blocked, 'every API request must match a fixture and all network must stay local').toEqual([]);
      expect(pageErrors, 'uncaught page errors').toEqual([]);
      expect(mutations.every((item) => !/\/(sync|refresh)\/$/.test(item.pathname)), 'no MES operation is sent').toBe(true);
    },
  };
}

function measurement(page: Page) { return page.locator('.inspection-detail .inspection-item input[inputmode="decimal"]').first(); }
function requestCard(page: Page, id: number) { return page.locator('.inspection-kanban-request').filter({ hasText: `SYNTHETIC-WO-${id}` }); }
async function selectRequest(page: Page, id = 1) {
  await requestCard(page, id).click();
  await expect(page.getByRole('heading', { name: `SYNTHETIC-WO-${id}`, exact: true })).toBeVisible();
}
async function clickIfEnabled(control: Locator) { if (await control.isEnabled()) await control.click(); }
async function clickAppLink(page: Page, info: TestInfo, destination: string) {
  const text = labels(info);
  const navigation = page.locator(info.project.name === 'zh-mobile' ? '#main-mobile-navigation' : '.main-sidebar--desktop');
  if (info.project.name === 'zh-mobile') {
    // The exiting drawer can still be visible after its semantic state is closed.
    const menu = page.getByRole('button', { name: text.openMenu, exact: true });
    if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
  }
  await navigation.locator(`a[href="${destination}"]`).click();
}
async function expectNoCompletion(page: Page) {
  await expect(page.locator('.inspection-kanban-request [data-stage="completed"]')).toHaveCount(0);
  await expect(page.locator('.inspection-management-stages [data-stage="completed"] strong')).toHaveText('0');
}
async function expectNavigationLocked(page: Page, info: TestInfo) {
  const text = labels(info);
  const dialogs: string[] = [];
  const listener = async (dialog: import('@playwright/test').Dialog) => { dialogs.push(dialog.message()); await dialog.accept(); };
  page.on('dialog', listener);
  try {
    await clickIfEnabled(page.getByRole('button', { name: text.back, exact: true }));
    await expect(page.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true })).toBeVisible();
    await clickIfEnabled(requestCard(page, 2));
    await expect(page.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true })).toBeVisible();
    await clickIfEnabled(page.getByRole('button', { name: text.create, exact: true }));
    await expect(page.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true })).toBeVisible();
    expect(dialogs, 'uncertain/in-flight mutations cannot be discarded through a confirmation').toEqual([]);
    await clickAppLink(page, info, '/analysis');
    const routeDialog = page.getByRole('alertdialog', { name: text.routeLocked });
    await expect(routeDialog).toBeVisible();
    await expect(routeDialog.getByRole('button', { name: text.routeLeave, exact: true })).toHaveCount(0);
    const stay = routeDialog.getByRole('button', { name: text.routeStay, exact: true });
    await expect(stay).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(stay).toBeFocused();
    await stay.click();
    await expect(routeDialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true })).toBeVisible();
  } finally { page.off('dialog', listener); }
}

test('administrator quality inspection menu, source labels, 17 machines, input focus and dirty cancellation', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: text.board, exact: true })).toBeVisible();
  const banner = page.locator('.inspection-connection-notice');
  await expect(banner).toContainText(text.local);
  await expect(banner.locator('dd')).toHaveText([text.plans, text.manual]);
  await expect(page.locator('.inspection-machine-card')).toHaveCount(17);
  await expect(page.locator('.inspection-machine-card h3').first()).toHaveText(text.language === 'zh' ? '1号机' : '1호기');
  await expect(page.locator('.inspection-machine-card h3').last()).toHaveText(text.language === 'zh' ? '17号机' : '17호기');

  if (info.project.name === 'zh-mobile') await page.getByRole('button', { name: text.openMenu, exact: true }).click();
  const navigation = page.locator(info.project.name === 'zh-mobile' ? '#main-mobile-navigation' : '.main-sidebar--desktop');
  const quality = navigation.locator('.main-navigation__group').filter({ has: page.locator('.main-navigation__group-label', { hasText: text.quality }) });
  await expect(quality.locator(`a[href="${path}"]`)).toHaveText(text.title);
  await quality.locator(`a[href="${path}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.locator('.inspection-machine-card')).toHaveCount(17);
  await expectNoCompletion(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('inspection-board.png') });

  await selectRequest(page);
  await expect(page.locator('.inspection-detail-workspace')).toBeFocused();
  await expect(measurement(page)).toHaveValue('10.0');
  if (info.project.name === 'zh-mobile') {
    const back = await page.getByRole('button', { name: text.back, exact: true }).boundingBox();
    const header = await page.locator('.main-mobile-header').boundingBox();
    const field = await measurement(page).boundingBox();
    expect(back && header && back.y >= header.y + header.height - 1, 'sticky mobile header must not cover back navigation').toBe(true);
    expect(field && header && field.y >= header.y + header.height - 1 && field.y < 843 - 35,
      'selected request opens with its first measurement in the visible mobile workspace').toBe(true);
  }
  await page.screenshot({ path: info.outputPath('inspection-input.png') });
  await page.locator('.inspection-detail details').filter({ has: page.getByText(text.mes, { exact: true }) }).locator('summary').click();
  await expect(page.getByRole('button', { name: text.refreshMes, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: text.syncMes, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: text.finishMes, exact: true })).toBeDisabled();
  await measurement(page).fill('10.1');
  const dialog = page.waitForEvent('dialog');
  const backClick = page.getByRole('button', { name: text.back, exact: true }).click();
  await (await dialog).dismiss();
  await backClick;
  await expect(measurement(page)).toHaveValue('10.1');
  await expect(page.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true })).toBeVisible();
  expect(fixture.mutations).toEqual([]);
  fixture.assertClean();
});

for (const identity of [{ name: 'staff/group administrator', superuser: false, active: true },
  { name: 'inactive superuser', superuser: true, active: false }]) {
  test(`${identity.name} cannot see inspection menu or open its direct route`, async ({ page, baseURL }, info) => {
    const fixture = await installFixtures(page, baseURL!, info, identity);
    await page.goto(path);
    await expect(page).toHaveURL(/\/analysis$/);
    await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0);
    await expect(page.locator('.inspection-requests-page')).toHaveCount(0);
    expect(fixture.inspectionReads, 'route denial must happen before requesting inspection data').toEqual([]);
    expect(fixture.mutations).toEqual([]);
    fixture.assertClean();
  });
}

test('synthetic preview names both data sources explicitly', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info, { dataMode: 'synthetic_preview' });
  await page.goto(path);
  const banner = page.locator('.inspection-connection-notice');
  await expect(banner).toContainText(text.preview);
  await expect(banner.locator('dd')).toHaveText([text.previewPlans, text.previewRequests]);
  await expect(banner).not.toContainText(text.local);
  await expectNoCompletion(page);
  fixture.assertClean();
});

test('dirty sidebar navigation supports staying, deliberate leave and explicit version-preserving recovery', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  await page.goto(path);
  await selectRequest(page);
  await measurement(page).fill('10.1');
  await clickAppLink(page, info, '/analysis');
  const dialog = page.getByRole('alertdialog', { name: text.routeDirty });
  await expect(dialog).toBeVisible();
  const stay = dialog.getByRole('button', { name: text.routeStay, exact: true });
  const leave = dialog.getByRole('button', { name: text.routeLeave, exact: true });
  await expect(stay).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(leave).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(stay).toBeFocused();
  await stay.click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(measurement(page)).toHaveValue('10.1');
  await clickAppLink(page, info, '/analysis');
  await dialog.getByRole('button', { name: text.routeLeave, exact: true }).click();
  await expect(page).toHaveURL(/\/analysis$/);
  await clickAppLink(page, info, path);
  await selectRequest(page);
  await expect(measurement(page)).toHaveValue('10.0');
  await page.getByRole('button', { name: text.restore, exact: true }).click();
  await expect(measurement(page)).toHaveValue('10.1');
  await expect(page.locator('.inspection-detail-heading small')).toContainText('2');
  expect(fixture.mutations).toEqual([]);
  fixture.assertClean();
});

test('browser Back preserves dirty input until the user chooses to leave', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  await page.goto('/analysis');
  await clickAppLink(page, info, path);
  await selectRequest(page);
  await measurement(page).fill('10.1');
  await page.evaluate(() => window.history.back());
  const dialog = page.getByRole('alertdialog', { name: text.routeDirty });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await dialog.getByRole('button', { name: text.routeStay, exact: true }).click();
  await expect(measurement(page)).toHaveValue('10.1');
  await page.evaluate(() => window.history.back());
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: text.routeLeave, exact: true }).click();
  await expect(page).toHaveURL(/\/analysis$/);
  expect(fixture.mutations).toEqual([]);
  fixture.assertClean();
});

test('one in-flight save survives repeat clicks and blocks navigation until confirmation', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  fixture.onMutation(async (route, mutation) => {
    await held;
    Object.assign(fixture.records[0], mutation.body, { version: 3 });
    await route.fulfill({ json: fixture.records[0] });
  });
  await page.goto(path);
  await selectRequest(page);
  await measurement(page).fill('10.1');
  await page.getByRole('button', { name: text.save, exact: true }).dblclick();
  await expect.poll(() => fixture.mutations.length).toBe(1);
  await expect(page.locator('.inspection-detail')).toHaveAttribute('aria-busy', 'true');
  await expect(measurement(page)).toBeDisabled();
  try { await expectNavigationLocked(page, info); } finally { release(); }
  await expect(page.getByText(text.saved, { exact: true })).toBeVisible();
  await expect(measurement(page)).toHaveValue('10.1');
  await expect(page.locator('.inspection-detail-heading small')).toContainText('3');
  expect(fixture.mutations).toHaveLength(1);
  await expectNoCompletion(page);
  fixture.assertClean();
});

test('409 preserves the draft and original version until explicit reload acceptance', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  fixture.onMutation(async (route) => {
    fixture.records[0].version = 3;
    fixture.records[0].measurements[0].value = '9.9';
    await route.fulfill({ status: 409, json: { code: 'stale_version', detail: 'Synthetic concurrent edit.' } });
  });
  await page.goto(path);
  await selectRequest(page);
  await measurement(page).fill('10.1');
  await page.getByRole('button', { name: text.save, exact: true }).click();
  const conflict = page.getByRole('alert').filter({ hasText: text.conflict });
  await expect(conflict).toBeVisible();
  await expect(measurement(page)).toHaveValue('10.1');
  expect(fixture.mutations[0].body.version).toBe(2);
  await expect(page.getByRole('button', { name: text.save, exact: true })).toBeDisabled();
  const reload = conflict.getByRole('button', { name: text.reload, exact: true });
  const declined = page.waitForEvent('dialog');
  const firstClick = reload.click();
  await (await declined).dismiss(); await firstClick;
  await expect(measurement(page)).toHaveValue('10.1');
  const accepted = page.waitForEvent('dialog');
  const secondClick = reload.click();
  await (await accepted).accept(); await secondClick;
  await expect(measurement(page)).toHaveValue('9.9');
  await expect(page.locator('.inspection-detail-heading small')).toContainText('3');
  await expect(conflict).toHaveCount(0);
  expect(fixture.mutations).toHaveLength(1);
  await expectNoCompletion(page);
  fixture.assertClean();
});

test('network timeout keeps immutable retry key/body and prevents leaving an uncertain operation', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  fixture.onMutation(async (route, mutation) => {
    if (fixture.mutations.length === 1) { await route.abort('timedout'); return; }
    Object.assign(fixture.records[0], mutation.body, { version: 3 });
    await route.fulfill({ json: fixture.records[0] });
  });
  await page.goto(path);
  await selectRequest(page);
  await measurement(page).fill('10.1');
  await page.getByRole('button', { name: text.save, exact: true }).click();
  const retry = page.getByRole('button', { name: text.retry, exact: true });
  await expect(retry).toBeVisible();
  await expect(measurement(page)).toHaveValue('10.1');
  await expect(measurement(page)).toBeDisabled();
  await expectNavigationLocked(page, info);
  await expectNoCompletion(page);
  await retry.click();
  await expect(page.getByText(text.saved, { exact: true })).toBeVisible();
  expect(fixture.mutations).toHaveLength(2);
  expect(fixture.mutations[1]).toEqual(fixture.mutations[0]);
  expect(fixture.mutations[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await expectNoCompletion(page);
  fixture.assertClean();
});

for (const recorded of [false, true]) {
  test(`HTTP 202 ${recorded ? 'durable operation' : 'unrecorded outcome'} is pending, blocks navigation and never means MES complete`, async ({ page, baseURL }, info) => {
    const text = labels(info);
    const fixture = await installFixtures(page, baseURL!, info);
    fixture.onMutation(async (route, mutation) => {
      const pending = structuredClone(fixture.records[0]);
      Object.assign(pending, { version: 3, sync_status: 'pending', mes_completion_status: 'pending',
        operations: [{ id: 72, scope: '11:1:sync', key: mutation.key, status: 'pending',
          response_status: 202, created_at: now, completed_at: null }],
        capabilities: { ...pending.capabilities, can_edit: false, can_submit: false } });
      await route.fulfill({ status: 202, json: { code: 'operation_pending', detail: 'Synthetic operation is still pending.',
        ...(recorded ? { operation_id: 72, request: pending } : {}) } });
    });
    await page.goto(path);
    await selectRequest(page);
    await measurement(page).fill('10.1');
    await page.getByRole('button', { name: text.save, exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic operation is still pending.' })).toBeVisible();
    await expect(measurement(page)).toHaveValue('10.1');
    await expect(measurement(page)).toBeDisabled();
    await expectNavigationLocked(page, info);
    await expectNoCompletion(page);
    expect(fixture.mutations).toHaveLength(1);
    fixture.assertClean();
  });
}


test('synthetic MES observations preserve distinct QC plans and remain read-only on kanban', async ({ page, baseURL }, info) => {
  const fixture = await installFixtures(page, baseURL!, info, { mesObservations: true });
  await page.goto(path);
  const cards = page.getByTestId('mes-read-observation');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.inspection-machine-card').first().locator('header span')).toHaveText('WJ 1 · MES 3');
  const zh = labels(info).language === 'zh';
  await expect(cards.nth(0).locator('strong').first()).toContainText(zh ? '首检' : '초검');
  await expect(cards.nth(1).locator('strong').first()).toContainText(zh ? '首检' : '초검');
  await expect(cards.nth(2).locator('strong').first()).toContainText(zh ? '巡检' : '순검');
  await expect(cards.nth(0)).toContainText(zh ? '方案名称与实际类型不一致' : '방안 이름과 실제 유형 불일치');
  await expect(cards.nth(0)).toContainText(zh ? '合成 MES 观测' : '합성 MES 관측');
  await expect(cards.locator('button, input, select, textarea')).toHaveCount(0);
  await cards.nth(0).locator('summary').click();
  await expect(cards.nth(0)).toContainText('10000000000000001');
  await expect(cards.nth(0)).toContainText('9.500 ~ 10.500');
  await expect(cards.nth(0)).toContainText(zh ? '当前状态、实际运行及入库条件未确认' : '현재 상태·실제 가동·입고 조건 미확인');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mes-read-observations.png') });
  expect(fixture.mutations).toEqual([]);
  fixture.assertClean();
});

test('MES source specifications and every recorded sample remain distinct and read-only', async ({ page, baseURL }, info) => {
  const fixture = await installFixtures(page, baseURL!, info, { mesObservations: true, mesSourceRecords: true });
  await page.goto(path);
  const card = page.getByTestId('mes-read-observation').first();
  await card.locator('summary').click();
  const items = card.getByTestId('mes-observed-item');
  await expect(items).toHaveCount(3);
  const weight = items.nth(0);
  await expect(weight.getByTestId('mes-item-specification')).toContainText('19.1000000000 ~ 21.9000000000 mm');
  const records = weight.getByTestId('mes-item-record');
  await expect(records).toHaveCount(2);
  const zh = labels(info).language === 'zh';
  await expect(records.nth(0)).toContainText(zh ? '样本序号 1' : '샘플 순번 1');
  await expect(records.nth(0).getByTestId('mes-record-result')).toHaveText(zh ? '源值为空' : '원천값 없음');
  await expect(records.nth(0)).toContainText('20.0000000000');
  await expect(records.nth(1)).toContainText(zh ? '样本序号 2' : '샘플 순번 2');
  await expect(records.nth(1).getByTestId('mes-record-result')).toHaveText('20.5000000000');
  await expect(items.nth(1).getByTestId('mes-item-specification')).toContainText('<= 7.0000000000 mm');
  await expect(items.nth(1)).toContainText(zh ? '未观测到记录' : '관측된 기록 없음');
  await expect(items.nth(2).getByTestId('mes-item-specification')).toContainText('合格 · 不合格');
  await expect(card.locator('button, input, select, textarea')).toHaveCount(0);
  await expect(card).toContainText(zh ? '只读' : '읽기 전용');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await weight.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mes-source-records.png') });
  expect(fixture.mutations).toEqual([]);
  fixture.assertClean();
});

test('MES value save and individual QC completion require distinct clicks and fresh readback', async ({ page, baseURL }, info) => {
  const text = labels(info);
  const fixture = await installFixtures(page, baseURL!, info);
  const record = fixture.records[0];
  record.status = 'approved';
  record.capabilities.can_edit = false; record.capabilities.can_submit = false;
  record.mes_workflow = { phase: 'ready', enabled: true, can_save: true, can_finish: false, can_reconcile: false,
    test_label: '연동 테스트용 가상값 / 非实测，仅用于接口测试 / SYNTHETIC', last_verified_at: null };
  fixture.onMutation(async (route, mutation) => {
    expect(mutation.pathname).toMatch(/\/mes-(save|finish)\/$/);
    expect(mutation.body.version).toBe(record.version);
    const finishing = mutation.pathname.endsWith('/mes-finish/');
    expect(record.mes_workflow?.phase).toBe(finishing ? 'saved' : 'ready');
    record.version += 1; record.sync_status = 'succeeded'; record.mes_checked_at = now;
    record.mes_completion_status = finishing ? 'completed' : 'not_completed';
    record.mes_workflow = { ...record.mes_workflow!, phase: finishing ? 'completed' : 'saved', can_save: false,
      can_finish: !finishing, can_reconcile: true, last_verified_at: now };
    await route.fulfill({ json: record });
  });
  await page.goto(path); await selectRequest(page);
  await page.locator('.inspection-detail details').filter({ has: page.getByText(text.mes, { exact: true }) }).locator('summary').click();
  const save = page.getByRole('button', { name: text.syncMes, exact: true });
  const finish = page.getByRole('button', { name: text.finishMes, exact: true });
  await expect(finish).toBeDisabled(); await save.click();
  await expect(save).toBeDisabled(); await expect(finish).toBeEnabled();
  expect(fixture.mutations.map(item => item.pathname)).toEqual([`${apiPath}1/mes-save/`]);
  page.once('dialog', async dialog => { await dialog.dismiss(); });
  await finish.click();
  expect(fixture.mutations).toHaveLength(1);
  page.once('dialog', async dialog => { await dialog.accept(); });
  await finish.click();
  await expect(finish).toBeDisabled();
  await expect.poll(() => fixture.mutations.length).toBe(2);
  expect(fixture.mutations.map(item => item.pathname)).toEqual([`${apiPath}1/mes-save/`, `${apiPath}1/mes-finish/`]);
  fixture.assertClean();
});

test('dashboard keeps production quantities visible when optional inspection read fails', async ({ page, baseURL }, info) => {
  const fixture = await installFixtures(page, baseURL!, info);
  const zh = labels(info).language === 'zh';
  await page.route('**/api/production/status/**', route => route.fulfill({ status: 503, json: { detail: 'SYNTHETIC unavailable quality source' } }));
  await page.route('**/api/production/overview-board/**', route => route.fulfill({ json: {
    schema_version: 'production-overview.v1', business_date: '2026-09-30', generated_at: now,
    processes: { injection: { planned_quantity: 1234, actual_quantity: 987, completion_rate: 80, remaining_quantity: 247 },
      assembly: { planned_quantity: 0, actual_quantity: null } },
    freshness: { sources: { injection_production: { status: 'ok', row_count: 1, stale: false, source_latest_at: now } } },
    equipment: { injection: [] }, warnings: [],
  } }));
  await page.goto('/analysis?date=2026-09-30');
  const quality = page.getByRole('region', { name: zh ? '检验与不合格处置概览' : '검사·불량조치 현황' });
  await expect(quality).toContainText(zh ? '质量查询失败' : '품질 조회 실패');
  await expect(quality.locator('dd')).toHaveText(['—', '—', zh ? '未关联' : '미연동', zh ? '未关联' : '미연동']);
  await expect(page.locator('.analysis-production')).toContainText('1,234');
  await expect(page.locator('.analysis-production')).toContainText('987');
  await quality.locator('summary').click();
  await expect(quality.locator('strong')).toHaveCount(17);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('inspection-overview-unavailable.png'), fullPage: true });
  expect(fixture.mutations).toHaveLength(0);
  fixture.assertClean();
});

test('QC completion preserves unresolved nonconformance and cannot execute a disposition', async ({ page, baseURL }, info) => {
  const fixture = await installFixtures(page, baseURL!, info);
  const record = fixture.records[0];
  record.status = 'approved'; record.judgement = 'fail'; record.mes_completion_status = 'completed';
  record.capabilities.can_edit = false; record.capabilities.can_submit = false;
  record.nonconformance = { state: 'open', quantity: '2.000', uom: 'EA', owner_name: 'SYNTHETIC owner', mes_status: 'unverified', can_execute: false };
  await page.goto(path); await selectRequest(page);
  await expect(page.locator('.inspection-detail')).toContainText(labels(info).language === 'zh' ? '不合格处置未解决' : '불량조치 미해결');
  await expect(page.locator('.inspection-detail')).toContainText('2.000 EA');
  await expect(page.locator('.inspection-detail')).toContainText('SYNTHETIC owner');
  expect(fixture.mutations).toHaveLength(0);
  fixture.assertClean();
});
