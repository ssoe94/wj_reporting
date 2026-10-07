import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { Children, isValidElement } from 'react';
import * as displayLabel from '../src/pages/quality/inspection-requests/displayLabel.ts';
import * as measurementJudgement from '../src/pages/quality/inspection-requests/measurementJudgement.ts';
import * as roleModel from '../src/pages/quality/inspection-requests/roleModel.ts';
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
const expandedDetails = new WeakSet<Element>();
function openDetails(node: Element) { expandedDetails.add(node); }
function nodes(node: any, visible = false): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child, visible));
  if (!node || typeof node !== 'object' || !('props' in node) || (visible && node.props.hidden)) return [];
  const children = visible && node.type === 'details' && !node.props.open && !expandedDetails.has(node) ? summary(node) : node.props.children;
  return [node, ...nodes(children, visible)];
}
function content(node: any, visible = false): string {
  if (Array.isArray(node)) return node.map((child) => content(child, visible)).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (visible && node.props?.hidden) return '';
  if (visible && node.type === 'details' && !node.props.open && !expandedDetails.has(node)) return content(summary(node), visible);
  return content(node.props?.children, visible);
}
function metaValue(view: ReturnType<typeof harness>, label: string): string {
  const row = view.nodes(true).find((node) => node.type === 'div'
    && nodes(node.props.children).some((child) => child.type === 'dt' && content(child).trim() === label));
  assert.ok(row, `Visible metadata required: ${label}`);
  return content(nodes(row.props.children).find((node) => node.type === 'dd')).trim();
}
function harness(initial = fixture(), lang: 'ko' | 'zh' = 'ko', fail = false, mesEnabled = true) {
  const hooks: any[] = [];
  const writes: unknown[] = [];
  let cursor = 0;
  let tree: Element;
  const dependencies: Record<string, unknown> = {
    react: {
      Children, isValidElement,
      useId: () => `synthetic-inspector-${cursor++}`,
      useState(value: any) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value;
        return [hooks[i], (next: any) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
      useRef(value: any) { const i = cursor++; return hooks[i] ?? (hooks[i] = { current: value }); },
      useMemo: (make: () => unknown) => { cursor += 1; return make(); },
      useCallback: (callback: unknown) => { cursor += 1; return callback; },
      useEffect: () => { cursor += 1; },
    },
    'react/jsx-runtime': { jsx: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ $$typeof: Symbol.for('react.transitional.element'), type, props, key: null }), jsxs: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ $$typeof: Symbol.for('react.transitional.element'), type, props, key: null }), Fragment: 'Fragment' },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => assert.equal(session, SESSION) },
    'lucide-react': { ExternalLink: 'Icon', Plus: 'Icon', RefreshCw: 'Icon', ChevronDown: 'Icon' },
    'react-dom': { createPortal: (node: unknown) => node },
    './displayLabel': displayLabel, './measurementJudgement': measurementJudgement, './roleModel': roleModel,
    '@/components/MesConnectionDialog': { default: 'MesConnectionDialog' },
    './api': { ...model, getInspectionRequest: async () => initial,
      mutateInspectionRequest: async (...args: unknown[]) => { writes.push(args); if (fail) throw { response: { status: 400, data: { detail: 'SYNTHETIC-SAVE-FAILURE' } } }; return initial; } },
    './RoleInspectionRequestDetail': { default: 'RoleInspectionRequestDetail' }, './TrialPresentation': { IntegrationTrialBadge: 'IntegrationTrialBadge' }, './integrationTrial': trial,
    './copy': copy, './workflow': { ...workflow, createInspectionKey: () => '00000000-0000-4000-8000-000000000001' },
    './kanban': { inspectionRequestKind }, './kanbanCopy': { inspectionKanbanCopy }, './navigation': navigation, './mesWorkflowResult': results,
  };
  for (const module of ['inspectionEntryFlow', 'InspectionMeasurementVerdict', 'InspectionFinalJudgementDialog', 'InspectionAuxiliaryTabs']) {
    const output: Record<string, unknown> = {};
    const extension = module === 'inspectionEntryFlow' ? 'ts' : 'tsx';
    const source = readFileSync(new URL(`../src/pages/quality/inspection-requests/${module}.${extension}`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function('require', 'exports', 'document', code)((name: string) => { assert.ok(name in dependencies, `Unexpected module in ${module}: ${name}`); return dependencies[name]; }, output, { body: {} });
    dependencies[`./${module}`] = output;
  }
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'sessionStorage', 'window', compiled)(
    (name: string) => { assert.ok(name in dependencies, `Unexpected module: ${name}`); return dependencies[name]; }, exports,
    { getItem: () => null, setItem: () => {}, removeItem: () => {} }, { confirm: () => true },
  );
  function render() { cursor = 0; tree = exports.default({ initial, userId: 18, sessionId: SESSION, lang,
    globalCapabilities: { data_mode: 'wj_local_beta', mes: { enabled: mesEnabled, can_refresh: true } }, onChanged: () => {}, onDirty: () => {}, onLocked: () => {} }); }
  render();
  return { writes, render, nodes: (visible = false) => nodes(tree, visible), text: (visible = false) => content(tree, visible),
    openPanel: (name: string) => {
      const button = nodes(tree).find((node) => node.type === 'button' && String(node.props['aria-controls']).endsWith(`-${name}-content`));
      assert.ok(button, `Auxiliary panel control required: ${name}`);
      if (!button.props['aria-expanded']) { button.props.onClick(); render(); }
      const panel = nodes(tree, true).find((node) => node.props.role === 'region' && String(node.props.id).endsWith(`-${name}-content`));
      assert.ok(panel, `Opened auxiliary panel must be visible: ${name}`);
      return panel;
    },
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
    const mesPanel = view.openPanel('mes');
    const mesHelp = nodes(mesPanel).find((node) => node.type === 'details' && content(node).includes(text.mesStageHint))!;
    openDetails(mesHelp);
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
    ready.openPanel('mes'); completed.openPanel('mes');
    const readiness = lang === 'ko' ? '이 검사요청의 MES 처리 준비가 필요합니다.' : '此检验申请需准备 MES 处理。';
    assert.ok(ready.text(true).includes(readiness));
    assert.ok(!completed.text(true).includes(readiness));
    assert.ok(completed.text(true).includes(copy.mesCompletionLabels[lang].completed));
    assert.ok(!ready.text(true).includes(lang === 'ko' ? 'MES 미연결' : 'MES 未连接'));
  }
});

test('the standalone MES verdict uses only the verified server projection in both languages', () => {
  for (const lang of ['ko', 'zh'] as const) {
    for (const verdict of ['pass', 'fail'] as const) {
      const initial = fixture('completed');
      initial.judgement = verdict === 'pass' ? 'fail' : 'pass';
      initial.mes_state.qc_status = verdict === 'pass' ? 4 : 1;
      initial.mes_trial_observation = { verdict, observed_at: initial.mes_checked_at };
      const view = harness(initial, lang); view.openPanel('mes');
      assert.equal(metaValue(view, copy.inspectionCopy[lang].mesTrialVerdict), trial.integrationTrialCopy[lang][verdict]);
      assert.ok(!view.text(true).includes(copy.inspectionCopy[lang].mesQcStatus), 'Trial must not masquerade as a production QC verdict');
      assert.equal(view.writes.length, 0, 'Rendering a verified verdict sends no operation');
    }
  }
});

test('missing, unverified and unresolved standalone projections never borrow local or production verdicts', () => {
  for (const lang of ['ko', 'zh'] as const) {
    const initial = fixture('completed');
    for (const observation of [undefined, null, { verdict: null, observed_at: null },
      { verdict: null, observed_at: initial.mes_checked_at }, { verdict: 'pass', observed_at: null },
      { verdict: 'pass', observed_at: 'invalid-time' }, { verdict: 'unexpected', observed_at: initial.mes_checked_at }] as const) {
      const candidate = { ...initial, mes_trial_observation: observation } as model.InspectionRequest;
      const view = harness(candidate, lang); view.openPanel('mes');
      assert.equal(metaValue(view, copy.inspectionCopy[lang].mesTrialVerdict), trial.integrationTrialCopy[lang].unknown);
    }
    initial.mes_completion_status = 'approval_pending';
    initial.mes_trial_observation = { verdict: null, observed_at: initial.mes_checked_at };
    const pending = harness(initial, lang); pending.openPanel('mes');
    assert.equal(metaValue(pending, copy.inspectionCopy[lang].mesTrialVerdict), trial.integrationTrialCopy[lang].unknown);
    assert.ok(pending.text(true).includes(copy.mesCompletionLabels[lang].approval_pending));
    initial.sync_status = 'unknown'; initial.last_error_code = 'mes_outcome_unknown';
    initial.mes_trial_observation = { verdict: 'pass', observed_at: initial.mes_checked_at };
    const unknown = harness(initial, lang); unknown.openPanel('mes');
    assert.equal(metaValue(unknown, copy.inspectionCopy[lang].mesTrialVerdict), trial.integrationTrialCopy[lang].unknown);
    assert.ok(unknown.text(true).includes(copy.inspectionCopy[lang].reconciliationRequired));
  }
});

test('production inspection keeps its MES QC status even if a trial projection is present', () => {
  for (const lang of ['ko', 'zh'] as const) {
    const initial = fixture('completed');
    initial.source_kind = 'local_manual'; initial.inspection_type = 'first'; initial.mes_workflow!.test_only = false;
    initial.mes_state.qc_status = 4;
    initial.mes_trial_observation = { verdict: 'pass', observed_at: initial.mes_checked_at };
    const view = harness(initial, lang); view.openPanel('mes');
    assert.equal(metaValue(view, copy.inspectionCopy[lang].mesQcStatus), copy.mesQcLabels[lang][4]);
    assert.ok(!view.text(true).includes(copy.inspectionCopy[lang].mesTrialVerdict));
  }
});

test('area tables keep criteria, labelled values, automatic verdicts and scoped saves aligned', async () => {
  const initial = fixture();
  initial.inspection_items[0].unit = 'mm'; initial.inspection_items[0].minimum = '0.50'; initial.inspection_items[0].maximum = '3.00';
  initial.inspection_items.push({ id: 'synthetic-choice', label: 'SYNTHETIC-VISUAL', kind: 'choice', options: ['OK', 'NG'], unit: '', required: false, evidence_required: false });
  initial.measurements.push({ item_id: 'synthetic-choice', value: 'OK', judgement: 'pass', evidence_url: '' });
  const view = harness(initial);
  const table = view.nodes(true).filter((node) => node.type === 'table');
  assert.equal(table.length, 2, 'Dimension and appearance each retain a semantic working table');
  for (const areaTable of table) {
    assert.equal(content(nodes(areaTable).find((node) => node.type === 'caption')).trim(), copy.inspectionCopy.ko.items);
    assert.equal(nodes(areaTable).filter((node) => node.type === 'th' && node.props.scope === 'col').length, 5);
  }
  const rows = nodes(table).filter((node) => node.type === 'tr' && nodes(node).some((child) => child.type === 'th' && child.props.scope === 'row'));
  assert.equal(rows.length, 2);
  assert.equal(content(nodes(rows[0]).find((node) => node.type === 'th')).trim(), 'SYNTHETIC-DIMENSION *0.50–3.00 mm');
  for (const criterion of ['mm', '0.50', '3.00']) assert.ok(content(rows[0]).includes(criterion));
  assert.equal(nodes(rows[1]).some((node) => node.props.className === 'inspection-item-required'), false);
  const controls = nodes(table).filter((node) => ['input', 'select'].includes(String(node.type)));
  assert.equal(new Set(controls.map((node) => node.props.id)).size, 2);
  assert.equal(nodes(table).filter((node) => node.props.className === 'inspection-auto-verdict').length, 2);
  assert.equal(nodes(table).some((node) => node.type === 'select' && String(node.props.id).endsWith('-judgement')), false);
  for (const control of controls) {
    const label = nodes(table).find((node) => node.type === 'label' && node.props.htmlFor === control.props.id);
    assert.ok(label, 'Every control keeps a unique native label association');
    assert.equal(control.props.disabled, false);
  }
  assert.equal(content(nodes(rows[0]).find((node) => node.type === 'label')).trim(), 'SYNTHETIC-DIMENSION · 측정·관찰 값 *');
  const value = controls.find((node) => node.type === 'input')!;
  value.props.onChange({ target: { value: '2.50' } }); view.render();
  assert.ok(view.nodes(true).some((node) => node.type === 'select' && node.props.value === 'OK'));
  view.button('치수 저장').props.onClick(); await view.settle();
  const attempt = (view.writes[0] as unknown[])[1] as workflow.MutationAttempt;
  assert.deepEqual((attempt.payload.measurements as model.InspectionMeasurement[]).map((item) => [item.item_id, item.value]), [['synthetic-item', '2.50'], ['synthetic-choice', 'OK']]);
  initial.capabilities.can_edit = false;
  const readonly = harness(initial);
  assert.ok(readonly.nodes(true).filter((node) => ['input', 'select'].includes(String(node.type))).every((node) => node.props.disabled === true));
});

test('required evidence remains discoverable and editable without exposing optional URLs in the working table', () => {
  const initial = fixture(); initial.require_evidence = true; initial.inspection_items[0].evidence_required = true;
  initial.measurements[0].evidence_url = 'https://example.test/synthetic-item-evidence';
  initial.evidence = [{ label: 'SYNTHETIC-COMMON', url: 'https://example.test/synthetic-common-evidence' }];
  const view = harness(initial); const text = copy.inspectionCopy.ko;
  assert.ok(view.text(true).includes(text.evidenceRequired));
  assert.ok(view.text(true).includes(text.requiredEvidenceHint));
  assert.equal(view.nodes(true).filter((node) => node.type === 'input' && node.props.type === 'url').length, 0);
  assert.equal(view.nodes(true).filter((node) => node.type === 'a').length, 0);
  view.openPanel('evidence');
  const urlInputs = view.nodes(true).filter((node) => node.type === 'input' && node.props.type === 'url');
  assert.equal(urlInputs.length, 2); assert.ok(urlInputs.every((node) => node.props.disabled === false));
  assert.ok(view.nodes(true).some((node) => node.type === 'input' && node.props['aria-label'] === `SYNTHETIC-DIMENSION · ${text.itemEvidence} *`));
  assert.ok(view.nodes(true).some((node) => node.type === 'a' && node.props.href === initial.measurements[0].evidence_url));
  initial.capabilities.can_edit = false;
  const readonly = harness(initial);
  assert.ok(readonly.nodes().filter((node) => node.type === 'input' && node.props.type === 'url').every((node) => node.props.disabled === true));
  initial.capabilities.can_edit = true; initial.measurements[0].evidence_url = 'https://example.test/synthetic?unsafe=1';
  const invalid = harness(initial);
  assert.ok(invalid.nodes(true).some((node) => node.props.role === 'alert' && content(node).includes(text.unsafeEvidence)));
  assert.ok(!invalid.nodes().some((node) => node.type === 'a' && node.props.href === initial.measurements[0].evidence_url));
  assert.equal(invalid.button('치수 저장').props.disabled, true);
});

test('long readonly text and choice measurements remain reachable in a wrapping full-value disclosure', () => {
  for (const kind of ['text', 'choice'] as const) {
    const initial = fixture('completed'); initial.capabilities.can_edit = false;
    const value = 'SYNTHETIC-LONG-READONLY-VALUE-完整观测值';
    initial.inspection_items[0].kind = kind;
    if (kind === 'choice') initial.inspection_items[0].options = [value, 'SYNTHETIC-OTHER'];
    initial.measurements[0].value = value;
    const view = harness(initial);
    const field = view.nodes(true).find((node) => node.type === (kind === 'choice' ? 'select' : 'input') && node.props.value === value)!;
    assert.equal(field.props.disabled, true);
    const fullValue = view.nodes(true).find((node) => node.type === 'details' && node.props.className?.includes('inspection-full-value'))!;
    assert.ok(content(fullValue, true).includes(copy.inspectionCopy.ko.fullValue));
    assert.ok(!fullValue.props.open); openDetails(fullValue);
    assert.ok(content(fullValue, true).includes(value)); assert.equal(view.writes.length, 0);
  }
});

test('compact history preserves real actors and unknown results while raw codes and long reasons stay separately folded', () => {
  const initial = fixture('completed'); const reason = 'SYNTHETIC-LONG-REASON '.repeat(40);
  initial.audit = [
    { id: 1, actor_name: 'SYNTHETIC-AUDIT-ACTOR', action: 'mes-save_reserved', version: 4, status: 'approved', reason, result_digest: '', created_at: '2026-10-06T03:00:00Z' },
    { id: 2, actor_name: 'SYNTHETIC-AUDIT-ACTOR', action: 'mes-finish_unknown', version: 5, status: 'approved', reason: '', result_digest: '', created_at: '2026-10-06T03:01:00Z' },
  ];
  initial.operations = [{ id: 1, scope: '18:42:mes-save', key: 'SYNTHETIC-KEY', status: 'succeeded', response_status: 200,
    created_at: '2026-10-06T03:02:00Z', completed_at: '2026-10-06T03:02:30Z' }];
  for (const lang of ['ko', 'zh'] as const) {
    const view = harness(initial, lang); const text = copy.inspectionCopy[lang];
    assert.ok(!view.text(true).includes(reason)); assert.ok(!view.text(true).includes('HTTP 200'));
    assert.ok(!view.nodes(true).some((node) => node.props.role === 'region' && String(node.props.id).endsWith('-history-content')));
    const history = view.openPanel('history');
    const table = nodes(history).find((node) => node.type === 'table')!;
    const rows = nodes(table).filter((node) => node.type === 'tr' && nodes(node).some((child) => child.type === 'td'));
    assert.equal(rows.length, 3);
    assert.deepEqual(nodes(rows[0]).filter((node) => node.type === 'td').map((node) => content(node).trim()),
      [copy.inspectionTime(initial.operations[0].created_at, lang), '—', copy.inspectionHistoryActionLabel(lang, 'mes-save'), copy.inspectionOperationLabels[lang].succeeded]);
    assert.ok(content(rows[1]).includes('SYNTHETIC-AUDIT-ACTOR'));
    assert.ok(content(rows[1]).includes(copy.inspectionOperationLabels[lang].unknown));
    assert.ok(content(rows[2]).includes(copy.inspectionOperationLabels[lang].pending));
    for (const hidden of ['mes-save', 'mes-finish', 'HTTP 200', reason, 'SYNTHETIC-KEY', initial.assigned_to_name]) assert.ok(!content(history, true).includes(hidden));
    assert.equal(copy.inspectionHistoryResultLabel(lang, 'mes-save', 'approved'), text.historyUnknownResult);
    const diagnostics = view.openPanel('diagnostics');
    for (const fold of nodes(diagnostics).filter((node) => node.type === 'details')) openDetails(fold);
    assert.ok(view.text(true).includes(reason)); assert.ok(view.text(true).includes('HTTP 200'));
    assert.equal(view.writes.length, 0);
  }
});

test('standalone empty work information stays folded without a blank heading or an unrecorded zero quantity', () => {
  const initial = fixture('completed'); initial.work_order_ref = ''; initial.target_quantity = '0';
  const view = harness(initial);
  assert.equal(content(view.nodes(true).find((node) => node.type === 'h2')).trim(), 'SYNTHETIC-QC');
  assert.ok(view.text(true).includes(`${copy.inspectionCopy.ko.requestId} #42`));
  assert.ok(!view.text(true).includes(copy.inspectionCopy.ko.quantity));
  assert.ok(!view.nodes(true).some((node) => node.type === 'p' && content(node).trim() === '·'));
  assert.ok(view.text(true).includes(LABEL));
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
  view.button('치수 저장').props.onClick(); await view.settle();
  assert.equal(view.writes.length, 1);
  assert.ok(view.nodes(true).some((node) => node.props.role === 'alert' && content(node).includes('SYNTHETIC-SAVE-FAILURE')));
  assert.ok(view.text(true).includes(text.dirty));
  assert.ok(view.nodes(true).some((node) => node.type === 'input' && node.props.value === '2.50'));
});
