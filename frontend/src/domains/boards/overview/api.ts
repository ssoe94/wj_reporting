import { http } from "@/shared/api/http";
import type { AppLanguage } from "@/shared/i18n/language";
import { createOverviewDemoModel } from "./fallback";
import type {
  AssemblyEquipmentRow,
  AttentionItem,
  EnergyStatus,
  InjectionEquipmentRow,
  InjectionOeeStatus,
  InventoryStatus,
  MouldStatus,
  OeeFactor,
  OutboundPriorityItem,
  OutboundTodayDetailSummary,
  OverviewBoardModel,
  OverviewBoardResult,
  OverviewTone,
  ProductionProcess,
  QualityAiAttentionItem,
  QualityAiLocalizedText,
  QualityAiProblemLocationPair,
  QualityAiSummary,
  QualityAttentionItem,
  WeatherStatus,
} from "./types";

const OVERVIEW_BOARD_ENDPOINT = "/production/overview-board/";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function firstValue(source: JsonRecord, keys: string[]) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(source: JsonRecord, keys: string[]): string | null {
  return asString(firstValue(source, keys));
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replaceAll(",", "").replace("%", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(source: JsonRecord, keys: string[]): number | null {
  return asNumber(firstValue(source, keys));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter((item): item is string => Boolean(item));
  }
  const single = asString(value);
  return single ? [single] : [];
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "1", "yes", "running"].includes(value.trim().toLowerCase());
  return false;
}

function asNullableBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  return asBoolean(value);
}

function normalizePaceStatus(value: unknown): ProductionProcess["paceStatus"] {
  const normalized = asString(value)?.toLowerCase();
  if (normalized === "ahead" || normalized === "on_track" || normalized === "behind" || normalized === "no_plan") {
    return normalized;
  }
  return "unknown";
}

function normalizeTone(value: unknown): OverviewTone {
  const normalized = asString(value)?.toLowerCase() ?? "";
  if (["normal", "ok", "healthy", "green", "정상", "正常"].includes(normalized)) return "normal";
  if (["attention", "warning", "caution", "partial", "orange", "주의", "注意"].includes(normalized)) return "attention";
  if (["critical", "danger", "error", "red", "위험", "严重"].includes(normalized)) return "critical";
  return "unknown";
}

function normalizeProcess(value: unknown, key: ProductionProcess["key"]): ProductionProcess {
  const source = asRecord(value);
  const reportingMixValue = firstValue(source, ["reporting_mix"]);
  const reportingMix = reportingMixValue && typeof reportingMixValue === "object"
    ? asRecord(reportingMixValue)
    : null;
  return {
    key,
    plannedQuantity: firstNumber(source, ["planned_quantity", "planned_qty", "plan_qty", "planned"]),
    actualQuantity: firstNumber(source, ["actual_quantity", "actual_qty", "actual", "production_qty"]),
    completionRate: firstNumber(source, ["completion_rate", "progress_rate", "achievement_rate"]),
    timeProgressRate: firstNumber(source, ["time_progress_rate", "elapsed_rate", "time_rate"]),
    forecastCompletionRate: firstNumber(source, ["forecast_completion_rate", "forecast_rate", "projected_completion_rate"]),
    activeEquipmentCount: firstNumber(source, ["active_equipment_count"]),
    runningEquipmentCount: firstNumber(source, ["running_equipment_count"]),
    totalEquipmentCount: firstNumber(source, ["total_equipment_count"]),
    planRowCount: firstNumber(source, ["plan_row_count"]),
    completionVsTimeGap: firstNumber(source, ["completion_vs_time_gap_pp", "gap_to_time_rate_pp"]),
    expectedQuantityByTime: firstNumber(source, ["expected_qty_by_time", "target_qty_by_time"]),
    gapToTimeQuantity: firstNumber(source, ["gap_to_time_qty", "quantity_gap_to_time"]),
    paceIndexPercent: firstNumber(source, ["pace_index_percent", "pace_index"]),
    paceStatus: normalizePaceStatus(firstValue(source, ["pace_status"])),
    remainingQuantity: firstNumber(source, ["remaining_qty", "remaining_quantity"]),
    remainingBusinessMinutes: firstNumber(source, ["remaining_business_minutes", "remaining_minutes"]),
    requiredQuantityPerHour: firstNumber(source, ["required_qty_per_hour", "required_quantity_per_hour"]),
    reportingMix: reportingMix ? {
      effectiveActualQuantity: firstNumber(reportingMix, ["effective_actual_qty"]),
      mesConfirmedQuantity: firstNumber(reportingMix, ["mes_confirmed_qty", "mes_qty"]),
      manualOpenQuantity: firstNumber(reportingMix, ["manual_open_qty"]),
      matchedManualQuantity: firstNumber(reportingMix, ["matched_manual_qty"]),
      reportedDefectQuantity: firstNumber(reportingMix, ["reported_defect_qty"]),
      manualOpenSharePercent: firstNumber(reportingMix, ["manual_open_share_percent"]),
      manualOpenRowCount: firstNumber(reportingMix, ["manual_open_row_count"]),
      dataQualityNote: firstString(reportingMix, ["data_quality_note"]),
    } : null,
  };
}

function normalizeInjectionEquipmentRows(value: unknown): InjectionEquipmentRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = asRecord(item);
    const machineNumber = firstNumber(row, ["machine_number"]);
    const nestedCurrentParts = Array.isArray(row.current_parts)
      ? row.current_parts.map((part) => {
          const source = asRecord(part);
          return {
            modelName: firstString(source, ["model_name", "model", "product_model"]),
            partNumber: firstString(source, ["part_no", "part_number", "product_code"]),
            partName: firstString(source, ["part_name", "product_name"]),
          };
        }).filter((part) => part.modelName || part.partNumber || part.partName)
      : [];
    const flatCurrentPart = {
      modelName: firstString(row, ["current_model", "model_name", "model", "product_model"]),
      partNumber: firstString(row, ["current_part_no", "part_no", "part_number", "product_code"]),
      partName: firstString(row, ["current_part_name", "part_name", "product_name"]),
    };
    const currentParts = nestedCurrentParts.length > 0
      ? nestedCurrentParts
      : flatCurrentPart.modelName || flatCurrentPart.partNumber || flatCurrentPart.partName
        ? [flatCurrentPart]
        : [];
    const currentModels = currentParts
      .map((part) => part.modelName ?? part.partNumber ?? part.partName)
      .filter((part): part is string => Boolean(part));
    const label = firstString(row, ["machine_name", "machine_label", "monitoring_name", "machine"])
      ?? (machineNumber === null ? `I-${index + 1}` : `I-${String(machineNumber).padStart(2, "0")}`);
    const productionState = firstString(row, ["production_state", "state"]);
    const explicitRunning = firstValue(row, ["is_running", "running"]);
    const isRunning = explicitRunning === undefined || explicitRunning === null
      ? Boolean(productionState?.startsWith("running_"))
      : asBoolean(explicitRunning);
    return {
      id: firstString(row, ["id", "key"]) ?? `${label}-${index}`,
      label,
      machineNumber,
      isRunning,
      recent60mShots: firstNumber(row, ["recent_60m_shots", "recent_shots"]),
      recent60mAverageCycleTimeSeconds: firstNumber(row, ["recent_60m_avg_ct_sec", "average_cycle_time_seconds"]),
      plannedQuantity: firstNumber(row, ["planned_qty", "planned_quantity"]),
      actualQuantity: firstNumber(row, ["actual_qty", "actual_quantity"]),
      completionRate: firstNumber(row, ["completion_rate", "progress_rate"]),
      timeProgressRate: firstNumber(row, ["time_progress_rate", "elapsed_rate", "time_rate"]),
      gapToTimeRate: firstNumber(row, ["gap_to_time_rate_pp", "completion_vs_time_gap_pp"]),
      currentModels,
      currentParts,
      hasPlan: asNullableBoolean(firstValue(row, ["has_plan"])),
      productionState,
      stateReason: firstString(row, ["state_reason", "status_reason"]),
      currentPartResolutionStatus: firstString(asRecord(row.current_part_resolution), ["status"]),
      resolvedCurrentPartCount: firstNumber(row, ["resolved_current_part_count"]),
      sourceStatus: firstString(row, ["source_status"]),
      sourceLatestAt: firstString(row, ["source_latest_at", "latest_at"]),
      activityWindowMinutes: firstNumber(row, ["activity_window_minutes"]),
    };
  });
}

function normalizeAssemblyEquipmentRows(value: unknown): AssemblyEquipmentRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = asRecord(item);
    const label = firstString(row, ["equipment_name", "equipment_label", "machine_name", "equipment_key"])
      ?? `L-${index + 1}`;
    return {
      id: firstString(row, ["id", "key", "equipment_key"]) ?? `${label}-${index}`,
      label,
      plannedQuantity: firstNumber(row, ["planned_qty", "planned_quantity"]),
      actualQuantity: firstNumber(row, ["actual_qty", "actual_quantity"]),
      completionRate: firstNumber(row, ["completion_rate", "progress_rate"]),
    };
  });
}

function normalizeOeeFactor(value: unknown): OeeFactor {
  const source = asRecord(value);
  const rawStatus = firstString(source, ["status"])?.toLowerCase();
  const status: OeeFactor["status"] = rawStatus === "verified" || rawStatus === "proxy_only" || rawStatus === "unavailable"
    ? rawStatus
    : "unknown";
  return {
    valuePercent: firstNumber(source, ["value_percent", "value", "rate"]),
    proxyValuePercent: firstNumber(source, ["proxy_value_percent", "proxy_value", "proxy_rate"]),
    status,
    source: firstString(source, ["source", "calculation_source"]),
    reason: firstString(source, ["reason", "warning", "note"]),
  };
}

function normalizeInjectionOee(
  value: unknown,
  injectionRows: InjectionEquipmentRow[],
  process: ProductionProcess,
): InjectionOeeStatus {
  const source = asRecord(value);
  const oee = asRecord(source.oee);
  const factors = asRecord(oee.factors);
  const paceCounts = asRecord(source.pace_counts);
  const trendValue = firstValue(source, ["utilization_trend", "trend"]);
  const trend = Array.isArray(trendValue)
    ? trendValue.map((item, index) => {
        const point = asRecord(item);
        return {
          label: firstString(point, ["label", "time", "timestamp"]) ?? String(index + 1),
          utilizationRate: firstNumber(point, ["utilization_rate", "operating_rate_percent", "value"]),
          activeMachineCount: firstNumber(point, ["active_machine_count", "running_machine_count"]),
        };
      })
    : [];
  const runningFallback = injectionRows.length > 0
    ? injectionRows.filter((row) => row.isRunning).length
    : process.runningEquipmentCount;
  const totalFallback = process.totalEquipmentCount;
  const operatingFallback = runningFallback !== null && totalFallback !== null && totalFallback > 0
    ? (runningFallback / totalFallback) * 100
    : null;
  const hasOperatingRate = ["operating_rate_percent", "operating_rate"].some((key) => Object.prototype.hasOwnProperty.call(source, key));
  const bottleneck = asRecord(source.bottleneck_machine);
  return {
    status: firstString(oee, ["status"]) ?? "unavailable",
    oeeRate: firstNumber(oee, ["value_percent", "oee_rate", "value"]),
    availableFactorCount: firstNumber(oee, ["available_factor_count"]),
    requiredFactorCount: firstNumber(oee, ["required_factor_count"]) ?? 3,
    availability: normalizeOeeFactor(factors.availability),
    performance: normalizeOeeFactor(factors.performance),
    quality: normalizeOeeFactor(factors.quality),
    operatingRate: hasOperatingRate
      ? firstNumber(source, ["operating_rate_percent", "operating_rate"])
      : operatingFallback,
    scheduledOperatingRate: firstNumber(source, ["scheduled_operating_rate_percent", "scheduled_operating_rate"]),
    activityWindowMinutes: firstNumber(source, ["activity_window_minutes"]) ?? 60,
    activityMetricsAvailable: Object.prototype.hasOwnProperty.call(source, "activity_metrics_available")
      ? asBoolean(source.activity_metrics_available)
      : injectionRows.length > 0,
    activitySourceStale: asBoolean(source.activity_source_stale),
    totalEquipmentCount: firstNumber(source, ["total_equipment_count"]) ?? totalFallback,
    plannedMachineCount: firstNumber(source, ["planned_equipment_count", "planned_machine_count"]),
    runningMachineCount: firstNumber(source, ["running_equipment_count", "running_machine_count"]) ?? runningFallback,
    stoppedPlannedMachineCount: firstNumber(source, ["stopped_planned_equipment_count", "stopped_planned_machine_count"]),
    behindMachineCount: firstNumber(paceCounts, ["behind"]) ?? injectionRows.filter((row) => (row.gapToTimeRate ?? 0) < -5).length,
    onTrackMachineCount: firstNumber(paceCounts, ["on_track"]),
    aheadMachineCount: firstNumber(paceCounts, ["ahead"]),
    unplannedMachineCount: firstNumber(source, ["unplanned_active_equipment_count", "unplanned_machine_count", "unplanned_equipment_count"]),
    bottleneckMachine: firstString(bottleneck, ["machine_name", "machine_label", "label"])
      ?? firstString(source, ["bottleneck_machine"]),
    calculationBasis: firstString(oee, ["calculation_basis"]),
    trend,
  };
}

function attentionCategory(value: unknown, processValue: unknown): AttentionItem["category"] {
  const normalized = asString(value)?.toLowerCase() ?? "";
  const process = asString(processValue)?.toLowerCase() ?? "";
  if (process === "injection") return "injection";
  if (process === "mould" || normalized.includes("mould") || normalized.includes("mold")) return "mould";
  if (process === "assembly" || process === "machining") return "assembly";
  if (normalized.includes("signal")) return "signal";
  if (normalized.includes("material") || normalized.includes("inventory")) return "material";
  if (normalized.includes("quality")) return "quality";
  if (normalized.includes("equipment") || normalized.includes("machine")) return "equipment";
  return "assembly";
}

function normalizeAttention(value: unknown, index: number): AttentionItem | null {
  const source = asRecord(value);
  const summary = firstString(source, ["summary", "message", "title", "label"]);
  if (!summary) return null;
  return {
    id: firstString(source, ["id", "key"]) ?? `attention-${index}`,
    rank: firstNumber(source, ["rank", "priority", "order"]) ?? index + 1,
    category: attentionCategory(
      firstValue(source, ["category", "type", "source"]),
      firstValue(source, ["process", "process_key"]),
    ),
    tone: normalizeTone(firstValue(source, ["tone", "status", "severity"])),
    summary,
    action: firstString(source, ["action", "recommended_action", "detail", "note"]),
  };
}

function normalizePhenomena(source: JsonRecord) {
  const direct = asStringArray(firstValue(source, ["phenomena", "top_phenomena", "issues", "warnings"]));
  if (direct.length > 0) return direct;
  const phenomenon = firstString(source, ["phenomenon", "issue", "quality_issue"]);
  return phenomenon ? phenomenon.split(/[·,/|]/).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeQualityItem(value: unknown, index: number): QualityAttentionItem | null {
  const source = asRecord(value);
  const machineLabel = firstString(source, ["machine_label", "machine_name", "machine", "equipment_name"]);
  const modelLabel = firstString(source, ["model_label", "model_name", "model", "current_model"]);
  if (!machineLabel && !modelLabel) return null;
  return {
    id: firstString(source, ["id", "key"]) ?? `quality-${index}`,
    machineLabel: machineLabel ?? "-",
    modelLabel: modelLabel ?? "-",
    partNumber: firstString(source, ["part_number", "part_no", "current_part_no"]),
    phenomena: normalizePhenomena(source),
    reportCount: firstNumber(source, ["report_count", "matching_report_count", "history_report_count"]),
    latestReportDate: firstString(source, ["latest_report_date", "latest_report_dt", "latest_date"]),
    matchLabel: firstString(source, ["match_label", "resolution_label", "match_type_label"]),
  };
}

function normalizeNestedQualityItems(value: unknown): QualityAttentionItem[] {
  if (!Array.isArray(value)) return [];
  const rows: QualityAttentionItem[] = [];

  value.forEach((machineValue, machineIndex) => {
    const machine = asRecord(machineValue);
    if (!Array.isArray(machine.parts)) {
      const flatItem = normalizeQualityItem(machineValue, machineIndex);
      if (flatItem) rows.push(flatItem);
      return;
    }

    const machineNumber = firstNumber(machine, ["machine_number"]);
    const machineLabel = firstString(machine, ["machine_name", "machine_label"])
      ?? (machineNumber === null ? "-" : `I-${String(machineNumber).padStart(2, "0")}`);
    const resolution = asRecord(machine.resolution);
    machine.parts.forEach((partValue, partIndex) => {
      const part = asRecord(partValue);
      const reportCount = firstNumber(part, ["historical_report_count", "report_count"]);
      if (reportCount !== null && reportCount <= 0) return;
      const topPhenomena = Array.isArray(part.top_phenomena)
        ? part.top_phenomena
            .map((item) => firstString(asRecord(item), ["phenomenon", "label"]))
            .filter((item): item is string => Boolean(item))
        : [];
      const partNumber = firstString(part, ["part_no", "part_number"]);
      rows.push({
        id: `${machineLabel}-${partNumber ?? partIndex}`,
        machineLabel,
        modelLabel: firstString(part, ["model_name", "model_label"]) ?? "-",
        partNumber,
        phenomena: topPhenomena,
        reportCount,
        latestReportDate: firstString(part, ["latest_historical_report_at", "latest_report_date"]),
        matchLabel: firstString(part, ["match_type", "match_label"])
          ?? firstString(resolution, ["method", "status"]),
      });
    });
  });

  return rows;
}

function normalizeQualityAiLocalizedText(value: unknown): QualityAiLocalizedText | null {
  const source = asRecord(value);
  const ko = firstString(source, ["ko"]);
  const zh = firstString(source, ["zh"]);
  return ko || zh ? { ko, zh } : null;
}

function normalizeQualityAiRankedLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = asRecord(item);
    return {
      label: normalizeQualityAiLocalizedText(source.label),
      count: firstNumber(source, ["count"]),
    };
  }).filter((item) => item.label !== null);
}

function normalizeQualityAiProblemLocationPairs(value: unknown): QualityAiProblemLocationPair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = asRecord(item);
    const problemLabel = normalizeQualityAiLocalizedText(source.problem_label);
    const locationLabel = normalizeQualityAiLocalizedText(source.location_label);
    if (!problemLabel || !locationLabel) return [];
    return [{
      label: normalizeQualityAiLocalizedText(source.label),
      problemLabel,
      locationLabel,
      count: firstNumber(source, ["count"]),
    }];
  });
}

function normalizeQualityAiAttentionItems(value: unknown): QualityAiAttentionItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const source = asRecord(item);
    const checkpoints = asRecord(source.checkpoints);
    return {
      sourceKey: firstString(source, ["source_key"]) ?? `quality-ai-${index}`,
      machineName: firstString(source, ["machine_name"]),
      machineNumber: firstNumber(source, ["machine_number"]),
      partPrefix: firstString(source, ["part_prefix"]),
      partNumbers: asStringArray(source.part_nos),
      modelNames: asStringArray(source.model_names),
      matchingReportCount: firstNumber(source, ["matching_report_count"]),
      latestReportAt: firstString(source, ["latest_report_dt"]),
      headline: normalizeQualityAiLocalizedText(source.headline),
      checkpoints: {
        ko: asStringArray(checkpoints.ko),
        zh: asStringArray(checkpoints.zh),
      },
      problemTypes: normalizeQualityAiRankedLabels(source.problem_types),
      problemLocationPairs: normalizeQualityAiProblemLocationPairs(source.problem_location_pairs),
      locations: normalizeQualityAiRankedLabels(source.locations),
    };
  });
}

function normalizeQualityAiSummary(value: unknown): QualityAiSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = asRecord(value);
  const rawStatus = firstString(source, ["status"])?.toLowerCase();
  const status: QualityAiSummary["status"] = rawStatus === "ready"
    || rawStatus === "pending"
    || rawStatus === "stale"
    ? rawStatus
    : "unavailable";
  const totalsValue = firstValue(source, ["totals"]);
  const totals = totalsValue && typeof totalsValue === "object" && !Array.isArray(totalsValue)
    ? asRecord(totalsValue)
    : null;
  return {
    status,
    businessDate: firstString(source, ["business_date"]),
    sourcePlanHash: firstString(source, ["source_plan_hash"]),
    sourceEvidenceHash: firstString(source, ["source_evidence_hash"]),
    generatedAt: firstString(source, ["generated_at"]),
    completedAt: firstString(source, ["completed_at"]),
    modelId: firstString(source, ["model_id"]),
    schemaVersion: firstString(source, ["schema_version"]),
    generationSource: firstString(source, ["generation_source"]),
    llmFallback: asBoolean(firstValue(source, ["llm_fallback"])),
    llmFallbackCode: firstString(source, ["llm_fallback_code"]),
    summary: normalizeQualityAiLocalizedText(source.summary),
    disclaimer: normalizeQualityAiLocalizedText(source.disclaimer),
    totals: totals ? {
      planGroupCount: firstNumber(totals, ["plan_group_count"]),
      matchedReportCount: firstNumber(totals, ["matched_report_count"]),
      withoutHistoryCount: firstNumber(totals, ["without_history_count"]),
    } : null,
    attentionItems: normalizeQualityAiAttentionItems(source.attention_items),
    reason: firstString(source, ["reason"]),
  };
}

function normalizeInventory(value: unknown): InventoryStatus {
  const source = asRecord(value);
  const finishedGoods = asRecord(firstValue(source, ["finished_and_semifinished", "finished_goods", "finished_product"]));
  const shipping = asRecord(source.shipping);
  const outboundPerformance = normalizeOutboundPerformance(firstValue(source, ["outbound_performance", "outboundPerformance"]));
  const warehouses = Array.isArray(finishedGoods.warehouses)
    ? finishedGoods.warehouses.map((item, index) => {
        const row = asRecord(item);
        return {
          label: firstString(row, ["warehouse_name", "label", "name"]) ?? String(index + 1),
          skuCount: firstNumber(row, ["sku_count"]),
          quantity: firstNumber(row, ["total_quantity", "quantity", "qty"]),
          carts: firstNumber(row, ["total_carts", "cart_count", "carts"]),
        };
      })
    : [];
  return {
    skuCount: firstNumber(finishedGoods, ["sku_count"]),
    finishedAndSemifinishedQuantity: firstNumber(finishedGoods, ["total_quantity", "quantity", "qty", "stock"]),
    totalCarts: firstNumber(finishedGoods, ["total_carts", "carts"]),
    shippingNetChange: firstNumber(shipping, ["net_change"]),
    shippingRecordCount: firstNumber(shipping, ["record_count"]),
    shippingInbound: firstNumber(shipping, ["total_in", "inbound", "in_qty"]),
    shippingOutbound: firstNumber(shipping, ["total_out", "outbound", "out_qty"]),
    warehouses,
    outboundPerformance,
  };
}

function normalizeOutboundMetric(value: unknown) {
  const source = asRecord(value);
  return {
    unit: firstString(source, ["unit", "uom", "quantity_unit"]),
    orderCount: firstNumber(source, ["order_count", "orders"]),
    lineCount: firstNumber(source, ["line_count", "item_count", "lines"]),
    targetQuantity: firstNumber(source, ["target_qty", "planned_qty", "plan_qty"]),
    fulfilledQuantity: firstNumber(source, ["fulfilled_qty", "actual_qty", "done_qty"]),
    completionRate: firstNumber(source, ["completion_rate", "fulfillment_rate", "achievement_rate"]),
  };
}

function normalizeOutboundPeriod(value: unknown) {
  const source = asRecord(value);
  const metrics = asRecord(firstValue(source, ["metrics", "categories"]));
  return {
    label: firstString(source, ["label", "period_label"]),
    startAt: firstString(source, ["start_at", "start_date", "date_from"]),
    endAt: firstString(source, ["end_at", "end_date", "date_to"]),
    jit: normalizeOutboundMetric(firstValue(source, ["JIT", "jit"]) ?? firstValue(metrics, ["JIT", "jit"])),
    cskd: normalizeOutboundMetric(firstValue(source, ["CSKD", "cskd", "CKD", "ckd"])
      ?? firstValue(metrics, ["CSKD", "cskd", "CKD", "ckd"])),
  };
}

function normalizeOutboundPriorityItem(value: unknown): OutboundPriorityItem | null {
  const source = asRecord(value);
  const rawCategory = firstString(source, ["category", "order_category"])?.toUpperCase();
  const category: OutboundPriorityItem["category"] | null = rawCategory === "JIT"
    ? "JIT"
    : rawCategory === "CSKD" || rawCategory === "CKD" || rawCategory === "CSD"
      ? "CSKD"
      : null;
  const materialCode = firstString(source, ["material_code", "material_no", "material_number", "code"]);
  if (!category || !materialCode) return null;

  const rawState = firstString(source, ["fulfillment_state", "state"])?.toLowerCase();
  const fulfillmentState: OutboundPriorityItem["fulfillmentState"] = rawState === "pending"
    || rawState === "complete"
    || rawState === "over"
    ? rawState
    : "unknown";
  return {
    category,
    outboundOrderId: firstString(source, ["outbound_order_id", "order_id"]),
    outboundOrderCode: firstString(source, ["outbound_order_code", "order_code"]) ?? "-",
    planTime: firstString(source, ["plan_time", "planned_at"]),
    status: firstString(source, ["status", "biz_status"]),
    materialId: firstString(source, ["material_id"]),
    materialCode,
    materialName: firstString(source, ["material_name", "name"]),
    specification: firstString(source, ["specification", "material_spec", "spec"]),
    targetQuantity: firstNumber(source, ["target_qty", "plan_qty", "plan_amount"]),
    fulfilledQuantity: firstNumber(source, ["fulfilled_qty", "done_qty", "done_amount"]),
    remainingQuantity: firstNumber(source, ["remaining_qty", "remaining_quantity"]),
    varianceQuantity: firstNumber(source, ["variance_qty", "variance_quantity"]),
    completionRate: firstNumber(source, ["completion_rate", "fulfillment_rate"]),
    unit: firstString(source, ["unit", "uom"]),
    fulfillmentState,
  };
}

function normalizeOutboundTodayDetailSummary(value: unknown): OutboundTodayDetailSummary {
  const source = asRecord(value);
  return {
    pendingLineCount: firstNumber(source, ["pending_line_count", "pending_count"]),
    completeLineCount: firstNumber(source, ["complete_line_count", "complete_count"]),
    overLineCount: firstNumber(source, ["over_line_count", "over_count"]),
    zeroFulfilledLineCount: firstNumber(source, ["zero_fulfilled_line_count", "zero_done_count"]),
    remainingQuantity: firstNumber(source, ["remaining_qty", "remaining_quantity"]),
    overQuantity: firstNumber(source, ["over_qty", "over_quantity"]),
    unit: firstString(source, ["unit", "uom"]),
    largestPending: normalizeOutboundPriorityItem(firstValue(source, ["largest_pending", "priority_item"])),
  };
}

function normalizeOutboundMeasurementBasis(value: unknown): InventoryStatus["outboundPerformance"]["measurementBasis"] {
  const direct = asString(value);
  if (direct) {
    return {
      cohort: direct,
      targetQuantity: null,
      fulfilledQuantity: null,
      classification: null,
      eligibleUnit: null,
      periodPolicy: null,
    };
  }
  const source = asRecord(value);
  if (Object.keys(source).length === 0) return null;
  return {
    cohort: firstString(source, ["cohort"]),
    targetQuantity: firstString(source, ["target_qty", "target_quantity"]),
    fulfilledQuantity: firstString(source, ["fulfilled_qty", "fulfilled_quantity"]),
    classification: firstString(source, ["classification"]),
    eligibleUnit: firstString(source, ["eligible_unit", "unit_policy"]),
    periodPolicy: firstString(source, ["period_policy"]),
  };
}

function normalizeOutboundPerformance(value: unknown): InventoryStatus["outboundPerformance"] {
  const source = asRecord(value);
  const periods = asRecord(source.periods);
  const todayDetailSummary = asRecord(firstValue(source, ["today_detail_summary", "todayDetailSummary"]));
  const priorityItemsValue = firstValue(source, ["today_priority_items", "todayPriorityItems"]);
  const exclusionsByReason = Object.fromEntries(
    Object.entries(asRecord(source.exclusions_by_reason))
      .map(([reason, count]) => [reason, asNumber(count)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== null),
  );
  const rawStatus = firstString(source, ["status"])?.toLowerCase();
  const status: InventoryStatus["outboundPerformance"]["status"] = rawStatus === "ok" || rawStatus === "partial"
    ? rawStatus
    : "unavailable";
  const unclassified = asRecord(source.unclassified);
  return {
    status,
    fetchedAt: firstString(source, ["fetched_at", "updated_at"]),
    measurementBasis: normalizeOutboundMeasurementBasis(firstValue(source, ["measurement_basis", "calculation_basis"])),
    periods: {
      today: normalizeOutboundPeriod(periods.today),
      previousWeek: normalizeOutboundPeriod(firstValue(periods, ["previous_week", "last_week"])),
      previousMonth: normalizeOutboundPeriod(firstValue(periods, ["previous_month", "last_month"])),
    },
    todayDetailSummary: {
      jit: normalizeOutboundTodayDetailSummary(firstValue(todayDetailSummary, ["JIT", "jit"])),
      cskd: normalizeOutboundTodayDetailSummary(firstValue(todayDetailSummary, ["CSKD", "cskd", "CKD", "ckd"])),
    },
    todayPriorityItems: Array.isArray(priorityItemsValue)
      ? priorityItemsValue
          .map(normalizeOutboundPriorityItem)
          .filter((item): item is OutboundPriorityItem => item !== null)
      : [],
    warnings: asStringArray(source.warnings),
    acceptedLineCount: firstNumber(source, ["accepted_line_count"]),
    excludedLineCount: firstNumber(source, ["excluded_line_count"]),
    ignoredOutsidePeriodLineCount: firstNumber(source, ["ignored_outside_period_line_count"]),
    exclusionsByReason,
    unclassified: {
      orderCount: firstNumber(unclassified, ["order_count", "orders"])
        ?? firstNumber(source, ["unclassified_order_count"]),
      lineCount: firstNumber(unclassified, ["line_count", "item_count", "lines"])
        ?? firstNumber(source, ["unclassified_line_count"]),
    },
  };
}

function normalizeEnergy(value: unknown): EnergyStatus {
  const source = asRecord(value);
  const rawUsage = firstNumber(source, ["usage_kwh", "usage_value", "total_usage"]);
  const rawUnit = firstString(source, ["unit"]) ?? "kWh";
  const sourceIsMwh = rawUnit.trim().toLowerCase() === "mwh";
  const toKwh = (amount: number | null) => (
    amount === null ? null : sourceIsMwh ? amount * 1_000 : amount
  );
  const usageByMachine = source.usage_by_machine;
  const hourlyTrend = source.hourly_trend;
  return {
    usageValue: toKwh(rawUsage),
    unit: "kWh",
    meteredMachineCount: firstNumber(source, ["metered_machine_count"]),
    machinesWithPositiveUsageCount: firstNumber(source, ["machines_with_positive_usage_count"]),
    totalShots: firstNumber(source, ["total_shots"]),
    energyPer1000ShotsKwh: firstNumber(source, ["energy_per_1000_shots_kwh"]),
    efficiencyMeteredMachineCount: firstNumber(source, ["efficiency_metered_machine_count"]),
    usageByMachine: Array.isArray(usageByMachine)
      ? usageByMachine.map((item, index) => {
          const point = asRecord(item);
          const rawValue = firstNumber(point, ["usage_kwh", "value", "usage"]);
          return {
            label: firstString(point, ["machine_name", "label"]) ?? String(index + 1),
            value: toKwh(rawValue),
          };
        })
      : [],
    hourlyTrend: Array.isArray(hourlyTrend)
      ? hourlyTrend.map((item, index) => {
          const point = asRecord(item);
          return {
            timestamp: firstString(point, ["timestamp"]),
            label: firstString(point, ["label"]) ?? String(index + 1),
            usageKwh: firstNumber(point, ["usage_kwh"]),
            movingAverage8hKwh: firstNumber(point, ["ma_8h_kwh"]),
            movingAverage12hKwh: firstNumber(point, ["ma_12h_kwh"]),
            movingAverage24hKwh: firstNumber(point, ["ma_24h_kwh"]),
            coverageMachineCount: firstNumber(point, ["coverage_machine_count"]),
            isCurrentBusinessDay: asBoolean(firstValue(point, ["is_current_business_day"])),
          };
        })
      : [],
  };
}

function normalizeMoulds(value: unknown): MouldStatus {
  const source = asRecord(value);
  return {
    total: firstNumber(source, ["total", "managed_count", "total_count", "mould_count"]),
    mounted: firstNumber(source, ["mounted"]),
    stored: firstNumber(source, ["stored"]),
    maintenance: firstNumber(source, ["maintenance"]),
    repair: firstNumber(source, ["repair"]),
    offsite: firstNumber(source, ["offsite"]),
    unknown: firstNumber(source, ["unknown"]),
    confirmationRequired: firstNumber(source, ["confirmation_required", "inspection_due_count"]),
    conflicts: firstNumber(source, ["conflicts", "location_conflicts", "location_conflict_count", "conflict_count"]),
  };
}

function normalizeWeather(value: unknown): WeatherStatus {
  const source = asRecord(value);
  const rawStatus = firstString(source, ["status"]);
  const rawDayPhase = firstString(source, ["day_phase"]);
  const rawSymbolCode = firstString(source, ["symbol_code"])?.toLowerCase() ?? "";
  const fallbackDayPhase = (() => {
    if (rawSymbolCode.endsWith("_night")) return "night" as const;
    if (rawSymbolCode.endsWith("_day")) return "day" as const;
    const shanghaiHour = Number(new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Shanghai",
    }).format(new Date()));
    return shanghaiHour >= 6 && shanghaiHour < 18 ? "day" as const : "night" as const;
  })();
  const status: WeatherStatus["status"] = rawStatus === "ok" || rawStatus === "stale" ? rawStatus : "unavailable";
  return {
    location: firstString(source, ["location"]) ?? "Nanjing",
    status,
    isStale: asBoolean(firstValue(source, ["is_stale"])) || status === "stale",
    temperatureC: firstNumber(source, ["temperature_c"]),
    relativeHumidityPercent: firstNumber(source, ["relative_humidity_percent"]),
    windSpeedMps: firstNumber(source, ["wind_speed_mps"]),
    conditionCode: firstString(source, ["condition_code"]) ?? "unknown",
    dayPhase: rawDayPhase === "day" || rawDayPhase === "night" ? rawDayPhase : fallbackDayPhase,
    validAt: firstString(source, ["valid_at"]),
    source: firstString(source, ["source"]) ?? "MET Norway",
    sourceUrl: firstString(source, ["source_url"]),
    attribution: firstString(source, ["attribution"]) ?? "Weather data: MET Norway",
  };
}

function normalizeOverviewResponse(
  value: unknown,
  requestedDate: string,
  requestedLanguage: AppLanguage,
): OverviewBoardModel {
  const source = asRecord(value);
  if (Object.keys(source).length === 0) throw new Error("Invalid overview board response");

  const processes = asRecord(source.processes);
  const overallStatus = asRecord(source.overall_status);
  const quality = asRecord(source.quality);
  const planQualityItems = firstValue(quality, ["plan_items", "planItems"]);
  const qualityItems = Array.isArray(planQualityItems) && planQualityItems.length > 0
    ? planQualityItems
    : firstValue(quality, ["items", "rows"]);
  const freshness = asRecord(source.freshness);
  const freshnessSources = asRecord(freshness.sources);
  const freshnessStates = Object.values(freshnessSources).map(asRecord);

  const attention = Array.isArray(source.attention)
    ? source.attention.map(normalizeAttention).filter((item): item is AttentionItem => item !== null)
    : [];
  const normalizedQualityItems = normalizeNestedQualityItems(qualityItems);
  const injectionProcess = normalizeProcess(processes.injection, "injection");
  const assemblyProcess = normalizeProcess(processes.assembly ?? processes.machining, "assembly");
  const equipment = asRecord(source.equipment);
  const injectionEquipmentNode = equipment.injection;
  const assemblyEquipmentNode = equipment.assembly;
  const injectionRows = normalizeInjectionEquipmentRows(
    Array.isArray(injectionEquipmentNode)
      ? injectionEquipmentNode
      : firstValue(asRecord(injectionEquipmentNode), ["rows", "machines", "items"]),
  );
  const assemblyRows = normalizeAssemblyEquipmentRows(
    Array.isArray(assemblyEquipmentNode)
      ? assemblyEquipmentNode
      : firstValue(asRecord(assemblyEquipmentNode), ["rows", "lines", "items"]),
  );
  const injectionOee = normalizeInjectionOee(
    firstValue(equipment, ["injection_summary", "injection_oee", "oee"])
      ?? firstValue(asRecord(injectionEquipmentNode), ["summary", "oee"]),
    injectionRows,
    injectionProcess,
  );

  const responseLanguage = firstString(source, ["language"]);
  return {
    schemaVersion: firstString(source, ["schema_version"]) ?? "unknown",
    language: responseLanguage === "zh" ? "zh" : responseLanguage === "ko" ? "ko" : requestedLanguage,
    businessDate: firstString(source, ["business_date"]) ?? requestedDate,
    generatedAt: firstString(source, ["generated_at"]),
    businessWindow: firstString(source, ["business_window"]),
    overallStatus: normalizeTone(firstValue(overallStatus, ["code", "status", "tone"]) ?? source.overall_status),
    processes: {
      injection: injectionProcess,
      assembly: assemblyProcess,
    },
    equipment: {
      injection: {
        running: injectionOee.runningMachineCount,
        total: injectionOee.totalEquipmentCount,
        trend: injectionOee.trend.map((point) => point.utilizationRate).filter((point): point is number => point !== null),
      },
      assembly: {
        running: assemblyProcess.activeEquipmentCount,
        total: assemblyProcess.totalEquipmentCount,
        trend: [],
      },
      injectionRows,
      assemblyRows,
      injectionOee,
      alertLabel: attention.find((item) => item.category === "signal" || item.category === "equipment")?.summary ?? null,
    },
    attention,
    quality: {
      scope: firstString(quality, ["scope", "scope_label"]),
      businessDate: firstString(quality, ["business_date", "businessDate"]),
      historyCoverage: firstString(quality, ["history_coverage", "historyCoverage"]),
      historyWindowDays: firstNumber(quality, ["history_window_days", "lookback_days"]) ?? 90,
      disclaimer: firstString(quality, ["disclaimer"]),
      items: normalizedQualityItems,
      aiSummary: normalizeQualityAiSummary(firstValue(quality, ["ai_summary", "aiSummary"])),
    },
    energy: normalizeEnergy(source.energy),
    weather: normalizeWeather(source.weather),
    inventory: normalizeInventory(source.inventory),
    moulds: normalizeMoulds(source.moulds),
    freshnessLabel: firstString(freshness, ["label", "summary", "latest_label"]),
    freshness: {
      sourceCount: freshnessStates.length,
      staleSourceCount: freshnessStates.filter((state) => state.stale === true).length,
      unavailableSourceCount: freshnessStates.filter((state) => {
        const status = firstString(state, ["status"])?.toLowerCase();
        return status === "error" || status === "missing";
      }).length,
    },
    warnings: asStringArray(source.warnings),
  };
}

export async function getOverviewBoard(
  businessDate: string,
  language: AppLanguage,
): Promise<OverviewBoardResult> {
  try {
    const response = await http.get<unknown>(OVERVIEW_BOARD_ENDPOINT, {
      params: { date: businessDate, lang: language },
      skipAuth: true,
    });
    return {
      model: normalizeOverviewResponse(response.data, businessDate, language),
      mode: "live",
    };
  } catch (error) {
    if (import.meta.env.DEV) {
      return {
        model: createOverviewDemoModel(businessDate, language),
        mode: "demo",
      };
    }
    throw error;
  }
}
