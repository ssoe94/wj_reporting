import { http } from "@/shared/api/http";
import type { PlanType } from "./api";
export type MaterialOption = { key: string; material_id: string; material_code: string; material_name: string;
  material_version: string; unit_id: string; unit_name: string; selectable: boolean };
export type MaterialInput = MaterialOption & { numerator: string; denominator: string; required_quantity: string };
export type MaterialSnapshot = Record<string, unknown> & { inputs: MaterialInput[] };
export type WorkflowRow = { id: number; uid: string; version: number; plan_date: string; machine_name: string;
  part_no: string; planned_quantity: string; default_version: number; identity_state: string; candidates: string[];
  candidate_details: { uid: string; snapshot: { plan_date: string; machine_name: string; sequence: number; planned_quantity: string } }[];
  approval: { id: number; snapshot: MaterialSnapshot; approved_at: string; actor_name?: string } | null;
  previous_approval: { snapshot: MaterialSnapshot } | null;
  recommendation: { version: number; snapshot: MaterialSnapshot } | null };
export type WorkflowGroup = { key: string; machine_name: string; part_no: string; quantity: string;
  planned_start: string; planned_end: string; operation: string; blockers: string[]; work_order_code: string | null;
  mes_id?: string | null; versions?: Record<string, number>;
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
  product_resource_bom_mapping_review_required: ["제품·설비 연결을 관리자가 확인해야 합니다", "请管理员确认产品与设备连接"],
  tenant_contract_review_required: ["MES 연결 준비가 필요합니다. 관리자에게 요청하세요", "MES连接尚未准备好，请联系管理员"],
  tenant_readback_mapping_required: ["제품·원료 연결을 관리자가 확인해야 합니다", "请管理员确认产品与原料连接"],
  task_quantity_propagation_and_allowed_state_review: ["수량 변경 가능 여부를 MES 담당자가 확인해야 합니다", "请MES负责人确认是否允许修改数量"],
  plan_scope_truncated: ["계획 조회 범위 초과", "计划查询范围超限"],
  disabled: ["준비 저장됨 · MES 전송 전", "准备已保存 · 尚未发送MES"],
  superseded: ["새 버전으로 대체", "已被新版本替代"],
  confirmed: ["조회 검증됨", "已核验"],
  uncertain: ["결과 불확실 · 재조회", "结果不确定 · 需复查"],
  readback_pending: ["재조회 대기", "待复查"],
  sending: ["결과 확인 중", "正在确认结果"],
  review: ["담당자 확인 대기", "待负责人确认"],
  create: ["신규 工单 준비", "准备新工单"], update: ["수량·종료시간 변경", "修改数量及结束时间"],
  prepare: ["기존 준비안 변경", "修改现有准备方案"], unchanged: ["변경 없음", "无变更"],
  complete_creation_readback_required: ["생성 결과를 다시 조회하세요. 재전송하지 마세요", "请复查创建结果，不要重复发送"],
  connection_or_read_authority_required: ["MES 연결을 확인한 뒤 다시 조회하세요", "确认MES连接后再复查"],
  permission_required: ["조회 권한을 MES 담당자에게 요청하세요", "请向MES负责人申请查询权限"],
  campaign_bom_readback_adapter_required: ["원료와 전체 생산기간을 MES 담당자가 확인해야 합니다", "请MES负责人确认原料及完整生产期间"],
};
