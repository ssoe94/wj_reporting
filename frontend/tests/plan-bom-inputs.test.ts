import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { materialRequirement } from '../src/domains/production/plan-workflow-form.ts';
import type { PlanBomInputSelection, PlanBomInputsProps, PlanBomSource, PlanBomCatalogMaterial } from '../src/domains/production/components/PlanBomInputs.tsx';

const compiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/components/PlanBomInputs.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const dependencies: Record<string, unknown> = { 'react/jsx-runtime': jsxRuntime, '../plan-workflow-form': { materialRequirement } };
const component: Record<string, any> = {};
new Function('require', 'exports', compiled)((name: string) => {
  assert.ok(name in dependencies, name); return dependencies[name];
}, component);
const { PlanBomInputs, PlanBomPrimaryInput, initialPlanBomInputs, isPlanBomSelectionValid } = component;
const source: PlanBomSource = {
  id: '19000000000000001', version: '1.0', material_id: '19000000000000002', part_no: 'SYNTHETIC-PART', hash: 'synthetic-bom-hash',
  setup: { bom_version: '1.0', process_code: 'ZS10', process_num: '1', route_code: 'SYNTHETIC',
    output_unit_id: '19000000000000003', output_unit_name: 'EA', output_version: '' },
  inputs: [
    { source_row_id: '19000000000000011', seq: '1', material_id: '19000000000000101', material_code: 'RESIN-A', material_name: '원본 수지',
      material_version: '', unit_id: '19000000000000201', unit_name: 'KG', numerator: '0.429', denominator: '1', category_code: 'ANY', category_name: '服务端可替换', replaceable: true },
    { source_row_id: '19000000000000012', seq: '2', material_id: '19000000000000102', material_code: 'INSERT-A', material_name: '철물 A',
      material_version: '', unit_id: '19000000000000202', unit_name: 'EA', numerator: '3', denominator: '1', category_code: 'RAW', category_name: '原料', replaceable: false },
    { source_row_id: '19000000000000013', seq: '3', material_id: '19000000000000103', material_code: 'INSERT-B', material_name: '철물 B',
      material_version: '', unit_id: '19000000000000202', unit_name: 'EA', numerator: '1', denominator: '1', category_code: '', category_name: '', replaceable: false },
  ],
};
const catalog: PlanBomCatalogMaterial[] = [
  { material_code: 'RESIN-B', material_name: '교체 수지', unit_id: '19000000000000201', unit_name: 'KG', selectable: true },
  { material_code: 'UNSELECTABLE', material_name: '사용 불가', unit_id: '19000000000000201', unit_name: 'KG', selectable: false },
  { material_code: 'WRONG-UNIT', material_name: '다른 단위', unit_id: '19000000000000202', unit_name: 'EA', selectable: true },
];
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const props = (overrides: Partial<PlanBomInputsProps> = {}): PlanBomInputsProps => ({
  source, catalog, quantity: '1920', value: initialPlanBomInputs(source), onChange: () => {}, ko: true, ...overrides,
});
const html = (overrides: Partial<PlanBomInputsProps> = {}) => renderToStaticMarkup(createElement(PlanBomInputs, props(overrides)));

test('renders every BOM row, exact quantities and IDs; only server-replaceable material is editable', () => {
  const markup = html();
  assert.equal((markup.match(/data-source-row-id=/g) || []).length, 3);
  source.inputs.forEach(row => assert.ok(markup.includes(`data-source-row-id="${row.source_row_id}"`)));
  assert.equal((markup.match(/<select /g) || []).length, 1);
  assert.ok(!markup.includes('<input') && !markup.includes('<button'));
  assert.ok(markup.includes('필요량 823.68 KG'));
  assert.ok(markup.includes('필요량 5760 EA'));
  assert.ok(markup.includes('필요량 1920 EA'));
  assert.ok(markup.includes('3 EA / 1 EA'));
  assert.ok(markup.includes('value="RESIN-A" selected=""'));
  assert.ok(!markup.includes('UNSELECTABLE') && !markup.includes('WRONG-UNIT'));
  assert.equal(isPlanBomSelectionValid(source, catalog, initialPlanBomInputs(source)), true);
});

test('source option remains selected without catalog; replacement preserves all fixed rows and source ratios', () => {
  assert.ok(html({ catalog: [] }).includes('value="RESIN-A" selected=""'));
  const original = initialPlanBomInputs(source);
  let next: PlanBomInputSelection[] | undefined;
  const tree = PlanBomInputs(props({ value: original, onChange: value => { next = value; } }));
  nodes(tree).find(node => node.type === 'select')!.props.onChange({ target: { value: 'RESIN-B' } });
  assert.deepEqual(next, [{ source_row_id: source.inputs[0].source_row_id, material_code: 'RESIN-B' }, ...original.slice(1)]);
  assert.equal(original[0].material_code, 'RESIN-A');
  assert.equal(isPlanBomSelectionValid(source, catalog, next), true);
  const markup = html({ value: next });
  assert.ok(markup.includes('value="RESIN-B" selected=""'));
  assert.ok(markup.includes('value="RESIN-A"'));
  assert.ok(markup.includes('필요량 823.68 KG') && markup.includes('필요량 5760 EA'));
});

test('rejects omitted, duplicate, extra or tampered fixed rows and unavailable replacement codes', () => {
  const original = initialPlanBomInputs(source);
  for (const value of [original.slice(1), [original[0], original[0], original[2]], [...original, original[0]],
    original.map((row: PlanBomInputSelection, index: number) => index === 1 ? { ...row, material_code: 'RESIN-B' } : row),
    original.map((row: PlanBomInputSelection, index: number) => index === 0 ? { ...row, material_code: 'WRONG-UNIT' } : row)]) {
    assert.equal(isPlanBomSelectionValid(source, catalog, value), false);
    assert.ok(html({ value }).includes('role="alert"'));
  }
  const value = original.map((row: PlanBomInputSelection, index: number) => index === 0 ? { ...row, material_code: 'MISSING' } : row);
  const markup = html({ value });
  assert.ok(markup.includes('value="MISSING" disabled="" selected=""'));
  assert.ok(markup.includes('aria-invalid="true"'));
  assert.ok(!markup.includes('value="RESIN-A" selected=""'));
});

test('disabled or structurally stale form and invalid selection events cannot mutate values', () => {
  let changes = 0;
  for (const overrides of [{ disabled: true }, { value: initialPlanBomInputs(source).slice(1) }]) {
    const tree = PlanBomInputs(props({ ...overrides, onChange: () => { changes += 1; } }));
    const select = nodes(tree).find(node => node.type === 'select')!;
    assert.equal(select.props.disabled, true);
    select.props.onChange({ target: { value: 'RESIN-B' } });
  }
  const tree = PlanBomInputs(props({ onChange: () => { changes += 1; } }));
  const select = nodes(tree).find(node => node.type === 'select')!;
  for (const code of ['WRONG-UNIT', 'UNSELECTABLE', 'INVENTED']) select.props.onChange({ target: { value: code } });
  assert.equal(changes, 0);
});

test('unavailable source has no manual fallback and invalid quantities are not rounded or shown as zero', () => {
  const absent = html({ source: null });
  assert.ok(absent.includes('role="alert"'));
  assert.ok(!absent.includes('<select') && !absent.includes('<input'));
  assert.equal(isPlanBomSelectionValid(null, catalog, []), false);
  const repeating = { ...source, inputs: [{ ...source.inputs[0], numerator: '1', denominator: '3' }] };
  const markup = html({ source: repeating, value: initialPlanBomInputs(repeating), quantity: '1', ko: false });
  assert.ok(markup.includes('需求量 待核对'));
  assert.ok(!markup.includes('0.333'));
  assert.ok(html({ quantity: '0' }).includes('필요량 확인 필요'));
});

test('primary cell uses the first replaceable row; body retains its ratio and requirement without a duplicate editor or name', () => {
  const reordered = { ...source, inputs: [source.inputs[1], source.inputs[0], source.inputs[2]] };
  const inputProps = props({ source: reordered, value: initialPlanBomInputs(reordered), hidePrimary: true });
  const cell = renderToStaticMarkup(createElement(PlanBomPrimaryInput, inputProps));
  const body = renderToStaticMarkup(createElement(PlanBomInputs, inputProps));
  assert.equal((cell.match(/<select /g) || []).length, 1);
  assert.ok(cell.includes('사용 원료 2. RESIN-A'));
  assert.ok(!cell.includes('필요량'));
  assert.ok(body.includes('plan-workflow__bom-inputs') && !body.includes('plan-workflow__editor'));
  assert.equal((body.match(/data-source-row-id=/g) || []).length, 3);
  assert.ok(!body.includes('<select') && !body.includes('RESIN-A'));
  assert.ok(body.includes('원료 배합') && body.includes('0.429 KG / 1 EA') && body.includes('필요량 823.68 KG'));
  assert.ok(body.includes('필요량 5760 EA') && body.includes('필요량 1920 EA'));
  let changed: PlanBomInputSelection[] | undefined;
  const tree = PlanBomPrimaryInput({ ...inputProps, onChange: (value: PlanBomInputSelection[]) => { changed = value; } });
  nodes(tree).find(node => node.type === 'select')!.props.onChange({ target: { value: 'RESIN-B' } });
  assert.deepEqual(changed, [inputProps.value[0], { ...inputProps.value[1], material_code: 'RESIN-B' }, inputProps.value[2]]);
});

test('fixed materials render each name once, including when the name is the code; no raw material is inferred', () => {
  const fixed = { ...source, inputs: source.inputs.slice(1).map(row => ({ ...row, material_name: row.material_code })) };
  const inputProps = props({ source: fixed, value: initialPlanBomInputs(fixed), hidePrimary: true });
  const body = renderToStaticMarkup(createElement(PlanBomInputs, inputProps));
  for (const row of fixed.inputs) assert.equal((body.match(new RegExp(row.material_code, 'g')) || []).length, 1);
  assert.ok(!body.includes('<select'));
  const cell = renderToStaticMarkup(createElement(PlanBomPrimaryInput, inputProps));
  assert.ok(cell.includes('고정 자재만 사용') && !cell.includes('<select'));
  const absent = renderToStaticMarkup(createElement(PlanBomPrimaryInput, props({ source: null })));
  assert.ok(absent.includes('BOM 확인 필요') && !absent.includes('<select'));
});
