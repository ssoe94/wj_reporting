import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectionMeasurementJudgement as verdict, inspectionMeasurementPatch as patch, inspectionChoiceLabel } from '../src/pages/quality/inspection-requests/measurementJudgement.ts';
import type { InspectionItem } from '../src/pages/quality/inspection-requests/model.ts';
const item: InspectionItem = { id: 'size', label: 'SYNTHETIC dimension', kind: 'number', unit: 'mm', required: true, evidence_required: false, minimum: '9.5', maximum: '10.5' };
test('numeric dimension includes both bounds and returns exact nearest-bound differences', () => {
  for (const value of ['9.5', '10', '10.5', '1.05e1']) assert.equal(verdict(item, 'dimension', value).judgement, 'pass');
  assert.deepEqual(verdict(item, 'dimension', '9.3'), { automatic: true, state: 'fail', judgement: 'fail', side: 'below', difference: '0.2', exactDifference: '0.2', approximate: false });
  assert.equal(verdict(item, 'dimension', '10.6').difference, '0.1');
  assert.equal(verdict(item, 'dimension', '10.50000000000000001').judgement, 'fail');
  assert.equal(verdict(item, 'dimension', '10.50000000000000001').difference, '1e-17');
  assert.equal(verdict({ ...item, minimum: '-1.2', maximum: '-0.5' }, 'dimension', '-1.3').difference, '0.1');
});
test('empty, malformed and unfinished values clear prior automatic pass and never fabricate a verdict', () => {
  for (const value of ['', ' ', '-', '.', 'NaN', 'Infinity', '0x10', '1e', '1e13']) {
    assert.equal(patch(item, 'dimension', { value }).judgement, '');
  }
  assert.equal(verdict({ ...item, minimum: '11', maximum: '9' }, 'dimension', '10').state, 'unconfigured');
  assert.equal(verdict({ ...item, minimum: 'bad' }, 'dimension', '10').state, 'unconfigured');
});
test('one-sided specifications remain inclusive and do not invent the missing limit', () => {
  const { minimum, ...upperOnly } = item; void minimum;
  assert.equal(verdict(upperOnly, 'dimension', '-100').judgement, 'pass');
  assert.equal(verdict(upperOnly, 'dimension', '10.6').side, 'above');
  const { maximum, ...lowerOnly } = item; void maximum;
  assert.equal(verdict(lowerOnly, 'dimension', '100').judgement, 'pass');
  assert.equal(verdict(lowerOnly, 'dimension', '9.3').side, 'below');
});
test('appearance and deformation pass/fail choices update their verdict from a single selection', () => {
  assert.deepEqual(patch(item, 'appearance', { value: '10.6' }), { value: '10.6' });
  const choice = { ...item, kind: 'choice' as const, options: ['合格', '不合格'] };
  assert.equal(verdict(choice, 'dimension', '合格').judgement, 'pass');
  assert.equal(verdict(choice, 'dimension', '不合格').judgement, 'fail');
  assert.deepEqual(patch(choice, 'appearance', { value: '不合格' }), { value: '不合格', judgement: 'fail' });
  assert.deepEqual(patch(choice, 'appearance', { value: '' }), { value: '', judgement: '' });
  assert.equal(inspectionChoiceLabel('合格', 'ko'), '합격');
  assert.equal(inspectionChoiceLabel('불합격', 'zh'), '不合格');
  assert.equal(inspectionChoiceLabel('MES-CUSTOM', 'ko'), 'MES-CUSTOM');
  assert.equal(verdict({ ...choice, options: ['A', 'B'] }, 'dimension', 'A').automatic, false);
  assert.deepEqual(patch(item, 'dimension', { evidence_url: 'https://example.invalid/proof' }), { evidence_url: 'https://example.invalid/proof' });
});
