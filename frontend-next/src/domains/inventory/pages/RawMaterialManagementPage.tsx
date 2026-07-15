import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock3,
  RefreshCw,
  Search,
  Warehouse,
  Weight,
} from "lucide-react";
import {
  getRawMaterialOverview,
  getRawMaterialStockDetails,
  getRawMaterialSyncStatus,
  startRawMaterialSync,
  type RawMaterialOverview,
  type RawMaterialRisk,
  type RawMaterialRow,
  type RawMaterialStockDetail,
  type RawMaterialTransaction,
  type RawMaterialTrendPoint,
  type RawMaterialWarningDetail,
} from "@/domains/inventory/api";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";

const pageCopy = {
  ko: {
    eyebrow: "재고 관리",
    title: "원재료 관리",
    description: "매일 08:00 저장한 MES 재고로 24시간 변화와 최근 소요 흐름을 한 화면에서 검토합니다.",
    loading: "저장된 원재료 재고 보고서를 불러오는 중입니다.",
    fetchError: "저장된 원재료 보고서를 불러오지 못했습니다. 권한 또는 동기화 상태를 확인해주세요.",
    partial: "일부 MES 데이터를 불러오지 못해 현재 확인 가능한 범위만 표시합니다.",
    selectionRequired: "원재료창고 설정을 확인해 주세요.",
    selectionHint: "원재료창고를 자동으로 확인하지 못했습니다. MES 원재료창고 ID 설정을 확인해 주세요.",
    filters: "조회 조건",
    advancedFilters: "고급 분석 조건",
    warehouses: "원재료 창고",
    allWarehouses: "원재료 후보 자동 선택",
    period: "분석 기간",
    days7: "최근 7일",
    days14: "최근 14일",
    days30: "최근 30일",
    days60: "최근 60일",
    days90: "최근 90일",
    lead: "조달 리드타임",
    review: "검토 주기",
    days: "일",
    unit: "수량 단위",
    search: "원재료 검색",
    searchPlaceholder: "코드, 원재료명, 규격 검색",
    riskFilter: "재고 위험",
    allRisks: "전체 위험",
    refresh: "수동 MES 업데이트",
    refreshing: "MES 업데이트 중",
    syncStartFailed: "수동 MES 업데이트를 시작하지 못했습니다. 잠시 후 다시 시도해주세요.",
    syncFailed: "수동 MES 업데이트에 실패했습니다.",
    syncCooldown: "최근 MES 업데이트가 끝난 직후입니다. 서버 부하 방지를 위해 잠시 후 다시 시도해주세요.",
    syncRunning: "MES 데이터를 한 번만 수집해 새 보고서를 만드는 중입니다. 완료되면 화면이 자동으로 갱신됩니다.",
    syncComplete: "수동 MES 업데이트가 완료되어 저장된 보고서를 갱신했습니다.",
    syncQueued: "이미 실행 중인 MES 업데이트를 이어서 확인합니다.",
    syncRequired: "저장된 08:00 재고가 없습니다. 수동 MES 업데이트를 한 번 실행해 최초 보고서를 만들어주세요.",
    manualHint: "예외적으로 최신 수치가 필요할 때만 사용하세요. 중복 업데이트는 실행되지 않습니다.",
    sourceLatest: "저장 재고 기준",
    changeLatest: "변동 기록 기준",
    scheduled: "매일 08:00 자동 업데이트",
    scheduleLabel: "자동 업데이트",
    statusToolbar: "원재료창고 데이터 상태",
    rawWarehouseName: "원재료창고",
    fixedUnit: "기준 단위",
    dataReference: "재고 기준",
    storedMode: "저장 보고서",
    manualMode: "수동 갱신 현재고",
    generatedAt: "화면 산출",
    noTimestamp: "확인 불가",
    fresh: "최신",
    delayed: "갱신 확인",
    stale: "지연",
    previous: "이전",
    next: "다음",
    current: "실물 현재고",
    usable: "발주 가용재고",
    restricted: "QC 제한",
    unclassified: "QC 미분류",
    usableRate: "가용 비율",
    inbound: "입고",
    outbound: "출고",
    consumption: "추정 소요(출고)",
    transferOut: "이동 출고",
    adjustment: "조정",
    recommended: "권고 발주",
    materialCount: "원재료 수",
    periodSuffix: "기간 합계",
    healthEyebrow: "현재고 상태",
    healthTitle: "저장 현재고 건전성",
    healthHint: "선택 단위의 실물 현재고를 QC 가용·제한·미분류 상태로 나눠 봅니다.",
    qcComposition: "QC 상태 구성",
    healthRisk: "발주 위험 분포",
    riskHint: "리드타임과 재주문점을 기준으로 분류한 원재료 수입니다. 막대나 항목을 선택하면 상세 목록이 필터링됩니다.",
    critical: "긴급",
    warning: "주의",
    healthy: "정상",
    noUsage: "사용 이력 없음",
    unknown: "데이터 확인",
    noRisk: "분류할 원재료가 없습니다.",
    flowEyebrow: "사용 및 변동",
    flowTitle: "추정 소요·변동 추이",
    flowHint: "생산 출고(out)만 추정 소요로 보며, 창고 간 이동 출고(issue)는 별도로 구분합니다.",
    dailyMovement: "일별 입고·추정 소요·이동 출고",
    dailyMovementHint: "세 값은 모두 0 기준의 동일한 수량 축을 사용하며 이동 출고는 소요에서 제외합니다.",
    closing: "추정 마감재고",
    closingHint: "현재고에서 MES 변동 기록을 역산한 참고 추이입니다.",
    noTrend: "표시할 일별 재고 흐름이 없습니다.",
    orderEyebrow: "발주 우선순위",
    orderTitle: "발주 검토 우선순위",
    orderHint: "재고 커버를 리드타임과 검토 주기에 직접 비교해 부족 시점을 먼저 봅니다.",
    orderCaveat: "발주 권고는 약 95% 서비스 수준을 가정한 통계적 검토용 추정치입니다. MES 품질상태가 합격·양보합격인 수량만 가용재고로 반영하며, MOQ와 미입고 발주 잔량은 실제 발주 전에 별도 확인하세요.",
    noOrders: "현재 발주 검토 우선순위에 표시할 원재료가 없습니다.",
    unavailableOrders: "사용 이력이나 완료 영업일 데이터가 부족해 발주 권고를 산정할 수 없습니다.",
    excludedOrders: "산정 불가 원재료는 우선순위에서 제외했습니다.",
    notCalculated: "산정 불가",
    coverVsLead: "재고 커버 / 리드타임",
    leadMarker: "리드타임",
    reviewHorizon: "검토 한계",
    insufficient: "리드타임 부족",
    reviewZone: "검토 구간",
    sufficient: "여유",
    inventoryEyebrow: "원재료 상세",
    inventoryTitle: "원재료 재고 현황",
    inventoryHint: "같은 원료 코드는 한 행으로 합산합니다. 행을 누르면 배치·개별 수량·입고일을 확인할 수 있고, 열 제목으로 정렬할 수 있습니다.",
    change24h: "24시간 변화",
    comparisonEyebrow: "일일 재고 비교",
    comparisonTitle: "24시간 재고 변화",
    comparisonHint: "전일 08:00과 당일 08:00 저장 재고를 동일 원료·단위로 비교합니다.",
    comparisonWindow: "비교 구간",
    comparisonUnavailable: "08:00 재고가 이틀 연속 저장되면 24시간 비교를 표시합니다.",
    currentSnapshot: "당일 08:00",
    previousSnapshot: "전일 08:00",
    increase: "증가",
    decrease: "감소",
    noChange: "변화 없음",
    material: "원재료",
    specification: "규격",
    warehouse: "창고",
    avgDaily: "평균 일사용",
    cover: "재고 커버",
    reorderPoint: "재주문점",
    targetStock: "목표재고",
    risk: "위험",
    noMaterials: "선택한 조건에 맞는 원재료가 없습니다.",
    noUsageCover: "사용 이력 없음",
    rows: "건",
    stockDetails: "현재고 상세",
    stockDetailsHint: "MES 재고 명세 원본을 배치·위치별로 표시합니다.",
    stockDetailTotal: "상세 합계",
    openStockDetails: "재고 상세 펼치기",
    closeStockDetails: "재고 상세 접기",
    inboundDate: "입고일(입장일)",
    batchAndId: "배치 / 식별코드",
    qcStatus: "QC 상태",
    storageLocation: "보관 위치",
    inboundDocument: "입고 문서",
    supplierBatch: "공급자 배치",
    qrCode: "식별코드",
    qcAccepted: "합격",
    qcConcession: "양보 합격",
    qcPending: "검사 대기",
    qcRejected: "불합격",
    qcTemporary: "임시 제한",
    qcUnknown: "미분류",
    stockDetailsLoading: "재고 상세를 불러오는 중입니다.",
    stockDetailsError: "재고 상세를 불러오지 못했습니다.",
    stockDetailsRetry: "다시 시도",
    noStockDetails: "표시할 재고 상세가 없습니다.",
    stockDetailsTruncated: "전체 {total}건 중 첫 {shown}건을 표시합니다.",
    movementsEyebrow: "최근 재고 변동",
    movementsTitle: "최근 입출고 기록",
    movementsHint: "MES 재고 변동 기록을 최신 순서로 표시합니다.",
    occurredAt: "발생 일시",
    type: "구분",
    quantity: "변동 수량",
    batch: "배치",
    document: "문서 / 작업자",
    noMovements: "선택한 조건에 맞는 입출고 기록이 없습니다.",
    in: "입고",
    out: "출고(추정 소요)",
    receive: "이동 입고",
    issue: "이동 출고",
    amountAdjust: "수량 조정",
    attrAdjust: "속성 조정",
    unknownAction: "기타",
    riskEyebrow: "발주 위험",
    kpiCurrent: "현재고",
    kpiUsable: "가용재고",
    kpiChange: "24시간 증감",
    kpiConsumption: "30일 추정 소요",
    kpiRisk: "위험 원재료",
    kpiCurrentHint: "원재료창고 저장 재고",
    kpiUsableHint: "QC 가용 비율",
    kpiChangeHint: "전일 08:00 → 당일 08:00",
    kpiDailyAverage: "일평균",
    kpiRiskHint: "긴급·주의 합계",
    notCollected: "미수집",
    comparisonPending: "비교 대기",
    movementUnavailable: "MES 변동 기록이 수집되지 않아 소요 추이와 발주 권고를 표시하지 않습니다.",
    movementUnavailableShort: "MES 변동 기록 미수집",
    genericWarning: "일부 MES 데이터를 확인하지 못했습니다. 저장 시각과 동기화 상태를 확인해 주세요.",
    searchResults: "검색 결과",
  },
  zh: {
    eyebrow: "库存管理",
    title: "原材料管理",
    description: "基于每日 08:00 保存的 MES 库存，查看 24 小时变化与近期消耗趋势。",
    loading: "正在读取已保存的原材料库存报告。",
    fetchError: "无法读取已保存的原材料报告。请确认权限或同步状态。",
    partial: "部分 MES 数据读取失败，当前仅显示可确认范围。",
    selectionRequired: "请确认原材料仓库设置。",
    selectionHint: "系统无法自动确认原材料仓库，请检查 MES 原材料仓库 ID 设置。",
    filters: "查询条件",
    advancedFilters: "高级分析条件",
    warehouses: "原材料仓库",
    allWarehouses: "自动选择原材料候选仓库",
    period: "分析期间",
    days7: "最近 7 天",
    days14: "最近 14 天",
    days30: "最近 30 天",
    days60: "最近 60 天",
    days90: "最近 90 天",
    lead: "采购提前期",
    review: "复核周期",
    days: "天",
    unit: "数量单位",
    search: "搜索原材料",
    searchPlaceholder: "搜索编码、名称、规格",
    riskFilter: "库存风险",
    allRisks: "全部风险",
    refresh: "手动更新 MES",
    refreshing: "MES 更新中",
    syncStartFailed: "无法启动手动 MES 更新，请稍后重试。",
    syncFailed: "手动 MES 更新失败。",
    syncCooldown: "刚完成一次 MES 更新。为避免增加服务器负载，请稍后重试。",
    syncRunning: "正在单次采集 MES 数据并生成新报告，完成后页面会自动刷新。",
    syncComplete: "手动 MES 更新已完成，保存的报告已刷新。",
    syncQueued: "MES 更新已在运行，将继续查看其状态。",
    syncRequired: "尚无保存的 08:00 库存，请手动更新一次 MES 以生成首份报告。",
    manualHint: "仅在例外需要最新数值时使用；不会重复运行更新。",
    sourceLatest: "保存库存基准",
    changeLatest: "变动记录基准",
    scheduled: "每天 08:00 自动更新",
    scheduleLabel: "自动更新",
    statusToolbar: "原材料仓库数据状态",
    rawWarehouseName: "原材料仓库",
    fixedUnit: "基准单位",
    dataReference: "库存基准",
    storedMode: "保存报告",
    manualMode: "手动更新当前库存",
    generatedAt: "页面计算",
    noTimestamp: "无法确认",
    fresh: "最新",
    delayed: "确认更新",
    stale: "延迟",
    previous: "上一页",
    next: "下一页",
    current: "实物当前库存",
    usable: "订货可用库存",
    restricted: "QC 受限",
    unclassified: "QC 未分类",
    usableRate: "可用比例",
    inbound: "入库",
    outbound: "出库",
    consumption: "估算消耗（出库）",
    transferOut: "调拨出库",
    adjustment: "调整",
    recommended: "建议订货",
    materialCount: "原材料数",
    periodSuffix: "期间合计",
    healthEyebrow: "当前库存状态",
    healthTitle: "已保存当前库存健康度",
    healthHint: "按 QC 可用、受限和未分类状态拆分所选单位的实物库存。",
    qcComposition: "QC 状态构成",
    healthRisk: "订货风险分布",
    riskHint: "根据提前期和再订货点统计原材料数量。选择条形或项目可筛选明细。",
    critical: "紧急",
    warning: "注意",
    healthy: "正常",
    noUsage: "无消耗记录",
    unknown: "确认数据",
    noRisk: "暂无可分类的原材料。",
    flowEyebrow: "消耗与变动",
    flowTitle: "估算消耗与变动趋势",
    flowHint: "仅将生产出库（out）视为估算消耗，仓库调拨出库（issue）单独显示。",
    dailyMovement: "每日入库、估算消耗与调拨出库",
    dailyMovementHint: "三个指标使用相同的零起点数量轴，调拨出库不计入消耗。",
    closing: "估算期末库存",
    closingHint: "由当前库存和 MES 变动记录倒推的参考趋势。",
    noTrend: "暂无每日库存趋势。",
    orderEyebrow: "订货优先级",
    orderTitle: "订货评估优先级",
    orderHint: "将库存覆盖天数与采购提前期、复核周期直接比较，优先识别短缺时点。",
    orderCaveat: "建议订货量按约 95% 服务水平估算，仅将 MES 质量状态为合格或让步合格的数量计入可用库存。MOQ 和未入库采购订单余量需在实际订货前另行确认。",
    noOrders: "当前没有需要列入订货评估优先级的原材料。",
    unavailableOrders: "因消耗记录或已完成营业日数据不足，无法计算订货建议。",
    excludedOrders: "无法计算的原材料已从优先级中排除。",
    notCalculated: "无法计算",
    coverVsLead: "库存覆盖 / 提前期",
    leadMarker: "提前期",
    reviewHorizon: "复核上限",
    insufficient: "提前期不足",
    reviewZone: "复核区间",
    sufficient: "充足",
    inventoryEyebrow: "原材料明细",
    inventoryTitle: "原材料库存明细",
    inventoryHint: "相同物料编号合并为一行。点击行可查看批次、单笔数量和入厂日期，点击列标题可排序。",
    change24h: "24 小时变化",
    comparisonEyebrow: "每日库存对比",
    comparisonTitle: "24 小时库存变化",
    comparisonHint: "按相同原料与单位比较昨日 08:00 和今日 08:00 的保存库存。",
    comparisonWindow: "比较区间",
    comparisonUnavailable: "连续两天保存 08:00 库存后，将显示 24 小时对比。",
    currentSnapshot: "今日 08:00",
    previousSnapshot: "昨日 08:00",
    increase: "增加",
    decrease: "减少",
    noChange: "无变化",
    material: "原材料",
    specification: "规格",
    warehouse: "仓库",
    avgDaily: "日均消耗",
    cover: "库存覆盖",
    reorderPoint: "再订货点",
    targetStock: "目标库存",
    risk: "风险",
    noMaterials: "没有符合所选条件的原材料。",
    noUsageCover: "无消耗记录",
    rows: "条",
    stockDetails: "当前库存明细",
    stockDetailsHint: "按批次与库位显示 MES 库存明细原始记录。",
    stockDetailTotal: "明细合计",
    openStockDetails: "展开库存明细",
    closeStockDetails: "收起库存明细",
    inboundDate: "入库日（入厂日期）",
    batchAndId: "批次 / 标识码",
    qcStatus: "QC 状态",
    storageLocation: "库位",
    inboundDocument: "入库单",
    supplierBatch: "供应商批次",
    qrCode: "标识码",
    qcAccepted: "合格",
    qcConcession: "让步合格",
    qcPending: "待检",
    qcRejected: "不合格",
    qcTemporary: "暂控",
    qcUnknown: "未分类",
    stockDetailsLoading: "正在读取库存明细。",
    stockDetailsError: "无法读取库存明细。",
    stockDetailsRetry: "重试",
    noStockDetails: "没有可显示的库存明细。",
    stockDetailsTruncated: "共 {total} 条，当前显示前 {shown} 条。",
    movementsEyebrow: "最近库存变动",
    movementsTitle: "最近出入库记录",
    movementsHint: "按最新时间显示 MES 库存变动记录。",
    occurredAt: "发生时间",
    type: "类型",
    quantity: "变动数量",
    batch: "批次",
    document: "单据 / 操作人",
    noMovements: "没有符合所选条件的出入库记录。",
    in: "入库",
    out: "出库（估算消耗）",
    receive: "调拨入库",
    issue: "调拨出库",
    amountAdjust: "数量调整",
    attrAdjust: "属性调整",
    unknownAction: "其他",
    riskEyebrow: "订货风险",
    kpiCurrent: "当前库存",
    kpiUsable: "可用库存",
    kpiChange: "24 小时增减",
    kpiConsumption: "30 天估算消耗",
    kpiRisk: "风险原材料",
    kpiCurrentHint: "原材料仓库保存库存",
    kpiUsableHint: "QC 可用比例",
    kpiChangeHint: "昨日 08:00 → 今日 08:00",
    kpiDailyAverage: "日均",
    kpiRiskHint: "紧急与注意合计",
    notCollected: "未采集",
    comparisonPending: "等待对比",
    movementUnavailable: "尚未采集 MES 变动记录，因此不显示消耗趋势和订货建议。",
    movementUnavailableShort: "MES 变动记录未采集",
    genericWarning: "部分 MES 数据无法确认，请检查保存时间和同步状态。",
    searchResults: "搜索结果",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

type SortKey =
  | "material"
  | "current"
  | "change24h"
  | "usable"
  | "inbound"
  | "outbound"
  | "transferOut"
  | "consumption"
  | "average"
  | "cover"
  | "reorder"
  | "recommended"
  | "risk";
type SortState = { key: SortKey; direction: "asc" | "desc" };
type Copy = Record<string, string>;

const RAW_MATERIAL_UNIT = "kg";
const RAW_MATERIAL_LOOKBACK_DAYS = 30;
const RAW_MATERIAL_LEAD_TIME_DAYS = 14;
const RAW_MATERIAL_REVIEW_PERIOD_DAYS = 14;

type WarningGroup =
  | "stored_inventory"
  | "inventory"
  | "warehouse"
  | "warehouse_id"
  | "comparison"
  | "movement"
  | "unit_assumed"
  | "unit_excluded"
  | "pagination"
  | "quality"
  | "records"
  | "sync"
  | "generic";

function warningGroup(code: string): WarningGroup {
  const normalized = code.toLocaleLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (normalized === "stored_inventory_fallback") return "stored_inventory";
  if (normalized.includes("comparison") || normalized.includes("inventory_history") || normalized.includes("snapshot_pending")) return "comparison";
  if (normalized.includes("warehouse") && normalized.includes("id")) return "warehouse_id";
  if (normalized.includes("warehouse")) return "warehouse";
  if (normalized.includes("movement") || normalized.includes("change_log")) return "movement";
  if (normalized === "unit_assumed_kg") return "unit_assumed";
  if (normalized.includes("unit")) return "unit_excluded";
  if (normalized.includes("pagination") || normalized.includes("page_")) return "pagination";
  if (normalized.includes("quality") || normalized.includes("qc_")) return "quality";
  if (normalized.includes("skipped") || normalized.includes("invalid") || normalized.includes("unclassified") || normalized.includes("conflict") || normalized.includes("unattributed")) return "records";
  if (normalized.includes("sync") || normalized.includes("store_failed") || normalized.includes("save_failed")) return "sync";
  if (normalized.includes("inventory")) return "inventory";
  return "generic";
}

function warningParam(params: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  }
  return "";
}

function warningText(
  group: WarningGroup,
  detail: RawMaterialWarningDetail | null,
  language: AppLanguage,
  copy: Copy,
) {
  const params = detail?.params ?? {};
  const count = warningParam(params, "count", "record_count", "skipped_count", "excluded_count");
  const unit = warningParam(params, "unit", "units", "unit_code");
  const suffix = count ? (language === "ko" ? ` (${count}건)` : `（${count} 条）`) : "";
  if (language === "ko") {
    if (group === "stored_inventory") return "마지막으로 저장된 현재고를 표시합니다. 변동 이력은 MES 업데이트 후 제공됩니다.";
    if (group === "inventory") return "원재료창고 현재고를 확인하지 못해 마지막 정상 범위만 표시합니다.";
    if (group === "warehouse") return "MES에서 원재료창고를 확인하지 못했습니다. 창고 설정을 확인해 주세요.";
    if (group === "warehouse_id") return "원재료창고의 MES ID를 확인하지 못해 변동 이력이 일부 누락될 수 있습니다.";
    if (group === "comparison") return "08:00 현재고가 이틀 연속 저장되면 정확한 24시간 비교를 제공합니다.";
    if (group === "movement") return "원재료창고의 MES 변동 기록을 수집하지 못해 소요와 발주 분석을 표시하지 않습니다.";
    if (group === "unit_assumed") return `단위가 없는 원재료 기록에 원재료창고 기본 단위 kg를 적용했습니다${suffix}.`;
    if (group === "unit_excluded") return `kg가 아닌 재고${unit ? `(${unit})` : ""}는 합계와 분석에서 제외했습니다${suffix}.`;
    if (group === "pagination") return "MES 응답이 완전하지 않아 확인된 데이터만 표시합니다.";
    if (group === "quality") return `확인되지 않은 QC 상태의 수량은 발주 가용재고에서 제외했습니다${suffix}.`;
    if (group === "records") return `형식이 올바르지 않은 MES 기록은 분석에서 제외했습니다${suffix}.`;
    if (group === "sync") return "MES 업데이트가 완료되지 않아 마지막 정상 보고서를 표시합니다.";
    return copy.genericWarning;
  }
  if (group === "stored_inventory") return "当前显示最后一次保存的库存；变动记录将在 MES 更新后提供。";
  if (group === "inventory") return "无法确认原材料仓库当前库存，当前仅显示最后一次正常范围。";
  if (group === "warehouse") return "无法在 MES 中确认原材料仓库，请检查仓库设置。";
  if (group === "warehouse_id") return "无法确认原材料仓库的 MES ID，库存变动记录可能不完整。";
  if (group === "comparison") return "连续两天保存 08:00 库存后，才可进行准确的 24 小时比较。";
  if (group === "movement") return "未能采集原材料仓库的 MES 变动记录，因此不显示消耗和订货分析。";
  if (group === "unit_assumed") return `缺少单位的原材料记录已按原材料仓库默认单位 kg 处理${suffix}。`;
  if (group === "unit_excluded") return `非 kg 库存${unit ? `（${unit}）` : ""}已从合计和分析中排除${suffix}。`;
  if (group === "pagination") return "MES 响应不完整，当前仅显示已确认的数据。";
  if (group === "quality") return `无法确认 QC 状态的数量已从订货可用库存中排除${suffix}。`;
  if (group === "records") return `格式无效的 MES 记录已从分析中排除${suffix}。`;
  if (group === "sync") return "MES 更新未完成，当前显示最后一份正常报告。";
  return copy.genericWarning;
}

function legacyWarningGroup(message: string): WarningGroup {
  const normalized = message.toLocaleLowerCase();
  if (normalized.includes("last stored inventory") || normalized.includes("stored inventory snapshot")) return "stored_inventory";
  if (normalized.includes("warehouse") && normalized.includes("mes id")) return "warehouse_id";
  if (normalized.includes("warehouse")) return "warehouse";
  if (normalized.includes("24-hour comparison") || normalized.includes("08:00 inventory snapshot")) return "comparison";
  if (normalized.includes("movement") || normalized.includes("change log")) return "movement";
  if (normalized.includes("without a main unit") || normalized.includes("without main unit") || normalized.includes("kg was assumed")) return "unit_assumed";
  if (normalized.includes("unit")) return "unit_excluded";
  if (normalized.includes("pagination") || normalized.includes("declared total")) return "pagination";
  if (normalized.includes("quality status") || normalized.includes("qc")) return "quality";
  if (normalized.includes("skipped") || normalized.includes("unclassified") || normalized.includes("conflict")) return "records";
  if (normalized.includes("sync") || normalized.includes("could not be saved")) return "sync";
  if (normalized.includes("inventory")) return "inventory";
  return "generic";
}

function localizedWarnings(
  details: RawMaterialWarningDetail[],
  legacyWarnings: string[],
  language: AppLanguage,
  copy: Copy,
) {
  const messages: string[] = [];
  const groups = new Set<WarningGroup>();
  const add = (group: WarningGroup, message: string) => {
    if (groups.has(group) || messages.includes(message)) return;
    groups.add(group);
    messages.push(message);
  };

  details.forEach((detail) => {
    const group = warningGroup(detail.code);
    add(group, warningText(group, detail, language, copy));
  });
  legacyWarnings.forEach((message) => {
    const group = legacyWarningGroup(message);
    if (groups.has(group)) return;
    const hasKorean = /[가-힣]/.test(message);
    const hasChinese = /[\u3400-\u9fff]/.test(message);
    const localizedMessage = language === "ko" && hasKorean
      ? message
      : language === "zh" && hasChinese && !hasKorean
        ? message
        : warningText(group, null, language, copy);
    add(group, localizedMessage);
  });
  return messages;
}

function localizedExternalMessage(message: string, language: AppLanguage) {
  if (!message) return "";
  if (language === "ko" && /[가-힣]/.test(message)) return message;
  if (language === "zh" && /[\u3400-\u9fff]/.test(message) && !/[가-힣]/.test(message)) return message;
  return "";
}

const RISK_ORDER: RawMaterialRisk[] = ["critical", "warning", "healthy", "no_usage", "unknown"];
const RISK_COLORS: Record<RawMaterialRisk, string> = {
  critical: "#d9485f",
  warning: "#f0a21a",
  healthy: "#009c49",
  no_usage: "#7b8d9b",
  unknown: "#b7c3cc",
};

function quantity(value: number, language: AppLanguage) {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    maximumFractionDigits: 2,
  }).format(safe);
}

function percent(value: number, language: AppLanguage) {
  return new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);
}

function dateTime(value: string, language: AppLanguage, fallback: string) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function dateOnly(value: string, language: AppLanguage, fallback: string) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function stockQcInfo(detail: RawMaterialStockDetail, copy: Copy) {
  if (detail.qcStatusCode === 1) return { label: copy.qcAccepted, tone: "usable" };
  if (detail.qcStatusCode === 2) return { label: copy.qcConcession, tone: "usable" };
  if (detail.qcStatusCode === 3) return { label: copy.qcPending, tone: "pending" };
  if (detail.qcStatusCode === 4) return { label: copy.qcRejected, tone: "restricted" };
  if (detail.qcStatusCode === 5) return { label: copy.qcTemporary, tone: "restricted" };
  return { label: copy.qcUnknown, tone: "unknown" };
}

function RawMaterialStockDetailPanel({
  copy,
  detailId,
  language,
  row,
  snapshotVersion,
}: {
  copy: Copy;
  detailId: string;
  language: AppLanguage;
  row: RawMaterialRow;
  snapshotVersion: string;
}) {
  const detailsQuery = useQuery({
    queryKey: [
      "inventory",
      "raw-material-stock-details",
      row.groupKey,
      row.unit,
      snapshotVersion,
    ],
    queryFn: () => getRawMaterialStockDetails({
      groupKey: row.groupKey,
      unit: row.unit,
      page: 1,
      pageSize: 100,
    }),
    retry: 1,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const details = detailsQuery.data?.stockDetails ?? [];
  const totalQuantity = detailsQuery.data?.totalQuantity ?? row.currentQuantity;
  const truncatedMessage = copy.stockDetailsTruncated
    .replace("{total}", quantity(detailsQuery.data?.stockDetailCount ?? row.stockDetailCount, language))
    .replace("{shown}", quantity(details.length, language));

  return (
    <tr className="raw-inventory-detail-row">
      <td colSpan={11}>
        <div
          aria-label={`${row.materialName} ${copy.stockDetails}`}
          className="raw-stock-detail-panel"
          id={detailId}
          role="region"
        >
          <div className="raw-stock-detail-header">
            <div>
              <strong>{copy.stockDetails}</strong>
              <span>{copy.stockDetailsHint}</span>
            </div>
            <span>{copy.stockDetailTotal} <strong>{quantity(totalQuantity, language)} {row.unit}</strong></span>
          </div>
          {detailsQuery.isPending ? (
            <div aria-live="polite" className="raw-stock-detail-state" role="status">
              <RefreshCw aria-hidden="true" className="raw-spin" size={15} />
              <span>{copy.stockDetailsLoading}</span>
            </div>
          ) : detailsQuery.isError ? (
            <div className="raw-stock-detail-state raw-stock-detail-state--error" role="alert">
              <span>{copy.stockDetailsError}</span>
              <button
                className="button button--ghost"
                onClick={() => { void detailsQuery.refetch(); }}
                type="button"
              >
                {copy.stockDetailsRetry}
              </button>
            </div>
          ) : details.length ? (
            <>
              {detailsQuery.data && detailsQuery.data.totalPages > 1 ? (
                <p className="raw-stock-detail-truncated" role="status">{truncatedMessage}</p>
              ) : null}
              <div className="raw-stock-detail-table" role="table">
                <div className="raw-stock-detail-grid raw-stock-detail-grid--head" role="row">
                  <span role="columnheader">{copy.inboundDate}</span>
                  <span role="columnheader">{copy.batchAndId}</span>
                  <span role="columnheader">{copy.current}</span>
                  <span role="columnheader">{copy.qcStatus}</span>
                  <span role="columnheader">{copy.storageLocation}</span>
                  <span role="columnheader">{copy.inboundDocument}</span>
                </div>
                <div role="rowgroup">
                  {details.map((detail) => {
                    const qc = stockQcInfo(detail, copy);
                    const detailMeta = [
                      detail.supplierBatchNo ? `${copy.supplierBatch} ${detail.supplierBatchNo}` : "",
                      detail.qrCode ? `${copy.qrCode} ${detail.qrCode}` : "",
                    ].filter(Boolean).join(" · ");
                    return (
                      <div className="raw-stock-detail-grid" key={detail.inventoryId} role="row">
                        <span data-label={copy.inboundDate} role="cell" className={detail.inboundAt ? "" : "raw-stock-detail--missing"}>
                          {dateOnly(detail.inboundAt, language, copy.notCollected)}
                        </span>
                        <span data-label={copy.batchAndId} role="cell">
                          <strong>{detail.batchNo || "-"}</strong>
                          {detailMeta ? <small>{detailMeta}</small> : null}
                        </span>
                        <span data-label={copy.current} role="cell">
                          <strong>{quantity(detail.quantity, language)}</strong> <small>{row.unit}</small>
                        </span>
                        <span data-label={copy.qcStatus} role="cell">
                          <span className={`raw-stock-qc raw-stock-qc--${qc.tone}`}>{qc.label}</span>
                        </span>
                        <span data-label={copy.storageLocation} role="cell">{detail.storageLocation || copy.notCollected}</span>
                        <span data-label={copy.inboundDocument} role="cell">{detail.inboundOrderNumbers.join(", ") || copy.notCollected}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="raw-stock-detail-state" role="status">{copy.noStockDetails}</div>
          )}
        </div>
      </td>
    </tr>
  );
}

function freshness(value: string) {
  const timestamp = new Date(value).getTime();
  if (!value || Number.isNaN(timestamp)) return "unknown" as const;
  const elapsedHours = Math.max(0, Date.now() - timestamp) / 3_600_000;
  if (elapsedHours <= 24) return "fresh" as const;
  if (elapsedHours <= 36) return "delayed" as const;
  return "stale" as const;
}

function riskLabel(risk: RawMaterialRisk, copy: Copy) {
  if (risk === "critical") return copy.critical;
  if (risk === "warning") return copy.warning;
  if (risk === "healthy") return copy.healthy;
  if (risk === "no_usage") return copy.noUsage;
  return copy.unknown;
}

function effectiveRisk(row: RawMaterialRow, leadTimeDays: number, reviewPeriodDays: number): RawMaterialRisk {
  if (!row.recommendationAvailable) return "unknown";
  if (row.risk !== "unknown") return row.risk;
  if (row.averageDailyConsumption <= 0) return "no_usage";
  if (
    row.usableQuantity <= row.safetyStock
    || (row.daysOfCover !== null && row.daysOfCover <= leadTimeDays)
  ) return "critical";
  if (
    row.usableQuantity <= row.reorderPoint
    || (row.daysOfCover !== null && row.daysOfCover <= leadTimeDays + reviewPeriodDays)
  ) return "warning";
  return "healthy";
}

function actionInfo(row: RawMaterialTransaction, copy: Copy) {
  const action = row.transactionType.toLowerCase().replaceAll("-", "_");
  const explicitDirection = row.direction.toLowerCase();
  if (row.isTransferOut || action === "issue") return { label: row.actionLabel || copy.issue, direction: "out" };
  if (action === "amount_adjust") return { label: row.actionLabel || copy.amountAdjust, direction: "adjust" };
  if (action === "attr_adjust") return { label: row.actionLabel || copy.attrAdjust, direction: "adjust" };
  if (["in", "inbound"].includes(explicitDirection) || ["in", "inbound", "receive"].includes(action)) {
    return { label: row.actionLabel || (action === "receive" ? copy.receive : copy.in), direction: "in" };
  }
  if (["out", "outbound"].includes(explicitDirection) || ["out", "outbound", "issue"].includes(action)) {
    return { label: row.actionLabel || (action === "issue" ? copy.issue : copy.out), direction: "out" };
  }
  return { label: row.actionLabel || row.transactionType || copy.unknownAction, direction: "adjust" };
}

function quantityDirection(row: RawMaterialTransaction, fallback: string): "in" | "out" | "adjust" {
  const direction = row.direction.toLowerCase();
  if (["in", "inbound", "true", "1"].includes(direction)) return "in";
  if (["out", "outbound", "false", "0"].includes(direction)) return "out";
  return fallback === "in" || fallback === "out" ? fallback : "adjust";
}

function StockTrendCharts({
  points,
  unit,
  language,
  copy,
}: {
  points: RawMaterialTrendPoint[];
  unit: string;
  language: AppLanguage;
  copy: Copy;
}) {
  const rows = points.flatMap((point) => {
    const value = point.values.find((item) => item.unit === unit);
    return value ? [{ date: point.date, value }] : [];
  });
  if (!rows.length) return <div className="raw-empty">{copy.noTrend}</div>;

  const width = 920;
  const left = 58;
  const right = 18;
  const plotWidth = width - left - right;
  const x = (index: number) => left + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));

  const flowHeight = 250;
  const flowTop = 20;
  const flowBottom = 42;
  const flowPlotHeight = flowHeight - flowTop - flowBottom;
  const flowMax = Math.max(
    1,
    ...rows.flatMap(({ value }) => [Math.abs(value.inbound), Math.abs(value.consumption), Math.abs(value.transferOut)]),
  );
  const yFlow = (value: number) => flowTop + flowPlotHeight - (Math.max(0, value) / flowMax) * flowPlotHeight;
  const groupWidth = Math.max(6, Math.min(30, plotWidth / Math.max(rows.length, 1) * 0.68));
  const barWidth = Math.max(2, groupWidth / 3 - 1);

  const stockHeight = 174;
  const stockTop = 18;
  const stockBottom = 36;
  const stockPlotHeight = stockHeight - stockTop - stockBottom;
  const stockMax = Math.max(1, ...rows.map(({ value }) => Math.max(0, value.estimatedClosingStock)));
  const yStock = (value: number) => stockTop + stockPlotHeight - (Math.max(0, value) / stockMax) * stockPlotHeight;
  const stockLine = rows
    .map(({ value }, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${yStock(value.estimatedClosingStock).toFixed(1)}`)
    .join(" ");
  const stockArea = `${stockLine} L${x(rows.length - 1).toFixed(1)},${(stockTop + stockPlotHeight).toFixed(1)} L${x(0).toFixed(1)},${(stockTop + stockPlotHeight).toFixed(1)} Z`;

  return (
    <div className="raw-trend-charts">
      <section className="raw-plot" aria-labelledby="raw-daily-movement-title">
        <div className="raw-plot-header">
          <div>
            <h3 id="raw-daily-movement-title">{copy.dailyMovement}</h3>
            <p>{copy.dailyMovementHint}</p>
          </div>
          <strong>{unit}</strong>
        </div>
        <svg aria-label={`${copy.dailyMovement} (${unit})`} role="img" viewBox={`0 0 ${width} ${flowHeight}`}>
          <title>{copy.dailyMovement}</title>
          <desc>{copy.dailyMovementHint}</desc>
          {[0, 0.5, 1].map((ratio) => {
            const y = flowTop + flowPlotHeight * ratio;
            return (
              <g key={ratio}>
                <line className="raw-chart-grid" x1={left} x2={width - right} y1={y} y2={y} />
                <text className="raw-chart-axis" x={left - 8} y={y + 4} textAnchor="end">
                  {quantity(flowMax * (1 - ratio), language)}
                </text>
              </g>
            );
          })}
          {rows.map(({ date, value }, index) => {
            const center = x(index);
            const values = [
              { key: "in", amount: value.inbound, label: copy.inbound },
              { key: "use", amount: value.consumption, label: copy.consumption },
              { key: "transfer", amount: value.transferOut, label: copy.transferOut },
            ];
            return (
              <g key={`${date}-${index}`}>
                {values.map((item, itemIndex) => {
                  const y = yFlow(Math.abs(item.amount));
                  return (
                    <rect
                      className={`raw-chart-bar raw-chart-bar--${item.key}`}
                      height={flowTop + flowPlotHeight - y}
                      key={item.key}
                      width={barWidth}
                      x={center - groupWidth / 2 + itemIndex * (barWidth + 1)}
                      y={y}
                    >
                      <title>{`${date} ${item.label} ${quantity(Math.abs(item.amount), language)} ${unit}`}</title>
                    </rect>
                  );
                })}
                {index % labelEvery === 0 || index === rows.length - 1 ? (
                  <text className="raw-chart-axis" x={center} y={flowHeight - 14} textAnchor="middle">
                    {date.slice(5)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <div className="raw-chart-legend">
          <span><i className="raw-legend--in" />{copy.inbound}</span>
          <span><i className="raw-legend--use" />{copy.consumption}</span>
          <span><i className="raw-legend--transfer" />{copy.transferOut}</span>
        </div>
      </section>

      <section className="raw-plot" aria-labelledby="raw-closing-stock-title">
        <div className="raw-plot-header">
          <div>
            <h3 id="raw-closing-stock-title">{copy.closing}</h3>
            <p>{copy.closingHint}</p>
          </div>
          <strong>{unit}</strong>
        </div>
        <svg aria-label={`${copy.closing} (${unit})`} role="img" viewBox={`0 0 ${width} ${stockHeight}`}>
          <title>{copy.closing}</title>
          <desc>{copy.closingHint}</desc>
          {[0, 0.5, 1].map((ratio) => {
            const y = stockTop + stockPlotHeight * ratio;
            return (
              <g key={ratio}>
                <line className="raw-chart-grid" x1={left} x2={width - right} y1={y} y2={y} />
                <text className="raw-chart-axis" x={left - 8} y={y + 4} textAnchor="end">
                  {quantity(stockMax * (1 - ratio), language)}
                </text>
              </g>
            );
          })}
          <path className="raw-chart-area" d={stockArea} />
          <path className="raw-chart-line" d={stockLine} />
          {rows.map(({ date, value }, index) => (
            <g key={`${date}-stock`}>
              <circle className="raw-chart-dot" cx={x(index)} cy={yStock(value.estimatedClosingStock)} r="3">
                <title>{`${date} ${copy.closing} ${quantity(value.estimatedClosingStock, language)} ${unit}`}</title>
              </circle>
              {index % labelEvery === 0 || index === rows.length - 1 ? (
                <text className="raw-chart-axis" x={x(index)} y={stockHeight - 10} textAnchor="middle">
                  {date.slice(5)}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </section>
    </div>
  );
}

function DailyInventoryComparison({
  rows,
  unit,
  language,
  copy,
}: {
  rows: RawMaterialRow[];
  unit: string;
  language: AppLanguage;
  copy: Copy;
}) {
  const comparable = rows
    .filter((row) => row.previousQuantity !== null && row.comparisonCurrentQuantity !== null && row.quantityChange24h !== null)
    .sort((a, b) => Math.abs(b.quantityChange24h ?? 0) - Math.abs(a.quantityChange24h ?? 0))
    .slice(0, 8);
  if (!comparable.length) return <div className="raw-empty">{copy.comparisonUnavailable}</div>;

  const scale = Math.max(1, ...comparable.flatMap((row) => [row.comparisonCurrentQuantity ?? 0, row.previousQuantity ?? 0]));
  return (
    <div className="raw-daily-comparison-list">
      {comparable.map((row) => {
        const previous = row.previousQuantity ?? 0;
        const comparisonCurrent = row.comparisonCurrentQuantity ?? 0;
        const change = row.quantityChange24h ?? 0;
        const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
        const directionLabel = change > 0 ? copy.increase : change < 0 ? copy.decrease : copy.noChange;
        return (
          <article className="raw-daily-comparison-row" key={`${row.materialId}-${row.warehouseCode}-${row.unit}`}>
            <div className="raw-daily-comparison-material" title={`${row.materialName} · ${row.materialCode}`}>
              <strong>{row.materialName}</strong>
              <span>{row.materialCode}</span>
            </div>
            <div className="raw-daily-comparison-bars">
              <div>
                <span>{copy.previousSnapshot}</span>
                <i><b className="raw-comparison-bar--previous" style={{ width: `${previous > 0 ? Math.max(1, previous / scale * 100) : 0}%` }} /></i>
                <strong>{quantity(previous, language)}</strong>
              </div>
              <div>
                <span>{copy.currentSnapshot}</span>
                <i><b className="raw-comparison-bar--current" style={{ width: `${comparisonCurrent > 0 ? Math.max(1, comparisonCurrent / scale * 100) : 0}%` }} /></i>
                <strong>{quantity(comparisonCurrent, language)}</strong>
              </div>
            </div>
            <div className={`raw-daily-comparison-delta raw-daily-comparison-delta--${direction}`}>
              <span>{copy.change24h}</span>
              <strong>{change > 0 ? "+" : ""}{quantity(change, language)} {unit}</strong>
              <small>{directionLabel}</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function RiskStack({
  rows,
  lead,
  review,
  selected,
  onSelect,
  recommendationsAvailable,
  copy,
}: {
  rows: RawMaterialRow[];
  lead: number;
  review: number;
  selected: RawMaterialRisk | "all";
  onSelect: (risk: RawMaterialRisk | "all") => void;
  recommendationsAvailable: boolean;
  copy: Copy;
}) {
  const counts = RISK_ORDER.map((risk) => ({
    risk,
    count: rows.filter((row) => (
      recommendationsAvailable ? effectiveRisk(row, lead, review) : "unknown"
    ) === risk).length,
  }));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  const summary = counts.map((item) => `${riskLabel(item.risk, copy)} ${item.count}`).join(", ");

  return (
    <div className="raw-risk-visual">
      {total ? (
        <div aria-label={`${copy.healthRisk}: ${summary}`} className="raw-risk-stack" role="group">
          {counts.filter((item) => item.count > 0).map((item) => (
            <button
              aria-label={`${riskLabel(item.risk, copy)} ${item.count}`}
              aria-pressed={selected === item.risk}
              className={`raw-risk-segment raw-risk-segment--${item.risk}`}
              key={item.risk}
              onClick={() => onSelect(item.risk)}
              style={{ width: `${(item.count / total) * 100}%` }}
              title={`${riskLabel(item.risk, copy)} ${item.count}`}
              type="button"
            />
          ))}
        </div>
      ) : <div className="raw-empty">{copy.noRisk}</div>}
      <div className="raw-risk-list">
        <button aria-pressed={selected === "all"} className={selected === "all" ? "is-active" : ""} onClick={() => onSelect("all")} type="button">
          <span>{copy.allRisks}</span><strong>{total}</strong>
        </button>
        {counts.map((item) => (
          <button aria-pressed={selected === item.risk} className={selected === item.risk ? "is-active" : ""} key={item.risk} onClick={() => onSelect(item.risk)} type="button">
            <i style={{ backgroundColor: RISK_COLORS[item.risk] }} />
            <span>{riskLabel(item.risk, copy)}</span>
            <strong>{item.count}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function coverTone(row: RawMaterialRow, lead: number, review: number) {
  if (!row.recommendationAvailable || row.daysOfCover === null) return "unknown";
  if (row.daysOfCover <= lead) return "critical";
  if (row.daysOfCover <= lead + review) return "warning";
  return "healthy";
}

function coverStatus(row: RawMaterialRow, lead: number, review: number, copy: Copy) {
  const tone = coverTone(row, lead, review);
  if (tone === "critical") return copy.insufficient;
  if (tone === "warning") return copy.reviewZone;
  if (tone === "healthy") return copy.sufficient;
  return copy.notCalculated;
}

function isSyncActive(status: string) {
  return ["accepted", "queued", "pending", "starting", "started", "running", "in_progress"].includes(
    status.toLowerCase(),
  );
}

function isSyncComplete(status: string) {
  return ["complete", "completed", "success", "succeeded"].includes(status.toLowerCase());
}

function isSyncFailed(status: string) {
  return ["error", "failed", "failure"].includes(status.toLowerCase());
}

function isSyncCooldown(status: string) {
  return status.toLowerCase() === "cooldown";
}

export function RawMaterialManagementPage() {
  const [language] = useStoredLanguage();
  const copy = pageCopy[language];
  const queryClient = useQueryClient();
  const lookback = RAW_MATERIAL_LOOKBACK_DAYS;
  const lead = RAW_MATERIAL_LEAD_TIME_DAYS;
  const review = RAW_MATERIAL_REVIEW_PERIOD_DAYS;
  const unit = RAW_MATERIAL_UNIT;
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState<RawMaterialRisk | "all">("all");
  const [sort, setSort] = useState<SortState>({ key: "risk", direction: "asc" });
  const [pageIndex, setPageIndex] = useState(0);
  const [expandedStockRows, setExpandedStockRows] = useState<Set<string>>(
    () => new Set(),
  );
  const handledSyncRef = useRef("");

  const queryKey = ["inventory", "raw-material-overview", "raw-material-warehouse", lookback, lead, review] as const;
  const params = {
    lookbackDays: lookback,
    leadTimeDays: lead,
    reviewPeriodDays: review,
  };
  const overviewQuery = useQuery({ queryKey, queryFn: () => getRawMaterialOverview(params) });
  const syncQuery = useQuery({
    queryKey: ["inventory", "raw-material-sync"],
    queryFn: getRawMaterialSyncStatus,
    retry: false,
    refetchInterval: (query) => (isSyncActive(query.state.data?.status ?? "") ? 2_000 : false),
  });
  const refreshMutation = useMutation({
    mutationFn: startRawMaterialSync,
    onSuccess: (response) => queryClient.setQueryData(["inventory", "raw-material-sync"], response),
  });
  const syncStatus = syncQuery.data ?? refreshMutation.data;
  const syncRunning = Boolean(syncStatus && isSyncActive(syncStatus.status));
  const data: RawMaterialOverview | undefined = overviewQuery.data;
  const detailSnapshotVersion = data?.meta.snapshotSyncedAt
    || data?.meta.inventorySourceLatestAt
    || "current";
  useEffect(() => {
    if (!syncStatus || !isSyncComplete(syncStatus.status)) return;
    const completedKey = syncStatus.finishedAt || syncStatus.updatedAt;
    if (!completedKey || handledSyncRef.current === completedKey) return;
    handledSyncRef.current = completedKey;
    void queryClient.invalidateQueries({ queryKey: ["inventory", "raw-material-overview"] });
    void queryClient.invalidateQueries({ queryKey: ["inventory", "raw-material-stock-details"] });
  }, [queryClient, syncStatus]);
  const unitRows = useMemo(
    () => (data?.materials ?? []).filter((row) => row.unit === RAW_MATERIAL_UNIT),
    [data?.materials],
  );
  const movementAvailable = Boolean(data?.meta.movementAvailable);
  const recommendationsAvailable = Boolean(
    movementAvailable
    && data?.meta.recommendationsAvailable
    && unitRows.some((row) => row.recommendationAvailable),
  );
  const filteredRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const value = (row: RawMaterialRow, key: SortKey): string | number => {
      if (key === "material") return `${row.materialCode} ${row.materialName}`;
      if (key === "current") return row.currentQuantity;
      if (key === "change24h") return row.quantityChange24h ?? Number.MIN_SAFE_INTEGER;
      if (key === "usable") return row.usableQuantity;
      if (key === "inbound") return row.inboundQuantity;
      if (key === "outbound") return row.outboundQuantity;
      if (key === "transferOut") return row.transferOutQuantity;
      if (key === "consumption") return row.consumptionQuantity;
      if (key === "average") return row.averageDailyConsumption;
      if (key === "cover") return row.daysOfCover ?? Number.MAX_SAFE_INTEGER;
      if (key === "reorder") return row.reorderPoint;
      if (key === "recommended") return row.recommendationAvailable ? row.recommendedOrder : Number.MAX_SAFE_INTEGER;
      return RISK_ORDER.indexOf(recommendationsAvailable ? effectiveRisk(row, lead, review) : "unknown");
    };
    return unitRows
      .filter((row) => {
        const matchesTerm = !term || `${row.materialCode} ${row.materialName} ${row.specification}`.toLocaleLowerCase().includes(term);
        const rowRisk = recommendationsAvailable ? effectiveRisk(row, lead, review) : "unknown";
        return matchesTerm && (risk === "all" || rowRisk === risk);
      })
      .sort((a, b) => {
        if (
          sort.key === "recommended"
          && a.recommendationAvailable !== b.recommendationAvailable
        ) {
          return a.recommendationAvailable ? -1 : 1;
        }
        const av = value(a, sort.key);
        const bv = value(b, sort.key);
        const result = typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), language === "ko" ? "ko" : "zh");
        return (result || b.recommendedOrder - a.recommendedOrder) * (sort.direction === "asc" ? 1 : -1);
      });
  }, [unitRows, search, risk, sort, lead, review, language, recommendationsAvailable]);

  const transactions = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (data?.recentTransactions ?? []).filter((row) => (
      row.unit === RAW_MATERIAL_UNIT
      && (!term || `${row.materialCode} ${row.materialName} ${row.batchNo} ${row.documentNo}`.toLocaleLowerCase().includes(term))
    ));
  }, [data?.recentTransactions, search]);

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const pageRows = filteredRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  useEffect(() => { setPageIndex(0); }, [search, risk, sort]);
  useEffect(() => { setPageIndex((current) => Math.min(current, pageCount - 1)); }, [pageCount]);

  const toggleStockRow = (rowKey: string) => {
    setExpandedStockRows((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const summary = data?.summary.quantities.find((row) => row.unit === unit);
  const currentQuantity = summary?.current ?? 0;
  const previousCurrentQuantity = summary?.previousCurrent ?? null;
  const comparisonCurrentQuantity = summary?.comparisonCurrent ?? null;
  const currentChange24h = summary?.change24h ?? null;
  const usableQuantity = summary?.usable ?? 0;
  const restrictedQuantity = summary?.restricted ?? 0;
  const unclassifiedQuantity = summary?.unclassified ?? 0;
  const compositionBase = Math.max(1, currentQuantity, usableQuantity + restrictedQuantity + unclassifiedQuantity);
  const availabilityRate = currentQuantity > 0 ? Math.max(0, Math.min(100, (usableQuantity / currentQuantity) * 100)) : 0;
  const priorityRows = (recommendationsAvailable ? [...unitRows] : [])
    .filter((row) => row.recommendationAvailable && (
      row.recommendedOrder > 0 || ["critical", "warning"].includes(effectiveRisk(row, lead, review))
    ))
    .sort((a, b) => {
      const riskDelta = RISK_ORDER.indexOf(effectiveRisk(a, lead, review)) - RISK_ORDER.indexOf(effectiveRisk(b, lead, review));
      if (riskDelta) return riskDelta;
      return (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) - (b.daysOfCover ?? Number.MAX_SAFE_INTEGER)
        || b.recommendedOrder - a.recommendedOrder;
    })
    .slice(0, 8);
  const unavailableCount = recommendationsAvailable
    ? unitRows.filter((row) => !row.recommendationAvailable).length
    : unitRows.length;

  const toggleSort = (key: SortKey) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
  }));
  const sortable = (label: string, key: SortKey) => (
    <button className="raw-sort" onClick={() => toggleSort(key)} type="button">
      {label}
      {sort.key === key
        ? sort.direction === "asc"
          ? <ArrowUp aria-hidden="true" size={13} />
          : <ArrowDown aria-hidden="true" size={13} />
        : null}
    </button>
  );
  const sortDirection = (key: SortKey): "ascending" | "descending" | "none" => (
    sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
  );
  const isSelectionRequired = data?.status.toLowerCase() === "selection_required";
  const isPartial = Boolean(data && (data.meta.partial || data.status.toLowerCase() === "partial"));
  const warningMessages = localizedWarnings(
    data?.meta.warningDetails ?? [],
    data?.meta.warnings ?? [],
    language,
    copy,
  );
  const showWarnings = Boolean(warningMessages.length && !isPartial);
  const inventorySourceLatestAt = data?.meta.snapshotSyncedAt
    || data?.meta.inventorySourceLatestAt
    || data?.meta.sourceLatestAt
    || "";
  const sourceFreshness = freshness(inventorySourceLatestAt);
  const freshnessLabel = sourceFreshness === "fresh"
    ? copy.fresh
    : sourceFreshness === "delayed"
      ? copy.delayed
      : sourceFreshness === "stale"
        ? copy.stale
        : copy.noTimestamp;
  const comparisonAvailable = Boolean(
    data?.meta.comparisonAvailable
    && previousCurrentQuantity !== null
    && comparisonCurrentQuantity !== null
    && currentChange24h !== null,
  );
  const periodConsumption = summary?.consumption ?? 0;
  const averageDailyConsumption = lookback > 0 ? periodConsumption / lookback : 0;
  const criticalCount = recommendationsAvailable
    ? unitRows.filter((row) => effectiveRisk(row, lead, review) === "critical").length
    : 0;
  const warningCount = recommendationsAvailable
    ? unitRows.filter((row) => effectiveRisk(row, lead, review) === "warning").length
    : 0;
  const riskMaterialCount = criticalCount + warningCount;

  return (
    <section aria-busy={overviewQuery.isFetching || refreshMutation.isPending || syncRunning} className="page raw-material-page" data-testid="raw-material-page">
      <PageHeader eyebrow={copy.eyebrow} icon="inventory" title={copy.title} description={copy.description} />

      <section aria-label={copy.statusToolbar} className="panel raw-status-toolbar">
        <div className="raw-status-scope">
          <div className="raw-status-item raw-status-item--warehouse">
            <Warehouse aria-hidden="true" size={18} />
            <span><small>{copy.warehouse}</small><strong>{copy.rawWarehouseName}</strong></span>
          </div>
          <div className="raw-status-item">
            <Weight aria-hidden="true" size={18} />
            <span><small>{copy.fixedUnit}</small><strong>{RAW_MATERIAL_UNIT}</strong></span>
          </div>
          <div className="raw-status-item raw-status-item--schedule">
            <CalendarClock aria-hidden="true" size={18} />
            <span><small>{copy.scheduleLabel}</small><strong>{copy.scheduled}</strong></span>
          </div>
        </div>
        <div className="raw-status-actions">
          <div
            className="raw-status-item raw-status-item--reference"
            title={`${copy.changeLatest}: ${dateTime(data?.meta.changeLogSourceLatestAt ?? "", language, copy.noTimestamp)} · ${copy.generatedAt}: ${dateTime(data?.meta.generatedAt ?? "", language, copy.noTimestamp)}`}
          >
            <Clock3 aria-hidden="true" size={18} />
            <span>
              <small>{copy.dataReference} · {data?.meta.inventoryCaptureType === "manual" ? copy.manualMode : copy.storedMode}</small>
              <strong>{dateTime(inventorySourceLatestAt, language, copy.noTimestamp)}</strong>
            </span>
          </div>
          <span className={`raw-freshness-state raw-freshness-state--${sourceFreshness}`}>{freshnessLabel}</span>
          <button
            aria-label={copy.refresh}
            className="button button--ghost raw-refresh"
            data-testid="raw-material-refresh"
            disabled={refreshMutation.isPending || syncRunning || overviewQuery.isLoading}
            onClick={() => refreshMutation.mutate()}
            title={copy.manualHint}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={refreshMutation.isPending || syncRunning ? "is-spinning" : ""} size={17} />
            {refreshMutation.isPending || syncRunning ? copy.refreshing : copy.refresh}
          </button>
        </div>
      </section>

      {overviewQuery.isLoading && !data ? <LoadingBlock label={copy.loading} /> : null}
      {overviewQuery.isError && !data ? <div className="notice notice--warning" role="alert">{copy.fetchError}</div> : null}
      {overviewQuery.isError && data ? <div className="notice notice--warning" role="alert">{copy.fetchError}</div> : null}
      {refreshMutation.isError ? <div className="notice notice--warning" role="alert">{copy.syncStartFailed}</div> : null}
      {syncRunning ? <div className="notice notice--neutral" role="status">{copy.syncRunning}</div> : null}
      {refreshMutation.submittedAt > 0 && syncStatus && isSyncComplete(syncStatus.status) ? (
        <div className="notice notice--success" role="status">{copy.syncComplete}</div>
      ) : null}
      {refreshMutation.submittedAt > 0 && syncStatus && isSyncCooldown(syncStatus.status) ? (
        <div className="notice notice--warning" role="alert">{copy.syncCooldown}</div>
      ) : null}
      {refreshMutation.submittedAt > 0 && syncStatus && isSyncFailed(syncStatus.status) ? (
        <div className="notice notice--warning" role="alert">
          {copy.syncFailed}{localizedExternalMessage(syncStatus.message, language) ? ` ${localizedExternalMessage(syncStatus.message, language)}` : ""}
        </div>
      ) : null}
      {data?.meta.syncRequired ? <div className="notice notice--warning" role="alert">{copy.syncRequired}</div> : null}
      {isSelectionRequired ? (
        <div className="notice notice--warning raw-selection-notice" role="alert">
          <strong>{copy.selectionRequired}</strong><span>{copy.selectionHint}</span>
        </div>
      ) : null}
      {isPartial ? (
        <div className="notice notice--warning" role="alert">
          {copy.partial}
          {warningMessages.length ? <ul>{warningMessages.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
        </div>
      ) : null}
      {showWarnings ? (
        <div className="notice notice--neutral raw-data-notice" role="alert">
          <ul>{warningMessages.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      ) : null}

      {data && !isSelectionRequired ? (
        <>
          <div className="stats-grid raw-kpi-grid" aria-label={copy.statusToolbar}>
            <StatCard
              hint={copy.kpiCurrentHint}
              title={copy.kpiCurrent}
              value={`${quantity(currentQuantity, language)} ${unit}`}
            />
            <StatCard
              hint={`${copy.kpiUsableHint} ${percent(availabilityRate, language)}%`}
              hintTone={availabilityRate >= 90 ? "positive" : availabilityRate > 0 ? "neutral" : "negative"}
              title={copy.kpiUsable}
              value={`${quantity(usableQuantity, language)} ${unit}`}
            />
            <StatCard
              hint={copy.kpiChangeHint}
              hintTone={comparisonAvailable && currentChange24h !== null && currentChange24h < 0 ? "negative" : "neutral"}
              title={copy.kpiChange}
              value={comparisonAvailable && currentChange24h !== null
                ? `${currentChange24h > 0 ? "+" : ""}${quantity(currentChange24h, language)} ${unit}`
                : copy.comparisonPending}
            />
            <StatCard
              hint={movementAvailable
                ? `${copy.kpiDailyAverage} ${quantity(averageDailyConsumption, language)} ${unit}`
                : copy.movementUnavailableShort}
              title={copy.kpiConsumption}
              value={movementAvailable ? `${quantity(periodConsumption, language)} ${unit}` : copy.notCollected}
            />
            <StatCard
              hint={recommendationsAvailable
                ? `${copy.critical} ${criticalCount} · ${copy.warning} ${warningCount}`
                : copy.movementUnavailableShort}
              hintTone={riskMaterialCount > 0 ? "negative" : "neutral"}
              title={copy.kpiRisk}
              value={recommendationsAvailable ? `${riskMaterialCount} ${copy.rows}` : copy.notCollected}
            />
          </div>

          <div className="raw-health-grid">
            <section className="panel raw-health-panel">
              <div className="raw-panel-header">
                <div>
                  <p className="panel-card__eyebrow">{copy.healthEyebrow}</p>
                  <h2 className="panel__title">{copy.healthTitle}</h2>
                  <p className="raw-panel-hint">{copy.healthHint}</p>
                </div>
                <span className="raw-estimate-badge">{unit || "-"}</span>
              </div>
              <div className="raw-health-metrics">
                <article className="raw-health-primary">
                  <span>{copy.current}</span>
                  <strong>{quantity(currentQuantity, language)}</strong>
                  <small>{unit || "-"}</small>
                </article>
                <article>
                  <span>{copy.usable}</span>
                  <strong>{quantity(usableQuantity, language)}</strong>
                  <small>{copy.usableRate} {percent(availabilityRate, language)}%</small>
                </article>
                <article>
                  <span>{copy.restricted}</span>
                  <strong>{quantity(restrictedQuantity, language)}</strong>
                  <small>{unit || "-"}</small>
                </article>
                <article>
                  <span>{copy.unclassified}</span>
                  <strong>{quantity(unclassifiedQuantity, language)}</strong>
                  <small>{unit || "-"}</small>
                </article>
              </div>
              <div className="raw-quality-composition">
                <div className="raw-quality-heading"><span>{copy.qcComposition}</span><strong>{percent(availabilityRate, language)}% {copy.usable}</strong></div>
                <div aria-label={`${copy.qcComposition}: ${copy.usable} ${quantity(usableQuantity, language)}, ${copy.restricted} ${quantity(restrictedQuantity, language)}, ${copy.unclassified} ${quantity(unclassifiedQuantity, language)}`} className="raw-quality-bar" role="img">
                  <span className="raw-quality-bar--usable" style={{ width: `${Math.max(0, usableQuantity / compositionBase * 100)}%` }} title={`${copy.usable} ${quantity(usableQuantity, language)} ${unit}`} />
                  <span className="raw-quality-bar--restricted" style={{ width: `${Math.max(0, restrictedQuantity / compositionBase * 100)}%` }} title={`${copy.restricted} ${quantity(restrictedQuantity, language)} ${unit}`} />
                  <span className="raw-quality-bar--unknown" style={{ width: `${Math.max(0, unclassifiedQuantity / compositionBase * 100)}%` }} title={`${copy.unclassified} ${quantity(unclassifiedQuantity, language)} ${unit}`} />
                </div>
                <div className="raw-quality-legend">
                  <span><i className="raw-quality-dot--usable" />{copy.usable}</span>
                  <span><i className="raw-quality-dot--restricted" />{copy.restricted}</span>
                  <span><i className="raw-quality-dot--unknown" />{copy.unclassified}</span>
                </div>
              </div>
            </section>

            <section className="panel raw-risk-panel">
              <p className="panel-card__eyebrow">{copy.riskEyebrow}</p>
              <h2 className="panel__title">{copy.healthRisk}</h2>
              <p className="raw-panel-hint">{copy.riskHint}</p>
              <RiskStack
                copy={copy}
                lead={lead}
                onSelect={setRisk}
                recommendationsAvailable={recommendationsAvailable}
                review={review}
                rows={unitRows}
                selected={risk}
              />
            </section>
          </div>

          <section className="panel raw-trend-panel">
            <div className="raw-panel-header">
              <div>
                <p className="panel-card__eyebrow">{copy.flowEyebrow}</p>
                <h2 className="panel__title">{copy.flowTitle}</h2>
                <p className="raw-panel-hint">{copy.flowHint}</p>
              </div>
              {movementAvailable ? (
                <div className="raw-flow-totals" aria-label={`${lookback} ${copy.days} ${copy.periodSuffix}`}>
                  <span><i className="raw-flow-dot--in" />{copy.inbound}<strong>{quantity(summary?.inbound ?? 0, language)} {unit}</strong></span>
                  <span><i className="raw-flow-dot--use" />{copy.consumption}<strong>{quantity(summary?.consumption ?? 0, language)} {unit}</strong></span>
                  <span><i className="raw-flow-dot--transfer" />{copy.transferOut}<strong>{quantity(summary?.transferOut ?? 0, language)} {unit}</strong></span>
                  <span>{copy.adjustment}<strong>{quantity(summary?.adjustment ?? 0, language)} {unit}</strong></span>
                </div>
              ) : null}
            </div>
            {movementAvailable
              ? <StockTrendCharts copy={copy} language={language} points={data.trend} unit={unit} />
              : <div className="notice notice--neutral raw-movement-unavailable" role="status">{copy.movementUnavailable}</div>}
          </section>

          <section className={`panel raw-daily-comparison-panel${comparisonAvailable ? "" : " is-pending"}`}>
            <div className="raw-panel-header">
              <div>
                <p className="panel-card__eyebrow">{copy.comparisonEyebrow}</p>
                <h2 className="panel__title">{copy.comparisonTitle}</h2>
                <p className="raw-panel-hint">{copy.comparisonHint}</p>
              </div>
              {comparisonAvailable ? (
                <div className="raw-comparison-window">
                  <span>{copy.comparisonWindow}</span>
                  <strong>
                    {dateTime(data.meta.comparisonStartAt, language, copy.noTimestamp)}
                    <ArrowRight aria-hidden="true" size={14} />
                    {dateTime(data.meta.comparisonEndAt, language, copy.noTimestamp)}
                  </strong>
                </div>
              ) : null}
            </div>
            {comparisonAvailable && previousCurrentQuantity !== null && comparisonCurrentQuantity !== null && currentChange24h !== null ? (
              <>
                <div className="raw-comparison-summary">
                  <article><span>{copy.previousSnapshot}</span><strong>{quantity(previousCurrentQuantity, language)}</strong><small>{unit}</small></article>
                  <article><span>{copy.currentSnapshot}</span><strong>{quantity(comparisonCurrentQuantity, language)}</strong><small>{unit}</small></article>
                  <article className={currentChange24h > 0 ? "is-up" : currentChange24h < 0 ? "is-down" : "is-flat"}>
                    <span>{copy.change24h}</span>
                    <strong>{currentChange24h > 0 ? "+" : ""}{quantity(currentChange24h, language)}</strong>
                    <small>{currentChange24h > 0 ? copy.increase : currentChange24h < 0 ? copy.decrease : copy.noChange}</small>
                  </article>
                </div>
                <DailyInventoryComparison copy={copy} language={language} rows={unitRows} unit={unit} />
              </>
            ) : <div className="raw-comparison-pending" role="status">{copy.comparisonUnavailable}</div>}
          </section>

          {movementAvailable ? <section className="panel raw-order-panel">
            <div className="raw-panel-header">
              <div>
                <p className="panel-card__eyebrow">{copy.orderEyebrow}</p>
                <h2 className="panel__title">{copy.orderTitle}</h2>
                <p className="raw-panel-hint">{copy.orderHint}</p>
              </div>
              <div className="raw-order-axis-legend">
                <span><i className="raw-order-lead-marker" />{copy.leadMarker} {lead} {copy.days}</span>
                <span>{copy.reviewHorizon} {lead + review} {copy.days}</span>
              </div>
            </div>
            {!recommendationsAvailable ? (
              <div className="notice notice--neutral raw-recommendation-notice" role="status">
                {copy.unavailableOrders}
              </div>
            ) : null}
            {priorityRows.length ? (
              <ol className="raw-priority-list">
                {priorityRows.map((row, index) => {
                  const tone = coverTone(row, lead, review);
                  const horizon = Math.max(1, lead + review);
                  const coverWidth = Math.max(0, Math.min(100, ((row.daysOfCover ?? 0) / horizon) * 100));
                  const leadPosition = Math.max(0, Math.min(100, (lead / horizon) * 100));
                  return (
                    <li className="raw-priority-row" key={`${row.materialId}-${row.warehouseCode}-${index}`}>
                      <span className="raw-order-rank">{index + 1}</span>
                      <div className="raw-priority-material">
                        <strong>{row.materialName} · {row.materialCode}</strong>
                        <span>{row.specification || copy.rawWarehouseName}</span>
                      </div>
                      <div className="raw-priority-availability">
                        <span>{copy.usable}</span>
                        <strong>{quantity(row.usableQuantity, language)} {unit}</strong>
                      </div>
                      <div className="raw-cover-visual">
                        <div className="raw-cover-label">
                          <strong>{row.daysOfCover === null ? copy.notCalculated : `${quantity(row.daysOfCover, language)} ${copy.days}`}</strong>
                          <span className={`raw-cover-status raw-cover-status--${tone}`}>{coverStatus(row, lead, review, copy)}</span>
                        </div>
                        <div aria-label={`${copy.coverVsLead}: ${row.daysOfCover === null ? copy.notCalculated : `${quantity(row.daysOfCover, language)} ${copy.days}`}, ${copy.leadMarker} ${lead} ${copy.days}`} className="raw-cover-track" role="img">
                          <span className={`raw-cover-fill raw-cover-fill--${tone}`} style={{ width: `${coverWidth}%` }} />
                          <i className="raw-cover-lead" style={{ left: `${leadPosition}%` }} title={`${copy.leadMarker} ${lead} ${copy.days}`} />
                        </div>
                      </div>
                      <div className="raw-priority-order">
                        <span>{copy.recommended}</span>
                        <strong>{quantity(row.recommendedOrder, language)} {unit}</strong>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : recommendationsAvailable ? <div className="raw-empty">{copy.noOrders}</div> : null}
            {recommendationsAvailable && unavailableCount > 0 ? <p className="raw-excluded-note">{unavailableCount} {copy.rows} · {copy.excludedOrders}</p> : null}
            {recommendationsAvailable ? <aside className="raw-caveat"><strong>{copy.orderHint}</strong><p>{copy.orderCaveat}</p></aside> : null}
          </section> : null}

          <section className="panel raw-table-panel">
            <div className="raw-panel-header">
              <div>
                <p className="panel-card__eyebrow">{copy.inventoryEyebrow}</p>
                <h2 className="panel__title">{copy.inventoryTitle}</h2>
                <p className="raw-panel-hint">{copy.inventoryHint}</p>
              </div>
              <div className="raw-table-heading-actions">
                <label className="raw-material-search">
                  <Search aria-hidden="true" size={17} />
                  <input
                    aria-label={copy.search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={copy.searchPlaceholder}
                    type="search"
                    value={search}
                  />
                </label>
                <strong className="raw-row-count">{copy.searchResults} {filteredRows.length} {copy.rows}</strong>
              </div>
            </div>
            {filteredRows.length ? (
              <>
                <div className="raw-table-wrap">
                  <table className="raw-table raw-inventory-table">
                    <thead>
                      <tr>
                        <th aria-sort={sortDirection("material")}>{sortable(copy.material, "material")}</th>
                        <th aria-sort={sortDirection("risk")}>{sortable(copy.risk, "risk")}</th>
                        <th aria-sort={sortDirection("current")}>{sortable(copy.current, "current")}</th>
                        <th aria-sort={sortDirection("change24h")}>{sortable(copy.change24h, "change24h")}</th>
                        <th aria-sort={sortDirection("usable")}>{sortable(copy.usable, "usable")}</th>
                        <th aria-sort={sortDirection("inbound")}>{sortable(copy.inbound, "inbound")}</th>
                        <th aria-sort={sortDirection("consumption")}>{sortable(copy.consumption, "consumption")}</th>
                        <th aria-sort={sortDirection("transferOut")}>{sortable(copy.transferOut, "transferOut")}</th>
                        <th aria-sort={sortDirection("average")}>{sortable(copy.avgDaily, "average")}</th>
                        <th aria-sort={sortDirection("reorder")}>{sortable(copy.reorderPoint, "reorder")}</th>
                        <th aria-sort={sortDirection("recommended")}>{sortable(copy.recommended, "recommended")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row, index) => {
                        const rowRisk = recommendationsAvailable ? effectiveRisk(row, lead, review) : "unknown";
                        const rowRecommendationAvailable = recommendationsAvailable && row.recommendationAvailable;
                        const rowKey = `${row.groupKey}:${row.unit}`;
                        const hasStockDetails = row.stockDetailCount > 0;
                        const stockDetailsExpanded = hasStockDetails && expandedStockRows.has(rowKey);
                        const stockDetailId = `raw-stock-detail-${pageIndex}-${index}`;
                        return (
                          <Fragment key={rowKey}>
                            <tr
                              className={`raw-inventory-summary-row${hasStockDetails ? " raw-inventory-summary-row--expandable" : ""}${stockDetailsExpanded ? " is-expanded" : ""}`}
                              onClick={hasStockDetails ? () => toggleStockRow(rowKey) : undefined}
                            >
                              <td>
                                <button
                                  aria-controls={hasStockDetails ? stockDetailId : undefined}
                                  aria-expanded={hasStockDetails ? stockDetailsExpanded : undefined}
                                  aria-label={`${row.materialName} · ${stockDetailsExpanded ? copy.closeStockDetails : copy.openStockDetails}`}
                                  className="raw-material-toggle"
                                  disabled={!hasStockDetails}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (hasStockDetails) toggleStockRow(rowKey);
                                  }}
                                  type="button"
                                >
                                  <span className="raw-material-toggle__icon" aria-hidden="true">
                                    {stockDetailsExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                                  </span>
                                  <span className="raw-material-toggle__label">
                                    <strong>{row.materialName}</strong>
                                    <span>{row.materialCode} · {row.specification || "-"}</span>
                                  </span>
                                  <span className="raw-stock-detail-count">{row.stockDetailCount} {copy.rows}</span>
                                </button>
                              </td>
                              <td>
                                <span className={`raw-risk-chip raw-risk-chip--${rowRisk}`}>{riskLabel(rowRisk, copy)}</span>
                                <span>{rowRecommendationAvailable
                                  ? row.daysOfCover === null ? copy.noUsageCover : `${quantity(row.daysOfCover, language)} ${copy.days}`
                                  : copy.notCalculated}</span>
                              </td>
                              <td>{quantity(row.currentQuantity, language)} <small>{unit}</small></td>
                              <td className={row.quantityChange24h === null ? "" : row.quantityChange24h > 0 ? "raw-number--in" : row.quantityChange24h < 0 ? "raw-number--out" : ""}>
                                {row.quantityChange24h === null ? copy.notCalculated : `${row.quantityChange24h > 0 ? "+" : ""}${quantity(row.quantityChange24h, language)}`}
                              </td>
                              <td><strong>{quantity(row.usableQuantity, language)}</strong><span>{copy.restricted} {quantity(row.restrictedQuantity, language)} · {copy.unclassified} {quantity(row.unclassifiedQuantity, language)}</span></td>
                              <td className={movementAvailable ? "raw-number--in" : ""}>{movementAvailable ? `+${quantity(Math.abs(row.inboundQuantity), language)}` : copy.notCollected}</td>
                              <td>{movementAvailable ? quantity(row.consumptionQuantity, language) : copy.notCollected}</td>
                              <td className={movementAvailable ? "raw-number--out" : ""}>{movementAvailable ? quantity(row.transferOutQuantity, language) : copy.notCollected}</td>
                              <td>{movementAvailable ? quantity(row.averageDailyConsumption, language) : copy.notCollected}</td>
                              <td><strong>{rowRecommendationAvailable ? quantity(row.reorderPoint, language) : movementAvailable ? copy.notCalculated : copy.notCollected}</strong><span>{copy.targetStock} {rowRecommendationAvailable ? quantity(row.targetStock, language) : movementAvailable ? copy.notCalculated : copy.notCollected}</span></td>
                              <td><strong>{rowRecommendationAvailable ? quantity(row.recommendedOrder, language) : movementAvailable ? copy.notCalculated : copy.notCollected}</strong></td>
                            </tr>
                            {stockDetailsExpanded ? (
                              <RawMaterialStockDetailPanel
                                copy={copy}
                                detailId={stockDetailId}
                                language={language}
                                row={row}
                                snapshotVersion={detailSnapshotVersion}
                              />
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="raw-pagination">
                  <button className="button button--ghost" disabled={pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))} type="button">{copy.previous}</button>
                  <span>{pageIndex + 1} / {pageCount}</span>
                  <button className="button button--ghost" disabled={pageIndex + 1 >= pageCount} onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))} type="button">{copy.next}</button>
                </div>
              </>
            ) : <div className="raw-empty">{copy.noMaterials}</div>}
          </section>

          <section className="panel raw-table-panel">
            <div className="raw-panel-header">
              <div>
                <p className="panel-card__eyebrow">{copy.movementsEyebrow}</p>
                <h2 className="panel__title">{copy.movementsTitle}</h2>
                <p className="raw-panel-hint">{copy.movementsHint}</p>
              </div>
              {movementAvailable ? <strong className="raw-row-count">{transactions.length} {copy.rows}</strong> : null}
            </div>
            {!movementAvailable ? (
              <div className="notice notice--neutral raw-movement-unavailable" role="status">{copy.movementUnavailable}</div>
            ) : transactions.length ? (
              <div className="raw-table-wrap">
                <table className="raw-table raw-movement-table">
                  <thead><tr><th>{copy.occurredAt}</th><th>{copy.type}</th><th>{copy.material}</th><th>{copy.quantity}</th><th>{copy.batch}</th><th>{copy.document}</th></tr></thead>
                  <tbody>
                    {transactions.map((row, index) => {
                      const action = actionInfo(row, copy);
                      const movementDirection = quantityDirection(row, action.direction);
                      return (
                        <tr key={`${row.id}-${index}`}>
                          <td>{dateTime(row.occurredAt, language, "-")}</td>
                          <td><span className={`raw-action raw-action--${action.direction}`}>{action.label}</span></td>
                          <td><strong>{row.materialName} · {row.materialCode}</strong></td>
                          <td className={`raw-number--${action.direction}`}>{movementDirection === "in" ? "+" : movementDirection === "out" ? "−" : ""}{quantity(Math.abs(row.quantity), language)} <small>{unit}</small></td>
                          <td>{row.batchNo || "-"}</td>
                          <td><strong>{row.documentNo || "-"}</strong><span>{row.operatorName || ""}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="raw-empty">{copy.noMovements}</div>}
          </section>
        </>
      ) : null}
    </section>
  );
}
