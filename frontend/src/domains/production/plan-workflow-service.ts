import type { WorkflowData, WorkflowGroup, WorkflowRequest, WorkflowScope } from "./plan-workflow-api";

export const PLAN_CREATE_BATCH_LIMIT = 50;
export function requestUid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
/** MES integers are returned as decimal strings; never repair a rounded number. */
export function safeMesId(value: unknown): string | null {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}
export function canSendPlanRequest(data: WorkflowData, group: WorkflowGroup, request: WorkflowRequest | undefined,
  attempted: ReadonlySet<string>): boolean {
  return data.write_enabled === true && data.can_edit === true && group.blockers.length === 0 && !group.mes_id
    && ["create", "prepare", "unchanged"].includes(group.operation)
    && !!request && requestUid(request.uid) && request.can_send === true && request.attempt === 0
    && request.operation === "create" && ["disabled", "prepared", "failed"].includes(request.state)
    && request.blockers.length === 0 && (request.mes_id == null || request.mes_id === "") && !attempted.has(request.uid);
}
/** Only a fresh server snapshot of an aborted preflight may release ambiguity. */
export function canReleasePlanSendAttempt(request: WorkflowRequest): boolean {
  return requestUid(request.uid) && request.state === "failed" && request.attempt === 0
    && request.can_send === true && request.operation === "create" && request.blockers.length === 0
    && (request.mes_id == null || request.mes_id === "");
}
export function canRecheckPlanRequest(request: WorkflowRequest | undefined): boolean {
  return !!request && requestUid(request.uid) && request.can_recheck === true;
}
export function planRequestState(request: WorkflowRequest | undefined): string | null {
  if (!request) return null;
  const result = request.last_result;
  if (request.state === "created") return "created";
  if (request.state === "already_exists") return "already_exists";
  if (request.state === "confirmed") {
    if (result?.outcome === "already_exists") return "already_exists";
    if (result?.outcome === "created") return "created";
    return "confirmed";
  }
  return request.state;
}
export type PlanServiceResult = { uid: string; code: string; state: string; mes_id: string | null; blockers: string[] };
export function parsePlanSendResult(value: unknown, requested: readonly string[]): PlanServiceResult[] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== requested.length) throw Error("Incomplete plan send response");
  const expected = new Set(requested), seen = new Set<string>();
  return results.map(row => {
    const code = row?.work_order_code ?? row?.code ?? (row?.state === "blocked" ? "" : undefined);
    if (!row || !requestUid(row.uid) || !expected.has(row.uid) || seen.has(row.uid)
      || typeof code !== "string" || code.length > 160
      || !["created", "already_exists", "uncertain", "readback_pending", "review", "failed", "blocked", "checking", "sending"].includes(row.state)
      || !Array.isArray(row.blockers) || row.blockers.some((code: unknown) => typeof code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(code))
      || (row.mes_id !== null && row.mes_id !== undefined && row.mes_id !== "" && !safeMesId(row.mes_id))) throw Error("Invalid plan send response");
    seen.add(row.uid);
    return { uid: row.uid, code, state: row.state, mes_id: safeMesId(row.mes_id), blockers: [...row.blockers] };
  });
}
export function parsePlanRecheckResult(value: unknown, uid: string): PlanServiceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid plan readback response");
  const row = value as Record<string, unknown>;
  return parsePlanSendResult({ results: [{ ...row, work_order_code: row.work_order_code ?? row.code ?? "" }] }, [uid])[0];
}
export function planSendBody(scope: WorkflowScope, uids: readonly string[]) {
  if (!uids.length || uids.length > PLAN_CREATE_BATCH_LIMIT || new Set(uids).size !== uids.length || !uids.every(requestUid))
    throw Error("Invalid selected plan requests");
  return { ...scope, action: "send", request_uids: [...uids] };
}
