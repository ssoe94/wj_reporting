import type { InspectionEvidence, InspectionJudgement, InspectionMeasurement, InspectionRequest } from './model';

export type InspectionArea = 'appearance' | 'dimension';
export const inspectionAreas: InspectionArea[] = ['appearance', 'dimension'];
export type InspectionRoleSetting = {
  id: number; version: number; code: string; label: string; timezone: string; start_time: string | null; end_time: string | null;
  appearance_assignee: number | null; dimension_assignee: number | null;
  appearance_assignee_name?: string; dimension_assignee_name?: string; active: boolean;
  shift_date?: string;
};
export type InspectionRoleSettings = {
  settings: InspectionRoleSetting[]; candidates: { id: number; name: string }[]; can_configure: boolean;
};
export type InspectionRoleArea = {
  area: InspectionArea; assigned_to: number | null; assigned_to_name: string; version: number;
  status: string; judgement: InspectionJudgement; measurements: InspectionMeasurement[]; evidence: InspectionEvidence[];
  completed_by: number | null; completed_at: string | null; completed_by_name?: string;
  can_save: boolean; can_complete: boolean; can_reopen: boolean;
};
export type InspectionRoleWorkflow = {
  mode: 'roles'; configured: boolean; status: string; config_version: number; can_configure?: boolean;
  shift_snapshot: InspectionRoleSetting | null; item_areas: Record<string, InspectionArea>;
  areas: InspectionRoleArea[]; my_item_ids: string[]; aggregate_judgement: InspectionJudgement;
  mes: { can_save: false; reason: string };
};
export type InspectionRoleAction = 'role-configure' | 'area-save' | 'area-complete' | 'area-reopen' | 'role-results';
export type InspectionRoleAttempt = { action: InspectionRoleAction; payload: Record<string, unknown>; key: string };

/** Absence is legacy. Malformed role metadata must never grant item editing. */
export function inspectionRoleItemEditable(workflow: InspectionRoleWorkflow, itemId: string, userId: number): boolean {
  if (!workflow.configured || !Array.isArray(workflow.my_item_ids) || !workflow.my_item_ids.includes(itemId)) return false;
  const area = workflow.areas.find((row) => row.area === workflow.item_areas[itemId]);
  return Boolean(area && area.assigned_to === userId && area.can_save === true && area.status !== 'complete');
}

export function inspectionRoleFinalJudgement(workflow: InspectionRoleWorkflow): InspectionJudgement {
  const areas = inspectionAreas.map((area) => workflow.areas.find((row) => row.area === area));
  if (areas.some((row) => !row || row.status !== 'complete')) return '';
  if (areas.some((row) => row?.judgement === 'fail')) return 'fail';
  return areas.every((row) => row?.judgement === 'pass') ? 'pass' : '';
}

export function inspectionRoleMeasurements(request: InspectionRequest): InspectionMeasurement[] {
  const rows = request.role_workflow?.areas.flatMap((area) => area.measurements || []) || [];
  return request.inspection_items.map((item) => {
    const row = rows.find((entry) => entry.item_id === item.id) || request.measurements.find((entry) => entry.item_id === item.id);
    return { item_id: item.id, value: row?.value || '', judgement: row?.judgement || '', evidence_url: row?.evidence_url || '' };
  });
}

/** Partial payload contains only the selected, currently assigned area. */
export function inspectionRoleSavePayload(workflow: InspectionRoleWorkflow, area: InspectionArea, userId: number, measurements: InspectionMeasurement[], evidence: InspectionEvidence[]): Record<string, unknown> {
  const current = workflow.areas.find((row) => row.area === area);
  if (!current || current.assigned_to !== userId || !current.can_save) throw new Error('inspection_area_not_editable');
  const ownedIds = Object.keys(workflow.item_areas).filter((id) => workflow.item_areas[id] === area);
  if (!ownedIds.length || ownedIds.some((id) => !inspectionRoleItemEditable(workflow, id, userId))) throw new Error('inspection_area_not_editable');
  const selected = measurements.filter((row) => ownedIds.includes(row.item_id));
  if (selected.length !== ownedIds.length || new Set(selected.map((row) => row.item_id)).size !== ownedIds.length) throw new Error('inspection_area_measurements_incomplete');
  return { area, area_version: current.version, config_version: workflow.config_version,
    measurements: selected.map((row) => ({ item_id: row.item_id, value: row.value.trim(), judgement: row.judgement, evidence_url: row.evidence_url?.trim() || '' })),
    evidence: evidence.map((row) => ({ label: row.label.trim(), url: row.url.trim() })) };
}

/** A fresh read supplies other actors' rows; owned unsaved rows retain their original draft. */
export function inspectionRoleReconcileDraft(previous: InspectionMeasurement[], latest: InspectionRequest, userId: number): InspectionMeasurement[] {
  const workflow = latest.role_workflow;
  return inspectionRoleMeasurements(latest).map((row) => workflow && inspectionRoleItemEditable(workflow, row.item_id, userId)
    ? previous.find((draft) => draft.item_id === row.item_id) || row : row);
}

export function inspectionRoleMappingValid(itemIds: string[], itemAreas: Record<string, string>): boolean {
  return itemIds.length >= 2 && itemIds.every((id) => inspectionAreas.includes(itemAreas[id] as InspectionArea))
    && Object.keys(itemAreas).length === itemIds.length && inspectionAreas.every((area) => itemIds.some((id) => itemAreas[id] === area));
}

export function parseInspectionRoleSettings(value: unknown): InspectionRoleSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid inspection role settings');
  const data = value as InspectionRoleSettings;
  if (!Array.isArray(data.settings) || !Array.isArray(data.candidates) || typeof data.can_configure !== 'boolean'
    || data.candidates.some((row) => !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.name !== 'string')
    || data.settings.some((row) => !Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.label !== 'string')) throw new Error('Invalid inspection role settings');
  return data;
}
