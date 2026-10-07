import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import * as model from '../src/pages/quality/inspection-requests/model.ts';
import * as navigation from '../src/pages/quality/inspection-requests/navigation.ts';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
import * as results from '../src/pages/quality/inspection-requests/mesWorkflowResult.ts';
import * as trial from '../src/pages/quality/inspection-requests/integrationTrial.ts';
import { inspectionRequestKind } from '../src/pages/quality/inspection-requests/kanban.ts';
import { inspectionKanbanCopy } from '../src/pages/quality/inspection-requests/kanbanCopy.ts';

// Execute the delivered component with synthetic hooks/API adapters. Native
// details/summary semantics remain browser-owned; no DOM, session or MES is read.
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
  if (Array.isArray(node)) return node.map((child) => content(child, visible)).join(' ');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (visible && node.type === 'details' && !node.props.open) return content(summary(node), visible);
  return content(node.props?.children, visible);
}
function harness(initial = fixture(), lang: 'ko' | 'zh' = 'ko', fail = false, mesEnabled = true) {
  const hooks: any[] = [];
  const writes: unknown[] = [];
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
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }), Fragment: 'Fragment' },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => assert.equal(session, SESSION) },
    'lucide-react': { ExternalLink: 'Icon', Plus: 'Icon', RefreshCw: 'Icon' },
    '@/components/MesConnectionDialog': { default: 'MesConnectionDialog' },
    './api': { ...model, getInspectionRequest: async () => initial,
      mutateInspectionRequest: async (...args: unknown[]) => { writes.push(args); if (fail) throw { response: { status: 400, data: { detail: 'SYNTHETIC-SAVE-FAILURE' } } }; return initial; } },
    './TrialPresentation': { IntegrationTrialBadge: 'IntegrationTrialBadge' }, './integrationTrial': trial,
    './copy': copy, './workflow': { ...workflow, createInspectionKey: () => '00000000-0000-4000-8000-000000000001' },
    './kanban': { inspectionRequestKind }, './kanbanCopy': { inspectionKanbanCopy }, './navigation': navigation, './mesWorkflowResult': results,
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'sessionStorage', 'window', compiled)(
    (name: string) => { assert.ok(name in dependencies, `Unexpected module: ${name}`); return dependencies[name]; }, exports,
    { getItem: () => null, setItem: () => {}, removeItem: () => {} }, { confirm: () => true },
  );
  function render() { cursor = 0; tree = exports.default({ initial, userId: 18, sessionId: SESSION, lang,
    globalCapabilities: { data_mode: 'wj_local_beta', mes: { enabled: mesEnabled, can_refresh: true } }, onChanged: () => {}, onDirty: () => {}, onLocked: () => {} }); }
  render();
  return { writes, render, nodes: (visible = false) => nodes(tree, visible), text: (visible = false) => content(tree, visible),
    button: (label: string) => nodes(tree).find((node) => node.type === 'button' && content(node).trim() === label)!,
    async settle() { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); render(); } },
  };
}

test('native circled-i help starts folded; real status and next action stay visible in both languages', () => {
  for (const lang of ['ko', 'zh'] as const) {
    const view = harness(fixture('saved'), lang);
    const text = copy.inspectionCopy[lang];
    assert.ok(view.text(true).includes(text.mesSave));
    assert.ok(view.text(true).includes(text.mesFinish));
    assert.ok(view.text(true).includes(text.refreshMes));
    assert.ok(!view.text(true).includes(text.receiptHint), 'Stock-contract explanation should not dominate the working screen');
    assert.ok(!view.text(true).includes(text.mesStageHint));
    assert.ok(view.text().includes(text.receiptHint), 'Original explanation remains available');
    const helps = view.nodes().filter((node) => node.type === 'details' && node.props.className?.includes('inspection-help'));
    assert.ok(helps.length >= 4);
    for (const help of helps) {
      assert.ok(!help.props.open, 'Help must not expand by default');
      const summary = nodes(help.props.children).find((node) => node.type === 'summary')!;
      assert.ok(content(summary).includes('ⓘ'));
      assert.equal(summary.props.role, undefined, 'Keep native keyboard/expanded semantics');
      assert.notEqual(summary.props.tabIndex, -1);
      assert.ok(nodes(summary).some((node) => node.type === 'span' && node.props['aria-hidden'] === 'true'));
    }
    const mesHelp = helps.find((node) => content(node).includes(text.mesStageHint))!;
    mesHelp.props.open = true;
    assert.ok(view.text(true).includes(text.receiptHint), 'Opening help reveals the original explanation');
    assert.equal(view.writes.length, 0, 'Reading help cannot dispatch a write');
  }
});

test('ready/save/finish states highlight only the permitted next MES action', () => {
  const text = copy.inspectionCopy.ko;
  for (const phase of ['ready', 'saved', 'completed'] as const) {
    const view = harness(fixture(phase));
    const save = view.button(text.mesSave); const finish = view.button(text.mesFinish);
    assert.equal(save.props.disabled, phase !== 'ready');
    assert.equal(finish.props.disabled, phase !== 'saved');
    assert.equal(save.props.className.includes('is-primary'), phase === 'ready');
    assert.equal(finish.props.className.includes('is-primary'), phase === 'saved');
    assert.ok(view.nodes(true).includes(save)); assert.ok(view.nodes(true).includes(finish));
    assert.ok(view.nodes(true).some((node) => node.type === 'IntegrationTrialBadge'));
    assert.ok(view.text(true).includes(trial.integrationTrialCopy.ko.excluded));
    assert.ok(view.text(true).includes(LABEL), 'The permanent non-measured marker stays visible');
  }
});

test('a scoped processing limit does not imply logout or obscure an already completed QC', () => {
  for (const lang of ['ko', 'zh'] as const) {
    const ready = harness(fixture('ready'), lang, false, false);
    const completed = harness(fixture('completed'), lang, false, false);
    const readiness = lang === 'ko' ? '이 검사요청의 MES 처리 준비가 필요합니다.' : '此检验申请需准备 MES 处理。';
    assert.ok(ready.text(true).includes(readiness));
    assert.ok(!completed.text(true).includes(readiness));
    assert.ok(completed.text(true).includes(copy.mesCompletionLabels[lang].completed));
    assert.ok(!ready.text(true).includes(lang === 'ko' ? 'MES 미연결' : 'MES 未连接'));
  }
});

test('unknown outcome keeps values and visible reconciliation warning while blocking retransmission', async () => {
  const initial = fixture('finish_unknown');
  initial.sync_status = 'unknown'; initial.mes_completion_status = 'unknown'; initial.last_error_code = 'mes_outcome_unknown';
  initial.mes_workflow!.can_save = true; initial.mes_workflow!.can_finish = true;
  const view = harness(initial); const text = copy.inspectionCopy.ko;
  assert.ok(view.text(true).includes(text.reconciliationRequired));
  assert.ok(view.text(true).includes(text.currentReconciliation));
  assert.ok(view.nodes(true).some((node) => node.props.role === 'status' && content(node).includes(text.reconciliationRequired)));
  for (const label of [text.mesSave, text.mesFinish]) { const button = view.button(label); assert.equal(button.props.disabled, true); button.props.onClick(); }
  await view.settle();
  assert.equal(view.writes.length, 0);
  assert.equal(view.button(text.refreshMes).props.disabled, false);
  assert.equal(view.button(text.refreshMes).props.className.includes('is-primary'), true);
  assert.ok(view.nodes(true).some((node) => node.type === 'input' && node.props.value === '1.25'));
});

test('edited input and a failed save remain visible and prevent skipping directly to MES', async () => {
  const view = harness(fixture(), 'ko', true); const text = copy.inspectionCopy.ko;
  const input = view.nodes().find((node) => node.type === 'input' && node.props.value === '1.25')!;
  input.props.onChange({ target: { value: '2.50' } }); view.render();
  assert.ok(view.text(true).includes(text.dirty));
  assert.equal(view.button(text.mesSave).props.disabled, true);
  view.button(text.save).props.onClick(); await view.settle();
  assert.equal(view.writes.length, 1);
  assert.ok(view.nodes(true).some((node) => node.props.role === 'alert' && content(node).includes('SYNTHETIC-SAVE-FAILURE')));
  assert.ok(view.text(true).includes(text.dirty));
  assert.ok(view.nodes(true).some((node) => node.type === 'input' && node.props.value === '2.50'));
});
