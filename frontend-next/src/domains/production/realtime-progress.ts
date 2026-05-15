import { type InjectionProductionMatrix } from "@/domains/mes/api";
import {
  type ProductionPlanRecord,
  type ProductionPlanSummaryResponse,
  type ProductionStatusMachine,
  type ProductionStatusResponse,
} from "@/domains/production/api";

export type RealtimeProgressSegmentStatus = "completed" | "in_progress" | "pending";

export type RealtimeProgressSegment = {
  key: string;
  sequence: number;
  partNo: string;
  modelName: string;
  lotNo: string;
  productFamilyCode: string | null;
  productFamilyName: string | null;
  isFinishedProduct: boolean;
  plannedQty: number;
  cavity: number;
  requiredShots: number;
  allocatedShots: number;
  estimatedQty: number;
  progressRate: number;
  status: RealtimeProgressSegmentStatus;
};

export type RealtimeProgressRow = {
  key: string;
  label: string;
  plannedQty: number;
  shotCount: number;
  recentShots: number;
  recentCycleTimeSec: number | null;
  estimatedQty: number;
  progressRate: number;
  gapQty: number;
  partCount: number;
  avgCavity: number;
  isRunning: boolean;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  segments: RealtimeProgressSegment[];
};

export type RealtimeProgressSummary = {
  plannedQty: number;
  shotCount: number;
  estimatedQty: number;
  progressRate: number;
  runningCount: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  partCount: number;
  rows: RealtimeProgressRow[];
};

function getLatestTime(data?: InjectionProductionMatrix) {
  const latestSlot = data?.time_slots.at(-1);
  return latestSlot ? new Date(latestSlot.time) : null;
}

function getProductionDayStart(latestTime: Date | null) {
  if (!latestTime) return null;
  const start = new Date(latestTime);
  start.setHours(8, 0, 0, 0);
  if (latestTime < start) {
    start.setDate(start.getDate() - 1);
  }
  return start;
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

export function buildRealtimeProgressSummary(
  planSummary: ProductionPlanSummaryResponse | undefined,
  mesData: InjectionProductionMatrix | undefined,
  productionStatus?: ProductionStatusResponse,
): RealtimeProgressSummary {
  const latestTime = getLatestTime(mesData);
  const productionDayStart = getProductionDayStart(latestTime);
  const recentStart = latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null;
  const planMap = new Map<string, {
    label: string;
    plannedQty: number;
    cavityWeightedQty: number;
    records: ProductionPlanRecord[];
  }>();

  for (const record of planSummary?.injection.records ?? []) {
    const machineNumber = getMachineNumberFromName(record.machine_name);
    const key = machineNumber ?? (record.machine_name || "unknown");
    const plannedQty = Number(record.planned_quantity ?? 0);
    const cavity = Math.max(1, Number(record.cavity ?? 1) || 1);
    const current = planMap.get(key) ?? {
      label: record.machine_name || (machineNumber ? `${machineNumber}호기` : "-"),
      plannedQty: 0,
      cavityWeightedQty: 0,
      records: [],
    };

    current.plannedQty += plannedQty;
    current.cavityWeightedQty += plannedQty * cavity;
    current.records.push(record);
    planMap.set(key, current);
  }

  const shotMap = new Map<string, { shotCount: number; recentShots: number; label: string }>();
  for (const machine of mesData?.machines ?? []) {
    const key = String(machine.machine_number);
    let shotCount = 0;
    let recentShots = 0;
    mesData?.time_slots.forEach((slot, index) => {
      const slotTime = new Date(slot.time);
      const output = numberAt(mesData.actual_production_matrix[key], index);
      if (productionDayStart && latestTime && slotTime >= productionDayStart && slotTime <= latestTime) {
        shotCount += output;
      }
      if (recentStart && latestTime && slotTime >= recentStart && slotTime <= latestTime) {
        recentShots += output;
      }
    });
    shotMap.set(key, { shotCount, recentShots, label: machine.display_name || `${machine.machine_number}호기` });
  }

  if (productionStatus?.injection?.length) {
    return buildStatusBackedProgressSummary(productionStatus.injection, planMap, shotMap);
  }

  const rows = [...planMap.keys()].map((key) => {
    const plan = planMap.get(key);
    const shots = shotMap.get(key);
    const plannedQty = plan?.plannedQty ?? 0;
    const avgCavity = plannedQty > 0 ? (plan?.cavityWeightedQty ?? plannedQty) / plannedQty : 1;
    const shotCount = shots?.shotCount ?? 0;
    let remainingShots = shotCount;
    const segments = getOrderedPlanRecords(plan?.records ?? []).map((record, index) => {
      const segmentPlannedQty = Number(record.planned_quantity ?? 0);
      const cavity = Math.max(1, Number(record.cavity ?? 1) || 1);
      const requiredShots = segmentPlannedQty > 0 ? Math.ceil(segmentPlannedQty / cavity) : 0;
      const allocatedShots = index === (plan?.records.length ?? 0) - 1
        ? Math.max(0, remainingShots)
        : Math.max(0, Math.min(remainingShots, requiredShots));
      const estimatedQty = Math.round(allocatedShots * cavity);
      const progressRate = segmentPlannedQty > 0 ? (estimatedQty / segmentPlannedQty) * 100 : 0;
      const status: RealtimeProgressSegmentStatus = progressRate >= 99.9
        ? "completed"
        : progressRate > 0
          ? "in_progress"
          : "pending";

      remainingShots -= allocatedShots;
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
        cavity,
        requiredShots,
        allocatedShots,
        estimatedQty,
        progressRate,
        status,
      };
    });
    const cappedEstimatedQty = segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
    const extraQty = remainingShots > 0 ? Math.round(remainingShots * avgCavity) : 0;
    const estimatedQty = cappedEstimatedQty + extraQty;
    const progressRate = plannedQty > 0 ? Math.min(999, (estimatedQty / plannedQty) * 100) : 0;
    const completedCount = segments.filter((segment) => segment.status === "completed").length;
    const inProgressCount = segments.filter((segment) => segment.status === "in_progress").length;
    const pendingCount = segments.filter((segment) => segment.status === "pending").length;

    const recentShots = shots?.recentShots ?? 0;
    return {
      key,
      label: plan?.label ?? shots?.label ?? key,
      plannedQty,
      shotCount,
      recentShots,
      recentCycleTimeSec: recentShots > 0 ? 3600 / recentShots : null,
      estimatedQty,
      progressRate,
      gapQty: estimatedQty - plannedQty,
      partCount: segments.length,
      avgCavity,
      isRunning: (shots?.recentShots ?? 0) > 0,
      completedCount,
      inProgressCount,
      pendingCount,
      segments,
    };
  }).sort((left, right) => {
    const leftNumber = Number(getMachineNumberFromName(left.label) ?? left.key);
    const rightNumber = Number(getMachineNumberFromName(right.label) ?? right.key);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    return left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" });
  });

  const plannedQty = rows.reduce((sum, row) => sum + row.plannedQty, 0);
  const estimatedQty = rows.reduce((sum, row) => sum + row.estimatedQty, 0);
  const shotCount = rows.reduce((sum, row) => sum + row.shotCount, 0);
  const completedCount = rows.reduce((sum, row) => sum + row.completedCount, 0);
  const inProgressCount = rows.reduce((sum, row) => sum + row.inProgressCount, 0);
  const pendingCount = rows.reduce((sum, row) => sum + row.pendingCount, 0);

  return {
    plannedQty,
    shotCount,
    estimatedQty,
    progressRate: plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : 0,
    runningCount: rows.filter((row) => row.isRunning).length,
    completedCount,
    inProgressCount,
    pendingCount,
    partCount: completedCount + inProgressCount + pendingCount,
    rows,
  };
}

function buildStatusBackedProgressSummary(
  statusRows: ProductionStatusMachine[],
  planMap: Map<string, {
    label: string;
    plannedQty: number;
    cavityWeightedQty: number;
    records: ProductionPlanRecord[];
  }>,
  shotMap: Map<string, { shotCount: number; recentShots: number; label: string }>,
): RealtimeProgressSummary {
  const rows = statusRows.map((statusRow) => {
    const machineNumber = getMachineNumberFromName(statusRow.machine_name);
    const key = machineNumber ?? (statusRow.machine_name || "unknown");
    const plan = planMap.get(key);
    const shots = shotMap.get(key);
    const orderedRecords = getOrderedPlanRecords(plan?.records ?? []);
    const plannedQty = Number(statusRow.total_planned ?? 0);
    const estimatedQty = Number(statusRow.total_actual ?? 0);
    const avgCavity = plannedQty > 0 ? (plan?.cavityWeightedQty ?? plannedQty) / plannedQty : 1;
    const segments = (statusRow.parts ?? []).map((part, index) => {
      const matchingRecord = orderedRecords.find((record) => {
        const recordPart = String(record.part_no ?? "").trim().toUpperCase();
        const partNo = String(part.part_no ?? "").trim().toUpperCase();
        return recordPart && partNo && recordPart === partNo;
      }) ?? orderedRecords[index];
      const segmentPlannedQty = Number(part.planned_quantity ?? matchingRecord?.planned_quantity ?? 0);
      const segmentActualQty = Number(part.actual_quantity ?? 0);
      const cavity = Math.max(1, Number(matchingRecord?.cavity ?? 1) || 1);
      const requiredShots = segmentPlannedQty > 0 ? Math.ceil(segmentPlannedQty / cavity) : 0;
      const allocatedShots = segmentActualQty > 0 ? segmentActualQty / cavity : 0;
      const progressRate = segmentPlannedQty > 0 ? (segmentActualQty / segmentPlannedQty) * 100 : 0;
      const status: RealtimeProgressSegmentStatus = progressRate >= 99.9
        ? "completed"
        : progressRate > 0
          ? "in_progress"
          : "pending";

      return {
        key: `${matchingRecord?.id ?? index}-${part.part_no ?? part.model_name ?? "part"}`,
        sequence: index + 1,
        partNo: part.part_no || matchingRecord?.part_no || matchingRecord?.model_name || "-",
        modelName: part.model_name || matchingRecord?.model_name || matchingRecord?.part_spec || "-",
        lotNo: matchingRecord?.lot_no || "-",
        productFamilyCode: matchingRecord?.product_family_code || null,
        productFamilyName: matchingRecord?.product_family_name || null,
        isFinishedProduct: Boolean(matchingRecord?.is_finished_product),
        plannedQty: segmentPlannedQty,
        cavity,
        requiredShots,
        allocatedShots,
        estimatedQty: segmentActualQty,
        progressRate,
        status,
      };
    });
    const completedCount = segments.filter((segment) => segment.status === "completed").length;
    const inProgressCount = segments.filter((segment) => segment.status === "in_progress").length;
    const pendingCount = segments.filter((segment) => segment.status === "pending").length;
    const recentShots = shots?.recentShots ?? 0;

    return {
      key,
      label: statusRow.machine_name || plan?.label || shots?.label || key,
      plannedQty,
      shotCount: shots?.shotCount ?? 0,
      recentShots,
      recentCycleTimeSec: recentShots > 0 ? 3600 / recentShots : null,
      estimatedQty,
      progressRate: plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : Number(statusRow.progress ?? 0),
      gapQty: estimatedQty - plannedQty,
      partCount: segments.length,
      avgCavity,
      isRunning: recentShots > 0,
      completedCount,
      inProgressCount,
      pendingCount,
      segments,
    };
  });

  const plannedQty = rows.reduce((sum, row) => sum + row.plannedQty, 0);
  const estimatedQty = rows.reduce((sum, row) => sum + row.estimatedQty, 0);
  const shotCount = rows.reduce((sum, row) => sum + row.shotCount, 0);
  const completedCount = rows.reduce((sum, row) => sum + row.completedCount, 0);
  const inProgressCount = rows.reduce((sum, row) => sum + row.inProgressCount, 0);
  const pendingCount = rows.reduce((sum, row) => sum + row.pendingCount, 0);

  return {
    plannedQty,
    shotCount,
    estimatedQty,
    progressRate: plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : 0,
    runningCount: rows.filter((row) => row.isRunning).length,
    completedCount,
    inProgressCount,
    pendingCount,
    partCount: completedCount + inProgressCount + pendingCount,
    rows,
  };
}
