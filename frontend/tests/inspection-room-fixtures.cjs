'use strict';

// Disposable local preview data. These identities and measurements are not MES data.
const clone = value => JSON.parse(JSON.stringify(value));
const API = '/api/quality/inspection-requests/';
const now = () => new Date().toISOString();
const dimensionIds = ['length', 'width', 'height', 'diameter', 'weight', 'deformation'];

function token(kind, claims) {
  const payload = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload({ alg: 'synthetic', typ: 'JWT' })}.${payload({ ...claims, token_type: kind })}.SYNTHETIC-LOCAL-ONLY`;
}
function authPair() {
  const claims = { user_id: 101, exp: Math.floor(Date.now() / 1000) + 86400, mes_sid: 'F'.repeat(43), mes_login_exp: Math.floor(Date.now() / 1000) + 86400, mes_session_v: 2, fixture_only: true };
  return { access: token('access', claims), refresh: token('refresh', claims) };
}
function activityResponse(pair) { return { ...pair, session_last_activity_at: now(), session_idle_expires_at: new Date(Date.now() + 8 * 3600000).toISOString(), fixture_only: true }; }
function currentUser() {
  return { id: 101, username: 'QC-ROOM', email: 'fixture@example.invalid', is_staff: true, is_superuser: true, is_active: true, groups: [], department: '', password_reset_required: false, is_using_temp_password: false,
    permissions: { is_admin: true, can_view_quality: true, can_edit_quality: true } };
}
function roleSettings() {
  const common = { version: 1, timezone: 'Asia/Shanghai', appearance_assignee: 201, appearance_assignee_name: 'QC003', dimension_assignee: 202, dimension_assignee_name: 'QC001', active: true,
    effective_from: '2026-01-01T00:00:00Z', effective_from_local: '2026-01-01T08:00', effective_until: null, effective_until_local: null };
  return { can_configure: true, candidates: [{ id: 201, name: common.appearance_assignee_name, username: 'fixture-appearance' }, { id: 202, name: common.dimension_assignee_name, username: 'fixture-dimension' }],
    settings: [{ ...common, id: 1, code: 'SYNTHETIC-DAY', label: '주간 / 白班', start_time: '08:00:00', end_time: '20:00:00' },
      { ...common, id: 2, code: 'SYNTHETIC-NIGHT', label: '야간 / 夜班', start_time: '20:00:00', end_time: '08:00:00' }] };
}
// Display-only roster fixtures; these IDs never identify WJ/MES accounts.
function createWeeklyRosterStore() {
  const weeks = new Map(), attempts = new Map();
  let roster = [
    { id: 501, display_name: '示例 王明', distinguishing_note: '', active: true },
    { id: 502, display_name: '示例 陈丽', distinguishing_note: '', active: true },
    { id: 503, display_name: '示例 李伟', distinguishing_note: '', active: true },
    { id: 504, display_name: '示例 张敏', distinguishing_note: '', active: true },
  ];
  const positions = [{ shift: 'DAY', area: 'dimension' }, { shift: 'DAY', area: 'appearance' }, { shift: 'NIGHT', area: 'dimension' }, { shift: 'NIGHT', area: 'appearance' }];
  const clean = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const normalized = value => clean(value).toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  const dateOf = week => {
    const date = new Date(`${week}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1) throw new Error('synthetic_week_invalid');
    return date;
  };
  const read = week => {
    const end = dateOf(week); end.setUTCDate(end.getUTCDate() + 6);
    const state = weeks.get(week) || { version: 1, slots: positions.map((slot, index) => ({ ...slot, inspector_id: 501 + index })) };
    return clone({ week_start: week, week_end: end.toISOString().slice(0, 10), ...state, can_configure: true, roster, fixture_only: true });
  };
  const save = (body, key) => {
    const fail = (code, status = 400) => ({ status, body: { code, fixture_only: true } });
    if (!key) return fail('synthetic_key_required');
    const serialized = JSON.stringify(body), previous = attempts.get(key);
    if (previous) return previous.payload === serialized ? clone(previous.result) : fail('synthetic_key_conflict', 409);
    let current;
    try { current = read(body.week_start); } catch { return fail('synthetic_week_invalid'); }
    if (body.version !== current.version) return fail('version_conflict', 409);
    if (!Array.isArray(body.slots) || body.slots.length !== 4) return fail('synthetic_slots_invalid');
    const nextRoster = clone(roster), slots = [];
    for (const position of positions) {
      const matching = body.slots.filter(slot => slot.shift === position.shift && slot.area === position.area);
      if (matching.length !== 1) return fail('synthetic_slots_invalid');
      const slot = matching[0]; let id = slot.inspector_id;
      if ('display_name' in slot) {
        const name = clean(slot.display_name), note = clean(slot.distinguishing_note);
        if (!name || name.length > 128 || note.length > 64) return fail('synthetic_name_invalid');
        const stored = nextRoster.find(person => normalized(person.display_name) === normalized(name) && normalized(person.distinguishing_note) === normalized(note));
        id = stored?.id || Math.max(...nextRoster.map(person => person.id)) + 1;
        if (!stored) nextRoster.push({ id, display_name: name, distinguishing_note: note, active: true });
      } else if (id !== null && !nextRoster.some(person => person.id === id && person.active)) return fail('synthetic_person_unavailable');
      slots.push({ ...position, inspector_id: id });
    }
    for (const shift of ['DAY', 'NIGHT']) {
      const pair = slots.filter(slot => slot.shift === shift);
      if (pair[0].inspector_id !== null && pair[0].inspector_id === pair[1].inspector_id) return fail('synthetic_same_person');
    }
    roster = nextRoster; weeks.set(body.week_start, { version: current.version + 1, slots });
    const result = { status: 200, body: { ...read(body.week_start), actor_id: 101 } };
    attempts.set(key, { payload: serialized, result: clone(result) }); return result;
  };
  return { read, save };
}
function record(id, role = false) {
  const number = (id, label, minimum, maximum, unit = 'mm') => ({ id, label, kind: 'number', unit, minimum, maximum });
  const choice = (id, label) => ({ id, label, kind: 'choice', unit: '', options: ['合格', '不合格'] });
  const appearanceItems = [['surface', '외관 / 外观'], ['color', '구조 / 结构'], ['scratch', '색차 / 色差'], ['flash', '재질 / 材料'],
    ['contamination', '인쇄 / 印刷'], ['short-shot', '표면처리 / 表面处理'], ['sink', '모서리·버 / SharpEdge毛刺'], ['weld', '조립성 / 装配性'],
    ['mark', '포장 상태 / 包装状态'], ['assembly', '오염 / 油污']].map(([id, label]) => choice(id, label));
  const items = role ? [
    number('length', '尺寸L上', '713.4', '714.2'), number('width', '尺寸L下', '713.4', '714.2'),
    number('height', '尺寸H左', '419.2', '419.8'), number('diameter', '尺寸H右', '419.2', '419.8'),
    number('weight', '重量', '814.8', '906.4', 'g'), choice('deformation', '变形度A'),
    ...appearanceItems,
  ] : [...Array.from({ length: 8 }, (_, i) => number(`dim-${i}`, `치수 ${i + 1} / 尺寸 ${i + 1}`, '9.5', '10.5')), ...appearanceItems];
  const measurements = items.map(item => ({ item_id: item.id, value: !role && item.kind === 'number' ? '10.0' : '', judgement: !role && item.kind === 'number' ? 'pass' : '', evidence_url: '' }));
  const at = now();
  const result = {
    id, source_kind: 'local_manual', work_order_ref: id === 7 ? 'QC-26100700128' : `SYNTHETIC-WO-${id}`, task_ref: `SYNTHETIC-TASK-${id}`,
    part_no: id === 7 ? 'WJ-PART-027' : `SYNTHETIC-PART-${id}`, equipment_ref: `imm${String(id).padStart(2, '0')}`, inspection_type: 'first',
    target_quantity: '10.000', uom: 'EA', warehouse_ref: 'SYNTHETIC-WAREHOUSE', lot_ref: 'SYNTHETIC-LOT',
    work_started_at: at, quantity_mode: 'not_recorded', judgement_policy: 'strict_items', require_evidence: false,
    inspection_items: items.map(item => ({ ...item, required: true, evidence_required: false })), measurements,
    evidence: [], inspected_quantity: '0.000', accepted_quantity: '0.000', rejected_quantity: '0.000', judgement: '', notes: '',
    parent: null, assigned_to: 101, assigned_to_name: 'QC-ROOM', status: 'draft', version: 2,
    submitted_by: null, submitted_at: null, reviewed_by: null, reviewed_at: null, review_reason: '',
    sync_status: 'not_synced', mes_completion_status: 'not_completed', injection_receipt_readiness: 'not_verified',
    mes_checked_at: null, external_result_id: '', last_error_code: '',
    mes_state: { task_status: null, qc_status: null, state_version: null, receipt_allowed: null },
    created_at: at, updated_at: at, audit: [], operations: [],
    capabilities: { can_edit: true, can_submit: true, can_review: false, can_reinspect: false, can_sync: false, can_refresh: false },
  };
  if (role) result.role_workflow = {
    mode: 'roles', configured: true, status: 'in_progress', config_version: 1, can_configure: false,
    shift_snapshot: roleSettings().settings[0], item_areas: Object.fromEntries(items.map(item => [item.id, dimensionIds.includes(item.id) ? 'dimension' : 'appearance'])),
    areas: ['appearance', 'dimension'].map(area => ({ area, assigned_to: area === 'appearance' ? 201 : 202,
      assigned_to_name: area === 'appearance' ? 'QC003' : 'QC001', version: 1, status: 'draft', judgement: '',
      measurements: measurements.filter(row => dimensionIds.includes(row.item_id) === (area === 'dimension')),
      evidence: [], item_authorship: {}, completed_by: null, completed_at: null, completed_recorded_by: null, can_save: true, can_complete: true, can_reopen: false })),
    my_item_ids: items.map(item => item.id), aggregate_judgement: '',
    shared_terminal: { enabled: true, operator_id: 101, operator_name: 'QC-ROOM', can_operate: true },
    mes: { can_save: false, reason: 'synthetic-unverified' },
  };
  return result;
}
function records() { return [record(1), record(7, true)]; }
// Synthetic source times are fixed per fixture process; a refresh cannot reset elapsed time.
const machineSignalOrigin = Date.now();
function machineSignal(number, part, date) {
  if (number === 10) return undefined; // Legacy WJ-only response deliberately has no MES evidence.
  const at = minutes => new Date(machineSignalOrigin + minutes * 60_000).toISOString();
  const relation = { work_order_id: `SYNTHETIC-WORK-${number}`, production_task_id: `SYNTHETIC-TASK-${number}`, plan_id: `SYNTHETIC-MES-PLAN-${number}` };
  const check = { ...relation, qc_id: `SYNTHETIC-QC-${number}`, kind: 'first', current_state_verified: true,
    state: 'requested', judgement: null, requested_at: at(-42), planned_at: null, official_deadline_at: null, completed_at: null };
  const signal = { schema_version: 'mes-inspection-signal.v1', source_kind: 'synthetic_contract_fixture', business_date: date,
    machine_number: number, current_plan_id: number, plan_version: 'SYNTHETIC-PLAN', observed_at: at(0), fresh_until: at(60),
    current_state_verified: true, stale: false, complete: true, first_inspection_required: false,
    current_work: { ...relation, part_no: part, product_name: number === 7 ? '前盖 / FRONT COVER' : '注塑壳体 / HOUSING', production_status: 'running' }, inspections: [check] };
  if (number === 2) { check.kind = 'periodic'; check.planned_at = at(-10); }
  if (number === 3) { check.kind = 'periodic'; check.requested_at = at(-82); check.official_deadline_at = at(-15); }
  if ([4, 5, 6, 8, 9, 15, 16, 17].includes(number)) { check.state = 'completed'; check.judgement = 'pass'; check.completed_at = at(-15); }
  if (number === 5) { check.judgement = 'fail'; signal.inspections.push({ ...check, kind: 'periodic', qc_id: 'SYNTHETIC-PERIODIC-5', judgement: 'pass' }); }
  if (number === 6) signal.current_work.production_status = 'stopped';
  if (number === 7 || number === 17) check.kind = 'periodic';
  if (number === 8) { signal.stale = true; signal.fresh_until = at(-1); }
  if (number === 9) check.production_task_id = 'SYNTHETIC-OLD-TASK';
  if (number === 11) signal.inspections = [];
  if (number === 12) { check.kind = 'production'; check.state = 'in_progress'; }
  if (number === 13) { check.kind = 'periodic'; check.planned_at = at(20); }
  if (number === 14) { signal.first_inspection_required = true; signal.inspections = []; }
  if (number === 15) check.completed_at = null;
  if (number === 16) signal.current_plan_id = 999;
  return signal;
}
function kanban(records, date) {
  const at = now();
  return { schema_version: 'inspection-kanban.v1', business_date: date, day_start: `${date}T08:00:00+08:00`, day_end: `${date}T08:00:00+08:00`, generated_at: at,
    plan_snapshot: { source: 'ProductionPlan', version: 'SYNTHETIC-PLAN', latest_changed_at: at, shift_stored: false, work_task_binding_available: false, complete: true, freshness_verified: false },
    machines: Array.from({ length: 17 }, (_, index) => {
      const number = index + 1, requests = records.filter(item => item.equipment_ref === `imm${String(number).padStart(2, '0')}`);
      return { machine_number: number, station_id: `imm${String(number).padStart(2, '0')}`, mapping_status: 'mapped', plan_status: 'present',
        mes_inspection_signal: records.length ? machineSignal(number, requests[0]?.part_no || `SYNTHETIC-PART-${number}`, date) : undefined,
        plans: [{ id: number, machine_name: `imm${String(number).padStart(2, '0')}`, part_no: requests[0]?.part_no || `SYNTHETIC-PART-${number}`, lot_no: 'SYNTHETIC-LOT', sequence: 1, planned_quantity: '500.000', updated_at: at, execution_status: 'running' }],
        requests: requests.map(item => ({ ...item, plan_alignment: { status: 'part_listed', matching_plan_ids: [number], task_binding_verified: false } })), request_count: requests.length, requests_truncated: false,
        dry_run: { enabled: false, mode: 'dry_run', candidate: 'none', recommendation: 'none', blocking_reasons: ['mes_disconnected'], plan_version: 'SYNTHETIC-PLAN', requires_new_first_inspection_on_resume: 'unknown' } };
    }), unmapped_requests: [], unmapped_plans: [], requests_truncated: false, plans_truncated: false, executions_truncated: false,
    counts: { requests_displayed: records.length, plans_displayed: 17, unmapped_requests: 0, unmapped_plans: 0 } };
}
function capabilities() {
  return { data_mode: 'wj_local_beta', can_view: true, can_manage: true, can_submit: true, can_review: false, access_scope: 'all', can_view_kanban: true, can_manage_role_settings: true,
    mes: { enabled: false, reason_code: 'mes_contract_unverified', message: 'Synthetic disconnected adapter', can_refresh: false, can_sync: false } };
}
function mutation(record, action, body) {
  const workflow = record.role_workflow, state = workflow?.areas.find(area => area.area === body.area);
  const error = code => ({ status: 400, body: { code } });
  const ready = (items, rows) => items.every(item => {
    const row = rows.find(row => row.item_id === item.id);
    if (!row?.value?.trim()) return item.required === false;
    if (!['pass', 'fail'].includes(row.judgement)) return false;
    if (item.kind === 'choice' && !item.options.includes(row.value)) return false;
    if (item.kind === 'number') { const value = Number(row.value); if (!Number.isFinite(value) || ((value < Number(item.minimum) || value > Number(item.maximum)) && row.judgement !== 'fail')) return false; }
    return true;
  });
  if (['draft', 'submit'].includes(action)) {
    if (body.version !== record.version) return { status: 409, body: { code: 'version_conflict' } };
    if (record.status !== 'draft') return error('synthetic_not_draft');
    if (action === 'draft') {
      if (workflow) return error('synthetic_area_actions_required');
      for (const field of ['measurements', 'evidence', 'judgement', 'notes', 'inspected_quantity', 'accepted_quantity', 'rejected_quantity']) if (field in body) record[field] = clone(body[field]);
    } else {
      if (workflow && !workflow.areas.every(area => area.status === 'complete')) return error('synthetic_areas_incomplete');
      if (!ready(record.inspection_items, record.measurements) || !['pass', 'fail', 'concession'].includes(body.judgement)) return error('synthetic_final_invalid');
      if (body.judgement === 'pass' && record.measurements.some(row => row.judgement === 'fail')) return error('synthetic_failed_items');
      if (body.judgement === 'concession' && !body.reason?.trim()) return error('synthetic_concession_reason');
      record.judgement = body.judgement; record.status = body.judgement === 'fail' ? 'failed' : 'submitted'; record.submitted_by = 101; record.submitted_at = now();
      record.capabilities.can_edit = false; record.capabilities.can_submit = false;
      if (workflow) { workflow.aggregate_judgement = body.judgement; workflow.can_submit = false; }
    }
    record.version++; record.updated_at = now();
    record.audit.push({ id: record.audit.length + 1, actor_name: 'QC-ROOM', action, version: record.version, status: record.status, reason: body.reason || '', result_digest: '', created_at: now() });
    return { status: 200, body: clone(record) };
  }
  if (!workflow || !['area-save', 'area-complete'].includes(action) || !state) return error('synthetic_action_not_supported');
  if (body.inspector_id !== state.assigned_to) return error('synthetic_inspector_mismatch');
  if (body.area_version !== state.version || body.config_version !== workflow.config_version) return { status: 409, body: { code: 'version_conflict' } };
  if (action === 'area-save') {
    const ids = record.inspection_items.filter(item => workflow.item_areas[item.id] === body.area).map(item => item.id);
    if (!Array.isArray(body.measurements) || !Array.isArray(body.evidence) || body.measurements.length !== ids.length || new Set(body.measurements.map(row => row.item_id)).size !== ids.length || body.measurements.some(row => !ids.includes(row.item_id))) return error('synthetic_area_scope_invalid');
    state.measurements = clone(body.measurements); state.evidence = clone(body.evidence);
    for (const row of state.measurements) state.item_authorship[row.item_id] = { inspector_id: state.assigned_to, inspector_name: state.assigned_to_name, recorded_by_id: 101, recorded_by_name: 'QC-ROOM', recorded_at: now() };
  } else {
    if (!ready(record.inspection_items.filter(item => workflow.item_areas[item.id] === body.area), state.measurements) || !['pass', 'fail'].includes(body.judgement)) return error('synthetic_judgement_invalid');
    state.status = 'complete'; state.judgement = body.judgement; state.completed_by = state.assigned_to; state.completed_by_name = state.assigned_to_name;
    state.completed_recorded_by = 101; state.completed_recorded_by_name = 'QC-ROOM'; state.completed_at = now();
    state.can_save = false; state.can_complete = false;
  }
  state.version++; record.version++; record.updated_at = now(); record.measurements = workflow.areas.flatMap(area => area.measurements);
  workflow.aggregate_judgement = workflow.areas.every(area => area.status === 'complete') ? (workflow.areas.some(area => area.judgement === 'fail') ? 'fail' : 'pass') : '';
  record.judgement = workflow.aggregate_judgement; workflow.status = workflow.areas.every(area => area.status === 'complete') ? 'completed' : 'ready'; workflow.can_submit = workflow.status === 'completed'; record.capabilities.can_submit = workflow.can_submit;
  record.audit.push({ id: record.audit.length + 1, actor_name: 'QC-ROOM', action, version: record.version, status: record.status, reason: '', result_digest: '', created_at: now() });
  return { status: 200, body: clone(record) };
}
module.exports = { API, authPair, activityResponse, currentUser, roleSettings, createWeeklyRosterStore, record, records, kanban, capabilities, mutation };
