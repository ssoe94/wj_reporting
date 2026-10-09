import { http } from "@/shared/api/http";
import { getAuthSessionSnapshot } from "@/domains/auth/auth-storage";
import { assertAuthSessionCurrent } from "@/domains/auth/auth-transition";
import type { WorkflowScope } from "./plan-workflow-api";
import { parsePlanRecheckResult, parsePlanSendResult, planSendBody, requestUid } from "./plan-workflow-service";

export async function sendPlanRequests(scope: WorkflowScope, uids: readonly string[]) {
  const body = planSendBody(scope, uids);
  const session = getAuthSessionSnapshot().id;
  assertAuthSessionCurrent(session);
  const response = await http.post("/production/plan-workflow/", body, { authSessionId: session, skipAuthRefresh: true });
  assertAuthSessionCurrent(session);
  return parsePlanSendResult(response.data, uids);
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
