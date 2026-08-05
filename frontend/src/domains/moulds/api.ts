import { http } from "@/shared/api/http";

const MOULD_BOARD_ENDPOINT = "/injection/moulds/board/";
const MOULD_DETAIL_ENDPOINT = "/injection/moulds";
const EXPECTED_MACHINE_COUNT = 17;

type UnknownRecord = Record<string, unknown>;

export type MouldLocationKind =
  | "machine"
  | "storage"
  | "maintenance"
  | "repair"
  | "offsite"
  | "unknown";

export type MouldWarning = {
  code: string;
  message: string;
  params: Record<string, unknown>;
};

export type MouldCapabilities = Record<string, boolean>;

export type MouldDataFreshness = {
  fetchedAt: string;
  sourceLatestAt: string;
  status: string;
};

export type MouldLocation = {
  id: string;
  code: string;
  label: string;
  kind: MouldLocationKind;
  machineNumber: number | null;
  parentCode: string;
  parentLabel: string;
  zoneCode: string;
  zoneLabel: string;
  level: number | null;
  mouldCount: number;
  conflict: boolean;
};

export type MouldRecord = {
  instanceId: string;
  mouldCode: string;
  assetCode: string;
  name: string;
  drawingNo: string;
  model: string;
  statusCode: string;
  statusLabel: string;
  classification: string;
  cavityCount: number | null;
  serialNo: string;
  supplier: string;
  currentOutputAmount: number | null;
  currentOutputBatchAmount: number | null;
  lifespanStatus: string;
  maintenanceStatus: string;
  repairStatus: string;
  summaryCategory: MouldLocationKind;
  location: MouldLocation;
  finalChangedAt: string;
  recordUpdatedAt: string;
  positionChangedAt: string;
  timeQuality: string;
  warnings: MouldWarning[];
};

export type MouldMachineSlot = {
  number: number;
  deviceCode: string;
  locationCode: string;
  label: string;
  tonnage: string;
};

export type MouldBoardSummary = {
  total: number;
  mounted: number;
  stored: number;
  maintenance: number;
  repair: number;
  offsite: number;
  unknown: number;
  conflicts: number;
};

export type MouldBoard = {
  summary: MouldBoardSummary;
  locations: MouldLocation[];
  machines: MouldMachineSlot[];
  moulds: MouldRecord[];
  finalChangedAt: string;
  dataFreshness: MouldDataFreshness;
  capabilities: MouldCapabilities;
  warnings: MouldWarning[];
  calculationBasis: string[];
};

export type MouldMovementRecord = {
  id: string;
  occurredAt: string;
  fromLocation: string;
  toLocation: string;
  reason: string;
  operatorName: string;
  timeQuality: string;
};

export type MouldProductionRecord = {
  id: string;
  period: string;
  year: number | null;
  month: number | null;
  quantity: number | null;
  cumulativeQuantity: number | null;
  unit: string;
  recordedAt: string;
};

export type MouldRepairRecord = {
  id: string;
  recordCode: string;
  requestedAt: string;
  startedAt: string;
  finishedAt: string;
  type: string;
  content: string;
  vendor: string;
  creatorName: string;
  cumulativeOutputAmount: number | null;
  attachmentIds: string[];
};

export type MouldAttachment = {
  id: string;
  name: string;
  url: string;
  contentType: string;
};

export type MouldDetail = MouldRecord & {
  acquiredAt: string;
  enabledAt: string;
  coverFileId: string;
  attachments: MouldAttachment[];
  movements: MouldMovementRecord[];
  productionHistory: MouldProductionRecord[];
  repairHistory: MouldRepairRecord[];
  capabilities: MouldCapabilities;
  dataFreshness: MouldDataFreshness;
  calculationBasis: string[];
};

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
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replaceAll(",", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return fallback;
}

function asEpochAwareDateString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) return asEpochAwareDateString(Number(trimmed));
    return trimmed;
  }
  return "";
}

function enumCode(value: unknown): string {
  if (!isRecord(value)) return asString(value);
  return asString(pick(value, "code", "value", "id"));
}

function enumLabel(value: unknown): string {
  if (!isRecord(value)) return asString(value);
  return asString(pick(value, "label", "message", "name", "display_name", "displayName"), enumCode(value));
}

function unwrapData(value: unknown): UnknownRecord {
  let current = asRecord(value);
  for (let index = 0; index < 2; index += 1) {
    const nested = current.data;
    if (!isRecord(nested)) break;
    current = nested;
  }
  return current;
}

function normalizeLocationKind(value: unknown): MouldLocationKind {
  const normalized = asString(value).toLowerCase().replaceAll("-", "_");
  if (["machine", "mounted", "equipment", "injection_machine"].includes(normalized)) return "machine";
  if (["storage", "stored", "warehouse", "cell"].includes(normalized)) return "storage";
  if (["maintenance", "maintaining"].includes(normalized)) return "maintenance";
  if (["repair", "repairing"].includes(normalized)) return "repair";
  if (["offsite", "off_site", "outside", "external"].includes(normalized)) return "offsite";
  return "unknown";
}

function normalizeWarning(value: unknown, index: number): MouldWarning {
  if (!isRecord(value)) {
    const message = asString(value);
    return { code: message ? `message_${index + 1}` : `warning_${index + 1}`, message, params: {} };
  }
  return {
    code: asString(pick(value, "code", "warning_code", "warningCode"), `warning_${index + 1}`),
    message: asString(pick(value, "message", "label", "text", "detail")),
    params: asRecord(pick(value, "params", "context", "details")),
  };
}

function normalizeWarnings(value: unknown): MouldWarning[] {
  return asArray(value)
    .map(normalizeWarning)
    .filter((warning) => Boolean(warning.message || warning.code));
}

function mergeWarnings(...groups: MouldWarning[][]): MouldWarning[] {
  const merged = new Map<string, MouldWarning>();
  groups.flat().forEach((warning) => {
    const key = `${warning.code}|${warning.message}`;
    if (!merged.has(key)) merged.set(key, warning);
  });
  return [...merged.values()];
}

function normalizeCapabilities(value: unknown): MouldCapabilities {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, raw]) => {
    if (isRecord(raw)) return [key, asBoolean(pick(raw, "available", "enabled", "supported"))];
    return [key, asBoolean(raw)];
  }));
}

function normalizeCalculationBasis(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean);
  const single = asString(value);
  return single ? [single] : [];
}

function normalizeDataFreshness(value: unknown, fallbackRecord: UnknownRecord = {}): MouldDataFreshness {
  const freshness = asRecord(value);
  return {
    fetchedAt: asEpochAwareDateString(pick(freshness, "fetched_at", "fetchedAt", "generated_at", "generatedAt"))
      || asEpochAwareDateString(pick(fallbackRecord, "fetched_at", "fetchedAt", "generated_at", "generatedAt")),
    sourceLatestAt: asEpochAwareDateString(pick(freshness, "source_latest_at", "sourceLatestAt", "latest_at", "latestAt"))
      || asEpochAwareDateString(pick(fallbackRecord, "source_latest_at", "sourceLatestAt", "latest_at", "latestAt")),
    status: asString(pick(freshness, "status", "state", "quality")),
  };
}

function validMachineNumber(value: unknown): number | null {
  const number = asNumber(value, Number.NaN);
  if (!Number.isInteger(number) || number < 1 || number > EXPECTED_MACHINE_COUNT) return null;
  return number;
}

function deriveZoneCode(locationCode: string): string {
  const match = locationCode.trim().match(/^([A-Za-z]+)(?=\d|[-_\s])/);
  return match?.[1]?.toUpperCase() ?? "";
}

function normalizeLocation(value: unknown): MouldLocation {
  const source = asRecord(value);
  const parent = asRecord(pick(source, "parent", "parent_location", "parentLocation"));
  const zone = asRecord(pick(source, "zone", "area"));
  const machineNumber = validMachineNumber(pick(source, "machine_number", "machineNumber"));
  const explicitKind = normalizeLocationKind(pick(source, "kind", "location_kind", "locationKind", "type"));
  const code = asString(pick(source, "code", "location_code", "locationCode", "identifier"));
  const parentCode = asString(pick(source, "parent_code", "parentCode"), asString(pick(parent, "code", "identifier")));
  const parentLabel = asString(pick(source, "parent_label", "parentLabel", "parent_name", "parentName"), asString(pick(parent, "label", "name")));
  const zoneCode = asString(
    pick(source, "zone_code", "zoneCode"),
    asString(pick(zone, "code", "identifier"), parentCode || deriveZoneCode(code)),
  );
  return {
    id: asString(pick(source, "id", "location_id", "locationId")),
    code,
    label: asString(pick(source, "label", "name", "location_label", "locationLabel"), code),
    kind: machineNumber !== null ? "machine" : explicitKind,
    machineNumber,
    parentCode,
    parentLabel,
    zoneCode,
    zoneLabel: asString(
      pick(source, "zone_label", "zoneLabel", "zone_name", "zoneName"),
      asString(pick(zone, "label", "name"), parentLabel || zoneCode),
    ),
    level: asNullableNumber(pick(source, "level", "location_level", "locationLevel")),
    mouldCount: Math.max(0, asNumber(pick(source, "mould_count", "mouldCount", "mold_count", "moldCount"))),
    conflict: asBoolean(pick(source, "conflict", "has_conflict", "hasConflict")),
  };
}

function emptyLocation(): MouldLocation {
  return normalizeLocation({});
}

function normalizeMouldRecord(value: unknown): MouldRecord {
  const source = asRecord(value);
  const status = pick(source, "status", "mould_status", "mouldStatus", "mold_status", "moldStatus");
  const locations = asArray(pick(source, "locations", "location_path", "locationPath"))
    .map(normalizeLocation)
    .sort((left, right) => (right.level ?? -1) - (left.level ?? -1));
  const locationValue = pick(source, "location", "current_location", "currentLocation");
  const location = isRecord(locationValue) ? normalizeLocation(locationValue) : locations[0] ?? emptyLocation();
  const rawSummaryCategory = pick(source, "summary_category", "summaryCategory");
  const summaryCategory = rawSummaryCategory === undefined || rawSummaryCategory === null || rawSummaryCategory === ""
    ? location.kind
    : normalizeLocationKind(rawSummaryCategory);
  const recordUpdatedAt = asEpochAwareDateString(pick(source, "record_updated_at", "recordUpdatedAt", "updated_at", "updatedAt"));
  const positionChangedAt = asEpochAwareDateString(pick(source, "position_changed_at", "positionChangedAt"));
  const finalChangedAt = asEpochAwareDateString(pick(source, "final_changed_at", "finalChangedAt"))
    || positionChangedAt
    || recordUpdatedAt;
  return {
    instanceId: asString(pick(source, "instance_id", "instanceId", "id")),
    mouldCode: asString(pick(source, "mould_code", "mouldCode", "mold_code", "moldCode", "code")),
    assetCode: asString(pick(source, "asset_code", "assetCode", "entity_link_code", "entityLinkCode")),
    name: asString(pick(source, "name", "mould_name", "mouldName", "mold_name", "moldName")),
    drawingNo: asString(pick(source, "drawing_no", "drawingNo", "drawing_number", "drawingNumber")),
    model: asString(pick(source, "model", "model_name", "modelName")),
    statusCode: enumCode(status),
    statusLabel: enumLabel(status),
    classification: enumLabel(pick(source, "classification", "classification_name", "classificationName")),
    cavityCount: asNullableNumber(pick(source, "cavity_count", "cavityCount", "cavity_no", "cavityNo")),
    serialNo: asString(pick(source, "serial_no", "serialNo")),
    supplier: enumLabel(pick(source, "supplier", "manufacturer")),
    currentOutputAmount: asNullableNumber(pick(source, "current_output_amount", "currentOutputAmount")),
    currentOutputBatchAmount: asNullableNumber(pick(source, "current_output_batch_amount", "currentOutputBatchAmount")),
    lifespanStatus: enumLabel(pick(source, "lifespan_status", "lifespanStatus")),
    maintenanceStatus: enumLabel(pick(source, "maintenance_status", "maintenanceStatus")),
    repairStatus: enumLabel(pick(source, "repair_status", "repairStatus")),
    summaryCategory,
    location,
    finalChangedAt,
    recordUpdatedAt,
    positionChangedAt,
    timeQuality: asString(
      pick(source, "time_quality", "timeQuality"),
      positionChangedAt ? "position_change" : recordUpdatedAt ? "record_update" : "unknown",
    ),
    warnings: normalizeWarnings(pick(source, "warnings", "warning_details", "warningDetails")),
  };
}

function normalizeMachineSlot(value: unknown): MouldMachineSlot {
  const source = asRecord(value);
  const number = validMachineNumber(pick(source, "number", "machine_number", "machineNumber")) ?? 0;
  return {
    number,
    deviceCode: asString(pick(source, "device_code", "deviceCode", "code")),
    locationCode: asString(pick(source, "location_code", "locationCode")),
    label: asString(pick(source, "label", "display_name", "displayName", "machine_name", "machineName"), number ? `${number}호기` : ""),
    tonnage: asString(pick(source, "tonnage", "capacity_label", "capacityLabel")),
  };
}

function normalizeMachineSlots(value: unknown): MouldMachineSlot[] {
  const provided = new Map<number, MouldMachineSlot>();
  asArray(value).map(normalizeMachineSlot).forEach((machine) => {
    if (machine.number) provided.set(machine.number, machine);
  });
  return Array.from({ length: EXPECTED_MACHINE_COUNT }, (_, index) => {
    const number = index + 1;
    return provided.get(number) ?? {
      number,
      deviceCode: "",
      locationCode: "",
      label: `${number}호기`,
      tonnage: "",
    };
  });
}

function countKind(moulds: MouldRecord[], kind: MouldLocationKind): number {
  return moulds.filter((mould) => mould.location.kind === kind).length;
}

function normalizeSummary(value: unknown, moulds: MouldRecord[], locations: MouldLocation[]): MouldBoardSummary {
  const source = asRecord(value);
  const total = asNumber(pick(source, "total", "total_count", "totalCount"), moulds.length);
  const mounted = asNumber(pick(source, "mounted", "mounted_count", "mountedCount"), countKind(moulds, "machine"));
  const stored = asNumber(pick(source, "stored", "stored_count", "storedCount", "storage"), countKind(moulds, "storage"));
  const maintenance = asNumber(
    pick(source, "maintenance", "maintenance_count", "maintenanceCount"),
    countKind(moulds, "maintenance"),
  );
  const repair = asNumber(pick(source, "repair", "repair_count", "repairCount"), countKind(moulds, "repair"));
  const offsite = asNumber(pick(source, "offsite", "offsite_count", "offsiteCount", "off_site", "offSite"), countKind(moulds, "offsite"));
  const known = mounted + stored + maintenance + repair + offsite;
  return {
    total,
    mounted,
    stored,
    maintenance,
    repair,
    offsite,
    unknown: asNumber(pick(source, "unknown", "unknown_count", "unknownCount"), Math.max(0, total - known)),
    conflicts: asNumber(
      pick(source, "conflicts", "conflict_count", "conflictCount"),
      locations.filter((location) => location.conflict).length,
    ),
  };
}

export function normalizeMouldBoard(value: unknown): MouldBoard {
  const source = unwrapData(value);
  const board = asRecord(pick(source, "board", "layout"));
  const locations = asArray(pick(source, "locations") ?? pick(board, "locations", "cells")).map(normalizeLocation);
  const moulds = asArray(pick(source, "moulds", "molds", "items", "list")).map(normalizeMouldRecord);
  return {
    summary: normalizeSummary(pick(source, "summary", "counts"), moulds, locations),
    locations,
    machines: normalizeMachineSlots(pick(source, "machines", "machine_slots", "machineSlots") ?? pick(board, "machines", "machine_slots", "machineSlots")),
    moulds,
    finalChangedAt: asEpochAwareDateString(pick(source, "final_changed_at", "finalChangedAt")),
    dataFreshness: normalizeDataFreshness(pick(source, "data_freshness", "dataFreshness"), source),
    capabilities: normalizeCapabilities(pick(source, "capabilities")),
    warnings: normalizeWarnings(pick(source, "warnings", "warning_details", "warningDetails")),
    calculationBasis: normalizeCalculationBasis(pick(source, "calculation_basis", "calculationBasis")),
  };
}

function normalizeAttachment(value: unknown): MouldAttachment {
  const source = asRecord(value);
  return {
    id: asString(pick(source, "id", "file_id", "fileId"), asString(value)),
    name: asString(pick(source, "name", "file_name", "fileName")),
    url: asString(pick(source, "url", "download_url", "downloadUrl")),
    contentType: asString(pick(source, "content_type", "contentType", "mime_type", "mimeType")),
  };
}

function normalizeMovement(value: unknown, index: number): MouldMovementRecord {
  const source = asRecord(value);
  return {
    id: asString(pick(source, "id", "log_id", "logId", "record_code", "recordCode"), `movement-${index + 1}`),
    occurredAt: asEpochAwareDateString(pick(source, "occurred_at", "occurredAt", "logged_at", "loggedAt")),
    fromLocation: asString(pick(source, "from_location", "fromLocation", "source_location", "sourceLocation")),
    toLocation: asString(pick(source, "to_location", "toLocation", "destination_location", "destinationLocation")),
    reason: asString(pick(source, "reason", "operation_reason", "operationReason")),
    operatorName: asString(pick(source, "operator_name", "operatorName", "owner", "responsible")),
    timeQuality: asString(pick(source, "time_quality", "timeQuality"), "event_time"),
  };
}

function normalizeProduction(value: unknown, index: number): MouldProductionRecord {
  const source = asRecord(value);
  return {
    id: asString(pick(source, "id", "record_code", "recordCode"), `production-${index + 1}`),
    period: asString(pick(source, "period", "period_label", "periodLabel")),
    year: asNullableNumber(pick(source, "year")),
    month: asNullableNumber(pick(source, "month")),
    quantity: asNullableNumber(pick(source, "quantity", "output_quantity", "outputQuantity", "value")),
    cumulativeQuantity: asNullableNumber(pick(source, "cumulative_quantity", "cumulativeQuantity", "total")),
    unit: asString(pick(source, "unit", "param_unit", "paramUnit")),
    recordedAt: asEpochAwareDateString(pick(source, "recorded_at", "recordedAt", "record_time", "recordTime")),
  };
}

function normalizeRepair(value: unknown, index: number): MouldRepairRecord {
  const source = asRecord(value);
  return {
    id: asString(pick(source, "id", "task_id", "taskId"), `repair-${index + 1}`),
    recordCode: asString(pick(source, "record_code", "recordCode", "code", "task_code", "taskCode")),
    requestedAt: asEpochAwareDateString(pick(source, "requested_at", "requestedAt", "request_at", "requestAt")),
    startedAt: asEpochAwareDateString(pick(source, "started_at", "startedAt", "actual_start_at", "actualStartAt")),
    finishedAt: asEpochAwareDateString(pick(source, "finished_at", "finishedAt", "actual_end_at", "actualEndAt")),
    type: enumLabel(pick(source, "type", "repair_type", "repairType", "category")),
    content: asString(pick(source, "content", "description", "repair_content", "repairContent")),
    vendor: enumLabel(pick(source, "vendor", "supplier")),
    creatorName: asString(pick(source, "creator_name", "creatorName", "operator_name", "operatorName")),
    cumulativeOutputAmount: asNullableNumber(pick(source, "cumulative_output_amount", "cumulativeOutputAmount", "current_output_amount", "currentOutputAmount")),
    attachmentIds: asArray(pick(source, "attachment_ids", "attachmentIds", "file_id_list", "fileIdList"))
      .map((item) => asString(item))
      .filter(Boolean),
  };
}

export function normalizeMouldDetail(value: unknown): MouldDetail {
  const source = unwrapData(value);
  const mouldSource = asRecord(pick(source, "mould", "mold", "detail"));
  const baseSource = Object.keys(mouldSource).length ? { ...source, ...mouldSource } : source;
  const base = normalizeMouldRecord(baseSource);
  const attachmentsValue = pick(source, "attachments", "files") ?? pick(baseSource, "attachments", "files", "file_id_list", "fileIdList");
  const movementsValue = pick(source, "movements", "movement_history", "movementHistory", "location_history", "locationHistory")
    ?? pick(baseSource, "movements", "movement_history", "movementHistory", "location_history", "locationHistory");
  const productionValue = pick(source, "production_history", "productionHistory", "production_records", "productionRecords")
    ?? pick(baseSource, "production_history", "productionHistory", "production_records", "productionRecords");
  const repairValue = pick(source, "repair_history", "repairHistory", "repairs", "repair_records", "repairRecords")
    ?? pick(baseSource, "repair_history", "repairHistory", "repairs", "repair_records", "repairRecords");
  return {
    ...base,
    acquiredAt: asEpochAwareDateString(pick(baseSource, "acquired_at", "acquiredAt", "enter_factory_date", "enterFactoryDate")),
    enabledAt: asEpochAwareDateString(pick(baseSource, "enabled_at", "enabledAt", "enable_date", "enableDate")),
    coverFileId: asString(pick(baseSource, "cover_file_id", "coverFileId")),
    attachments: asArray(attachmentsValue).map(normalizeAttachment),
    movements: asArray(movementsValue).map(normalizeMovement),
    productionHistory: asArray(productionValue).map(normalizeProduction),
    repairHistory: asArray(repairValue).map(normalizeRepair),
    capabilities: normalizeCapabilities(pick(source, "capabilities") ?? pick(baseSource, "capabilities")),
    dataFreshness: normalizeDataFreshness(pick(source, "data_freshness", "dataFreshness"), source),
    calculationBasis: normalizeCalculationBasis(pick(source, "calculation_basis", "calculationBasis")),
    warnings: mergeWarnings(
      base.warnings,
      normalizeWarnings(pick(source, "warnings", "warning_details", "warningDetails")),
    ),
  };
}

export async function getMouldBoard(): Promise<MouldBoard> {
  const response = await http.get<unknown>(MOULD_BOARD_ENDPOINT, { skipAuth: true });
  return normalizeMouldBoard(response.data);
}

export async function getMouldDetail(instanceId: string): Promise<MouldDetail> {
  const normalizedId = instanceId.trim();
  if (!normalizedId) throw new Error("Mould instance id is required.");
  const response = await http.get<unknown>(`${MOULD_DETAIL_ENDPOINT}/${encodeURIComponent(normalizedId)}/`, { skipAuth: true });
  return normalizeMouldDetail(response.data);
}
