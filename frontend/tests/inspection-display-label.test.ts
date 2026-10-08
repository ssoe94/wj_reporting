import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectionDisplayLabel } from '../src/pages/quality/inspection-requests/displayLabel.ts';
test('explicit bilingual shift and item labels display in the active language without mutating the record', () => {
  assert.equal(inspectionDisplayLabel('주간 / 白班', 'zh'), '白班');
  assert.equal(inspectionDisplayLabel('치수 1 / 尺寸 1', 'zh'), '尺寸 1');
  assert.equal(inspectionDisplayLabel('치수 1 / 尺寸 1', 'ko'), '치수 1');
  assert.equal(inspectionDisplayLabel('外观 / 외관', 'zh'), '外观');
});
test('opaque account names, custom labels, part references and multi-part descriptions stay intact', () => {
  for (const value of ['QC001', '이검사자', '모델 A / B', '项目 A / B', 'LABEL / CODE / OTHER', '주간 白班', 'A/B']) {
    assert.equal(inspectionDisplayLabel(value, 'zh'), value);
    assert.equal(inspectionDisplayLabel(value, 'ko'), value);
  }
});
