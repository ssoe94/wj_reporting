import { http } from '@/shared/api/http';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { parseInspectionAccess } from '@/domains/auth/inspection-beta-access';
import type { InspectionAction, MutationAttempt } from './workflow';

import type { InspectionCapabilities, InspectionList, InspectionRequest } from './model';
import { validateInspectionKanban } from './kanban';
import type { InspectionKanban } from './kanban';
export * from './model';

const base = '/quality/inspection-requests/';
export async function getInspectionCapabilities(sessionId: string | null): Promise<InspectionCapabilities> {
  assertAuthSessionCurrent(sessionId);
  const response = await http.get<InspectionCapabilities>(`${base}capabilities/`, { authSessionId: sessionId });
  assertAuthSessionCurrent(sessionId);
  if (!parseInspectionAccess(response.data)) throw new Error('Invalid inspection capability response');
  return response.data;
}
export async function getInspectionRequests(search: string, status: string, page: number, sessionId: string | null): Promise<InspectionList> {
  assertAuthSessionCurrent(sessionId);
  const response = await http.get<InspectionList>(base, { authSessionId: sessionId, params: { search: search || undefined, status: status || undefined, page } });
  assertAuthSessionCurrent(sessionId);
  return response.data;
}
export async function getInspectionKanban(date: string, sessionId: string | null): Promise<InspectionKanban> {
  assertAuthSessionCurrent(sessionId);
  const response = await http.get<InspectionKanban>(`${base}kanban/`, { authSessionId: sessionId, params: { date } });
  assertAuthSessionCurrent(sessionId);
  return validateInspectionKanban(response.data, date);
}
export async function getInspectionRequest(id: number, sessionId: string | null): Promise<InspectionRequest> {
  assertAuthSessionCurrent(sessionId);
  const item = (await http.get<InspectionRequest>(`${base}${id}/`, { authSessionId: sessionId })).data;
  assertAuthSessionCurrent(sessionId);
  if (item.id !== id) throw new Error('Inspection request identity mismatch');
  return item;
}
const actionPaths: Record<Exclude<InspectionAction, 'create' | 'save'>, string> = {
  submit: 'submit', approve: 'approve', reject: 'reject', reinspect: 'reinspect', refresh: 'refresh', sync: 'sync', 'mes-save': 'mes-save', 'mes-finish': 'mes-finish', 'mes-reconcile': 'mes-reconcile', 'review-failure': 'review-failure',
};
export async function mutateInspectionRequest(id: number, attempt: MutationAttempt, sessionId: string | null): Promise<InspectionRequest> {
  assertAuthSessionCurrent(sessionId);
  const config = { authSessionId: sessionId, headers: { 'Idempotency-Key': attempt.key } };
  const response = attempt.action === 'create' ? await http.post<InspectionRequest>(base, attempt.payload, config)
    : attempt.action === 'save' ? await http.patch<InspectionRequest>(`${base}${id}/`, attempt.payload, config)
      : await http.post<InspectionRequest>(`${base}${id}/${actionPaths[attempt.action]}/`, attempt.payload, config);
  assertAuthSessionCurrent(sessionId);
  if (response.status === 202) throw { response: { status: response.status, data: response.data } };
  const result = response.data;
  if (!Number.isSafeInteger(result?.id) || result.id <= 0 || (!['create', 'reinspect'].includes(attempt.action) && result.id !== id)) throw new Error('Inspection mutation identity mismatch');
  return result;
}
