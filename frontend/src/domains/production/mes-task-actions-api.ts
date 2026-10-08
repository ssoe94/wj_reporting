import { http } from "@/shared/api/http";
import type { TaskActionKind } from "./injection-machine-board";

export type MesTaskActionItem = {
  action: TaskActionKind;
  task_id: string;
  task_code: string;
  machine_number: number;
  expected_status: 1 | 2 | 3;
  work_order_code: string;
  part_no: string;
};

export type MesTaskActionOutcome = "confirmed" | "rejected" | "uncertain" | "blocked";

export type MesTaskActionResult = {
  task_id: string;
  task_code: string;
  action: TaskActionKind;
  machine_number: number;
  work_order_code: string;
  part_no: string;
  status_before: number;
  status_after: number | null;
  outcome: MesTaskActionOutcome;
  reason: string;
  mes_code: number | null;
  mes_sub_code: string;
  mes_message: string;
  need_check: number | null;
};

export type MesTaskActionAvailability = { enabled: boolean; permitted: boolean };

export async function getMesTaskActionAvailability(signal?: AbortSignal) {
  const { data } = await http.get<MesTaskActionAvailability>("/production/mes-task-actions/", { signal });
  return { enabled: data?.enabled === true, permitted: data?.permitted === true };
}

export async function postMesTaskActions(items: MesTaskActionItem[], reason: string) {
  const { data } = await http.post<{ request_id: string; results: MesTaskActionResult[] }>(
    "/production/mes-task-actions/",
    { items, reason },
  );
  if (!Array.isArray(data?.results)) throw new Error("Invalid action response");
  return data;
}
