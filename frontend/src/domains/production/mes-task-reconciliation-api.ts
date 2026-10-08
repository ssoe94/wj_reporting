import { http } from "@/shared/api/http";
import type { MesTaskReconciliation } from "./mes-task-reconciliation";

export async function getMesTaskReconciliation(businessDate: string, signal?: AbortSignal) {
  const { data } = await http.get<MesTaskReconciliation>("/production/mes-task-reconciliation/", {
    params: { business_date: businessDate }, signal,
  });
  if (!Array.isArray(data?.machines) || !Array.isArray(data?.unmapped_tasks)
      || !Array.isArray(data?.warnings) || !data?.data_freshness || data.business_date !== businessDate) {
    throw new Error("Invalid task reconciliation response");
  }
  return data;
}
