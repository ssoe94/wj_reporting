import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessFieldMonitoring, isFieldMonitoringRoute } from '../src/domains/auth/field-monitoring-access.ts';
import { exceptionRecordFilters, fieldStationBinding, recordParams } from '../src/domains/field-monitoring/model.ts';

test('field monitoring navigation requires the dedicated permission or superuser status', () => {
  assert.equal(canAccessFieldMonitoring({ is_superuser: true }), true);
  assert.equal(canAccessFieldMonitoring({ can_access_field_monitoring: true }), true);
  assert.equal(canAccessFieldMonitoring({ is_superuser: true, is_active: false }), false);
  assert.equal(canAccessFieldMonitoring({ can_access_field_monitoring: false }), false);
  assert.equal(canAccessFieldMonitoring(null), false);
  assert.equal(isFieldMonitoringRoute('/injection/field-monitoring/?tab=records'), true);
  assert.equal(isFieldMonitoringRoute('/injection/%66ield-monitoring'), true);
  assert.equal(isFieldMonitoringRoute('/injection/dashboard'), false);
});

test('station production binding retains older injection selections and clears unrelated targets', () => {
  const blank = { production_process: null, injection_machine_number: null, assembly_line: null };
  assert.deepEqual(fieldStationBinding({}), blank);
  assert.deepEqual(fieldStationBinding({ production_process: null, injection_machine_number: 10 }), blank);
  assert.deepEqual(fieldStationBinding({ injection_machine_number: 10 }), {
    ...blank, production_process: 'injection', injection_machine_number: 10,
  });
  assert.deepEqual(fieldStationBinding({ production_process: 'injection', assembly_line: 'B' }), {
    ...blank, production_process: 'injection',
  });
  assert.deepEqual(fieldStationBinding({ production_process: 'assembly', assembly_line: 'C', injection_machine_number: 11 }), {
    ...blank, production_process: 'assembly', assembly_line: 'C',
  });
});

test('exception navigation pins the selected PC and preserves cross-day evidence without copying cursor controls', () => {
  const filters = exceptionRecordFilters('2026-11-16', 'SYNTH-WS', {
    reason: 'print_submitted',
    job_id: 'CASE-0042',
    cycle_id: 'SYNTH-CYCLE',
    station: 'OTHER',
    from: '2026-11-15',
    to: '2026-11-17',
    page_size: '500',
    cursor: 'old-page',
  });
  assert.deepEqual(recordParams(filters), {
    from: '2026-11-15',
    to: '2026-11-17',
    station: 'SYNTH-WS',
    reason: 'print_submitted',
    job_id: 'CASE-0042',
    cycle_id: 'SYNTH-CYCLE',
  });
  assert.deepEqual(exceptionRecordFilters('2026-11-16', 'SYNTH-WS', {}), {
    from: '2026-11-16', to: '2026-11-16', station: 'SYNTH-WS',
  });
});

test('record and export filters preserve exact values and omit empty controls', () => {
  assert.deepEqual(recordParams({
    from: '2026-11-15', to: '2026-11-16', station: '', barcode: '00001234', mode: 'test',
  }), {
    from: '2026-11-15', to: '2026-11-16', mode: 'test', barcode: '00001234',
  });
});

test('record and export queries include historical archive only when selected', () => {
  const range = { from: '2025-09-01', to: '2025-09-30', station: 'SYNTH-WS' };
  assert.deepEqual(recordParams({ ...range, archive: '' }), range);
  assert.deepEqual(recordParams({ ...range, archive: 'true' }), { ...range, archive: 'true' });
});

test('record and export queries keep the selected scanner lane in the live and archive search', () => {
  const range = { from: '2025-09-01', to: '2025-09-30', station: 'SYNTH-WS' };
  assert.deepEqual(recordParams({ ...range, lane: '' }), range);
  assert.deepEqual(recordParams({ ...range, lane: 'B' }), { ...range, lane: 'B' });
  assert.deepEqual(
    recordParams({ ...range, lane: 'W', archive: 'true' }),
    { ...range, lane: 'W', archive: 'true' },
  );
});

test('explicit cross-PC issuance evidence keeps both stations in the records and CSV query', () => {
  const reserved = exceptionRecordFilters('2026-11-17', 'SYNTH-WS', {
    station: '', part_no: 'SYNTH-PART', type: 'label.reserved', issuer_namespace: 'TST',
    label_print_date: '2026-11-17', from: '2026-11-16', to: '2026-11-17',
  });
  assert.deepEqual(recordParams(reserved), {
    from: '2026-11-16', to: '2026-11-17', part_no: 'SYNTH-PART', type: 'label.reserved',
    issuer_namespace: 'TST', label_print_date: '2026-11-17',
  });
  const reads = exceptionRecordFilters('2026-11-17', 'SYNTH-WS', {
    station: '', barcode: '0000123400', issuance_scan: 'true',
  });
  assert.deepEqual(recordParams(reads), {
    from: '2026-11-17', to: '2026-11-17', barcode: '0000123400', issuance_scan: 'true',
  });
});
