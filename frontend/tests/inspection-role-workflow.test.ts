import * as displayLabel from '../src/pages/quality/inspection-requests/displayLabel.ts';
import * as measurementJudgement from '../src/pages/quality/inspection-requests/measurementJudgement.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as roleModel from '../src/pages/quality/inspection-requests/roleModel.ts';
import { inspectionRoleCopy } from '../src/pages/quality/inspection-requests/roleCopy.ts';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import * as navigation from '../src/pages/quality/inspection-requests/navigation.ts';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
import { inspectionCreatePayload } from '../src/pages/quality/inspection-requests/model.ts';
import type { InspectionRequest } from '../src/pages/quality/inspection-requests/model.ts';
import type { InspectionRoleSettings } from '../src/pages/quality/inspection-requests/roleModel.ts';

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
      { area: 'dimension', assigned_to: 102, assigned_to_name: 'SYNTHETIC-ACTOR-B', version: 4, status: 'draft', judgement: '', measurements: [{ item_id: 'dimension-item', value: '10', judgement: 'pass', evidence_url: '' }], evidence: [], completed_by: null, completed_at: null, can_save: false, can_complete: false, can_reopen: false },
    ] },
  };
}
test('role opt-in is explicit and does not alter the legacy create payload', () => {
  const { role_workflow: ignored, ...legacy } = fixture(); void ignored;
  assert.equal('role_workflow' in inspectionCreatePayload(legacy), false);
  assert.equal(inspectionCreatePayload({ ...legacy, role_workflow: false }).role_workflow, undefined);
  assert.equal(inspectionCreatePayload({ ...legacy, role_workflow: true }).role_workflow, true);
});
test('display roster attribution requires the current configured terminal and never impersonates a WJ account', () => {
  const role = fixture().role_workflow!;
  role.shared_terminal = { enabled: true, operator_id: 101, operator_name: 'SYNTHETIC terminal', can_operate: true };
  role.areas[0] = { ...role.areas[0], assigned_to: null, assigned_person_id: 101 };
  assert.equal(roleModel.inspectionRoleAreaActorAllowed(role, 'appearance', 101), true);
  assert.equal(roleModel.inspectionRoleAreaActorAllowed(role, 'appearance', 102), false);
  assert.deepEqual(roleModel.inspectionRoleActorPayload(role, 'appearance', 101), { inspector_person_id: 101 });
  assert.equal(roleModel.inspectionRoleAreaActorAllowed({ ...role, shared_terminal: undefined }, 'appearance', 101), false);
  role.areas[0].assigned_to = 101;
  assert.equal(roleModel.inspectionRoleAreaActorAllowed(role, 'appearance', 101), false);
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

test('deformation choices are suggested as dimension alongside numeric measurements', () => {
  const items = fixture().inspection_items;
  const choices = ['变形度A', '變形度A', '변형도A'].map((label, index) => ({ ...items[0], id: `deformation-${index}`, label, kind: 'choice' as const, options: ['合格', '不合格'] }));
  assert.deepEqual(roleModel.inspectionRoleSuggestedItemAreas([...items, ...choices]), { 'appearance-item': 'appearance', 'dimension-item': 'dimension', 'deformation-0': 'dimension', 'deformation-1': 'dimension', 'deformation-2': 'dimension' });
});

function sharedFixture(): InspectionRequest {
  const request = fixture(); const role = request.role_workflow!;
  role.shared_terminal = { enabled: true, operator_id: 101, operator_name: 'SYNTHETIC-OPERATOR', can_operate: true };
  role.my_item_ids = request.inspection_items.map((item) => item.id);
  role.areas.forEach((area, index) => { area.assigned_to = 201 + index; area.can_save = true; area.can_complete = true; });
  return request;
}

test('shared terminal requires exact authorized operator and carries scoped inspector attribution', () => {
  const request = sharedFixture(); const role = request.role_workflow!;
  assert.equal(roleModel.inspectionRoleItemEditable(role, 'dimension-item', 101), true);
  assert.equal(roleModel.inspectionRoleItemEditable(role, 'dimension-item', 999), false);
  assert.equal(roleModel.inspectionRoleItemEditable({ ...role, shared_terminal: { ...role.shared_terminal!, can_operate: false } }, 'dimension-item', 101), false);
  assert.equal(roleModel.inspectionRoleItemEditable({ ...role, my_item_ids: ['appearance-item'] }, 'dimension-item', 101), false);
  const payload = roleModel.inspectionRoleSavePayload(role, 'dimension', 101, roleModel.inspectionRoleMeasurements(request), []);
  assert.equal(payload.inspector_id, 202);
  assert.deepEqual((payload.measurements as any[]).map((row) => row.item_id), ['dimension-item']);
  assert.deepEqual(roleModel.inspectionRoleActorPayload(role, 'appearance', 101), { inspector_id: 201 });
  assert.throws(() => roleModel.inspectionRoleActorPayload(role, 'appearance', 999), /not_editable/);
});

test('shared area reconciliation accepts saved area and retains only unsaved other-area rows', () => {
  const request = sharedFixture();
  const drafts = roleModel.inspectionRoleMeasurements(request).map((row) => ({ ...row, value: 'LOCAL-DRAFT' }));
  request.role_workflow!.areas[0].measurements[0].value = 'SERVER-NORMALIZED-APPEARANCE';
  const rows = roleModel.inspectionRoleReconcileDraft(drafts, request, 101, 'appearance', ['dimension']);
  assert.equal(rows[0].value, 'SERVER-NORMALIZED-APPEARANCE');
  assert.equal(rows[1].value, 'LOCAL-DRAFT');
  assert.equal(roleModel.inspectionRoleReconcileDraft(drafts, request, 101, 'appearance', [])[1].value, '10');
});

const entryFlow: Record<string, any> = {};
new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/inspectionEntryFlow.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)((name: string) => { assert.equal(name, './workflow'); return workflow; }, entryFlow);
const shiftHelperSource = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/roleShiftSettingsModel.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const shiftHelpers: Record<string, any> = {};
new Function('require', 'exports', shiftHelperSource)((name: string) => { assert.equal(name, './workflow'); return workflow; }, shiftHelpers);
const verdictComponent: Record<string, any> = {};
const verdictRuntime = { jsx: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), Fragment: 'Fragment' };
new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/InspectionMeasurementVerdict.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name: string) => name === 'react/jsx-runtime' ? verdictRuntime : name === './displayLabel' ? displayLabel : measurementJudgement, verdictComponent);
const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/RoleInspectionRequestDetail.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (node: any): Element[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' && node.props ? [node, ...nodes(node.props.children)] : [];
const content = (node: any): string => Array.isArray(node) ? node.map(content).join('') : node == null || typeof node === 'boolean' ? '' : typeof node === 'object' ? content(node.props?.children) : String(node);
function harness(initial = fixture(), error?: unknown, options: { canManageRoleSettings?: boolean; stale?: boolean; settingsError?: unknown; settings?: InspectionRoleSettings; readDetail?: () => Promise<InspectionRequest>; mutateRole?: (request: InspectionRequest, attempt: any) => InspectionRequest; mutateLegacy?: (request: InspectionRequest, attempt: any) => InspectionRequest } = {}) {
  const hooks: any[] = []; let cursor = 0; let tree: Element; let currentSession = options.stale ? 'SYNTHETIC-SESSION-B' : 'SYNTHETIC-SESSION-A'; let keyCount = 0;
  let server = initial;
  const calls: any[] = []; const changed: InspectionRequest[] = []; const settingsReads: unknown[][] = [];
  const detailReads: unknown[][] = []; const locks: { locked: boolean; pending: boolean }[] = [];
  const recoveries = new Map<string, string>();
  const focused: string[] = [];
  const effects: (() => void)[] = [];
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
  const dependencies: Record<string, unknown> = {
    react: { useState: (initial: any) => { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], (next: any) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; }, useRef: (initial: any) => { const index = cursor++; return hooks[index] ??= { current: initial }; }, useMemo: (fn: any) => { cursor++; return fn(); }, useCallback: (fn: any, deps: unknown[]) => { const index = cursor++; const hook = hooks[index] ??= {}; if (!same(hook.deps, deps)) { hook.fn = fn; hook.deps = deps; } return hook.fn; }, useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { const index = cursor++; const hook = hooks[index] ??= {}; if (!same(hook.deps, deps)) { hook.deps = deps; effects.push(() => { hook.cleanup?.(); hook.cleanup = fn() || undefined; }); } } },
    'react/jsx-runtime': verdictRuntime,
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => { if (session !== currentSession) throw new Error('Stale synthetic session'); } },
    './displayLabel': displayLabel, './InspectionMeasurementVerdict': verdictComponent, './measurementJudgement': measurementJudgement,
    './InspectionFinalJudgementDialog': { default: 'InspectionFinalJudgementDialog' },
    './inspectionEntryFlow': entryFlow,
    './InspectionAuxiliaryTabs': { default: 'InspectionAuxiliaryTabs' },
    './roleShiftSettingsModel': shiftHelpers, './roleModel': roleModel, './roleCopy': { inspectionRoleCopy }, './copy': copy,
    './navigation': navigation,
    './workflow': { ...workflow, createInspectionKey: () => `00000000-0000-4000-8000-${String(++keyCount).padStart(12, '0')}` },
    './api': { getInspectionRoleSettings: async (...args: unknown[]) => { settingsReads.push(args); if (options.settingsError) throw options.settingsError; return options.settings || { settings: [], candidates: [], can_configure: true }; }, getInspectionRequest: async (...args: unknown[]) => { detailReads.push(args); return options.readDetail ? options.readDetail() : server; },
      mutateInspectionRole: async (...args: any[]) => { calls.push(args); if (error) throw error; if (options.mutateRole) server = options.mutateRole(server, args[1]); return server; },
      mutateInspectionRequest: async (...args: any[]) => { calls.push(args); if (error) throw error; if (options.mutateLegacy) server = options.mutateLegacy(server, args[1]); return server; } },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'sessionStorage', 'window', 'document', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports, { getItem: (key: string) => recoveries.get(key) ?? null, setItem: (key: string, value: string) => recoveries.set(key, value), removeItem: (key: string) => recoveries.delete(key) }, { confirm: () => true }, { getElementById: (id: string) => ({ focus: () => focused.push(id) }) });
  const render = () => { cursor = 0; tree = exports.default({ initial, userId: 101, sessionId: 'SYNTHETIC-SESSION-A', lang: 'ko', globalCapabilities: { can_manage_role_settings: options.canManageRoleSettings !== false }, onChanged: (row: InspectionRequest) => changed.push(row), onDirty: () => {}, onLocked: (locked: boolean, pending: boolean) => locks.push({ locked, pending }) }); for (const effect of effects.splice(0)) effect(); return tree; };
  render();
  return { dialog: () => nodes(tree).find((node) => node.type === 'InspectionFinalJudgementDialog'), render, calls, changed, settingsReads, detailReads, locks, recoveries, focused, nodes: () => nodes(tree), text: () => content(tree), input: (id: string) => nodes(tree).find((node) => node.props.id === id)!, button: (label: string) => nodes(tree).find((node) => node.type === 'button' && content(node) === label) || nodes(tree).find((node) => node.type === 'button' && typeof node.props.onClick === 'function' && content(node).endsWith(` ${label}`))!, stale: () => { currentSession = 'SYNTHETIC-SESSION-B'; }, settle: async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } } };
}

test('new mapping suggests deformation dimension while preserving existing configured history', () => {
  const initial = fixture();
  initial.inspection_items[0] = { ...initial.inspection_items[0], label: '变形度A', kind: 'choice', options: ['合格', '不合格'] };
  const configured = harness(initial);
  assert.equal(configured.nodes().find((node) => node.props['data-inspection-item'] === 'appearance-item')!.props['data-inspection-area'], 'appearance');
  assert.equal(initial.role_workflow!.item_areas['appearance-item'], 'appearance');
  const unconfigured = structuredClone(initial);
  unconfigured.role_workflow = { ...unconfigured.role_workflow!, configured: false, status: 'unconfigured', can_configure: true, areas: [], item_areas: {}, my_item_ids: [] };
  const draft = harness(unconfigured);
  const suggested = draft.nodes().find((node) => node.type === 'label' && content(node).startsWith('变形度A'))!;
  assert.equal(nodes(suggested).find((node) => node.type === 'select')!.props.value, 'dimension');
  assert.deepEqual(unconfigured.role_workflow!.item_areas, {});
  assert.equal(draft.calls.length, 0);
});

test('one worksheet groups both inspectors and Enter stays inside its own area', () => {
  const request = sharedFixture();
  request.inspection_items.push({ ...request.inspection_items[1], id: 'dimension-next' });
  request.role_workflow!.item_areas['dimension-next'] = 'dimension'; request.role_workflow!.my_item_ids.push('dimension-next');
  const view = harness(request);
  assert.deepEqual(view.nodes().filter((node) => node.props['data-inspection-item']).map((node) => node.props['data-inspection-item']), ['dimension-item', 'dimension-next', 'appearance-item']);
  let prevented = 0;
  const key = (patch: Record<string, unknown> = {}) => ({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => prevented++, ...patch });
  view.input('inspection-item-42-1-value').props.onKeyDown(key({ nativeEvent: { isComposing: true } }));
  view.input('inspection-item-42-1-value').props.onKeyDown(key({ shiftKey: true }));
  assert.deepEqual(view.focused, []);
  view.input('inspection-item-42-1-value').props.onKeyDown(key());
  assert.deepEqual(view.focused, ['inspection-item-42-2-value']); assert.equal(prevented, 1);
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: '10.2' } }); view.render();
  assert.equal(view.nodes().filter((node) => node.props.className === 'inspection-items-table inspection-role-worksheet').length, 1);
  assert.deepEqual(view.nodes().filter((node) => node.type === 'tbody' && node.props['data-card-area']).map((node) => node.props['data-card-area']), ['dimension', 'appearance']);
  for (const area of request.role_workflow!.areas) {
    const group = view.nodes().find((node) => node.type === 'tbody' && node.props['data-card-area'] === area.area);
    assert.ok(content(group).includes(area.assigned_to_name));
  }
  assert.equal(view.input('inspection-item-42-1-value').props.value, '10.2');
  view.input('inspection-role-only-unfilled').props.onChange({ target: { checked: true } }); view.render();
  assert.deepEqual(view.nodes().filter((node) => node.props['data-inspection-item']).map((node) => node.props['data-inspection-item']), ['dimension-next']);
  assert.equal(view.calls.length, 0);
});
test('delivered role table edits only own area and dispatches scoped partial save', async () => {
  const view = harness();
  assert.equal(view.input('inspection-item-42-0-value').props.disabled, false); assert.equal(view.input('inspection-item-42-1-value').props.disabled, true); assert.equal(view.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true);
  assert.match(view.text(), /MES 실행자가 모든 항목을 함께 저장/);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'MY-UPDATED-APPEARANCE' } }); view.render();
  view.button('외관 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0][1].action, 'area-save');
  assert.deepEqual(view.calls[0][1].payload.measurements.map((row: any) => row.item_id), ['appearance-item']);
  assert.equal(view.calls[0][1].payload.measurements[0].value, 'MY-UPDATED-APPEARANCE');
});
test('unified worksheet preserves other inspector measurement, evidence and verdict across area save', async () => {
  const view = harness(sharedFixture(), undefined, { mutateRole: (current, attempt) => {
    const updated = structuredClone(current);
    const area = updated.role_workflow!.areas.find((row) => row.area === attempt.payload.area)!;
    area.measurements = attempt.payload.measurements; area.evidence = attempt.payload.evidence; area.version += 1;
    updated.version += 1;
    area.item_authorship = { ...area.item_authorship, [area.measurements[0].item_id]: { inspector_id: area.assigned_to!, inspector_name: area.assigned_to_name, recorded_by_id: 101, recorded_by_name: 'SYNTHETIC-OPERATOR', recorded_at: '2026-10-07T01:00:00Z' } };
    return updated;
  } });
  const areaNodes = (area: string) => nodes(view.nodes().find((node) => node.props.className === 'inspection-role-area-control' && node.props['data-inspection-area'] === area));
  const evidenceNodes = (area: string) => nodes(view.nodes().find((node) => node.props['data-inspection-evidence-area'] === area));
  const areaButton = (area: string, label: string) => areaNodes(area).find((node) => node.type === 'button' && (content(node) === label || content(node).endsWith(` ${label}`)))!;
  assert.equal(view.input('inspection-item-42-1-value').props.disabled, false);
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: 'UNSAVED-DIMENSION' } }); view.render();
  evidenceNodes('dimension').find((node) => node.type === 'button' && content(node) === copy.inspectionCopy.ko.addEvidence)!.props.onClick(); view.render();
  evidenceNodes('dimension').find((node) => node.type === 'input' && node.props.maxLength === 128)!.props.onChange({ target: { value: 'DIMENSION-EVIDENCE' } }); view.render();
  evidenceNodes('dimension').find((node) => node.type === 'input' && node.props.type === 'url' && node.props.disabled === false && node.props.value === '' && node.props.maxLength === 500 && !node.props.id && !content(node))!.props.onChange({ target: { value: 'https://example.com/item-evidence' } }); view.render();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '  SAVED-APPEARANCE  ' } }); view.render();
  areaButton('appearance', inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls[0][1].payload.inspector_id, 201);
  assert.equal(view.input('inspection-item-42-0-value').props.value, 'SAVED-APPEARANCE');
  assert.equal(view.dialog(), undefined);
  assert.equal(evidenceNodes('dimension').find((node) => node.type === 'input' && node.props.maxLength === 128)!.props.value, 'DIMENSION-EVIDENCE');
  assert.match(view.text(), /입력자: SYNTHETIC-OPERATOR/);
  const savedRow = view.nodes().find((node) => node.props['data-inspection-item'] === 'appearance-item')!;
  assert.match(nodes(savedRow).find((node) => node.props.className === 'inspection-role-row-state')!.props.title, /SYNTHETIC-ACTOR-A · 입력자: SYNTHETIC-OPERATOR/);
  assert.equal(areaButton('appearance', inspectionRoleCopy.ko.save).props.disabled, false); assert.equal(view.input('inspection-item-42-1-value').props.value, 'UNSAVED-DIMENSION');
  assert.equal(areaButton('dimension', inspectionRoleCopy.ko.save).props.disabled, false);
  areaButton('dimension', inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls[1][1].payload.inspector_id, 202);
  assert.equal(view.calls[1][1].payload.measurements[0].value, 'UNSAVED-DIMENSION');
  assert.equal(view.calls[1][1].payload.evidence[0].label, 'DIMENSION-EVIDENCE');
  assert.equal(view.dialog(), undefined); // invalid numeric draft must never offer final submission
});
test('stale conflict retains own visible input until explicit latest-version reconciliation', async () => {
  const view = harness(fixture(), { response: { status: 409, data: { detail: 'SYNTHETIC conflict' } } });
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'RETAIN-MY-DRAFT' } }); view.render(); view.button('외관 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, 'RETAIN-MY-DRAFT'); assert.equal(view.input('inspection-item-42-0-value').props.disabled, true);
  view.button(inspectionRoleCopy.ko.compare).props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, 'RETAIN-MY-DRAFT');
  view.button(inspectionRoleCopy.ko.useDraft).props.onClick(); view.render();
  assert.equal(view.input('inspection-item-42-0-value').props.disabled, false); assert.equal(view.input('inspection-item-42-0-value').props.value, 'RETAIN-MY-DRAFT');
});

test('saving one area requires explicit reconciliation when another locally edited area changes on server', async () => {
  const view = harness(sharedFixture(), undefined, { mutateRole: (current, attempt) => {
    const updated = structuredClone(current);
    const appearance = updated.role_workflow!.areas.find((row) => row.area === 'appearance')!;
    const dimension = updated.role_workflow!.areas.find((row) => row.area === 'dimension')!;
    appearance.measurements = attempt.payload.measurements; appearance.version += 1;
    dimension.measurements[0].value = 'CONCURRENT-SERVER-DIMENSION'; dimension.version += 1;
    updated.version += 1;
    return updated;
  } });
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: 'RETAIN-DIMENSION-DRAFT' } }); view.render();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'SAVE-APPEARANCE' } }); view.render();
  const save = view.nodes().find((node) => node.props.className === 'inspection-role-area-control' && node.props['data-inspection-area'] === 'appearance')!;
  nodes(save).find((node) => node.props['data-area-action'] === 'save')!.props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, 'SAVE-APPEARANCE');
  assert.equal(view.input('inspection-item-42-1-value').props.value, 'RETAIN-DIMENSION-DRAFT');
  assert.equal(view.input('inspection-item-42-1-value').props.disabled, true);
  assert.match(view.text(), /다른 변경이 먼저 저장/);
  view.button(inspectionRoleCopy.ko.compare).props.onClick(); await view.settle();
  assert.match(view.text(), /CONCURRENT-SERVER-DIMENSION/);
  view.button(inspectionRoleCopy.ko.useDraft).props.onClick(); view.render();
  assert.equal(view.input('inspection-item-42-1-value').props.value, 'RETAIN-DIMENSION-DRAFT');
  assert.equal(view.input('inspection-item-42-1-value').props.disabled, false);
});
test('a non-owner cannot finalise even when both stored areas are valid', () => {
  const view = harness(); assert.equal(view.button('최종 판정').props.disabled, true);
  assert.equal(view.dialog(), undefined);
});
test('final modal opens after both saves and confirms completion in order with latest CAS versions', async () => {
  const request = sharedFixture();
  const view = harness(request, undefined, { mutateRole: (current, attempt) => {
    const next = structuredClone(current), area = next.role_workflow!.areas.find((row) => row.area === attempt.payload.area)!;
    assert.equal(attempt.payload.area_version, area.version);
    area.version++; next.version++;
    if (attempt.action === 'area-save') area.measurements = attempt.payload.measurements;
    else { area.status = 'complete'; area.judgement = attempt.payload.judgement; area.can_save = false; area.can_complete = false; }
    return next;
  }, mutateLegacy: (current, attempt) => {
    assert.equal(attempt.payload.version, current.version);
    const next = structuredClone(current); next.status = 'submitted'; next.judgement = attempt.payload.judgement; next.version++; return next;
  } });
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: '10.1' } }); view.render();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'NEW-APPEARANCE' } }); view.render();
  view.button('외관 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.dialog(), undefined); view.button('치수 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.ok(view.dialog()); assert.equal(view.calls.length, 2);
  await view.dialog()!.props.onConfirm('concession', 'SYNTHETIC concession basis'); await view.settle();
  assert.deepEqual(view.calls.map((call) => call[1].action), ['area-save', 'area-save', 'area-complete', 'area-complete', 'submit']);
  assert.deepEqual(view.calls.slice(2, 4).map((call) => call[1].payload.area), ['dimension', 'appearance']);
  assert.equal(view.calls[4][1].payload.judgement, 'concession'); assert.equal(view.calls[4][1].payload.reason, 'SYNTHETIC concession basis');
  assert.equal(view.dialog(), undefined);
});
test('missing required proof or unsaved rows prevents opening the final modal', () => {
  const request = sharedFixture(); request.require_evidence = true;
  assert.equal(harness(request).button('최종 판정').props.disabled, true);
  request.require_evidence = false; const view = harness(request);
  assert.equal(view.button('최종 판정').props.disabled, false);
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: '11' } }); view.render();
  assert.equal(view.button('최종 판정').props.disabled, true);
});
test('uncertain mutation retries exact original key/body without enabling edits', async () => {
  const view = harness(fixture(), new Error('SYNTHETIC network'));
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'ONE-ORIGINAL-DRAFT' } }); view.render(); view.button('외관 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.disabled, true);
  view.button(inspectionRoleCopy.ko.retry).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 2); assert.deepEqual(view.calls[1], view.calls[0]);
});
test('account change blocks role edits and mutations before transport', async () => {
  const view = harness();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'OWN-DRAFT' } }); view.render(); view.stale();
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: 'OTHER-SESSION' } }); view.button('외관 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 0); assert.equal(view.input('inspection-item-42-0-value').props.value, 'OWN-DRAFT');
});
test('new role configure date has no inferred shift default, final PASS selector absent', () => {
  const request = fixture(); request.role_workflow = { ...request.role_workflow!, configured: false, status: 'unconfigured', can_configure: true, areas: [], item_areas: {}, my_item_ids: [] };
  const view = harness(request);
  assert.equal(view.nodes().find((node) => node.type === 'input' && node.props.type === 'date')?.props.value, '');
  assert.equal(view.nodes().some((node) => node.type === 'select' && node.props.value === request.judgement && content(node).includes(copy.inspectionCopy.ko.pass)), false);
  assert.equal(view.button(inspectionRoleCopy.ko.configure).props.disabled, true);
});

test('unconfigured restricted reader retains setup hint without requesting forbidden role settings', async () => {
  for (const [canConfigure, canManageRoleSettings] of [[false, false], [false, true], [true, false]]) {
    const request = fixture(); request.role_workflow = { ...request.role_workflow!, configured: false, status: 'unconfigured', can_configure: canConfigure, areas: [], item_areas: {}, my_item_ids: [] };
    const view = harness(request, undefined, { canManageRoleSettings, settingsError: { response: { status: 403, data: { detail: 'SYNTHETIC pilot route denied' } } } });
    await view.settle();
    assert.equal(view.settingsReads.length, 0);
    assert.match(view.text(), /교대·담당이 아직 설정되지 않았습니다/);
    assert.match(view.text(), /설정은 현재 설정 권한이 있는 계정에서 가능합니다/);
    assert.equal(view.nodes().some(node => node.props.role === 'alert'), false);
    assert.equal(view.nodes().some(node => node.type === 'input' && node.props.type === 'date'), false);
  }
});
test('role settings is fetched once only for current account with explicit global and request configuration authority', async () => {
  const request = fixture(); request.role_workflow = { ...request.role_workflow!, configured: false, status: 'unconfigured', can_configure: true, areas: [], item_areas: {}, my_item_ids: [] };
  const allowed = harness(request); await allowed.settle();
  assert.deepEqual(allowed.settingsReads, [['SYNTHETIC-SESSION-A']]);
  assert.equal(allowed.nodes().some(node => node.type === 'input' && node.props.type === 'date'), true);
  const stale = harness(request, undefined, { stale: true }); await stale.settle();
  assert.deepEqual(stale.settingsReads, []);
  const configured = harness(fixture()); await configured.settle();
  assert.deepEqual(configured.settingsReads, []);
});

test('delivered configure requires the entire explicit overnight shift within its effective period', async () => {
  const request = fixture(); request.role_workflow = { ...request.role_workflow!, configured: false, status: 'unconfigured', can_configure: true, areas: [], item_areas: {}, my_item_ids: [] };
  const settings: InspectionRoleSettings = { settings: [{ id: 501, version: 7, code: 'SYNTHETIC-NIGHT', label: 'SYNTHETIC-NIGHT', timezone: 'Asia/Shanghai', start_time: '20:00:00', end_time: '08:00:00', appearance_assignee: 101, dimension_assignee: 102, active: true, effective_from: '2026-10-07T12:00:00+00:00', effective_until: '2026-10-08T00:00:00+00:00', effective_from_local: '2026-10-07T20:00', effective_until_local: '2026-10-08T08:00' }], candidates: [], can_configure: true };
  const view = harness(request, undefined, { settings }); await view.settle();
  view.input('inspection-role-shift-setting').props.onChange({ target: { value: '501' } }); view.render();
  const mapping = () => view.nodes().filter(node => node.type === 'select' && !node.props.id);
  mapping()[0].props.onChange({ target: { value: 'appearance' } }); view.render();
  mapping()[1].props.onChange({ target: { value: 'dimension' } }); view.render();
  view.nodes().find(node => node.type === 'textarea' && node.props.maxLength === 500)!.props.onChange({ target: { value: 'SYNTHETIC explicit configured period' } }); view.render();
  view.input('inspection-role-shift-date').props.onChange({ target: { value: '2026-10-08' } }); view.render();
  assert.equal(view.button(inspectionRoleCopy.ko.configure).props.disabled, true);
  assert.match(view.text(), /교대 전체가 이 설정의 적용 기간/);
  view.button(inspectionRoleCopy.ko.configure).props.onClick(); await view.settle(); assert.equal(view.calls.length, 0);
  view.input('inspection-role-shift-date').props.onChange({ target: { value: '2026-10-07' } }); view.render();
  assert.equal(view.button(inspectionRoleCopy.ko.configure).props.disabled, false);
  view.button(inspectionRoleCopy.ko.configure).props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0][1].action, 'role-configure');
  assert.equal(view.calls[0][1].payload.shift_date, '2026-10-07'); assert.equal(view.calls[0][1].payload.shift_setting_id, 501); assert.equal(view.calls[0][1].payload.shift_version, 7);
});


test('visible MES status does not infer completion from WJ approval or stale observations', () => {
  const approved = fixture(); approved.status = 'approved';
  const approvedView = harness(approved);
  const chips = (view: ReturnType<typeof harness>) => view.nodes().filter((node) => node.props.className === 'inspection-mes-chip');
  assert.deepEqual(chips(approvedView).map((node) => node.props['data-state']), ['not_synced', 'not_completed']);
  assert.match(chips(approvedView).map(content).join(' '), /미동기화.*완료 전/);
  const stale = fixture(); stale.sync_status = 'succeeded'; stale.mes_completion_status = 'completed'; stale.last_error_code = 'stale_remote_observation';
  const staleView = harness(stale);
  assert.deepEqual(chips(staleView).map((node) => node.props['data-state']), ['unknown', 'unknown']);
  assert.ok(chips(staleView).every((node) => content(node).includes(copy.inspectionCopy.ko.currentReconciliation)));
  assert.equal(staleView.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true);
});

test('an individual inspector retains scoped area completion without a final verdict selector', async () => {
  const view = harness(); const complete = view.button('외관 ' + inspectionRoleCopy.ko.complete);
  assert.equal(complete.props.disabled, false); complete.props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0][1].action, 'area-complete');
  assert.deepEqual(view.calls[0][1].payload, { area: 'appearance', area_version: 1, config_version: 2, judgement: 'pass' });
});
test('a stored concession remains distinct from failed area measurements', () => {
  const request = sharedFixture(); request.role_workflow!.aggregate_judgement = 'concession';
  request.role_workflow!.areas.forEach((row) => { row.status = 'complete'; row.judgement = 'fail'; });
  assert.equal(roleModel.inspectionRoleFinalJudgement(request.role_workflow!), 'concession');
});

test('delivered dimension input automatically saves FAIL with exact delta; appearance stays manual', async () => {
  const request = sharedFixture(); request.inspection_items[1].minimum = '9.5'; request.inspection_items[1].maximum = '10.5';
  const view = harness(request);
  assert.equal(view.input('inspection-item-42-1-judgement'), undefined);
  assert.ok(view.input('inspection-item-42-0-judgement'));
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: '10.6' } }); view.render();
  assert.match(view.text(), /불합격상한 초과 0.1 mm/);
  view.button('치수 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.equal(view.calls[0][1].payload.measurements[0].judgement, 'fail');
  assert.equal(view.calls[0][1].payload.measurements[0].value, '10.6');
  const next = harness(request);
  next.input('inspection-item-42-1-value').props.onChange({ target: { value: '9.5' } }); next.render();
  next.button('치수 ' + inspectionRoleCopy.ko.save).props.onClick(); await next.settle();
  assert.equal(next.calls[0][1].payload.measurements[0].judgement, 'pass');
});


test('shared terminal appearance has one selector and saves matching fail with inspector attribution', async () => {
  const request = sharedFixture();
  request.inspection_items[0] = { ...request.inspection_items[0], kind: 'choice', options: ['合格', '不合格'] };
  request.role_workflow!.areas[0].measurements[0] = { item_id: 'appearance-item', value: '合格', judgement: 'pass', evidence_url: '' };
  const view = harness(request);
  assert.equal(view.input('inspection-item-42-0-judgement'), undefined);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '不合格' } }); view.render();
  assert.match(view.text(), /不合格|불합격/);
  view.button('외관 ' + inspectionRoleCopy.ko.save).props.onClick(); await view.settle();
  assert.deepEqual(view.calls[0][1].payload.measurements[0], { item_id: 'appearance-item', value: '不合格', judgement: 'fail', evidence_url: '' });
  assert.equal(view.calls[0][1].payload.inspector_id, 201);
});
test('both inspection areas need a required item, including legacy requests and optional-only appearance', () => {
  const items = fixture().inspection_items;
  assert.equal(roleModel.inspectionRequiredAreasPresent(items), true);
  assert.equal(roleModel.inspectionRequiredAreasPresent(items.slice(1)), false);
  assert.equal(roleModel.inspectionRequiredAreasPresent(items.map(item => ({ ...item, required: item.id !== 'appearance-item' }))), false);
});

function wholeSnapshotFixture(phase: 'ready' | 'full_saved' = 'ready'): InspectionRequest {
  const request = fixture();
  request.status = 'approved'; request.judgement = 'pass';
  request.role_workflow!.status = 'complete'; request.role_workflow!.aggregate_judgement = 'pass';
  request.role_workflow!.areas.forEach((area) => { area.status = 'complete'; area.judgement = 'pass'; area.can_save = false; area.can_complete = false; });
  request.sync_status = phase === 'ready' ? 'not_synced' : 'succeeded';
  request.mes_workflow = { phase, mode: 'whole_snapshot', enabled: true, test_only: true, qc_code: 'SYNTHETIC-WHOLE-QC', test_label: 'SYNTHETIC',
    last_verified_at: null, source_digest: 'a'.repeat(64), operation_id: null,
    can_save: phase === 'ready', can_finish: phase === 'full_saved', can_reconcile: false };
  return request;
}

test('role UI dispatches whole save and separate finish with the server digest and no client measurement rows', async () => {
  for (const [phase, action, label, nextPhase] of [
    ['ready', 'mes-full-save', inspectionRoleCopy.ko.mesPartial, 'full_saved'],
    ['full_saved', 'mes-full-finish', copy.inspectionCopy.ko.mesFinish, 'full_completed'],
  ] as const) {
    const view = harness(wholeSnapshotFixture(phase), undefined, { mutateLegacy: (current) => ({ ...current, version: current.version + 1,
      sync_status: 'succeeded', mes_completion_status: nextPhase === 'full_completed' ? 'completed' : 'not_completed',
      mes_checked_at: '2026-10-07T10:11:59Z',
      mes_workflow: { ...current.mes_workflow!, phase: nextPhase, last_verified_at: '2026-10-07T10:11:59Z', can_save: false, can_finish: nextPhase === 'full_saved' } }) });
    assert.equal(view.button(label).props.disabled, false);
    view.button(label).props.onClick();
    await view.settle();
    assert.equal(view.calls.length, 1);
    assert.deepEqual(view.calls[0], [42, { action, payload: { source_digest: 'a'.repeat(64) }, key: '00000000-0000-4000-8000-000000000001' }, 'SYNTHETIC-SESSION-A']);
    assert.deepEqual(view.detailReads, [[42, 'SYNTHETIC-SESSION-A']]);
    assert.equal(view.button(inspectionRoleCopy.ko.retry), undefined);
  }
});

test('whole outcome reconciliation posts only the recorded operation and unlocks finish after verified full readback', async () => {
  const initial = wholeSnapshotFixture();
  initial.sync_status = 'unknown'; initial.last_error_code = 'mes_outcome_unknown';
  initial.mes_workflow = { ...initial.mes_workflow!, phase: 'full_save_unknown', operation_id: 301, can_save: false, can_reconcile: true };
  const view = harness(initial, undefined, { mutateLegacy: (current, attempt) => {
    assert.equal(attempt.action, 'mes-full-reconcile');
    assert.deepEqual(attempt.payload, { operation_id: 301 });
    return { ...current, version: current.version + 1, sync_status: 'succeeded', last_error_code: '', mes_checked_at: '2026-10-07T10:11:59Z',
      mes_workflow: { ...current.mes_workflow!, phase: 'full_saved', last_verified_at: '2026-10-07T10:11:59Z', can_finish: true, can_reconcile: false } };
  } });
  assert.equal(view.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true);
  assert.equal(view.button(copy.inspectionCopy.ko.mesFinish).props.disabled, true);
  const read = view.button(copy.inspectionCopy.ko.reload);
  assert.equal(read.props.disabled, false); read.props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0][1].action, 'mes-full-reconcile');
  assert.equal(view.button(copy.inspectionCopy.ko.mesFinish).props.disabled, false);
  assert.equal(view.locks.at(-1)?.locked, false);
  await view.settle(); assert.equal(view.calls.length, 1, 'a full readback must not automatically execute finish');
});

test('whole policy unavailable is a known pre-dispatch failure with no automatic stage retry', async () => {
  for (const code of ['whole_connection_review_required', 'remote_concurrency_unverified']) {
    const blocked = wholeSnapshotFixture(); blocked.mes_workflow = { ...blocked.mes_workflow!, enabled: false, can_save: false, source_digest: null };
    const view = harness(wholeSnapshotFixture(), { response: { status: 503, data: { code, detail: 'SYNTHETIC unavailable policy' } } }, { readDetail: async () => blocked });
    view.button(inspectionRoleCopy.ko.mesPartial).props.onClick(); await view.settle();
    assert.equal(view.calls.length, 1); assert.equal(view.detailReads.length, 1);
    assert.match(view.text(), /SYNTHETIC unavailable policy/);
    assert.equal(view.button(inspectionRoleCopy.ko.retry), undefined);
    assert.equal(view.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true);
    await view.settle(); assert.equal(view.calls.length, 1);
  }
});

test('recorded whole pending or unknown retains a read-only reconciliation lock even if follow-up GET fails', async () => {
  for (const [status, code, sync, phase] of [[202, 'operation_pending', 'pending', 'full_save_pending'], [503, 'mes_outcome_unknown', 'unknown', 'full_save_unknown']] as const) {
    for (const readFails of [false, true]) {
      const current = wholeSnapshotFixture();
      const recorded = { ...current, version: 4, sync_status: sync, last_error_code: code,
        mes_workflow: { ...current.mes_workflow!, phase, operation_id: 301, can_save: false, can_reconcile: true } };
      const view = harness(current, { response: { status, data: { code, operation_id: 301, request: recorded } } }, {
        readDetail: async () => { if (readFails) throw new Error('SYNTHETIC detail read failed'); return recorded; },
      });
      view.button(inspectionRoleCopy.ko.mesPartial).props.onClick(); await view.settle();
      assert.equal(view.calls.length, 1); assert.equal(view.detailReads.length, 1);
      assert.equal(view.button(inspectionRoleCopy.ko.retry), undefined, 'full attempts have a read control instead of a write retry');
      const feedback = view.nodes().find((node) => node.type === 'div' && node.props.className === 'inspection-message' && content(node).includes(inspectionRoleCopy.ko.uncertain));
      const readAgain = nodes(feedback).find((node) => node.type === 'button' && content(node) === copy.inspectionCopy.ko.reload);
      assert.ok(readAgain, 'retain the original immutable attempt while offering only a read');
      assert.equal(view.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true, 'a failed WJ GET cannot restore a stale save capability');
      assert.equal(view.button(copy.inspectionCopy.ko.mesFinish).props.disabled, true);
      assert.equal(view.locks.at(-1)?.locked, true, 'durable MES uncertainty protects editor navigation');
      const recovery = JSON.parse(view.recoveries.get('wj-inspection-role-draft:v1:101:42')!);
      assert.equal(recovery.reconciliation_required, true, 'durable MES uncertainty survives a page reload');
      assert.equal(recovery.attempt.action, 'mes-full-save');
      assert.equal(recovery.attempt.key, view.calls[0][1].key);
      assert.deepEqual(recovery.attempt.payload, { source_digest: 'a'.repeat(64) });
      readAgain.props.onClick(); await view.settle();
      assert.equal(view.detailReads.length, 2, 'the same-request feedback control performs only a local GET');
      assert.equal(view.calls.length, 1, 'feedback must not post the retained save attempt again');
      assert.equal(view.locks.at(-1)?.locked, true, 'a local GET never resolves provider uncertainty');
      await view.settle(); assert.equal(view.calls.length, 1, 'rendering and local reads must not resend the MES action');
    }
  }
});

test('explicit local read recovers a recorded whole operation after the immediate GET fails without resending save', async () => {
  const current = wholeSnapshotFixture();
  const recorded: InspectionRequest = { ...current, version: 4, sync_status: 'unknown', last_error_code: 'mes_outcome_unknown',
    mes_workflow: { ...current.mes_workflow!, phase: 'full_save_unknown', operation_id: 301, can_save: false, can_reconcile: true } };
  let readCount = 0;
  const view = harness(current, { response: { status: 503, data: { code: 'mes_outcome_unknown', operation_id: 301, request: recorded } } }, {
    readDetail: async () => { if (++readCount === 1) throw new Error('SYNTHETIC immediate GET failed'); return recorded; },
  });
  view.button(inspectionRoleCopy.ko.mesPartial).props.onClick(); await view.settle();
  const feedback = view.nodes().find((node) => node.type === 'div' && node.props.className === 'inspection-message' && content(node).includes(inspectionRoleCopy.ko.uncertain));
  nodes(feedback).find((node) => node.type === 'button')!.props.onClick(); await view.settle();
  assert.equal(view.calls.length, 1); assert.equal(view.detailReads.length, 2);
  assert.equal(view.button(inspectionRoleCopy.ko.mesPartial).props.disabled, true);
  assert.equal(view.locks.at(-1)?.locked, true, 'a successful local GET retains the provider reconciliation lock');
  const providerRead = view.nodes().find((node) => node.props.className === 'inspection-mes-strip')!;
  const reconciliation = nodes(providerRead).find((node) => node.type === 'button' && content(node) === copy.inspectionCopy.ko.reload);
  assert.ok(reconciliation, 'the recovered summary exposes an explicit provider read for the matching operation');
  assert.equal(reconciliation.props.disabled, false);
  const recovery = JSON.parse(view.recoveries.get('wj-inspection-role-draft:v1:101:42')!);
  assert.equal(recovery.whole_operation_id, 301);
  assert.equal(recovery.reconciliation_required, true);
  assert.deepEqual(recovery.attempt.payload, { source_digest: 'a'.repeat(64) });
});
