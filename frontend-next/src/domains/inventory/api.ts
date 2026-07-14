import { http } from "@/shared/api/http";

export type RawMaterialOverviewParams = {
  warehouseCodes?: string[];
  lookbackDays: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
};

export type RawMaterialWarehouseOption = {
  code: string;
  name: string;
};

export type RawMaterialUnitSummary = {
  unit: string;
  current: number;
  previousCurrent: number | null;
  comparisonCurrent: number | null;
  change24h: number | null;
  usable: number;
  restricted: number;
  unclassified: number;
  inbound: number;
  outbound: number;
  consumption: number;
  transferOut: number;
  adjustment: number;
  recommendedOrder: number;
  recommendationUnavailableCount: number;
};

export type RawMaterialTrendValue = {
  unit: string;
  inbound: number;
  outbound: number;
  consumption: number;
  transferOut: number;
  adjustment: number;
  netChange: number;
  estimatedClosingStock: number;
};

export type RawMaterialTrendPoint = {
  date: string;
  values: RawMaterialTrendValue[];
};

export type RawMaterialRisk = "critical" | "warning" | "healthy" | "no_usage" | "unknown";

export type RawMaterialRow = {
  materialId: string;
  materialCode: string;
  materialName: string;
  specification: string;
  warehouseCode: string;
  warehouseName: string;
  unit: string;
  currentQuantity: number;
  previousQuantity: number | null;
  comparisonCurrentQuantity: number | null;
  quantityChange24h: number | null;
  usableQuantity: number;
  previousUsableQuantity: number | null;
  usableChange24h: number | null;
  restrictedQuantity: number;
  unclassifiedQuantity: number;
  inboundQuantity: number;
  outboundQuantity: number;
  consumptionQuantity: number;
  transferOutQuantity: number;
  averageDailyConsumption: number;
  safetyStock: number;
  reorderPoint: number;
  targetStock: number;
  recommendedOrder: number;
  daysOfCover: number | null;
  risk: RawMaterialRisk;
  recommendationAvailable: boolean;
  recommendationStatus: string;
};

export type RawMaterialTransaction = {
  id: string;
  occurredAt: string;
  transactionType: string;
  actionLabel: string;
  direction: string;
  materialCode: string;
  materialName: string;
  warehouseCode: string;
  warehouseName: string;
  quantity: number;
  unit: string;
  batchNo: string;
  documentNo: string;
  operatorName: string;
  note: string;
  isTransferOut: boolean;
};

export type RawMaterialOverviewMeta = {
  generatedAt: string;
  sourceLatestAt: string;
  inventorySourceLatestAt: string;
  changeLogSourceLatestAt: string;
  lookbackDays: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
  partial: boolean;
  warnings: string[];
  recommendationsAvailable: boolean;
  dataMode: string;
  inventoryCaptureType: string;
  snapshotSyncedAt: string;
  syncRequired: boolean;
  comparisonAvailable: boolean;
  comparisonStartAt: string;
  comparisonEndAt: string;
  comparisonHours: number;
};

export type RawMaterialSyncStatus = {
  status: string;
  trigger: string;
  message: string;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
};

export type RawMaterialOverview = {
  status: string;
  meta: RawMaterialOverviewMeta;
  warehouseOptions: RawMaterialWarehouseOption[];
  selectedWarehouses: string[];
  units: string[];
  summary: {
    quantities: RawMaterialUnitSummary[];
  };
  trend: RawMaterialTrendPoint[];
  materials: RawMaterialRow[];
  recentTransactions: RawMaterialTransaction[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asJoinedString(value: unknown, fallback = ""): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => asString(item)).filter(Boolean);
    return items.length ? items.join(", ") : fallback;
  }
  return asString(value, fallback);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replaceAll(",", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "1", "yes", "partial"].includes(value.toLowerCase());
  return false;
}

function asBooleanWithDefault(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return asBoolean(value);
}

function normalizeRisk(value: unknown): RawMaterialRisk {
  const risk = asString(value).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["critical", "danger", "stockout", "shortage", "high", "urgent"].includes(risk)) return "critical";
  if (["warning", "warn", "watch", "low", "medium", "attention"].includes(risk)) return "warning";
  if (["healthy", "normal", "safe", "ok", "low_risk"].includes(risk)) return "healthy";
  if (["no_usage", "no_consumption", "slow_moving", "inactive", "excess"].includes(risk)) return "no_usage";
  return "unknown";
}

function normalizeWarehouseOption(value: unknown): RawMaterialWarehouseOption | null {
  if (typeof value === "string" || typeof value === "number") {
    const code = asString(value);
    return code ? { code, name: code } : null;
  }
  const row = asRecord(value);
  const code = asString(pick(row, "code", "warehouse_code", "warehouseCode", "id", "warehouse_id"));
  if (!code) return null;
  return {
    code,
    name: asString(pick(row, "name", "warehouse_name", "warehouseName", "label"), code),
  };
}

function normalizeSummary(value: unknown): RawMaterialUnitSummary {
  const row = asRecord(value);
  const current = asNumber(pick(row, "current", "current_quantity", "currentQuantity", "stock"));
  const previousCurrent = asNullableNumber(pick(row, "previous_current", "previousCurrent"));
  const comparisonCurrent = asNullableNumber(pick(row, "comparison_current", "comparisonCurrent"));
  return {
    unit: asString(pick(row, "unit", "unit_name", "unitName"), "-"),
    current,
    previousCurrent,
    comparisonCurrent: comparisonCurrent ?? (previousCurrent !== null ? current : null),
    change24h: asNullableNumber(pick(row, "change_24h", "change24h")),
    usable: asNumber(pick(row, "usable", "usable_quantity", "usableQuantity", "available"), current),
    restricted: asNumber(pick(row, "restricted", "restricted_quantity", "restrictedQuantity")),
    unclassified: asNumber(pick(row, "unclassified", "unclassified_quantity", "unclassifiedQuantity")),
    inbound: asNumber(pick(row, "inbound", "inbound_quantity", "inboundQuantity")),
    outbound: asNumber(pick(row, "outbound", "outbound_quantity", "outboundQuantity")),
    consumption: asNumber(pick(row, "consumption", "consumption_quantity", "consumptionQuantity", "used")),
    transferOut: asNumber(pick(row, "transfer_out", "transferOut", "transfer_out_quantity", "transferOutQuantity")),
    adjustment: asNumber(pick(row, "adjustment", "adjustment_quantity", "adjustmentQuantity")),
    recommendedOrder: asNumber(pick(row, "recommended_order", "recommendedOrder", "recommended_order_quantity")),
    recommendationUnavailableCount: asNumber(
      pick(row, "recommendation_unavailable_count", "recommendationUnavailableCount"),
    ),
  };
}

function normalizeTrendValue(value: unknown): RawMaterialTrendValue {
  const row = asRecord(value);
  return {
    unit: asString(pick(row, "unit", "unit_name", "unitName"), "-"),
    inbound: asNumber(pick(row, "inbound", "inbound_quantity", "inboundQuantity")),
    outbound: asNumber(pick(row, "outbound", "outbound_quantity", "outboundQuantity")),
    consumption: asNumber(pick(row, "consumption", "consumption_quantity", "consumptionQuantity", "used")),
    transferOut: asNumber(pick(row, "transfer_out", "transferOut", "transfer_out_quantity", "transferOutQuantity")),
    adjustment: asNumber(pick(row, "adjustment", "adjustment_quantity", "adjustmentQuantity")),
    netChange: asNumber(pick(row, "net_change", "netChange", "change")),
    estimatedClosingStock: asNumber(pick(row, "estimated_closing_stock", "estimatedClosingStock", "closing_stock")),
  };
}

function normalizeMaterial(value: unknown, index: number): RawMaterialRow {
  const row = asRecord(value);
  const currentQuantity = asNumber(pick(row, "current_quantity", "currentQuantity", "current", "quantity"));
  const previousQuantity = asNullableNumber(pick(row, "previous_quantity", "previousQuantity"));
  const comparisonCurrentQuantity = asNullableNumber(
    pick(row, "comparison_current_quantity", "comparisonCurrentQuantity"),
  );
  const usableQuantity = asNumber(pick(row, "usable_quantity", "usableQuantity", "available_quantity", "availableQuantity"), currentQuantity);
  const averageDailyConsumption = asNumber(pick(row, "avg_daily_consumption", "average_daily_consumption", "averageDailyConsumption"));
  const rawCover = pick(row, "days_of_cover", "daysOfCover", "coverage_days");
  const parsedCover = rawCover === null || rawCover === undefined || rawCover === "" ? null : asNumber(rawCover, Number.NaN);
  const materialCode = asString(pick(row, "material_code", "materialCode", "code"), `material-${index + 1}`);
  return {
    materialId: asString(pick(row, "material_id", "materialId", "id"), materialCode),
    materialCode,
    materialName: asString(pick(row, "material_name", "materialName", "name"), materialCode),
    specification: asString(pick(row, "specification", "spec", "material_spec")),
    warehouseCode: asJoinedString(pick(row, "warehouse_code", "warehouseCode", "warehouse_codes", "warehouseCodes")),
    warehouseName: asJoinedString(pick(row, "warehouse_name", "warehouseName", "warehouse", "warehouse_names", "warehouseNames")),
    unit: asString(pick(row, "unit", "unit_name", "unitName"), "-"),
    currentQuantity,
    previousQuantity,
    comparisonCurrentQuantity: comparisonCurrentQuantity
      ?? (previousQuantity !== null ? currentQuantity : null),
    quantityChange24h: asNullableNumber(pick(row, "quantity_change_24h", "quantityChange24h")),
    usableQuantity,
    previousUsableQuantity: asNullableNumber(pick(row, "previous_usable_quantity", "previousUsableQuantity")),
    usableChange24h: asNullableNumber(pick(row, "usable_change_24h", "usableChange24h")),
    restrictedQuantity: asNumber(pick(row, "restricted_quantity", "restrictedQuantity")),
    unclassifiedQuantity: asNumber(pick(row, "unclassified_quantity", "unclassifiedQuantity")),
    inboundQuantity: asNumber(pick(row, "inbound_quantity", "inboundQuantity", "inbound")),
    outboundQuantity: asNumber(pick(row, "outbound_quantity", "outboundQuantity", "outbound")),
    consumptionQuantity: asNumber(pick(row, "consumption_quantity", "consumptionQuantity", "consumption", "used")),
    transferOutQuantity: asNumber(pick(row, "transfer_out_quantity", "transferOutQuantity", "transfer_out", "transferOut")),
    averageDailyConsumption,
    safetyStock: asNumber(pick(row, "safety_stock", "safetyStock")),
    reorderPoint: asNumber(pick(row, "reorder_point", "reorderPoint")),
    targetStock: asNumber(pick(row, "target_stock", "targetStock")),
    recommendedOrder: asNumber(pick(row, "recommended_order", "recommendedOrder", "recommended_order_quantity")),
    daysOfCover: Number.isFinite(parsedCover) ? parsedCover : averageDailyConsumption > 0 ? usableQuantity / averageDailyConsumption : null,
    risk: normalizeRisk(pick(row, "risk", "risk_level", "riskLevel", "status")),
    recommendationAvailable: asBooleanWithDefault(
      pick(row, "recommendation_available", "recommendationAvailable"),
      true,
    ),
    recommendationStatus: asString(
      pick(row, "recommendation_status", "recommendationStatus"),
    ),
  };
}

function normalizeTransaction(value: unknown, index: number): RawMaterialTransaction {
  const row = asRecord(value);
  const materialCode = asString(pick(row, "material_code", "materialCode", "code"));
  const occurredAt = asString(pick(row, "occurred_at", "occurredAt", "operation_time", "operationTime", "created_at", "createdAt", "date"));
  return {
    id: asString(pick(row, "id", "transaction_id", "transactionId", "change_id"), `${occurredAt}-${materialCode}-${index}`),
    occurredAt,
    transactionType: asString(pick(row, "action_code", "actionCode", "transaction_type", "transactionType", "action", "type"), "unknown"),
    actionLabel: asString(pick(row, "action_label", "actionLabel")),
    direction: asString(pick(row, "direction", "change_direction", "changeDirection")),
    materialCode,
    materialName: asString(pick(row, "material_name", "materialName", "name"), materialCode || "-"),
    warehouseCode: asString(pick(row, "warehouse_code", "warehouseCode")),
    warehouseName: asString(pick(row, "warehouse_name", "warehouseName", "warehouse")),
    quantity: asNumber(pick(row, "quantity", "change_quantity", "changeQuantity", "amount")),
    unit: asString(pick(row, "unit", "unit_name", "unitName"), "-"),
    batchNo: asString(pick(row, "batch_no", "batchNo", "batch")),
    documentNo: asString(pick(row, "document_no", "documentNo", "order_no", "orderNo", "related_order_no")),
    operatorName: asString(pick(row, "operator_name", "operatorName", "operator")),
    note: asString(pick(row, "note", "remark", "reason")),
    isTransferOut: asBoolean(pick(row, "is_transfer_out", "isTransferOut")),
  };
}

function normalizeSelectedWarehouse(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return asString(value);
  const row = asRecord(value);
  return asString(pick(row, "code", "warehouse_code", "warehouseCode", "id"));
}

function normalizeRawMaterialOverview(payload: unknown): RawMaterialOverview {
  const root = asRecord(payload);
  const meta = asRecord(pick(root, "meta", "metadata"));
  const summarySource = pick(root, "summary", "totals");
  const summary = asRecord(summarySource);
  const quantitiesSource = Array.isArray(summarySource)
    ? summarySource
    : pick(summary, "quantities", "by_unit", "byUnit", "units");

  const warehouseOptions = asArray(pick(root, "warehouse_options", "warehouseOptions", "warehouses"))
    .map(normalizeWarehouseOption)
    .filter((row): row is RawMaterialWarehouseOption => row !== null);
  const selectedWarehouses = asArray(pick(root, "selected_warehouses", "selectedWarehouses", "warehouse_codes"))
    .map(normalizeSelectedWarehouse)
    .filter(Boolean);
  const quantities = asArray(quantitiesSource).map(normalizeSummary);
  const trend = asArray(pick(root, "trend", "daily_trend", "dailyTrend")).map((value) => {
    const row = asRecord(value);
    const nestedValues = asArray(pick(row, "values", "quantities", "by_unit", "byUnit"));
    const values = nestedValues.length
      ? nestedValues.map(normalizeTrendValue)
      : [normalizeTrendValue(row)];
    return {
      date: asString(pick(row, "date", "day", "business_date", "businessDate")),
      values,
    };
  });
  const materials = asArray(pick(root, "materials", "items", "rows")).map(normalizeMaterial);
  const recentTransactions = asArray(pick(root, "recent_transactions", "recentTransactions", "transactions", "change_logs"))
    .map(normalizeTransaction);
  const explicitUnits = asArray(pick(root, "units", "unit_options", "unitOptions")).map((unit) => asString(unit)).filter(Boolean);
  const inferredUnits = [...quantities.map((row) => row.unit), ...materials.map((row) => row.unit)].filter((unit) => unit && unit !== "-");

  return {
    status: asString(pick(root, "status", "state"), "ok"),
    meta: {
      generatedAt: asString(pick(meta, "generated_at", "generatedAt", "refreshed_at", "refreshedAt")),
      sourceLatestAt: asString(pick(
        meta,
        "inventory_source_latest_at",
        "inventorySourceLatestAt",
        "source_latest_at",
        "sourceLatestAt",
        "last_updated_at",
        "lastUpdatedAt",
      )),
      inventorySourceLatestAt: asString(pick(
        meta,
        "inventory_source_latest_at",
        "inventorySourceLatestAt",
        "source_latest_at",
        "sourceLatestAt",
        "last_updated_at",
        "lastUpdatedAt",
      )),
      changeLogSourceLatestAt: asString(pick(
        meta,
        "change_log_source_latest_at",
        "changeLogSourceLatestAt",
      )),
      lookbackDays: asNumber(pick(meta, "lookback_days", "lookbackDays")),
      leadTimeDays: asNumber(pick(meta, "lead_time_days", "leadTimeDays")),
      reviewPeriodDays: asNumber(pick(meta, "review_period_days", "reviewPeriodDays")),
      partial: asBoolean(pick(meta, "partial", "is_partial", "isPartial")),
      warnings: asArray(pick(meta, "warnings", "warning_messages", "warningMessages")).map((warning) => asString(warning)).filter(Boolean),
      recommendationsAvailable: asBooleanWithDefault(
        pick(meta, "recommendations_available", "recommendationsAvailable"),
        true,
      ),
      dataMode: asString(pick(meta, "data_mode", "dataMode"), "stored"),
      inventoryCaptureType: asString(
        pick(meta, "inventory_capture_type", "inventoryCaptureType"),
      ),
      snapshotSyncedAt: asString(pick(meta, "snapshot_synced_at", "snapshotSyncedAt")),
      syncRequired: asBoolean(pick(meta, "sync_required", "syncRequired")),
      comparisonAvailable: asBoolean(pick(meta, "comparison_available", "comparisonAvailable")),
      comparisonStartAt: asString(pick(meta, "comparison_start_at", "comparisonStartAt")),
      comparisonEndAt: asString(pick(meta, "comparison_end_at", "comparisonEndAt")),
      comparisonHours: asNumber(pick(meta, "comparison_hours", "comparisonHours"), 24),
    },
    warehouseOptions,
    selectedWarehouses,
    units: Array.from(new Set([...explicitUnits, ...inferredUnits])),
    summary: { quantities },
    trend,
    materials,
    recentTransactions,
  };
}

export async function getInventoryLastUpdate() {
  const response = await http.get("/inventory/last-update/");
  return response.data;
}

export async function getWarehouses() {
  const response = await http.get("/inventory/warehouses/");
  return response.data;
}

export async function getRawMaterialOverview(params: RawMaterialOverviewParams): Promise<RawMaterialOverview> {
  const response = await http.get("/inventory/raw-materials/overview/", {
    params: {
      warehouse_codes: (params.warehouseCodes ?? []).join(","),
      lookback_days: params.lookbackDays,
      lead_time_days: params.leadTimeDays,
      review_period_days: params.reviewPeriodDays,
    },
  });
  return normalizeRawMaterialOverview(response.data);
}

function asNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSyncStatus(value: unknown): RawMaterialSyncStatus {
  const row = asRecord(value);
  return {
    status: asString(pick(row, "status", "state"), "unknown"),
    trigger: asString(pick(row, "trigger")),
    message: asString(pick(row, "message", "detail")),
    startedAt: asString(pick(row, "started_at", "startedAt")),
    finishedAt: asString(pick(row, "finished_at", "finishedAt")),
    updatedAt: asString(pick(row, "updated_at", "updatedAt")),
  };
}

export async function getRawMaterialSyncStatus(): Promise<RawMaterialSyncStatus> {
  const response = await http.get("/inventory/raw-materials/sync/");
  return normalizeSyncStatus(response.data);
}

export async function startRawMaterialSync(): Promise<RawMaterialSyncStatus> {
  try {
    const response = await http.post("/inventory/raw-materials/sync/");
    return normalizeSyncStatus(response.data);
  } catch (error) {
    const response = asRecord(asRecord(error).response);
    if (asNumber(response.status) === 409) return normalizeSyncStatus(response.data);
    throw error;
  }
}
