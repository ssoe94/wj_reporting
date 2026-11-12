import api from '@/lib/api';
import type { HrDailyEventInput, HrDailyInput, HrDailySheet } from './daily-work';
const url = (date: string) => `/analytics/hr/daily-work/${date}/`;
export async function getHrDailyWork(date: string, signal?: AbortSignal): Promise<HrDailySheet> { return (await api.get<HrDailySheet>(url(date), { signal })).data; }
export async function previewHrDailyWork(date: string, payload: HrDailyInput, signal?: AbortSignal): Promise<HrDailySheet> { return (await api.post<HrDailySheet>(`${url(date)}preview/`, payload, { signal })).data; }
export async function saveHrDailyWork(date: string, payload: HrDailyInput & { status: 'draft' | 'confirmed'; reason: string }): Promise<HrDailySheet> { return (await api.put<HrDailySheet>(url(date), payload)).data; }
export async function createHrDailyEvent(date: string, payload: HrDailyEventInput): Promise<HrDailySheet> { return (await api.post<HrDailySheet>(`${url(date)}events/`, payload)).data; }
