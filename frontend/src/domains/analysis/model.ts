import type { InjectionEquipmentRow, OverviewBoardModel, ProductionProcess } from "@/domains/boards/overview/types";

export type FieldMachineRecord = {
  machine_number: number;
  station_id: string;
  status: "reported" | "no_records" | "invalid";
  checkpoint_count: number;
  zero_defect_checkpoint_count: number;
  reported_defect_qty: number | null;
  estimated_gross_qty: number | null;
  derived_good_qty: number | null;
  latest_reported_at: string | null;
};

export type FieldOperationsData = {
  schema_version: "field-operations.v1";
  business_date: string;
  status: "ok" | "partial" | "no_records";
  summary: {
    checkpoint_count: number;
    recorded_machine_count: number;
    zero_defect_checkpoint_count: number;
    reported_defect_qty: number | null;
    estimated_gross_qty: number | null;
    derived_good_qty: number | null;
    latest_reported_at: string | null;
  };
  machines: FieldMachineRecord[];
  defects: Array<{ code: string; reported_defect_qty: number; checkpoint_count: number }>;
  coverage: {
    total_machine_count: number;
    recorded_machine_count: number;
    unrecorded_machine_count: number;
    invalid_document_count: number;
    invalid_checkpoint_count: number;
    duplicate_checkpoint_count: number;
    excluded_by_reason?: Record<string, number>;
  };
  freshness: {
    generated_at: string | null;
    latest_reported_at: string | null;
    snapshot_updated_at: string | null;
    refresh_policy: string;
  };
  used_data: unknown[];
  calculation_basis: unknown[];
  warnings: string[];
};

export function resolveAnalysisDate(requested: string | null, currentDate: string) {
  if (!requested || !/^\d{4}-\d{2}-\d{2}$/.test(requested) || requested > currentDate) return currentDate;
  const parsed = new Date(`${requested}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === requested ? requested : currentDate;
}

export function hasOverviewEvidence(model: OverviewBoardModel) {
  return [model.processes.injection, model.processes.assembly].some((process) => (
    process.plannedQuantity !== null || process.actualQuantity !== null
  )) || (model.freshness.sources?.length ?? 0) > 0;
}

export function getProcessEvidence(model: OverviewBoardModel, key: ProductionProcess["key"]) {
  const process = model.processes[key];
  const sourceKey = key === "injection" ? "injection_production" : "assembly_production";
  const source = model.freshness.sources?.find((item) => item.key === sourceKey);
  const missingMes = model.warnings.includes(`${key}_mes_data_missing`);
  const unavailable = missingMes || model.warnings.includes("production_context_unavailable")
    || !source || ["missing", "error", "unavailable", "unknown"].includes(source.status);
  const capacityCoverageIncomplete = key === "injection" && process.capacityCoverageComplete === false;
  const canEvaluate = !unavailable && !capacityCoverageIncomplete && source?.status === "ok" && !source.stale
    && !model.warnings.includes(`${key}_mes_data_stale`);
  const hasPlan = process.plannedQuantity !== null && process.plannedQuantity > 0;
  const actual = unavailable ? null : process.actualQuantity;
  return {
    process,
    source,
    unavailable,
    missingMes,
    capacityCoverageIncomplete,
    canEvaluate,
    hasPlan,
    actual,
    completionRate: canEvaluate && hasPlan && actual !== null ? process.completionRate : null,
    remainingQuantity: canEvaluate && hasPlan && actual !== null ? process.remainingQuantity : null,
    gap: canEvaluate && hasPlan && actual !== null && process.plannedQuantity !== null ? actual - process.plannedQuantity : null,
  };
}

export type EquipmentReason = "source" | "unplanned" | "unresolved" | "stopped" | "behind";

export function getEquipmentReason(row: InjectionEquipmentRow): EquipmentReason | null {
  if (row.capacityDataAvailable === false || row.dataWarning) return "source";
  if (!row.sourceStatus || ["missing", "stale", "error", "unavailable", "unknown"].includes(row.sourceStatus)) return "source";
  if (row.productionState === "running_without_plan") return "unplanned";
  if (row.productionState === "running_part_unresolved") return "unresolved";
  if (row.productionState === "planned_stopped") return "stopped";
  if (row.hasPlan && row.gapToTimeRate !== null && row.gapToTimeRate < -5) return "behind";
  return null;
}

export function getPriorityEquipment(model: OverviewBoardModel) {
  const priority: Record<EquipmentReason, number> = { source: 0, unplanned: 1, unresolved: 2, stopped: 3, behind: 4 };
  const sourceReady = getProcessEvidence(model, "injection").canEvaluate;
  return model.equipment.injectionRows.flatMap((row) => {
    const reason = sourceReady ? getEquipmentReason(row) : "source";
    return reason ? [{ row, reason }] : [];
  }).sort((a, b) => priority[a.reason] - priority[b.reason] || (a.row.gapToTimeRate ?? 0) - (b.row.gapToTimeRate ?? 0));
}

export function getFieldStationPath(machineNumber: number | null) {
  return machineNumber !== null && Number.isInteger(machineNumber) && machineNumber >= 1 && machineNumber <= 17
    ? `/field/imm${String(machineNumber).padStart(2, "0")}`
    : "/field";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseFieldOperations(value: unknown, businessDate: string): FieldOperationsData {
  if (!isRecord(value) || value.schema_version !== "field-operations.v1" || value.business_date !== businessDate
    || !["ok", "partial", "no_records"].includes(String(value.status))
    || !isRecord(value.summary) || !isRecord(value.coverage) || !isRecord(value.freshness)
    || !Array.isArray(value.machines) || !Array.isArray(value.defects)
    || !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")
    || !Array.isArray(value.used_data) || !Array.isArray(value.calculation_basis)) {
    throw new Error("Field operation data is incomplete or belongs to another business day.");
  }
  const counts = [value.summary.checkpoint_count, value.summary.recorded_machine_count,
    value.summary.zero_defect_checkpoint_count, value.coverage.total_machine_count,
    value.coverage.recorded_machine_count, value.coverage.unrecorded_machine_count,
    value.coverage.invalid_document_count, value.coverage.invalid_checkpoint_count, value.coverage.duplicate_checkpoint_count];
  if (counts.some((count) => typeof count !== "number" || !Number.isInteger(count) || count < 0)) {
    throw new Error("Field operation counts are unavailable.");
  }
  const validQuantity = (quantity: unknown) => quantity === null || (typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0);
  const validCount = (count: unknown) => typeof count === "number" && Number.isInteger(count) && count >= 0;
  const validTime = (time: unknown) => time === null || (typeof time === "string" && Number.isFinite(new Date(time).getTime()));
  if (![value.summary.reported_defect_qty, value.summary.estimated_gross_qty, value.summary.derived_good_qty].every(validQuantity)
    || value.machines.some((row) => !isRecord(row) || typeof row.machine_number !== "number" || !Number.isInteger(row.machine_number)
      || row.machine_number < 1 || row.machine_number > 17 || row.station_id !== `imm${String(row.machine_number).padStart(2, "0")}`
      || !["reported", "no_records", "invalid"].includes(String(row.status))
      || !validCount(row.checkpoint_count) || !validCount(row.zero_defect_checkpoint_count)
      || !validTime(row.latest_reported_at)
      || ![row.reported_defect_qty, row.estimated_gross_qty, row.derived_good_qty].every(validQuantity)
      || (row.checkpoint_count === 0 && [row.reported_defect_qty, row.estimated_gross_qty, row.derived_good_qty].some((quantity) => quantity !== null))
      || (typeof row.checkpoint_count === "number" && row.checkpoint_count > 0 && row.status !== "reported"))
    || value.defects.some((row) => !isRecord(row) || typeof row.code !== "string" || !row.code
      || row.reported_defect_qty === null || !validQuantity(row.reported_defect_qty) || !validCount(row.checkpoint_count))) {
    throw new Error("Field operation quantities are invalid.");
  }
  if (new Set(value.machines.map((row) => (row as Record<string, unknown>).machine_number)).size !== value.machines.length
    || !validTime(value.summary.latest_reported_at)
    || ![value.freshness.generated_at, value.freshness.latest_reported_at, value.freshness.snapshot_updated_at].every(validTime)
    || value.freshness.refresh_policy !== "event_driven"
    || (value.status === "no_records" && value.summary.checkpoint_count !== 0)) {
    throw new Error("Field operation scope or timestamps are invalid.");
  }
  if (value.summary.checkpoint_count === 0 && [value.summary.reported_defect_qty, value.summary.estimated_gross_qty, value.summary.derived_good_qty].some((quantity) => quantity !== null)) {
    throw new Error("Missing field reports cannot be counted as zero production or defects.");
  }
  return value as unknown as FieldOperationsData;
}
