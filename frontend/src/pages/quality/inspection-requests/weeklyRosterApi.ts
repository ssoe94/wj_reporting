import { http } from '@/shared/api/http';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { parseWeeklyRosterSettings } from './weeklyRosterModel';
import type { WeeklyRosterPayload, WeeklyRosterSettings } from './weeklyRosterModel';

const endpoint = '/quality/inspection-requests/weekly-role-settings/';
export async function getWeeklyInspectionRoleSettings(weekStart: string, sessionId: string | null): Promise<WeeklyRosterSettings> {
  assertAuthSessionCurrent(sessionId);
  const response = await http.get(endpoint, { authSessionId: sessionId, params: { week_start: weekStart } });
  assertAuthSessionCurrent(sessionId);
  return parseWeeklyRosterSettings(response.data, weekStart);
}
export async function saveWeeklyInspectionRoleSettings(payload: WeeklyRosterPayload, key: string, sessionId: string | null, expectedActorId: number): Promise<WeeklyRosterSettings> {
  assertAuthSessionCurrent(sessionId);
  if (!Number.isSafeInteger(expectedActorId) || expectedActorId <= 0) throw new Error('Inspection weekly setting actor identity required');
  const response = await http.post<WeeklyRosterSettings & { actor_id: number }>(endpoint, payload, {
    authSessionId: sessionId, headers: { 'Idempotency-Key': key },
  });
  assertAuthSessionCurrent(sessionId);
  if (response.status === 202) throw { response: { status: response.status, data: response.data } };
  const result = parseWeeklyRosterSettings(response.data, payload.week_start);
  if (response.data.actor_id !== expectedActorId || result.can_configure !== true || result.version !== payload.version + 1)
    throw new Error('Inspection weekly setting mutation identity mismatch');
  return result;
}
