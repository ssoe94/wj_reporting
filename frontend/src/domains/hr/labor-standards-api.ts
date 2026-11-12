import api from '@/lib/api';
import type { HrActualPaymentAmounts, HrLaborActualPayments, HrLaborCalendar, HrLaborDayType, HrLaborRules, HrLaborStandards } from './labor-standards';
const ROOT = '/analytics/hr';
export async function getHrLaborStandards(month: string, signal?: AbortSignal): Promise<HrLaborStandards> {
  return (await api.get<HrLaborStandards>(`${ROOT}/labor-standards/${month}/`, { signal })).data;
}
export async function saveHrLaborStandards(month: string, payload: { version: number; reason: string; rules: HrLaborRules }): Promise<HrLaborStandards> {
  return (await api.put<HrLaborStandards>(`${ROOT}/labor-standards/${month}/`, payload)).data;
}
export async function getHrLaborCalendar(month: string, signal?: AbortSignal): Promise<HrLaborCalendar> {
  return (await api.get<HrLaborCalendar>(`${ROOT}/labor-calendar/${month}/`, { signal })).data;
}
export async function saveHrLaborCalendar(month: string, payload: { version: number; reason: string; days: Record<string, HrLaborDayType> }): Promise<HrLaborCalendar> {
  return (await api.put<HrLaborCalendar>(`${ROOT}/labor-calendar/${month}/`, payload)).data;
}

export async function getHrLaborActualPayments(month: string, signal?: AbortSignal): Promise<HrLaborActualPayments> {
  return (await api.get<HrLaborActualPayments>(`${ROOT}/labor-actual-payments/${month}/`, { signal })).data;
}
export async function saveHrLaborActualPayments(month: string, payload: { version: number; reason: string; amounts: HrActualPaymentAmounts; evidence_memo: string }): Promise<HrLaborActualPayments> {
  return (await api.put<HrLaborActualPayments>(`${ROOT}/labor-actual-payments/${month}/`, payload)).data;
}
