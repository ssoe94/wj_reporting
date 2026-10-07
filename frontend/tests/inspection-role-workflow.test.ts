import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as roleModel from '../src/pages/quality/inspection-requests/roleModel.ts';
import { inspectionRoleCopy } from '../src/pages/quality/inspection-requests/roleCopy.ts';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
import { inspectionCreatePayload } from '../src/pages/quality/inspection-requests/model.ts';
import type { InspectionRequest } from '../src/pages/quality/inspection-requests/model.ts';
import type { InspectionRoleWorkflow } from '../src/pages/quality/inspection-requests/roleModel.ts';

function fixture(): InspectionRequest {
  return {
    id: 42, version: 3, work_order_ref: 'SYNTHETIC-WO', task_ref: 'SYNTHETIC-TASK', part_no: 'SYNTHETIC-PART', equipment_ref: '', inspection_type: 'first', target_quantity: '1', uom: 'EA', warehouse_ref: '', lot_ref: '', work_started_at: '2026-10-07T00:00:00Z',
    inspection_items: [
      { id: 'appearance-item', label: 'SYNTHETIC-APPEARANCE', kind: 'text', unit: '', required: true, evidence_required: false },
      { id: 'dimension-item', label: 'SYNTHETIC-DIMENSION', kind: 'number', unit: 'mm', required: true, evidence_required: false },
    ], require_evidence: false, quantity_mode: 'not_recorded', judgement_policy: 'strict_items', measurements: [], evidence: [], inspected_quantity: '0', accepted_quantity: '0', rejected_quantity: '0', judgement: '', notes: '',
    source_kind: 'local_manual', parent: null, assigned_to: 101, assigned_to_name: 'SYNTHETIC-ACTOR-A', status: 'draft', submitted_by: null, submitted_at: null, reviewed_by: null, reviewed_at: null, review_reason: '',
    sync_status: 'not_synced', mes_completion_status: 'not_completed', injection_receipt_readiness: 'not_verified', mes_checked_at: null, external_result_id: '', mes_state: { task_status: null, qc_status: null, state_version: null, receipt_allowed: null }, last_error_code: '', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', audit: [], operations: [], capabilities: { can_edit: true, can_submit: false, can_review: false, can_reinspect: false, can_sync: false, can_refresh: false },
    role_workflow: { mode: 'roles', configured: true, status: 'ready', config_version: 2, shift_snapshot: null, item_areas: { 'appearance-item': 'appearance', 'dimension-item': 'dimension' }, my_item_ids: ['appearance-item'], aggregate_judgement: '', mes: { can_save: false, reason: 'mes_partial_multi_executor_contract_unverified' }, areas: [
      { area: 'appearance', assigned_to: 101, assigned_to_name: 'SYNTHETIC-ACTOR-A', version: 1, status: 'draft', judgement: '', measurements: [{ item_id: 'appearance-item', value: 'SYNTHETIC-A', judgement: 'pass', evidence_url: '' }], evidence: [], completed_by: null, completed_at: null, can_save: true, can_complete: true, can_reopen: false },
      { area: 'dimension', assigned_to: 102, assigned_to_name: 'SYNTHETIC-ACTOR-B', version: 4, status: 'draft', judgement: '', measurements: [{ item_id: 'dimension-item', value: 'SYNTHETIC-B', judgement: 'pass', evidence_url: '' }], evidence: [], completed_by: null, completed_at: null, can_save: false, can_complete: false, can_reopen: false },
    ] },
  };
}
test('role opt-in is explicit and does not alter the legacy create payload', () => {
  const { role_workflow: ignored, ...legacy } = fixture(); void ignored;
  assert.equal('role_workflow' in inspectionCreatePayload(legacy), false);
  assert.equal(inspectionCreatePayload({ ...legacy, role_workflow: false }).role_workflow, undefined);
  assert.equal(inspectionCreatePayload({ ...legacy, role_workflow: true }).role_workflow, true);
});
test('editing requires current actor assignment, server item scope and mutable area', () => {
  const role = fixture().role_workflow!;
  assert.equal(roleModel.inspectionRoleItemEditable(role, 'appearance-item', 101), true);
  assert.equal(roleModel.inspectionRoleItemEditable(role, 'dimension-item', 101), false);
  assert.equal(roleModel.inspectionRoleItemEditable({ ...role, my_item_ids: ['appearance-item', 'dimension-item'] }, 'dimension-item', 101), false);
  assert.equal(roleModel.inspectionRoleItemEditable({ ...role, configured: false }, 'appearance-item', 101), false);
  assert.equal(roleModel.inspectionRoleItemEditable({ ...role, areas: role.areas.map((area) => ({ ...area, status: 'complete' })) }, 'appearance-item', 101), false);
});
test('final PASS needs both distinct areas complete/pass, regardless of advertised aggregate', () => {
  const role = fixture().role_workflow!;
  assert.equal(roleModel.inspectionRoleFinalJudgement({ ...role, aggregate_judgement: 'pass' }), '');
  const completed = { ...role, areas: role.areas.map((area) => ({ ...area, status: 'complete', judgement: 'pass' as const })) };
  assert.equal(roleModel.inspectionRoleFinalJudgement(completed), 'pass');
  assert.equal(roleModel.inspectionRoleFinalJudgement({ ...completed, areas: completed.areas.slice(0, 1) }), '');
  assert.equal(roleModel.inspectionRoleFinalJudgement({ ...completed, areas: completed.areas.map((area) => area.area === 'dimension' ? { ...area, judgement: 'fail' } : area) }), 'fail');
});
test('area partial payload cannot include or erase another actor results', () => {
  const request = fixture(); const role = request.role_workflow!;
  const payload = roleModel.inspectionRoleSavePayload(role, 'appearance', 101, roleModel.inspectionRoleMeasurements(request), []);
  assert.deepEqual(payload, { area: 'appearance', area_version: 1, config_version: 2, measurements: [{ item_id: 'appearance-item', value: 'SYNTHETIC-A', judgement: 'pass', evidence_url: '' }], evidence: [] });
  assert.throws(() => roleModel.inspectionRoleSavePayload(role, 'dimension', 101, roleModel.inspectionRoleMeasurements(request), []), /not_editable/);
  assert.throws(() => roleModel.inspectionRoleSavePayload(role, 'appearance', 101, [], []), /incomplete/);
});
test('explicit conflict reconciliation retains own draft and reads current other-area values', () => {
  const request = fixture(); const own = roleModel.inspectionRoleMeasurements(request).map((row) => ({ ...row, value: 'UNSAVED-LOCAL' }));
  request.role_workflow!.areas[1].measurements[0].value = 'LATEST-OTHER-ACTOR';
  const merged = roleModel.inspectionRoleReconcileDraft(own, request, 101);
  assert.equal(merged[0].value, 'UNSAVED-LOCAL'); assert.equal(merged[1].value, 'LATEST-OTHER-ACTOR');
  request.role_workflow!.areas[0].assigned_to = 103;
  assert.equal(roleModel.inspectionRoleReconcileDraft(own, request, 101)[0].value, 'SYNTHETIC-A');
});
test('mapping requires explicit coverage of both areas and empty settings remains empty', () => {
  assert.equal(roleModel.inspectionRoleMappingValid(['a', 'b'], { a: 'appearance', b: 'dimension' }), true);
  for (const mapping of [{}, { a: 'appearance', b: 'appearance' }, { a: 'appearance', b: 'dimension', c: 'appearance' }]) assert.equal(roleModel.inspectionRoleMappingValid(['a', 'b'], mapping), false);
  assert.deepEqual(roleModel.parseInspectionRoleSettings({ settings: [], candidates: [], can_configure: true }).settings, []);
});

const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/RoleInspectionRequestDetail.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (node: any): Element[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' && node.props ? [node, ...nodes(node.props.children)] : [];
const content = (node: any): string => Array.isArray(node) ? node.map(content).join('') : node == null || typeof node === 'boolean' ? '' : typeof node === 'object' ? content(node.props?.children) : String(node);
function harness(initial = fixture(), error?: unknown) {
  const hooks: any[] = []; let cursor = 0; let tree: Element; let currentSession = 'SYNTHETIC-SESSION-A'; let keyCount = 0;
  const calls: any[] = []; const changed: InspectionRequest[] = [];
  const dependencies: Record<string, unknown> = {
    react: { useState: (initial: any) => { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], (next: any) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; }, useRef: (initial: any) => { const index = cursor++; return hooks[index] ??= { current: initial }; }, useMemo: (fn: any) => { cursor++; return fn(); }, useCallback: (fn: any) => { cursor++; return fn; }, useEffect: () => { cursor++; } },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => { if (session !== currentSession) throw new Error('Stale synthetic session'); } },
    './roleModel': roleModel, './roleCopy': { inspectionRoleCopy }, './copy': copy,
    './workflow': { ...workflow, createInspectionKey: () => `00000000-0000-4000-8000-${String(++keyCount).padStart(12, '0')}` },
    './api': { getInspectionRoleSettings: async () => ({ settings: [], candidates: [], can_configure: true }), getInspectionRequest: async () => initial,
      mutateInspectionRole: async (...args: any[]) => { calls.push(args); if (error) throw error; return initial; },
      mutateInspectionRequest: async (...args: any[]) => { calls.push(args); if (error) throw error; return initial; } },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'sessionStorage', 'window', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports, { getItem: () => null, setItem: () => {}, removeItem: () => {} }, { confirm: () => true });
  const render = () => { cursor = 0; tree = exports.default({ initial, userId: 101, sessionId: 'SYNTHETIC-SESSION-A', lang: 'ko', globalCapabilities: { can_manage_role_settings: true }, onChanged: (row: InspectionRequest) => changed.push(row), onDirty: () => {}, onLocked: () => {} }); return tree; };
  render();
  return { render, calls, changed, nodes: () => nodes(tree), text: () => content(tree), input: (id: string) => nodes(tree).find((node) => node.props.id === id)!, button: (label: string) => nodes(tree).find((node) => node.type === 'button' && content(node) === label)!, stale: () => { currentSession = 'SYNTHETIC-SESSION-B'; }, settle: async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } } };
}
test('delivered role table edits only own area and dispatches scoped partial save', async () => {
  const view = harness();
  assert.equal(view.input('inspection-item-42-0-value').props.disabled, false); assert.equal(view.input('inspection-item-42-1-value').props.disabled, true);
  assert.equal(view.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true);
  assert.match(view.text(), /WJ 입력 담당과 MES 실행자는 별도/);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'MY-UPDATED-APPEARANCE' } }); view.render();
  view.button(inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0][1].action, 'area-save');
  assert.deepEqual(view.calls[0][1].payload.measurements.map((row: any) => row.item_id), ['appearance-item']);
  assert.equal(view.calls[0][1].payload.measurements[0].value, 'MY-UPDATED-APPEARANCE');
});
test('stale conflict retains own visible input until explicit latest-version reconciliation', async () => {
  const view = harness(fixture(), { response: { status: 409, data: { detail: 'SYNTHETIC conflict' } } });
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'RETAIN-MY-DRAFT' } }); view.render(); view.button(inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, 'RETAIN-MY-DRAFT'); assert.equal(view.input('inspection-item-42-0-value').props.disabled, true);
  view.button(inspectionRoleCopy.ko.compare).props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, 'RETAIN-MY-DRAFT');
  view.button(inspectionRoleCopy.ko.useDraft).props.onClick(); view.render();
  assert.equal(view.input('inspection-item-42-0-value').props.disabled, false); assert.equal(view.input('inspection-item-42-0-value').props.value, 'RETAIN-MY-DRAFT');
});
test('choosing own area OK sends only its completion and cannot manually promote final PASS', async () => {
  const view = harness();
  const area = view.nodes().find(node => node.type === 'article' && content(node).includes('SYNTHETIC-ACTOR-A'))!;
  nodes(area).find(node => node.type === 'select')!.props.onChange({ target: { value: 'pass' } }); view.render();
  assert.match(view.text(), /두 영역 완료·OK 대기/);
  assert.equal(view.button(copy.inspectionCopy.ko.submit).props.disabled, true);
  view.button(inspectionRoleCopy.ko.complete).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0][1].action, 'area-complete');
  assert.deepEqual(view.calls[0][1].payload, { area: 'appearance', area_version: 1, config_version: 2, judgement: 'pass' });
});
test('final submission is disabled until two saved completed OK areas agree with server capability', () => {
  const request = fixture(); request.capabilities.can_submit = true;
  let view = harness(request);
  assert.equal(view.button(copy.inspectionCopy.ko.submit).props.disabled, true);
  request.role_workflow!.areas.forEach(area => { area.status = 'complete'; area.judgement = 'pass'; area.can_save = false; area.can_complete = false; });
  view = harness(request);
  assert.match(view.text(), /외관·치수 모두 완료·OK/);
  assert.equal(view.button(copy.inspectionCopy.ko.submit).props.disabled, false);
  request.capabilities.can_submit = false;
  assert.equal(harness(request).button(copy.inspectionCopy.ko.submit).props.disabled, true);
});
test('uncertain mutation retries exact original key/body without enabling edits', async () => {
  const view = harness(fixture(), new Error('SYNTHETIC network'));
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'ONE-ORIGINAL-DRAFT' } }); view.render(); view.button(inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.disabled, true);
  view.button(inspectionRoleCopy.ko.retry).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 2); assert.deepEqual(view.calls[1], view.calls[0]);
});
test('account change blocks role edits and mutations before transport', async () => {
  const view = harness();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'OWN-DRAFT' } }); view.render(); view.stale();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'OTHER-SESSION' } }); view.button(inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 0); assert.equal(view.input('inspection-item-42-0-value').props.value, 'OWN-DRAFT');
});
test('new role configure date has no inferred shift default, final PASS selector absent', () => {
  const request = fixture(); request.role_workflow = { ...request.role_workflow!, configured: false, status: 'unconfigured', can_configure: true, areas: [], item_areas: {}, my_item_ids: [] };
  const view = harness(request);
  assert.equal(view.nodes().find((node) => node.type === 'input' && node.props.type === 'date')?.props.value, '');
  assert.equal(view.nodes().some((node) => node.type === 'select' && node.props.value === request.judgement && content(node).includes(copy.inspectionCopy.ko.pass)), false);
  assert.equal(view.button(inspectionRoleCopy.ko.configure).props.disabled, true);
});
