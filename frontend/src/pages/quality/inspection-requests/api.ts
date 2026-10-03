import { http } from '@/shared/api/http';
import type { InspectionAction, MutationAttempt } from './workflow';

import type { InspectionCapabilities, InspectionList, InspectionRequest } from './model';
import { validateInspectionKanban } from './kanban';
import type { InspectionKanban } from './kanban';
export * from './model';

const base = '/quality/inspection-requests/';
export async function getInspectionCapabilities(): Promise<InspectionCapabilities> {
  return (await http.get<InspectionCapabilities>(`${base}capabilities/`)).data;
}
export async function getInspectionRequests(search: string, status: string, page: number): Promise<InspectionList> {
  return (await http.get<InspectionList>(base, { params: { search: search || undefined, status: status || undefined, page } })).data;
}
export async function getInspectionKanban(date: string): Promise<InspectionKanban> {
  return validateInspectionKanban((await http.get<InspectionKanban>(`${base}kanban/`, { params: { date } })).data, date);
}
export async function getInspectionRequest(id: number): Promise<InspectionRequest> {
  const item = (await http.get<InspectionRequest>(`${base}${id}/`)).data;
  if (item.id !== id) throw new Error('Inspection request identity mismatch');
  return item;
}
const actionPaths: Record<Exclude<InspectionAction, 'create' | 'save'>, string> = {
  submit: 'submit', approve: 'approve', reject: 'reject', reinspect: 'reinspect', refresh: 'refresh', sync: 'sync', 'mes-save': 'mes-save', 'mes-finish': 'mes-finish', 'mes-reconcile': 'mes-reconcile', 'review-failure': 'review-failure',
};
export async function mutateInspectionRequest(id: number, attempt: MutationAttempt): Promise<InspectionRequest> {
  const config = { headers: { 'Idempotency-Key': attempt.key } };
  const response = attempt.action === 'create' ? await http.post<InspectionRequest>(base, attempt.payload, config)
    : attempt.action === 'save' ? await http.patch<InspectionRequest>(`${base}${id}/`, attempt.payload, config)
      : await http.post<InspectionRequest>(`${base}${id}/${actionPaths[attempt.action]}/`, attempt.payload, config);
  if (response.status === 202) throw { response: { status: response.status, data: response.data } };
  const result = response.data;
  if (!Number.isSafeInteger(result?.id) || result.id <= 0 || (!['create', 'reinspect'].includes(attempt.action) && result.id !== id)) throw new Error('Inspection mutation identity mismatch');
  return result;
}
