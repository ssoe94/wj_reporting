import type { InjectionProductionMatrix } from "@/domains/mes/api";
import type {
  ProductionPlanRecord,
  ProductionPlanSummaryResponse,
  ProductionStatusMachine,
  ProductionStatusResponse,
  ProductionTransition,
} from "@/domains/production/api";
import type { InjectionTransitionAnalysis } from "@/domains/production/injection-transition-analysis";

export type RealtimeProgressSegmentStatus = "completed" | "in_progress" | "pending";
export type RealtimeEquipmentState = "running" | "paused" | "idle" | "unplanned_running" | "activity_review";

export type RealtimeProgressSegment = {
  key: string;
  planId?: number | null;
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
  unattributedShotCount?: number;
  transition?: ProductionTransition | null;
  recentShots: number;
  recentCycleTimeSec: number | null;
  estimatedQty: number;
  progressRate: number;
  gapQty: number;
  partCount: number;
  avgCavity: number;
  isRunning: boolean;
  equipmentState: RealtimeEquipmentState;
  hasPlan: boolean;
  lastShotAt: string | null;
  idleMinutes: number | null;
  morningShotGapCount?: number;
  expectedCycleTimeSec: number | null;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  segments: RealtimeProgressSegment[];
};

export type RealtimeProgressSummary = {
  plannedQty: number;
  shotCount: number;
  estimatedQty: number;
  unplannedShotCount: number;
  unplannedMachineCount: number;
  progressRate: number;
  runningCount: number;
  pausedCount: number;
  reviewCount: number;
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
  lastShotAt: string | null;
  idleMinutes: number | null;
  morningShotGapCount: number;
  expectedCycleTimeSec: number | null;
  isRunning: boolean;
};

const RUNNING_CT_LOOKBACK_MINUTES = 60;
const RUNNING_IDLE_MIN_MINUTES = 6;
const RUNNING_IDLE_MAX_MINUTES = 15;
const RUNNING_CT_TOLERANCE_MULTIPLIER = 2.5;

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

function normalizeShotTotal(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function getSlotIntervalMinutes(data: InjectionProductionMatrix, index: number) {
  const explicitInterval = Number(data.time_slots[index]?.interval_minutes ?? 0);
  if (explicitInterval > 0) return explicitInterval;

  const currentTime = new Date(data.time_slots[index]?.time ?? 0);
  const nextTime = new Date(data.time_slots[index + 1]?.time ?? 0);
  if (!Number.isNaN(currentTime.getTime()) && !Number.isNaN(nextTime.getTime())) {
    const interval = (nextTime.getTime() - currentTime.getTime()) / (60 * 1000);
    if (interval > 0) return interval;
  }
  return 2;
}

function buildMachineShotStats(
  data: InjectionProductionMatrix,
  machine: InjectionProductionMatrix["machines"][number],
  productionStart: Date | null,
  productionEnd: Date | null,
  latestTime: Date | null,
  recentStart: Date | null,
): MachineShotStats {
  const productionRow = getMachineMatrixValues(data, machine.machine_number);
  const activeSamples: Array<{ index: number; time: Date; output: number; intervalMinutes: number }> = [];
  let latestPositiveSample: { time: Date; output: number; intervalMinutes: number } | undefined;
  let shotCount = 0;
  let recentShots = 0;

  (data.time_slots ?? []).forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    const output = numberAt(productionRow, index);
    if (output > 0 && latestTime && slotTime <= latestTime) {
      latestPositiveSample = { time: slotTime, output, intervalMinutes: getSlotIntervalMinutes(data, index) };
    }
    if (productionStart && productionEnd && slotTime >= productionStart && slotTime <= productionEnd) {
      shotCount += output;
      if (output > 0) {
        activeSamples.push({
          index,
          time: slotTime,
          output,
          intervalMinutes: getSlotIntervalMinutes(data, index),
        });
      }
    }
    if (recentStart && latestTime && slotTime >= recentStart && slotTime <= latestTime) {
      recentShots += output;
    }
  });

  // Machine 3 is stored with a 0.5 monitoring correction. Keep the fractional
  // slot values for C/T analysis, but expose completed physical shots as units.
  const normalizedShotCount = normalizeShotTotal(shotCount);
  const normalizedRecentShots = normalizeShotTotal(recentShots);
  const observedSlots = data.capacity_observed_matrix?.[String(machine.machine_number)];
  const morningEndMs = productionStart ? productionStart.getTime() + 4 * 60 * 60_000 : 0;
  const morningShotGapCount = observedSlots && morningEndMs
    ? activeSamples.slice(1).reduce((count, sample, index) => {
      const previous = activeSamples[index];
      if (sample.time.getTime() > morningEndMs
        || sample.time.getTime() - previous.time.getTime() < 15 * 60_000
        || sample.index >= observedSlots.length
        || !observedSlots.slice(previous.index, sample.index + 1).every(Boolean)) return count;
      return count + 1;
    }, 0)
    : 0;

  // The live matrix spans the business-day boundary. Keep the latest observed
  // shot for current machine state, but allocate shots only inside this day.
  const lastSample = activeSamples.at(-1) ?? latestPositiveSample;
  if (!lastSample || !latestTime) {
    return {
      shotCount: normalizedShotCount,
      recentShots: normalizedRecentShots,
      label: machine.display_name || `${machine.machine_number}`,
      lastShotAt: null,
      idleMinutes: null,
      morningShotGapCount,
      expectedCycleTimeSec: null,
      isRunning: false,
    };
  }

  const lookbackStart = new Date(Math.max(
    productionStart?.getTime() ?? lastSample.time.getTime(),
    lastSample.time.getTime() - RUNNING_CT_LOOKBACK_MINUTES * 60 * 1000,
  ));
  const baselineSamples = activeSamples.filter((sample) => sample.time >= lookbackStart && sample.time <= lastSample.time);
  const baselineShots = baselineSamples.reduce((sum, sample) => sum + sample.output, 0);
  const baselineActiveMinutes = baselineSamples.reduce((sum, sample) => sum + sample.intervalMinutes, 0);
  const expectedCycleTimeSec = baselineShots >= 3 && baselineActiveMinutes > 0
    ? (baselineActiveMinutes * 60) / baselineShots
    : null;
  const pauseThresholdMinutes = Math.min(
    RUNNING_IDLE_MAX_MINUTES,
    Math.max(
      RUNNING_IDLE_MIN_MINUTES,
      expectedCycleTimeSec === null
        ? RUNNING_IDLE_MIN_MINUTES
        : (expectedCycleTimeSec * RUNNING_CT_TOLERANCE_MULTIPLIER) / 60 + lastSample.intervalMinutes,
    ),
  );
  const idleMinutes = Math.max(0, (latestTime.getTime() - lastSample.time.getTime()) / (60 * 1000));

  return {
    shotCount: normalizedShotCount,
    recentShots: normalizedRecentShots,
    label: machine.display_name || `${machine.machine_number}`,
    lastShotAt: lastSample.time.toISOString(),
    idleMinutes,
    morningShotGapCount,
    expectedCycleTimeSec,
    isRunning: idleMinutes <= pauseThresholdMinutes,
  };
}

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
    isRunning: shots.isRunning,
    equipmentState: shots.isRunning ? "unplanned_running" : "activity_review",
    hasPlan: false,
    lastShotAt: shots.lastShotAt,
    idleMinutes: shots.idleMinutes,
    morningShotGapCount: shots.morningShotGapCount,
    expectedCycleTimeSec: shots.expectedCycleTimeSec,
    completedCount: 0,
    inProgressCount: 0,
    pendingCount: 0,
    segments: [],
  };
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
      const candidateIndexes = records
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate, candidateIndex }) => (
          candidateIndex >= index
          && !consumed.has(candidateIndex)
          && getRecordCavityGroup(candidate) === groupKey
          && getRecordPartsPerShot(candidate) === partsPerShot
        ))
        .map(({ candidateIndex }) => candidateIndex);

      // A cavity group may repeat later for another LOT. Keep each physical
      // parts-per-shot occurrence separate so later plan rows do not receive
      // the same shots as the active occurrence.
      const selectedIndexes = [index];
      const selectedParts = new Set([normalizeComparableCode(record.part_no)]);
      const expectedParts = groupKey
        .split("+")
        .map((value) => normalizeComparableCode(value))
        .filter(Boolean);

      expectedParts.forEach((expectedPart) => {
        if (selectedIndexes.length >= partsPerShot || selectedParts.has(expectedPart)) return;
        const matchIndex = candidateIndexes.find((candidateIndex) => (
          !selectedIndexes.includes(candidateIndex)
          && normalizeComparableCode(records[candidateIndex]?.part_no) === expectedPart
        ));
        if (matchIndex !== undefined) {
          selectedIndexes.push(matchIndex);
          selectedParts.add(expectedPart);
        }
      });

      candidateIndexes.forEach((candidateIndex) => {
        if (selectedIndexes.length >= partsPerShot) return;
        const candidatePart = normalizeComparableCode(records[candidateIndex]?.part_no);
        if (selectedIndexes.includes(candidateIndex) || selectedParts.has(candidatePart)) return;
        selectedIndexes.push(candidateIndex);
        selectedParts.add(candidatePart);
      });

      // If a declared parallel part is missing, keep the anchor independent.
      // A same-part row here is a later LOT, not a simultaneous cavity member.
      memberIndexes = selectedIndexes.length === partsPerShot
        ? selectedIndexes.sort((left, right) => left - right)
        : [index];
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

function isSameRunningProductGroup(left: PlanAllocationGroup, right: PlanAllocationGroup) {
  if (left.members.length !== right.members.length) return false;
  const exactIdentity = (group: PlanAllocationGroup) => group.members.map((member) => {
    const partNo = normalizeComparableCode(member.record.part_no);
    const modelName = normalizeComparableCode(member.record.model_name);
    return partNo || modelName ? `${partNo}:${modelName}:${member.cavity}` : "";
  }).sort();
  const leftExact = exactIdentity(left);
  const rightExact = exactIdentity(right);
  if (leftExact.every((value, index) => value !== "" && value === rightExact[index])) return true;
  // A different Part No. with the same model and cavity follows the plan
  // sequence provisionally; the field must still confirm physical identity.
  const modelIdentity = (group: PlanAllocationGroup) => group.members.map((member) => {
    const modelName = normalizeComparableCode(member.record.model_name);
    return modelName ? `${modelName}:${member.cavity}` : "";
  }).sort();
  const leftModel = modelIdentity(left);
  const rightModel = modelIdentity(right);
  return leftModel.every((value, index) => value !== "" && value === rightModel[index]);
}

function allocateFallbackGroupShots(groups: PlanAllocationGroup[], totalShots: number) {
  const allocations = groups.map(() => 0);
  let remainingShots = Math.max(0, totalShots);
  let activeGroupIndex = -1;
  groups.forEach((group, index) => {
    if (remainingShots <= 0) return;
    const nextGroup = groups[index + 1];
    const sameProductRollover = nextGroup && isSameRunningProductGroup(group, nextGroup);
    const allocatedShots = sameProductRollover
      ? Math.min(remainingShots, group.requiredShots)
      : remainingShots;
    allocations[index] = allocatedShots;
    remainingShots -= allocatedShots;
    if (allocatedShots > 0) activeGroupIndex = index;
  });
  return { allocations, activeGroupIndex };
}

function getAverageShotYield(records: ProductionPlanRecord[]) {
  const groups = buildPlanAllocationGroups(records);
  const weightedShots = groups.reduce((sum, group) => sum + group.requiredShots, 0);
  if (weightedShots <= 0) return 1;
  return groups.reduce((sum, group) => sum + (group.requiredShots * Math.max(1, group.totalCavity)), 0) / weightedShots;
}

function canRolloverWithoutTransition(left: ProductionPlanRecord | undefined, right: ProductionPlanRecord | undefined) {
  if (!left || !right) return false;
  if (getRecordCavity(left) !== getRecordCavity(right)) return false;
  const leftGroup = getRecordCavityGroup(left);
  const rightGroup = getRecordCavityGroup(right);
  if (leftGroup && leftGroup === rightGroup && getRecordPartsPerShot(left) > 1) return true;

  // A core-suffix variant is a physical change, even when its first nine
  // characters match. Only the same exact part may roll over by quantity.
  const leftPartNo = normalizeComparableCode(left.part_no);
  return Boolean(leftPartNo && leftPartNo === normalizeComparableCode(right.part_no));
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

function getEquipmentTransitionEvents(transitionAnalysis: InjectionTransitionAnalysis | undefined, machineKey: string) {
  return (transitionAnalysis?.events ?? [])
    .filter((event) => (
      event.machineKey === machineKey
      && (event.type === "mold_change" || event.type === "core_change")
      && event.status !== "ongoing"
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
  if (transitions.length === 0 || buildPlanAllocationGroups(records).some((group) => group.members.length > 1)) {
    return null;
  }
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
  const planRecords = planSummary?.injection?.records ?? [];
  const dailyPlanRecords = planRecords.filter((record) => {
    // Existing single-day API responses have undated records. A combined
    // workbook response may include future dates, which are separate targets.
    const planDate = record.plan_date || record.date || planSummary?.plan_date;
    return !businessDate || !planDate || planDate === businessDate;
  });
  const hasOtherDatePlans = dailyPlanRecords.length !== planRecords.length;

  for (const record of dailyPlanRecords) {
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
      shotMap.set(key, buildMachineShotStats(
        mesData,
        machine,
        productionWindow.start,
        productionWindow.end,
        latestTime,
        recentStart,
      ));
    }
  }

  if (productionStatus?.injection?.length) {
    const futureOnlyMachineKeys = new Set(planRecords
      .map((record) => getMachineNumberFromName(record.machine_name) ?? (record.machine_name || "unknown"))
      .filter((key) => !planMap.has(key)));
    const dailyStatusRows = productionStatus.injection.filter((row) => !futureOnlyMachineKeys.has(
      getMachineNumberFromName(row.machine_name) ?? (row.machine_name || "unknown"),
    ));
    return buildStatusBackedProgressSummary(dailyStatusRows, planMap, shotMap, transitionAnalysis, hasOtherDatePlans);
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
    const orderedRecords = getOrderedPlanRecords(plan?.records ?? []);
    const allocationGroups = buildPlanAllocationGroups(orderedRecords);
    const avgCavity = plannedQty > 0 ? getAverageShotYield(orderedRecords) : 1;
    // A plan target cannot establish that a different mould/model has started.
    // Only an identical running product may roll over to its next LOT here.
    const fallbackAllocation = allocateFallbackGroupShots(allocationGroups, shotCount);
    const segments = allocationGroups.flatMap((group, groupIndex) => {
      const allocatedShots = fallbackAllocation.allocations[groupIndex];

      return group.members.map((member) => {
        const record = member.record;
        const segmentPlannedQty = Number(record.planned_quantity ?? 0);
        const cavity = member.cavity;
        const requiredShots = member.requiredShots;
        const estimatedQty = Math.round(allocatedShots * cavity);
        const progressRate = segmentPlannedQty > 0 ? (estimatedQty / segmentPlannedQty) * 100 : 0;
        const status: RealtimeProgressSegmentStatus = groupIndex === fallbackAllocation.activeGroupIndex && allocatedShots > 0
          ? "in_progress"
          : progressRate >= 99.9
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
    const estimatedQty = segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
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
      isRunning: shots?.isRunning ?? false,
      equipmentState: shots?.isRunning
        ? "running"
        : shotCount > 0 && inProgressCount > 0
          ? "paused"
          : "idle",
      hasPlan: true,
      lastShotAt: shots?.lastShotAt ?? null,
      idleMinutes: shots?.idleMinutes ?? null,
      morningShotGapCount: shots?.morningShotGapCount ?? 0,
      expectedCycleTimeSec: shots?.expectedCycleTimeSec ?? null,
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

  const plannedRows = rows.filter((row) => row.hasPlan);
  const unplannedRows = rows.filter((row) => !row.hasPlan && row.shotCount > 0);
  const plannedQty = plannedRows.reduce((sum, row) => sum + row.plannedQty, 0);
  const estimatedQty = plannedRows.reduce((sum, row) => sum + row.estimatedQty, 0);
  const shotCount = rows.reduce((sum, row) => sum + row.shotCount, 0);
  const unplannedShotCount = unplannedRows.reduce((sum, row) => sum + row.shotCount, 0);
  const completedCount = rows.reduce((sum, row) => sum + row.completedCount, 0);
  const inProgressCount = rows.reduce((sum, row) => sum + row.inProgressCount, 0);
  const pendingCount = rows.reduce((sum, row) => sum + row.pendingCount, 0);

  return {
    plannedQty,
    shotCount,
    estimatedQty,
    unplannedShotCount,
    unplannedMachineCount: unplannedRows.length,
    progressRate: plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : 0,
    runningCount: rows.filter((row) => row.isRunning).length,
    pausedCount: rows.filter((row) => row.equipmentState === "paused").length,
    reviewCount: rows.filter((row) => !row.hasPlan).length,
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
  useDailyPlanTargets = false,
): RealtimeProgressSummary {
  const providedStatusKeys = new Set(statusRows.map((statusRow) => (
    getMachineNumberFromName(statusRow.machine_name) ?? (statusRow.machine_name || "unknown")
  )));
  const planOnlyStatusRows = [...planMap.entries()]
    .filter(([key]) => !providedStatusKeys.has(key))
    .map(([, plan]): ProductionStatusMachine => ({
      machine_name: plan.label,
      total_planned: plan.plannedQty,
      total_actual: 0,
      progress: 0,
      parts: plan.records.map((record) => ({
        part_no: record.part_no ?? null,
        model_name: record.model_name ?? record.part_spec ?? null,
        planned_quantity: Number(record.planned_quantity ?? 0),
        actual_quantity: 0,
        progress: 0,
      })),
    }));
  const mergedStatusRows = [...statusRows, ...planOnlyStatusRows];
  const plannedRows = mergedStatusRows.map((statusRow): RealtimeProgressRow => {
    const machineNumber = getMachineNumberFromName(statusRow.machine_name);
    const key = machineNumber ?? (statusRow.machine_name || "unknown");
    const plan = planMap.get(key);
    const shots = shotMap.get(key);
    const orderedRecords = getOrderedPlanRecords(plan?.records ?? []);
    const plannedQty = useDailyPlanTargets && plan ? plan.plannedQty : Number(statusRow.total_planned ?? 0);
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
    const canonicalParts = new Map((statusRow.parts ?? [])
      .filter((part) => part.plan_id != null && part.allocated_shots != null)
      .map((part) => [Number(part.plan_id), part] as const));
    const useCanonicalAllocation = sourceRecords.length > 0
      && sourceRecords.every((record) => record.id != null && canonicalParts.has(Number(record.id)));
    const fallbackAllocation = useMesShotActual && !useCanonicalAllocation
      ? allocateFallbackGroupShots(allocationGroups, shotCount)
      : null;
    const transitionQtyAllocations = useMesShotActual || useCanonicalAllocation
      ? null
      : allocateQuantitiesByTransitionSignals(sourceRecords, statusEstimatedQty, key, transitionAnalysis);
    let remainingActualQty = Math.max(0, statusEstimatedQty);
    const segments = allocationGroups.flatMap((group, groupIndex) => {
      const isLastGroup = groupIndex === allocationGroups.length - 1;
      const canonicalGroupParts = useCanonicalAllocation
        ? group.members.map((member) => canonicalParts.get(Number(member.record.id)))
        : [];
      const allocatedShots = useCanonicalAllocation
        ? Math.max(0, ...canonicalGroupParts.map((part) => Number(part?.allocated_shots ?? 0)))
        : useMesShotActual
        ? fallbackAllocation?.allocations[groupIndex] ?? 0
        : 0;
      const groupActualQty = useCanonicalAllocation
        ? canonicalGroupParts.reduce((sum, part) => sum + Number(part?.actual_quantity ?? 0), 0)
        : useMesShotActual
        ? group.members.reduce((sum, member) => sum + Math.round(allocatedShots * member.cavity), 0)
        : transitionQtyAllocations
          ? group.members.reduce((sum, member) => sum + Math.max(0, transitionQtyAllocations[member.index] ?? 0), 0)
          : isLastGroup
            ? Math.max(0, remainingActualQty)
            : Math.max(0, Math.min(remainingActualQty, group.members.reduce((sum, member) => sum + member.plannedQty, 0)));
      remainingActualQty = Math.max(0, remainingActualQty - groupActualQty);

      return group.members.map((member) => {
        const record = member.record;
        const canonicalPart = useCanonicalAllocation ? canonicalParts.get(Number(record.id)) : undefined;
        const segmentPlannedQty = Number(record.planned_quantity ?? 0);
        const cavity = member.cavity;
        const segmentActualQty = canonicalPart
          ? Number(canonicalPart.actual_quantity ?? 0)
          : useMesShotActual
          ? Math.round(allocatedShots * cavity)
          : transitionQtyAllocations
            ? Math.max(0, transitionQtyAllocations[member.index] ?? 0)
            : group.members.length > 1 && group.totalCavity > 0
              ? Math.round(groupActualQty * (cavity / group.totalCavity))
              : Math.min(groupActualQty, segmentPlannedQty);
        const displayAllocatedShots = canonicalPart
          ? Number(canonicalPart.allocated_shots ?? 0)
          : useMesShotActual
          ? allocatedShots
          : segmentActualQty > 0 ? segmentActualQty / cavity : 0;
        const progressRate = segmentPlannedQty > 0 ? (segmentActualQty / segmentPlannedQty) * 100 : 0;
        const inferredStatus: RealtimeProgressSegmentStatus = progressRate >= 99.9
          ? "completed"
          : progressRate > 0
            ? "in_progress"
            : "pending";
        const status: RealtimeProgressSegmentStatus = canonicalPart?.status === "completed"
          || canonicalPart?.status === "in_progress"
          || canonicalPart?.status === "pending"
          ? canonicalPart.status
          : fallbackAllocation?.activeGroupIndex === groupIndex && allocatedShots > 0
            ? "in_progress"
          : inferredStatus;

        return {
          key: `${record.id ?? member.index}-${record.part_no ?? record.model_name ?? "part"}`,
          planId: record.id ?? null,
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
    const estimatedQty = useMesShotActual || useCanonicalAllocation
      ? segments.reduce((sum, segment) => sum + segment.estimatedQty, 0)
      : statusEstimatedQty;
    const completedCount = segments.filter((segment) => segment.status === "completed").length;
    const inProgressCount = segments.filter((segment) => segment.status === "in_progress").length;
    const pendingCount = segments.filter((segment) => segment.status === "pending").length;
    const recentShots = shots?.recentShots ?? 0;
    const hasPlan = Boolean(plan) || plannedQty > 0;

    return {
      key,
      label: statusRow.machine_name || plan?.label || shots?.label || key,
      plannedQty,
      shotCount,
      unattributedShotCount: Math.max(0, Number(statusRow.unattributed_shots ?? 0)),
      transition: statusRow.transition ?? null,
      recentShots,
      recentCycleTimeSec: recentShots > 0 ? 3600 / recentShots : null,
      estimatedQty,
      progressRate: plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : Number(statusRow.progress ?? 0),
      gapQty: estimatedQty - plannedQty,
      partCount: segments.length,
      avgCavity,
      isRunning: statusRow.transition?.phase === "changeover" ? false : shots?.isRunning ?? false,
      equipmentState: statusRow.transition?.phase === "changeover"
        ? "paused"
        : hasPlan
        ? shots?.isRunning
          ? "running"
          : shotCount > 0 && inProgressCount > 0
            ? "paused"
            : "idle"
        : shots?.isRunning
          ? "unplanned_running"
          : "activity_review",
      hasPlan,
      lastShotAt: shots?.lastShotAt ?? null,
      idleMinutes: shots?.idleMinutes ?? null,
      morningShotGapCount: shots?.morningShotGapCount ?? 0,
      expectedCycleTimeSec: shots?.expectedCycleTimeSec ?? null,
      completedCount,
      inProgressCount,
      pendingCount,
      segments,
    };
  });
  const statusKeys = new Set(mergedStatusRows.map((statusRow) => (
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

  const plannedRowsForSummary = rows.filter((row) => row.hasPlan);
  const unplannedRowsForSummary = rows.filter((row) => !row.hasPlan && row.shotCount > 0);
  const plannedQty = plannedRowsForSummary.reduce((sum, row) => sum + row.plannedQty, 0);
  const estimatedQty = plannedRowsForSummary.reduce((sum, row) => sum + row.estimatedQty, 0);
  const shotCount = rows.reduce((sum, row) => sum + row.shotCount, 0);
  const unplannedShotCount = unplannedRowsForSummary.reduce((sum, row) => sum + row.shotCount, 0);
  const completedCount = rows.reduce((sum, row) => sum + row.completedCount, 0);
  const inProgressCount = rows.reduce((sum, row) => sum + row.inProgressCount, 0);
  const pendingCount = rows.reduce((sum, row) => sum + row.pendingCount, 0);

  return {
    plannedQty,
    shotCount,
    estimatedQty,
    unplannedShotCount,
    unplannedMachineCount: unplannedRowsForSummary.length,
    progressRate: plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : 0,
    runningCount: rows.filter((row) => row.isRunning).length,
    pausedCount: rows.filter((row) => row.equipmentState === "paused").length,
    reviewCount: rows.filter((row) => !row.hasPlan).length,
    completedCount,
    inProgressCount,
    pendingCount,
    partCount: completedCount + inProgressCount + pendingCount,
    rows,
  };
}
