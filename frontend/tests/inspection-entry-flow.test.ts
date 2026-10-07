import * as displayLabel from '../src/pages/quality/inspection-requests/displayLabel.ts';
import * as measurementJudgement from '../src/pages/quality/inspection-requests/measurementJudgement.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import * as model from '../src/pages/quality/inspection-requests/model.ts';
import * as navigation from '../src/pages/quality/inspection-requests/navigation.ts';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
import * as roleModel from '../src/pages/quality/inspection-requests/roleModel.ts';
import * as results from '../src/pages/quality/inspection-requests/mesWorkflowResult.ts';
import * as trial from '../src/pages/quality/inspection-requests/integrationTrial.ts';
import { inspectionRequestKind } from '../src/pages/quality/inspection-requests/kanban.ts';
import { inspectionKanbanCopy } from '../src/pages/quality/inspection-requests/kanbanCopy.ts';

// Execute the delivered component with synthetic hooks/API adapters. Native
// details/summary semantics remain browser-owned; no DOM, session or MES is read.
const entryFlow: Record<string, any> = {};
new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/inspectionEntryFlow.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)((name: string) => { assert.equal(name, './workflow'); return workflow; }, entryFlow);
const verdictComponent: Record<string, any> = {};
const verdictRuntime = { jsx: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), Fragment: 'Fragment' };
new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/InspectionMeasurementVerdict.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name: string) => name === 'react/jsx-runtime' ? verdictRuntime : name === './displayLabel' ? displayLabel : measurementJudgement, verdictComponent);
const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/InspectionRequestDetail.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const SESSION = 'SYNTHETIC-INSPECTOR-UX-SESSION';
const LABEL = 'SYNTHETIC-NOT-MEASURED';
function fixture(phase: model.InspectionMesWorkflow['phase'] = 'ready'): model.InspectionRequest {
  return {
    id: 42, version: 4, work_order_ref: 'SYNTHETIC-TRIAL-42', task_ref: '', part_no: '', equipment_ref: '',
    inspection_type: 'general', target_quantity: '1', uom: '', warehouse_ref: '', lot_ref: '', work_started_at: '',
    inspection_items: [{ id: 'synthetic-item', label: 'SYNTHETIC-DIMENSION', kind: 'number', unit: '', required: true, evidence_required: false }],
    measurements: [{ item_id: 'synthetic-item', value: '1.25', judgement: 'pass', evidence_url: '' }],
    require_evidence: false, quantity_mode: 'not_recorded', judgement_policy: 'strict_items',
    evidence: [], inspected_quantity: '0', accepted_quantity: '0', rejected_quantity: '0', judgement: 'pass', notes: LABEL,
    source_kind: 'integration_test', parent: null, assigned_to: 18, assigned_to_name: 'SYNTHETIC-INSPECTOR',
    status: 'approved', submitted_by: 18, submitted_at: null, reviewed_by: 18, reviewed_at: null, review_reason: '',
    sync_status: phase === 'ready' ? 'not_synced' : 'succeeded', mes_completion_status: phase === 'completed' ? 'completed' : 'not_completed',
    injection_receipt_readiness: 'not_verified', mes_checked_at: '2026-10-06T03:00:00Z', external_result_id: 'SYNTHETIC-ID',
    mes_state: { task_status: 1, qc_status: 1, state_version: null, receipt_allowed: null }, last_error_code: '',
    created_at: '2026-10-06T03:00:00Z', updated_at: '2026-10-06T03:00:00Z', audit: [], operations: [],
    mes_workflow: { phase, enabled: true, test_only: true, qc_code: 'SYNTHETIC-QC', test_label: LABEL,
      last_verified_at: '2026-10-06T03:00:00Z', can_save: phase === 'ready', can_finish: phase === 'saved', can_reconcile: true },
    capabilities: { can_edit: true, can_submit: false, can_review: false, can_reinspect: false, can_sync: false, can_refresh: true },
  };
}
function summary(node: Element): Element | undefined {
  return [node.props.children].flat().find((child) => child && typeof child === 'object' && child.type === 'summary');
}
function nodes(node: any, visible = false): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child, visible));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const children = visible && node.type === 'details' && !node.props.open ? summary(node) : node.props.children;
  return [node, ...nodes(children, visible)];
}
function content(node: any, visible = false): string {
  if (Array.isArray(node)) return node.map((child) => content(child, visible)).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (visible && node.type === 'details' && !node.props.open) return content(summary(node), visible);
  return content(node.props?.children, visible);
}
function metaValue(view: ReturnType<typeof harness>, label: string): string {
  const row = view.nodes(true).find((node) => node.type === 'div'
    && nodes(node.props.children).some((child) => child.type === 'dt' && content(child).trim() === label));
  assert.ok(row, `Visible metadata required: ${label}`);
  return content(nodes(row.props.children).find((node) => node.type === 'dd')).trim();
}
function harness(initial = fixture(), lang: 'ko' | 'zh' = 'ko', fail = false, mesEnabled = true, mutate?: (current: model.InspectionRequest, attempt: any) => model.InspectionRequest) {
  const hooks: any[] = [];
  const writes: unknown[] = [];
  const removedRecovery: string[] = [];
  let server = initial;
  let cursor = 0;
  let tree: Element;
  const dependencies: Record<string, unknown> = {
    react: {
      useState(value: any) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value;
        return [hooks[i], (next: any) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
      useRef(value: any) { const i = cursor++; return hooks[i] ?? (hooks[i] = { current: value }); },
      useMemo: (make: () => unknown) => { cursor += 1; return make(); },
      useCallback: (callback: unknown) => { cursor += 1; return callback; },
      useEffect: () => { cursor += 1; },
    },
    'react/jsx-runtime': { jsx: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), Fragment: 'Fragment' },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => assert.equal(session, SESSION) },
    'lucide-react': { ExternalLink: 'Icon', Plus: 'Icon', RefreshCw: 'Icon' },
    '@/components/MesConnectionDialog': { default: 'MesConnectionDialog' },
    './InspectionAuxiliaryTabs': { default: 'InspectionAuxiliaryTabs' },
    './displayLabel': displayLabel, './InspectionMeasurementVerdict': verdictComponent, './measurementJudgement': measurementJudgement,
    './InspectionFinalJudgementDialog': { default: 'InspectionFinalJudgementDialog' },
    './inspectionEntryFlow': entryFlow, './roleModel': roleModel,
    './api': { ...model, getInspectionRequest: async () => server,
      mutateInspectionRequest: async (...args: unknown[]) => { writes.push(args); if (fail) throw { response: { status: 400, data: { detail: 'SYNTHETIC-SAVE-FAILURE' } } }; if (mutate) server = mutate(server, args[1]); return server; } },
    './RoleInspectionRequestDetail': { default: 'RoleInspectionRequestDetail' }, './TrialPresentation': { IntegrationTrialBadge: 'IntegrationTrialBadge' }, './integrationTrial': trial,
    './copy': copy, './workflow': { ...workflow, createInspectionKey: () => '00000000-0000-4000-8000-000000000001' },
    './kanban': { inspectionRequestKind }, './kanbanCopy': { inspectionKanbanCopy }, './navigation': navigation, './mesWorkflowResult': results,
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'sessionStorage', 'window', compiled)(
    (name: string) => { assert.ok(name in dependencies, `Unexpected module: ${name}`); return dependencies[name]; }, exports,
    { getItem: () => null, setItem: () => {}, removeItem: (key: string) => removedRecovery.push(key) }, { confirm: () => true },
  );
  function render() { cursor = 0; tree = exports.default({ initial, userId: 18, sessionId: SESSION, lang,
    globalCapabilities: { data_mode: 'wj_local_beta', mes: { enabled: mesEnabled, can_refresh: true } }, onChanged: () => {}, onDirty: () => {}, onLocked: () => {} }); }
  render();
  return { dialog: () => nodes(tree).find(node => node.type === 'InspectionFinalJudgementDialog'), input: (id: string) => nodes(tree).find(node => node.props.id === id)!, writes, removedRecovery, render, nodes: (visible = false) => nodes(tree, visible), text: (visible = false) => content(tree, visible),
    button: (label: string) => nodes(tree).find((node) => node.type === 'button' && content(node).trim() === label)!,
    async settle() { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); render(); } },
  };
}


test('legacy area save retains the other area draft and opens final dialog only after both saves', async () => {
  const request = fixture(); request.status = 'draft'; request.capabilities.can_submit = true; request.source_kind = 'local_manual';
  request.inspection_items.push({ id: 'visual', label: 'SYNTHETIC-VISUAL', kind: 'text', unit: '', required: true, evidence_required: false });
  request.measurements.push({ item_id: 'visual', value: 'original', judgement: 'pass' });
  const view = harness(request, 'ko', false, false, (current, attempt) => {
    assert.equal(attempt.payload.version, current.version);
    return { ...current, ...attempt.payload, version: current.version + 1, ...(attempt.action === 'submit' ? { status: 'submitted' as const } : {}) };
  });
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: ' 2.50 ' } }); view.render();
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: 'new visual' } }); view.render();
  view.button('외관 저장').props.onClick(); await view.settle();
  assert.equal(view.dialog(), undefined); assert.equal(view.input('inspection-item-42-0-value').props.value, ' 2.50 ');
  view.button('치수 저장').props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, '2.50');
  assert.ok(view.dialog()); assert.equal(view.writes.length, 2);
  assert.equal(view.nodes().some(node => node.type === 'select' && node.props.value === request.judgement && !node.props.id), false);
  view.dialog()!.props.onConfirm('pass', ''); await view.settle();
  assert.equal((view.writes[2] as any[])[1].payload.judgement, 'pass'); assert.equal(view.dialog(), undefined);
});
test('legacy failed save retains draft and never opens a final decision', async () => {
  const request = fixture(); request.status = 'draft'; request.source_kind = 'local_manual'; request.capabilities.can_submit = true; delete request.mes_workflow;
  const view = harness(request, 'ko', true);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '2.50' } }); view.render();
  view.button('치수 저장').props.onClick(); await view.settle();
  assert.equal(view.input('inspection-item-42-0-value').props.value, '2.50'); assert.equal(view.dialog(), undefined);
});

test('delivered legacy dimension badge and saved verdict change together without a manual selector', async () => {
  const request = fixture(); request.status = 'draft'; request.source_kind = 'local_manual'; request.inspection_items[0].minimum = '1'; request.inspection_items[0].maximum = '2';
  const view = harness(request);
  assert.equal(view.input('inspection-item-42-0-judgement'), undefined);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '0.9' } }); view.render();
  assert.match(view.text(), /불합격하한 미달 0.1/);
  view.button('치수 저장').props.onClick(); await view.settle();
  assert.equal((view.writes[0] as any[])[1].payload.measurements[0].judgement, 'fail');
});


test('legacy appearance uses one localized choice and saves the original configured value with matching verdict', async () => {
  const request = fixture(); request.status = 'draft'; request.source_kind = 'local_manual';
  request.inspection_items.push({ id: 'visual', label: '외관 / 外观', kind: 'choice', options: ['合格', '不合格'], unit: '', required: true, evidence_required: false });
  request.measurements.push({ item_id: 'visual', value: '', judgement: '' });
  const view = harness(request);
  assert.equal(view.input('inspection-item-42-1-judgement'), undefined);
  assert.equal(content(view.input('inspection-item-42-1-value')), '선택하세요합격불합격');
  view.input('inspection-item-42-1-value').props.onChange({ target: { value: '不合格' } }); view.render();
  assert.match(view.text(), /불합격/);
  view.button('외관 저장').props.onClick(); await view.settle();
  assert.deepEqual((view.writes[0] as any[])[1].payload.measurements[1], { item_id: 'visual', value: '不合格', judgement: 'fail', evidence_url: '' });
});
test('a dimension-only legacy request shows both cards but cannot finalise a missing appearance inspection', async () => {
  const request = fixture(); request.status = 'draft'; request.source_kind = 'local_manual'; request.capabilities.can_submit = true; delete request.mes_workflow;
  const view = harness(request, 'ko', false, false, (current, attempt) => ({ ...current, ...attempt.payload, version: current.version + 1 }));
  assert.equal(view.nodes().filter(node => node.props.className === 'inspection-area-card').length, 2);
  assert.equal(view.button('최종 판정').props.disabled, true);
  assert.equal(view.button('외관 저장').props.disabled, true);
  assert.match(view.text(), /치수와 외관은 모두 필수/);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '2' } }); view.render();
  view.button('치수 저장').props.onClick(); await view.settle();
  assert.equal(view.dialog(), undefined); assert.equal(view.button('최종 판정').props.disabled, true);
});

test('returning an input to its saved value clears only that request recovery and sends no write', () => {
  const request = fixture(); request.status = 'draft';
  const view = harness(request);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '2.5' } }); view.render();
  assert.equal(view.removedRecovery.length, 0);
  view.input('inspection-item-42-0-value').props.onChange({ target: { value: '1.25' } }); view.render();
  assert.deepEqual(view.removedRecovery, [workflow.inspectionRecoveryKey(18, 42)]);
  assert.equal(view.writes.length, 0);
});
