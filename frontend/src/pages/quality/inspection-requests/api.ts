import { http } from '@/shared/api/http';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { parseInspectionAccess } from '@/domains/auth/inspection-beta-access';
import type { InspectionAction, MutationAttempt } from './workflow';

import type { InspectionCapabilities, InspectionList, InspectionRequest } from './model';
import { validateInspectionKanban } from './kanban';
import type { InspectionKanban } from './kanban';
import { parseMesDetailPreview } from './mesDetailPreviewModel';
import { parseInspectionRoleSettings } from './roleModel';
import type { InspectionRoleAttempt, InspectionRoleSetting, InspectionRoleSettings } from './roleModel';
export * from './model';

const base = '/quality/inspection-requests/';
export async function getInspectionRoleSettings(sessionId: string | null): Promise<InspectionRoleSettings> {
  assertAuthSessionCurrent(sessionId);
  const response = await http.get(`${base}role-settings/`, { authSessionId: sessionId });
  assertAuthSessionCurrent(sessionId);
  return parseInspectionRoleSettings(response.data);
}
export async function saveInspectionRoleSetting(id: number | null, payload: Record<string, unknown>, key: string, sessionId: string | null, expectedActorId: number): Promise<InspectionRoleSetting> {
  assertAuthSessionCurrent(sessionId);
  if (!Number.isSafeInteger(expectedActorId) || expectedActorId <= 0) throw new Error('Inspection role setting actor identity required');
  const config = { authSessionId: sessionId, headers: { 'Idempotency-Key': key } };
  type SettingMutationResponse = InspectionRoleSettings & { setting: InspectionRoleSetting; actor_id: number };
  const response = id === null ? await http.post<SettingMutationResponse>(`${base}role-settings/`, payload, config)
    : await http.patch<SettingMutationResponse>(`${base}role-settings/${id}/`, payload, config);
  assertAuthSessionCurrent(sessionId);
  if (response.status === 202) throw { response: { status: response.status, data: response.data } };
  const data = response.data;
  const setting = data?.setting;
  const nullableActor = (value: number | null) => value === null || (Number.isSafeInteger(value) && value > 0);
  const periodFields = ['effective_from', 'effective_until', 'effective_from_local', 'effective_until_local'] as const;
  if (data?.actor_id !== expectedActorId || data.can_configure !== true || !setting
    || !Number.isSafeInteger(setting.id) || setting.id <= 0 || (id !== null && setting.id !== id)
    || !Number.isSafeInteger(setting.version) || setting.version < 1
    || typeof setting.code !== 'string' || !setting.code || typeof setting.label !== 'string'
    || typeof setting.timezone !== 'string' || typeof setting.active !== 'boolean'
    || !(setting.start_time === null || typeof setting.start_time === 'string')
    || !(setting.end_time === null || typeof setting.end_time === 'string')
    || !nullableActor(setting.appearance_assignee) || !nullableActor(setting.dimension_assignee)
    || periodFields.some((field) => setting[field] !== null && typeof setting[field] !== 'string')) throw new Error('Inspection role setting mutation identity mismatch');
  const settings = parseInspectionRoleSettings(data);
  const listed = settings.settings.find((row) => row.id === setting.id);
  if (!listed || ['id', 'version', 'code', 'label', 'timezone', 'start_time', 'end_time', 'appearance_assignee', 'dimension_assignee', 'active', ...periodFields].some((field) => listed[field as keyof InspectionRoleSetting] !== setting[field as keyof InspectionRoleSetting])) throw new Error('Inspection role setting mutation identity mismatch');
  return setting;
}
export async function mutateInspectionRole(id: number, attempt: InspectionRoleAttempt, sessionId: string | null): Promise<InspectionRequest> {
  assertAuthSessionCurrent(sessionId);
  if (!['role-configure', 'area-save', 'area-complete', 'area-reopen', 'role-results'].includes(attempt.action)) throw new Error('Invalid inspection role action');
  const response = await http.post<InspectionRequest>(`${base}${id}/${attempt.action}/`, attempt.payload,
    { authSessionId: sessionId, headers: { 'Idempotency-Key': attempt.key } });
  assertAuthSessionCurrent(sessionId);
  if (response.status === 202) throw { response: { status: response.status, data: response.data } };
  if (response.data?.id !== id || response.data.role_workflow?.mode !== 'roles') throw new Error('Inspection role mutation identity mismatch');
  return response.data;
}
export async function getMesDetailPreview(sessionId: string | null, signal?: AbortSignal) {
  assertAuthSessionCurrent(sessionId);
  const response = await http.get(`${base}mes-detail-preview/`, { authSessionId: sessionId, signal });
  assertAuthSessionCurrent(sessionId);
  return parseMesDetailPreview(response.data);
}
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

/** Local WJ preparation only; no MES operation is dispatched here. */
export async function createIntegrationTrial(attempt: MutationAttempt, sessionId: string | null): Promise<InspectionRequest> {
  assertAuthSessionCurrent(sessionId);
  if (attempt.action !== 'create' || Object.keys(attempt.payload).sort().join(',') !== 'code,inspection_items'
    || typeof attempt.payload.code !== 'string' || !/^WJ-IT-[A-Z0-9][A-Z0-9-]{0,47}$/.test(attempt.payload.code)
    || !Array.isArray(attempt.payload.inspection_items)) throw new Error('Invalid integration trial preparation');
  const response = await http.post<InspectionRequest>(`${base}integration-trial/`, attempt.payload,
    { authSessionId: sessionId, headers: { 'Idempotency-Key': attempt.key } });
  assertAuthSessionCurrent(sessionId);
  if (response.status === 202) throw { response: { status: response.status, data: response.data } };
  if (!Number.isSafeInteger(response.data?.id) || response.data.id <= 0 || response.data.source_kind !== 'integration_test') throw new Error('Integration trial identity mismatch');
  return response.data;
}
