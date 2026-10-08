import assert from 'node:assert/strict';
import test from 'node:test';
import { mesReadEnum, mesReadRecordValue, mesReadSpecification } from '../src/pages/quality/inspection-requests/mesReadObservation.ts';
import type { MesReadItem, MesReadItemSource } from '../src/pages/quality/inspection-requests/mesReadObservation.ts';

const source: MesReadItemSource = {
  config_row_id: '10000000000000001', master_check_item_id: '10000000000000002', config_version_id: '10000000000000003',
  serial_no: 5, outer_group_name: 'SYNTHETIC', nested_group_name: null,
  unit: { id: null, code: null, name: 'mm' }, minimum: '19.1000000000', maximum: '21.9000000000', base: null,
  logic: { code: 1, message: '区间' }, scale: 2, execute_item_type: { code: 1, message: '数值' },
  value_type: { code: 2, message: '数值区间' }, required_type: { code: 1, message: '必填' }, options: [],
  check_count: '1.0000000000', task_check_count: '1.0000000000', total_report_count: 1, required_report_count: null, filled_report_count: 1,
};
const item: MesReadItem = { ordinal: 0, label: 'SYNTHETIC weight', unit: 'mm', minimum: '19.1', maximum: '21.9',
  required: true, recorded_value: null, write_mapping_verified: false, source };

test('specification prefers exact source strings without number conversion or record substitution', () => {
  const before = JSON.stringify(item);
  assert.deepEqual(mesReadSpecification(item), { range: '19.1000000000 ~ 21.9000000000 mm', condition: null, options: null });
  assert.equal(JSON.stringify(item), before);
});

test('comparator base remains separate from absent range and does not create min or max', () => {
  const field = { ...item, source: { ...source, minimum: null, maximum: null, base: '7.0000000000', logic: { code: 5, message: '<=' } } };
  assert.deepEqual(mesReadSpecification(field), { range: null, condition: '<= 7.0000000000 mm', options: null });
});

test('unknown source bounds never fall back to stale canonical display fields', () => {
  const field = { ...item, source: { ...source, minimum: null, maximum: null } };
  assert.equal(mesReadSpecification(field).range, null);
  assert.equal(mesReadSpecification({ ...field, source: { ...field.source, minimum: '0.0000000000' } }).range, '0.0000000000 ~ — mm');
});

test('choice options remain source text and do not become judgement or observed values', () => {
  const field = { ...item, source: { ...source, minimum: null, maximum: null, options: ['合格', '不合格'] } };
  assert.deepEqual(mesReadSpecification(field), { range: null, condition: null, options: '合格 · 不合格' });
  assert.equal(field.recorded_value, null);
});

test('legacy observation range still preserves provided precision', () => {
  assert.equal(mesReadSpecification({ ...item, source: undefined, minimum: '9.500', maximum: '10.500' }).range, '9.500 ~ 10.500 mm');
});

test('null, empty and literal zero records have distinct readable representations in both languages', () => {
  for (const lang of ['ko', 'zh'] as const) {
    assert.notEqual(mesReadRecordValue(null, lang), mesReadRecordValue('', lang));
    assert.equal(mesReadRecordValue('0', lang), '0');
    assert.equal(mesReadRecordValue('20.0000000000', lang), '20.0000000000');
  }
});

test('enum display preserves zero and unknown rather than inferring business status', () => {
  assert.equal(mesReadEnum({ code: 0, message: '未开始' }), '0 · 未开始');
  assert.equal(mesReadEnum({ code: null, message: null }), '—');
  assert.equal(mesReadEnum({ code: 99, message: null }), '99');
});
