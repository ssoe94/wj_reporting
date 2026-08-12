import type { AppLanguage } from "@/shared/i18n/language";

export type OverviewTone = "normal" | "attention" | "critical" | "unknown";

export type ProductionProcess = {
  key: "injection" | "assembly";
  plannedQuantity: number | null;
  actualQuantity: number | null;
  completionRate: number | null;
  timeProgressRate: number | null;
  forecastCompletionRate: number | null;
  activeEquipmentCount: number | null;
  runningEquipmentCount: number | null;
  totalEquipmentCount: number | null;
  planRowCount: number | null;
  completionVsTimeGap: number | null;
  expectedQuantityByTime: number | null;
  gapToTimeQuantity: number | null;
  paceIndexPercent: number | null;
  paceStatus: "ahead" | "on_track" | "behind" | "no_plan" | "unknown";
  remainingQuantity: number | null;
  remainingBusinessMinutes: number | null;
  requiredQuantityPerHour: number | null;
  reportingMix: {
    effectiveActualQuantity: number | null;
    mesConfirmedQuantity: number | null;
    manualOpenQuantity: number | null;
    matchedManualQuantity: number | null;
    reportedDefectQuantity: number | null;
    manualOpenSharePercent: number | null;
    manualOpenRowCount: number | null;
    dataQualityNote: string | null;
  } | null;
};

export type EquipmentGroup = {
  running: number | null;
  total: number | null;
  trend: number[];
};

export type InjectionEquipmentRow = {
  id: string;
  label: string;
  machineNumber: number | null;
  isRunning: boolean;
  recent60mShots: number | null;
  recent60mAverageCycleTimeSeconds: number | null;
  plannedQuantity: number | null;
  actualQuantity: number | null;
  completionRate: number | null;
  timeProgressRate: number | null;
  gapToTimeRate: number | null;
  currentModels: string[];
  currentParts: Array<{
    modelName: string | null;
    partNumber: string | null;
    partName: string | null;
  }>;
  hasPlan: boolean | null;
  productionState: string | null;
  stateReason: string | null;
  currentPartResolutionStatus: string | null;
  resolvedCurrentPartCount: number | null;
  sourceStatus: string | null;
  sourceLatestAt: string | null;
  activityWindowMinutes: number | null;
};

export type AssemblyEquipmentRow = {
  id: string;
  label: string;
  plannedQuantity: number | null;
  actualQuantity: number | null;
  completionRate: number | null;
};

export type UtilizationPoint = {
  label: string;
  utilizationRate: number | null;
  activeMachineCount: number | null;
};

export type OeeFactor = {
  valuePercent: number | null;
  proxyValuePercent: number | null;
  status: "verified" | "proxy_only" | "unavailable" | "unknown";
  source: string | null;
  reason: string | null;
};

export type InjectionOeeStatus = {
  status: string;
  oeeRate: number | null;
  availableFactorCount: number | null;
  requiredFactorCount: number | null;
  availability: OeeFactor;
  performance: OeeFactor;
  quality: OeeFactor;
  operatingRate: number | null;
  scheduledOperatingRate: number | null;
  activityWindowMinutes: number | null;
  activityMetricsAvailable: boolean;
  activitySourceStale: boolean;
  totalEquipmentCount: number | null;
  plannedMachineCount: number | null;
  runningMachineCount: number | null;
  stoppedPlannedMachineCount: number | null;
  behindMachineCount: number | null;
  onTrackMachineCount: number | null;
  aheadMachineCount: number | null;
  unplannedMachineCount: number | null;
  bottleneckMachine: string | null;
  calculationBasis: string | null;
  trend: UtilizationPoint[];
};

export type EquipmentStatus = {
  injection: EquipmentGroup;
  assembly: EquipmentGroup;
  injectionRows: InjectionEquipmentRow[];
  assemblyRows: AssemblyEquipmentRow[];
  injectionOee: InjectionOeeStatus;
  alertLabel: string | null;
};

export type AttentionItem = {
  id: string;
  rank: number;
  category: "injection" | "assembly" | "signal" | "material" | "quality" | "equipment" | "mould";
  tone: OverviewTone;
  summary: string;
  action: string | null;
};

export type QualityAttentionItem = {
  id: string;
  machineLabel: string;
  modelLabel: string;
  partNumber: string | null;
  phenomena: string[];
  reportCount: number | null;
  latestReportDate: string | null;
  matchLabel: string | null;
};

export type QualityAiLocalizedText = {
  ko: string | null;
  zh: string | null;
};

export type QualityAiAttentionItem = {
  sourceKey: string;
  machineName: string | null;
  machineNumber: number | null;
  partPrefix: string | null;
  partNumbers: string[];
  modelNames: string[];
  matchingReportCount: number | null;
  latestReportAt: string | null;
  headline: QualityAiLocalizedText | null;
  checkpoints: {
    ko: string[];
    zh: string[];
  };
  problemTypes: Array<{
    label: QualityAiLocalizedText | null;
    count: number | null;
  }>;
  locations: Array<{
    label: QualityAiLocalizedText | null;
    count: number | null;
  }>;
};

export type QualityAiSummary = {
  status: "ready" | "pending" | "stale" | "unavailable";
  businessDate: string | null;
  sourcePlanHash: string | null;
  generatedAt: string | null;
  completedAt: string | null;
  modelId: string | null;
  modelName: string | null;
  schemaVersion: string | null;
  generationSource: string | null;
  llmFallback: boolean;
  llmFallbackCode: string | null;
  summary: QualityAiLocalizedText | null;
  disclaimer: QualityAiLocalizedText | null;
  totals: {
    planGroupCount: number | null;
    matchedReportCount: number | null;
    withoutHistoryCount: number | null;
  } | null;
  attentionItems: QualityAiAttentionItem[];
  reason: string | null;
};

export type InventoryStatus = {
  skuCount: number | null;
  finishedAndSemifinishedQuantity: number | null;
  totalCarts: number | null;
  shippingNetChange: number | null;
  shippingRecordCount: number | null;
  shippingInbound: number | null;
  shippingOutbound: number | null;
  warehouses: Array<{
    label: string;
    skuCount: number | null;
    quantity: number | null;
    carts: number | null;
  }>;
  outboundPerformance: OutboundPerformanceStatus;
};

export type OutboundPerformanceMetric = {
  unit: string | null;
  orderCount: number | null;
  lineCount: number | null;
  targetQuantity: number | null;
  fulfilledQuantity: number | null;
  completionRate: number | null;
};

export type OutboundPriorityItem = {
  category: "JIT" | "CSKD";
  outboundOrderId: string | null;
  outboundOrderCode: string;
  planTime: string | null;
  status: string | null;
  materialId: string | null;
  materialCode: string;
  materialName: string | null;
  specification: string | null;
  targetQuantity: number | null;
  fulfilledQuantity: number | null;
  remainingQuantity: number | null;
  varianceQuantity: number | null;
  completionRate: number | null;
  unit: string | null;
  fulfillmentState: "pending" | "complete" | "over" | "unknown";
};

export type OutboundTodayDetailSummary = {
  pendingLineCount: number | null;
  completeLineCount: number | null;
  overLineCount: number | null;
  zeroFulfilledLineCount: number | null;
  remainingQuantity: number | null;
  overQuantity: number | null;
  unit: string | null;
  largestPending: OutboundPriorityItem | null;
};

export type OutboundPerformancePeriod = {
  label: string | null;
  startAt: string | null;
  endAt: string | null;
  jit: OutboundPerformanceMetric;
  cskd: OutboundPerformanceMetric;
};

export type OutboundPerformanceStatus = {
  status: "ok" | "partial" | "unavailable";
  fetchedAt: string | null;
  measurementBasis: {
    cohort: string | null;
    targetQuantity: string | null;
    fulfilledQuantity: string | null;
    classification: string | null;
    eligibleUnit: string | null;
    periodPolicy: string | null;
  } | null;
  periods: {
    today: OutboundPerformancePeriod;
    previousWeek: OutboundPerformancePeriod;
    previousMonth: OutboundPerformancePeriod;
  };
  todayDetailSummary: {
    jit: OutboundTodayDetailSummary;
    cskd: OutboundTodayDetailSummary;
  };
  todayPriorityItems: OutboundPriorityItem[];
  warnings: string[];
  acceptedLineCount: number | null;
  excludedLineCount: number | null;
  ignoredOutsidePeriodLineCount: number | null;
  exclusionsByReason: Record<string, number>;
  unclassified: {
    orderCount: number | null;
    lineCount: number | null;
  };
};

export type EnergyStatus = {
  usageValue: number | null;
  unit: string;
  meteredMachineCount: number | null;
  machinesWithPositiveUsageCount: number | null;
  totalShots: number | null;
  energyPer1000ShotsKwh: number | null;
  efficiencyMeteredMachineCount: number | null;
  usageByMachine: Array<{ label: string; value: number | null }>;
  hourlyTrend: Array<{
    timestamp: string | null;
    label: string;
    usageKwh: number | null;
    movingAverage8hKwh: number | null;
    movingAverage12hKwh: number | null;
    movingAverage24hKwh: number | null;
    coverageMachineCount: number | null;
    isCurrentBusinessDay: boolean;
  }>;
};

export type MouldStatus = {
  total: number | null;
  mounted: number | null;
  stored: number | null;
  maintenance: number | null;
  repair: number | null;
  offsite: number | null;
  unknown: number | null;
  confirmationRequired: number | null;
  conflicts: number | null;
};

export type WeatherStatus = {
  location: string;
  status: "ok" | "stale" | "unavailable";
  isStale: boolean;
  temperatureC: number | null;
  relativeHumidityPercent: number | null;
  windSpeedMps: number | null;
  conditionCode: string;
  dayPhase: "day" | "night";
  validAt: string | null;
  source: string;
  sourceUrl: string | null;
  attribution: string;
};

export type OverviewBoardModel = {
  schemaVersion: string;
  language: AppLanguage;
  businessDate: string;
  generatedAt: string | null;
  businessWindow: string | null;
  overallStatus: OverviewTone;
  processes: {
    injection: ProductionProcess;
    assembly: ProductionProcess;
  };
  equipment: EquipmentStatus;
  attention: AttentionItem[];
  quality: {
    scope: string | null;
    businessDate: string | null;
    historyCoverage: string | null;
    historyWindowDays: number;
    disclaimer: string | null;
    items: QualityAttentionItem[];
    aiSummary: QualityAiSummary | null;
  };
  energy: EnergyStatus;
  weather: WeatherStatus;
  inventory: InventoryStatus;
  moulds: MouldStatus;
  freshnessLabel: string | null;
  freshness: {
    sourceCount: number;
    staleSourceCount: number;
    unavailableSourceCount: number;
  };
  warnings: string[];
};

export type OverviewBoardResult = {
  model: OverviewBoardModel;
  mode: "live" | "demo";
};
