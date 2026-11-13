import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { workbookPreviewBlocker } from '../src/domains/hr/workbook-preview.ts';
import type { HrEmploymentType, HrRosterEntry, HrWorkbookBatch } from '../src/domains/hr/workbook-types.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/hr/HrWorkbookImportPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('')
  : value?.props ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const originalMonths: [string, HrEmploymentType][] = [
  ['2026-06', 'hourly'], ['2026-07', 'hourly'], ['2026-08', 'hourly'], ['2026-09', 'hourly'], ['2026-10', 'contract'],
];
const originalRoster: HrRosterEntry = {
  id: 1, name: 'Synthetic Person', code: '00090001', employment_type: 'hourly', department: 'Synthetic A',
  first_month: '2026-06', last_month: '2026-09', status: 'active', version: 7, previous_codes: [], in_month: true,
};

async function panel({ lang = 'ko', months = originalMonths, roster = [originalRoster] }: {
  lang?: 'ko' | 'zh'; months?: [string, HrEmploymentType][]; roster?: HrRosterEntry[];
} = {}) {
  const state: any[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  const requests: HrWorkbookBatch[] = [];
  const nextSteps: { step: 'roster' | 'assign'; month: string }[] = [];
  const reference = { filename: 'synthetic-reference.xlsx', rows: [] };
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (next: any) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        if (!(index in state)) state[index] = { current: initial };
        return state[index];
      },
      useEffect(effect: () => void, dependencies: unknown[]) {
        const index = cursor++;
        if (!state[index] || dependencies.some((value, i) => !Object.is(value, state[index][i]))) effects.push(effect);
        state[index] = dependencies;
      },
      useMemo: (callback: () => unknown) => callback(),
      useCallback: (callback: unknown) => callback,
      useId: () => 'validation-hint',
    },
    'react-router-dom': { Link: 'a' },
    'lucide-react': Object.fromEntries(['CheckCircle2', 'FileSpreadsheet', 'RefreshCw', 'RotateCcw', 'Upload', 'X'].map((name) => [name, name])),
    '../../i18n': { useLang: () => ({ lang }) },
    '../../domains/hr/api': {
      getHrClassificationReference: async () => ({ reference, version: 3, updated_at: null }),
      previewHrWorkbookBatch: async (payload: HrWorkbookBatch) => {
        requests.push(payload);
        return { classification: reference, months: payload.months.map(({ month }) => ({
          month, version: 1, total: '10.00', fingerprint: 'synthetic', rows: [],
        })), preview_token: 'synthetic' };
      },
      importHrWorkbookBatch: async (payload: HrWorkbookBatch) => ({ workspaces: payload.months }),
    },
    '../../domains/hr/import': { readWorkbook: async (file: { name: string }) => ({ filename: file.name, sheets: [{ name: 'payroll', rows: [] }] }) },
    '../../domains/hr/flow': { hrFlowHref: () => '' },
    '../../domains/hr/workbook-preview': { workbookPreviewBlocker },
    '../../domains/hr/workbook-import': {
      parseCompanyPayroll: (inputs: { id: string; book: { filename: string }; employment_type: HrEmploymentType }[]) => ({
        files: inputs.map((input) => ({ id: input.id, filename: input.book.filename, employment_type: input.employment_type })),
        months: months.map(([month, employment_type], index) => ({ month, rows: [{
          period: month, code: '90001', name: 'SyntheticPerson', employment_type, amount: '10.00', title: '',
          source_department: `Synthetic ${employment_type}`, source_file: inputs.find((input) => input.employment_type === employment_type)!.id,
          source_sheet: 'payroll', source_row: index + 2, original_code: '90001',
        }] })),
        issues: [], warnings: [], codeReviews: [{
          key: 'opaque-transition-review', name: 'SyntheticPerson', employment_type: months.at(-1)![1],
          codes: [{ code: '90001', months: months.map(([month]) => month) }],
          employment_types: (['hourly', 'contract'] as const).map((employment_type) => ({
            employment_type, months: months.filter(([, type]) => type === employment_type).map(([month]) => month),
          })),
        }],
      }),
    },
    '../../domains/hr/labels': { hrAssignmentPath: () => '' },
    './hrCommon': { isHrConflict: () => false, compactMoney: String },
    './HrFileDrop': { default: 'HrFileDrop' },
    './hr-workbook-import.css': {},
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, exports);
  const props = {
    roster, workspace: { month: '2026-10', company_structure: { classification: { nodes: [] } } },
    disabled: false, onImported() {}, onBusyChange() {}, onConflict() {},
    onNextStep(step: 'roster' | 'assign', month: string) { nextSteps.push({ step, month }); },
  };
  const render = () => {
    cursor = 0;
    const result = nodes(exports.default(props));
    effects.splice(0).forEach((effect) => effect());
    return result;
  };
  render();
  await setImmediate();
  render().find((node) => node.type === 'button' && 'aria-expanded' in node.props)!.props.onClick();
  render().find((node) => node.type === 'HrFileDrop' && node.props.id === 'payroll')!.props.onFiles([
    { name: 'synthetic-小时工.xlsx', size: 100 }, { name: 'synthetic-合同工.xlsx', size: 100 },
  ]);
  await setImmediate();
  const previewButton = () => render().find((node) => node.type === 'button' && node.props.className?.includes('hr-workbook-validate'))!;
  const review = () => render().find((node) => node.props.className === 'hr-compact-toolbar');
  return {
    render, requests, review, previewButton, nextSteps,
    confirm: (reason = '  Synthetic transition  ') => {
      nodes(review()).find((node) => node.type === 'select')!.props.onChange({ target: { value: '90001' } });
      nodes(review()).find((node) => node.type === 'input' && node.props.maxLength === 500)!.props.onChange({ target: { value: reason } });
    },
    selectMonth: (month: string, checked: boolean) => {
      const label = render().find((node) => node.type === 'label' && node.props.className === 'hr-checkbox' && text(node) === month)!;
      nodes(label).find((node) => node.type === 'input')!.props.onChange({ target: { checked } });
    },
    preview: async () => { previewButton().props.onClick(); await setImmediate(); },
    save: async () => {
      render().find((node) => node.type === 'button' && /선택 \d+개월 저장/.test(text(node)))!.props.onClick();
      await setImmediate();
    },
  };
}

test('deferring an employment transition allows payroll preview without a roster decision', async () => {
  const form = await panel();
  assert.equal(form.previewButton().props.disabled, false);
  await form.preview();
  assert.equal(form.requests.length, 1);
  assert.deepEqual(form.requests[0].roster_decisions, []);
  assert.equal(form.requests[0].months.length, 5);
});

test('one-code transition confirmation uses normalized name/code and the existing roster version', async () => {
  const form = await panel();
  form.confirm();
  assert.equal(form.previewButton().props.disabled, false);
  await form.preview();
  assert.deepEqual(form.requests[0].roster_decisions, [{
    name: 'SyntheticPerson', employment_type: 'contract', code: '90001', reason: 'Synthetic transition', version: 7,
  }]);
});

test('saved workbook recommends the roster for a deferred review and assignment for a confirmed review', async () => {
  const deferred = await panel();
  await deferred.preview();
  await deferred.save();
  assert.deepEqual(deferred.nextSteps, [{ step: 'roster', month: '2026-10' }]);

  const confirmed = await panel();
  confirmed.confirm();
  await confirmed.preview();
  await confirmed.save();
  assert.deepEqual(confirmed.nextSteps, [{ step: 'assign', month: '2026-10' }]);
});

test('a historical code also resolves the current employee version for transition confirmation', async () => {
  const form = await panel({ roster: [{ ...originalRoster, code: '90002', previous_codes: ['00090001'] }] });
  form.confirm();
  await form.preview();
  assert.equal(form.requests[0].roster_decisions![0].version, 7);
});

test('transition confirmation requires a nonblank reason and can be returned to deferral', async () => {
  const form = await panel();
  form.confirm('   ');
  assert.equal(form.previewButton().props.disabled, true);
  await form.preview();
  assert.equal(form.requests.length, 0);
  nodes(form.review()).find((node) => node.type === 'select')!.props.onChange({ target: { value: '' } });
  assert.equal(form.previewButton().props.disabled, false);
  await form.preview();
  assert.deepEqual(form.requests[0].roster_decisions, []);
});

test('month changes clear confirmation and the new confirmation uses the latest selected type', async () => {
  const form = await panel({ roster: [], months: [['2026-06', 'hourly'], ['2026-09', 'contract'], ['2026-10', 'hourly']] });
  form.confirm();
  await form.preview();
  assert.equal(form.requests[0].roster_decisions![0].employment_type, 'hourly');
  form.selectMonth('2026-10', false);
  assert.equal(nodes(form.review()).find((node) => node.type === 'select')!.props.value, '');
  await form.preview();
  assert.deepEqual(form.requests[1].roster_decisions, []);
  form.confirm();
  await form.preview();
  assert.deepEqual(form.requests[2].months.map(({ month }) => month), ['2026-06', '2026-09']);
  assert.equal(form.requests[2].roster_decisions![0].employment_type, 'contract');
  assert.equal(form.requests[2].roster_decisions![0].version, 0);
});

test('selecting only the unchanged employment period hides the transition review', async () => {
  const form = await panel();
  form.confirm();
  form.selectMonth('2026-10', false);
  assert.equal(form.review(), undefined);
  assert.equal(form.previewButton().props.disabled, false);
  await form.preview();
  assert.deepEqual(form.requests[0].roster_decisions, []);
});

test('transition review labels display employment-specific months in Korean and Chinese', async () => {
  for (const lang of ['ko', 'zh'] as const) {
    const form = await panel({ lang });
    const label = text(form.review());
    assert.ok(label.includes(lang === 'ko' ? '고용형태 변경' : '用工类型变更'));
    assert.ok(label.includes(`${lang === 'ko' ? '시급직' : '小时工'}: 2026-06, 2026-07, 2026-08, 2026-09`));
    assert.ok(label.includes(`${lang === 'ko' ? '계약직' : '合同工'}: 2026-10`));
    assert.ok(label.includes(lang === 'ko' ? '확인 보류' : '暂不确认'));
  }
});
