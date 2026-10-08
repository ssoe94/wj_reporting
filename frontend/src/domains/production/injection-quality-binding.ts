import type { ExpectedInjectionQualityScope } from './injection-quality-status';

export type InjectionInspectionScope = {
  business_date: string; machine_number: number; current_plan_id: number | null;
  plan_version: string; plan_updated_at: string | null;
};

type Inputs = {
  businessDate: string; requestedBusinessDate: string; machineNumber: number;
  currentPlanId: number | null | undefined; planDate: string | undefined;
  // Local plan association uses the board's existing station selector only.
  // It is never treated as a MES equipment/task mapping.
  machinePlanIds: readonly (number | undefined)[];
  planRecords: readonly { id?: number; updated_at?: string }[];
  statusMachines: readonly { machine_number?: number; parts: readonly { plan_id?: number | null }[];
    inspection_scope?: InjectionInspectionScope | null; inspection_status?: unknown }[];
};

/** Reject mixed generations from independently refreshed plan/status endpoints. */
export function selectBoardInspection(input: Inputs): { scope: ExpectedInjectionQualityScope; payload: unknown } {
  const fallback: ExpectedInjectionQualityScope = { businessDate: input.businessDate,
    machineNumber: input.machineNumber, currentPlanId: input.currentPlanId ?? null,
    planVersion: '0'.repeat(64) };
  const absent = () => ({ scope: fallback, payload: null });
  if (input.requestedBusinessDate !== input.businessDate || input.planDate !== input.businessDate
    || !Number.isSafeInteger(input.currentPlanId) || Number(input.currentPlanId) <= 0) return absent();
  const matches = input.statusMachines.filter(row => row.machine_number === input.machineNumber);
  if (matches.length !== 1) return absent();
  const row = matches[0];
  const scope = row.inspection_scope;
  if (!scope || scope.business_date !== input.businessDate || scope.machine_number !== input.machineNumber
    || scope.current_plan_id !== input.currentPlanId || !/^[a-f0-9]{64}$/.test(scope.plan_version)
    || typeof scope.plan_updated_at !== 'string') return absent();
  if (input.planRecords.filter(plan => plan.id === input.currentPlanId).length !== 1) return absent();
  const revisionTimes = input.planRecords.map(plan => typeof plan.updated_at === 'string' ? Date.parse(plan.updated_at) : NaN);
  if (!revisionTimes.length || revisionTimes.some(time => !Number.isFinite(time))
    || Math.max(...revisionTimes) !== Date.parse(scope.plan_updated_at)) return absent();
  // Added/deleted/reordered local rows invalidate a retained status even when
  // an update timestamp alone cannot describe the change.
  const ids = row.parts.map(part => part.plan_id);
  if (ids.length !== input.machinePlanIds.length || ids.some((id, index) =>
    !Number.isSafeInteger(id) || Number(id) <= 0 || id !== input.machinePlanIds[index])
    || new Set(ids).size !== ids.length) return absent();
  return { scope: { businessDate: scope.business_date, machineNumber: scope.machine_number,
    currentPlanId: scope.current_plan_id, planVersion: scope.plan_version }, payload: row.inspection_status };
}
