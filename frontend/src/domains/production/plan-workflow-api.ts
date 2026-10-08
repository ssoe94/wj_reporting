import { http } from "@/shared/api/http";
import type { PlanType } from "./api";
export type MaterialOption = { key: string; material_id: string; material_code: string; material_name: string;
  material_version: string; unit_id: string; unit_name: string; selectable: boolean };
export type MaterialInput = MaterialOption & { numerator: string; denominator: string; required_quantity: string };
export type MaterialSnapshot = Record<string, unknown> & { inputs: MaterialInput[] };
export type WorkflowRow = { id: number; uid: string; version: number; plan_date: string; machine_name: string;
  part_no: string; planned_quantity: string; default_version: number; identity_state: string; candidates: string[];
  candidate_details: { uid: string; snapshot: { plan_date: string; machine_name: string; sequence: number; planned_quantity: string } }[];
  approval: { id: number; snapshot: MaterialSnapshot; approved_at: string } | null;
  previous_approval: { snapshot: MaterialSnapshot } | null;
  recommendation: { version: number; snapshot: MaterialSnapshot } | null };
export type WorkflowGroup = { key: string; machine_name: string; part_no: string; quantity: string;
  planned_start: string; planned_end: string; operation: string; blockers: string[]; work_order_code: string | null;
  members: string[]; reported_quantity: string | null; inbound_quantity: string | null };
export type WorkflowRequest = { uid: string; work_order_code: string; operation: string; state: string; blockers: string[] };
export type WorkflowData = { write_enabled: false; can_edit: boolean; can_manage_defaults: boolean; rows: WorkflowRow[];
  catalog: { dataset_id: number | null; refreshed_at: string | null; materials: MaterialOption[] };
  preview: WorkflowGroup[]; requests: WorkflowRequest[] };
export type WorkflowScope = { start: string; end: string; plan_type: PlanType };
export async function getPlanWorkflow(scope: WorkflowScope) {
  return (await http.get<WorkflowData>("/production/plan-workflow/", { params: scope })).data;
}
export async function changePlanWorkflow(scope: WorkflowScope, data: Record<string, unknown>) {
  return (await http.post("/production/plan-workflow/", { ...scope, ...data })).data;
}
export const workflowLabels: Record<string, [string, string]> = {
  identity_confirmation: ["작업 동일성 확인 필요", "需确认任务标识"],
  material_confirmation: ["원료 확인 필요", "待确认原料"],
  multiple_rows_setup_review: ["복수행·셋업 확인 필요", "多行／设置需确认"],
  campaign_members_changed: ["연속생산 구성 변경 확인", "需确认连续生产组成变更"],
  work_target_changed_review: ["제품·호기·LOT 변경 확인 필요", "需确认产品／设备／批次变更"],
  setup_changed_new_work_review: ["셋업 변경·새 작업 검토", "设置变更，需审核新任务"],
  planned_start_changed: ["기존 시작계획 변경 확인", "需确认原计划开始时间变更"],
  mes_observation_incomplete: ["MES 보고·입고 조회 필요", "需查询MES报工／入库"],
  below_existing_execution_review: ["기존 실행 기록량 미만 · 확인 필요", "低于已有执行记录数量 · 需确认"],
  below_produced_or_inbound: ["생산·입고량 미만으로 감소 불가", "不可低于已生产／入库数量"],
  readback_required: ["전송 결과 재조회 필요", "需复查发送结果"],
  product_resource_bom_mapping_review_required: ["품번·설비·BOM 매핑 검증 필요", "需验证产品／设备／BOM映射"],
  tenant_contract_review_required: ["MES 계약·매핑 검증 필요", "需验证MES契约及映射"],
  tenant_readback_mapping_required: ["MES 원본 ID·금형·BOM·조회 매핑 검증 필요", "需验证MES原始ID／模具／BOM及查询映射"],
  task_quantity_propagation_and_allowed_state_review: ["任务 수량 반영·수정 허용상태 검증 필요", "需验证任务数量联动及可编辑状态"],
  plan_scope_truncated: ["계획 조회 범위 초과", "计划查询范围超限"],
  disabled: ["MES 쓰기 OFF · 로컬 준비", "MES写入关闭 · 本地准备"],
  superseded: ["새 버전으로 대체", "已被新版本替代"],
  confirmed: ["조회 검증됨", "已核验"],
  uncertain: ["결과 불확실 · 재조회", "结果不确定 · 需复查"],
  readback_pending: ["재조회 대기", "待复查"],
  sending: ["결과 확인 중", "正在确认结果"],
  review: ["담당자 확인 대기", "待负责人确认"],
  create: ["신규 工单 준비", "准备新工单"], update: ["수량·종료시간 변경", "修改数量及结束时间"],
  prepare: ["기존 준비안 변경", "修改现有准备方案"], unchanged: ["변경 없음", "无变更"],
};
