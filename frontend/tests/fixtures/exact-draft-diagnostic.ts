import { EXACT_DRAFT_CODE, EXACT_DRAFT_START, EXACT_DRAFT_END } from '../../src/domains/production/exact-draft-diagnostic.ts';
export const DIAGNOSTIC_CLOCK = Date.parse('2026-10-09T13:00:00Z');
export const DIAGNOSTIC_UID = '00000000-0000-4000-8000-000000000018';
export function diagnosticRaw(patch: Record<string, unknown> = {}) {
  return { code: EXACT_DRAFT_CODE, scope: { material_code: '0', quantity: '1', unit_name: '个', status: 0,
    planned_start: EXACT_DRAFT_START, planned_end: EXACT_DRAFT_END,
    resource_assigned: false, inputs_assigned: false, processes_assigned: false },
    state: 'prepared', request_uid: DIAGNOSTIC_UID, attempt: 0,
    approval: { reference: 'SYNTHETIC-EXACT-APPROVAL', approved_at: new Date(DIAGNOSTIC_CLOCK).toISOString(),
      expires_at: new Date(DIAGNOSTIC_CLOCK + 1800000).toISOString(), active: true, expired: false,
      max_attempts: 1, app_max_attempts: 1, app_attempt: 0 },
    app_supply: { available: true, usable_for_seconds: 1800, supply_mode: 'server' },
    connection: { status: 'ready', reason: null }, can_prepare: false, can_send: true,
    can_recheck: false, can_reconnect: true, blockers: [], ordinary_writer_enabled: false, ...patch };
}
