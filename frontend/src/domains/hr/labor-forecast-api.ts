import api from '@/lib/api';
import type { LaborForecast } from './labor-forecast';

export async function getLaborForecast(month: string, signal: AbortSignal): Promise<LaborForecast> {
  return (await api.get<LaborForecast>(`/analytics/hr/labor-forecast/${month}/`, { signal })).data;
}
