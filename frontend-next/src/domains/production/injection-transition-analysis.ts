import { type InjectionProductionMatrix, type InjectionMachineInfo } from "@/domains/mes/api";
import { type ProductionPlanRecord, type ProductionPlanSummaryResponse } from "@/domains/production/api";

export type InjectionTransitionEventType = "mold_change" | "core_change" | "production_stop" | "tuning";

export type InjectionTransitionEventStatus = "estimated" | "ongoing" | "needs_note";

export type InjectionTransitionFlagType = "overproduction_check" | "advance_production_possible";

export type InjectionTransitionFlag = {
  id: string;
  machineKey: string;
  machineLabel: string;
  type: InjectionTransitionFlagType;
  status: "needs_note";
  sourceEventId?: string;
  targetRecord?: ProductionPlanRecord;
  planDate?: string;
  evidence: {
    producedQty?: number;
    plannedQty?: number;
    excessQty?: number;
    excessRate?: number;
    futurePlanCount?: number;
    outputQty?: number;
  };
};

export type InjectionTransitionEvent = {
  id: string;
  machineKey: string;
  machineLabel: string;
  type: InjectionTransitionEventType;
  status: InjectionTransitionEventStatus;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  confidence: "high" | "medium" | "low";
  fromRecord?: ProductionPlanRecord;
  toRecord?: ProductionPlanRecord;
  targetRecord?: ProductionPlanRecord;
  stableStartTime?: string | null;
  evidence: {
    stopThresholdMinutes: number;
    cumulativeQtyAtStop: number;
    runOutputQty: number;
    completedPlanQty?: number;
    producedForTargetQty?: number;
    targetPlanQty?: number;
    zeroSlotCount?: number;
  };
};

export type InjectionTransitionMachineAnalysis = {
  machineKey: string;
  machineLabel: string;
  events: InjectionTransitionEvent[];
  flags: InjectionTransitionFlag[];
  totals: {
    moldChangeMinutes: number;
    coreChangeMinutes: number;
    tuningMinutes: number;
    productionStopMinutes: number;
    eventCount: number;
    flagCount: number;
    noteRequiredCount: number;
  };
};

export type InjectionTransitionAnalysis = {
  businessDate: string;
  stopThresholdMinutes: number;
  machines: InjectionTransitionMachineAnalysis[];
  events: InjectionTransitionEvent[];
  flags: InjectionTransitionFlag[];
  totals: {
    moldChangeMinutes: number;
    coreChangeMinutes: number;
    tuningMinutes: number;
    productionStopMinutes: number;
    eventCount: number;
    flagCount: number;
    noteRequiredCount: number;
  };
};

type PlanBoundary = {
  record: ProductionPlanRecord;
  index: number;
  startQty: number;
  endQty: number;
  plannedQty: number;
};

type SlotState = {
  index: number;
  time: Date;
  outputShots: number;
  outputQty: number;
  cumulativeBefore: number;
  cumulativeAfter: number;
};

type ActiveRun = {
  startIndex: number;
  endIndex: number;
  startTime: Date;
  endTime: Date;
  startCumulative: number;
  endCumulative: number;
  outputShots: number;
  outputQty: number;
};

type RunPlanContext = {
  planIndex: number;
  boundary: PlanBoundary | null;
  producedBeforeRun: number;
  producedAfterRun: number;
  runProducedQty: number;
};

type GapTransitionContext = {
  runIndex: number;
  nextRunIndex: number;
  gapStartTime: Date;
  gapEndTime: Date;
  gapMinutes: number;
  zeroSlotCount: number;
  type: InjectionTransitionEventType;
  currentContext: RunPlanContext;
  nextContext: RunPlanContext | null;
};

type FuturePlanRecord = {
  planDate: string;
  record: ProductionPlanRecord;
};

const DEFAULT_STOP_THRESHOLD_MINUTES = 10;
const GENERAL_STOP_AFTER_PLAN_COMPLETE_MINUTES = 90;
const OVERPRODUCTION_CHECK_MIN_RATE = 1.05;
const OVERPRODUCTION_CHECK_MIN_QTY = 5;

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

function getBusinessDayStart(businessDate: string) {
  return new Date(`${businessDate}T08:00:00+08:00`);
}

function getBusinessDayEnd(businessDate: string) {
  return new Date(getBusinessDayStart(businessDate).getTime() + 24 * 60 * 60 * 1000);
}

function getLatestTime(data?: InjectionProductionMatrix) {
  const latestSlot = data?.time_slots.at(-1);
  return latestSlot ? new Date(latestSlot.time) : null;
}

function getSlotIntervalMinutes(data: InjectionProductionMatrix, index: number) {
  const explicitInterval = data.time_slots[index]?.interval_minutes;
  if (explicitInterval) return explicitInterval;

  const currentTime = new Date(data.time_slots[index]?.time ?? 0);
  const nextSlot = data.time_slots[index + 1];
  if (!Number.isNaN(currentTime.getTime()) && nextSlot) {
    const nextTime = new Date(nextSlot.time);
    const diffMinutes = (nextTime.getTime() - currentTime.getTime()) / (60 * 1000);
    if (diffMinutes > 0) return diffMinutes;
  }

  return 2;
}

function minutesBetween(startTime: Date, endTime: Date) {
  const minutes = (endTime.getTime() - startTime.getTime()) / (60 * 1000);
  return Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
}

function getMachineMatrixRow(data: InjectionProductionMatrix, machine: InjectionMachineInfo) {
  const candidateKeys = [
    String(machine.machine_number),
    machine.machine_name,
    machine.display_name,
    `${machine.machine_number}호기`,
  ].filter(Boolean);

  for (const key of candidateKeys) {
    const row = data.actual_production_matrix[key];
    if (row) return row;
  }

  return [];
}

function buildPlanMap(planSummary?: ProductionPlanSummaryResponse) {
  const planMap = new Map<string, { label: string; records: ProductionPlanRecord[] }>();

  for (const record of planSummary?.injection.records ?? []) {
    const machineNumber = getMachineNumberFromName(record.machine_name);
    const key = machineNumber ?? record.machine_name ?? "unknown";
    const current = planMap.get(key) ?? {
      label: record.machine_name || (machineNumber ? `${machineNumber}호기` : "-"),
      records: [],
    };
    current.records.push(record);
    planMap.set(key, current);
  }

  return planMap;
}

function buildFuturePlanMap(futurePlanSummaries: ProductionPlanSummaryResponse[]) {
  const planMap = new Map<string, FuturePlanRecord[]>();

  for (const summary of futurePlanSummaries) {
    for (const record of summary.injection.records ?? []) {
      const machineNumber = getMachineNumberFromName(record.machine_name);
      const key = machineNumber ?? record.machine_name ?? "unknown";
      const current = planMap.get(key) ?? [];
      current.push({ planDate: summary.plan_date, record });
      planMap.set(key, current);
    }
  }

  for (const [key, records] of planMap.entries()) {
    planMap.set(key, records.sort((left, right) => {
      if (left.planDate !== right.planDate) return left.planDate.localeCompare(right.planDate);
      const leftSequence = Number(left.record.sequence ?? 0);
      const rightSequence = Number(right.record.sequence ?? 0);
      return leftSequence - rightSequence;
    }));
  }

  return planMap;
}

function buildPlanBoundaries(records: ProductionPlanRecord[]): PlanBoundary[] {
  let cursor = 0;
  return getOrderedPlanRecords(records).map((record, index) => {
    const plannedQty = Math.max(0, Number(record.planned_quantity ?? 0) || 0);
    const boundary = {
      record,
      index,
      startQty: cursor,
      endQty: cursor + plannedQty,
      plannedQty,
    };
    cursor += plannedQty;
    return boundary;
  });
}

function getCavity(record: ProductionPlanRecord | undefined) {
  return Math.max(1, Number(record?.cavity ?? 1) || 1);
}

function normalizePartNo(record: ProductionPlanRecord | undefined) {
  return String(record?.part_no ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function normalizeModelName(record: ProductionPlanRecord | undefined) {
  return String(record?.model_name ?? "").trim().toUpperCase();
}

function hasSamePartNoExceptLastTwo(fromRecord: ProductionPlanRecord | undefined, toRecord: ProductionPlanRecord | undefined) {
  const fromPartNo = normalizePartNo(fromRecord);
  const toPartNo = normalizePartNo(toRecord);
  if (fromPartNo.length !== 11 || toPartNo.length !== 11) return false;
  return fromPartNo.slice(0, -2) === toPartNo.slice(0, -2) && fromPartNo.slice(-2) !== toPartNo.slice(-2);
}

function getPlannedTransitionType(
  fromRecord: ProductionPlanRecord | undefined,
  toRecord: ProductionPlanRecord | undefined,
): InjectionTransitionEventType {
  const fromPartNo = normalizePartNo(fromRecord);
  const toPartNo = normalizePartNo(toRecord);
  if (fromPartNo.length === 11 && toPartNo.length === 11) {
    if (fromPartNo === toPartNo) return "production_stop";
    if (hasSamePartNoExceptLastTwo(fromRecord, toRecord)) return "core_change";
    return "mold_change";
  }
  if (fromPartNo && toPartNo && fromPartNo === toPartNo) return "production_stop";

  const fromModelName = normalizeModelName(fromRecord);
  const toModelName = normalizeModelName(toRecord);
  if (fromModelName && toModelName && fromModelName !== toModelName) return "mold_change";
  return "production_stop";
}

function isEquipmentChangeEvent(type: InjectionTransitionEventType) {
  return type === "mold_change" || type === "core_change";
}

function shouldFlagOverproduction(context: RunPlanContext) {
  const plannedQty = context.boundary?.plannedQty ?? 0;
  if (plannedQty <= 0) return false;
  const excessQty = context.producedAfterRun - plannedQty;
  return (
    excessQty >= OVERPRODUCTION_CHECK_MIN_QTY
    && context.producedAfterRun / plannedQty >= OVERPRODUCTION_CHECK_MIN_RATE
  );
}

function createOverproductionFlag(
  machineKey: string,
  machineLabel: string,
  eventId: string,
  context: RunPlanContext,
) {
  const plannedQty = context.boundary?.plannedQty ?? 0;
  const producedQty = context.producedAfterRun;
  const excessQty = Math.max(0, producedQty - plannedQty);
  return {
    id: `${eventId}-overproduction`,
    machineKey,
    machineLabel,
    type: "overproduction_check" as const,
    status: "needs_note" as const,
    sourceEventId: eventId,
    targetRecord: context.boundary?.record,
    evidence: {
      producedQty: Math.round(producedQty),
      plannedQty: Math.round(plannedQty),
      excessQty: Math.round(excessQty),
      excessRate: plannedQty > 0 ? (producedQty / plannedQty) * 100 : undefined,
    },
  };
}

function createAdvanceProductionFlag(
  machineKey: string,
  machineLabel: string,
  futurePlan: FuturePlanRecord | undefined,
  outputQty: number,
) {
  if (!futurePlan || outputQty <= 0) return null;
  return {
    id: `${machineKey}-${futurePlan.planDate}-${futurePlan.record.id ?? futurePlan.record.sequence ?? "future"}-advance`,
    machineKey,
    machineLabel,
    type: "advance_production_possible" as const,
    status: "needs_note" as const,
    targetRecord: futurePlan.record,
    planDate: futurePlan.planDate,
    evidence: {
      outputQty: Math.round(outputQty),
      futurePlanCount: 1,
      plannedQty: Math.round(Number(futurePlan.record.planned_quantity ?? 0) || 0),
    },
  };
}

function addOverproductionFlag(
  flags: InjectionTransitionFlag[],
  machineKey: string,
  machineLabel: string,
  sourceEventId: string,
  context: RunPlanContext,
) {
  if (!shouldFlagOverproduction(context)) return;
  const record = context.boundary?.record;
  const recordKey = `${record?.id ?? record?.part_no ?? context.planIndex}`;
  const hasSameFlag = flags.some((flag) => (
    flag.type === "overproduction_check"
    && `${flag.targetRecord?.id ?? flag.targetRecord?.part_no ?? ""}` === recordKey
  ));
  if (!hasSameFlag) {
    flags.push(createOverproductionFlag(machineKey, machineLabel, sourceEventId, context));
  }
}

function buildSlotStates(
  data: InjectionProductionMatrix,
  productionRow: number[],
  businessDate: string,
): SlotState[] {
  const dayStart = getBusinessDayStart(businessDate);
  const dayEnd = getBusinessDayEnd(businessDate);
  const latestTime = getLatestTime(data);
  const referenceEnd = latestTime
    ? new Date(Math.min(Math.max(latestTime.getTime(), dayStart.getTime()), dayEnd.getTime()))
    : dayEnd;
  let cumulativeShots = 0;
  const states: SlotState[] = [];

  data.time_slots.forEach((slot, index) => {
    const time = new Date(slot.time);
    if (time < dayStart || time > referenceEnd) return;

    const outputShots = Math.max(0, numberAt(productionRow, index));
    const cumulativeBefore = cumulativeShots;
    cumulativeShots += outputShots;
    states.push({
      index,
      time,
      outputShots,
      outputQty: outputShots,
      cumulativeBefore,
      cumulativeAfter: cumulativeShots,
    });
  });

  return states;
}

function buildActiveRuns(
  data: InjectionProductionMatrix,
  slotStates: SlotState[],
  stopThresholdMinutes: number,
): ActiveRun[] {
  const runs: ActiveRun[] = [];
  let currentRun: ActiveRun | null = null;
  let previousActiveState: SlotState | null = null;

  for (const state of slotStates) {
    if (state.outputShots <= 0) continue;

    const gapMinutes = previousActiveState
      ? getGapMinutes(data, previousActiveState.index, state.index)
      : 0;

    const isCompensatedGap = isCompensatedMesCollectionGap(
      data,
      currentRun,
      previousActiveState,
      state,
      stopThresholdMinutes,
    );

    if (!currentRun || (gapMinutes >= stopThresholdMinutes && !isCompensatedGap)) {
      currentRun = {
        startIndex: state.index,
        endIndex: state.index,
        startTime: state.time,
        endTime: state.time,
        startCumulative: state.cumulativeBefore,
        endCumulative: state.cumulativeAfter,
        outputShots: state.outputShots,
        outputQty: state.outputQty,
      };
      runs.push(currentRun);
    } else {
      currentRun.endIndex = state.index;
      currentRun.endTime = state.time;
      currentRun.endCumulative = state.cumulativeAfter;
      currentRun.outputShots += state.outputShots;
      currentRun.outputQty += state.outputQty;
    }

    previousActiveState = state;
  }

  return runs;
}

function getGapMinutes(data: InjectionProductionMatrix, previousActiveIndex: number, nextActiveIndex: number) {
  const previousTime = new Date(data.time_slots[previousActiveIndex]?.time ?? 0);
  const nextTime = new Date(data.time_slots[nextActiveIndex]?.time ?? 0);
  const previousInterval = getSlotIntervalMinutes(data, previousActiveIndex);
  const gapStart = new Date(previousTime.getTime() + previousInterval * 60 * 1000);
  return minutesBetween(gapStart, nextTime);
}

function getGapStartTime(data: InjectionProductionMatrix, previousActiveIndex: number) {
  const previousTime = new Date(data.time_slots[previousActiveIndex]?.time ?? 0);
  const previousInterval = getSlotIntervalMinutes(data, previousActiveIndex);
  return new Date(previousTime.getTime() + previousInterval * 60 * 1000);
}

function getSlotEndTime(data: InjectionProductionMatrix, index: number) {
  const slotTime = new Date(data.time_slots[index]?.time ?? 0);
  const intervalMinutes = getSlotIntervalMinutes(data, index);
  return new Date(slotTime.getTime() + intervalMinutes * 60 * 1000);
}

function getRunRatePerMinute(data: InjectionProductionMatrix, run: ActiveRun) {
  const durationMinutes = minutesBetween(run.startTime, getSlotEndTime(data, run.endIndex));
  if (durationMinutes <= 0) return 0;
  return run.outputShots / durationMinutes;
}

function isCompensatedMesCollectionGap(
  data: InjectionProductionMatrix,
  currentRun: ActiveRun | null,
  previousActiveState: SlotState | null,
  nextActiveState: SlotState,
  stopThresholdMinutes: number,
) {
  if (!currentRun || !previousActiveState) return false;
  const gapMinutes = getGapMinutes(data, previousActiveState.index, nextActiveState.index);
  if (gapMinutes < stopThresholdMinutes) return false;

  const priorRatePerMinute = getRunRatePerMinute(data, currentRun);
  if (priorRatePerMinute <= 0) return false;

  const compensationWindowMinutes = minutesBetween(
    getGapStartTime(data, previousActiveState.index),
    getSlotEndTime(data, nextActiveState.index),
  );
  if (compensationWindowMinutes <= 0) return false;

  const expectedCompensatedOutput = priorRatePerMinute * compensationWindowMinutes;
  const compensatedRatePerMinute = nextActiveState.outputShots / compensationWindowMinutes;

  return (
    nextActiveState.outputShots >= Math.max(2, expectedCompensatedOutput * 0.65)
    && nextActiveState.outputShots <= Math.max(2, expectedCompensatedOutput * 1.6)
    && compensatedRatePerMinute >= priorRatePerMinute * 0.65
    && compensatedRatePerMinute <= priorRatePerMinute * 1.6
  );
}

function countZeroSlots(productionRow: number[], previousActiveIndex: number, nextActiveIndex: number) {
  let count = 0;
  for (let index = previousActiveIndex + 1; index < nextActiveIndex; index += 1) {
    if (numberAt(productionRow, index) <= 0) count += 1;
  }
  return count;
}

function findStableStartIndex(data: InjectionProductionMatrix, productionRow: number[], run: ActiveRun) {
  const positiveIndices: number[] = [];
  for (let index = run.startIndex; index <= run.endIndex; index += 1) {
    if (numberAt(productionRow, index) > 0) positiveIndices.push(index);
  }

  for (let cursor = 0; cursor <= positiveIndices.length - 3; cursor += 1) {
    const window = positiveIndices.slice(cursor, cursor + 3);
    const isConsecutive = window.every((index, offset) => {
      if (offset === 0) return true;
      return getGapMinutes(data, window[offset - 1], index) <= 0;
    });
    if (!isConsecutive) continue;

    const values = window.map((index) => numberAt(productionRow, index));
    const max = Math.max(...values);
    const min = Math.min(...values);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (min > 0 && max - min <= Math.max(1, average * 0.35)) {
      return window[0];
    }
  }

  return null;
}

function getBoundaryForPlanIndex(boundaries: PlanBoundary[], planIndex: number) {
  if (!boundaries.length) return null;
  const clampedIndex = Math.min(Math.max(0, planIndex), boundaries.length - 1);
  return boundaries[clampedIndex] ?? null;
}

function getRunProducedQty(run: ActiveRun, boundary: PlanBoundary | null) {
  return run.outputShots * getCavity(boundary?.record);
}

function isPlanComplete(context: RunPlanContext) {
  if (!context.boundary) return false;
  return context.producedAfterRun >= context.boundary.plannedQty;
}

function isGeneralStopContext(context: RunPlanContext, boundaries: PlanBoundary[]) {
  if (!context.boundary) return true;
  return isPlanComplete(context) && context.planIndex >= boundaries.length - 1;
}

function isDelayedNextPlanGeneralStop(
  context: RunPlanContext,
  boundaries: PlanBoundary[],
  gapMinutes: number,
) {
  return (
    context.boundary !== null
    && isPlanComplete(context)
    && context.planIndex < boundaries.length - 1
    && gapMinutes >= GENERAL_STOP_AFTER_PLAN_COMPLETE_MINUTES
  );
}

function buildRunPlanContexts(
  data: InjectionProductionMatrix,
  productionRow: number[],
  boundaries: PlanBoundary[],
  runs: ActiveRun[],
  stopThresholdMinutes: number,
) {
  const runContexts: RunPlanContext[] = [];
  const gapContexts: GapTransitionContext[] = [];
  let planIndex = 0;
  let producedForCurrentPlan = 0;

  runs.forEach((run, runIndex) => {
    const boundary = getBoundaryForPlanIndex(boundaries, planIndex);
    const runProducedQty = getRunProducedQty(run, boundary);
    const currentContext = {
      planIndex,
      boundary,
      producedBeforeRun: producedForCurrentPlan,
      producedAfterRun: producedForCurrentPlan + runProducedQty,
      runProducedQty,
    };
    runContexts[runIndex] = currentContext;

    const nextRun = runs[runIndex + 1];
    if (!nextRun) {
      producedForCurrentPlan = currentContext.producedAfterRun;
      return;
    }

    const gapStartTime = getGapStartTime(data, run.endIndex);
    const gapEndTime = nextRun.startTime;
    const gapMinutes = minutesBetween(gapStartTime, gapEndTime);
    if (gapMinutes < stopThresholdMinutes) {
      producedForCurrentPlan = currentContext.producedAfterRun;
      return;
    }

    const hasNextPlan = currentContext.boundary !== null && planIndex < boundaries.length - 1;
    const shouldAdvancePlan = hasNextPlan && isPlanComplete(currentContext);
    const nextPlanIndex = shouldAdvancePlan ? planIndex + 1 : planIndex;
    if (isGeneralStopContext(currentContext, boundaries)) {
      producedForCurrentPlan = currentContext.producedAfterRun;
      return;
    }

    if (shouldAdvancePlan && isDelayedNextPlanGeneralStop(currentContext, boundaries, gapMinutes)) {
      planIndex = nextPlanIndex;
      producedForCurrentPlan = 0;
      return;
    }

    const nextBoundary = getBoundaryForPlanIndex(boundaries, nextPlanIndex);
    const type = shouldAdvancePlan
      ? getPlannedTransitionType(currentContext.boundary?.record, nextBoundary?.record)
      : "production_stop";
    gapContexts.push({
      runIndex,
      nextRunIndex: runIndex + 1,
      gapStartTime,
      gapEndTime,
      gapMinutes,
      zeroSlotCount: countZeroSlots(productionRow, run.endIndex, nextRun.startIndex),
      type,
      currentContext,
      nextContext: nextBoundary ? {
        planIndex: nextPlanIndex,
        boundary: nextBoundary,
        producedBeforeRun: shouldAdvancePlan ? 0 : currentContext.producedAfterRun,
        producedAfterRun: shouldAdvancePlan ? 0 : currentContext.producedAfterRun,
        runProducedQty: 0,
      } : null,
    });

    if (shouldAdvancePlan) {
      planIndex = nextPlanIndex;
      producedForCurrentPlan = 0;
      return;
    }

    producedForCurrentPlan = currentContext.producedAfterRun;
  });

  return { runContexts, gapContexts };
}

function buildMachineAnalysis(
  data: InjectionProductionMatrix,
  machine: InjectionMachineInfo,
  planRecords: ProductionPlanRecord[],
  futurePlanRecords: FuturePlanRecord[],
  businessDate: string,
  stopThresholdMinutes: number,
): InjectionTransitionMachineAnalysis {
  const machineKey = String(machine.machine_number);
  const machineLabel = machine.display_name || machine.machine_name || `${machine.machine_number}호기`;
  const productionRow = getMachineMatrixRow(data, machine);
  const boundaries = buildPlanBoundaries(planRecords);
  const totalOutputQty = productionRow.reduce((sum, value) => sum + Math.max(0, Number(value ?? 0) || 0), 0);
  const flags: InjectionTransitionFlag[] = [];
  if (!boundaries.length) {
    const advanceFlag = createAdvanceProductionFlag(machineKey, machineLabel, futurePlanRecords[0], totalOutputQty);
    if (advanceFlag) flags.push(advanceFlag);
    return { machineKey, machineLabel, events: [], flags, totals: sumTransitionTotals([], flags) };
  }

  const slotStates = buildSlotStates(data, productionRow, businessDate);
  const runs = buildActiveRuns(data, slotStates, stopThresholdMinutes);
  const events: InjectionTransitionEvent[] = [];
  const { runContexts, gapContexts } = buildRunPlanContexts(
    data,
    productionRow,
    boundaries,
    runs,
    stopThresholdMinutes,
  );
  runContexts.forEach((context) => {
    addOverproductionFlag(flags, machineKey, machineLabel, `${machineKey}-plan-${context.planIndex}-overproduction`, context);
  });

  gapContexts.forEach((gapContext) => {
    const nextRun = runs[gapContext.nextRunIndex];
    const nextContext = runContexts[gapContext.nextRunIndex] ?? gapContext.nextContext;
    const currentBoundary = gapContext.currentContext.boundary;
    const nextBoundary = nextContext?.boundary ?? null;

    if (isEquipmentChangeEvent(gapContext.type)) {
      const eventId = `${machineKey}-${gapContext.runIndex}-${gapContext.nextRunIndex}-${gapContext.type}`;
      events.push({
        id: eventId,
        machineKey,
        machineLabel,
        type: gapContext.type,
        status: "needs_note",
        startTime: gapContext.gapStartTime.toISOString(),
        endTime: gapContext.gapEndTime.toISOString(),
        durationMinutes: gapContext.gapMinutes,
        confidence: "medium",
        fromRecord: currentBoundary?.record,
        toRecord: nextBoundary?.record,
        evidence: {
          stopThresholdMinutes,
          cumulativeQtyAtStop: Math.round(gapContext.currentContext.producedAfterRun),
          runOutputQty: Math.round(gapContext.currentContext.runProducedQty),
          completedPlanQty: Math.round(currentBoundary?.plannedQty ?? 0),
          zeroSlotCount: gapContext.zeroSlotCount,
        },
      });
      addOverproductionFlag(flags, machineKey, machineLabel, eventId, gapContext.currentContext);
    } else {
      const eventId = `${machineKey}-${gapContext.runIndex}-${gapContext.nextRunIndex}-production-stop`;
      events.push({
        id: eventId,
        machineKey,
        machineLabel,
        type: "production_stop",
        status: "needs_note",
        startTime: gapContext.gapStartTime.toISOString(),
        endTime: gapContext.gapEndTime.toISOString(),
        durationMinutes: gapContext.gapMinutes,
        confidence: "medium",
        targetRecord: currentBoundary?.record,
        evidence: {
          stopThresholdMinutes,
          cumulativeQtyAtStop: Math.round(gapContext.currentContext.producedAfterRun),
          runOutputQty: Math.round(gapContext.currentContext.runProducedQty),
          producedForTargetQty: Math.round(gapContext.currentContext.producedAfterRun),
          targetPlanQty: Math.round(currentBoundary?.plannedQty ?? 0),
          zeroSlotCount: gapContext.zeroSlotCount,
        },
      });
      addOverproductionFlag(flags, machineKey, machineLabel, eventId, gapContext.currentContext);
    }

    if (!nextRun) return;
    const stableStartIndex = findStableStartIndex(data, productionRow, nextRun);
    const stableStartTime = stableStartIndex !== null
      ? new Date(data.time_slots[stableStartIndex]?.time ?? nextRun.startTime)
      : null;
    const tuningEndTime = stableStartTime ?? new Date(
      nextRun.endTime.getTime() + getSlotIntervalMinutes(data, nextRun.endIndex) * 60 * 1000,
    );
    const tuningMinutes = minutesBetween(nextRun.startTime, tuningEndTime);
    if (tuningMinutes > 0) {
      events.push({
        id: `${machineKey}-${nextRun.startIndex}-tuning`,
        machineKey,
        machineLabel,
        type: "tuning",
        status: "needs_note",
        startTime: nextRun.startTime.toISOString(),
        endTime: tuningEndTime.toISOString(),
        durationMinutes: tuningMinutes,
        confidence: stableStartTime ? "medium" : "low",
        targetRecord: nextBoundary?.record,
        stableStartTime: stableStartTime?.toISOString() ?? null,
        evidence: {
          stopThresholdMinutes,
          cumulativeQtyAtStop: Math.round(nextContext?.producedBeforeRun ?? 0),
          runOutputQty: Math.round(nextContext?.runProducedQty ?? getRunProducedQty(nextRun, nextBoundary)),
          producedForTargetQty: Math.round(nextContext?.producedAfterRun ?? 0),
          targetPlanQty: Math.round(nextBoundary?.plannedQty ?? 0),
        },
      });
    }
  });

  const latestTime = getLatestTime(data);
  const lastRun = runs.at(-1);
  const lastContext = runContexts.at(-1);
  if (latestTime && lastRun && lastContext) {
    const ongoingStartTime = getGapStartTime(data, lastRun.endIndex);
    const ongoingGapMinutes = minutesBetween(ongoingStartTime, latestTime);
    if (
      ongoingGapMinutes >= stopThresholdMinutes
      && !isGeneralStopContext(lastContext, boundaries)
      && !isDelayedNextPlanGeneralStop(lastContext, boundaries, ongoingGapMinutes)
    ) {
      const hasNextPlan = lastContext.boundary !== null && lastContext.planIndex < boundaries.length - 1;
      const nextBoundary = hasNextPlan
        ? getBoundaryForPlanIndex(boundaries, lastContext.planIndex + 1)
        : null;
      const type: InjectionTransitionEventType = hasNextPlan && isPlanComplete(lastContext)
        ? getPlannedTransitionType(lastContext.boundary?.record, nextBoundary?.record)
        : "production_stop";
      const eventId = `${machineKey}-${lastRun.endIndex}-ongoing-${type}`;
      events.push({
        id: eventId,
        machineKey,
        machineLabel,
        type,
        status: "ongoing",
        startTime: ongoingStartTime.toISOString(),
        endTime: latestTime.toISOString(),
        durationMinutes: ongoingGapMinutes,
        confidence: "low",
        fromRecord: isEquipmentChangeEvent(type) ? lastContext.boundary?.record : undefined,
        toRecord: isEquipmentChangeEvent(type) ? nextBoundary?.record : undefined,
        targetRecord: isEquipmentChangeEvent(type) ? undefined : nextBoundary?.record ?? lastContext.boundary?.record,
        evidence: {
          stopThresholdMinutes,
          cumulativeQtyAtStop: Math.round(lastContext.producedAfterRun),
          runOutputQty: Math.round(lastContext.runProducedQty),
          completedPlanQty: isEquipmentChangeEvent(type) ? Math.round(lastContext.boundary?.plannedQty ?? 0) : undefined,
          producedForTargetQty: isEquipmentChangeEvent(type) ? undefined : Math.round(lastContext.producedAfterRun),
          targetPlanQty: isEquipmentChangeEvent(type) ? undefined : Math.round((nextBoundary ?? lastContext.boundary)?.plannedQty ?? 0),
        },
      });
      addOverproductionFlag(flags, machineKey, machineLabel, eventId, lastContext);
    }
  }

  const mergedEvents = mergePreparationSequences(events, stopThresholdMinutes);
  const totals = sumTransitionTotals(mergedEvents, flags);
  return { machineKey, machineLabel, events: mergedEvents, flags, totals };
}

function mergePreparationSequences(
  events: InjectionTransitionEvent[],
  stopThresholdMinutes: number,
) {
  const mergedEvents: InjectionTransitionEvent[] = [];
  let index = 0;

  while (index < events.length) {
    const event = events[index];
    if (isEquipmentChangeEvent(event.type)) {
      mergedEvents.push(event);
      index += 1;
      continue;
    }

    const cluster = [event];
    let cursor = index + 1;
    while (cursor < events.length) {
      const previous = cluster[cluster.length - 1];
      const next = events[cursor];
      if (next.machineKey !== event.machineKey || isEquipmentChangeEvent(next.type)) break;
      const gapMinutes = minutesBetween(new Date(previous.endTime), new Date(next.startTime));
      if (gapMinutes > stopThresholdMinutes) break;
      cluster.push(next);
      cursor += 1;
    }

    const tuningCount = cluster.filter((clusterEvent) => clusterEvent.type === "tuning").length;
    const productionStopCount = cluster.filter((clusterEvent) => clusterEvent.type === "production_stop").length;
    if (cluster.length >= 3 && tuningCount > 0 && productionStopCount > 0) {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      const producedForTargetQty = Math.max(
        ...cluster.map((clusterEvent) => Number(clusterEvent.evidence.producedForTargetQty ?? 0)),
      );
      const targetPlanQty = [...cluster]
        .reverse()
        .find((clusterEvent) => clusterEvent.evidence.targetPlanQty !== undefined)
        ?.evidence.targetPlanQty;
      mergedEvents.push({
        ...first,
        id: `${first.id}-merged-${last.id}`,
        type: "tuning",
        status: cluster.some((clusterEvent) => clusterEvent.status === "ongoing") ? "ongoing" : "needs_note",
        endTime: last.endTime,
        durationMinutes: minutesBetween(new Date(first.startTime), new Date(last.endTime)),
        confidence: cluster.some((clusterEvent) => clusterEvent.confidence === "low") ? "low" : "medium",
        targetRecord: last.targetRecord ?? first.targetRecord,
        stableStartTime: [...cluster]
          .reverse()
          .find((clusterEvent) => clusterEvent.stableStartTime)
          ?.stableStartTime ?? null,
        evidence: {
          stopThresholdMinutes,
          cumulativeQtyAtStop: first.evidence.cumulativeQtyAtStop,
          runOutputQty: cluster.reduce((sum, clusterEvent) => sum + Number(clusterEvent.evidence.runOutputQty ?? 0), 0),
          producedForTargetQty,
          targetPlanQty,
          zeroSlotCount: cluster.reduce((sum, clusterEvent) => sum + Number(clusterEvent.evidence.zeroSlotCount ?? 0), 0),
        },
      });
    } else {
      mergedEvents.push(...cluster);
    }

    index = cursor;
  }

  return mergedEvents;
}

function sumTransitionTotals(events: InjectionTransitionEvent[], flags: InjectionTransitionFlag[] = []) {
  const totals = events.reduce(
    (totals, event) => {
      totals.eventCount += 1;
      if (event.status === "needs_note" || event.status === "ongoing") {
        totals.noteRequiredCount += 1;
      }
      if (event.type === "mold_change") totals.moldChangeMinutes += event.durationMinutes;
      if (event.type === "core_change") totals.coreChangeMinutes += event.durationMinutes;
      if (event.type === "tuning") totals.tuningMinutes += event.durationMinutes;
      if (event.type === "production_stop") totals.productionStopMinutes += event.durationMinutes;
      return totals;
    },
    {
      moldChangeMinutes: 0,
      coreChangeMinutes: 0,
      tuningMinutes: 0,
      productionStopMinutes: 0,
      eventCount: 0,
      flagCount: 0,
      noteRequiredCount: 0,
    },
  );
  totals.flagCount = flags.length;
  totals.noteRequiredCount += flags.filter((flag) => flag.status === "needs_note").length;
  return totals;
}

export function buildInjectionTransitionAnalysis(
  planSummary: ProductionPlanSummaryResponse | undefined,
  mesData: InjectionProductionMatrix | undefined,
  businessDate: string,
  stopThresholdMinutes = DEFAULT_STOP_THRESHOLD_MINUTES,
  futurePlanSummaries: ProductionPlanSummaryResponse[] = [],
): InjectionTransitionAnalysis {
  if (!mesData || !businessDate) {
    return {
      businessDate,
      stopThresholdMinutes,
      machines: [],
      events: [],
      flags: [],
      totals: sumTransitionTotals([]),
    };
  }

  const planMap = buildPlanMap(planSummary);
  const futurePlanMap = buildFuturePlanMap(futurePlanSummaries);
  const machines = mesData.machines.map((machine) => {
    const key = String(machine.machine_number);
    const planRecords = planMap.get(key)?.records ?? [];
    const futurePlanRecords = futurePlanMap.get(key) ?? [];
    return buildMachineAnalysis(mesData, machine, planRecords, futurePlanRecords, businessDate, stopThresholdMinutes);
  }).filter((machine) => machine.events.length > 0 || machine.flags.length > 0);
  const events = machines
    .flatMap((machine) => machine.events)
    .sort((left, right) => new Date(right.startTime).getTime() - new Date(left.startTime).getTime());
  const flags = machines.flatMap((machine) => machine.flags);

  return {
    businessDate,
    stopThresholdMinutes,
    machines,
    events,
    flags,
    totals: sumTransitionTotals(events, flags),
  };
}
