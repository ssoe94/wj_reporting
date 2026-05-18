import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getInjectionProductionMatrix,
  getInjectionProductionMatrixForDate,
  type InjectionProductionMatrix,
} from "@/domains/mes/api";
import {
  askProductionAi,
  cancelAiJob,
  createAiJob,
  getAiJob,
  getProductionAiBriefing,
  getProductionMesReportStats,
  getProductionPlanSummary,
  getProductionStatus,
  type ProductionMesReportStatsResponse,
  type ProductionPlanRecord,
  type ProductionPlanSummaryResponse,
  type ProductionStatusResponse,
  type AiJob,
  type AiJobStatus,
} from "@/domains/production/api";
import {
  buildRealtimeProgressSummary,
  type RealtimeProgressRow,
  type RealtimeProgressSegment,
  type RealtimeProgressSegmentStatus,
  type RealtimeProgressSummary,
} from "@/domains/production/realtime-progress";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { getShanghaiDateString } from "@/shared/utils/date";

type ProductionBriefContext = {
  businessDate: string;
  injectionPlanQty: number;
  machiningPlanQty: number;
  actualInjectionOutput: number;
  actualMachiningOutput: number;
  planGap: number;
  machiningPlanGap: number;
  activeMachineCount: number;
  runningMachineCount: number;
  totalMachines: number;
  topMachines: Array<{ machine: string; output: number }>;
  lowOutputMachines: Array<{ machine: string; output: number }>;
  latestUpdatedAt: string | null;
};

type MachiningProgressPreview = {
  plannedQty: number;
  actualQty: number;
  partCount: number;
  progressRate: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  rows: Array<{
    key: string;
    label: string;
    plannedQty: number;
    actualQty: number;
    gapQty: number;
    progressRate: number;
    completedCount: number;
    inProgressCount: number;
    pendingCount: number;
    segments: RealtimeProgressSegment[];
  }>;
};

const pageCopy = {
  ko: {
    eyebrow: "Production",
    title: "생산 대시보드",
    description: "생산 계획과 MES 실적을 비교하고, 로컬 LLM으로 일일 생산 브리핑을 작성합니다.",
    loading: "생산 현황을 불러오는 중입니다.",
    productionDate: "기준일",
    productionDateHint: "오전 08:00 ~ 익일 08:00 기준",
    injectionActualPlan: "사출 계획 및 실행율",
    machiningActualPlan: "가공 실적 / 계획",
    completedRate: "완료",
    timeRate: "시간 기준",
    injectionFacilities: "사출기",
    machiningFacilities: "가공 라인",
    planOver: "계획 대비 초과",
    planShort: "계획 대비 부족",
    activeMachines: "기준일 가동 설비",
    todayActiveMachines: "기준일 실적 설비",
    recentRunning: "최근 60분 가동",
    localBrief: "AI BRIEFING",
    briefTitle: "일일 생산 브리핑",
    usedData: "사용한 데이터",
    calculationBasis: "계산 기준",
    deterministicBrief: "계산형 RAG 브리핑",
    askAi: "AI에게 질문하기",
    closeAi: "질문 닫기",
    runWorkerAnalysis: "로컬 AI 분석 실행",
    workerAnalysisRunning: "분석 작업 대기 중",
    workerJobTitle: "Mac Studio Worker 분석",
    workerJobStatus: "작업 상태",
    workerJobWaiting: "Mac Studio Worker가 작업을 가져가면 분석이 시작됩니다.",
    workerJobCancel: "작업 취소",
    workerJobResult: "분석 결과",
    workerJobIssue: "확인 이슈",
    workerJobNoIssue: "별도 이슈가 없습니다.",
    workerJobFallback: "로컬 LLM 응답 지연으로 계산 기반 분석을 표시합니다.",
    askingAi: "AI 답변 중",
    aiQuestionPlaceholder: "예: 오늘 계획 대비 가장 먼저 확인해야 할 사출기는 어디야?",
    aiAnswerTitle: "AI 답변",
    aiSubmit: "질문 보내기",
    llmError: "로컬 MLX LLM 서버에 연결하지 못했습니다. 현재는 데이터 기반 초안을 표시합니다.",
    progressEyebrow: "LIVE PROGRESS",
    progressTitle: "실시간 프로그레스",
    progressDescription: "사출은 생산 계획과 MES 형합수를 조합해 Cavity 기준 추정 생산량으로 진행률을 계산합니다.",
    injectionProgress: "사출 실시간 진행",
    machiningProgress: "가공 실시간 진행",
    planned: "계획",
    actualEstimate: "추정 생산",
    shotCount: "형합수",
    running: "가동",
    gap: "차이",
    overrun: "초과 생산",
    overrunShort: "초과",
    parts: "Part",
    cavity: "Cavity",
    completed: "완료",
    inProgress: "진행중",
    pending: "대기",
    currentPart: "현재",
    partProgress: "Part별 진행",
    totalProgress: "전체 진행률",
    detail: "상세",
    close: "닫기",
    machineDetailTitle: "사출기 진행 상세",
    sequence: "순서",
    model: "모델",
    lot: "Lot",
    progress: "진행률",
    estimatedVsPlan: "추정 / 계획",
    progressHint: "각 설비의 계획 순서대로 형합수를 배분해 완료/진행중/대기를 표시합니다.",
    noProgressRows: "계획 또는 MES 실적이 없습니다.",
    machiningPending: "Blacklake JG/加工 생산보고 수량을 계획 순서대로 배분해 진행률을 표시합니다.",
    plannedOnly: "계획 수량 기준 준비",
    rawTitle: "운영 API 확인",
  },
  zh: {
    eyebrow: "Production",
    title: "生产看板",
    description: "对比生产计划与 MES 实绩，并使用本地 LLM 生成每日生产简报。",
    loading: "正在读取生产现况。",
    productionDate: "基准日",
    productionDateHint: "上午 08:00 ~ 次日 08:00 基准",
    injectionActualPlan: "注塑计划及执行率",
    machiningActualPlan: "加工实绩 / 计划",
    completedRate: "完成",
    timeRate: "时间基准",
    injectionFacilities: "注塑机",
    machiningFacilities: "加工线",
    planOver: "较计划超出",
    planShort: "较计划不足",
    activeMachines: "基准日运行设备",
    todayActiveMachines: "基准日有实绩设备",
    recentRunning: "最近 60 分钟运行",
    localBrief: "AI BRIEFING",
    briefTitle: "每日生产简报",
    usedData: "使用的数据",
    calculationBasis: "计算基准",
    deterministicBrief: "计算型 RAG 简报",
    askAi: "向 AI 提问",
    closeAi: "关闭提问",
    runWorkerAnalysis: "运行本地 AI 分析",
    workerAnalysisRunning: "分析任务等待中",
    workerJobTitle: "Mac Studio Worker 分析",
    workerJobStatus: "任务状态",
    workerJobWaiting: "Mac Studio Worker 领取任务后将开始分析。",
    workerJobCancel: "取消任务",
    workerJobResult: "分析结果",
    workerJobIssue: "确认事项",
    workerJobNoIssue: "暂无特别事项。",
    workerJobFallback: "本地 LLM 响应延迟，当前显示基于计算的分析。",
    askingAi: "AI 回答中",
    aiQuestionPlaceholder: "例：今天计划对比最需要先确认哪台注塑机？",
    aiAnswerTitle: "AI 回答",
    aiSubmit: "发送问题",
    llmError: "无法连接本地 MLX LLM 服务。当前显示基于数据的草稿。",
    progressEyebrow: "LIVE PROGRESS",
    progressTitle: "实时进度",
    progressDescription: "注塑结合生产计划与 MES 合模数，并按 Cavity 估算生产量计算进度。",
    injectionProgress: "注塑实时进度",
    machiningProgress: "加工实时进度",
    planned: "计划",
    actualEstimate: "估算生产",
    shotCount: "合模数",
    running: "运行",
    gap: "差异",
    overrun: "超计划生产",
    overrunShort: "超出",
    parts: "Part",
    cavity: "Cavity",
    completed: "完成",
    inProgress: "进行中",
    pending: "待开始",
    currentPart: "当前",
    partProgress: "按 Part 进度",
    totalProgress: "整体进度",
    detail: "详情",
    close: "关闭",
    machineDetailTitle: "注塑机进度详情",
    sequence: "顺序",
    model: "型号",
    lot: "Lot",
    progress: "进度",
    estimatedVsPlan: "估算 / 计划",
    progressHint: "按设备计划顺序分配合模数，显示完成/进行中/待开始。",
    noProgressRows: "暂无计划或 MES 实绩。",
    machiningPending: "按 Blacklake JG/加工报工数量分配到计划顺序并显示进度。",
    plannedOnly: "按计划数量准备",
    rawTitle: "运营 API 确认",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const LOCAL_LLM_BASE_URL = import.meta.env.VITE_LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080/v1";
const LOCAL_LLM_MODEL = import.meta.env.VITE_LOCAL_LLM_MODEL || "mlx-community/gemma-4-e2b-it-8bit";

type DashboardAiIntent = {
  intent: "injection_cycle_time" | "production_output" | "production_status" | "production_summary" | "unknown";
  metric?: string | null;
  filters: {
    running_only?: boolean;
    product_family?: string | null;
    target_text?: string | null;
    machine?: string | null;
  };
  sort?: "ct_desc" | "ct_asc" | "output_desc" | "output_asc" | null;
  limit?: number;
};

function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

function isAiJobTerminal(status?: AiJobStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getAiJobStatusLabel(status: AiJobStatus | undefined, language: AppLanguage) {
  const labels = {
    ko: {
      pending: "대기",
      claimed: "Worker 배정",
      running: "분석 중",
      completed: "완료",
      failed: "실패",
      cancelled: "취소",
    },
    zh: {
      pending: "等待",
      claimed: "已分配",
      running: "分析中",
      completed: "完成",
      failed: "失败",
      cancelled: "已取消",
    },
  } satisfies Record<AppLanguage, Record<AiJobStatus, string>>;
  return status ? labels[language][status] : "-";
}

function getStringField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function getTopIssues(source: Record<string, unknown>) {
  const issues = source.top_issues;
  return Array.isArray(issues)
    ? issues
      .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object")
      .slice(0, 5)
    : [];
}

function getIssueText(issue: Record<string, unknown>) {
  const evidence = issue.evidence;
  if (Array.isArray(evidence)) {
    return evidence.map((item) => String(item)).filter(Boolean).join(" · ");
  }
  return getStringField(issue, "detail") || getStringField(issue, "summary");
}

function normalizeProductFamily(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (["bc", "b/c", "backcover", "백커버"].includes(normalized)) return "BC";
  if (["ca", "c/a", "cabinet", "캐비넷"].includes(normalized)) return "CA";
  if (["gp", "g/p", "guidepanel", "가이드패널"].includes(normalized)) return "GP";
  return null;
}

function normalizeDashboardIntent(raw: Partial<DashboardAiIntent>): DashboardAiIntent {
  const validIntent = ["injection_cycle_time", "production_output", "production_status", "production_summary", "unknown"].includes(String(raw.intent))
    ? raw.intent
    : "unknown";
  const filters = raw.filters ?? {};
  const limit = Math.max(1, Math.min(20, Number(raw.limit ?? 8) || 8));
  return {
    intent: validIntent ?? "unknown",
    metric: raw.metric ?? null,
    filters: {
      running_only: Boolean(filters.running_only),
      product_family: normalizeProductFamily(filters.product_family),
      target_text: String(filters.target_text ?? "").trim() || null,
      machine: String(filters.machine ?? "").trim() || null,
    },
    sort: raw.sort ?? null,
    limit,
  };
}

function extractJsonObject(text: string) {
  try {
    const parsed = JSON.parse(text.trim());
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      const parsed = JSON.parse(match[0]);
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }
}

function heuristicDashboardIntent(question: string): DashboardAiIntent {
  const normalized = question.toLowerCase();
  const runningOnly = ["현재", "지금", "생산중", "가동", "现在", "当前", "运行"].some((token) => normalized.includes(token));
  const productFamily = normalizeProductFamily(
    ["back cover", "backcover", "b/c", "bc", "백커버"].some((token) => normalized.includes(token)) ? "BC"
      : ["cabinet", "c/a", "캐비넷"].some((token) => normalized.includes(token)) ? "CA"
        : ["guide panel", "g/p", "가이드"].some((token) => normalized.includes(token)) ? "GP"
          : null,
  );
  const targetTokens = question
    .match(/[A-Za-z0-9][A-Za-z0-9./_-]{2,}/g)
    ?.filter((token) => token.length >= 4 && !["back", "cover", "cycle", "output", "production"].includes(token.toLowerCase())) ?? [];

  if (["c/t", "ct", "cycle", "사이클", "싸이클", "시간", "节拍", "周期"].some((token) => normalized.includes(token))) {
    const longest = ["가장 길", "제일 길", "최장", "longest", "最慢", "最长"].some((token) => normalized.includes(token));
    const shortest = ["가장 짧", "제일 짧", "최단", "shortest", "最快", "最短"].some((token) => normalized.includes(token));
    return normalizeDashboardIntent({
      intent: "injection_cycle_time",
      metric: "recent_60m_avg_ct_sec",
      filters: { running_only: runningOnly, product_family: productFamily, target_text: targetTokens[0] ?? null },
      sort: longest ? "ct_desc" : shortest ? "ct_asc" : null,
      limit: longest || shortest ? 1 : 8,
    });
  }

  if (["생산량", "실적", "몇개", "몇 개", "output", "production", "产量", "实绩"].some((token) => normalized.includes(token))) {
    return normalizeDashboardIntent({
      intent: "production_output",
      metric: "estimated_qty",
      filters: { running_only: runningOnly, product_family: productFamily, target_text: targetTokens[0] ?? null },
      sort: "output_desc",
      limit: 8,
    });
  }

  if (runningOnly && ["몇대", "몇 대", "수는", "수량", "몇台", "几台", "多少台"].some((token) => normalized.includes(token))) {
    return normalizeDashboardIntent({
      intent: "production_status",
      metric: "running_count",
      filters: { running_only: true, product_family: productFamily },
      limit: 17,
    });
  }

  if (["진도", "진행", "진척", "상황", "어때", "어떄", "怎么样", "进度", "情况"].some((token) => normalized.includes(token))) {
    return normalizeDashboardIntent({
      intent: "production_summary",
      metric: "progress_rate",
      filters: { running_only: false, product_family: productFamily },
      limit: 8,
    });
  }

  return normalizeDashboardIntent({ intent: "unknown", filters: {} });
}

function getLatestTime(data?: InjectionProductionMatrix) {
  const latestSlot = data?.time_slots.at(-1);
  return latestSlot ? new Date(latestSlot.time) : null;
}

function getBusinessDayStart(businessDate: string) {
  return new Date(`${businessDate}T08:00:00+08:00`);
}

function getBusinessDayEnd(businessDate: string) {
  return new Date(getBusinessDayStart(businessDate).getTime() + 24 * 60 * 60 * 1000);
}

function getBusinessDayReferenceEnd(businessDate: string, mesData?: InjectionProductionMatrix) {
  const start = getBusinessDayStart(businessDate);
  const end = getBusinessDayEnd(businessDate);
  const latestTime = getLatestTime(mesData);
  if (!latestTime) return end;
  return new Date(Math.min(Math.max(latestTime.getTime(), start.getTime()), end.getTime()));
}

function getProductionElapsedRate(businessDate: string, mesData?: InjectionProductionMatrix) {
  const start = getBusinessDayStart(businessDate);
  const end = getBusinessDayEnd(businessDate);
  const latestTime = getLatestTime(mesData);
  const fallbackTime = businessDate === getShanghaiDateString() ? new Date() : end;
  const referenceTime = latestTime ?? fallbackTime;
  const clampedTime = new Date(Math.min(Math.max(referenceTime.getTime(), start.getTime()), end.getTime()));
  return ((clampedTime.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100;
}

function getRateTone(actualRate: number, expectedRate: number): "positive" | "negative" | "neutral" {
  const gap = actualRate - expectedRate;
  if (gap >= 5) return "positive";
  if (gap <= -5) return "negative";
  return "neutral";
}

function numberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0) return 0;
  return Number(values[index] ?? 0);
}

function getMachineNumberFromName(value: string | null | undefined) {
  const text = String(value ?? "");
  const suffixMatch = text.match(/-(\d+)\s*$/);
  if (suffixMatch) return suffixMatch[1];
  const koreanMatch = text.match(/^(\d+)\s*호기/);
  if (koreanMatch) return koreanMatch[1];
  const leadingMatch = text.match(/^(\d+)\D/);
  return leadingMatch ? leadingMatch[1] : null;
}

function getOrderedPlanRecords(records: ProductionPlanRecord[]) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftSequence = Number(left.record.sequence ?? left.index);
      const rightSequence = Number(right.record.sequence ?? right.index);
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return left.index - right.index;
    })
    .map(({ record }) => record);
}

function normalizeDashboardPartNo(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

function getMachiningEquipmentKey(value: string | null | undefined) {
  const text = String(value ?? "").trim().toUpperCase();
  const match = text.match(/[A-Z]/);
  return match ? match[0] : text;
}

function getProgressLabel(status: RealtimeProgressSegmentStatus, copy: Record<string, string>) {
  if (status === "completed") return copy.completed;
  if (status === "in_progress") return copy.inProgress;
  return copy.pending;
}

function getProgressTooltip(lines: Array<string | null | undefined>) {
  return lines.filter(Boolean).join("\n");
}

function sumPlannedQuantity(summary: ProductionPlanSummaryResponse | undefined, bucket: "injection" | "machining", date: string) {
  const dailyTotal = summary?.[bucket].daily_totals.find((item) => item.date === date);
  if (dailyTotal) return Number(dailyTotal.plan_qty ?? 0);
  return summary?.[bucket].records.reduce((sum, record) => sum + Number(record.planned_quantity ?? 0), 0) ?? 0;
}

function buildProductionBriefContext(
  businessDate: string,
  planSummary: ProductionPlanSummaryResponse | undefined,
  mesData: InjectionProductionMatrix | undefined,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  productionStatus: ProductionStatusResponse | undefined,
): ProductionBriefContext {
  const latestTime = getLatestTime(mesData);
  const productionDayStart = getBusinessDayStart(businessDate);
  const productionDayEnd = getBusinessDayReferenceEnd(businessDate, mesData);
  const recentStart = latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null;
  const machineOutputs = mesData?.machines.map((machine) => {
    const key = String(machine.machine_number);
    let shiftOutput = 0;
    let recentOutput = 0;

    mesData.time_slots.forEach((slot, index) => {
      const slotTime = new Date(slot.time);
      const output = numberAt(mesData.actual_production_matrix[key], index);
      if (slotTime >= productionDayStart && slotTime <= productionDayEnd) {
        shiftOutput += output;
      }
      if (recentStart && latestTime && slotTime >= recentStart && slotTime <= latestTime) {
        recentOutput += output;
      }
    });

    return {
      machine: `${machine.machine_number}호기`,
      output: shiftOutput,
      recentOutput,
    };
  }) ?? [];
  const realtimeSummary = buildRealtimeProgressSummary(planSummary, mesData, productionStatus, businessDate);
  const actualMachineOutputs = realtimeSummary.rows
    .filter((row) => row.estimatedQty > 0)
    .map((row) => ({ machine: row.label, output: row.estimatedQty }));
  const injectionPlanQty = realtimeSummary.plannedQty || sumPlannedQuantity(planSummary, "injection", businessDate);
  const actualInjectionOutput = realtimeSummary.estimatedQty;
  const machiningPlanQty = sumPlannedQuantity(planSummary, "machining", businessDate);
  const actualMachiningOutput = Number(machiningStats?.summary.total_mes ?? 0);
  const activeMachineCount = machineOutputs.filter((item) => item.output > 0).length;
  const runningMachineCount = machineOutputs.filter((item) => item.recentOutput > 0).length;
  const sortedActiveMachines = actualMachineOutputs
    .filter((item) => item.output > 0)
    .sort((a, b) => b.output - a.output);

  return {
    businessDate,
    injectionPlanQty,
    machiningPlanQty,
    actualInjectionOutput,
    actualMachiningOutput,
    planGap: actualInjectionOutput - injectionPlanQty,
    machiningPlanGap: actualMachiningOutput - machiningPlanQty,
    activeMachineCount,
    runningMachineCount,
    totalMachines: mesData?.machines.length || 17,
    topMachines: sortedActiveMachines.slice(0, 4).map(({ machine, output }) => ({ machine, output })),
    lowOutputMachines: sortedActiveMachines.slice(-4).map(({ machine, output }) => ({ machine, output })),
    latestUpdatedAt: latestTime?.toISOString() ?? null,
  };
}

function buildMachiningProgressPreview(
  planSummary: ProductionPlanSummaryResponse | undefined,
  machiningStats: ProductionMesReportStatsResponse | undefined,
): MachiningProgressPreview {
  const planMap = new Map<string, {
    label: string;
    plannedQty: number;
    records: ProductionPlanRecord[];
  }>();
  const plannedKeys = new Set<string>();
  const plannedParts = new Set<string>();

  for (const record of planSummary?.machining.records ?? []) {
    const key = record.machine_name || "unknown";
    const current = planMap.get(key) ?? {
      label: record.machine_name || "-",
      plannedQty: 0,
      records: [],
    };
    current.plannedQty += Number(record.planned_quantity ?? 0);
    current.records.push(record);
    planMap.set(key, current);

    const equipmentKey = getMachiningEquipmentKey(record.machine_name);
    const partNo = normalizeDashboardPartNo(record.part_no);
    if (partNo) {
      plannedParts.add(partNo);
    }
    if (equipmentKey && partNo) {
      plannedKeys.add(`${equipmentKey}|${partNo}`);
    }
  }

  const exactMesQtyByKey = new Map<string, number>();
  const orphanMesQtyByPart = new Map<string, number>();
  const mesOnlyRows: MachiningProgressPreview["rows"] = [];

  for (const row of machiningStats?.rows ?? []) {
    const equipmentKey = getMachiningEquipmentKey(row.equipment_key || row.equipment_name);
    const partNo = normalizeDashboardPartNo(row.part_no);
    const mesQty = Number(row.mes_qty ?? 0);
    if (!equipmentKey || !partNo || mesQty <= 0) continue;

    const key = `${equipmentKey}|${partNo}`;
    exactMesQtyByKey.set(key, (exactMesQtyByKey.get(key) ?? 0) + mesQty);
    if (!plannedKeys.has(key)) {
      orphanMesQtyByPart.set(partNo, (orphanMesQtyByPart.get(partNo) ?? 0) + mesQty);
      if (row.compare_status === "mes_only" && !plannedParts.has(partNo)) {
        const segment: RealtimeProgressSegment = {
          key: `mes-only-${key}`,
          sequence: 1,
          partNo: row.part_no || "-",
          modelName: row.model_name || "-",
          lotNo: "-",
          productFamilyCode: null,
          productFamilyName: null,
          isFinishedProduct: false,
          plannedQty: 0,
          cavity: 1,
          requiredShots: 0,
          allocatedShots: mesQty,
          estimatedQty: mesQty,
          progressRate: 100,
          status: "completed",
        };
        mesOnlyRows.push({
          key: `mes-only-${key}`,
          label: row.equipment_label || row.equipment_name || row.equipment_key || "-",
          plannedQty: 0,
          actualQty: mesQty,
          gapQty: mesQty,
          progressRate: 100,
          completedCount: 1,
          inProgressCount: 0,
          pendingCount: 0,
          segments: [segment],
        });
      }
    }
  }

  const rows = [...planMap.entries()]
    .map(([key, plan]) => ({
      key,
      label: plan.label,
      plannedQty: plan.plannedQty,
      actualQty: 0,
      gapQty: 0,
      progressRate: 0,
      completedCount: 0,
      inProgressCount: 0,
      pendingCount: 0,
      segments: getOrderedPlanRecords(plan.records).map((record, index) => {
        const segmentPlannedQty = Number(record.planned_quantity ?? 0);
        const partNo = normalizeDashboardPartNo(record.part_no);
        const equipmentKey = getMachiningEquipmentKey(record.machine_name);
        const exactKey = `${equipmentKey}|${partNo}`;
        const exactRemaining = exactMesQtyByKey.get(exactKey) ?? 0;
        const orphanRemaining = orphanMesQtyByPart.get(partNo) ?? 0;
        const availableQty = exactRemaining > 0 ? exactRemaining : orphanRemaining;
        const estimatedQty = Math.min(segmentPlannedQty, Math.max(0, availableQty));

        if (exactRemaining > 0) {
          exactMesQtyByKey.set(exactKey, Math.max(0, exactRemaining - estimatedQty));
        } else if (orphanRemaining > 0) {
          orphanMesQtyByPart.set(partNo, Math.max(0, orphanRemaining - estimatedQty));
        }

        const progressRate = segmentPlannedQty > 0 ? (estimatedQty / segmentPlannedQty) * 100 : 0;
        const status: RealtimeProgressSegmentStatus = estimatedQty >= segmentPlannedQty && segmentPlannedQty > 0
          ? "completed"
          : estimatedQty > 0
            ? "in_progress"
            : "pending";
        return {
          key: `${record.id ?? index}-${record.part_no ?? record.model_name ?? "part"}`,
          sequence: index + 1,
          partNo: record.part_no || record.model_name || record.part_spec || "-",
          modelName: record.model_name || record.part_spec || "-",
          lotNo: record.lot_no || "-",
          productFamilyCode: record.product_family_code || null,
          productFamilyName: record.product_family_name || null,
          isFinishedProduct: Boolean(record.is_finished_product),
          plannedQty: segmentPlannedQty,
          cavity: Math.max(1, Number(record.cavity ?? 1) || 1),
          requiredShots: segmentPlannedQty,
          allocatedShots: estimatedQty,
          estimatedQty,
          progressRate,
          status,
        };
      }),
    }))
    .map((row) => {
      const actualQty = row.segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
      const completedCount = row.segments.filter((segment) => segment.status === "completed").length;
      const inProgressCount = row.segments.filter((segment) => segment.status === "in_progress").length;
      const pendingCount = row.segments.filter((segment) => segment.status === "pending").length;
      const extraExactKeys = new Set<string>();
      const extraPartKeys = new Set<string>();
      const extraQty = getOrderedPlanRecords(planMap.get(row.key)?.records ?? []).reduce((sum, record) => {
        const partNo = normalizeDashboardPartNo(record.part_no);
        const equipmentKey = getMachiningEquipmentKey(record.machine_name);
        const exactKey = `${equipmentKey}|${partNo}`;
        let extra = 0;
        if (!extraExactKeys.has(exactKey)) {
          extra += exactMesQtyByKey.get(exactKey) ?? 0;
          exactMesQtyByKey.set(exactKey, 0);
          extraExactKeys.add(exactKey);
        }
        if (partNo && !extraPartKeys.has(partNo)) {
          extra += orphanMesQtyByPart.get(partNo) ?? 0;
          orphanMesQtyByPart.set(partNo, 0);
          extraPartKeys.add(partNo);
        }
        return sum + extra;
      }, 0);
      const totalActualQty = actualQty + extraQty;
      return {
        ...row,
        actualQty: totalActualQty,
        gapQty: totalActualQty - row.plannedQty,
        progressRate: row.plannedQty > 0 ? (totalActualQty / row.plannedQty) * 100 : 0,
        completedCount,
        inProgressCount,
        pendingCount,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" }));

  const allRows = [...rows, ...mesOnlyRows]
    .sort((left, right) => left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" }));
  const plannedQty = allRows.reduce((sum, row) => sum + row.plannedQty, 0);
  const actualQty = allRows.reduce((sum, row) => sum + row.actualQty, 0);

  return {
    plannedQty,
    actualQty,
    partCount: allRows.reduce((sum, row) => sum + row.segments.length, 0),
    progressRate: plannedQty > 0 ? (actualQty / plannedQty) * 100 : 0,
    completedCount: allRows.reduce((sum, row) => sum + row.completedCount, 0),
    inProgressCount: allRows.reduce((sum, row) => sum + row.inProgressCount, 0),
    pendingCount: allRows.reduce((sum, row) => sum + row.pendingCount, 0),
    rows: allRows,
  };
}

async function requestLocalDashboardIntent(question: string, businessDate: string) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 18_000);
  const systemPrompt = [
    "You convert Korean/Chinese manufacturing questions into JSON only.",
    "Do not answer or calculate.",
    "Schema:",
    '{"intent":"injection_cycle_time|production_output|production_status|production_summary|unknown","metric":"recent_60m_avg_ct_sec|estimated_qty|running_count|progress_rate|null","filters":{"running_only":true,"product_family":"BC|CA|GP|null","target_text":"part/model/machine text or null","machine":"machine text or null"},"sort":"ct_desc|ct_asc|output_desc|output_asc|null","limit":number}',
    `Default business_date is ${businessDate}.`,
    "Glossary: B/C/back cover/백커버=BC, C/A/cabinet=CA, G/P/guide panel=GP. C/T/ct/节拍/周期 means cycle time.",
  ].join(" ");

  try {
    const response = await fetch(`${LOCAL_LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL,
        temperature: 0,
        max_tokens: 220,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              'Q: 오늘 생산중인 사출기의 수는?\nA: {"intent":"production_status","metric":"running_count","filters":{"running_only":true,"product_family":null,"target_text":null,"machine":null},"sort":null,"limit":17}',
              'Q: 지금 백커버 만드는 기계 중 제일 느린 거 뭐야?\nA: {"intent":"injection_cycle_time","metric":"recent_60m_avg_ct_sec","filters":{"running_only":true,"product_family":"BC","target_text":null,"machine":null},"sort":"ct_desc","limit":1}',
              'Q: 24g411 오늘 얼마나 나왔어?\nA: {"intent":"production_output","metric":"estimated_qty","filters":{"running_only":false,"product_family":null,"target_text":"24G411","machine":null},"sort":"output_desc","limit":8}',
              'Q: 오늘 생산 진도 어때?\nA: {"intent":"production_summary","metric":"progress_rate","filters":{"running_only":false,"product_family":null,"target_text":null,"machine":null},"sort":null,"limit":8}',
              `Q: ${question}\nA:`,
            ].join("\n"),
          },
        ],
      }),
    });
    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "");
    const parsed = normalizeDashboardIntent(extractJsonObject(content) as Partial<DashboardAiIntent>);
    if (parsed.intent !== "unknown") return parsed;
  } catch {
    // Fall through to the heuristic parser so local tests do not get blocked by MLX latency.
  } finally {
    window.clearTimeout(timeoutId);
  }

  return heuristicDashboardIntent(question);
}

function matchesPartTarget(segment: RealtimeProgressSegment | undefined, targetText: string | null | undefined) {
  if (!targetText) return true;
  if (!segment) return false;
  const needle = targetText.toUpperCase();
  const haystack = `${segment.partNo} ${segment.modelName}`.toUpperCase();
  return haystack.includes(needle);
}

function answerDashboardIntent(intent: DashboardAiIntent, realtimeProgress: RealtimeProgressSummary, language: AppLanguage) {
  const isChinese = language === "zh";
  const productFamily = intent.filters.product_family;
  const targetText = intent.filters.target_text;

  if (intent.intent === "production_status") {
    const runningRows = realtimeProgress.rows.filter((row) => {
      if (!row.isRunning) return false;
      const current = row.segments.find((segment) => segment.status === "in_progress");
      if (productFamily && current?.productFamilyCode !== productFamily) return false;
      return true;
    });
    const labels = runningRows.map((row) => row.label).join(", ") || "-";
    return isChinese
      ? `最近60分钟合模数 기준 현재 생산중인 사출기는 ${runningRows.length}대입니다. 대상 설비: ${labels}.`
      : `최근 60분 형합수 기준 현재 생산중인 사출기는 ${runningRows.length}대입니다. 대상 설비는 ${labels}입니다.`;
  }

  if (intent.intent === "injection_cycle_time") {
    const rows = realtimeProgress.rows
      .map((row) => ({ row, current: row.segments.find((segment) => segment.status === "in_progress") }))
      .filter(({ row, current }) => {
        if (intent.filters.running_only && !row.isRunning) return false;
        if (productFamily && current?.productFamilyCode !== productFamily) return false;
        if (!matchesPartTarget(current, targetText)) return false;
        return row.recentCycleTimeSec !== null;
      })
      .map(({ row, current }) => ({
        machine: row.label,
        partNo: current?.partNo ?? "-",
        modelName: current?.modelName ?? "-",
        family: current?.productFamilyName ?? "-",
        shots: row.recentShots,
        ct: row.recentCycleTimeSec ?? 0,
      }));

    if (intent.sort === "ct_desc") rows.sort((a, b) => b.ct - a.ct);
    if (intent.sort === "ct_asc") rows.sort((a, b) => a.ct - b.ct);
    if (!rows.length) return isChinese ? "未找到符合条件的最近60分钟 C/T 数据。" : "조건에 맞는 최근 60분 C/T 데이터를 찾지 못했습니다.";
    if (intent.limit === 1 || intent.sort === "ct_desc" || intent.sort === "ct_asc") {
      const top = rows[0];
      return isChinese
        ? `最近60分钟 기준 ${top.machine} 的 C/T 约 ${top.ct.toFixed(1)} 秒，当前推定 Part 为 ${top.partNo}（${top.modelName}，${top.family}），60分钟合模数 ${top.shots} 次。`
        : `최근 60분 기준 ${top.machine}의 평균 C/T는 약 ${top.ct.toFixed(1)}초입니다. 현재 추정 Part는 ${top.partNo} (${top.modelName}, ${top.family})이고, 최근 60분 형합수는 ${formatNumber(top.shots)}회입니다.`;
    }
    const averageCt = rows.reduce((sum, row) => sum + row.ct, 0) / rows.length;
    const details = rows.slice(0, intent.limit ?? 8).map((row) => `${row.machine} ${row.ct.toFixed(1)}초`).join(", ");
    return `최근 60분 기준 대상 사출기 ${rows.length}대의 평균 C/T는 약 ${averageCt.toFixed(1)}초입니다. 설비별로는 ${details}입니다.`;
  }

  if (intent.intent === "production_output") {
    const items = realtimeProgress.rows.flatMap((row) => row.segments
      .filter((segment) => {
        if (productFamily && segment.productFamilyCode !== productFamily) return false;
        if (!matchesPartTarget(segment, targetText)) return false;
        return true;
      })
      .map((segment) => ({
        machine: row.label,
        partNo: segment.partNo,
        estimatedQty: segment.estimatedQty,
        plannedQty: segment.plannedQty,
      })));
    items.sort((a, b) => b.estimatedQty - a.estimatedQty);
    if (!items.length) return isChinese ? "未找到符合条件的生产计划或 MES 推定实绩。" : "조건에 맞는 생산계획 또는 MES 추정 실적을 찾지 못했습니다.";
    const totalEstimated = items.reduce((sum, item) => sum + item.estimatedQty, 0);
    const totalPlanned = items.reduce((sum, item) => sum + item.plannedQty, 0);
    const details = items.slice(0, intent.limit ?? 8).map((item) => `${item.machine} ${item.partNo} ${formatNumber(item.estimatedQty)}/${formatNumber(item.plannedQty)}개`).join(", ");
    return `기준일 현재 추정 생산량은 총 ${formatNumber(totalEstimated)}개이고, 계획은 ${formatNumber(totalPlanned)}개입니다. 설비별 주요 내역은 ${details}입니다.`;
  }

  if (intent.intent === "production_summary") {
    const segments = realtimeProgress.rows.flatMap((row) => row.segments)
      .filter((segment) => !productFamily || segment.productFamilyCode === productFamily);
    const plannedQty = segments.reduce((sum, segment) => sum + segment.plannedQty, 0);
    const estimatedQty = segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
    const progressRate = plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : 0;
    const completed = segments.filter((segment) => segment.status === "completed").length;
    const inProgress = segments.filter((segment) => segment.status === "in_progress").length;
    const pending = segments.filter((segment) => segment.status === "pending").length;
    const runningRows = realtimeProgress.rows.filter((row) => row.isRunning);
    const topRows = [...realtimeProgress.rows]
      .filter((row) => row.estimatedQty > 0)
      .sort((a, b) => b.estimatedQty - a.estimatedQty)
      .slice(0, 4)
      .map((row) => `${row.label} ${formatNumber(row.estimatedQty)}개`)
      .join(", ") || "-";
    return isChinese
      ? `今天注塑进度约 ${Math.round(progressRate)}%，推定实绩 ${formatNumber(estimatedQty)} / 计划 ${formatNumber(plannedQty)} 个。最近60分钟运行设备 ${runningRows.length}台，状态为完成 ${completed}、进行中 ${inProgress}、待开始 ${pending}。主要生产设备: ${topRows}。`
      : `오늘 사출 생산 진도는 약 ${Math.round(progressRate)}%입니다. 추정 실적은 ${formatNumber(estimatedQty)} / 계획 ${formatNumber(plannedQty)}개이고, 최근 60분 기준 가동 사출기는 ${runningRows.length}대입니다. 작업 상태는 완료 ${completed}건, 진행중 ${inProgress}건, 대기 ${pending}건이며, 상위 생산 설비는 ${topRows}입니다.`;
  }

  return null;
}

async function answerWithLocalMlxFallback(question: string, businessDate: string, realtimeProgress: RealtimeProgressSummary, language: AppLanguage) {
  const intent = await requestLocalDashboardIntent(question, businessDate);
  const answer = answerDashboardIntent(intent, realtimeProgress, language);
  return answer ?? (language === "ko"
    ? "질문 의도는 해석했지만 현재 대시보드 데이터로 계산 가능한 답을 찾지 못했습니다."
    : "已解析问题意图，但当前看板数据无法计算出答案。");
}

function buildRuleBasedBrief(context: ProductionBriefContext, language: AppLanguage) {
  const planRate = context.injectionPlanQty > 0
    ? Math.round((context.actualInjectionOutput / context.injectionPlanQty) * 100)
    : 0;
  const unit = language === "ko" ? "개" : "个";
  const gapText = context.planGap >= 0
    ? (language === "ko" ? `계획 대비 ${formatNumber(context.planGap)}${unit} 초과` : `较计划超出 ${formatNumber(context.planGap)}${unit}`)
    : (language === "ko" ? `계획 대비 ${formatNumber(Math.abs(context.planGap))}${unit} 부족` : `较计划不足 ${formatNumber(Math.abs(context.planGap))}${unit}`);
  const topText = context.topMachines.length
    ? context.topMachines.map((item) => `${item.machine} ${formatNumber(item.output)}${unit}`).join(", ")
    : (language === "ko" ? "생산 실적 없음" : "暂无生产实绩");
  const lowText = context.lowOutputMachines.length
    ? context.lowOutputMachines.map((item) => `${item.machine} ${formatNumber(item.output)}${unit}`).join(", ")
    : (language === "ko" ? "확인 대상 없음" : "暂无需确认设备");

  if (language === "zh") {
    return [
      `${context.businessDate} 基准日注塑实绩为 ${formatNumber(context.actualInjectionOutput)}${unit}，对比注塑计划 ${formatNumber(context.injectionPlanQty)}${unit}，进度约 ${planRate}%。加工实绩为 ${formatNumber(context.actualMachiningOutput)}${unit}，计划为 ${formatNumber(context.machiningPlanQty)}${unit}。`,
      `基准日 ${context.activeMachineCount}/${context.totalMachines} 台设备有生产实绩，区间最后 60 分钟运行设备为 ${context.runningMachineCount} 台。当前为${gapText}。`,
      `主要生产设备为 ${topText}。低实绩设备为 ${lowText}，如计划存在缺口，建议优先确认停机记录与作业安排。`,
    ].join("\n\n");
  }

  return [
    `${context.businessDate} 기준일의 사출 실적은 ${formatNumber(context.actualInjectionOutput)}${unit}이며, 사출 계획 ${formatNumber(context.injectionPlanQty)}${unit} 대비 진행률은 약 ${planRate}%입니다. 가공 실적은 ${formatNumber(context.actualMachiningOutput)}${unit}, 가공 계획은 ${formatNumber(context.machiningPlanQty)}${unit}입니다.`,
    `기준일에 ${context.activeMachineCount}/${context.totalMachines}대가 생산 실적을 남겼고, 선택 구간 마지막 60분 기준 가동 설비는 ${context.runningMachineCount}대입니다. ${gapText} 상태입니다.`,
    `상위 생산 설비는 ${topText}입니다. 낮은 실적 설비는 ${lowText}이며, 계획 대비 부족 상태라면 해당 설비의 정지 이력과 작업 배정을 먼저 확인하는 것이 좋습니다.`,
  ].join("\n\n");
}

function ProductionDashboardSkeleton({ copy }: { copy: Record<string, string> }) {
  return (
    <div className="production-dashboard-skeleton" aria-label={copy.loading} role="status">
      <div className="stats-grid">
        {[0, 1, 2, 3].map((item) => (
          <article className="stat-card production-skeleton-card" key={item}>
            <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
            <span className="mes-skeleton-line mes-skeleton-line--value" />
            <span className="mes-skeleton-line" />
          </article>
        ))}
      </div>

      <section className="panel production-brief-panel">
        <div className="production-brief-panel__header">
          <div className="mes-skeleton-heading">
            <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
            <span className="mes-skeleton-line mes-skeleton-line--title" />
          </div>
          <span className="mes-skeleton-line production-skeleton-button" />
        </div>
        <div className="production-brief-panel__body production-skeleton-brief">
          <span className="mes-skeleton-line mes-skeleton-line--wide" />
          <span className="mes-skeleton-line" />
          <span className="mes-skeleton-line mes-skeleton-line--short" />
        </div>
      </section>

      <section className="panel production-progress-panel">
        <div className="mes-skeleton-heading">
          <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
          <span className="mes-skeleton-line mes-skeleton-line--title" />
        </div>
        <div className="production-progress-grid">
          {[0, 1].map((card) => (
            <article className="production-progress-card" key={card}>
              <div className="production-progress-visual-summary">
                <span className="production-skeleton-ring" />
                <div className="mes-skeleton-heading">
                  <span className="mes-skeleton-line mes-skeleton-line--title" />
                  <span className="mes-skeleton-line" />
                  <span className="mes-skeleton-line mes-skeleton-line--short" />
                </div>
              </div>
              <div className="production-progress-list">
                {[0, 1, 2, 3].map((row) => (
                  <div className="production-progress-row production-skeleton-row" key={row}>
                    <div className="production-progress-row__head">
                      <span className="mes-skeleton-line mes-skeleton-line--short" />
                      <span className="mes-skeleton-line production-skeleton-pill" />
                    </div>
                    <span className="mes-skeleton-line production-skeleton-track" />
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ProductionDashboardPage() {
  const queryClient = useQueryClient();
  const [language] = useStoredLanguage();
  const currentDate = getShanghaiDateString();
  const [businessDate, setBusinessDate] = useState(currentDate);
  const [isAiAskOpen, setIsAiAskOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [activeAiJobId, setActiveAiJobId] = useState<number | null>(null);
  const [selectedProgressRow, setSelectedProgressRow] = useState<RealtimeProgressRow | null>(null);
  const copy = pageCopy[language];
  const isCurrentDate = businessDate === currentDate;
  const planSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", businessDate],
    queryFn: () => getProductionPlanSummary(businessDate),
  });
  const productionStatusQuery = useQuery({
    queryKey: ["production-status", businessDate],
    queryFn: () => getProductionStatus(businessDate),
    refetchInterval: isCurrentDate ? 60_000 : false,
  });
  const machiningStatsQuery = useQuery({
    queryKey: ["production-mes-report-stats", "machining", businessDate],
    queryFn: () => getProductionMesReportStats(businessDate, "machining"),
  });
  const mesQuery = useQuery({
    queryKey: ["mes", "production-dashboard-matrix", businessDate, isCurrentDate],
    queryFn: () => (isCurrentDate ? getInjectionProductionMatrix() : getInjectionProductionMatrixForDate(businessDate)),
    refetchInterval: isCurrentDate ? 60_000 : false,
  });
  const isDashboardDataReady = planSummaryQuery.isSuccess && mesQuery.isSuccess && machiningStatsQuery.isSuccess && productionStatusQuery.isSuccess;
  const aiBriefingQuery = useQuery({
    queryKey: ["production", "ai-briefing", businessDate, language],
    queryFn: () => getProductionAiBriefing(businessDate, language),
    enabled: isDashboardDataReady,
    refetchInterval: isCurrentDate && isDashboardDataReady ? 5 * 60_000 : false,
    retry: 1,
  });
  const aiJobQuery = useQuery({
    queryKey: ["ai-job", activeAiJobId],
    queryFn: () => getAiJob(activeAiJobId ?? 0),
    enabled: Boolean(activeAiJobId),
    refetchInterval: (query) => {
      const job = query.state.data as AiJob | undefined;
      return job && !isAiJobTerminal(job.status) ? 3_000 : false;
    },
  });
  const createAiJobMutation = useMutation({
    mutationFn: () => createAiJob({
      job_type: "production_daily_analysis",
      scope: { date: businessDate, language },
    }),
    onSuccess: (job) => {
      setActiveAiJobId(job.id);
      queryClient.setQueryData(["ai-job", job.id], job);
    },
  });
  const cancelAiJobMutation = useMutation({
    mutationFn: (jobId: number) => cancelAiJob(jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(["ai-job", job.id], job);
    },
  });

  const briefContext = useMemo(
    () => buildProductionBriefContext(
      businessDate,
      planSummaryQuery.data,
      mesQuery.data,
      machiningStatsQuery.data,
      productionStatusQuery.data,
    ),
    [businessDate, machiningStatsQuery.data, mesQuery.data, planSummaryQuery.data, productionStatusQuery.data],
  );
  const realtimeProgress = useMemo(
    () => buildRealtimeProgressSummary(planSummaryQuery.data, mesQuery.data, productionStatusQuery.data, businessDate),
    [businessDate, mesQuery.data, planSummaryQuery.data, productionStatusQuery.data],
  );
  const machiningProgress = useMemo(
    () => buildMachiningProgressPreview(planSummaryQuery.data, machiningStatsQuery.data),
    [machiningStatsQuery.data, planSummaryQuery.data],
  );
  const ruleBasedBrief = useMemo(() => buildRuleBasedBrief(briefContext, language), [briefContext, language]);
  const briefingText = aiBriefingQuery.data?.answer || ruleBasedBrief;
  const activeAiJob = aiJobQuery.data;
  const activeAiJobResult = activeAiJob?.result_payload ?? {};
  const activeAiJobSummary = getStringField(activeAiJobResult, "summary");
  const activeAiJobTopIssues = getTopIssues(activeAiJobResult);
  const aiQuestionMutation = useMutation({
    mutationFn: async () => {
      try {
        const response = await askProductionAi(businessDate, aiQuestion, language);
        if (response.source !== "timeout_or_llm_error") {
          return response;
        }
      } catch {
        // In local development the API may still point to Render, which cannot reach this Mac's MLX server.
      }
      const answer = await answerWithLocalMlxFallback(aiQuestion, businessDate, realtimeProgress, language);
      return { answer, source: "local_llm" as const };
    },
    onSuccess: (payload) => setAiAnswer(payload.answer),
  });

  useEffect(() => {
    setAiAnswer(null);
  }, [language, briefContext.businessDate, briefContext.latestUpdatedAt]);

  useEffect(() => {
    setActiveAiJobId(null);
  }, [businessDate, language]);

  function submitAiQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!aiQuestion.trim() || aiQuestionMutation.isPending) return;
    aiQuestionMutation.mutate();
  }

  const isLoading = planSummaryQuery.isLoading || mesQuery.isLoading || machiningStatsQuery.isLoading || productionStatusQuery.isLoading;
  const injectionCompletionRate = briefContext.injectionPlanQty > 0
    ? (briefContext.actualInjectionOutput / briefContext.injectionPlanQty) * 100
    : 0;
  const machiningCompletionRate = briefContext.machiningPlanQty > 0
    ? (briefContext.actualMachiningOutput / briefContext.machiningPlanQty) * 100
    : 0;
  const productionElapsedRate = getProductionElapsedRate(businessDate, mesQuery.data);
  const injectionRateTone = getRateTone(injectionCompletionRate, productionElapsedRate);
  const activeMachiningLineCount = new Set(
    (machiningStatsQuery.data?.rows ?? [])
      .filter((row) => Number(row.mes_qty ?? 0) > 0)
      .map((row) => row.equipment_label || row.equipment_name || row.equipment_key)
      .filter(Boolean),
  ).size;

  function getRingStyle(progressRate: number) {
    const degree = Math.max(0, Math.min(100, progressRate)) * 3.6;
    return { "--progress-deg": `${degree}deg` } as CSSProperties;
  }

  function renderOverrunChip(quantity: number) {
    if (quantity <= 0) return null;
    return (
      <span className="production-progress-chip production-progress-chip--overrun">
        {copy.overrunShort} +{formatNumber(quantity)}
      </span>
    );
  }

  function renderProgressSegment(segment: RealtimeProgressSegment, row: { plannedQty: number } | null) {
    const tooltip = getProgressTooltip([
      `${copy.currentPart} ${segment.sequence} · ${getProgressLabel(segment.status, copy)}`,
      `Part No: ${segment.partNo}`,
      `${language === "ko" ? "모델" : "型号"}: ${segment.modelName}`,
      `${copy.estimatedVsPlan}: ${formatNumber(segment.estimatedQty)} / ${formatNumber(segment.plannedQty)}`,
      `${copy.progress}: ${Math.round(segment.progressRate)}%`,
      `${copy.cavity}: ${segment.cavity}`,
    ]);
    const share = row && row.plannedQty > 0 ? segment.plannedQty / row.plannedQty : 0;

    return (
      <span
        className={`production-part-segment production-part-segment--${segment.status}`}
        data-tooltip={tooltip}
        key={segment.key}
        style={{ flexGrow: Math.max(segment.plannedQty, 1) }}
      >
        <span
          className="production-part-segment__fill"
          style={{ width: `${Math.max(0, Math.min(100, segment.progressRate))}%` }}
        />
        {share > 0.18 ? <em>{segment.partNo}</em> : null}
      </span>
    );
  }

  function renderProgressRow(row: RealtimeProgressRow) {
    const progress = Math.max(0, Math.min(100, row.progressRate));
    const currentSegment = row.segments.find((segment) => segment.status === "in_progress");

    return (
      <article className="production-progress-row" key={row.key}>
        <div className="production-progress-row__head">
          <div className="production-progress-row__identity">
            <div className="production-progress-row__title">
              <strong>{row.label}</strong>
              <button
                aria-label={`${row.label} ${copy.detail}`}
                className="production-progress-detail-button"
                onClick={() => setSelectedProgressRow(row)}
                type="button"
              >
                {copy.detail}
              </button>
            </div>
            <span>{currentSegment ? `${copy.currentPart} ${currentSegment.partNo}` : copy.partProgress}</span>
          </div>
          <div className="production-progress-row__state">
            <span>{Math.round(progress)}%</span>
            <em className={row.isRunning ? "production-progress-status production-progress-status--running" : "production-progress-status"}>
              {row.isRunning ? copy.running : "-"}
            </em>
          </div>
        </div>
        <div className={`production-part-track${row.gapQty > 0 ? " production-part-track--overrun" : ""}`} aria-label={`${row.label} ${Math.round(row.progressRate)}%`}>
          {row.segments.length ? row.segments.map((segment) => renderProgressSegment(segment, row)) : (
            <span className="production-part-segment production-part-segment--pending" style={{ flexGrow: 1 }}>
              <span className="production-part-segment__fill" style={{ width: `${progress}%` }} />
            </span>
          )}
          {row.gapQty > 0 ? (
            <span
              className="production-part-overrun"
              data-tooltip={`${copy.overrun}: +${formatNumber(row.gapQty)}`}
              style={{ flexGrow: Math.max(row.gapQty, 1) }}
            >
              <span />
            </span>
          ) : null}
        </div>
        <div className="production-progress-state-strip">
          <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {row.completedCount}</span>
          <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {row.inProgressCount}</span>
          <span className="production-progress-chip">{copy.pending} {row.pendingCount}</span>
          {renderOverrunChip(row.gapQty)}
        </div>
      </article>
    );
  }

  function renderMachiningPreviewRow(row: MachiningProgressPreview["rows"][number]) {
    const progress = Math.max(0, Math.min(100, row.progressRate));
    const currentSegment = row.segments.find((segment) => segment.status === "in_progress");
    const isActive = row.inProgressCount > 0;
    return (
      <article className="production-progress-row production-progress-row--preview" key={row.key}>
        <div className="production-progress-row__head">
          <div>
            <strong>{row.label}</strong>
            <span>{currentSegment ? `${copy.currentPart} ${currentSegment.partNo}` : `${copy.actualEstimate} ${formatNumber(row.actualQty)} / ${formatNumber(row.plannedQty)}`}</span>
          </div>
          <div className="production-progress-row__state">
            <span>{Math.round(progress)}%</span>
            <em className={isActive ? "production-progress-status production-progress-status--running" : "production-progress-status"}>
              {isActive ? copy.running : "-"}
            </em>
          </div>
        </div>
        <div className={`production-part-track${row.gapQty > 0 ? " production-part-track--overrun" : " production-part-track--preview"}`}>
          {row.segments.map((segment) => renderProgressSegment(segment, { plannedQty: row.plannedQty }))}
          {row.gapQty > 0 ? (
            <span
              className="production-part-overrun"
              data-tooltip={`${copy.overrun}: +${formatNumber(row.gapQty)}`}
              style={{ flexGrow: Math.max(row.gapQty, 1) }}
            >
              <span />
            </span>
          ) : null}
        </div>
        <div className="production-progress-state-strip">
          <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {row.completedCount}</span>
          <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {row.inProgressCount}</span>
          <span className="production-progress-chip">{copy.pending} {row.pendingCount}</span>
          {renderOverrunChip(row.gapQty)}
        </div>
      </article>
    );
  }

  return (
    <section className="page production-dashboard">
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.description}
      />

      {isLoading ? <ProductionDashboardSkeleton copy={copy} /> : null}

      {!isLoading ? (
        <>
          <div className="stats-grid">
            <label className="stat-card production-date-card">
              <span className="stat-card__title">{copy.productionDate}</span>
              <input
                type="date"
                value={businessDate}
                max={currentDate}
                onChange={(event) => setBusinessDate(event.target.value || currentDate)}
              />
              <span className="stat-card__hint">{copy.productionDateHint}</span>
            </label>
            <StatCard
              hint={`${copy.completedRate} ${Math.round(injectionCompletionRate)}% · ${copy.timeRate} ${Math.round(productionElapsedRate)}%`}
              hintTone={injectionRateTone}
              title={copy.injectionActualPlan}
              value={`${formatNumber(briefContext.actualInjectionOutput)} / ${formatNumber(briefContext.injectionPlanQty)}`}
            />
            <StatCard
              hint={`${copy.completedRate} ${Math.round(machiningCompletionRate)}%`}
              title={copy.machiningActualPlan}
              value={`${formatNumber(briefContext.actualMachiningOutput)} / ${formatNumber(briefContext.machiningPlanQty)}`}
            />
            <StatCard
              hint={`${copy.injectionFacilities} ${briefContext.activeMachineCount} · ${copy.machiningFacilities} ${activeMachiningLineCount}`}
              title={copy.activeMachines}
              value={`${briefContext.activeMachineCount}/${briefContext.totalMachines}`}
            />
          </div>

          <section className="panel production-brief-panel">
            <div className="production-brief-panel__header">
              <div>
                <p className="panel-card__eyebrow">{copy.localBrief}</p>
                <h3 className="panel__title">{copy.briefTitle}</h3>
              </div>
              <div className="production-brief-panel__actions">
                <button
                  className="button button--primary"
                  disabled={createAiJobMutation.isPending || Boolean(activeAiJob && !isAiJobTerminal(activeAiJob.status))}
                  type="button"
                  onClick={() => createAiJobMutation.mutate()}
                >
                  {createAiJobMutation.isPending ? copy.workerAnalysisRunning : copy.runWorkerAnalysis}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setIsAiAskOpen((isOpen) => !isOpen)}
                >
                  {isAiAskOpen ? copy.closeAi : copy.askAi}
                </button>
              </div>
            </div>

            <div className="production-brief-panel__body">
              {briefingText.split("\n\n").map((paragraph, index) => (
                <p key={`${paragraph.slice(0, 24)}-${index}`}>{paragraph}</p>
              ))}
            </div>

            <div className="production-brief-evidence">
              <span>{copy.deterministicBrief}</span>
              <details>
                <summary>{copy.usedData}</summary>
                <ul>
                  {(aiBriefingQuery.data?.used_data ?? []).map((item) => (
                    <li key={item.name}>
                      {item.name}: {formatNumber(item.row_count)}
                    </li>
                  ))}
                  {!aiBriefingQuery.data?.used_data?.length ? (
                    <li>{language === "ko" ? "백엔드 브리핑 연결 실패 시 화면 데이터로 계산한 초안을 표시합니다." : "后端简报连接失败时显示基于页面数据计算的草稿。"}</li>
                  ) : null}
                </ul>
              </details>
              <details>
                <summary>{copy.calculationBasis}</summary>
                <ul>
                  {(aiBriefingQuery.data?.calculation_basis ?? []).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                  {!aiBriefingQuery.data?.calculation_basis?.length ? (
                    <li>{language === "ko" ? "기준일 08:00 ~ 익일 08:00 기준으로 계산합니다." : "按基准日 08:00 ~ 次日 08:00 计算。"}</li>
                  ) : null}
                </ul>
              </details>
            </div>

            {isAiAskOpen ? (
              <form className="production-ai-ask" onSubmit={submitAiQuestion}>
                <textarea
                  onChange={(event) => setAiQuestion(event.target.value)}
                  placeholder={copy.aiQuestionPlaceholder}
                  rows={3}
                  value={aiQuestion}
                />
                <div className="production-ai-ask__actions">
                  <span>{language === "ko" ? "내부 생산 데이터 계산 + 로컬 MLX LLM" : "内部生产数据计算 + 本地 MLX LLM"}</span>
                  <button className="button button--primary" disabled={!aiQuestion.trim() || aiQuestionMutation.isPending} type="submit">
                    {aiQuestionMutation.isPending ? copy.askingAi : copy.aiSubmit}
                  </button>
                </div>
              </form>
            ) : null}

            {aiAnswer ? (
              <div className="production-ai-answer">
                <strong>{copy.aiAnswerTitle}</strong>
                {aiAnswer.split("\n\n").map((paragraph, index) => (
                  <p key={`${paragraph.slice(0, 24)}-${index}`}>{paragraph}</p>
                ))}
              </div>
            ) : null}

            {activeAiJob ? (
              <div className={`production-ai-job production-ai-job--${activeAiJob.status}`}>
                <div className="production-ai-job__header">
                  <div>
                    <strong>{copy.workerJobTitle}</strong>
                    <span>
                      {copy.workerJobStatus}: {getAiJobStatusLabel(activeAiJob.status, language)}
                      {activeAiJob.claimed_by ? ` · ${activeAiJob.claimed_by}` : ""}
                    </span>
                  </div>
                  {!isAiJobTerminal(activeAiJob.status) ? (
                    <button
                      className="button button--ghost button--mini"
                      disabled={cancelAiJobMutation.isPending}
                      onClick={() => cancelAiJobMutation.mutate(activeAiJob.id)}
                      type="button"
                    >
                      {copy.workerJobCancel}
                    </button>
                  ) : null}
                </div>

                {!isAiJobTerminal(activeAiJob.status) ? (
                  <p className="production-ai-job__message">{copy.workerJobWaiting}</p>
                ) : null}

                {activeAiJob.status === "completed" ? (
                  <div className="production-ai-job__result">
                    <strong>{copy.workerJobResult}</strong>
                    {activeAiJobResult.llm_fallback ? (
                      <div className="notice notice--warning">{copy.workerJobFallback}</div>
                    ) : null}
                    <p>{activeAiJobSummary || getStringField(activeAiJobResult, "title") || copy.workerJobNoIssue}</p>
                    <div className="production-ai-job__issues">
                      {activeAiJobTopIssues.length ? activeAiJobTopIssues.map((issue, index) => (
                        <div className="production-ai-job__issue" key={`${getStringField(issue, "label")}-${index}`}>
                          <span>{copy.workerJobIssue}</span>
                          <strong>{getStringField(issue, "label") || getStringField(issue, "type") || "-"}</strong>
                          <p>{getIssueText(issue)}</p>
                        </div>
                      )) : (
                        <div className="production-ai-job__issue">
                          <span>{copy.workerJobIssue}</span>
                          <strong>{copy.workerJobNoIssue}</strong>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeAiJob.status === "failed" ? (
                  <div className="notice notice--warning">{activeAiJob.error_message || copy.llmError}</div>
                ) : null}
              </div>
            ) : null}

            {aiQuestionMutation.isError ? (
              <div className="notice notice--warning">
                {copy.llmError}
              </div>
            ) : null}
          </section>

          <section className="panel production-progress-panel">
            <div className="production-progress-panel__header">
              <div>
                <p className="panel-card__eyebrow">{copy.progressEyebrow}</p>
                <div className="production-progress-title-line">
                  <h3 className="panel__title">{copy.progressTitle}</h3>
                  <span
                    className="production-progress-help"
                    data-tooltip={copy.progressDescription}
                    role="img"
                    aria-label={copy.progressDescription}
                  >
                    ?
                  </span>
                </div>
              </div>
            </div>

            <div className="production-progress-grid">
              <article className="production-progress-card">
                <div className="production-progress-visual-summary">
                  <div className={`production-progress-ring${realtimeProgress.estimatedQty > realtimeProgress.plannedQty ? " production-progress-ring--overrun" : ""}`} style={getRingStyle(realtimeProgress.progressRate)}>
                    <strong>{Math.round(realtimeProgress.progressRate)}%</strong>
                    <span>{copy.totalProgress}</span>
                  </div>
                  <div className="production-progress-summary-text">
                    <h4>{copy.injectionProgress}</h4>
                    <p>{copy.progressHint}</p>
                    <div className="production-progress-state-strip">
                      <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {realtimeProgress.completedCount}</span>
                      <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {realtimeProgress.inProgressCount}</span>
                      <span className="production-progress-chip">{copy.pending} {realtimeProgress.pendingCount}</span>
                      {renderOverrunChip(realtimeProgress.estimatedQty - realtimeProgress.plannedQty)}
                    </div>
                  </div>
                </div>
                <div className="production-progress-list">
                  {realtimeProgress.rows.length ? (
                    realtimeProgress.rows.map(renderProgressRow)
                  ) : (
                    <div className="notice notice--neutral">{copy.noProgressRows}</div>
                  )}
                </div>
              </article>

              <article className="production-progress-card production-progress-card--pending">
                <div className="production-progress-visual-summary">
                  <div className={`production-progress-ring${machiningProgress.actualQty > machiningProgress.plannedQty ? " production-progress-ring--overrun" : ""}`} style={getRingStyle(machiningProgress.progressRate)}>
                    <strong>{Math.round(machiningProgress.progressRate)}%</strong>
                    <span>{copy.totalProgress}</span>
                  </div>
                  <div className="production-progress-summary-text">
                    <h4>{copy.machiningProgress}</h4>
                    <p>{copy.machiningPending}</p>
                    <div className="production-progress-state-strip">
                      <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {machiningProgress.completedCount}</span>
                      <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {machiningProgress.inProgressCount}</span>
                      <span className="production-progress-chip">{copy.pending} {machiningProgress.pendingCount}</span>
                      {renderOverrunChip(machiningProgress.actualQty - machiningProgress.plannedQty)}
                    </div>
                  </div>
                </div>
                <div className="production-progress-list">
                  {machiningProgress.rows.length ? (
                    machiningProgress.rows.map(renderMachiningPreviewRow)
                  ) : (
                    <div className="notice notice--neutral">{copy.noProgressRows}</div>
                  )}
                </div>
              </article>
            </div>
          </section>

          {selectedProgressRow ? (
            <div className="modal-backdrop" role="presentation" onClick={() => setSelectedProgressRow(null)}>
              <section
                className="modal-card production-progress-modal"
                aria-modal="true"
                role="dialog"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-card__header">
                  <div>
                    <p className="panel-card__eyebrow">{copy.machineDetailTitle}</p>
                    <h3 className="panel__title">{selectedProgressRow.label}</h3>
                    <p className="production-progress-modal__meta">
                      {copy.totalProgress} {Math.round(selectedProgressRow.progressRate)}% · {copy.estimatedVsPlan} {formatNumber(selectedProgressRow.estimatedQty)} / {formatNumber(selectedProgressRow.plannedQty)}
                    </p>
                  </div>
                  <button className="button button--ghost" onClick={() => setSelectedProgressRow(null)} type="button">
                    {copy.close}
                  </button>
                </div>

                <div className="production-progress-modal__summary">
                  <div>
                    <span>{copy.shotCount}</span>
                    <strong>{formatNumber(selectedProgressRow.shotCount)}</strong>
                  </div>
                  <div>
                    <span>{copy.cavity}</span>
                    <strong>{selectedProgressRow.avgCavity.toFixed(1)}</strong>
                  </div>
                  <div>
                    <span>{copy.gap}</span>
                    <strong className={selectedProgressRow.gapQty >= 0 ? "production-progress-gap--up" : "production-progress-gap--down"}>
                      {selectedProgressRow.gapQty >= 0 ? "+" : "-"}{formatNumber(Math.abs(selectedProgressRow.gapQty))}
                    </strong>
                  </div>
                </div>

                <div className="production-progress-modal__table">
                  <div className="production-progress-modal__table-head">
                    <span>{copy.sequence}</span>
                    <span>Part No</span>
                    <span>{copy.model}</span>
                    <span>{copy.estimatedVsPlan}</span>
                    <span>{copy.progress}</span>
                  </div>
                  {selectedProgressRow.segments.map((segment) => (
                    <div className="production-progress-modal__row" key={segment.key}>
                      <span>{segment.sequence}</span>
                      <span>{segment.partNo}</span>
                      <span>{segment.modelName}</span>
                      <span>{formatNumber(segment.estimatedQty)} / {formatNumber(segment.plannedQty)}</span>
                      <span>
                        <div className="production-progress-modal__progress">
                          <div className="production-progress-modal__bar">
                            <span style={{ width: `${Math.max(0, Math.min(100, segment.progressRate))}%` }} />
                          </div>
                          <em className={`production-progress-chip production-progress-chip--${segment.status === "completed" ? "completed" : segment.status === "in_progress" ? "active" : "pending"}`}>
                            {Math.round(segment.progressRate)}%
                          </em>
                        </div>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
