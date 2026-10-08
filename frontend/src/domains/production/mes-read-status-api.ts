import { http } from '@/shared/api/http';
import { isExistingMesWorkOrderCode, parseMesReadStatus } from './mes-read-status';

/** One explicit existing-work-order read. No production or inbound mutation is exposed. */
export async function getMesReadStatus(businessDate: string, workOrderCode: string, authSessionId: string | null) {
  if (!isExistingMesWorkOrderCode(workOrderCode)) throw new Error('mes_read_work_order_code_required');
  const response = await http.get<unknown>('/production/mes-read-status/', {
    params: { business_date: businessDate, work_order_code: workOrderCode },
    authSessionId,
  });
  return parseMesReadStatus(response.data, businessDate, workOrderCode);
}
