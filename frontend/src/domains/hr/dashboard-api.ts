import api from '@/lib/api';
import type { HrDashboard } from './dashboard';

export async function getHrDashboard(month: string, signal: AbortSignal): Promise<HrDashboard> {
  return (await api.get<HrDashboard>(`/analytics/hr/dashboard/${month}/`, { signal })).data;
}
