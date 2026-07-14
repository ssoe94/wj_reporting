import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRawMaterialOverview,
  type RawMaterialOverview,
  type RawMaterialRisk,
  type RawMaterialRow,
  type RawMaterialTransaction,
  type RawMaterialTrendPoint,
} from "@/domains/inventory/api";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { PageHeader } from "@/shared/components/PageHeader";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";

const pageCopy = {
  ko: {
    eyebrow: "Inventory",
    title: "원재료 관리",
    description: "실물 재고와 QC 가용 상태, 사용 흐름, 발주 시점을 한 화면에서 검토합니다.",
    loading: "원재료 재고와 입출고 기록을 불러오는 중입니다.",
    fetchError: "원재료 데이터를 불러오지 못했습니다. 권한 또는 MES 연결 상태를 확인해주세요.",
    partial: "일부 MES 데이터를 불러오지 못해 현재 확인 가능한 범위만 표시합니다.",
    selectionRequired: "원재료창고를 선택해 주세요.",
    selectionHint: "MES 명세에는 원재료창고 code/id가 없어 자동으로 확정하지 않았습니다. 위 창고 목록에서 실제 원재료창고를 선택하면 현재고와 입출고를 계산합니다.",
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
    refresh: "MES 새로고침",
    refreshing: "동기화 중",
    sourceLatest: "현재고 명세 최신",
    changeLatest: "입출고 기록 최신",
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
    consumption: "사용량",
    adjustment: "조정",
    recommended: "권고 발주",
    materialCount: "원재료 수",
    periodSuffix: "기간 합계",
    healthEyebrow: "STOCK HEALTH",
    healthTitle: "현재 재고 건전성",
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
    flowEyebrow: "USAGE & MOVEMENT",
    flowTitle: "사용·입출고 추이",
    flowHint: "입고·출고·사용량은 같은 축과 같은 단위로 비교합니다. 추정 마감재고는 별도 축에 분리했습니다.",
    dailyMovement: "일별 입출고·사용량",
    dailyMovementHint: "세 값은 모두 0 기준의 동일한 수량 축을 사용합니다.",
    closing: "추정 마감재고",
    closingHint: "현재고에서 MES 변동 기록을 역산한 참고 추이입니다.",
    noTrend: "표시할 일별 재고 흐름이 없습니다.",
    orderEyebrow: "ORDER PRIORITY",
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
    inventoryEyebrow: "MATERIAL DETAIL",
    inventoryTitle: "원재료 재고 현황",
    inventoryHint: "한 단위 안에서 현재고, QC 가용 상태, 기간 사용량과 발주 기준을 비교합니다. 열 제목을 눌러 정렬할 수 있습니다.",
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
    movementsEyebrow: "RECENT MOVEMENT",
    movementsTitle: "최근 입출고 기록",
    movementsHint: "MES 재고 변동 기록을 최신 순서로 표시합니다.",
    occurredAt: "발생 일시",
    type: "구분",
    quantity: "변동 수량",
    batch: "배치",
    document: "문서 / 작업자",
    noMovements: "선택한 조건에 맞는 입출고 기록이 없습니다.",
    in: "입고",
    out: "출고",
    receive: "이동 입고",
    issue: "이동 출고",
    amountAdjust: "수량 조정",
    attrAdjust: "속성 조정",
    unknownAction: "기타",
  },
  zh: {
    eyebrow: "Inventory",
    title: "原材料管理",
    description: "在一个页面中评估实物库存、QC 可用状态、消耗趋势和订货时点。",
    loading: "正在读取原材料库存和出入库记录。",
    fetchError: "无法读取原材料数据。请确认权限或 MES 连接状态。",
    partial: "部分 MES 数据读取失败，当前仅显示可确认范围。",
    selectionRequired: "请选择原材料仓库。",
    selectionHint: "MES 规范未提供原材料仓库的 code/id，因此系统不会随意推测。请选择实际原材料仓库后再计算库存和出入库。",
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
    refresh: "刷新 MES",
    refreshing: "同步中",
    sourceLatest: "当前库存明细最新",
    changeLatest: "出入库记录最新",
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
    consumption: "消耗量",
    adjustment: "调整",
    recommended: "建议订货",
    materialCount: "原材料数",
    periodSuffix: "期间合计",
    healthEyebrow: "STOCK HEALTH",
    healthTitle: "当前库存健康度",
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
    flowEyebrow: "USAGE & MOVEMENT",
    flowTitle: "消耗与出入库趋势",
    flowHint: "入库、出库和消耗量使用同一单位与同一坐标轴；估算期末库存使用独立图表。",
    dailyMovement: "每日出入库与消耗量",
    dailyMovementHint: "三个指标均使用以 0 为起点的同一数量轴。",
    closing: "估算期末库存",
    closingHint: "由当前库存和 MES 变动记录倒推的参考趋势。",
    noTrend: "暂无每日库存趋势。",
    orderEyebrow: "ORDER PRIORITY",
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
    inventoryEyebrow: "MATERIAL DETAIL",
    inventoryTitle: "原材料库存明细",
    inventoryHint: "在同一单位内比较当前库存、QC 可用状态、期间消耗和订货基准。点击列标题可排序。",
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
    movementsEyebrow: "RECENT MOVEMENT",
    movementsTitle: "最近出入库记录",
    movementsHint: "按最新时间显示 MES 库存变动记录。",
    occurredAt: "发生时间",
    type: "类型",
    quantity: "变动数量",
    batch: "批次",
    document: "单据 / 操作人",
    noMovements: "没有符合所选条件的出入库记录。",
    in: "入库",
    out: "出库",
    receive: "调拨入库",
    issue: "调拨出库",
    amountAdjust: "数量调整",
    attrAdjust: "属性调整",
    unknownAction: "其他",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

type SortKey =
  | "material"
  | "warehouse"
  | "current"
  | "usable"
  | "inbound"
  | "outbound"
  | "consumption"
  | "average"
  | "cover"
  | "reorder"
  | "recommended"
  | "risk";
type SortState = { key: SortKey; direction: "asc" | "desc" };
type Copy = Record<string, string>;

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

function freshness(value: string) {
  const timestamp = new Date(value).getTime();
  if (!value || Number.isNaN(timestamp)) return "unknown" as const;
  const elapsedHours = Math.max(0, Date.now() - timestamp) / 3_600_000;
  if (elapsedHours <= 1) return "fresh" as const;
  if (elapsedHours <= 24) return "delayed" as const;
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
    ...rows.flatMap(({ value }) => [Math.abs(value.inbound), Math.abs(value.outbound), Math.abs(value.consumption)]),
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
              { key: "out", amount: value.outbound, label: copy.outbound },
              { key: "use", amount: value.consumption, label: copy.consumption },
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
          <span><i className="raw-legend--out" />{copy.outbound}</span>
          <span><i className="raw-legend--use" />{copy.consumption}</span>
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

export function RawMaterialManagementPage() {
  const [language] = useStoredLanguage();
  const copy = pageCopy[language];
  const queryClient = useQueryClient();
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [lookback, setLookback] = useState(30);
  const [lead, setLead] = useState(14);
  const [review, setReview] = useState(14);
  const [unit, setUnit] = useState("");
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState<RawMaterialRisk | "all">("all");
  const [sort, setSort] = useState<SortState>({ key: "risk", direction: "asc" });
  const [pageIndex, setPageIndex] = useState(0);

  const queryKey = ["inventory", "raw-material-overview", [...warehouses].sort().join(","), lookback, lead, review] as const;
  const params = {
    warehouseCodes: warehouses,
    lookbackDays: lookback,
    leadTimeDays: lead,
    reviewPeriodDays: review,
  };
  const overviewQuery = useQuery({ queryKey, queryFn: () => getRawMaterialOverview(params) });
  const refreshMutation = useMutation({
    mutationFn: () => getRawMaterialOverview({ ...params, refresh: true }),
    onSuccess: (response) => queryClient.setQueryData(queryKey, response),
  });
  const data: RawMaterialOverview | undefined = overviewQuery.data;
  useEffect(() => {
    if (data?.units.length && !data.units.includes(unit)) setUnit(data.units[0]);
  }, [data?.units, unit]);

  const unitRows = useMemo(
    () => (data?.materials ?? []).filter((row) => !unit || row.unit === unit),
    [data?.materials, unit],
  );
  const recommendationsAvailable = Boolean(
    data?.meta.recommendationsAvailable
    && unitRows.some((row) => row.recommendationAvailable),
  );
  const filteredRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const value = (row: RawMaterialRow, key: SortKey): string | number => {
      if (key === "material") return `${row.materialCode} ${row.materialName}`;
      if (key === "warehouse") return row.warehouseName;
      if (key === "current") return row.currentQuantity;
      if (key === "usable") return row.usableQuantity;
      if (key === "inbound") return row.inboundQuantity;
      if (key === "outbound") return row.outboundQuantity;
      if (key === "consumption") return row.consumptionQuantity;
      if (key === "average") return row.averageDailyConsumption;
      if (key === "cover") return row.daysOfCover ?? Number.MAX_SAFE_INTEGER;
      if (key === "reorder") return row.reorderPoint;
      if (key === "recommended") return row.recommendationAvailable ? row.recommendedOrder : Number.MAX_SAFE_INTEGER;
      return RISK_ORDER.indexOf(recommendationsAvailable ? effectiveRisk(row, lead, review) : "unknown");
    };
    return unitRows
      .filter((row) => {
        const matchesTerm = !term || `${row.materialCode} ${row.materialName} ${row.specification} ${row.warehouseName}`.toLocaleLowerCase().includes(term);
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
      (!unit || row.unit === unit)
      && (!term || `${row.materialCode} ${row.materialName} ${row.batchNo} ${row.documentNo}`.toLocaleLowerCase().includes(term))
    ));
  }, [data?.recentTransactions, unit, search]);

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const pageRows = filteredRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  useEffect(() => { setPageIndex(0); }, [unit, search, risk, sort, lookback, lead, review, warehouses]);
  useEffect(() => { setPageIndex((current) => Math.min(current, pageCount - 1)); }, [pageCount]);

  const summary = data?.summary.quantities.find((row) => row.unit === unit);
  const currentQuantity = summary?.current ?? 0;
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

  const toggleWarehouse = (code: string) => setWarehouses((current) => (
    current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
  ));
  const toggleSort = (key: SortKey) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
  }));
  const sortable = (label: string, key: SortKey) => (
    <button className="raw-sort" onClick={() => toggleSort(key)} type="button">
      {label}<span aria-hidden="true">{sort.key === key ? sort.direction === "asc" ? " ↑" : " ↓" : ""}</span>
    </button>
  );
  const sortDirection = (key: SortKey): "ascending" | "descending" | "none" => (
    sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
  );
  const autoSelectedNames = (data?.warehouseOptions ?? [])
    .filter((option) => data?.selectedWarehouses.includes(option.code))
    .map((option) => option.name);
  const autoWarehouseLabel = !warehouses.length && autoSelectedNames.length
    ? `${copy.allWarehouses}: ${autoSelectedNames.join(", ")}`
    : copy.allWarehouses;
  const isSelectionRequired = data?.status.toLowerCase() === "selection_required";
  const isPartial = Boolean(data && (data.meta.partial || data.status.toLowerCase() === "partial"));
  const showWarnings = Boolean(data?.meta.warnings.length && !isPartial);
  const inventorySourceLatestAt = data?.meta.inventorySourceLatestAt
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

  return (
    <section aria-busy={overviewQuery.isFetching || refreshMutation.isPending} className="page raw-material-page" data-testid="raw-material-page">
      <PageHeader eyebrow={copy.eyebrow} icon="inventory" title={copy.title} description={copy.description} />

      <section aria-label={copy.filters} className="panel raw-filter-panel">
        <div className="raw-filter-top">
          <div>
            <p className="panel-card__eyebrow">MES INVENTORY</p>
            <h2 className="panel__title">{copy.filters}</h2>
          </div>
          <div className="raw-freshness">
            <span>
              {copy.sourceLatest}
              <strong>{dateTime(inventorySourceLatestAt, language, copy.noTimestamp)}</strong>
            </span>
            <span className={`raw-freshness-state raw-freshness-state--${sourceFreshness}`}>{freshnessLabel}</span>
            <span>
              {copy.changeLatest}
              <strong>{dateTime(data?.meta.changeLogSourceLatestAt ?? "", language, copy.noTimestamp)}</strong>
            </span>
            <span>
              {copy.generatedAt}
              <strong>{dateTime(data?.meta.generatedAt ?? "", language, copy.noTimestamp)}</strong>
            </span>
            <button
              aria-label={copy.refresh}
              className="button button--primary raw-refresh"
              data-testid="raw-material-refresh"
              disabled={refreshMutation.isPending || overviewQuery.isLoading}
              onClick={() => refreshMutation.mutate()}
              type="button"
            >
              <span aria-hidden="true">↻</span>{refreshMutation.isPending ? copy.refreshing : copy.refresh}
            </button>
          </div>
        </div>
        <div className="raw-filter-grid raw-filter-grid--core">
          <fieldset className="raw-filter-field raw-filter-field--warehouse">
            <legend>{copy.warehouses}</legend>
            <div className="raw-chip-group">
              <button aria-pressed={!warehouses.length} className={!warehouses.length ? "is-active" : ""} onClick={() => setWarehouses([])} type="button">
                {autoWarehouseLabel}
              </button>
              {(data?.warehouseOptions ?? []).map((option) => {
                const isExplicit = warehouses.includes(option.code);
                const isAutomatic = !warehouses.length && data?.selectedWarehouses.includes(option.code);
                return (
                  <button
                    aria-pressed={isExplicit}
                    className={isExplicit ? "is-active" : isAutomatic ? "is-auto-selected" : ""}
                    key={option.code}
                    onClick={() => toggleWarehouse(option.code)}
                    title={option.code}
                    type="button"
                  >
                    {option.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="raw-filter-field">
            <span>{copy.unit}</span>
            <select disabled={!data?.units.length} onChange={(event) => setUnit(event.target.value)} value={unit}>
              {data?.units.length
                ? data.units.map((item) => <option key={item} value={item}>{item}</option>)
                : <option value="">-</option>}
            </select>
          </label>
          <label className="raw-filter-field raw-filter-field--search">
            <span>{copy.search}</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder={copy.searchPlaceholder} type="search" value={search} />
          </label>
        </div>
        <details className="raw-advanced-filters">
          <summary>
            <span>{copy.advancedFilters}</span>
            <strong>{copy.period} {lookback} {copy.days} · {copy.lead} {lead} {copy.days} · {copy.review} {review} {copy.days}</strong>
          </summary>
          <div className="raw-filter-grid raw-filter-grid--advanced">
            <label className="raw-filter-field">
              <span>{copy.period}</span>
              <select onChange={(event) => setLookback(Number(event.target.value))} value={lookback}>
                {([7, 14, 30, 60, 90] as const).map((days) => (
                  <option key={days} value={days}>{copy[`days${days}` as "days7" | "days14" | "days30" | "days60" | "days90"]}</option>
                ))}
              </select>
            </label>
            <label className="raw-filter-field">
              <span>{copy.lead}</span>
              <select onChange={(event) => setLead(Number(event.target.value))} value={lead}>
                {[3, 7, 14, 21, 30, 45, 60].map((days) => <option key={days} value={days}>{days} {copy.days}</option>)}
              </select>
            </label>
            <label className="raw-filter-field">
              <span>{copy.review}</span>
              <select onChange={(event) => setReview(Number(event.target.value))} value={review}>
                {[7, 14, 21, 30, 60].map((days) => <option key={days} value={days}>{days} {copy.days}</option>)}
              </select>
            </label>
            <label className="raw-filter-field">
              <span>{copy.riskFilter}</span>
              <select onChange={(event) => setRisk(event.target.value as RawMaterialRisk | "all")} value={risk}>
                <option value="all">{copy.allRisks}</option>
                {RISK_ORDER.map((item) => <option key={item} value={item}>{riskLabel(item, copy)}</option>)}
              </select>
            </label>
          </div>
        </details>
      </section>

      {overviewQuery.isLoading && !data ? <LoadingBlock label={copy.loading} /> : null}
      {overviewQuery.isError && !data ? <div className="notice notice--warning" role="alert">{copy.fetchError}</div> : null}
      {(overviewQuery.isError && data) || refreshMutation.isError ? <div className="notice notice--warning" role="alert">{copy.fetchError}</div> : null}
      {isSelectionRequired ? (
        <div className="notice notice--neutral raw-selection-notice" role="status">
          <strong>{copy.selectionRequired}</strong><span>{copy.selectionHint}</span>
        </div>
      ) : null}
      {isPartial ? (
        <div className="notice notice--warning" role="status">
          {copy.partial}
          {data?.meta.warnings.length ? <ul>{data.meta.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul> : null}
        </div>
      ) : null}
      {showWarnings ? (
        <div className="notice notice--neutral raw-data-notice" role="status">
          <ul>{data?.meta.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </div>
      ) : null}

      {data && !isSelectionRequired ? (
        <>
          <div className="raw-unit-heading">
            <div><span>{copy.unit}</span><strong>{unit || "-"}</strong></div>
            <p>{lookback} {copy.days} · {copy.periodSuffix}</p>
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
              <p className="panel-card__eyebrow">RISK MIX</p>
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
              <div className="raw-flow-totals" aria-label={`${lookback} ${copy.days} ${copy.periodSuffix}`}>
                <span><i className="raw-flow-dot--in" />{copy.inbound}<strong>{quantity(summary?.inbound ?? 0, language)}</strong></span>
                <span><i className="raw-flow-dot--out" />{copy.outbound}<strong>{quantity(summary?.outbound ?? 0, language)}</strong></span>
                <span><i className="raw-flow-dot--use" />{copy.consumption}<strong>{quantity(summary?.consumption ?? 0, language)}</strong></span>
                <span>{copy.adjustment}<strong>{quantity(summary?.adjustment ?? 0, language)}</strong></span>
              </div>
            </div>
            <StockTrendCharts copy={copy} language={language} points={data.trend} unit={unit} />
          </section>

          <section className="panel raw-order-panel">
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
              <div className="notice notice--neutral raw-recommendation-notice" role="status">{copy.unavailableOrders}</div>
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
                        <span>{row.warehouseName || "-"}</span>
                      </div>
                      <div className="raw-priority-availability">
                        <span>{copy.usable}</span>
                        <strong>{quantity(row.usableQuantity, language)} {row.unit}</strong>
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
                        <strong>{quantity(row.recommendedOrder, language)} {row.unit}</strong>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : <div className="raw-empty">{recommendationsAvailable ? copy.noOrders : copy.unavailableOrders}</div>}
            {unavailableCount > 0 ? <p className="raw-excluded-note">{unavailableCount} {copy.rows} · {copy.excludedOrders}</p> : null}
            <aside className="raw-caveat"><strong>ⓘ {copy.orderHint}</strong><p>{copy.orderCaveat}</p></aside>
          </section>

          <section className="panel raw-table-panel">
            <div className="raw-panel-header">
              <div>
                <p className="panel-card__eyebrow">{copy.inventoryEyebrow}</p>
                <h2 className="panel__title">{copy.inventoryTitle}</h2>
                <p className="raw-panel-hint">{copy.inventoryHint}</p>
              </div>
              <strong className="raw-row-count">{filteredRows.length} {copy.rows}</strong>
            </div>
            {filteredRows.length ? (
              <>
                <div className="raw-table-wrap">
                  <table className="raw-table raw-inventory-table">
                    <thead>
                      <tr>
                        <th aria-sort={sortDirection("material")}>{sortable(copy.material, "material")}</th>
                        <th aria-sort={sortDirection("warehouse")}>{sortable(copy.warehouse, "warehouse")}</th>
                        <th aria-sort={sortDirection("risk")}>{sortable(copy.risk, "risk")}</th>
                        <th aria-sort={sortDirection("current")}>{sortable(copy.current, "current")}</th>
                        <th aria-sort={sortDirection("usable")}>{sortable(copy.usable, "usable")}</th>
                        <th aria-sort={sortDirection("inbound")}>{sortable(copy.inbound, "inbound")}</th>
                        <th aria-sort={sortDirection("outbound")}>{sortable(copy.outbound, "outbound")}</th>
                        <th aria-sort={sortDirection("consumption")}>{sortable(copy.consumption, "consumption")}</th>
                        <th aria-sort={sortDirection("average")}>{sortable(copy.avgDaily, "average")}</th>
                        <th aria-sort={sortDirection("reorder")}>{sortable(copy.reorderPoint, "reorder")}</th>
                        <th aria-sort={sortDirection("recommended")}>{sortable(copy.recommended, "recommended")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row, index) => {
                        const rowRisk = recommendationsAvailable ? effectiveRisk(row, lead, review) : "unknown";
                        const rowRecommendationAvailable = recommendationsAvailable && row.recommendationAvailable;
                        return (
                          <tr key={`${row.materialId}-${row.warehouseCode}-${row.unit}-${index}`}>
                            <td><strong>{row.materialName}</strong><span>{row.materialCode} · {row.specification || "-"}</span></td>
                            <td><strong>{row.warehouseName || "-"}</strong><span>{row.warehouseCode}</span></td>
                            <td>
                              <span className={`raw-risk-chip raw-risk-chip--${rowRisk}`}>{riskLabel(rowRisk, copy)}</span>
                              <span>{rowRecommendationAvailable
                                ? row.daysOfCover === null ? copy.noUsageCover : `${quantity(row.daysOfCover, language)} ${copy.days}`
                                : copy.notCalculated}</span>
                            </td>
                            <td>{quantity(row.currentQuantity, language)} <small>{row.unit}</small></td>
                            <td><strong>{quantity(row.usableQuantity, language)}</strong><span>{copy.restricted} {quantity(row.restrictedQuantity, language)} · {copy.unclassified} {quantity(row.unclassifiedQuantity, language)}</span></td>
                            <td className="raw-number--in">+{quantity(Math.abs(row.inboundQuantity), language)}</td>
                            <td className="raw-number--out">−{quantity(Math.abs(row.outboundQuantity), language)}</td>
                            <td>{quantity(row.consumptionQuantity, language)}</td>
                            <td>{quantity(row.averageDailyConsumption, language)}</td>
                            <td><strong>{rowRecommendationAvailable ? quantity(row.reorderPoint, language) : copy.notCalculated}</strong><span>{copy.targetStock} {rowRecommendationAvailable ? quantity(row.targetStock, language) : copy.notCalculated}</span></td>
                            <td><strong>{rowRecommendationAvailable ? quantity(row.recommendedOrder, language) : copy.notCalculated}</strong></td>
                          </tr>
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
              <strong className="raw-row-count">{transactions.length} {copy.rows}</strong>
            </div>
            {transactions.length ? (
              <div className="raw-table-wrap">
                <table className="raw-table raw-movement-table">
                  <thead><tr><th>{copy.occurredAt}</th><th>{copy.type}</th><th>{copy.material}</th><th>{copy.warehouse}</th><th>{copy.quantity}</th><th>{copy.batch}</th><th>{copy.document}</th></tr></thead>
                  <tbody>
                    {transactions.map((row, index) => {
                      const action = actionInfo(row, copy);
                      const movementDirection = quantityDirection(row, action.direction);
                      return (
                        <tr key={`${row.id}-${index}`}>
                          <td>{dateTime(row.occurredAt, language, "-")}</td>
                          <td><span className={`raw-action raw-action--${action.direction}`}>{action.label}</span></td>
                          <td><strong>{row.materialName} · {row.materialCode}</strong></td>
                          <td>{row.warehouseName || row.warehouseCode || "-"}</td>
                          <td className={`raw-number--${action.direction}`}>{movementDirection === "in" ? "+" : movementDirection === "out" ? "−" : ""}{quantity(Math.abs(row.quantity), language)} <small>{row.unit}</small></td>
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
