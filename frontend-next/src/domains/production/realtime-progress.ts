import { type InjectionProductionMatrix } from "@/domains/mes/api";
import {
  type ProductionPlanRecord,
  type ProductionPlanSummaryResponse,
  type ProductionStatusMachine,
  type ProductionStatusResponse,
} from "@/domains/production/api";
import { type InjectionTransitionAnalysis } from "@/domains/production/injection-transition-analysis";

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
  shotGroupKey?: string;
  parallelPartCount?: number;
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

type MachineShotStats = {
  shotCount: number;
  recentShots: number;
  label: string;
};

function buildUnplannedProgressRow(key: string, shots: MachineShotStats): RealtimeProgressRow {
  return {
    key,
    label: shots.label || key,
    plannedQty: 0,
    shotCount: shots.shotCount,
    recentShots: shots.recentShots,
    recentCycleTimeSec: shots.recentShots > 0 ? 3600 / shots.recentShots : null,
    estimatedQty: 0,
    progressRate: 0,
    gapQty: 0,
    partCount: 0,
    avgCavity: 1,
    isRunning: shots.recentShots > 0,
    completedCount: 0,
    inProgressCount: 0,
    pendingCount: 0,
    segments: [],
  };
}

function getLatestTime(data?: InjectionProductionMatrix) {
  const latestSlot = data?.time_slots?.at(-1);
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

function getBusinessDayWindow(businessDate: string | undefined, latestTime: Date | null) {
  if (!businessDate) {
    const start = getProductionDayStart(latestTime);
    return {
      start,
      end: latestTime,
    };
  }

  const start = new Date(`${businessDate}T08:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const referenceEnd = latestTime
    ? new Date(Math.min(Math.max(latestTime.getTime(), start.getTime()), end.getTime()))
    : end;

  return {
    start,
    end: referenceEnd,
  };
}

function numberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0) return 0;
  return Number(values[index] ?? 0);
}

function getMachineMatrixValues(data: InjectionProductionMatrix, machineNumber: number) {
  const machine = data.machines.find((item) => item.machine_number === machineNumber);
  const candidateKeys = [
    String(machineNumber),
    machine?.machine_name,
    machine?.display_name,
    `${machineNumber}호기`,
  ].filter((value): value is string => Boolean(value));

  for (const key of candidateKeys) {
    const values = data.actual_production_matrix[key];
    if (values) return values;
  }

  return [];
}

function getMachineNumberFromName(value: string | null | undefined) {
  const text = String(value ?? "");
  const suffixMatch = text.match(/-(\d+)\s*$/);
  if (suffixMatch) return suffixMatch[1];
  const machineLabelMatch = text.match(/^(\d+)\s*(?:호기|号机)/);
  if (machineLabelMatch) return machineLabelMatch[1];
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

function getRecordIdentity(record: ProductionPlanRecord | undefined) {
  if (!record) return "";
  if (record.id !== undefined && record.id !== null) return `id:${record.id}`;
  return [
    record.part_no ?? "",
    record.model_name ?? "",
    record.lot_no ?? "",
    record.sequence ?? "",
  ].join("|");
}

function findRecordIndex(records: ProductionPlanRecord[], target: ProductionPlanRecord | undefined, minimumIndex = 0) {
  const targetIdentity = getRecordIdentity(target);
  if (!targetIdentity) return -1;
  return records.findIndex((record, index) => index >= minimumIndex && getRecordIdentity(record) === targetIdentity);
}

function normalizeComparableCode(value: string | null | undefined) {
  return String(value ?? "").replace(/[^0-9A-Z]/gi, "").toUpperCase();
}

const CORE_PART_NO_MIN_LENGTH = 10;

function getRecordPlannedQty(record: ProductionPlanRecord | undefined) {
  return Math.max(0, Number(record?.planned_quantity ?? 0) || 0);
}

function getRecordCavity(record: ProductionPlanRecord | undefined) {
  return Math.max(1, Number(record?.cavity ?? 1) || 1);
}

function getRecordPartsPerShot(record: ProductionPlanRecord | undefined) {
  const pattern = String(record?.cavity_pattern ?? "").trim().toLowerCase().replace(/\s+/g, "").replace("*", "x").replace("×", "x");
  const match = pattern.match(/^(\d+)x(\d+)$/);
  if (match) return Math.max(1, Number(match[1]) || 1);
  return Math.max(1, Number(record?.parts_per_shot ?? 1) || 1);
}

function getRecordCavityGroup(record: ProductionPlanRecord | undefined) {
  return String(record?.cavity_group ?? "").trim().toUpperCase();
}

function getRecordRequiredShots(record: ProductionPlanRecord | undefined) {
  const plannedQty = getRecordPlannedQty(record);
  const cavity = getRecordCavity(record);
  return plannedQty > 0 ? Math.ceil(plannedQty / cavity) : 0;
}

type PlanAllocationMember = {
  record: ProductionPlanRecord;
  index: number;
  cavity: number;
  requiredShots: number;
  plannedQty: number;
};

type PlanAllocationGroup = {
  key: string;
  members: PlanAllocationMember[];
  requiredShots: number;
  totalCavity: number;
};

function buildPlanAllocationGroups(records: ProductionPlanRecord[]) {
  const consumed = new Set<number>();
  const groups: PlanAllocationGroup[] = [];

  records.forEach((record, index) => {
    if (consumed.has(index)) return;

    const groupKey = getRecordCavityGroup(record);
    const partsPerShot = getRecordPartsPerShot(record);
    let memberIndexes = [index];
    if (groupKey && partsPerShot > 1) {
      memberIndexes = records
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate, candidateIndex }) => (
          !consumed.has(candidateIndex)
          && getRecordCavityGroup(candidate) === groupKey
        ))
        .map(({ candidateIndex }) => candidateIndex);
      if (memberIndexes.length <= 1) memberIndexes = [index];
    }

    const members = memberIndexes.map((memberIndex) => {
      const memberRecord = records[memberIndex];
      const cavity = getRecordCavity(memberRecord);
      const plannedQty = getRecordPlannedQty(memberRecord);
      consumed.add(memberIndex);
      return {
        record: memberRecord,
        index: memberIndex,
        cavity,
        plannedQty,
        requiredShots: plannedQty > 0 ? Math.ceil(plannedQty / cavity) : 0,
      };
    });

    groups.push({
      key: groupKey || getRecordIdentity(record) || `group-${index}`,
      members,
      requiredShots: Math.max(0, ...members.map((member) => member.requiredShots)),
      totalCavity: members.reduce((sum, member) => sum + member.cavity, 0),
    });
  });

  return groups;
}

function getAverageShotYield(records: ProductionPlanRecord[]) {
  const groups = buildPlanAllocationGroups(records);
  const weightedShots = groups.reduce((sum, group) => sum + group.requiredShots, 0);
  if (weightedShots <= 0) return 1;
  return groups.reduce((sum, group) => sum + (group.requiredShots * Math.max(1, group.totalCavity)), 0) / weightedShots;
}

function hasCoreSuffixPartNoChange(leftPartNo: string, rightPartNo: string) {
  if (!leftPartNo || !rightPartNo) return false;
  if (leftPartNo === rightPartNo) return false;
  if (leftPartNo.length !== rightPartNo.length) return false;
  if (leftPartNo.length < CORE_PART_NO_MIN_LENGTH) return false;

  const leftSuffix = leftPartNo.slice(-2);
  const rightSuffix = rightPartNo.slice(-2);
  if (!/^\d{2}$/.test(leftSuffix) || !/^\d{2}$/.test(rightSuffix)) return false;

  return leftPartNo.slice(0, -2) === rightPartNo.slice(0, -2);
}

function hasSamePartPrefixExceptSuffix(left: ProductionPlanRecord | undefined, right: ProductionPlanRecord | undefined) {
  const leftPartNo = normalizeComparableCode(left?.part_no);
  const rightPartNo = normalizeComparableCode(right?.part_no);
  if (!leftPartNo || !rightPartNo) return false;
  if (leftPartNo === rightPartNo) return true;
  return hasCoreSuffixPartNoChange(leftPartNo, rightPartNo);
}

function canRolloverWithoutTransition(left: ProductionPlanRecord | undefined, right: ProductionPlanRecord | undefined) {
  if (!left || !right) return false;
  if (getRecordCavity(left) !== getRecordCavity(right)) return false;
  const leftGroup = getRecordCavityGroup(left);
  const rightGroup = getRecordCavityGroup(right);
  if (leftGroup && leftGroup === rightGroup && getRecordPartsPerShot(left) > 1) return true;

  return hasSamePartPrefixExceptSuffix(left, right);
}

function allocateRemainingQuantitiesByRollover(
  records: ProductionPlanRecord[],
  allocations: number[],
  startIndex: number,
  totalQty: number,
) {
  let remainingQty = Math.max(0, totalQty);
  let cursor = Math.min(Math.max(0, startIndex), records.length - 1);

  while (remainingQty > 0 && cursor < records.length) {
    const canRollover = cursor < records.length - 1 && canRolloverWithoutTransition(records[cursor], records[cursor + 1]);
    if (!canRollover) {
      allocations[cursor] += remainingQty;
      return;
    }

    const capacity = Math.max(0, getRecordPlannedQty(records[cursor]) - (allocations[cursor] ?? 0));
    const allocatedQty = Math.min(remainingQty, capacity);
    allocations[cursor] += allocatedQty;
    remainingQty = Math.max(0, remainingQty - allocatedQty);
    if (remainingQty <= 0) return;
    cursor += 1;
  }

  if (remainingQty > 0 && records.length > 0) {
    allocations[records.length - 1] += remainingQty;
  }
}

function allocateRemainingShotsByRollover(
  records: ProductionPlanRecord[],
  allocations: number[],
  startIndex: number,
  totalShots: number,
) {
  let remainingShots = Math.max(0, totalShots);
  let cursor = Math.min(Math.max(0, startIndex), records.length - 1);

  while (remainingShots > 0 && cursor < records.length) {
    const canRollover = cursor < records.length - 1 && canRolloverWithoutTransition(records[cursor], records[cursor + 1]);
    if (!canRollover) {
      allocations[cursor] += remainingShots;
      return;
    }

    const capacity = Math.max(0, getRecordRequiredShots(records[cursor]) - (allocations[cursor] ?? 0));
    const allocatedShots = Math.min(remainingShots, capacity);
    allocations[cursor] += allocatedShots;
    remainingShots = Math.max(0, remainingShots - allocatedShots);
    if (remainingShots <= 0) return;
    cursor += 1;
  }

  if (remainingShots > 0 && records.length > 0) {
    allocations[records.length - 1] += remainingShots;
  }
}

function getEquipmentTransitionEvents(transitionAnalysis: InjectionTransitionAnalysis | undefined, machineKey: string) {
  return (transitionAnalysis?.events ?? [])
    .filter((event) => (
      event.machineKey === machineKey
      && (event.type === "mold_change" || event.type === "core_change")
      && event.fromRecord
      && event.toRecord
    ))
    .sort((left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime());
}

function allocateQuantitiesByTransitionSignals(
  records: ProductionPlanRecord[],
  totalQty: number,
  machineKey: string,
  transitionAnalysis: InjectionTransitionAnalysis | undefined,
) {
  if (!transitionAnalysis || records.length === 0) return null;
  const allocations = Array.from({ length: records.length }, () => 0);
  const transitions = getEquipmentTransitionEvents(transitionAnalysis, machineKey);
  let activeIndex = 0;
  let remainingQty = Math.max(0, totalQty);

  transitions.forEach((event) => {
    const fromIndex = findRecordIndex(records, event.fromRecord, activeIndex);
    const toIndex = findRecordIndex(records, event.toRecord, Math.max(fromIndex + 1, activeIndex + 1));
    if (fromIndex < 0 || toIndex < 0 || remainingQty <= 0) return;

    const producedBeforeChange = Math.max(0, Number(event.evidence.cumulativeQtyAtStop ?? 0) || 0);
    if (producedBeforeChange <= 0) return;

    activeIndex = fromIndex;
    const rolloverCapacity = canRolloverWithoutTransition(records[fromIndex], records[toIndex])
      ? getRecordPlannedQty(records[fromIndex])
      : producedBeforeChange;
    const allocatedQty = Math.min(remainingQty, producedBeforeChange, rolloverCapacity);
    allocations[fromIndex] += allocatedQty;
    remainingQty = Math.max(0, remainingQty - allocatedQty);
    activeIndex = toIndex;
  });

  if (remainingQty > 0) {
    allocateRemainingQuantitiesByRollover(records, allocations, activeIndex, remainingQty);
  }

  return allocations;
}

function allocateShotsByTransitionSignals(
  records: ProductionPlanRecord[],
  totalShots: number,
  machineKey: string,
  transitionAnalysis: InjectionTransitionAnalysis | undefined,
) {
  if (!transitionAnalysis || records.length === 0) return null;
  const allocations = Array.from({ length: records.length }, () => 0);
  const transitions = getEquipmentTransitionEvents(transitionAnalysis, machineKey);
  let activeIndex = 0;
  let remainingShots = Math.max(0, totalShots);

  transitions.forEach((event) => {
    const fromIndex = findRecordIndex(records, event.fromRecord, activeIndex);
    const toIndex = findRecordIndex(records, event.toRecord, Math.max(fromIndex + 1, activeIndex + 1));
    if (fromIndex < 0 || toIndex < 0 || remainingShots <= 0) return;

    const cavity = Math.max(1, Number(records[fromIndex]?.cavity ?? 1) || 1);
    const producedShotsBeforeChange = Math.max(0, Number(event.evidence.cumulativeQtyAtStop ?? 0) || 0) / cavity;
    if (producedShotsBeforeChange <= 0) return;

    activeIndex = fromIndex;
    const rolloverCapacity = canRolloverWithoutTransition(records[fromIndex], records[toIndex])
      ? getRecordRequiredShots(records[fromIndex])
      : producedShotsBeforeChange;
    const allocatedShots = Math.min(remainingShots, producedShotsBeforeChange, rolloverCapacity);
    allocations[fromIndex] += allocatedShots;
    remainingShots = Math.max(0, remainingShots - allocatedShots);
    activeIndex = toIndex;
  });

  if (remainingShots > 0) {
    allocateRemainingShotsByRollover(records, allocations, activeIndex, remainingShots);
  }

  return allocations;
}

export function buildRealtimeProgressSummary(
  planSummary: ProductionPlanSummaryResponse | undefined,
  mesData: InjectionProductionMatrix | undefined,
  productionStatus?: ProductionStatusResponse,
  businessDate?: string,
  transitionAnalysis?: InjectionTransitionAnalysis,
): RealtimeProgressSummary {
  const latestTime = getLatestTime(mesData);
  const productionWindow = getBusinessDayWindow(businessDate, latestTime);
  const recentStart = latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null;
  const planMap = new Map<string, {
    label: string;
    plannedQty: number;
    cavityWeightedQty: number;
    records: ProductionPlanRecord[];
  }>();

  for (const record of planSummary?.injection?.records ?? []) {
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

  const shotMap = new Map<string, MachineShotStats>();
  if (mesData) {
    for (const machine of mesData.machines ?? []) {
      const key = String(machine.machine_number);
      let shotCount = 0;
      let recentShots = 0;
      const productionRow = getMachineMatrixValues(mesData, machine.machine_number);
      (mesData.time_slots ?? []).forEach((slot, index) => {
        const slotTime = new Date(slot.time);
        const output = numberAt(productionRow, index);
        if (productionWindow.start && productionWindow.end && slotTime >= productionWindow.start && slotTime <= productionWindow.end) {
          shotCount += output;
        }
        if (recentStart && latestTime && slotTime >= recentStart && slotTime <= latestTime) {
          recentShots += output;
        }
      });
      shotMap.set(key, { shotCount, recentShots, label: machine.display_name || `${machine.machine_number}호기` });
    }
  }

  if (productionStatus?.injection?.length) {
    return buildStatusBackedProgressSummary(productionStatus.injection, planMap, shotMap, transitionAnalysis);
  }

  const rowKeys = new Set([
    ...planMap.keys(),
    ...[...shotMap.entries()]
      .filter(([, shots]) => shots.shotCount > 0)
      .map(([key]) => key),
  ]);
  const rows = [...rowKeys].map((key): RealtimeProgressRow => {
    const plan = planMap.get(key);
    const shots = shotMap.get(key);
    if (!plan && shots?.shotCount) return buildUnplannedProgressRow(key, shots);
    const plannedQty = plan?.plannedQty ?? 0;
    const shotCount = shots?.shotCount ?? 0;
    let remainingShots = shotCount;
    const orderedRecords = getOrderedPlanRecords(plan?.records ?? []);
    const allocationGroups = buildPlanAllocationGroups(orderedRecords);
    const avgCavity = plannedQty > 0 ? getAverageShotYield(orderedRecords) : 1;
    const transitionShotAllocations = allocateShotsByTransitionSignals(orderedRecords, shotCount, key, transitionAnalysis);
    const segments = allocationGroups.flatMap((group, groupIndex) => {
      const isLastGroup = groupIndex === allocationGroups.length - 1;
      const allocatedShots = transitionShotAllocations
        ? Math.max(0, ...group.members.map((member) => transitionShotAllocations[member.index] ?? 0))
        : isLastGroup
          ? Math.max(0, remainingShots)
          : Math.max(0, Math.min(remainingShots, group.requiredShots));
      remainingShots = Math.max(0, remainingShots - allocatedShots);

      return group.members.map((member) => {
        const record = member.record;
        const segmentPlannedQty = Number(record.planned_quantity ?? 0);
        const cavity = member.cavity;
        const requiredShots = member.requiredShots;
        const estimatedQty = Math.round(allocatedShots * cavity);
        const progressRate = segmentPlannedQty > 0 ? (estimatedQty / segmentPlannedQty) * 100 : 0;
        const status: RealtimeProgressSegmentStatus = progressRate >= 99.9
          ? "completed"
          : progressRate > 0
            ? "in_progress"
            : "pending";

        return {
          key: `${record.id ?? member.index}-${record.part_no ?? record.model_name ?? "part"}`,
          sequence: member.index + 1,
          partNo: record.part_no || record.model_name || record.part_spec || "-",
          modelName: record.model_name || record.part_spec || "-",
          lotNo: record.lot_no || "-",
          productFamilyCode: record.product_family_code || null,
          productFamilyName: record.product_family_name || null,
          isFinishedProduct: Boolean(record.is_finished_product),
          plannedQty: segmentPlannedQty,
          cavity,
          shotGroupKey: group.members.length > 1 ? group.key : undefined,
          parallelPartCount: group.members.length > 1 ? group.members.length : undefined,
          requiredShots,
          allocatedShots,
          estimatedQty,
          progressRate,
          status,
        };
      });
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
  shotMap: Map<string, MachineShotStats>,
  transitionAnalysis?: InjectionTransitionAnalysis,
): RealtimeProgressSummary {
  const plannedRows = statusRows.map((statusRow): RealtimeProgressRow => {
    const machineNumber = getMachineNumberFromName(statusRow.machine_name);
    const key = machineNumber ?? (statusRow.machine_name || "unknown");
    const plan = planMap.get(key);
    const shots = shotMap.get(key);
    const orderedRecords = getOrderedPlanRecords(plan?.records ?? []);
    const plannedQty = Number(statusRow.total_planned ?? 0);
    const statusEstimatedQty = Number(statusRow.total_actual ?? 0);
    const shotCount = shots?.shotCount ?? 0;
    const useMesShotActual = Boolean(shots);
    const sourceRecords = orderedRecords.length
      ? orderedRecords
      : (statusRow.parts ?? []).map((part) => ({
        part_no: part.part_no,
        model_name: part.model_name,
        part_spec: part.model_name,
        planned_quantity: part.planned_quantity,
        cavity: 1,
      } as ProductionPlanRecord));
    const allocationGroups = buildPlanAllocationGroups(sourceRecords);
    const avgCavity = plannedQty > 0 ? getAverageShotYield(sourceRecords) : 1;
    const transitionShotAllocations = useMesShotActual
      ? allocateShotsByTransitionSignals(sourceRecords, shotCount, key, transitionAnalysis)
      : null;
    const transitionQtyAllocations = useMesShotActual
      ? null
      : allocateQuantitiesByTransitionSignals(sourceRecords, statusEstimatedQty, key, transitionAnalysis);
    let remainingShots = Math.max(0, shotCount);
    let remainingActualQty = Math.max(0, statusEstimatedQty);
    const segments = allocationGroups.flatMap((group, groupIndex) => {
      const isLastGroup = groupIndex === allocationGroups.length - 1;
      const allocatedShots = useMesShotActual
        ? transitionShotAllocations
          ? Math.max(0, ...group.members.map((member) => transitionShotAllocations[member.index] ?? 0))
          : isLastGroup
            ? Math.max(0, remainingShots)
            : Math.max(0, Math.min(remainingShots, group.requiredShots))
        : 0;
      const groupActualQty = useMesShotActual
        ? group.members.reduce((sum, member) => sum + Math.round(allocatedShots * member.cavity), 0)
        : transitionQtyAllocations
          ? group.members.reduce((sum, member) => sum + Math.max(0, transitionQtyAllocations[member.index] ?? 0), 0)
          : isLastGroup
            ? Math.max(0, remainingActualQty)
            : Math.max(0, Math.min(remainingActualQty, group.members.reduce((sum, member) => sum + member.plannedQty, 0)));
      remainingShots = Math.max(0, remainingShots - allocatedShots);
      remainingActualQty = Math.max(0, remainingActualQty - groupActualQty);

      return group.members.map((member) => {
        const record = member.record;
        const segmentPlannedQty = Number(record.planned_quantity ?? 0);
        const cavity = member.cavity;
        const segmentActualQty = useMesShotActual
          ? Math.round(allocatedShots * cavity)
          : transitionQtyAllocations
            ? Math.max(0, transitionQtyAllocations[member.index] ?? 0)
            : group.members.length > 1 && group.totalCavity > 0
              ? Math.round(groupActualQty * (cavity / group.totalCavity))
              : Math.min(groupActualQty, segmentPlannedQty);
        const displayAllocatedShots = useMesShotActual
          ? allocatedShots
          : segmentActualQty > 0 ? segmentActualQty / cavity : 0;
        const progressRate = segmentPlannedQty > 0 ? (segmentActualQty / segmentPlannedQty) * 100 : 0;
        const status: RealtimeProgressSegmentStatus = progressRate >= 99.9
          ? "completed"
          : progressRate > 0
            ? "in_progress"
            : "pending";

        return {
          key: `${record.id ?? member.index}-${record.part_no ?? record.model_name ?? "part"}`,
          sequence: member.index + 1,
          partNo: record.part_no || record.model_name || record.part_spec || "-",
          modelName: record.model_name || record.part_spec || "-",
          lotNo: record.lot_no || "-",
          productFamilyCode: record.product_family_code || null,
          productFamilyName: record.product_family_name || null,
          isFinishedProduct: Boolean(record.is_finished_product),
          plannedQty: segmentPlannedQty,
          cavity,
          shotGroupKey: group.members.length > 1 ? group.key : undefined,
          parallelPartCount: group.members.length > 1 ? group.members.length : undefined,
          requiredShots: member.requiredShots,
          allocatedShots: displayAllocatedShots,
          estimatedQty: segmentActualQty,
          progressRate,
          status,
        };
      });
    });
    const estimatedQty = useMesShotActual
      ? segments.reduce((sum, segment) => sum + segment.estimatedQty, 0)
      : statusEstimatedQty;
    const completedCount = segments.filter((segment) => segment.status === "completed").length;
    const inProgressCount = segments.filter((segment) => segment.status === "in_progress").length;
    const pendingCount = segments.filter((segment) => segment.status === "pending").length;
    const recentShots = shots?.recentShots ?? 0;

    return {
      key,
      label: statusRow.machine_name || plan?.label || shots?.label || key,
      plannedQty,
      shotCount,
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
  const statusKeys = new Set(statusRows.map((statusRow) => (
    getMachineNumberFromName(statusRow.machine_name) ?? (statusRow.machine_name || "unknown")
  )));
  const unplannedRows = [...shotMap.entries()]
    .filter(([key, shots]) => shots.shotCount > 0 && !statusKeys.has(key))
    .map(([key, shots]) => buildUnplannedProgressRow(key, shots));
  const rows = [...plannedRows, ...unplannedRows].sort((left, right) => {
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
