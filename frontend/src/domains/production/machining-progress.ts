import type {
  MachiningProvisionResponse,
  MachiningProvisionRow,
  ProductionMesReportStatsResponse,
  ProductionPlanRecord,
  ProductionPlanSummaryResponse,
} from "./api.ts";
import type { RealtimeProgressSegment, RealtimeProgressSegmentStatus } from "./realtime-progress.ts";

export type MachiningProgressRow = {
  key: string;
  label: string;
  plannedQty: number;
  actualQty: number;
  gapQty: number;
  progressRate: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  mesQty: number;
  manualOpenQty: number;
  matchedManualQty: number;
  defectQty: number;
  status: MachiningProvisionRow["status"] | "legacy";
  provisionRow?: MachiningProvisionRow;
  segments: RealtimeProgressSegment[];
};

export type MachiningDateProgress = {
  date: string;
  plannedQty: number;
  actualQty: number;
  partCount: number;
  progressRate: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  rows: MachiningProgressRow[];
};

export type MachiningProgressPreview = Omit<MachiningDateProgress, "date"> & {
  /** All actual output reported during the selected business day, including advance production. */
  actualQty: number;
  /** Actual output allocated to today's plans and unplanned output. */
  dailyActualQty: number;
  /** Selected business-day output allocated to a later dated plan. */
  advanceQty: number;
  futureDates: MachiningDateProgress[];
};

type DatedPlanRecord = ProductionPlanRecord & { plan_date?: string | null };
type ProgressItem = {
  date: string | null;
  equipmentKey: string;
  label: string;
  segment: RealtimeProgressSegment;
  mesQty: number;
  manualOpenQty: number;
  matchedManualQty: number;
  defectQty: number;
  status: MachiningProgressRow["status"];
  provisionRow?: MachiningProvisionRow;
};

function displayValue(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text === "-" ? "" : text;
}

export function getPlanDisplayName(
  partNo: string | null | undefined,
  modelName: string | null | undefined,
  partSpec?: string | null,
) {
  return displayValue(partNo) || displayValue(modelName) || displayValue(partSpec) || "-";
}

function comparablePartNo(value: string | null | undefined) {
  return displayValue(value).replace(/\s+/g, "").toUpperCase();
}

function rate(actualQty: number, plannedQty: number) {
  return plannedQty > 0 ? (actualQty / plannedQty) * 100 : actualQty > 0 ? 100 : 0;
}

function segmentStatus(actualQty: number, plannedQty: number): RealtimeProgressSegmentStatus {
  return plannedQty > 0 && actualQty >= plannedQty
    ? "completed"
    : actualQty > 0 ? "in_progress" : "pending";
}

function buildDateProgress(date: string, items: ProgressItem[]): MachiningDateProgress {
  const groups = new Map<string, ProgressItem[]>();
  for (const item of items) {
    groups.set(item.equipmentKey, [...(groups.get(item.equipmentKey) ?? []), item]);
  }
  const statusPriority: MachiningProgressRow["status"][] = [
    "manual_mismatch", "manual_open", "manual_partial", "manual_matched", "mes_reported",
  ];
  const rows = [...groups.entries()].map(([key, group]): MachiningProgressRow => {
    const segments = group.map((item) => item.segment).sort((left, right) => left.sequence - right.sequence);
    const plannedQty = segments.reduce((sum, segment) => sum + segment.plannedQty, 0);
    const actualQty = segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
    const provisionRow = group.map((item) => item.provisionRow).filter((item) => Boolean(item?.plan_id))
      .sort((left, right) => {
        const leftDone = Number(left!.planned_qty) > 0 && Number(left!.effective_actual_qty) >= Number(left!.planned_qty);
        const rightDone = Number(right!.planned_qty) > 0 && Number(right!.effective_actual_qty) >= Number(right!.planned_qty);
        return Number(leftDone) - Number(rightDone) || Number(left!.sequence) - Number(right!.sequence);
      })[0];
    return {
      key,
      label: group[0].label,
      plannedQty,
      actualQty,
      gapQty: actualQty - plannedQty,
      progressRate: rate(actualQty, plannedQty),
      completedCount: segments.filter((segment) => segment.status === "completed").length,
      inProgressCount: segments.filter((segment) => segment.status === "in_progress").length,
      pendingCount: segments.filter((segment) => segment.status === "pending").length,
      mesQty: group.reduce((sum, item) => sum + item.mesQty, 0),
      manualOpenQty: group.reduce((sum, item) => sum + item.manualOpenQty, 0),
      matchedManualQty: group.reduce((sum, item) => sum + item.matchedManualQty, 0),
      defectQty: group.reduce((sum, item) => sum + item.defectQty, 0),
      status: statusPriority.find((status) => group.some((item) => item.status === status)) ?? group[0].status,
      provisionRow,
      segments,
    };
  }).sort((left, right) => left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" }));
  const plannedQty = rows.reduce((sum, row) => sum + row.plannedQty, 0);
  const actualQty = rows.reduce((sum, row) => sum + row.actualQty, 0);
  return {
    date,
    plannedQty,
    actualQty,
    partCount: rows.reduce((sum, row) => sum + row.segments.length, 0),
    progressRate: rate(actualQty, plannedQty),
    completedCount: rows.reduce((sum, row) => sum + row.completedCount, 0),
    inProgressCount: rows.reduce((sum, row) => sum + row.inProgressCount, 0),
    pendingCount: rows.reduce((sum, row) => sum + row.pendingCount, 0),
    rows,
  };
}

function provisionItems(provision: MachiningProvisionResponse): ProgressItem[] {
  return provision.rows.map((row, index) => {
    const plannedQty = Number(row.planned_qty ?? 0);
    const actualQty = Number(row.effective_actual_qty ?? 0);
    return {
      date: row.plan_date,
      equipmentKey: row.equipment_key || row.equipment_label || row.machine_name || `unknown-${index}`,
      label: row.equipment_label || row.machine_name || row.equipment_key || "-",
      segment: {
        key: `${row.plan_id ?? (row.plan_identity_hash || index)}-${row.part_no}-${index}`,
        planId: row.plan_id,
        sequence: Number(row.sequence ?? index + 1),
        partNo: displayValue(row.part_no) || "-",
        modelName: displayValue(row.model_name) || "-",
        lotNo: row.lot_no || "-",
        productFamilyCode: null,
        productFamilyName: null,
        isFinishedProduct: false,
        plannedQty,
        cavity: 1,
        requiredShots: plannedQty,
        allocatedShots: actualQty,
        estimatedQty: actualQty,
        progressRate: rate(actualQty, plannedQty),
        status: segmentStatus(actualQty, plannedQty),
      },
      mesQty: Number(row.mes_qty ?? 0),
      manualOpenQty: Number(row.manual_open_qty ?? 0),
      matchedManualQty: Number(row.matched_manual_qty ?? 0),
      defectQty: Number(row.defect_qty ?? 0),
      status: row.status,
      provisionRow: row,
    };
  });
}

function legacyItems(
  planSummary: ProductionPlanSummaryResponse | undefined,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  businessDate: string,
): ProgressItem[] {
  const records = (planSummary?.machining?.records ?? []).map((record, index) => ({
    record: record as DatedPlanRecord,
    index,
  })).sort((left, right) => {
    const machineComparison = String(left.record.machine_name ?? "").localeCompare(String(right.record.machine_name ?? ""));
    return machineComparison || Number(left.record.sequence ?? left.index) - Number(right.record.sequence ?? right.index);
  });
  const mesByPart = new Map<string, ProductionMesReportStatsResponse["rows"]>();
  const remainingQtyByPart = new Map<string, number>();
  const blankPartMesRows: Array<{ row: ProductionMesReportStatsResponse["rows"][number]; key: string }> = [];
  for (const [index, row] of (machiningStats?.rows ?? []).entries()) {
    const partNo = comparablePartNo(row.part_no);
    if (Number(row.mes_qty) <= 0) continue;
    if (!partNo) {
      // A model label alone is insufficient to match a MES report to a production plan.
      blankPartMesRows.push({ row, key: `mes-only-blank-${index}` });
      continue;
    }
    mesByPart.set(partNo, [...(mesByPart.get(partNo) ?? []), row]);
    remainingQtyByPart.set(partNo, (remainingQtyByPart.get(partNo) ?? 0) + Number(row.mes_qty));
  }
  const items: ProgressItem[] = records.map(({ record, index }) => {
    const date = record.plan_date || record.date || planSummary?.plan_date || businessDate;
    const plannedQty = Number(record.planned_quantity ?? 0);
    const partNo = comparablePartNo(record.part_no);
    let actualQty = 0;
    if (date === businessDate && partNo) {
      // Match the backend: keep all reported output, including an overrun, on the first matching plan.
      actualQty = remainingQtyByPart.get(partNo) ?? 0;
      remainingQtyByPart.set(partNo, 0);
    }
    return {
      date,
      equipmentKey: record.machine_name || "unknown",
      label: record.machine_name || "-",
      segment: {
        key: `${record.id ?? index}-${record.part_no ?? record.model_name ?? "part"}-${index}`,
        planId: record.id,
        sequence: Number(record.sequence ?? index + 1),
        partNo: displayValue(record.part_no) || "-",
        modelName: displayValue(record.model_name) || displayValue(record.part_spec) || "-",
        lotNo: record.lot_no || "-",
        productFamilyCode: record.product_family_code || null,
        productFamilyName: record.product_family_name || null,
        isFinishedProduct: Boolean(record.is_finished_product),
        plannedQty,
        cavity: Math.max(1, Number(record.cavity ?? 1) || 1),
        requiredShots: plannedQty,
        allocatedShots: actualQty,
        estimatedQty: actualQty,
        progressRate: rate(actualQty, plannedQty),
        status: segmentStatus(actualQty, plannedQty),
      },
      mesQty: actualQty,
      manualOpenQty: 0,
      matchedManualQty: 0,
      defectQty: 0,
      status: "legacy",
    };
  });
  const mesOnlyRows = [
    ...[...mesByPart.entries()].map(([partNo, mesRows]) => ({
      row: mesRows[0], key: `mes-only-${partNo}`, actualQty: remainingQtyByPart.get(partNo) ?? 0,
    })),
    ...blankPartMesRows.map(({ row, key }) => ({ row, key, actualQty: Number(row.mes_qty) })),
  ];
  for (const { row: firstRow, key, actualQty } of mesOnlyRows) {
    if (actualQty <= 0) continue;
    items.push({
      date: null,
      equipmentKey: key,
      label: firstRow.equipment_label || firstRow.equipment_name || firstRow.equipment_key || "-",
      segment: {
        key,
        sequence: 1,
        partNo: displayValue(firstRow.part_no) || "-",
        modelName: displayValue(firstRow.model_name) || "-",
        lotNo: "-",
        productFamilyCode: null,
        productFamilyName: null,
        isFinishedProduct: false,
        plannedQty: 0,
        cavity: 1,
        requiredShots: 0,
        allocatedShots: actualQty,
        estimatedQty: actualQty,
        progressRate: 100,
        status: "completed",
      },
      mesQty: actualQty,
      manualOpenQty: 0,
      matchedManualQty: 0,
      defectQty: 0,
      status: "legacy",
    });
  }
  return items;
}

export function buildMachiningProgressPreview(
  planSummary: ProductionPlanSummaryResponse | undefined,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  machiningProvision: MachiningProvisionResponse | undefined,
  businessDate: string,
): MachiningProgressPreview {
  const items = machiningProvision
    ? provisionItems(machiningProvision)
    : legacyItems(planSummary, machiningStats, businessDate);
  const daily = buildDateProgress(businessDate, items.filter((item) => item.date === businessDate || item.date === null));
  const futureDates = [...new Set(items.map((item) => item.date).filter((date): date is string => Boolean(date && date > businessDate)))]
    .sort().map((date) => buildDateProgress(date, items.filter((item) => item.date === date)));
  const actualQty = Number(machiningProvision?.summary.effective_actual_qty ?? machiningStats?.summary.total_mes ?? daily.actualQty);
  return {
    plannedQty: daily.plannedQty,
    actualQty,
    dailyActualQty: daily.actualQty,
    advanceQty: futureDates.reduce((sum, future) => sum + future.actualQty, 0),
    partCount: daily.partCount,
    progressRate: daily.plannedQty > 0 ? (actualQty / daily.plannedQty) * 100 : 0,
    completedCount: daily.completedCount,
    inProgressCount: daily.inProgressCount,
    pendingCount: daily.pendingCount,
    rows: daily.rows,
    futureDates,
  };
}
