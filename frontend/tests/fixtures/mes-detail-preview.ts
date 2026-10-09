import type { MesDetailPreviewData } from '../../src/pages/quality/inspection-requests/mesDetailPreviewModel.ts';

// Configuration-only synthetic metadata; no live request or measurement values.
export function previewFixture(): MesDetailPreviewData {
  const absent = () => ({ code: null, message: null });
  return {
    qc_id: '1791013139392836', qc_code: 'QC-26100300323', read_only: true,
    observed_at: '2026-10-06T10:00:00Z', get_able: 1, status: { code: 0, message: 'SYNTHETIC' },
    get_status: { code: 0, message: 'SYNTHETIC' }, executor_id: null, executor_present: false, executor_matches_lee: null,
    snapshot_id: '90001', items: Array.from({ length: 16 }, (_, i) => ({
      id: String(91000 + i), check_item_id: String(92000 + i), version_id: '93001',
      group_name: 'SYNTHETIC group', code: `SYNTHETIC-${i}`, serial_no: i + 1,
      execute_item_type: absent(), name: `SYNTHETIC specification ${i + 1}`,
      unit: { id: '94001', code: 'mm', name: 'SYNTHETIC unit' },
      minimum: '1.00', maximum: '2.00', base: '1.50', scale: 2,
      logic: absent(), value_type: absent(), required_type: absent(), options: ['SYNTHETIC-A', 'SYNTHETIC-B'], missing_fields: [],
    })), item_count: 16, expected_item_count: 16, item_count_matches_expected: true,
    approval: null, inventory_metadata: { qcRange: absent(), materialBatchRecordType: absent(),
      sampleProcessMethod: absent(), recordSample: absent(), recordSummaryCount: absent(),
      check_material_count: null, sample_material_count: null },
    missing_fields: ['executor_id', 'approval'],
  };
}
