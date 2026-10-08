import { isIntegrationTrial } from './integrationTrial.ts';
import { inspectionDisplayPlans, inspectionRequestStage, inspectionStageCounts } from './kanban.ts';
import type { InspectionMachine, InspectionStage, KanbanInspectionRequest } from './kanban';
import type { StationMesInspectionView } from './mesInspectionSignal';

export const inspectionStationNumbers = Array.from({ length: 17 }, (_, index) => index + 1);
export function stationRequests(machine: InspectionMachine | undefined): KanbanInspectionRequest[] {
  return (machine?.requests || []).filter((request) => !isIntegrationTrial(request));
}
/** Summaries describe displayed WJ requests, never inferred machine/MES availability. */
export function stationStage(machine: InspectionMachine | undefined): InspectionStage | 'empty' | 'unknown' {
  if (!machine) return 'unknown';
  const counts = inspectionStageCounts(stationRequests(machine));
  return (['blocked', 'in_progress', 'waiting', 'completed'] as const).find((stage) => counts[stage] > 0) || 'empty';
}
export function stationDefaultRequest(machine: InspectionMachine | undefined, selectedId: number | null): number | null {
  const requests = stationRequests(machine);
  if (requests.some((request) => request.id === selectedId)) return selectedId;
  const order: InspectionStage[] = ['waiting', 'in_progress', 'blocked', 'completed'];
  const sorted = [...requests].sort((a, b) => order.indexOf(inspectionRequestStage(a)) - order.indexOf(inspectionRequestStage(b)) || a.id - b.id);
  return sorted[0]?.id ?? null;
}

/** A displayed WJ plan remains labelled as plan evidence, even when its local execution is running. */
export function stationProductionSummary(machine: InspectionMachine | undefined, mes: StationMesInspectionView, lang: 'ko' | 'zh') {
  const ko = lang === 'ko';
  if (mes.current_work) {
    const work = mes.current_work;
    return { part: work.part_no, product: work.product_name || (ko ? 'MES 현재 품번' : 'MES 当前品号'),
      production: (ko ? { running: '생산 중', paused: '일시 정지', stopped: '생산 정지', completed: '생산 종료', unknown: '가동 미확인' }
        : { running: '生产中', paused: '已暂停', stopped: '已停产', completed: '生产结束', unknown: '运行未确认' })[work.production_status], source: 'mes' };
  }
  const plan = machine?.plans?.length ? inspectionDisplayPlans(machine.plans)[0] : null;
  return { part: plan?.part_no || (ko ? '품번 미확인' : '品号未确认'),
    product: plan ? (ko ? 'WJ 계획 품번' : 'WJ 计划品号') : (ko ? '계획 없음' : '暂无计划'),
    production: plan?.execution_status === 'running' ? (ko ? 'WJ 가동 기록' : 'WJ 运行记录')
      : plan?.execution_status === 'paused' ? (ko ? 'WJ 정지 기록' : 'WJ 暂停记录') : (ko ? '가동 미확인' : '运行未确认'), source: 'wj_plan' };
}
