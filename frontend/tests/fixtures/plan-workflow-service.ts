import type { WorkflowData } from '../../src/domains/production/plan-workflow-api.ts';

export const SERVICE_SCOPE = { start: '2026-10-10', end: '2026-10-10', plan_type: 'injection' as const };
export const serviceUid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
/** Public synthetic plans only. No provider, auth, credentials or network. */
export function serviceWorkflowFixture(states = ['disabled', 'disabled']): WorkflowData {
  const material = { key: 'synthetic-material', material_id: '12345678901234567', material_code: 'SYN-ABS',
    material_name: 'SYNTHETIC ABS', material_version: 'A', unit_id: '12345678901234568', unit_name: 'kg', selectable: true };
  const snapshot = { inputs: [{ ...material, numerator: '0.02', denominator: '1', required_quantity: '20' }],
    bom_version: 'A', mold_code: 'SYN-MOLD', resource_code: 'SYN-INJ-01', process_code: 'SYN-INJ', process_num: '1',
    route_code: 'SYN-ROUTE', output_unit_name: '个', output_unit_id: '12345678901234569', output_version: 'A' };
  const rows = states.map((_, index) => ({ id: index + 1, uid: serviceUid(index + 101), version: 1, plan_date: SERVICE_SCOPE.start,
    machine_name: `SYN-${String(index + 1).padStart(2, '0')}`, part_no: `SYN-PART-${index + 1}`, planned_quantity: '1000',
    default_version: 0, identity_state: 'identified', candidates: [], candidate_details: [], quantity_valid: true,
    approval: { id: index + 1, snapshot, approved_at: '2026-10-10T07:00:00+08:00', actor_name: 'SYNTHETIC QA' },
    previous_approval: null, recommendation: null }));
  return { write_enabled: true, can_edit: true, can_manage_defaults: true, rows,
    catalog: { dataset_id: 1, refreshed_at: '2026-10-10T07:00:00+08:00', materials: [material] },
    preview: rows.map((row, index) => ({ key: `synthetic-${index + 1}`, machine_name: row.machine_name, part_no: row.part_no,
      quantity: '1000', planned_start: '2026-10-10T08:00:00+08:00', planned_end: '2026-10-11T08:00:00+08:00',
      operation: 'prepare', blockers: [], work_order_code: `SYNTHETIC-WJ-${index + 1}`, members: [row.uid],
      mes_id: ['created', 'already_exists'].includes(states[index]) ? `123456789012345${String(index).padStart(2, '0')}` : null,
      reported_quantity: null, inbound_quantity: null })),
    requests: states.map((state, index) => ({ uid: serviceUid(index + 1), work_order_code: `SYNTHETIC-WJ-${index + 1}`,
      operation: 'create', state, blockers: [], attempt: ['disabled', 'prepared'].includes(state) ? 0 : 1,
      mes_id: ['created', 'already_exists'].includes(state) ? `123456789012345${String(index).padStart(2, '0')}` : null,
      last_result: { outcome: state, verified_scope: 'base_creation' }, can_send: ['disabled', 'prepared'].includes(state),
      can_recheck: ['sending', 'uncertain', 'readback_pending', 'review', 'failed'].includes(state) })) };
}

/** Fresh read-only BOM response, intentionally separate from the historical approval. */
export function serviceBomFixture(planId = 1) {
  return {
    id: `SYN-BOM-${planId}`, part_no: `SYN-PART-${planId}`, version: 'A', material_id: `SYN-PRODUCT-${planId}`, hash: `SYN-HASH-${planId}-A`,
    setup: { bom_version: 'A', process_code: 'SYN-INJ', process_num: '1', route_code: 'SYN-ROUTE',
      output_unit_name: '个', output_unit_id: '12345678901234569', output_version: '' },
    inputs: [{ source_row_id: `SYN-ROW-${planId}-RAW`, seq: '1', material_id: '12345678901234567', material_code: 'SYN-ABS',
      material_name: 'SYNTHETIC ABS', material_version: '', unit_id: '12345678901234568', unit_name: 'kg',
      numerator: '0.02', denominator: '1', category_code: 'CAT-011', category_name: 'Raw material', replaceable: true }],
  };
}
