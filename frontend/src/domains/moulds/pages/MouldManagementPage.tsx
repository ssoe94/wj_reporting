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
  LayoutGrid,
  ListFilter,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Minimize2,
  Move,
  RefreshCw,
  Search,
  Table2,
  Wrench,
  X,
} from "lucide-react";
import {
  getMouldBoard,
  getMouldDetail,
  getMouldMachineValidationRules,
  confirmMouldUsageMilestone,
  resetMouldMachineValidationRule,
  saveMouldMachineValidationRule,
  type MouldBoard,
  type MouldDetail,
  type MouldLocation,
  type MouldMachineValidationDecision,
  type MouldMachineValidationInput,
  type MouldMachineValidationRule,
  type MouldRecord,
} from "@/domains/moulds/api";
import { useAuth } from "@/domains/auth/auth-context";
import { FALLBACK_MOULD_BOARD, getFallbackMouldDetail } from "@/domains/moulds/fallback";
import {
  getProductionPlanDates,
  getProductionPlanSummary,
  getProductionStatus,
  type ProductionPlanRecord,
  type ProductionStatusMachine,
  type ProductionStatusPart,
} from "@/domains/production/api";
import { useStoredLanguage } from "@/shared/i18n/language";
import { getShanghaiBusinessDateString } from "@/shared/utils/date";
import injectionMachineGraphic from "@/assets/injection-machine-card.png";
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
    staleBadge: "MES 스냅샷 지연",
    fallbackNotice: "아래 수치는 화면 검증용 결정적 예시이며 실제 운영 수치가 아닙니다.",
    retry: "다시 시도",
    all: "전체",
    mounted: "장착",
    stored: "보관",
    repair: "수리",
    offsite: "외부",
    unknown: "미확인",
    machines: "사출기 장착 현황",
    machinesHint: "핵심 상태만 표시합니다. 행을 누르면 장착 금형과 생산 근거를 확인할 수 있습니다.",
    machineViewMode: "사출기 보기 방식",
    graphicMode: "그래픽",
    tableMode: "테이블",
    machine: "설비",
    tonnage: "TON",
    currentMould: "장착 금형",
    productionModel: "생산 중 모델",
    productionModelDate: "생산 기준",
    mouldModel: "금형 모델",
    modelMatch: "일치",
    modelReview: "동일 계열 · 판정 필요",
    modelMismatch: "불일치",
    modelUnknown: "판정 필요",
    modelConfirmedMatch: "현황판 판정 · 일치",
    modelConfirmedMismatch: "현황판 판정 · 불일치",
    modelPlanned: "다음 계획",
    modelRecent: "최근 생산 실적",
    modelStale: "최근 생산 오래됨",
    modelAmbiguous: "복수 생산",
    modelLoading: "조회 중",
    noProductionModel: "생산 데이터 없음",
    mouldNotMounted: "MES 시스템 확인 필요",
    machineConflict: "중복 장착",
    fieldConfirmed: "공용 판정 저장됨",
    verifyMould: "설비·금형 상세",
    verifyHint: "MES 장착 금형과 생산 모델을 대조하고 현황판 판정을 저장합니다.",
    installedMould: "MES 장착 금형",
    expectedModel: "생산 추정 모델",
    productionBasisActive: "형합수 기준 진행 중 추정",
    productionBasisRecent: "최근 생산 실적 기준",
    productionBasisPlanned: "생산계획만 있음",
    productionBasisAmbiguous: "동시에 진행 중인 생산이 여러 건",
    storageCandidate: "유사 금형 추천",
    recommendedLocation: "추천 위치",
    noStorageCandidate: "안전하게 추천할 수 있는 유사 금형을 찾지 못했습니다.",
    recommendation: "추천",
    matchedPrefix: "일치 기준",
    suggestionOnly: "추천 후보이며 MES 장착 정보는 자동으로 변경하지 않습니다.",
    modelMismatchNeedsMesFix: "금형과 생산 모델의 규격이 달라 불일치로 자동 판정했습니다.",
    cavityProduction: "다중 캐비티",
    partCount: "Part",
    paperworkRequired: "MES에서 사출기 장착 금형 정보를 확인해주세요.",
    confirmCorrectMould: "정확한 금형으로 확인",
    decideMatch: "일치로 판정",
    decideMismatch: "불일치로 판정",
    resetDecision: "자동 판정으로 되돌리기",
    savingDecision: "판정 저장 중",
    decisionError: "판정 결과를 저장하지 못했습니다.",
    decisionRuleNotice: "저장된 판정은 동일한 금형·생산 모델 조합에 자동 적용됩니다.",
    automaticDecision: "자동 판정",
    confirmedBy: "확인자",
    confirmedAt: "확인 시각",
    deviceConfirmationNotice: "판정 결과는 서버에 저장되며 MES 장착 정보 자체는 변경하지 않습니다.",
    noInstalledMouldDetail: "MES에 등록된 장착 금형 상세가 없습니다.",
    openMouldDetail: "금형 상세 보기",
    closeVerification: "금형 대조 닫기",
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
    occupiedCells: "사용 좌표",
    mouldRecords: "금형",
    dataIssues: "데이터 이슈",
    duplicateLocations: "중복 좌표",
    outsideLayout: "배치도 밖 위치",
    conflictCount: "중복",
    conflictListTitle: "중복 등록 점검",
    conflictListHint: "같은 위치에 등록된 금형을 확인하고 MES 위치 정보를 정리해주세요.",
    closeConflicts: "중복 등록 목록 닫기",
    conflictNeedsMesFix: "모델 판정보다 MES 위치 중복 정리가 먼저 필요합니다.",
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
    usageLegend: "10만 Shot 점검 알림",
    inactivityLegend: "6/12개월 미사용",
    shortMatch: "일치",
    shortReview: "판정필요",
    shortMismatch: "불일치",
    shortUnknown: "판정필요",
    shortConfirmedMatch: "판정일치",
    shortConfirmedMismatch: "판정불일치",
    shortPlanned: "계획 대기",
    shortRecent: "최근 실적",
    shortStale: "데이터 지연",
    shortAmbiguous: "복수생산",
    shortNoProduction: "생산 없음",
    shortMouldMissing: "MES확인",
    shortConflict: "중복등록",
    shortLoading: "조회 중",
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
    staleBadge: "MES 快照延迟",
    fallbackNotice: "以下数值仅用于界面验证，并非实际运营数据。",
    retry: "重试",
    all: "全部",
    mounted: "已安装",
    stored: "存放",
    repair: "维修",
    offsite: "外部",
    unknown: "未确认",
    machines: "注塑机安装现状",
    machinesHint: "仅显示关键状态。点击行可查看安装模具及生产判断依据。",
    machineViewMode: "注塑机查看方式",
    graphicMode: "图形",
    tableMode: "表格",
    machine: "设备",
    tonnage: "TON",
    currentMould: "安装模具",
    productionModel: "在产型号",
    productionModelDate: "生产基准",
    mouldModel: "模具型号",
    modelMatch: "一致",
    modelReview: "同系列 · 待判定",
    modelMismatch: "不一致",
    modelUnknown: "待判定",
    modelConfirmedMatch: "看板判定 · 一致",
    modelConfirmedMismatch: "看板判定 · 不一致",
    modelPlanned: "下一计划",
    modelRecent: "最近生产实绩",
    modelStale: "最近生产过旧",
    modelAmbiguous: "多项生产",
    modelLoading: "查询中",
    noProductionModel: "无生产数据",
    mouldNotMounted: "需在 MES 系统确认",
    machineConflict: "重复安装",
    fieldConfirmed: "共享判定已保存",
    verifyMould: "设备·模具详情",
    verifyHint: "核对 MES 安装模具与生产型号，并保存看板判定。",
    installedMould: "MES 安装模具",
    expectedModel: "推算生产型号",
    productionBasisActive: "按合模次数推算进行中",
    productionBasisRecent: "按最近生产实绩",
    productionBasisPlanned: "仅有生产计划",
    productionBasisAmbiguous: "同时存在多项进行中生产",
    storageCandidate: "相似模具推荐",
    recommendedLocation: "推荐位置",
    noStorageCandidate: "未找到可安全推荐的相似模具。",
    recommendation: "推荐",
    matchedPrefix: "匹配依据",
    suggestionOnly: "仅作为候选建议，不会自动修改 MES 安装信息。",
    modelMismatchNeedsMesFix: "模具与生产型号规格不同，已自动判定为不一致。",
    cavityProduction: "多模穴同步",
    partCount: "Part",
    paperworkRequired: "请在 MES 中确认注塑机安装模具信息。",
    confirmCorrectMould: "确认模具正确",
    decideMatch: "判定为一致",
    decideMismatch: "判定为不一致",
    resetDecision: "恢复自动判定",
    savingDecision: "正在保存判定",
    decisionError: "无法保存判定结果。",
    decisionRuleNotice: "保存的判定会自动应用于相同的模具与生产型号组合。",
    automaticDecision: "自动判定",
    confirmedBy: "确认人",
    confirmedAt: "确认时间",
    deviceConfirmationNotice: "判定结果保存在服务器中，但不会修改 MES 安装信息。",
    noInstalledMouldDetail: "MES 中没有已登记的安装模具详情。",
    openMouldDetail: "查看模具详情",
    closeVerification: "关闭模具核对",
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
    occupiedCells: "已用坐标",
    mouldRecords: "模具",
    dataIssues: "数据问题",
    duplicateLocations: "重复坐标",
    outsideLayout: "布局外位置",
    conflictCount: "重复",
    conflictListTitle: "重复登记检查",
    conflictListHint: "请确认同一位置登记的模具并整理 MES 位置信息。",
    closeConflicts: "关闭重复登记列表",
    conflictNeedsMesFix: "需先整理 MES 位置重复，再进行型号判定。",
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
    usageLegend: "每10万 Shot 点检提醒",
    inactivityLegend: "6/12个月未使用",
    shortMatch: "一致",
    shortReview: "待确认",
    shortMismatch: "不一致",
    shortUnknown: "待判定",
    shortConfirmedMatch: "判定一致",
    shortConfirmedMismatch: "判定不一致",
    shortPlanned: "计划待机",
    shortRecent: "最近实绩",
    shortStale: "数据延迟",
    shortAmbiguous: "多项生产",
    shortNoProduction: "无生产",
    shortMouldMissing: "MES确认",
    shortConflict: "重复登记",
    shortLoading: "查询中",
  },
} as const;

type Copy = { [Key in keyof typeof COPY.ko]: string };
type ViewFilter = "all" | "machine" | "storage" | "repair" | "offsite" | "unknown";
type MachineViewMode = "graphic" | "table";
type DetailTab = "movement" | "detail" | "production" | "repair";
type SelectedDetail = MouldDetail | MouldRecord;
type ProductionEvidence = "active_estimate" | "last_output" | "planned_only" | "ambiguous";
type ProductionMode = "single" | "multi_cavity";
type MachineProductionLink = {
  date: string;
  model: string;
  partNo: string;
  partNos: string[];
  parts: ProductionStatusPart[];
  basis: ProductionEvidence;
  mode: ProductionMode;
  cavityPattern: string;
  cavityGroup: string;
  productionGroupId: string;
  actualQuantity: number;
  plannedQuantity: number;
  candidateCount: number;
};
type ProductionPartSelection = {
  part: ProductionStatusPart;
  parts: ProductionStatusPart[];
  basis: ProductionEvidence;
  mode: ProductionMode;
  groupId: string;
  candidateCount: number;
};
type ModelRecommendation = {
  mould: MouldRecord;
  matchedPrefix: string;
  candidateModel: string;
  matchLevel: "exact" | "family";
  score: number;
};
type ModelRelation = "exact" | "family" | "different" | "unknown";
type ModelValidation =
  | "match"
  | "confirmed_match"
  | "review"
  | "mismatch"
  | "confirmed_mismatch"
  | "unknown"
  | "no_production"
  | "mould_missing"
  | "planned"
  | "recent_output"
  | "stale"
  | "ambiguous"
  | "conflict"
  | "loading";
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

function productionMachineNumber(value: string): number | null {
  const normalized = value.trim();
  const match = normalized.match(/(?:T\s*[-–—]?\s*|^)(\d{1,2})(?:\s*(?:호기|号机))?$/i);
  const machineNumber = Number(match?.[1]);
  return Number.isInteger(machineNumber) && machineNumber >= 1 && machineNumber <= 17
    ? machineNumber
    : null;
}

function productionPartInProgress(part: ProductionStatusPart): boolean {
  if (part.status) return part.status === "in_progress";
  return part.planned_quantity > 0
    && part.actual_quantity > 0
    && part.actual_quantity < part.planned_quantity;
}

function productionPartGroupKey(part: ProductionStatusPart, index: number): string {
  const explicit = text(part.production_group_id, "");
  if (explicit) return `group:${explicit}`;
  const cavityGroup = text(part.cavity_group, "");
  if (cavityGroup && Number(part.parts_per_shot ?? 1) > 1) return `cavity:${cavityGroup}`;
  return `part:${index}:${text(part.part_no, text(part.model_name, "unknown"))}`;
}

function groupProductionParts(parts: ProductionStatusPart[]): ProductionStatusPart[][] {
  const groups = new Map<string, ProductionStatusPart[]>();
  parts.forEach((part, index) => {
    const key = productionPartGroupKey(part, index);
    groups.set(key, [...(groups.get(key) ?? []), part]);
  });
  return [...groups.values()];
}

function selectProductionPart(machine: ProductionStatusMachine): ProductionPartSelection | undefined {
  const inProgress = machine.is_running === false
    ? []
    : machine.parts.filter(productionPartInProgress);
  if (inProgress.length) {
    const groups = groupProductionParts(inProgress);
    const parts = groups.flat();
    if (groups.length > 1) {
      return { part: parts[0], parts, basis: "ambiguous", mode: "single", groupId: "", candidateCount: groups.length };
    }

    const activeGroup = groups[0];
    const expectedSize = Math.max(1, ...activeGroup.map((part) => Number(part.parts_per_shot ?? 1)));
    const groupComplete = activeGroup.every((part) => part.production_group_complete !== false)
      && (expectedSize === 1 || activeGroup.length === expectedSize);
    const models = new Set(activeGroup.map((part) => (
      normalizedModelCode(text(part.model_name, ""))
      ?? text(part.model_name, "").normalize("NFKC").trim().toUpperCase()
    )).filter(Boolean));
    if (!groupComplete || models.size > 1) {
      return { part: activeGroup[0], parts: activeGroup, basis: "ambiguous", mode: "multi_cavity", groupId: "", candidateCount: 1 };
    }
    return {
      part: activeGroup[0],
      parts: activeGroup,
      basis: "active_estimate",
      mode: activeGroup.length > 1 ? "multi_cavity" : "single",
      groupId: text(activeGroup[0].production_group_id, text(activeGroup[0].cavity_group, "")),
      candidateCount: 1,
    };
  }

  const completedGroups = groupProductionParts(machine.parts.filter((part) => part.actual_quantity > 0));
  if (completedGroups.length) {
    const parts = completedGroups.at(-1)!;
    return {
      part: parts[0],
      parts,
      basis: "last_output",
      mode: parts.length > 1 ? "multi_cavity" : "single",
      groupId: text(parts[0].production_group_id, text(parts[0].cavity_group, "")),
      candidateCount: 1,
    };
  }

  const plannedGroups = groupProductionParts(machine.parts.filter((part) => part.planned_quantity > 0));
  const nextPlanned = plannedGroups[0];
  return nextPlanned?.length
    ? {
      part: nextPlanned[0],
      parts: nextPlanned,
      basis: "planned_only",
      mode: nextPlanned.length > 1 ? "multi_cavity" : "single",
      groupId: text(nextPlanned[0].production_group_id, text(nextPlanned[0].cavity_group, "")),
      candidateCount: 1,
    }
    : undefined;
}

function productionMachineWithPlanMetadata(machine: ProductionStatusMachine, planRecords: ProductionPlanRecord[]): ProductionStatusMachine {
  const machineNumber = productionMachineNumber(machine.machine_name);
  if (!machineNumber || !planRecords.length) return machine;
  const matchingPlans = planRecords.filter((plan) => productionMachineNumber(text(plan.machine_name, "")) === machineNumber);
  if (!matchingPlans.length) return machine;
  return {
    ...machine,
    parts: machine.parts.map((part) => {
      if (part.cavity_group || part.production_group_id) return part;
      const partNo = text(part.part_no, "").toUpperCase();
      const matchingPlan = matchingPlans.find((plan) => (
        text(plan.part_no, "").toUpperCase() === partNo
        && (!part.model_name || !plan.model_name || text(plan.model_name, "") === text(part.model_name, ""))
      ));
      if (!matchingPlan) return part;
      return {
        ...part,
        cavity: matchingPlan.cavity,
        cavity_pattern: matchingPlan.cavity_pattern,
        parts_per_shot: matchingPlan.parts_per_shot,
        cavity_group: matchingPlan.cavity_group,
        total_cavity: matchingPlan.total_cavity,
      };
    }),
  };
}

function buildMachineProductionLinks(machines: ProductionStatusMachine[], date: string, planRecords: ProductionPlanRecord[] = []) {
  const links = new Map<number, MachineProductionLink>();
  machines.forEach((machine) => {
    const machineNumber = productionMachineNumber(machine.machine_name);
    const enrichedMachine = productionMachineWithPlanMetadata(machine, planRecords);
    const selection = selectProductionPart(enrichedMachine);
    if (!machineNumber || !selection) return;
    const { part, parts, basis, mode, groupId, candidateCount } = selection;
    const partNos = [...new Set(parts.map((item) => text(item.part_no, "")).filter((value) => value && value !== "-"))];
    links.set(machineNumber, {
      date,
      model: text(part.model_name, ""),
      partNo: text(part.part_no),
      partNos,
      parts,
      basis,
      mode,
      cavityPattern: text(part.cavity_pattern, ""),
      cavityGroup: text(part.cavity_group, ""),
      productionGroupId: groupId,
      actualQuantity: parts.reduce((sum, item) => sum + item.actual_quantity, 0),
      plannedQuantity: parts.reduce((sum, item) => sum + item.planned_quantity, 0),
      candidateCount,
    });
  });
  return links;
}

function buildFallbackMachineProductionLinks(board: MouldBoard | undefined) {
  const date = getShanghaiBusinessDateString();
  const links = new Map<number, MachineProductionLink>();
  board?.moulds.forEach((mould) => {
    const machineNumber = mould.location.machineNumber;
    if (!machineNumber || !mould.model) return;
    links.set(machineNumber, {
      date,
      model: machineNumber % 4 === 0 ? `${mould.model}X` : `${mould.model}-QA`,
      partNo: `QA-${String(machineNumber).padStart(2, "0")}`,
      partNos: [`QA-${String(machineNumber).padStart(2, "0")}`],
      parts: [],
      basis: "active_estimate",
      mode: "single",
      cavityPattern: "",
      cavityGroup: "",
      productionGroupId: "",
      actualQuantity: 1,
      plannedQuantity: 2,
      candidateCount: 1,
    });
  });
  return links;
}

function normalizedModelCode(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(normalized)) return null;
  if (!/[A-Z]/.test(normalized) || !/\d/.test(normalized)) return null;
  return normalized;
}

function leadingModelSize(code: string): string | null {
  return code.match(/^(\d{2,3})(?=[A-Z])/)?.[1] ?? null;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function modelCodeRelation(leftValue: string, rightValue: string): ModelRelation {
  const left = normalizedModelCode(leftValue);
  const right = normalizedModelCode(rightValue);
  if (!left || !right) return "unknown";

  const leftBase = left.split(/[._/-]/, 1)[0];
  const rightBase = right.split(/[._/-]/, 1)[0];
  if (leftBase === rightBase) return "exact";

  const leftSize = leadingModelSize(leftBase);
  const rightSize = leadingModelSize(rightBase);
  if (leftSize && rightSize) {
    if (leftSize === rightSize) return "family";
    return "different";
  }

  const sharedLength = commonPrefixLength(leftBase, rightBase);
  const shared = leftBase.slice(0, sharedLength);
  if (sharedLength >= 4 && /[A-Z]/.test(shared) && /\d/.test(shared)) return "family";
  return "unknown";
}

function productionAgeDays(date: string): number {
  const reference = new Date(`${getShanghaiBusinessDateString()}T00:00:00Z`).getTime();
  const source = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(reference) || !Number.isFinite(source)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((reference - source) / 86_400_000));
}

function modelValidation(moulds: MouldRecord[], production: MachineProductionLink | undefined): ModelValidation {
  if (moulds.length > 1) return "conflict";
  const mould = moulds[0];
  if (!mould) return "mould_missing";
  if (!production) return "no_production";
  if (production.basis === "ambiguous") return "ambiguous";
  if (production.basis === "planned_only") return "planned";
  if (production.basis === "last_output") return "recent_output";
  if (productionAgeDays(production.date) > 3) return "stale";
  if (!mould.model) return "unknown";
  const relation = modelCodeRelation(mould.model, production.model);
  if (relation === "exact") return "match";
  if (relation === "family") return "review";
  if (relation === "different") return "mismatch";
  return "unknown";
}

function validationLabel(validation: ModelValidation, copy: Copy) {
  return {
    match: copy.modelMatch,
    confirmed_match: copy.modelConfirmedMatch,
    review: copy.modelReview,
    mismatch: copy.modelMismatch,
    confirmed_mismatch: copy.modelConfirmedMismatch,
    unknown: copy.modelUnknown,
    no_production: copy.noProductionModel,
    mould_missing: copy.mouldNotMounted,
    planned: copy.modelPlanned,
    recent_output: copy.modelRecent,
    stale: copy.modelStale,
    ambiguous: copy.modelAmbiguous,
    conflict: copy.machineConflict,
    loading: copy.modelLoading,
  }[validation];
}

function validationShortLabel(validation: ModelValidation, copy: Copy) {
  return {
    match: copy.shortMatch,
    confirmed_match: copy.shortConfirmedMatch,
    review: copy.shortReview,
    mismatch: copy.shortMismatch,
    confirmed_mismatch: copy.shortConfirmedMismatch,
    unknown: copy.shortUnknown,
    no_production: copy.shortNoProduction,
    mould_missing: copy.shortMouldMissing,
    planned: copy.shortPlanned,
    recent_output: copy.shortRecent,
    stale: copy.shortStale,
    ambiguous: copy.shortAmbiguous,
    conflict: copy.shortConflict,
    loading: copy.shortLoading,
  }[validation];
}

function validationClass(validation: ModelValidation) {
  return {
    match: styles.validationMatch,
    confirmed_match: styles.validationMatch,
    review: styles.validationReview,
    mismatch: styles.validationMismatch,
    confirmed_mismatch: styles.validationMismatch,
    unknown: styles.validationUnknown,
    no_production: styles.validationIdle,
    mould_missing: styles.validationUnknown,
    planned: styles.validationPlanned,
    recent_output: styles.validationPlanned,
    stale: styles.validationUnknown,
    ambiguous: styles.validationUnknown,
    conflict: styles.validationConflict,
    loading: styles.validationIdle,
  }[validation];
}

function productionBasisLabel(production: MachineProductionLink | undefined, copy: Copy): string {
  if (!production) return copy.noProductionModel;
  return {
    active_estimate: copy.productionBasisActive,
    last_output: copy.productionBasisRecent,
    planned_only: copy.productionBasisPlanned,
    ambiguous: copy.productionBasisAmbiguous,
  }[production.basis];
}

const MACHINE_VIEW_STORAGE_KEY = "wj-mould-machine-view-v1";
const MACHINE_VALIDATION_QUERY_KEY = ["injection", "moulds", "machine-validation-rules"] as const;

function readMachineViewMode(): MachineViewMode {
  try {
    return window.localStorage.getItem(MACHINE_VIEW_STORAGE_KEY) === "table" ? "table" : "graphic";
  } catch {
    return "graphic";
  }
}

function modelBaseCode(value: string): string | null {
  return normalizedModelCode(value)?.split(/[._/-]/, 1)[0] ?? null;
}

function normalizedRuleModel(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
}

function modelRuleToken(value: string): { key: string; structured: boolean } {
  const structured = modelBaseCode(value);
  return structured
    ? { key: structured, structured: true }
    : { key: normalizedRuleModel(value), structured: false };
}

function machineValidationRuleLookup(
  mould: MouldRecord | undefined,
  production: MachineProductionLink | undefined,
) {
  if (!mould || !production?.model) return null;
  const mouldToken = modelRuleToken(mould.model);
  const productionTokens = [production.model]
    .map(modelRuleToken)
    .filter((item) => Boolean(item.key))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (!mouldToken.key || !productionTokens.length) return null;
  const scope = mouldToken.structured && productionTokens.every((item) => item.structured)
    ? "model_pair" as const
    : "instance_pair" as const;
  const evidenceKey = normalizedRuleModel(mould.drawingNo)
    || normalizedRuleModel(mould.assetCode)
    || mouldToken.key;
  const mouldModelKey = scope === "model_pair"
    ? mouldToken.key
    : `${mould.instanceId}:${evidenceKey}`;
  const productionModelKey = productionTokens.map((item) => item.key).join("+");
  return {
    mapKey: JSON.stringify([scope, mouldModelKey, productionModelKey]),
    scope,
    mouldModelKey,
    productionModelKey,
  };
}

function validationRuleMapKey(rule: MouldMachineValidationRule): string {
  return JSON.stringify([rule.scope, rule.mouldModelKey, rule.productionModelKey]);
}

function resolveValidationRule(
  automatic: ModelValidation,
  rule: MouldMachineValidationRule | undefined,
): ModelValidation {
  if (!rule || !["review", "mismatch", "unknown"].includes(automatic)) return automatic;
  return rule.decision === "match" ? "confirmed_match" : "confirmed_mismatch";
}

function machineValidationInput(
  mould: MouldRecord,
  production: MachineProductionLink,
): MouldMachineValidationInput {
  return {
    mouldInstanceId: mould.instanceId,
    productionModels: [production.model],
    partNos: [...new Set(production.partNos)].sort(),
    productionMode: production.mode,
    cavityPattern: production.cavityPattern,
    businessDate: production.date,
  };
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function mouldRecommendationCodes(mould: MouldRecord): string[] {
  return [...new Set([
    modelBaseCode(mould.model),
    modelBaseCode(mould.name),
    modelBaseCode(mould.drawingNo),
  ].filter((value): value is string => Boolean(value)))];
}

function recommendationMatch(productionBase: string, candidateCode: string): Omit<ModelRecommendation, "mould"> | null {
  if (productionBase === candidateCode) {
    return { candidateModel: candidateCode, matchedPrefix: candidateCode, matchLevel: "exact", score: 1_000 + candidateCode.length };
  }

  if (productionBase.startsWith(candidateCode) || candidateCode.startsWith(productionBase)) {
    const sharedLength = Math.min(productionBase.length, candidateCode.length);
    if (sharedLength >= 3) {
      const shared = productionBase.slice(0, sharedLength);
      return { candidateModel: candidateCode, matchedPrefix: shared, matchLevel: "family", score: 900 + sharedLength };
    }
  }

  const comparisonLength = Math.min(productionBase.length, candidateCode.length);
  if (comparisonLength >= 5) {
    const productionSegment = productionBase.slice(0, comparisonLength);
    const candidateSegment = candidateCode.slice(0, comparisonLength);
    if (editDistance(productionSegment, candidateSegment) <= 1) {
      return {
        candidateModel: candidateCode,
        matchedPrefix: `${productionSegment}≈${candidateSegment}`,
        matchLevel: "family",
        score: 800 + comparisonLength,
      };
    }
  }

  const sharedLength = commonPrefixLength(productionBase, candidateCode);
  const shared = productionBase.slice(0, sharedLength);
  if (sharedLength >= 3 && /[A-Z]/.test(shared) && /\d/.test(shared)) {
    return { candidateModel: candidateCode, matchedPrefix: shared, matchLevel: "family", score: 700 + sharedLength };
  }

  const productionShortFamily = productionBase.match(/^([A-Z]{2,4})\d{1,2}$/)?.[1];
  const candidateShortFamily = candidateCode.match(/^([A-Z]{2,4})\d{1,2}$/)?.[1];
  if (productionShortFamily && productionShortFamily === candidateShortFamily) {
    return { candidateModel: candidateCode, matchedPrefix: productionShortFamily, matchLevel: "family", score: 600 + productionShortFamily.length };
  }
  return null;
}

function modelRecommendations(board: MouldBoard | undefined, production: MachineProductionLink | undefined): ModelRecommendation[] {
  if (!board || !production?.model) return [];
  const productionBase = modelBaseCode(production.model);
  if (!productionBase) return [];

  const locationByCode = new Map(board.locations.map((location) => [location.code.toUpperCase(), location]));
  return board.moulds
    .filter((mould) => {
      const aggregateLocation = locationByCode.get(mould.location.code.toUpperCase());
      const zoneCode = (aggregateLocation?.zoneCode || mould.location.zoneCode || mould.location.code.slice(0, 1)).toUpperCase();
      return mould.summaryCategory === "storage"
        && mould.location.kind === "storage"
        && ["A", "B", "C"].includes(zoneCode)
        && !aggregateLocation?.conflict
        && Number(aggregateLocation?.mouldCount ?? mould.location.mouldCount) <= 1;
    })
    .map((mould) => {
      const bestMatch = mouldRecommendationCodes(mould)
        .map((candidateCode) => recommendationMatch(productionBase, candidateCode))
        .filter((match): match is Omit<ModelRecommendation, "mould"> => Boolean(match))
        .sort((left, right) => right.score - left.score)[0];
      return bestMatch ? { mould, ...bestMatch } : null;
    })
    .filter((item): item is ModelRecommendation => Boolean(item))
    .sort((left, right) => (
      right.score - left.score
      || left.mould.location.code.localeCompare(right.mould.location.code, undefined, { numeric: true })
      || left.mould.mouldCode.localeCompare(right.mould.mouldCode, undefined, { numeric: true })
    ))
    .slice(0, 4);
}

function recommendationLocationText(recommendations: ModelRecommendation[], limit = 2): string {
  const locations = [...new Set(recommendations.map((item) => item.mould.location.code).filter(Boolean))];
  const visible = locations.slice(0, limit).join(" · ");
  return locations.length > limit ? `${visible} +${locations.length - limit}` : visible;
}

async function getLatestMachineProductionLinks() {
  const referenceDate = getShanghaiBusinessDateString();
  const fallbackDates = Array.from({ length: 8 }, (_, index) => {
    const candidateDate = new Date(`${referenceDate}T00:00:00Z`);
    candidateDate.setUTCDate(candidateDate.getUTCDate() - index);
    return candidateDate.toISOString().slice(0, 10);
  });
  let indexedDates: string[] = [];
  try {
    const dates = await getProductionPlanDates();
    indexedDates = dates.injection.filter((date) => date <= referenceDate);
  } catch {
    // Recent dates below still provide a deterministic fallback when the index is unavailable.
  }

  const candidateDates = [...new Set([...indexedDates, ...fallbackDates])]
    .filter((date) => date <= referenceDate)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 8);
  const recentStatuses = await Promise.all(candidateDates.map(async (date) => {
    try {
      const status = await getProductionStatus(date);
      const needsPlanMetadata = status.injection.some((machine) => {
        const activeParts = machine.parts.filter(productionPartInProgress);
        return activeParts.length > 1 && activeParts.some((part) => !part.cavity_group && !part.production_group_id);
      });
      let planRecords: ProductionPlanRecord[] = [];
      if (needsPlanMetadata) {
        try {
          planRecords = (await getProductionPlanSummary(date)).injection.records;
        } catch {
          // The status response remains usable; unresolved multi-part rows fail closed as ambiguous.
        }
      }
      return { date, status, planRecords };
    } catch {
      return null;
    }
  }));

  const actualLinks = new Map<number, MachineProductionLink>();
  const plannedLinks = new Map<number, MachineProductionLink>();
  recentStatuses.forEach((item) => {
    if (!item) return;
    buildMachineProductionLinks(item.status.injection, item.date, item.planRecords).forEach((link, machineNumber) => {
      if (link.basis === "planned_only") {
        if (!plannedLinks.has(machineNumber)) plannedLinks.set(machineNumber, link);
      } else if (!actualLinks.has(machineNumber)) {
        actualLinks.set(machineNumber, link);
      }
    });
  });
  const result = new Map(plannedLinks);
  actualLinks.forEach((link, machineNumber) => result.set(machineNumber, link));
  return result;
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
  const [machineViewMode, setMachineViewMode] = useState<MachineViewMode>(readMachineViewMode);
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("movement");
  const [detailOpen, setDetailOpen] = useState(false);
  const [statusListOpen, setStatusListOpen] = useState(false);
  const [verificationMachineNumber, setVerificationMachineNumber] = useState<number | null>(null);
  const [conflictListOpen, setConflictListOpen] = useState(false);
  const [conflictFocusCode, setConflictFocusCode] = useState("");
  const [focusedZone, setFocusedZone] = useState<string | null>(null);
  const [isZonePanning, setIsZonePanning] = useState(false);
  const zoneDragRef = useRef<ZoneDragState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [isMobileHeaderCompact, setIsMobileHeaderCompact] = useState(false);

  const changeMachineViewMode = (mode: MachineViewMode) => {
    setMachineViewMode(mode);
    try {
      window.localStorage.setItem(MACHINE_VIEW_STORAGE_KEY, mode);
    } catch {
      // The selected mode still works for this session when storage is unavailable.
    }
  };

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
      else if (verificationMachineNumber !== null) setVerificationMachineNumber(null);
      else if (conflictListOpen) setConflictListOpen(false);
      else if (focusedZone) setFocusedZone(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [conflictListOpen, detailOpen, focusedZone, statusListOpen, verificationMachineNumber]);

  const boardQuery = useQuery({
    queryKey: ["injection", "moulds", "board"],
    queryFn: getMouldBoard,
    enabled: !developmentFallback,
    retry: 1,
    refetchInterval: 3_600_000,
  });
  const productionLinksQuery = useQuery({
    queryKey: ["production-status", "mould-board-model-links"],
    queryFn: getLatestMachineProductionLinks,
    enabled: !developmentFallback,
    retry: 1,
    staleTime: 300_000,
    refetchInterval: 300_000,
  });
  const machineValidationRulesQuery = useQuery({
    queryKey: MACHINE_VALIDATION_QUERY_KEY,
    queryFn: getMouldMachineValidationRules,
    enabled: !developmentFallback,
    retry: 1,
    staleTime: 60_000,
    refetchInterval: 3_600_000,
  });
  const usingFallback = developmentFallback;
  const board = usingFallback ? FALLBACK_MOULD_BOARD : boardQuery.data;
  const fallbackProductionLinks = useMemo(
    () => buildFallbackMachineProductionLinks(usingFallback ? board : undefined),
    [board, usingFallback],
  );
  const productionLinks = usingFallback
    ? fallbackProductionLinks
    : productionLinksQuery.data ?? new Map<number, MachineProductionLink>();
  const machineValidationRules = useMemo(() => new Map(
    (machineValidationRulesQuery.data ?? []).map((rule) => [validationRuleMapKey(rule), rule]),
  ), [machineValidationRulesQuery.data]);

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
  const canConfirmUsage = auth.hasCapability("mould.confirm");
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
  const machineValidationMutation = useMutation({
    mutationFn: async ({
      action,
      input,
      decision,
    }: {
      action: "confirm" | "reset";
      input: MouldMachineValidationInput;
      decision?: MouldMachineValidationDecision;
    }) => {
      if (action === "reset") return resetMouldMachineValidationRule(input);
      if (!decision) throw new Error("A validation decision is required.");
      return saveMouldMachineValidationRule(input, decision);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MACHINE_VALIDATION_QUERY_KEY });
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
  const knownStorageCodes = useMemo(() => new Set(
    zones.flatMap((zone) => zone.rows.flatMap((row) => row.cells.map(({ location }) => location.code))),
  ), [zones]);
  const conflictGroups = useMemo(() => (
    [...mouldsByLocation.entries()]
      .filter(([, occupants]) => occupants.length > 1)
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
  ), [mouldsByLocation]);
  const storageConflictGroups = useMemo(() => conflictGroups.filter(([, occupants]) => (
    occupants.some((mould) => mould.location.kind === "storage")
  )), [conflictGroups]);
  const machineConflictGroups = useMemo(() => conflictGroups.filter(([, occupants]) => (
    occupants.some((mould) => mould.location.kind === "machine")
  )), [conflictGroups]);
  const unmappedStorageMoulds = useMemo(() => (board?.moulds ?? []).filter((mould) => (
    mould.location.kind === "storage" && !knownStorageCodes.has(mould.location.code)
  )), [board?.moulds, knownStorageCodes]);
  const mountedMachineCount = useMemo(() => {
    const mountedNumbers = new Set(
      (board?.moulds ?? [])
        .filter((mould) => mould.location.kind === "machine" && mould.location.machineNumber)
        .map((mould) => mould.location.machineNumber),
    );
    return board?.machines.filter((machine) => mountedNumbers.has(machine.number)).length ?? 0;
  }, [board?.machines, board?.moulds]);
  const displayedConflictGroups = conflictFocusCode
    ? conflictGroups.filter(([locationCode]) => locationCode === conflictFocusCode)
    : conflictGroups;
  const displayedUnmappedMoulds = conflictFocusCode
    ? unmappedStorageMoulds.filter((mould) => mould.location.code === conflictFocusCode)
    : unmappedStorageMoulds;

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
    if (mould.summaryCategory === "offsite") return copy.offsite;
    if (mould.summaryCategory === "repair" || mould.summaryCategory === "maintenance") return copy.repair;
    return localizedMachineText(text(mould.location.label || mould.location.code, copy.unknown), language);
  };

  const verificationMachine = board?.machines.find((machine) => machine.number === verificationMachineNumber);
  const verificationMoulds = verificationMachine
    ? (board?.moulds ?? []).filter((mould) => mould.location.kind === "machine" && mould.location.machineNumber === verificationMachine.number)
    : [];
  const verificationMould = verificationMoulds.length === 1 ? verificationMoulds[0] : undefined;
  const verificationProduction = verificationMachine ? productionLinks.get(verificationMachine.number) : undefined;
  const verificationAutomaticResult: ModelValidation = !usingFallback && !productionLinksQuery.isSuccess && !productionLinksQuery.isError
    ? "loading"
    : verificationMachine && (verificationMachine.conflict || verificationMachine.mouldCount > 1)
      ? "conflict"
      : modelValidation(verificationMoulds, verificationProduction);
  const verificationRuleLookup = machineValidationRuleLookup(verificationMould, verificationProduction);
  const verificationRule = verificationRuleLookup
    ? machineValidationRules.get(verificationRuleLookup.mapKey)
    : undefined;
  const verificationResult = resolveValidationRule(verificationAutomaticResult, verificationRule);
  const verificationCanDecide = Boolean(
    verificationMould
    && verificationProduction
    && ["review", "mismatch", "unknown"].includes(verificationAutomaticResult),
  );
  const verificationCandidates = verificationAutomaticResult === "mould_missing"
    ? modelRecommendations(board, verificationProduction)
    : [];
  const productionResolved = usingFallback || productionLinksQuery.isSuccess || productionLinksQuery.isError;
  const machineOverviewItems = (board?.machines ?? []).map((machine) => {
    const mountedMoulds = (board?.moulds ?? []).filter((mould) => (
      mould.location.kind === "machine" && mould.location.machineNumber === machine.number
    ));
    const mounted = mountedMoulds.length === 1 ? mountedMoulds[0] : undefined;
    const productionLink = productionLinks.get(machine.number);
    const machineHasConflict = machine.conflict || machine.mouldCount > 1 || mountedMoulds.length > 1;
    const automaticValidation: ModelValidation = !productionResolved
      ? "loading"
      : machineHasConflict
        ? "conflict"
        : modelValidation(mountedMoulds, productionLink);
    const ruleLookup = machineValidationRuleLookup(mounted, productionLink);
    const rule = ruleLookup ? machineValidationRules.get(ruleLookup.mapKey) : undefined;
    const validation = resolveValidationRule(automaticValidation, rule);
    const activeProductionModel = productionLink?.basis === "active_estimate" && productionAgeDays(productionLink.date) <= 3
      ? text(productionLink.model)
      : "-";
    const recommendations = automaticValidation === "mould_missing"
      ? modelRecommendations(board, productionLink)
      : [];
    const machineSearchText = [
      machineDisplayLabel(machine.number, machine.tonnage, language),
      ...mountedMoulds.flatMap((item) => [item.mouldCode, item.assetCode, item.name, item.model, item.drawingNo]),
      activeProductionModel,
      ...(productionLink?.partNos ?? []),
      ...recommendations.flatMap((item) => [item.mould.mouldCode, item.candidateModel, item.mould.location.code]),
      validationShortLabel(validation, copy),
    ].join(" ").toLocaleLowerCase();
    const visible = (mountedMoulds.length
      ? mountedMoulds.some((item) => matchesFilter(item, filter))
      : filter === "all")
      && (!search.trim() || machineSearchText.includes(search.trim().toLocaleLowerCase()));
    return {
      machine,
      mountedMoulds,
      mounted,
      productionLink,
      automaticValidation,
      validation,
      rule,
      activeProductionModel,
      recommendations,
      visible,
      selected: mountedMoulds.some((item) => item.instanceId === selectedInstanceId),
    };
  });

  const saveMachineDecision = (decision: MouldMachineValidationDecision) => {
    if (!verificationMould || !verificationProduction || !verificationCanDecide || !canConfirmUsage) return;
    machineValidationMutation.mutate({
      action: "confirm",
      decision,
      input: machineValidationInput(verificationMould, verificationProduction),
    });
  };

  const resetMachineDecision = () => {
    if (!verificationMould || !verificationProduction || !verificationRule || !canConfirmUsage) return;
    machineValidationMutation.mutate({
      action: "reset",
      input: machineValidationInput(verificationMould, verificationProduction),
    });
  };

  const selectMould = (instanceId: string) => {
    setSelectedInstanceId(instanceId);
    setStatusListOpen(false);
    setVerificationMachineNumber(null);
    setConflictListOpen(false);
    setDetailOpen(true);
  };

  const openConflictList = (locationCode = "") => {
    setConflictFocusCode(locationCode);
    setConflictListOpen(true);
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
            disabled={developmentFallback || boardQuery.isFetching || productionLinksQuery.isFetching || machineValidationRulesQuery.isFetching}
            onClick={() => void Promise.all([boardQuery.refetch(), productionLinksQuery.refetch(), machineValidationRulesQuery.refetch()])}
            title={copy.refresh}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={boardQuery.isFetching || productionLinksQuery.isFetching || machineValidationRulesQuery.isFetching ? styles.spinning : ""} size={21} />
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
            <span className={usingFallback ? styles.fallbackBadge : board?.dataFreshness.stale ? styles.staleBadge : styles.liveBadge}>
              {usingFallback ? copy.fallbackBadge : board?.dataFreshness.stale ? copy.staleBadge : copy.liveBadge}
            </span>
            {usingFallback ? <small>{copy.fallbackNotice}</small> : null}
          </div>
        </div>
      </div>

      {board ? (
        <div className={styles.boardGrid}>
          <section className={styles.machinePanel} aria-labelledby="mould-machine-title">
            <div className={styles.panelHeader}>
              <div><p>{copy.mounted}</p><h2 id="mould-machine-title">{copy.machines}</h2><span>{copy.machinesHint}</span></div>
              {machineConflictGroups.length ? (
                <button className={styles.panelIssueButton} onClick={() => openConflictList()} type="button">
                  <AlertTriangle aria-hidden="true" size={16} />{copy.machineConflict}<strong>{machineConflictGroups.length}</strong>
                </button>
              ) : null}
              <strong>{mountedMachineCount}<small>/17{language === "ko" ? "대" : "台"}</small></strong>
            </div>
            <div className={styles.machineViewToolbar}>
              <div className={styles.machineViewToggle} role="group" aria-label={copy.machineViewMode}>
                <button aria-pressed={machineViewMode === "graphic"} onClick={() => changeMachineViewMode("graphic")} type="button">
                  <LayoutGrid aria-hidden="true" size={17} />{copy.graphicMode}
                </button>
                <button aria-pressed={machineViewMode === "table"} onClick={() => changeMachineViewMode("table")} type="button">
                  <Table2 aria-hidden="true" size={17} />{copy.tableMode}
                </button>
              </div>
            </div>
            {machineViewMode === "graphic" ? (
              <div className={styles.machineGraphicGrid}>
                {machineOverviewItems.map(({ machine, mountedMoulds, mounted, productionLink, validation, activeProductionModel, recommendations, visible, selected }) => (
                  <button
                    aria-expanded={verificationMachineNumber === machine.number}
                    aria-haspopup="dialog"
                    aria-label={`${machineDisplayLabel(machine.number, machine.tonnage, language)}, ${copy.currentMould} ${mountedMoulds.length ? mountedMoulds.map((item) => item.mouldCode).join(", ") : "-"}, ${copy.productionModel} ${activeProductionModel}, ${validationLabel(validation, copy)}`}
                    className={`${styles.machineGraphicCard} ${selected ? styles.selectedMachine : ""} ${visible ? "" : styles.filteredOut}`}
                    key={machine.number}
                    onClick={() => setVerificationMachineNumber(machine.number)}
                    type="button"
                  >
                    <span className={styles.machineGraphicTopline}>
                      <strong>{machineDisplayLabel(machine.number, machine.tonnage, language)}</strong>
                      <i className={`${styles.statusPill} ${validationClass(validation)}`}>{validationShortLabel(validation, copy)}</i>
                    </span>
                    <span className={styles.machineGraphicBody}>
                      <span className={styles.machineGraphicArt}><img alt="" aria-hidden="true" src={injectionMachineGraphic} /></span>
                      <span className={styles.machineGraphicInfo}>
                        <small>{copy.productionModel}</small>
                        <strong title={activeProductionModel === "-" ? undefined : activeProductionModel}>{activeProductionModel}</strong>
                        {productionLink?.mode === "multi_cavity" && activeProductionModel !== "-" ? (
                          <em>{productionLink.partNos.length} {copy.partCount} · {copy.cavityProduction}</em>
                        ) : null}
                        <span><small>{copy.currentMould}</small><b>{mountedMoulds.length > 1 ? `${copy.shortConflict} ${mountedMoulds.length}${copy.listCount}` : mounted?.mouldCode || "-"}</b></span>
                      </span>
                    </span>
                    {recommendations.length ? (
                      <span className={styles.machineRecommendationLine}>
                        <small>{copy.recommendedLocation}</small>
                        <strong>{recommendations.length === 1 ? recommendations[0].mould.mouldCode : `${recommendations.length}${copy.listCount}`}</strong>
                        <em title={recommendations.map((item) => displayLocation(item.mould)).join(" · ")}>{recommendationLocationText(recommendations)}</em>
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className={styles.machineTable}>
                <div className={styles.machineTableHeader} aria-hidden="true">
                  <span>{copy.machine}</span><span>{copy.currentMould}</span><span>{copy.productionModel}</span><span>{copy.status}</span>
                </div>
                <div className={styles.machineRows}>
                  {machineOverviewItems.map(({ machine, mountedMoulds, mounted, productionLink, validation, activeProductionModel, recommendations, visible, selected }) => (
                    <button
                      aria-expanded={verificationMachineNumber === machine.number}
                      aria-haspopup="dialog"
                      aria-label={`${machineDisplayLabel(machine.number, machine.tonnage, language)}, ${copy.currentMould} ${mountedMoulds.length ? mountedMoulds.map((item) => item.mouldCode).join(", ") : "-"}, ${copy.productionModel} ${activeProductionModel}, ${validationLabel(validation, copy)}`}
                      className={`${styles.machineRow} ${selected ? styles.selectedMachine : ""} ${visible ? "" : styles.filteredOut}`}
                      key={machine.number}
                      onClick={() => setVerificationMachineNumber(machine.number)}
                      title={copy.verifyHint}
                      type="button"
                    >
                      <strong>{machineDisplayLabel(machine.number, machine.tonnage, language)}</strong>
                      <span className={styles.machineMountedCell}>
                        <small>{copy.currentMould}</small>
                        <strong>{mountedMoulds.length > 1 ? `${copy.shortConflict} ${mountedMoulds.length}${copy.listCount}` : mounted?.mouldCode || "-"}</strong>
                        {recommendations.length ? (
                          <em
                            className={styles.machineRecommendedLocation}
                            title={recommendations.map((item) => displayLocation(item.mould)).join(" · ")}
                          >
                            <span>{copy.recommendedLocation}</span>{recommendationLocationText(recommendations)}
                          </em>
                        ) : null}
                      </span>
                      <span className={styles.machineProductionCell}>
                        <small>{copy.productionModel}</small>
                        <strong title={activeProductionModel === "-" ? undefined : activeProductionModel}>{activeProductionModel}</strong>
                        {productionLink?.mode === "multi_cavity" && activeProductionModel !== "-" ? <em>{productionLink.partNos.length} {copy.partCount}</em> : null}
                      </span>
                      <span className={styles.machineStatusStack}>
                        <i className={`${styles.statusPill} ${validationClass(validation)}`}>{validationShortLabel(validation, copy)}</i>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className={styles.storagePanel} aria-labelledby="mould-storage-title">
            <div className={styles.panelHeader}>
              <div><p>{copy.stored}</p><h2 id="mould-storage-title">{copy.storageInventory}</h2><span>{copy.touchHint}</span></div>
              <div className={styles.cellLegend}>
                {storageConflictGroups.length || unmappedStorageMoulds.length ? (
                  <button className={styles.panelIssueButton} onClick={() => openConflictList()} type="button">
                    <AlertTriangle aria-hidden="true" size={16} />{copy.dataIssues}<strong>{storageConflictGroups.length + unmappedStorageMoulds.length}</strong>
                  </button>
                ) : null}
                <span className={styles.coordinateGuide}><MapIcon aria-hidden="true" size={18} />{copy.coordinateGuide}</span>
                <span><i className={styles.legendUsage} />{copy.usageLegend}</span>
                <span><i className={styles.legendConflict} />{copy.duplicateLocations}</span>
                <span><i className={styles.legendInactiveSix} />{copy.unusedSixMonths}</span>
                <span><i className={styles.legendInactiveTwelve} />{copy.unusedTwelveMonths}</span>
              </div>
            </div>
            <div className={`${styles.zoneList} ${focusedZone ? styles.zoneListFocused : ""}`}>
              {displayedZones.length ? displayedZones.map((zone) => {
                const zoneCells = zone.rows.flatMap((row) => row.cells);
                const occupied = zoneCells.filter(({ location }) => (mouldsByLocation.get(location.code)?.length ?? location.mouldCount) > 0).length;
                const mouldRecords = zoneCells.reduce((total, { location }) => total + (mouldsByLocation.get(location.code)?.length ?? location.mouldCount), 0);
                const zoneConflicts = zoneCells.filter(({ location }) => (mouldsByLocation.get(location.code)?.length ?? location.mouldCount) > 1).length;
                const zoneStyle = zone.code === "A" ? styles.zoneA : zone.code === "B" ? styles.zoneB : styles.zoneC;
                return (
                  <section className={`${styles.zone} ${zoneStyle} ${focusedZone ? styles.focusedZone : ""}`} key={zone.code}>
                    <header>
                      <h3>{zone.label}</h3>
                      <div className={styles.zoneStats}>
                        <span>{copy.occupiedCells}<strong>{occupied}/{zoneCells.length}</strong></span>
                        <span>{copy.mouldRecords}<strong>{mouldRecords}</strong></span>
                        {zoneConflicts ? <button onClick={() => openConflictList()} type="button">{copy.conflictCount}<strong>{zoneConflicts}</strong></button> : null}
                      </div>
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
                      onKeyDown={(event) => {
                        if (!focusedZone || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                        event.preventDefault();
                        const horizontal = event.key === "ArrowLeft" ? -80 : event.key === "ArrowRight" ? 80 : 0;
                        const vertical = event.key === "ArrowUp" ? -80 : event.key === "ArrowDown" ? 80 : 0;
                        event.currentTarget.scrollBy({ left: horizontal, top: vertical, behavior: "smooth" });
                      }}
                      style={{ "--coordinate-columns": zone.columns, "--coordinate-rows": zone.rows.length } as CSSProperties}
                      tabIndex={focusedZone ? 0 : undefined}
                    >
                      {zone.rows.map((row) => (
                        <div className={styles.coordinateRow} key={row.key}>
                          <div className={styles.coordinateCells}>
                            {row.cells.map(({ location }) => {
                              const occupants = mouldsByLocation.get(location.code) ?? [];
                              const occupant = occupants[0];
                              const selected = occupants.some((item) => item.instanceId === selectedInstanceId);
                              const visible = occupants.length ? occupants.some((item) => visibleIds.has(item.instanceId)) : filter === "all" && !search.trim();
                              const conflict = location.conflict || occupants.length > 1;
                              const occupantCodes = occupants.map((item) => item.mouldCode).join(", ");
                              return (
                                <button
                                  aria-label={occupant ? `${location.code}, ${conflict ? `${copy.conflict} ${occupants.length}${copy.listCount}, ${occupantCodes}` : occupant.mouldCode}${!conflict && inactivityLabel(occupant, copy) ? `, ${inactivityLabel(occupant, copy)}` : ""}${!conflict && occupant.confirmationRequired ? `, ${milestoneLabel(occupant.shotMilestone, language)} Shot ${copy.checkpointRequired}` : ""}` : `${location.code}, ${copy.emptyCell}`}
                                  aria-pressed={selected}
                                  className={`${styles.coordinateCell} ${occupant ? styles.occupiedCell : ""} ${occupant ? usageVisualClass(occupant) : ""} ${selected ? styles.selectedCell : ""} ${conflict ? styles.conflictCell : ""} ${visible ? "" : styles.filteredOut}`}
                                  disabled={!occupant}
                                  key={location.code}
                                  onClick={() => {
                                    if (zoneDragRef.current?.moved) {
                                      zoneDragRef.current.moved = false;
                                      return;
                                    }
                                    if (conflict) openConflictList(location.code);
                                    else if (occupant) selectMould(occupant.instanceId);
                                  }}
                                  title={occupant ? conflict ? `${location.code} · ${copy.conflict} ${occupants.length}${copy.listCount} · ${occupantCodes}` : `${occupant.mouldCode} · ${occupant.name}${inactivityLabel(occupant, copy) ? ` · ${inactivityLabel(occupant, copy)}` : ""}` : copy.emptyCell}
                                  type="button"
                                >
                                  <span className={styles.coordinateTopline}>
                                    <span className={styles.coordinateCode}>{location.code}</span>
                                    {conflict ? (
                                      <span className={styles.cellConflictBadge}>{occupants.length}</span>
                                    ) : occupant?.confirmationRequired ? (
                                      <span className={`${styles.cellUsageBadge} ${focusedZone ? styles.cellUsageBadgeExpanded : ""}`} title={`${milestoneLabel(occupant.shotMilestone, language)} Shot · ${copy.checkpointRequired}`}>
                                        {focusedZone ? `${milestoneLabel(occupant.shotMilestone, language)}!` : "!"}
                                      </span>
                                    ) : null}
                                  </span>
                                  {focusedZone && occupant ? (
                                    <span className={styles.coordinateDrawing}>
                                      {conflict ? `${copy.conflictCount} ${occupants.length} · ${occupants.map((item) => item.mouldCode).join(" / ")}` : text(occupant.drawingNo, occupant.assetCode || occupant.mouldCode)}
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

      {conflictListOpen ? (
        <>
          <button aria-label={copy.closeConflicts} className={styles.overlayBackdrop} onClick={() => setConflictListOpen(false)} type="button" />
          <section className={styles.conflictListPanel} role="dialog" aria-modal="true" aria-labelledby="mould-conflict-list-title">
            <header>
              <div>
                <span><AlertTriangle aria-hidden="true" size={21} />{copy.dataIssues}</span>
                <h2 id="mould-conflict-list-title">{copy.conflictListTitle}</h2>
                <p>{copy.conflictListHint}</p>
              </div>
              <div className={styles.conflictSummary}>
                <span>{copy.duplicateLocations}<strong>{conflictGroups.length}</strong></span>
                <span>{copy.outsideLayout}<strong>{unmappedStorageMoulds.length}</strong></span>
              </div>
              <button aria-label={copy.closeConflicts} onClick={() => setConflictListOpen(false)} title={copy.closeConflicts} type="button"><X aria-hidden="true" size={24} /></button>
            </header>
            <div className={styles.conflictListBody}>
              {displayedConflictGroups.map(([locationCode, occupants]) => (
                <article className={styles.conflictGroup} key={locationCode}>
                  <header>
                    <span><MapPin aria-hidden="true" size={18} /><strong>{localizedMachineText(locationCode, language)}</strong></span>
                    <i>{occupants[0]?.location.kind === "machine" ? copy.machineConflict : copy.duplicateLocations}<b>{occupants.length}</b></i>
                  </header>
                  <p>{copy.conflictNeedsMesFix}</p>
                  <div>
                    {occupants.map((mould) => (
                      <button key={mould.instanceId} onClick={() => selectMould(mould.instanceId)} type="button">
                        <span><strong>{mould.mouldCode}</strong><small>{text(mould.assetCode)}</small></span>
                        <span><small>{copy.drawingNo}</small><b>{text(mould.drawingNo)}</b></span>
                        <span><small>{copy.model}</small><b>{text(mould.model)}</b></span>
                        <span><small>{copy.finalChangedAt}</small><b>{dateTime(mould.finalChangedAt, language, copy.noTimestamp)}</b></span>
                      </button>
                    ))}
                  </div>
                </article>
              ))}
              {displayedUnmappedMoulds.map((mould) => (
                <article className={`${styles.conflictGroup} ${styles.unmappedGroup}`} key={`unmapped-${mould.instanceId}`}>
                  <header>
                    <span><MapPin aria-hidden="true" size={18} /><strong>{text(mould.location.code, copy.unknown)}</strong></span>
                    <i>{copy.outsideLayout}</i>
                  </header>
                  <button className={styles.unmappedMouldButton} onClick={() => selectMould(mould.instanceId)} type="button">
                    <span><strong>{mould.mouldCode}</strong><small>{text(mould.name)}</small></span>
                    <span><small>{copy.drawingNo}</small><b>{text(mould.drawingNo)}</b></span>
                    <span><small>{copy.model}</small><b>{text(mould.model)}</b></span>
                  </button>
                </article>
              ))}
              {!displayedConflictGroups.length && !displayedUnmappedMoulds.length ? <div className={styles.emptyHistory}>{copy.noMoulds}</div> : null}
            </div>
          </section>
        </>
      ) : null}

      {verificationMachine ? (
        <>
          <button aria-label={copy.closeVerification} className={styles.overlayBackdrop} onClick={() => setVerificationMachineNumber(null)} type="button" />
          <section className={styles.machineVerificationPanel} role="dialog" aria-modal="true" aria-labelledby="machine-verification-title">
            <header>
              <div>
                <span><BadgeCheck aria-hidden="true" size={22} />{copy.verifyMould}</span>
                <h2 id="machine-verification-title">{machineDisplayLabel(verificationMachine.number, verificationMachine.tonnage, language)}</h2>
                <p>{copy.verifyHint}</p>
              </div>
              <button aria-label={copy.closeVerification} onClick={() => setVerificationMachineNumber(null)} title={copy.closeVerification} type="button"><X aria-hidden="true" size={26} /></button>
            </header>
            <div className={styles.verificationComparison}>
              <article>
                <small>{copy.installedMould}</small>
                {verificationMoulds.length ? verificationMoulds.map((mould) => (
                  <button key={mould.instanceId} onClick={() => selectMould(mould.instanceId)} type="button">
                    <strong>{mould.mouldCode}</strong>
                    <span>{text(mould.model)}</span>
                    <small>{text(mould.drawingNo, mould.assetCode)}</small>
                  </button>
                )) : <><strong>{copy.unassigned}</strong><span>-</span></>}
              </article>
              <article>
                <small>{copy.expectedModel}</small>
                <strong>{verificationProduction?.model || copy.noProductionModel}</strong>
                <span>{verificationProduction?.date || "-"}</span>
                {verificationProduction?.partNos.length ? (
                  <span className={styles.verificationPartNos}>
                    {verificationProduction.partNos.map((partNo) => <b key={partNo}>{partNo}</b>)}
                  </span>
                ) : null}
                <small>
                  {productionBasisLabel(verificationProduction, copy)}
                  {verificationProduction?.mode === "multi_cavity" ? ` · ${verificationProduction.partNos.length} ${copy.partCount} · ${verificationProduction.cavityPattern || copy.cavityProduction}` : ""}
                </small>
              </article>
            </div>
            <div className={`${styles.verificationResult} ${validationClass(verificationResult)}`}>
              <strong>{validationLabel(verificationResult, copy)}</strong>
              {verificationResult === "conflict" ? <span>{copy.conflictNeedsMesFix}</span> : null}
              {verificationResult === "mould_missing" ? <span>{copy.paperworkRequired}</span> : null}
              {verificationAutomaticResult === "mismatch" && !verificationRule ? <span>{copy.modelMismatchNeedsMesFix}</span> : null}
              {verificationCanDecide && !verificationRule ? <span>{copy.decisionRuleNotice}</span> : null}
            </div>
            {verificationRule ? (
              <div className={styles.verificationAcknowledgement}>
                <BadgeCheck aria-hidden="true" size={18} />
                <span>
                  <strong>{copy.fieldConfirmed}</strong>
                  <small>{validationLabel(verificationResult, copy)} · {copy.confirmedAt} {dateTime(verificationRule.confirmedAt, language, copy.noTimestamp)}</small>
                </span>
              </div>
            ) : null}
            {!verificationMoulds.length && verificationResult === "mould_missing" ? (
              <div className={styles.verificationCandidates}>
                <h3><MapPin aria-hidden="true" size={20} />{copy.storageCandidate}</h3>
                <p>{copy.suggestionOnly}</p>
                {verificationCandidates.length ? verificationCandidates.map((candidate) => (
                  <button key={candidate.mould.instanceId} onClick={() => selectMould(candidate.mould.instanceId)} type="button">
                    <span><small>{copy.currentLocation}</small><strong>{displayLocation(candidate.mould)}</strong></span>
                    <span><b>{candidate.mould.mouldCode}</b><small>{candidate.candidateModel} · {text(candidate.mould.assetCode, candidate.mould.drawingNo)}</small></span>
                    <span><small>{copy.matchedPrefix}</small><b>{candidate.matchedPrefix}</b></span>
                  </button>
                )) : <p>{copy.noStorageCandidate}</p>}
              </div>
            ) : null}
            <footer>
              {verificationMould ? <button className={styles.secondaryVerificationAction} onClick={() => selectMould(verificationMould.instanceId)} type="button">{copy.openMouldDetail}</button> : <span>{verificationResult === "mould_missing" ? copy.paperworkRequired : copy.noInstalledMouldDetail}</span>}
              {verificationCanDecide ? (
                <div className={styles.machineDecisionActions}>
                  {verificationRule ? (
                    <button
                      className={styles.resetVerificationAction}
                      disabled={!canConfirmUsage || machineValidationMutation.isPending}
                      onClick={resetMachineDecision}
                      type="button"
                    >
                      {copy.resetDecision}
                    </button>
                  ) : null}
                  <button
                    className={styles.primaryVerificationAction}
                    data-selected={verificationRule?.decision === "match"}
                    disabled={!canConfirmUsage || machineValidationMutation.isPending || verificationRule?.decision === "match"}
                    onClick={() => saveMachineDecision("match")}
                    title={canConfirmUsage ? copy.decideMatch : copy.confirmLogin}
                    type="button"
                  >
                    <BadgeCheck aria-hidden="true" size={22} />{machineValidationMutation.isPending ? copy.savingDecision : copy.decideMatch}
                  </button>
                  <button
                    className={styles.negativeVerificationAction}
                    data-selected={verificationRule?.decision === "mismatch"}
                    disabled={!canConfirmUsage || machineValidationMutation.isPending || verificationRule?.decision === "mismatch"}
                    onClick={() => saveMachineDecision("mismatch")}
                    title={canConfirmUsage ? copy.decideMismatch : copy.confirmLogin}
                    type="button"
                  >
                    <X aria-hidden="true" size={21} />{machineValidationMutation.isPending ? copy.savingDecision : copy.decideMismatch}
                  </button>
                </div>
              ) : null}
              {verificationCanDecide && !canConfirmUsage ? <small>{copy.confirmLogin}</small> : null}
              {verificationCanDecide && machineValidationMutation.isError ? <small role="alert">{copy.decisionError}</small> : null}
            </footer>
          </section>
        </>
      ) : null}

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
                      <td data-label={copy.status}>{text(mould.statusLabel, copy.unknown)}</td>
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
            <div className={styles.drawerIdentity}>
              <Boxes aria-hidden="true" size={24} />
              <span>
                <small>{copy.selectedMould}</small>
                <strong id="selected-mould-title">{selectedDetail?.mouldCode || "-"}</strong>
                <em>{selectedDetail ? `${text(selectedDetail.name)} · ${text(selectedDetail.assetCode)}` : copy.selectMould}</em>
              </span>
            </div>
            {selectedDetail ? (
              <div className={styles.drawerQuickBadges}>
                <span>{text(selectedDetail.statusLabel, copy.unknown)}</span>
                <span>{displayLocation(selectedDetail)}</span>
                {selectedDetail.shotMilestone > 0 ? <span className={selectedDetail.confirmationRequired ? styles.summaryBadgeDue : styles.summaryBadgeConfirmed}>{milestoneLabel(selectedDetail.shotMilestone, language)} · {selectedDetail.confirmationRequired ? copy.checkpointRequired : copy.checkpointConfirmed}</span> : null}
              </div>
            ) : null}
            <button aria-label={copy.closeDetail} onClick={() => setDetailOpen(false)} title={copy.closeDetail} type="button"><X aria-hidden="true" size={22} /></button>
          </div>
          <section className={styles.detailPanel}>
            {selectedDetail ? (
              <>
                <aside className={styles.selectedSummary}>
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
