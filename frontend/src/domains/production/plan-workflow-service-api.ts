import { http } from "@/shared/api/http";
import { getAuthSessionSnapshot } from "@/domains/auth/auth-storage";
import { assertAuthSessionCurrent } from "@/domains/auth/auth-transition";
import type { WorkflowScope } from "./plan-workflow-api";
import { parsePlanRecheckResult, parsePlanSendResult, planSendBody, requestUid, splitPlanSelection,
  type PlanServiceResult } from "./plan-workflow-service";

export async function sendPlanRequests(scope: WorkflowScope, uids: readonly string[],
  ownerSession?: string | null, beforeRequest?: () => void) {
  const body = planSendBody(scope, uids);
  const session = ownerSession === undefined ? getAuthSessionSnapshot().id : ownerSession;
  assertAuthSessionCurrent(session);
  beforeRequest?.();
  const response = await http.post("/production/plan-workflow/", body, { authSessionId: session, skipAuthRefresh: true });
  assertAuthSessionCurrent(session);
  return parsePlanSendResult(response.data, uids);
}
export type PlanSelectionCallbacks = {
  beforeChunk?: (uids: readonly string[]) => void;
  onChunk?: (results: PlanServiceResult[], completed: number, total: number) => void;
};
export type PlanSelectionOutcome = { completed: number; total: number; attempted: number;
  uncertainUids: string[]; remainingUids: string[]; stopped: boolean };
/** One captured WJ owner, sequential bounded requests, no replay after ambiguity. */
export async function sendPlanSelection(scope: WorkflowScope, uids: readonly string[], callbacks: PlanSelectionCallbacks = {}): Promise<PlanSelectionOutcome> {
  const chunks = splitPlanSelection(uids), selection = chunks.flat(), fixedScope = { ...scope };
  const session = getAuthSessionSnapshot().id;
  let completed = 0, attempted = 0;
  for (const chunk of chunks) {
    let started = false;
    let results: PlanServiceResult[];
    try {
      results = await sendPlanRequests(fixedScope, chunk, session, () => {
        callbacks.beforeChunk?.([...chunk]);
        started = true; attempted += chunk.length;
      });
    } catch {
      return { completed, total: selection.length, attempted, uncertainUids: started ? [...chunk] : [],
        remainingUids: selection.slice(attempted), stopped: true };
    }
    completed += chunk.length;
    callbacks.onChunk?.(results, completed, selection.length);
  }
  return { completed, total: selection.length, attempted, uncertainUids: [], remainingUids: [], stopped: false };
}
export async function recheckPlanRequest(scope: WorkflowScope, uid: string) {
  if (!requestUid(uid)) throw Error("Invalid plan request");
  const session = getAuthSessionSnapshot().id;
  assertAuthSessionCurrent(session);
  const response = await http.post("/production/plan-workflow/", { ...scope, action: "recheck", request_uid: uid },
    { authSessionId: session, skipAuthRefresh: true });
  assertAuthSessionCurrent(session);
  return parsePlanRecheckResult(response.data, uid);
}
