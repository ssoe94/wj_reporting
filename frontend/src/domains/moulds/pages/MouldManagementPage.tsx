import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  BadgeCheck,
  Boxes,
  Clock3,
  Database,
  Expand,
  FileText,
  History,
  Info,
  ListFilter,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Minimize2,
  Move,
  RefreshCw,
  Search,
  Wrench,
  X,
} from "lucide-react";
import {
  getMouldBoard,
  getMouldDetail,
  confirmMouldUsageMilestone,
  type MouldBoard,
  type MouldDetail,
  type MouldLocation,
  type MouldRecord,
} from "@/domains/moulds/api";
import { useAuth } from "@/domains/auth/auth-context";
import { FALLBACK_MOULD_BOARD, getFallbackMouldDetail } from "@/domains/moulds/fallback";
import { useStoredLanguage } from "@/shared/i18n/language";
import styles from "./MouldManagementPage.module.css";

const USE_REMOTE_MOULD_API_IN_DEVELOPMENT = import.meta.env.VITE_USE_REMOTE_MOULD_API === "true";

const COPY = {
  ko: {
    eyebrow: "사출 금형 관리",
    title: "금형 실시간 현황판",
    description: "장착 설비와 A/B/C 보관 위치를 한 화면에서 확인합니다.",
    search: "금형 검색",
    searchPlaceholder: "금형 코드, 금형명, 모델, 위치 검색",
    filter: "상태 필터",
    finalChangedAt: "최종 변경 시각",
    refresh: "새로고침",
    loading: "금형 현황을 불러오는 중입니다.",
    loadError: "MES API를 불러오지 못했습니다. API 권한과 서버 연결 상태를 확인해주세요.",
    developmentFallback: "개발 환경에서는 검증용 예시 데이터를 표시합니다.",
    fallbackBadge: "예시 데이터",
    liveBadge: "MES 실데이터",
    fallbackNotice: "아래 수치는 화면 검증용 결정적 예시이며 실제 운영 수치가 아닙니다.",
    retry: "다시 시도",
    all: "전체",
    mounted: "장착",
    stored: "보관",
    repair: "수리",
    offsite: "외부",
    unknown: "미확인",
    machines: "사출기 장착 현황",
    machinesHint: "위치가 사출기로 등록된 금형만 장착으로 표시합니다.",
    machine: "설비",
    tonnage: "TON",
    currentMould: "장착 금형",
    status: "상태",
    changed: "최종 변경",
    unassigned: "금형 미지정",
    noTimestamp: "시각 미확인",
    storageInventory: "보관 인벤토리",
    storageHint: "A/B/C 좌표는 MES 위치 마스터를 기준으로 표시합니다.",
    coordinateGuide: "좌표 안내",
    focusZone: "존 확대",
    overviewMode: "전체 배치",
    touchHint: "존을 확대하면 터치 셀이 커집니다.",
    dragZoneHint: "드래그하여 이동",
    storedCount: "보관",
    emptyCell: "빈 위치",
    conflict: "중복 배치",
    noLayout: "표시할 A/B/C 보관 좌표가 없습니다.",
    noMoulds: "검색 또는 필터 조건에 맞는 금형이 없습니다.",
    statusListTitle: "금형 목록",
    statusListHint: "상태별 금형을 간단한 정보와 함께 확인합니다.",
    closeList: "금형 목록 닫기",
    listCount: "건",
    mouldCode: "금형 코드",
    mouldNameLabel: "금형명",
    selectMould: "금형 또는 위치 셀을 선택하면 상세 정보가 표시됩니다.",
    selectedMould: "선택 금형",
    currentLocation: "현재 위치",
    currentStatus: "현재 상태",
    lifetimeOutput: "생산 누적",
    outputBatch: "현재 형합수",
    model: "모델",
    cavity: "Cavity",
    assetCode: "자산 코드",
    drawingNo: "도면 번호",
    serialNo: "Serial No.",
    supplier: "공급사",
    classification: "분류",
    maintenanceStatus: "유지보수 상태",
    lifespanStatus: "수명 상태",
    movement: "이동 이력",
    detail: "상세 정보",
    production: "생산 이력",
    repairHistory: "수리 이력",
    occurredAt: "일시",
    from: "이전 위치",
    to: "변경 위치",
    content: "내용",
    operator: "작업자",
    firstRecord: "최초 기록",
    period: "기간",
    quantity: "생산량",
    cumulative: "누적",
    cumulativeBasis: "월 생산량을 연도 구분 없이 날짜순으로 합산한 누적값입니다.",
    requestedAt: "요청일",
    repairType: "유형",
    vendor: "처리 부서/업체",
    detailLoading: "금형 상세 정보를 불러오는 중입니다.",
    detailError: "상세 API를 불러오지 못해 현황 데이터만 표시합니다.",
    historyUnavailable: "이 이력은 현재 API에서 제공되지 않거나 기록이 없습니다.",
    dataBasis: "데이터 기준",
    warningTitle: "데이터 확인 사항",
    sourceTime: "조회 기준",
    autoRefresh: "1시간 자동 갱신",
    fullscreen: "전체 화면",
    exitFullscreen: "전체 화면 종료",
    backToBoards: "현황판 목록으로",
    closeDetail: "상세 닫기",
    openSelected: "선택 금형 상세 열기",
    recordUpdateQuality: "레코드 수정 시각",
    eventTimeQuality: "위치 변경 시각",
    timeUnknownQuality: "시각 근거 미확인",
    shots: "Shot",
    times: "회",
    lastUsed: "마지막 생산월",
    lastUsedUnknown: "사용일 미확인",
    unusedSixMonths: "6개월 이상 미사용",
    unusedTwelveMonths: "12개월 이상 미사용",
    usageCheckpoint: "형합수 점검",
    checkpointRequired: "금형부 확인 필요",
    checkpointConfirmed: "확인 완료",
    confirmCheckpoint: "점검 확인",
    confirmLogin: "로그인·사출 편집 권한 필요",
    confirmingCheckpoint: "확인 저장 중",
    confirmError: "확인 저장에 실패했습니다.",
    usageLegend: "형합수 10만 Shot 단위",
    inactivityLegend: "6/12개월 미사용",
  },
  zh: {
    eyebrow: "注塑模具管理",
    title: "模具实时看板",
    description: "在一个屏幕上查看安装设备及 A/B/C 存放位置。",
    search: "搜索模具",
    searchPlaceholder: "搜索模具编号、名称、型号或位置",
    filter: "状态筛选",
    finalChangedAt: "最后变更时间",
    refresh: "刷新",
    loading: "正在加载模具现状。",
    loadError: "MES API 暂不可用，请检查 API 权限和服务器连接。",
    developmentFallback: "开发环境当前显示验证用示例数据。",
    fallbackBadge: "示例数据",
    liveBadge: "MES 实际数据",
    fallbackNotice: "以下数值仅用于界面验证，并非实际运营数据。",
    retry: "重试",
    all: "全部",
    mounted: "已安装",
    stored: "存放",
    repair: "维修",
    offsite: "外部",
    unknown: "未确认",
    machines: "注塑机安装现状",
    machinesHint: "仅当前位置登记为注塑机的模具显示为已安装。",
    machine: "设备",
    tonnage: "TON",
    currentMould: "安装模具",
    status: "状态",
    changed: "最后变更",
    unassigned: "未指定模具",
    noTimestamp: "时间未确认",
    storageInventory: "存放位置",
    storageHint: "A/B/C 坐标基于 MES 位置主数据。",
    coordinateGuide: "坐标说明",
    focusZone: "放大区域",
    overviewMode: "全部布局",
    touchHint: "放大区域后可使用更大的触控单元格。",
    dragZoneHint: "拖动查看",
    storedCount: "存放",
    emptyCell: "空位置",
    conflict: "重复占用",
    noLayout: "没有可显示的 A/B/C 存放坐标。",
    noMoulds: "没有符合搜索或筛选条件的模具。",
    statusListTitle: "模具列表",
    statusListHint: "查看当前状态下的模具及主要信息。",
    closeList: "关闭模具列表",
    listCount: "条",
    mouldCode: "模具编号",
    mouldNameLabel: "模具名称",
    selectMould: "选择模具或位置单元格后显示详细信息。",
    selectedMould: "已选模具",
    currentLocation: "当前位置",
    currentStatus: "当前状态",
    lifetimeOutput: "累计产量",
    outputBatch: "当前合模次数",
    model: "型号",
    cavity: "模穴数",
    assetCode: "资产编号",
    drawingNo: "图纸编号",
    serialNo: "序列号",
    supplier: "供应商",
    classification: "分类",
    maintenanceStatus: "维保状态",
    lifespanStatus: "寿命状态",
    movement: "移动记录",
    detail: "详细信息",
    production: "生产记录",
    repairHistory: "维修记录",
    occurredAt: "时间",
    from: "原位置",
    to: "新位置",
    content: "内容",
    operator: "操作人",
    firstRecord: "首次记录",
    period: "期间",
    quantity: "产量",
    cumulative: "累计",
    cumulativeBasis: "累计值按月份顺序跨年度连续汇总，不在每年一月归零。",
    requestedAt: "申请日期",
    repairType: "类型",
    vendor: "部门/供应商",
    detailLoading: "正在加载模具详情。",
    detailError: "详情 API 暂不可用，仅显示现状数据。",
    historyUnavailable: "当前 API 未提供该记录或暂无记录。",
    dataBasis: "数据口径",
    warningTitle: "数据注意事项",
    sourceTime: "查询基准",
    autoRefresh: "1小时自动刷新",
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
    backToBoards: "返回看板中心",
    closeDetail: "关闭详情",
    openSelected: "打开所选模具详情",
    recordUpdateQuality: "记录更新时间",
    eventTimeQuality: "位置变更时间",
    timeUnknownQuality: "时间依据未确认",
    shots: "Shot",
    times: "次",
    lastUsed: "最后生产月",
    lastUsedUnknown: "使用时间未确认",
    unusedSixMonths: "超过6个月未使用",
    unusedTwelveMonths: "超过12个月未使用",
    usageCheckpoint: "合模次数点检",
    checkpointRequired: "模具部门待确认",
    checkpointConfirmed: "已确认",
    confirmCheckpoint: "确认点检",
    confirmLogin: "需要登录及注塑编辑权限",
    confirmingCheckpoint: "正在保存确认",
    confirmError: "保存确认失败。",
    usageLegend: "每10万 Shot",
    inactivityLegend: "6/12个月未使用",
  },
} as const;

type Copy = { [Key in keyof typeof COPY.ko]: string };
type ViewFilter = "all" | "machine" | "storage" | "repair" | "offsite" | "unknown";
type DetailTab = "movement" | "detail" | "production" | "repair";
type SelectedDetail = MouldDetail | MouldRecord;
type ZoneDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
};

type CoordinateCell = {
  location: MouldLocation;
  column: number;
};

type CoordinateRow = {
  key: string;
  label: string;
  cells: CoordinateCell[];
};

function milestoneLabel(milestone: number, language: "ko" | "zh"): string {
  const tenThousands = Math.floor(milestone / 10_000);
  return language === "ko" ? `${tenThousands}만` : `${tenThousands}万`;
}

function usageVisualClass(mould: MouldRecord): string {
  if (mould.inactivityTier === "twelve_months") return styles.inactiveTwelveMonths;
  if (mould.inactivityTier === "six_months") return styles.inactiveSixMonths;
  if (mould.confirmationRequired) return styles.usageReviewDue;
  if (mould.shotMilestoneLevel >= 4) return styles.usageLevelFour;
  if (mould.shotMilestoneLevel >= 3) return styles.usageLevelThree;
  if (mould.shotMilestoneLevel >= 2) return styles.usageLevelTwo;
  if (mould.shotMilestoneLevel >= 1) return styles.usageLevelOne;
  return "";
}

function inactivityLabel(mould: MouldRecord, copy: Copy): string {
  if (mould.inactivityTier === "twelve_months") return copy.unusedTwelveMonths;
  if (mould.inactivityTier === "six_months") return copy.unusedSixMonths;
  return "";
}

function inactivityShortLabel(mould: MouldRecord): string {
  if (mould.inactivityTier === "twelve_months") return "12M+";
  if (mould.inactivityTier === "six_months") return "6M+";
  return "";
}

type ZoneLayout = {
  code: string;
  label: string;
  rows: CoordinateRow[];
  columns: number;
};

const STORAGE_TOPOLOGY = {
  A: { rows: 6, columns: 6 },
  B: { rows: 4, columns: 6 },
  C: { rows: 9, columns: 18 },
} as const;

function text(value: string | null | undefined, fallback = "-") {
  return value?.trim() || fallback;
}

function isMouldDetail(value: SelectedDetail): value is MouldDetail {
  return "movements" in value && Array.isArray(value.movements);
}

function number(value: number | null | undefined, language: "ko" | "zh") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN").format(value);
}

function dateTime(value: string | null | undefined, language: "ko" | "zh", fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function finalChangedQualityLabel(value: string, copy: Copy) {
  return value ? copy.recordUpdateQuality : copy.timeUnknownQuality;
}

function localizedMachineText(value: string, language: "ko" | "zh") {
  return language === "zh" ? value.replace(/호기/g, "号机") : value.replace(/号机/g, "호기");
}

function machineDisplayLabel(machineNumber: number, tonnage: string, language: "ko" | "zh") {
  const suffix = language === "ko" ? "호기" : "号机";
  const normalizedTonnage = tonnage && !/t$/i.test(tonnage) ? `${tonnage}T` : tonnage;
  return `${machineNumber}${suffix}${normalizedTonnage ? ` - ${normalizedTonnage}` : ""}`;
}

function matchesFilter(mould: MouldRecord, filter: ViewFilter) {
  if (filter === "all") return true;
  if (filter === "repair") return ["repair", "maintenance"].includes(mould.summaryCategory);
  return mould.summaryCategory === filter;
}

function matchesSearch(mould: MouldRecord, search: string) {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return true;
  return [
    mould.mouldCode,
    mould.assetCode,
    mould.name,
    mould.model,
    mould.drawingNo,
    mould.location.code,
    mould.location.label,
    mould.location.machineNumber ? `${mould.location.machineNumber}호기` : "",
    mould.location.machineNumber ? `${mould.location.machineNumber}号机` : "",
  ].join(" ").toLocaleLowerCase().includes(term);
}

function coordinateParts(location: MouldLocation) {
  const code = location.code.toUpperCase();
  const match = code.match(/^([ABC])(\d+)?[-_](\d+)$/);
  if (!match) return null;
  return {
    zone: match[1] ?? "",
    row: Number(match[2] ?? 1),
    column: Number(match[3] ?? 1),
  };
}

function topologyLocation(zone: keyof typeof STORAGE_TOPOLOGY, row: number, column: number): MouldLocation {
  const code = `${zone}${row}-${column}`;
  return {
    id: `topology-${code}`,
    code,
    label: code,
    kind: "storage",
    machineNumber: null,
    parentCode: zone,
    parentLabel: `${zone}존`,
    zoneCode: zone,
    zoneLabel: `${zone}존`,
    level: 2,
    mouldCount: 0,
    conflict: false,
  };
}

function buildZoneLayouts(board: MouldBoard): ZoneLayout[] {
  const locations = new Map<string, MouldLocation>();
  (Object.entries(STORAGE_TOPOLOGY) as Array<[keyof typeof STORAGE_TOPOLOGY, { rows: number; columns: number }]>).forEach(([zone, topology]) => {
    for (let row = 1; row <= topology.rows; row += 1) {
      for (let column = 1; column <= topology.columns; column += 1) {
        const location = topologyLocation(zone, row, column);
        locations.set(location.code, location);
      }
    }
  });
  board.locations.forEach((location) => {
    if (coordinateParts(location)) locations.set(location.code, location);
  });
  board.moulds.forEach((mould) => {
    if (mould.location.kind === "storage" && coordinateParts(mould.location) && !locations.has(mould.location.code)) {
      locations.set(mould.location.code, mould.location);
    }
  });

  const locationFor = (zone: keyof typeof STORAGE_TOPOLOGY, rack: number, slot: number) => {
    const code = `${zone}${rack}-${slot}`;
    return locations.get(code) ?? topologyLocation(zone, rack, slot);
  };

  const ascending = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
  const descending = (count: number) => ascending(count).reverse();

  return [
    {
      code: "C",
      label: "C존",
      rows: descending(STORAGE_TOPOLOGY.C.columns).map((slot) => ({
        key: `C-slot-${slot}`,
        label: String(slot),
        cells: descending(STORAGE_TOPOLOGY.C.rows).map((rack, column) => ({
          location: locationFor("C", rack, slot),
          column,
        })),
      })),
      columns: STORAGE_TOPOLOGY.C.rows,
    },
    {
      code: "A",
      label: "A존",
      rows: ascending(STORAGE_TOPOLOGY.A.columns).map((slot) => ({
        key: `A-slot-${slot}`,
        label: String(slot),
        cells: ascending(STORAGE_TOPOLOGY.A.rows).map((rack, column) => ({
          location: locationFor("A", rack, slot),
          column,
        })),
      })),
      columns: STORAGE_TOPOLOGY.A.rows,
    },
    {
      code: "B",
      label: "B존",
      rows: ascending(STORAGE_TOPOLOGY.B.rows).map((rack) => ({
        key: `B-rack-${rack}`,
        label: `B${rack}`,
        cells: ascending(STORAGE_TOPOLOGY.B.columns).map((slot, column) => ({
          location: locationFor("B", rack, slot),
          column,
        })),
      })),
      columns: STORAGE_TOPOLOGY.B.columns,
    },
  ];
}

function emptyHistory(copy: Copy) {
  return (
    <div className={styles.emptyHistory} role="status">
      <Info aria-hidden="true" size={18} />
      <span>{copy.historyUnavailable}</span>
    </div>
  );
}

function DetailContent({ copy, detail, language, tab }: {
  copy: Copy;
  detail: SelectedDetail;
  language: "ko" | "zh";
  tab: DetailTab;
}) {
  const fullDetail = isMouldDetail(detail) ? detail : null;

  if (tab === "detail") {
    const fields = [
      [copy.assetCode, detail.assetCode],
      [copy.drawingNo, detail.drawingNo],
      [copy.model, detail.model],
      [copy.cavity, detail.cavityCount === null ? "-" : String(detail.cavityCount)],
      [copy.serialNo, detail.serialNo],
      [copy.supplier, detail.supplier],
      [copy.classification, detail.classification],
      [copy.maintenanceStatus, detail.maintenanceStatus],
      [copy.lifespanStatus, detail.lifespanStatus],
    ];
    return (
      <dl className={styles.detailGrid}>
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text(value)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (tab === "movement") {
    if (!fullDetail?.movements.length) return emptyHistory(copy);
    return (
      <div className={styles.tableScroller}>
        <table className={styles.historyTable}>
          <thead><tr><th>{copy.occurredAt}</th><th>{copy.from}</th><th>{copy.to}</th><th>{copy.content}</th></tr></thead>
          <tbody>{fullDetail.movements.map((item, index) => (
            <tr key={item.id}>
              <td>{dateTime(item.occurredAt, language, copy.noTimestamp)}</td>
              <td>{localizedMachineText(text(item.fromLocation, index === 0 ? copy.firstRecord : undefined), language)}</td>
              <td><strong>{localizedMachineText(text(item.toLocation), language)}</strong></td>
              <td>{text(item.reason)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
  }

  if (tab === "production") {
    if (!fullDetail?.productionHistory.length) return emptyHistory(copy);
    return (
      <>
        <p className={styles.historyBasis}>{copy.cumulativeBasis}</p>
        <div className={styles.tableScroller}>
          <table className={styles.historyTable}>
            <thead><tr><th>{copy.period}</th><th>{copy.quantity}</th><th>{copy.cumulative}</th><th>{copy.sourceTime}</th></tr></thead>
            <tbody>{fullDetail.productionHistory.map((item) => (
              <tr key={item.id}>
                <td><strong>{text(item.period)}</strong></td>
                <td>{number(item.quantity, language)} {text(item.unit, copy.shots)}</td>
                <td>{number(item.cumulativeQuantity, language)} {text(item.unit, copy.shots)}</td>
                <td>{dateTime(item.recordedAt, language, copy.noTimestamp)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>
    );
  }

  if (!fullDetail?.repairHistory.length) return emptyHistory(copy);
  return (
    <div className={styles.tableScroller}>
      <table className={styles.historyTable}>
        <thead><tr><th>{copy.requestedAt}</th><th>{copy.repairType}</th><th>{copy.content}</th><th>{copy.vendor}</th><th>{copy.cumulative}</th></tr></thead>
        <tbody>{fullDetail.repairHistory.map((item) => (
          <tr key={item.id}>
            <td>{dateTime(item.requestedAt, language, copy.noTimestamp)}</td>
            <td><strong>{text(item.type)}</strong></td>
            <td>{text(item.content)}</td>
            <td>{text(item.vendor)}</td>
            <td>{number(item.cumulativeOutputAmount, language)} {copy.shots}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function MouldManagementPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [language, setLanguage] = useStoredLanguage();
  const copy: Copy = COPY[language];
  const developmentFallback = import.meta.env.DEV && !USE_REMOTE_MOULD_API_IN_DEVELOPMENT;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ViewFilter>("all");
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("movement");
  const [detailOpen, setDetailOpen] = useState(false);
  const [statusListOpen, setStatusListOpen] = useState(false);
  const [focusedZone, setFocusedZone] = useState<string | null>(null);
  const [isZonePanning, setIsZonePanning] = useState(false);
  const zoneDragRef = useRef<ZoneDragState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [isMobileHeaderCompact, setIsMobileHeaderCompact] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detailOpen) setDetailOpen(false);
      else if (statusListOpen) setStatusListOpen(false);
      else if (focusedZone) setFocusedZone(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailOpen, focusedZone, statusListOpen]);

  const boardQuery = useQuery({
    queryKey: ["injection", "moulds", "board"],
    queryFn: getMouldBoard,
    enabled: !developmentFallback,
    retry: 1,
    refetchInterval: 3_600_000,
  });
  const usingFallback = developmentFallback;
  const board = usingFallback ? FALLBACK_MOULD_BOARD : boardQuery.data;

  useEffect(() => {
    if (!board?.moulds.length) return;
    if (selectedInstanceId && board.moulds.some((mould) => mould.instanceId === selectedInstanceId)) return;
    const preferred = board.moulds.find((mould) => mould.mouldCode === "MOLD-0674") ?? board.moulds[0];
    setSelectedInstanceId(preferred?.instanceId ?? "");
  }, [board, selectedInstanceId]);

  const detailQuery = useQuery({
    queryKey: ["injection", "moulds", "detail", selectedInstanceId],
    queryFn: () => getMouldDetail(selectedInstanceId),
    enabled: Boolean(selectedInstanceId) && !usingFallback,
    retry: 1,
  });

  const selectedRecord = board?.moulds.find((mould) => mould.instanceId === selectedInstanceId);
  const fallbackDetail = usingFallback ? getFallbackMouldDetail(selectedInstanceId) : undefined;
  const selectedDetail: SelectedDetail | undefined = fallbackDetail ?? detailQuery.data ?? selectedRecord;
  const selectedLifetimeProduction = selectedDetail && isMouldDetail(selectedDetail)
    ? selectedDetail.productionHistory.reduce<number | null>((maximum, item) => {
      if (item.cumulativeQuantity === null) return maximum;
      return maximum === null ? item.cumulativeQuantity : Math.max(maximum, item.cumulativeQuantity);
    }, null)
    : null;
  const canConfirmUsage = auth.hasCapability("injection.write");
  const confirmUsageMutation = useMutation({
    mutationFn: ({ instanceId, milestone }: { instanceId: string; milestone: number }) => (
      confirmMouldUsageMilestone(instanceId, milestone)
    ),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["injection", "moulds", "board"] }),
        queryClient.invalidateQueries({ queryKey: ["injection", "moulds", "detail", variables.instanceId] }),
      ]);
    },
  });

  const visibleMoulds = useMemo(() => (
    (board?.moulds ?? []).filter((mould) => matchesFilter(mould, filter) && matchesSearch(mould, search))
  ), [board?.moulds, filter, search]);
  const visibleIds = useMemo(() => new Set(visibleMoulds.map((mould) => mould.instanceId)), [visibleMoulds]);
  const listedMoulds = useMemo(() => (
    [...visibleMoulds].sort((a, b) => b.finalChangedAt.localeCompare(a.finalChangedAt))
  ), [visibleMoulds]);

  useEffect(() => {
    if (!selectedInstanceId || visibleIds.has(selectedInstanceId)) return;
    setDetailOpen(false);
  }, [selectedInstanceId, visibleIds]);

  const mouldsByLocation = useMemo(() => {
    const result = new Map<string, MouldRecord[]>();
    (board?.moulds ?? []).forEach((mould) => {
      const code = mould.location.code;
      if (!code) return;
      const rows = result.get(code) ?? [];
      rows.push(mould);
      result.set(code, rows);
    });
    return result;
  }, [board?.moulds]);
  const zones = useMemo(() => board ? buildZoneLayouts(board) : [], [board]);

  const filters: Array<{ key: ViewFilter; label: string; count: number }> = board ? [
    { key: "all", label: copy.all, count: board.summary.total },
    { key: "machine", label: copy.mounted, count: board.summary.mounted },
    { key: "storage", label: copy.stored, count: board.summary.stored },
    { key: "repair", label: copy.repair, count: board.summary.repair + board.summary.maintenance },
    { key: "offsite", label: copy.offsite, count: board.summary.offsite },
    { key: "unknown", label: copy.unknown, count: board.summary.unknown },
  ] : [];

  const finalChangedAt = board?.finalChangedAt;
  const displayedZones = focusedZone ? zones.filter((zone) => zone.code === focusedZone) : zones;
  const detailTabs: Array<{ key: DetailTab; label: string; icon: typeof History }> = [
    { key: "movement", label: copy.movement, icon: History },
    { key: "detail", label: copy.detail, icon: Info },
    { key: "production", label: copy.production, icon: BarChart3 },
    { key: "repair", label: copy.repairHistory, icon: Wrench },
  ];
  const activeFilter = filters.find((item) => item.key === filter);
  const detailContentState = !usingFallback && detailQuery.isLoading
    ? "loading"
    : !usingFallback && detailQuery.isError
      ? "error"
      : "ready";
  const displayLocation = (mould: SelectedDetail) => {
    if (mould.location.machineNumber) {
      const machine = board?.machines.find((item) => item.number === mould.location.machineNumber);
      return machineDisplayLabel(mould.location.machineNumber, machine?.tonnage ?? "", language);
    }
    return localizedMachineText(text(mould.location.label || mould.location.code, copy.unknown), language);
  };

  const selectMould = (instanceId: string) => {
    setSelectedInstanceId(instanceId);
    setStatusListOpen(false);
    setDetailOpen(true);
  };

  const selectFilter = (nextFilter: ViewFilter) => {
    setFilter(nextFilter);
    setStatusListOpen(nextFilter !== "all");
  };

  const startZonePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!focusedZone || event.button !== 0) return;
    zoneDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      moved: false,
    };
  };

  const moveZonePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = zoneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 5 && !drag.moved) {
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsZonePanning(true);
    }
    if (!drag.moved) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.scrollLeft - deltaX;
    event.currentTarget.scrollTop = drag.scrollTop - deltaY;
  };

  const endZonePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = zoneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsZonePanning(false);
    window.setTimeout(() => {
      if (zoneDragRef.current === drag) zoneDragRef.current = null;
    }, 0);
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  if (boardQuery.isLoading && !board) {
    return (
      <section className={styles.page} aria-busy="true">
        <div className={styles.loadingState}><RefreshCw aria-hidden="true" className={styles.spinning} size={22} />{copy.loading}</div>
      </section>
    );
  }

  if (boardQuery.isError && !board) {
    return (
      <section className={styles.page}>
        <div className={styles.errorState} role="alert">
          <AlertTriangle aria-hidden="true" size={24} />
          <strong>{copy.loadError}</strong>
          <button onClick={() => void boardQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={16} />{copy.retry}</button>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${styles.page} ${focusedZone ? styles.zoneFocusMode : ""}`}
      data-testid="mould-management-page"
      onScroll={(event) => {
        const shouldCompact = window.innerWidth <= 720 && event.currentTarget.scrollTop > 56;
        setIsMobileHeaderCompact((current) => current === shouldCompact ? current : shouldCompact);
      }}
    >
      <header className={`${styles.hero} ${isMobileHeaderCompact ? styles.compactHero : ""}`}>
        <div className={styles.titleGroup}>
          <span className={styles.titleLogo}><img alt="" src="/logo-transparent.png" /></span>
          <div>
            <p>{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <span>{copy.description}</span>
          </div>
        </div>
        <div className={styles.heroActions}>
          <label className={styles.searchField}>
            <Search aria-hidden="true" size={20} />
            <span className={styles.srOnly}>{copy.search}</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.searchPlaceholder} type="search" />
          </label>
          <div className={styles.freshness}>
            <Clock3 aria-hidden="true" size={18} />
            <span><small>{copy.finalChangedAt}</small><strong>{dateTime(finalChangedAt, language, copy.noTimestamp)}</strong></span>
          </div>
          <span className={styles.autoRefresh}>{copy.autoRefresh}</span>
          <div className={styles.languageSwitch} aria-label="Language">
            <button aria-pressed={language === "ko"} className={language === "ko" ? styles.languageActive : ""} onClick={() => setLanguage("ko")} type="button">KOR</button>
            <button aria-pressed={language === "zh"} className={language === "zh" ? styles.languageActive : ""} onClick={() => setLanguage("zh")} type="button">中文</button>
          </div>
          <button
            aria-label={copy.refresh}
            className={styles.topAction}
            disabled={developmentFallback || boardQuery.isFetching}
            onClick={() => void boardQuery.refetch()}
            title={copy.refresh}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={boardQuery.isFetching ? styles.spinning : ""} size={21} />
          </button>
          <button aria-label={isFullscreen ? copy.exitFullscreen : copy.fullscreen} className={styles.topAction} onClick={() => void toggleFullscreen()} title={isFullscreen ? copy.exitFullscreen : copy.fullscreen} type="button">
            {isFullscreen ? <Minimize2 aria-hidden="true" size={22} /> : <Maximize2 aria-hidden="true" size={22} />}
          </button>
        </div>
      </header>

      <div className={styles.filterStrip} aria-label={copy.filter}>
        <div className={styles.filterChips}>
          {filters.map((item) => (
            <button
              aria-pressed={filter === item.key}
              className={filter === item.key ? styles.activeChip : ""}
              key={item.key}
              onClick={() => selectFilter(item.key)}
              type="button"
            >
              {item.label}<strong>{item.count}</strong>
            </button>
          ))}
        </div>
        <div className={styles.boardStatus}>
          {selectedDetail && visibleIds.has(selectedDetail.instanceId) ? (
            <button className={styles.selectedPeek} onClick={() => setDetailOpen(true)} title={copy.openSelected} type="button">
              <small>{copy.selectedMould}</small><strong>{selectedDetail.mouldCode}</strong><span>{displayLocation(selectedDetail)}</span>
            </button>
          ) : null}
          <div className={styles.dataState}>
            <Database aria-hidden="true" size={17} />
            <span className={usingFallback ? styles.fallbackBadge : styles.liveBadge}>{usingFallback ? copy.fallbackBadge : copy.liveBadge}</span>
            {usingFallback ? <small>{copy.fallbackNotice}</small> : null}
          </div>
        </div>
      </div>

      {board ? (
        <div className={styles.boardGrid}>
          <section className={styles.machinePanel} aria-labelledby="mould-machine-title">
            <div className={styles.panelHeader}>
              <div><p>{copy.mounted}</p><h2 id="mould-machine-title">{copy.machines}</h2><span>{copy.machinesHint}</span></div>
              <strong>{board.summary.mounted}<small>{language === "ko" ? "대" : "台"}</small></strong>
            </div>
            <div className={styles.machineTable}>
              <div className={styles.machineTableHeader} aria-hidden="true">
                <span>{copy.machine}</span><span>{copy.currentMould}</span><span>{copy.status}</span><span>{copy.changed}</span>
              </div>
              <div className={styles.machineRows}>
                {board.machines.map((machine) => {
                  const mounted = board.moulds.find((mould) => mould.location.kind === "machine" && mould.location.machineNumber === machine.number);
                  const visible = mounted ? visibleIds.has(mounted.instanceId) : filter === "all" && !search.trim();
                  const selected = mounted?.instanceId === selectedInstanceId;
                  return (
                    <button
                      aria-label={mounted ? `${machineDisplayLabel(machine.number, machine.tonnage, language)}, ${mounted.mouldCode}` : `${machineDisplayLabel(machine.number, machine.tonnage, language)}, ${copy.unassigned}`}
                      aria-pressed={selected}
                      className={`${styles.machineRow} ${mounted ? usageVisualClass(mounted) : ""} ${selected ? styles.selectedMachine : ""} ${visible ? "" : styles.filteredOut}`}
                      disabled={!mounted}
                      key={machine.number}
                      onClick={() => mounted && selectMould(mounted.instanceId)}
                      type="button"
                    >
                      <strong>{machineDisplayLabel(machine.number, machine.tonnage, language)}</strong>
                      <span className={styles.machineMould}>{mounted ? <><strong>{mounted.mouldCode}</strong><small>{text(mounted.name)}</small>{mounted.shotMilestone > 0 ? <i className={`${styles.usageBadge} ${mounted.confirmationRequired ? styles.usageBadgeDue : ""}`}>{milestoneLabel(mounted.shotMilestone, language)}{mounted.confirmationRequired ? " !" : " ✓"}</i> : null}{inactivityLabel(mounted, copy) ? <i className={`${styles.inactivityBadge} ${mounted.inactivityTier === "twelve_months" ? styles.inactivityBadgeTwelve : ""}`}>{inactivityLabel(mounted, copy)}</i> : null}</> : <em>{copy.unassigned}</em>}</span>
                      <span>{mounted ? <i className={`${styles.statusPill} ${styles.mountedPill}`}>{copy.mounted}</i> : <i className={styles.statusPill}>{copy.unknown}</i>}</span>
                      <span className={styles.changedAt}>{mounted ? <strong title={finalChangedQualityLabel(mounted.finalChangedAt, copy)}>{dateTime(mounted.finalChangedAt, language, copy.noTimestamp)}</strong> : "-"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className={styles.storagePanel} aria-labelledby="mould-storage-title">
            <div className={styles.panelHeader}>
              <div><p>{copy.stored}</p><h2 id="mould-storage-title">{copy.storageInventory}</h2><span>{copy.touchHint}</span></div>
              <div className={styles.cellLegend}>
                <span className={styles.coordinateGuide}><MapIcon aria-hidden="true" size={18} />{copy.coordinateGuide}</span>
                <span><i className={styles.legendUsage} />{copy.usageLegend}</span>
                <span><i className={styles.legendInactiveSix} />{copy.unusedSixMonths}</span>
                <span><i className={styles.legendInactiveTwelve} />{copy.unusedTwelveMonths}</span>
              </div>
            </div>
            <div className={`${styles.zoneList} ${focusedZone ? styles.zoneListFocused : ""}`}>
              {displayedZones.length ? displayedZones.map((zone) => {
                const occupied = zone.rows.flatMap((row) => row.cells).filter(({ location }) => (mouldsByLocation.get(location.code)?.length ?? location.mouldCount) > 0).length;
                const zoneStyle = zone.code === "A" ? styles.zoneA : zone.code === "B" ? styles.zoneB : styles.zoneC;
                return (
                  <section className={`${styles.zone} ${zoneStyle} ${focusedZone ? styles.focusedZone : ""}`} key={zone.code}>
                    <header>
                      <h3>{zone.label}</h3>
                      <span>{copy.storedCount}<strong>{occupied}</strong></span>
                      {focusedZone ? <div className={styles.zonePanHint}><Move aria-hidden="true" size={16} />{copy.dragZoneHint}</div> : null}
                      <button aria-pressed={focusedZone === zone.code} className={styles.zoneFocusButton} onClick={() => setFocusedZone(focusedZone === zone.code ? null : zone.code)} type="button">
                        {focusedZone === zone.code ? <Minimize2 aria-hidden="true" size={18} /> : <Expand aria-hidden="true" size={18} />}
                        {focusedZone === zone.code ? copy.overviewMode : copy.focusZone}
                      </button>
                    </header>
                    <div
                      aria-label={focusedZone ? `${zone.label} · ${copy.dragZoneHint}` : undefined}
                      className={`${styles.coordinateRows} ${focusedZone ? styles.pannableZone : ""} ${isZonePanning ? styles.zonePanning : ""}`}
                      onPointerCancel={endZonePan}
                      onPointerDown={startZonePan}
                      onPointerMove={moveZonePan}
                      onPointerUp={endZonePan}
                      style={{ "--coordinate-columns": zone.columns, "--coordinate-rows": zone.rows.length } as CSSProperties}
                    >
                      {zone.rows.map((row) => (
                        <div className={styles.coordinateRow} key={row.key}>
                          <div className={styles.coordinateCells}>
                            {row.cells.map(({ location }) => {
                              const occupants = mouldsByLocation.get(location.code) ?? [];
                              const occupant = occupants[0];
                              const selected = occupant?.instanceId === selectedInstanceId;
                              const visible = occupant ? visibleIds.has(occupant.instanceId) : filter === "all" && !search.trim();
                              const conflict = location.conflict || occupants.length > 1;
                              return (
                                <button
                                  aria-label={occupant ? `${location.code}, ${occupant.mouldCode}${inactivityLabel(occupant, copy) ? `, ${inactivityLabel(occupant, copy)}` : ""}${conflict ? `, ${copy.conflict}` : ""}` : `${location.code}, ${copy.emptyCell}`}
                                  aria-pressed={selected}
                                  className={`${styles.coordinateCell} ${occupant ? styles.occupiedCell : ""} ${occupant ? usageVisualClass(occupant) : ""} ${selected ? styles.selectedCell : ""} ${conflict ? styles.conflictCell : ""} ${visible ? "" : styles.filteredOut}`}
                                  disabled={!occupant}
                                  key={location.code}
                                  onClick={() => {
                                    if (zoneDragRef.current?.moved) {
                                      zoneDragRef.current.moved = false;
                                      return;
                                    }
                                    if (occupant) selectMould(occupant.instanceId);
                                  }}
                                  title={occupant ? `${occupant.mouldCode} · ${occupant.name}${inactivityLabel(occupant, copy) ? ` · ${inactivityLabel(occupant, copy)}` : ""}` : copy.emptyCell}
                                  type="button"
                                >
                                  <span className={styles.coordinateCode}>{location.code}</span>
                                  {occupant?.shotMilestone ? <span className={`${styles.cellUsageBadge} ${occupant.confirmationRequired ? styles.cellUsageBadgeDue : ""}`}>{milestoneLabel(occupant.shotMilestone, language)}{occupant.confirmationRequired ? "!" : "✓"}</span> : null}
                                  {occupant && inactivityShortLabel(occupant) ? <span className={`${styles.cellInactivityBadge} ${occupant.inactivityTier === "twelve_months" ? styles.cellInactivityBadgeTwelve : ""}`}>{inactivityShortLabel(occupant)}</span> : null}
                                  {focusedZone && occupant ? (
                                    <span className={styles.coordinateDrawing}>
                                      {text(occupant.drawingNo, occupant.assetCode || occupant.mouldCode)}
                                      {occupants.length > 1 ? <small>+{occupants.length - 1}</small> : null}
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              }) : <div className={styles.emptyState}><MapPin aria-hidden="true" size={20} />{copy.noLayout}</div>}
            </div>
          </section>
        </div>
      ) : null}

      {board && !visibleMoulds.length ? <div className={styles.noResults} role="status"><Search aria-hidden="true" size={18} />{copy.noMoulds}</div> : null}

      {statusListOpen && activeFilter ? (
        <>
          <button aria-label={copy.closeList} className={styles.overlayBackdrop} onClick={() => setStatusListOpen(false)} type="button" />
          <section className={styles.statusListPanel} role="dialog" aria-labelledby="mould-status-list-title">
            <header className={styles.statusListHeader}>
              <div>
                <span><ListFilter aria-hidden="true" size={19} />{activeFilter.label}</span>
                <h2 id="mould-status-list-title">{copy.statusListTitle}</h2>
                <p>{copy.statusListHint}</p>
              </div>
              <strong>{number(listedMoulds.length, language)}<small>{copy.listCount}</small></strong>
              <button aria-label={copy.closeList} onClick={() => setStatusListOpen(false)} title={copy.closeList} type="button"><X aria-hidden="true" size={22} /></button>
            </header>
            <div className={styles.statusListBody}>
              {listedMoulds.length ? (
                <table className={styles.statusTable}>
                  <thead><tr><th>{copy.mouldCode}</th><th>{copy.mouldNameLabel}</th><th>{copy.drawingNo}</th><th>{copy.currentLocation}</th><th>{copy.finalChangedAt}</th><th>{copy.status}</th></tr></thead>
                  <tbody>{listedMoulds.map((mould) => (
                    <tr key={mould.instanceId} onClick={() => selectMould(mould.instanceId)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectMould(mould.instanceId); }}>
                      <td data-label={copy.mouldCode}><strong>{text(mould.mouldCode)}</strong><small>{text(mould.assetCode)}</small></td>
                      <td data-label={copy.mouldNameLabel}>{text(mould.name)}</td>
                      <td data-label={copy.drawingNo}>{text(mould.drawingNo)}</td>
                      <td data-label={copy.currentLocation}><span className={styles.locationPill}>{displayLocation(mould)}</span></td>
                      <td data-label={copy.finalChangedAt}>{dateTime(mould.finalChangedAt, language, copy.noTimestamp)}</td>
                      <td data-label={copy.status}>{text(mould.statusLabel, copy.unknown)}{inactivityLabel(mould, copy) ? <small className={styles.listInactivity}>{inactivityLabel(mould, copy)}</small> : null}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <div className={styles.emptyHistory}><Search aria-hidden="true" size={18} />{copy.noMoulds}</div>}
            </div>
          </section>
        </>
      ) : null}

      {detailOpen ? (
        <>
        <button aria-label={copy.closeDetail} className={`${styles.overlayBackdrop} ${styles.detailBackdrop}`} onClick={() => setDetailOpen(false)} type="button" />
        <aside className={styles.detailDrawer} role="dialog" aria-modal="true" aria-labelledby="selected-mould-title">
          <div className={styles.drawerTopbar}>
            <span><Boxes aria-hidden="true" size={20} />{copy.selectedMould}</span>
            <button aria-label={copy.closeDetail} onClick={() => setDetailOpen(false)} title={copy.closeDetail} type="button"><X aria-hidden="true" size={22} /></button>
          </div>
          <section className={styles.detailPanel}>
            {selectedDetail ? (
              <>
                <aside className={styles.selectedSummary}>
                  <div className={styles.summaryIdentity}>
                    <p>{copy.selectedMould}</p>
                    <h2 id="selected-mould-title">{selectedDetail.mouldCode}</h2>
                    <span className={styles.assetLine}>{text(selectedDetail.assetCode)}</span>
                    <strong className={styles.mouldName}>{text(selectedDetail.name)}</strong>
                  <div className={styles.summaryBadges}>
                      <span>{text(selectedDetail.statusLabel, copy.unknown)}</span>
                      <span>{text(selectedDetail.location.code, copy.unknown)}</span>
                      {selectedDetail.shotMilestone > 0 ? <span className={selectedDetail.confirmationRequired ? styles.summaryBadgeDue : styles.summaryBadgeConfirmed}><BadgeCheck aria-hidden="true" size={14} />{milestoneLabel(selectedDetail.shotMilestone, language)} · {selectedDetail.confirmationRequired ? copy.checkpointRequired : copy.checkpointConfirmed}</span> : null}
                    </div>
                  </div>
                  <dl className={styles.summaryFacts}>
                    <div><dt>{copy.currentLocation}</dt><dd>{displayLocation(selectedDetail)}</dd></div>
                    <div><dt>{copy.finalChangedAt}</dt><dd>{dateTime(selectedDetail.finalChangedAt, language, copy.noTimestamp)}<small>{finalChangedQualityLabel(selectedDetail.finalChangedAt, copy)}</small></dd></div>
                    <div><dt>{copy.lifetimeOutput}</dt><dd>{number(selectedLifetimeProduction, language)} {copy.shots}</dd></div>
                    <div><dt>{copy.outputBatch}</dt><dd>{number(selectedDetail.currentOutputAmount, language)} {copy.times}</dd></div>
                    <div><dt>{copy.lastUsed}</dt><dd>{selectedDetail.lastUsedAt ? dateTime(selectedDetail.lastUsedAt, language, copy.lastUsedUnknown) : copy.lastUsedUnknown}{selectedDetail.inactivityTier === "twelve_months" ? <small>{copy.unusedTwelveMonths}</small> : selectedDetail.inactivityTier === "six_months" ? <small>{copy.unusedSixMonths}</small> : null}</dd></div>
                  </dl>
                  {selectedDetail.pendingMilestone ? (
                    <div className={styles.usageConfirmation}>
                      <div><BadgeCheck aria-hidden="true" size={18} /><span><small>{copy.usageCheckpoint}</small><strong>{milestoneLabel(selectedDetail.pendingMilestone, language)} Shot · {copy.checkpointRequired}</strong></span></div>
                      <button
                        disabled={!canConfirmUsage || confirmUsageMutation.isPending}
                        onClick={() => confirmUsageMutation.mutate({ instanceId: selectedDetail.instanceId, milestone: selectedDetail.pendingMilestone ?? 0 })}
                        title={canConfirmUsage ? copy.confirmCheckpoint : copy.confirmLogin}
                        type="button"
                      >
                        {confirmUsageMutation.isPending ? copy.confirmingCheckpoint : copy.confirmCheckpoint}
                      </button>
                      {!canConfirmUsage ? <small>{copy.confirmLogin}</small> : null}
                      {confirmUsageMutation.isError ? <small className={styles.confirmationError}>{copy.confirmError}</small> : null}
                    </div>
                  ) : null}
                  {board && (board.warnings.length || board.calculationBasis.length) ? (
                    <details className={styles.dataBasis}>
                      <summary><Info aria-hidden="true" size={16} />{copy.dataBasis}</summary>
                      <div>
                        <p className={styles.sourceReference}><Clock3 aria-hidden="true" size={14} />{copy.sourceTime}: {dateTime(board.dataFreshness.sourceLatestAt || board.dataFreshness.fetchedAt, language, copy.noTimestamp)}</p>
                        {board.calculationBasis.length ? <ul>{board.calculationBasis.map((item) => <li key={item}>{item}</li>)}</ul> : null}
                        {board.warnings.length ? <section><strong>{copy.warningTitle}</strong><ul>{board.warnings.map((warning) => <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>)}</ul></section> : null}
                      </div>
                    </details>
                  ) : null}
                </aside>
                <div className={styles.detailBody}>
                  <div className={styles.detailTabs} role="tablist" aria-label={copy.selectedMould}>
                    {detailTabs.map((tab) => {
                      const Icon = tab.icon;
                      return (
                        <button aria-selected={detailTab === tab.key} className={detailTab === tab.key ? styles.activeTab : ""} key={tab.key} onClick={() => setDetailTab(tab.key)} role="tab" type="button">
                          <Icon aria-hidden="true" size={17} />{tab.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className={styles.detailContent} role="tabpanel">
                    {detailContentState === "loading" ? <div className={styles.inlineNotice}><RefreshCw aria-hidden="true" className={styles.spinning} size={16} />{copy.detailLoading}</div> : null}
                    {detailContentState === "error" ? <div className={`${styles.inlineNotice} ${styles.inlineWarning}`} role="alert"><AlertTriangle aria-hidden="true" size={16} />{copy.detailError}</div> : null}
                    {detailContentState === "ready" ? <DetailContent copy={copy} detail={selectedDetail} language={language} tab={detailTab} /> : null}
                  </div>
                </div>
              </>
            ) : <div className={styles.emptySelection}><FileText aria-hidden="true" size={22} />{copy.selectMould}</div>}
          </section>
        </aside>
        </>
      ) : null}
    </section>
  );
}
