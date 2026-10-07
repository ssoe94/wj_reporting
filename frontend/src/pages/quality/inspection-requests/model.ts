export type InspectionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'failed';
export type InspectionDataMode = 'wj_local_beta' | 'synthetic_preview';
export type InspectionJudgement = '' | 'pass' | 'fail';
export type InspectionItem = { id: string; label: string; kind: 'text' | 'number' | 'choice'; options?: string[]; unit: string; required: boolean; evidence_required: boolean; minimum?: string; maximum?: string };
export type InspectionMeasurement = { item_id: string; value: string; judgement: InspectionJudgement; evidence_url?: string };
export type InspectionEvidence = { label: string; url: string };
export type InspectionDraft = {
  measurements: InspectionMeasurement[]; evidence: InspectionEvidence[];
  inspected_quantity: string; accepted_quantity: string; rejected_quantity: string;
  judgement: InspectionJudgement; notes: string;
};
export type InspectionType = 'first' | 'process' | 'final' | 'general';
export type InspectionCreate = {
  work_order_ref: string; task_ref: string; part_no: string; equipment_ref: string;
  inspection_type: InspectionType; target_quantity: string; uom: string;
  warehouse_ref: string; lot_ref: string; work_started_at: string; inspection_items: InspectionItem[];
  require_evidence: boolean; quantity_mode: 'recorded' | 'not_recorded';
  judgement_policy: 'strict_items' | 'independent';
};
export type InspectionRecordCapabilities = {
  can_edit: boolean; can_submit: boolean; can_review: boolean; can_reinspect: boolean;
  can_sync: boolean; can_refresh: boolean; can_review_failure?: boolean;
};
export type InspectionMesWorkflow = {
  phase: 'unbound' | 'ready' | 'save_pending' | 'save_unknown' | 'saved' | 'finish_pending' | 'finish_unknown' | 'completed' | 'blocked';
  enabled: boolean; test_only?: boolean; qc_code?: string | null; test_label: string | null; last_verified_at: string | null;
  can_save: boolean; can_finish: boolean; can_reconcile: boolean;
};
export type InspectionMesTrialObservation = {
  verdict: 'pass' | 'fail' | null;
  observed_at: string | null;
};
export type InspectionRequest = InspectionCreate & InspectionDraft & {
  id: number; source_kind: string; parent: number | null; assigned_to: number | null; assigned_to_name: string;
  status: InspectionStatus; version: number; submitted_by: number | null; submitted_at: string | null;
  reviewed_by: number | null; reviewed_at: string | null; review_reason: string;
  sync_status: string; mes_completion_status: string; injection_receipt_readiness: 'not_verified' | 'ready' | 'blocked'; mes_checked_at: string | null; external_result_id: string;
  mes_state: { task_status: number | null; qc_status: number | null; state_version: string | null; receipt_allowed: boolean | null }; last_error_code: string; created_at: string; updated_at: string;
  audit: { id: number; actor_name: string; action: string; version: number; status: string; reason: string; result_digest: string; created_at: string }[];
  operations: { id: number; scope: string; key: string; status: string; response_status: number | null; created_at: string; completed_at: string | null }[];
  mes_workflow?: InspectionMesWorkflow;
  mes_trial_observation?: InspectionMesTrialObservation | null;
  nonconformance?: { state: string; quantity: string | null; uom: string; owner_name: string; mes_status: string; can_execute: false } | null;
  capabilities: InspectionRecordCapabilities;
};
export type InspectionCapabilities = {
  can_prepare_integration_trial?: boolean;
  data_mode: InspectionDataMode;
  can_view: boolean; can_manage: boolean; can_submit: boolean; can_review: boolean;
  access_scope: 'all' | 'assigned_only'; can_view_kanban: boolean;
  mes: { enabled: boolean; reason_code: string; message: string; can_refresh: boolean; can_sync: boolean };
};
export type InspectionWorkGroup = {
  work_order_ref: string; task_ref: string; equipment_ref: string; open_count: number; request_count: number;
  statuses: Partial<Record<InspectionStatus, number>>; source_kind: string; blocking_reasons: string[]; latest_request_at: string;
};
export type InspectionList = {
  count: number; next: string | null; previous: string | null; results: Omit<InspectionRequest, 'audit' | 'operations'>[];
  work_groups?: InspectionWorkGroup[]; work_groups_truncated?: boolean;
};

export function inspectionCreatePayload(form: InspectionCreate): Record<string, unknown> {
  return { work_order_ref: form.work_order_ref.trim(), task_ref: form.task_ref.trim(), part_no: form.part_no.trim(), equipment_ref: form.equipment_ref.trim(), inspection_type: form.inspection_type,
    target_quantity: form.target_quantity.trim(), uom: form.uom.trim(), warehouse_ref: form.warehouse_ref.trim(), lot_ref: form.lot_ref.trim(), work_started_at: new Date(form.work_started_at).toISOString(), require_evidence: form.require_evidence, quantity_mode: form.quantity_mode, judgement_policy: form.judgement_policy,
    inspection_items: inspectionItemPayload(form.inspection_items) };
}
export type InspectionPreparationDraft = InspectionCreate & { preparation_mode?: 'production' | 'integration_trial'; trial_code?: string };
function inspectionItemPayload(items: InspectionItem[]) {
  return items.map(({ id, label, kind, options, unit, required, evidence_required, minimum, maximum }) => ({ id, label: label.trim(), kind, unit: unit.trim(), required, evidence_required,
    ...(kind === 'choice' ? { options: (options || []).map((option) => option.trim()) } : {}),
    ...(kind === 'number' && minimum ? { minimum: minimum.trim() } : {}), ...(kind === 'number' && maximum ? { maximum: maximum.trim() } : {}) }));
}
export function integrationTrialCreatePayload(form: Pick<InspectionPreparationDraft, 'trial_code' | 'inspection_items'>): Record<string, unknown> {
  const code = (form.trial_code || '').trim();
  if (!/^WJ-IT-[A-Z0-9][A-Z0-9-]{0,47}$/.test(code)) throw new Error('integration_trial_code_invalid');
  return { code, inspection_items: inspectionItemPayload(form.inspection_items) };
}

export function editableInspectionDraft(request: InspectionRequest): InspectionDraft {
  return {
    measurements: request.inspection_items.map((item) => {
      const source = request.measurements.find((measurement) => measurement.item_id === item.id);
      return { item_id: item.id, value: source?.value || '', judgement: source?.judgement || '', evidence_url: source?.evidence_url || '' };
    }),
    evidence: request.evidence.map(({ label, url }) => ({ label, url })),
    inspected_quantity: request.inspected_quantity || '', accepted_quantity: request.accepted_quantity || '', rejected_quantity: request.rejected_quantity || '',
    judgement: request.judgement || '', notes: request.notes || '',
  };
}
export function inspectionDraftPayload(draft: InspectionDraft, version: number, quantityMode: InspectionCreate['quantity_mode'] = 'recorded'): Record<string, unknown> {
  return { version, measurements: draft.measurements.map(({ item_id, value, judgement, evidence_url }) => ({ item_id, value: value.trim(), judgement, evidence_url: evidence_url?.trim() || '' })),
    evidence: draft.evidence.map(({ label, url }) => ({ label: label.trim(), url: url.trim() })),
    inspected_quantity: quantityMode === 'not_recorded' ? '0' : draft.inspected_quantity.trim(), accepted_quantity: quantityMode === 'not_recorded' ? '0' : draft.accepted_quantity.trim(), rejected_quantity: quantityMode === 'not_recorded' ? '0' : draft.rejected_quantity.trim(), judgement: draft.judgement, notes: draft.notes.trim() };
}
