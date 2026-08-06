import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, FileSpreadsheet, Pencil, X } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { ko, zhCN } from "date-fns/locale";
import {
  getProductionPlanDates,
  getProductionPlanChangeLogs,
  getProductionPlanItems,
  updateProductionPartCavityGroup,
  updateProductionPlanItem,
  uploadProductionPlanFile,
  type PlanType,
  type ProductionPlanChangeLog,
  type ProductionPlanRecord,
} from "@/domains/production/api";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { PageHeaderIcon } from "@/shared/components/PageHeader";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { getSeoulDateString } from "@/shared/utils/date";
import { CalendarChevron } from "@/components/common/CalendarChevron";

type UploadStatus = {
  tone: "success" | "error";
  message: string;
};

type PlanEditDraft = {
  machine_name: string;
  part_no: string;
  model_name: string;
  lot_no: string;
  planned_quantity: string;
};

type MachinePlanGroup = {
  key: string;
  machineName: string;
  totalQty: number;
  records: ProductionPlanRecord[];
};

type PlanSnapshot = Record<PlanType, ProductionPlanRecord[]>;

type PlanChangeKind = "added" | "removed" | "changed" | "unchanged";

type PlanComparableRow = {
  key: string;
  machineName: string;
  partNo: string;
  modelName: string;
  lotNo: string;
  quantity: number;
  count: number;
};

type PlanChangeItem = {
  kind: PlanChangeKind;
  machineName: string;
  before?: PlanComparableRow;
  after?: PlanComparableRow;
  beforeQty: number;
  afterQty: number;
  deltaQty: number;
};

type MachineChangeSummary = {
  machineName: string;
  beforeQty: number;
  afterQty: number;
  deltaQty: number;
  added: number;
  removed: number;
  changed: number;
  items: PlanChangeItem[];
};

type ProcessChangeSummary = {
  planType: PlanType;
  beforeTotal: number;
  afterTotal: number;
  deltaTotal: number;
  machines: MachineChangeSummary[];
};

type UploadChangeReport = {
  date: string;
  processes: ProcessChangeSummary[];
};

type LocalSamplePlan = {
  date: string;
  plans: PlanSnapshot;
};

type DraggedJob = {
  orderKey: string;
  recordKey: string;
};

type DropPreview = {
  orderKey: string;
  recordKey: string;
  position: "before" | "after";
};

type CavityRowDraft = {
  parts: string;
  cavity: string;
  partners: string[];
};

type CavityEditState = {
  draft: CavityRowDraft;
  parts: number;
  cavity: number;
  partNos: string[];
  impactRows: CavityImpactRow[];
  hasQuantityMismatch: boolean;
  missingPartners: boolean;
  hasInvalidMachinePartner: boolean;
};

type CavityImpactRow = {
  partNo: string;
  quantity: number;
};

const cavityGroupColors = ["#008ec3", "#00a65a", "#7c3aed", "#f97316", "#0f766e", "#db2777"];
const cavityUiCopy = {
  ko: {
    group: "캐비티 묶음",
    select: "Part No. 선택",
    apply: "적용",
    clear: "선택 해제",
    row: "캐비티 묶음 행 선택",
    linked: "묶음",
    partner: "함께 생산 Part No.",
    partnerHint: "선택한 Part No.가 동일 사출 사이클에서 함께 생산됩니다.",
    invalidMachine: "같은 사출기 내 Part No.를 선택하세요.",
    partsTogether: "Part 동시",
    save: "저장",
    saving: "저장 중",
    needPartner: "함께 생산되는 Part No. 선택 필요",
  },
  zh: {
    group: "型腔组合",
    select: "选择 Part No.",
    apply: "应用",
    clear: "取消选择",
    row: "选择型腔组合行",
    linked: "组合",
    partner: "共同生产 Part No.",
    partnerHint: "所选 Part No. 将在同一注塑周期内共同生产。",
    invalidMachine: "请选择同一注塑机内的 Part No.",
    partsTogether: "个 Part 同时",
    save: "保存",
    saving: "保存中",
    needPartner: "需要选择共同生产的 Part No.",
  },
} satisfies Record<AppLanguage, {
  group: string;
  select: string;
  apply: string;
  clear: string;
  row: string;
  linked: string;
  partner: string;
  partnerHint: string;
  invalidMachine: string;
  partsTogether: string;
  save: string;
  saving: string;
  needPartner: string;
}>;

const pageCopy = {
  ko: {
    eyebrow: "생산관리",
    title: "생산 계획 업데이트",
    description: "생산 계획을 업로드 하여 업데이트 합니다.",
    planDate: "기준일",
    goDashboard: "대시보드로 가기",
    process: "공정",
    injection: "사출",
    machining: "가공",
    plannedQty: "계획 수량",
    activeMachines: "계획 배정 설비/라인",
    planRows: "작업 지시 수",
    totalHint: "선택 기준일의 총 계획 수량",
    machineHint: "계획이 배정된 설비와 라인 수",
    rowHint: "생산 지시 기준의 상세 작업 수",
    uploadTitle: "일자별 생산계획 업데이트",
    updateTarget: "업데이트 대상",
    updateMethod: "저장 방식",
    lastUpdate: "Last update",
    noLastUpdate: "변경 이력 없음",
    changeLog: "변경 로그",
    changeLogTitle: "생산계획 변경 로그",
    changeLogDescription: "선택 기준일의 업로드, 직접 수정, 순서 변경 이력입니다.",
    noChangeLogs: "선택 기준일의 변경 로그가 없습니다.",
    changedBy: "수정자",
    changeActionUpload: "업로드",
    changeActionCreate: "생성",
    changeActionUpdate: "수정",
    changeActionReorder: "순서",
    changeActionDelete: "삭제",
    latestSheetRule: "파일 내 최신 날짜 시트",
    replaceRule: "선택한 파일의 공정만 새 파일 기준으로 교체됩니다.",
    uploadSection: "업로드",
    openUpload: "생산계획 업로드",
    loadLocalSample: "샘플 계획 보기",
    localSampleLoaded: "로컬 샘플 생산계획을 표시했습니다. 서버에는 저장되지 않습니다.",
    cavityAutoApply: "저장 시 묶인 Part No. 모두 {pattern} Cavity로 저장됩니다.",
    cavityQuantityGuide: "동시생산 품목은 계획 수량과 순서를 같은 사출기 내에서 맞춰주세요.",
    cavityQuantityMismatch: "수량 확인 필요",
    close: "닫기",
    dashboardSection: "현황",
    machinesSection: "설비",
    modelsSection: "모델",
    detailsSection: "상세",
    injectionFile: "사출 계획 파일",
    machiningFile: "가공 계획 파일",
    uploadFile: "계획 파일",
    chooseFile: "파일 선택",
    dropFile: "파일을 여기에 끌어다 놓기",
    fileHint: "xlsx 또는 xls",
    uploadButton: "계획 업데이트",
    uploading: "업로드 중",
    uploadProgressTitle: "계획 파일을 분석하고 저장하는 중입니다.",
    uploadProgressHint: "파일 분석, 기존 계획 비교, 백엔드 저장을 순서대로 진행합니다.",
    noFile: "사출 또는 가공 계획 파일을 하나 이상 선택해주세요.",
    uploadSuccess: "업로드가 완료되었습니다.",
    uploadError: "업로드에 실패했습니다.",
    changeReportEyebrow: "업데이트 결과",
    changeReportTitle: "업로드 변경 확인",
    changeReportDescription: "업로드 전 계획과 새 계획을 비교했습니다.",
    before: "기존",
    after: "변경",
    delta: "차이",
    added: "추가",
    removed: "삭제",
    changed: "수량 변경",
    unchanged: "변동 없음",
    partRow: "Part No",
    beforeQty: "기존 수량",
    afterQty: "신규 수량",
    noChanges: "변경된 작업 지시가 없습니다.",
    closeChangeReport: "확인",
    dashboardTitle: "생산 계획 현황",
    dashboardMeta: "설비/라인별 생산 예정 순서",
    equipmentCompare: "설비/라인별 계획 비교",
    machineSummary: "설비별 계획",
    modelSummary: "모델별 계획",
    planDetails: "계획 상세",
    sequence: "순서",
    dragHint: "드래그로 순서 변경",
    orderChanged: "순서 변경됨",
    saveOrder: "확인 및 저장",
    savingOrder: "저장 중",
    noMachineData: "설비별 계획이 없습니다.",
    noModelData: "모델별 계획이 없습니다.",
    noRows: "선택한 조건의 계획 행이 없습니다.",
    machine: "설비",
    partNo: "Part No",
    model: "모델",
    lot: "Lot",
    qty: "수량",
    cavity: "Cavity",
    action: "수정",
    edit: "수정",
    save: "저장",
    cancel: "취소",
    cavitySettings: "캐비티 및 동시생산",
    rowUpdateError: "작업 지시를 저장하지 못했습니다. 입력값을 확인한 뒤 다시 시도해주세요.",
    lineRow: "라인/행",
    unsetMachine: "미지정 설비",
    unsetModel: "모델 미지정",
  },
  zh: {
    eyebrow: "生产管理",
    title: "生产计划更新",
    description: "上传生产计划并更新。",
    planDate: "基准日",
    goDashboard: "前往看板",
    process: "工序",
    injection: "注塑",
    machining: "加工",
    plannedQty: "计划数量",
    activeMachines: "已排设备/产线",
    planRows: "作业指示数",
    totalHint: "所选基准日的总计划数量",
    machineHint: "已排计划的设备和产线数",
    rowHint: "按生产指示统计的明细作业数",
    uploadTitle: "更新每日生产计划",
    updateTarget: "更新对象",
    updateMethod: "保存方式",
    lastUpdate: "Last update",
    noLastUpdate: "暂无变更记录",
    changeLog: "变更日志",
    changeLogTitle: "生产计划变更日志",
    changeLogDescription: "所选基准日的上传、手动修改和顺序调整记录。",
    noChangeLogs: "所选基准日暂无变更日志。",
    changedBy: "修改人",
    changeActionUpload: "上传",
    changeActionCreate: "新建",
    changeActionUpdate: "修改",
    changeActionReorder: "顺序",
    changeActionDelete: "删除",
    latestSheetRule: "文件内最新日期工作表",
    replaceRule: "仅按已选择文件的工序替换现有计划。",
    uploadSection: "上传",
    openUpload: "上传生产计划",
    loadLocalSample: "查看样例计划",
    localSampleLoaded: "已显示本地样例生产计划，未保存到服务器。",
    cavityAutoApply: "保存时，已组合的 Part No. 都会保存为 {pattern} Cavity。",
    cavityQuantityGuide: "共同生产项目需要在同一注塑机内对齐计划数量和顺序。",
    cavityQuantityMismatch: "需要确认数量",
    close: "关闭",
    dashboardSection: "现况",
    machinesSection: "设备",
    modelsSection: "型号",
    detailsSection: "明细",
    injectionFile: "注塑计划文件",
    machiningFile: "加工计划文件",
    uploadFile: "计划文件",
    chooseFile: "选择文件",
    dropFile: "将文件拖放到这里",
    fileHint: "xlsx 或 xls",
    uploadButton: "更新计划",
    uploading: "上传中",
    uploadProgressTitle: "正在分析并保存计划文件。",
    uploadProgressHint: "依次进行文件分析、原计划对比和后端保存。",
    noFile: "请至少选择一个注塑或加工计划文件。",
    uploadSuccess: "上传完成。",
    uploadError: "上传失败。",
    changeReportEyebrow: "更新结果",
    changeReportTitle: "确认上传变更",
    changeReportDescription: "已对比上传前计划和新计划。",
    before: "原计划",
    after: "新计划",
    delta: "差异",
    added: "新增",
    removed: "删除",
    changed: "数量变更",
    unchanged: "无变化",
    partRow: "Part No",
    beforeQty: "原数量",
    afterQty: "新数量",
    noChanges: "暂无变更的作业指示。",
    closeChangeReport: "确认",
    dashboardTitle: "生产计划现况",
    dashboardMeta: "按设备/产线查看生产顺序",
    equipmentCompare: "设备/产线计划对比",
    machineSummary: "设备计划",
    modelSummary: "型号计划",
    planDetails: "计划明细",
    sequence: "顺序",
    dragHint: "拖拽调整顺序",
    orderChanged: "顺序已变更",
    saveOrder: "确认并保存",
    savingOrder: "保存中",
    noMachineData: "暂无设备计划。",
    noModelData: "暂无型号计划。",
    noRows: "所选条件暂无计划行。",
    machine: "设备",
    partNo: "Part No",
    model: "型号",
    lot: "Lot",
    qty: "数量",
    cavity: "Cavity",
    action: "编辑",
    edit: "编辑",
    save: "保存",
    cancel: "取消",
    cavitySettings: "型腔及共同生产",
    rowUpdateError: "无法保存作业指示，请检查输入内容后重试。",
    lineRow: "产线/行",
    unsetMachine: "未指定设备",
    unsetModel: "未指定型号",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

function formatQuantity(value: number | null | undefined, language: AppLanguage) {
  return new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN").format(
    Math.round(Number(value) || 0),
  );
}

function formatDateTime(value: string | null | undefined, language: AppLanguage) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parsePlanDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

function formatPlanDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPlanDateLabel(value: string, language: AppLanguage) {
  const date = parsePlanDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function getProcessLabel(planType: PlanType, language: AppLanguage) {
  return pageCopy[language][planType];
}

function getChangeActionLabel(action: ProductionPlanChangeLog["action"], copy: Record<string, string>) {
  if (action === "upload") return copy.changeActionUpload;
  if (action === "create") return copy.changeActionCreate;
  if (action === "update") return copy.changeActionUpdate;
  if (action === "reorder") return copy.changeActionReorder;
  return copy.changeActionDelete;
}

function buildLocalSamplePlan(date: string): LocalSamplePlan {
  const updatedAt = `${date}T08:30:00+08:00`;
  const cavityGroup = "AAN30078443+AAN30078444";
  return {
    date,
    plans: {
      injection: [
        {
          id: 900001,
          machine_name: "850T-8",
          model_name: "34GN850P-BC.AEUOMKN",
          part_no: "ABJ76627101",
          lot_no: "6G1M05F2",
          planned_quantity: 237,
          cavity: 1,
          cavity_pattern: "1x1",
          parts_per_shot: 1,
          total_cavity: 1,
          sequence: 1,
          updated_at: updatedAt,
        },
        {
          id: 900002,
          machine_name: "850T-9",
          model_name: "24G411B-BB.AAUYJVN",
          part_no: "ACQ30776301",
          lot_no: "6I1M04VQ",
          planned_quantity: 756,
          cavity: 1,
          cavity_pattern: "1x1",
          parts_per_shot: 1,
          total_cavity: 1,
          sequence: 1,
          updated_at: updatedAt,
        },
        {
          id: 900003,
          machine_name: "850T-9",
          model_name: "24G411B-BB.AWPYJVN",
          part_no: "ACQ30776301",
          lot_no: "6I1M05XJ",
          planned_quantity: 1164,
          cavity: 1,
          cavity_pattern: "1x1",
          parts_per_shot: 1,
          total_cavity: 1,
          sequence: 2,
          updated_at: updatedAt,
        },
        {
          id: 900004,
          machine_name: "650T-10",
          model_name: "65UQ79",
          part_no: "AAN30078443",
          lot_no: "6HPXXL0A",
          planned_quantity: 2520,
          cavity: 2,
          cavity_pattern: "2x2",
          parts_per_shot: 2,
          cavity_group: cavityGroup,
          total_cavity: 4,
          sequence: 1,
          updated_at: updatedAt,
        },
        {
          id: 900005,
          machine_name: "650T-10",
          model_name: "65UQ79",
          part_no: "AAN30078444",
          lot_no: "6HPXXL09",
          planned_quantity: 2520,
          cavity: 2,
          cavity_pattern: "2x2",
          parts_per_shot: 2,
          cavity_group: cavityGroup,
          total_cavity: 4,
          sequence: 2,
          updated_at: updatedAt,
        },
      ],
      machining: [
        {
          id: 901001,
          machine_name: "가공 1라인",
          model_name: "24G411B-BB",
          part_no: "ACQ30776301",
          lot_no: "M-240805-01",
          planned_quantity: 1200,
          sequence: 1,
          updated_at: updatedAt,
        },
        {
          id: 901002,
          machine_name: "가공 2라인",
          model_name: "65UQ79",
          part_no: "AAN30078443",
          lot_no: "M-240805-02",
          planned_quantity: 1800,
          sequence: 1,
          updated_at: updatedAt,
        },
        {
          id: 901003,
          machine_name: "가공 2라인",
          model_name: "65UQ79",
          part_no: "AAN30078444",
          lot_no: "M-240805-03",
          planned_quantity: 1800,
          sequence: 2,
          updated_at: updatedAt,
        },
      ],
    },
  };
}

function getMachineSortNumber(machineName: string) {
  const match = machineName.match(/-(\d+)\s*$/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function parseCavityPattern(value: string | null | undefined, fallbackCavity = 1, fallbackParts = 1) {
  const text = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "").replace("*", "x").replace("×", "x");
  const match = text.match(/^(\d+)x(\d+)$/);
  if (match) {
    return {
      pattern: `${Math.max(1, Number(match[1]) || 1)}x${Math.max(1, Number(match[2]) || 1)}`,
      partsPerShot: Math.max(1, Number(match[1]) || 1),
      cavity: Math.max(1, Number(match[2]) || 1),
    };
  }
  const cavity = Math.max(1, Number(fallbackCavity) || 1);
  const partsPerShot = Math.max(1, Number(fallbackParts) || 1);
  return { pattern: `${partsPerShot}x${cavity}`, partsPerShot, cavity };
}

function applyCavityPatternToPlanRecords(
  records: ProductionPlanRecord[],
  partNos: string[],
  cavityPattern: string,
) {
  const normalizedPartNos = [...new Set(partNos.map((partNo) => partNo.trim().toUpperCase()).filter(Boolean))];
  if (!normalizedPartNos.length) return records;

  const parsed = parseCavityPattern(cavityPattern);
  const partNoSet = new Set(normalizedPartNos);
  const cavityGroup = parsed.partsPerShot > 1 ? normalizedPartNos.join("+") : normalizedPartNos[0];
  const updatedAt = new Date().toISOString();

  return records.map((record) => {
    const partNo = String(record.part_no ?? "").trim().toUpperCase();
    if (!partNoSet.has(partNo)) return record;
    return {
      ...record,
      cavity: parsed.cavity,
      cavity_pattern: parsed.pattern,
      parts_per_shot: parsed.partsPerShot,
      cavity_group: cavityGroup,
      total_cavity: parsed.cavity * parsed.partsPerShot,
      updated_at: updatedAt,
    };
  });
}

function buildMachineGroups(records: ProductionPlanRecord[], unsetMachineLabel: string, planType: PlanType) {
  const groupMap = new Map<string, MachinePlanGroup>();

  for (const record of records) {
    const machineName = record.machine_name || unsetMachineLabel;
    const current = groupMap.get(machineName) ?? {
      key: machineName,
      machineName,
      records: [],
      totalQty: 0,
    };

    current.records.push(record);
    current.totalQty += Number(record.planned_quantity) || 0;
    groupMap.set(machineName, current);
  }

  return [...groupMap.values()].sort((left, right) => {
    if (planType === "injection") {
      const leftMachineNumber = getMachineSortNumber(left.machineName);
      const rightMachineNumber = getMachineSortNumber(right.machineName);
      if (leftMachineNumber !== rightMachineNumber) {
        return leftMachineNumber - rightMachineNumber;
      }
    }

    return left.machineName.localeCompare(right.machineName, "ko-KR", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function normalizePlanText(value: string | null | undefined, fallback = "-") {
  const normalized = (value || "").trim();
  return normalized || fallback;
}

async function inferLatestWorkbookPlanDate(file: File, selectedDate: string) {
  const [selectedYear] = selectedDate.split("-").map(Number);
  if (!selectedYear) return selectedDate;

  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const dateSheets = workbook.SheetNames.flatMap((sheetName) => {
      const match = String(sheetName).match(/^\s*(\d{1,2})-(\d{1,2})\s*$/);
      if (!match) return [];

      const month = Number(match[1]);
      const day = Number(match[2]);
      if (!month || !day) return [];

      const dateValue = new Date(Date.UTC(selectedYear, month - 1, day));
      if (dateValue.getUTCMonth() !== month - 1 || dateValue.getUTCDate() !== day) return [];
      return [dateValue.toISOString().slice(0, 10)];
    });

    return dateSheets.sort().reverse()[0] ?? selectedDate;
  } catch {
    return selectedDate;
  }
}

function buildComparablePlanRows(records: ProductionPlanRecord[], unsetMachineLabel: string) {
  const rowMap = new Map<string, PlanComparableRow>();

  for (const record of records) {
    const machineName = normalizePlanText(record.machine_name, unsetMachineLabel);
    const partNo = normalizePlanText(record.part_no);
    const modelName = normalizePlanText(record.model_name || record.part_spec);
    const lotNo = normalizePlanText(record.lot_no);
    const partKey = partNo !== "-" ? partNo : `${modelName}||${lotNo}`;
    const key = [machineName, partKey].join("||").toUpperCase();
    const current = rowMap.get(key) ?? {
      key,
      machineName,
      partNo,
      modelName,
      lotNo,
      quantity: 0,
      count: 0,
    };

    current.quantity += Number(record.planned_quantity) || 0;
    current.count += 1;
    rowMap.set(key, current);
  }

  return rowMap;
}

function sortMachineChanges(planType: PlanType, machines: MachineChangeSummary[]) {
  return [...machines].sort((left, right) => {
    if (planType === "injection") {
      const leftMachineNumber = getMachineSortNumber(left.machineName);
      const rightMachineNumber = getMachineSortNumber(right.machineName);
      if (leftMachineNumber !== rightMachineNumber) {
        return leftMachineNumber - rightMachineNumber;
      }
    }

    return left.machineName.localeCompare(right.machineName, "ko-KR", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function buildUploadChangeReport(
  date: string,
  planTypes: PlanType[],
  beforeByType: PlanSnapshot,
  afterByType: PlanSnapshot,
  unsetMachineLabel: string,
): UploadChangeReport {
  const processes = planTypes.map((planType) => {
    const beforeRows = buildComparablePlanRows(beforeByType[planType], unsetMachineLabel);
    const afterRows = buildComparablePlanRows(afterByType[planType], unsetMachineLabel);
    const changesByMachine = new Map<string, MachineChangeSummary>();
    const machineTotals = new Map<string, { beforeQty: number; afterQty: number }>();

    for (const row of beforeRows.values()) {
      const current = machineTotals.get(row.machineName) ?? { beforeQty: 0, afterQty: 0 };
      current.beforeQty += row.quantity;
      machineTotals.set(row.machineName, current);
    }

    for (const row of afterRows.values()) {
      const current = machineTotals.get(row.machineName) ?? { beforeQty: 0, afterQty: 0 };
      current.afterQty += row.quantity;
      machineTotals.set(row.machineName, current);
    }

    function getMachineChange(machineName: string) {
      const current = changesByMachine.get(machineName);
      if (current) return current;

      const totals = machineTotals.get(machineName) ?? { beforeQty: 0, afterQty: 0 };
      const next = {
        machineName,
        beforeQty: totals.beforeQty,
        afterQty: totals.afterQty,
        deltaQty: totals.afterQty - totals.beforeQty,
        added: 0,
        removed: 0,
        changed: 0,
        items: [],
      };
      changesByMachine.set(machineName, next);
      return next;
    }

    const allKeys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
    allKeys.forEach((key) => {
      const before = beforeRows.get(key);
      const after = afterRows.get(key);
      const machineName = after?.machineName ?? before?.machineName ?? unsetMachineLabel;
      const beforeQty = before?.quantity ?? 0;
      const afterQty = after?.quantity ?? 0;
      const kind: PlanChangeKind = before && after
        ? beforeQty === afterQty ? "unchanged" : "changed"
        : after ? "added" : "removed";
      const machineChange = getMachineChange(machineName);
      if (kind !== "unchanged") {
        machineChange[kind] += 1;
      }
      machineChange.items.push({
        kind,
        machineName,
        before,
        after,
        beforeQty,
        afterQty,
        deltaQty: afterQty - beforeQty,
      });
    });

    return {
      planType,
      beforeTotal: beforeByType[planType].reduce((sum, row) => sum + (Number(row.planned_quantity) || 0), 0),
      afterTotal: afterByType[planType].reduce((sum, row) => sum + (Number(row.planned_quantity) || 0), 0),
      deltaTotal: 0,
      machines: sortMachineChanges(planType, [...changesByMachine.values()]),
    };
  });

  return {
    date,
    processes: processes.map((process) => ({
      ...process,
      deltaTotal: process.afterTotal - process.beforeTotal,
    })),
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { detail?: string; error?: string } } }).response;
    const message = response?.data?.detail || response?.data?.error;
    if (message === "Authentication credentials were not provided.") {
      return "업로드 권한이 확인되지 않아 저장은 진행하지 않았습니다. 현재 백엔드에 저장된 생산계획을 다시 불러옵니다.";
    }
    return message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export function ProductionPlansPage() {
  const queryClient = useQueryClient();
  const lastAnimatedOrderRef = useRef("");
  const [language] = useStoredLanguage();
  const copy = pageCopy[language];
  const cavityCopy = cavityUiCopy[language];
  const [selectedDate, setSelectedDate] = useState(getSeoulDateString());
  const [isDateCalendarOpen, setIsDateCalendarOpen] = useState(false);
  const dateCalendarRef = useRef<HTMLDivElement>(null);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [injectionFile, setInjectionFile] = useState<File | null>(null);
  const [machiningFile, setMachiningFile] = useState<File | null>(null);
  const [dragTarget, setDragTarget] = useState<PlanType | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [uploadChangeReport, setUploadChangeReport] = useState<UploadChangeReport | null>(null);
  const [isChangeLogOpen, setIsChangeLogOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [editingRowId, setEditingRowId] = useState<number | null>(null);
  const [rowEditError, setRowEditError] = useState("");
  const [pendingOrders, setPendingOrders] = useState<Record<string, string[]>>({});
  const [cavityRowDrafts, setCavityRowDrafts] = useState<Record<string, CavityRowDraft>>({});
  const [draggedJob, setDraggedJob] = useState<DraggedJob | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [localSamplePlan, setLocalSamplePlan] = useState<LocalSamplePlan | null>(null);
  const [editDraft, setEditDraft] = useState<PlanEditDraft>({
    machine_name: "",
    part_no: "",
    model_name: "",
    lot_no: "",
    planned_quantity: "",
  });

  const datesQuery = useQuery({
    queryKey: ["production", "plan-dates"],
    queryFn: getProductionPlanDates,
  });
  const isViewingLocalSample = localSamplePlan?.date === selectedDate;
  const canLoadLocalSample = import.meta.env.DEV;

  const dateOptions = useMemo(() => {
    return [
      ...new Set([
        selectedDate,
        localSamplePlan?.date,
        ...(datesQuery.data?.injection ?? []),
        ...(datesQuery.data?.machining ?? []),
      ]),
    ]
      .filter((date): date is string => Boolean(date))
      .sort()
      .reverse();
  }, [datesQuery.data, localSamplePlan?.date, selectedDate]);

  const dateOptionSet = useMemo(() => new Set(dateOptions), [dateOptions]);

  useEffect(() => {
    if (!isDateCalendarOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!dateCalendarRef.current?.contains(event.target as Node)) {
        setIsDateCalendarOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsDateCalendarOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDateCalendarOpen]);

  useEffect(() => {
    if (!datesQuery.data) return;
    const allDates = [
      localSamplePlan?.date,
      ...datesQuery.data.injection,
      ...datesQuery.data.machining,
    ].filter((date): date is string => Boolean(date)).sort().reverse();
    if (!allDates.length) return;
    if (!allDates.includes(selectedDate)) {
      setSelectedDate(allDates[0]);
    }
  }, [datesQuery.data, localSamplePlan?.date, selectedDate]);

  useEffect(() => {
    setPendingOrders({});
    setCavityRowDrafts({});
    setDraggedJob(null);
    setDropPreview(null);
    setEditingRowId(null);
    setRowEditError("");
  }, [selectedDate]);

  const injectionItemsQuery = useQuery({
    queryKey: ["production", "plan-items", selectedDate, "injection"],
    queryFn: () => getProductionPlanItems(selectedDate, "injection"),
    enabled: Boolean(selectedDate) && !isViewingLocalSample,
  });

  const machiningItemsQuery = useQuery({
    queryKey: ["production", "plan-items", selectedDate, "machining"],
    queryFn: () => getProductionPlanItems(selectedDate, "machining"),
    enabled: Boolean(selectedDate) && !isViewingLocalSample,
  });

  const changeLogsQuery = useQuery({
    queryKey: ["production", "plan-change-logs", selectedDate],
    queryFn: () => getProductionPlanChangeLogs(selectedDate),
    enabled: Boolean(selectedDate) && !isViewingLocalSample,
    retry: false,
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const uploads: Array<{ file: File; planType: PlanType }> = [];
      if (injectionFile) uploads.push({ file: injectionFile, planType: "injection" });
      if (machiningFile) uploads.push({ file: machiningFile, planType: "machining" });

      if (!uploads.length) throw new Error(copy.noFile);

      const uploadTargets = await Promise.all(
        uploads.map(async (upload) => ({
          ...upload,
          targetDate: await inferLatestWorkbookPlanDate(upload.file, selectedDate),
        })),
      );
      const beforeByType: PlanSnapshot = {
        injection: injectionItems,
        machining: machiningItems,
      };
      const beforeEntries = await Promise.all(
        uploadTargets.map(async (upload) => {
          try {
            return [upload.planType, await getProductionPlanItems(upload.targetDate, upload.planType)] as const;
          } catch {
            return [upload.planType, [] as ProductionPlanRecord[]] as const;
          }
        }),
      );
      beforeEntries.forEach(([planType, records]) => {
        beforeByType[planType] = records;
      });

      const responses = [];
      for (const upload of uploadTargets) {
        responses.push(await uploadProductionPlanFile(upload.file, upload.planType, selectedDate));
      }
      return {
        beforeByType,
        responses,
        uploadedTypes: uploadTargets.map((upload) => upload.planType),
        uploadTargetDates: uploadTargets.map((upload) => upload.targetDate),
      };
    },
    onSuccess: async ({ beforeByType, responses, uploadedTypes, uploadTargetDates }) => {
      const nextDate = uploadTargetDates[0]
        || responses.flatMap((response) => [response.target_date, response.plan_date].filter(Boolean) as string[])[0]
        || responses.flatMap((response) => response.available_days ?? [])[0]
        || selectedDate;
      const afterEntries = await Promise.all(
        uploadedTypes.map(async (planType) => [planType, await getProductionPlanItems(nextDate, planType)] as const),
      );
      const afterByType: PlanSnapshot = {
        injection: beforeByType.injection,
        machining: beforeByType.machining,
      };
      afterEntries.forEach(([planType, records]) => {
        afterByType[planType] = records;
      });

      setSelectedDate(nextDate);
      setInjectionFile(null);
      setMachiningFile(null);
      setFileInputKey((value) => value + 1);
      setIsUploadModalOpen(false);
      setUploadStatus({ tone: "success", message: copy.uploadSuccess });
      setUploadChangeReport(
        buildUploadChangeReport(nextDate, uploadedTypes, beforeByType, afterByType, copy.unsetMachine),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["production"] }),
        queryClient.invalidateQueries({ queryKey: ["production-plan-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["production", "plan-change-logs"] }),
        queryClient.invalidateQueries({ queryKey: ["production-mes-report-stats"] }),
      ]);
    },
    onError: async (error) => {
      setUploadStatus({ tone: "error", message: getErrorMessage(error, copy.uploadError) });
      await queryClient.invalidateQueries({ queryKey: ["production"] });
    },
  });

  useEffect(() => {
    if (!uploadMutation.isPending) {
      setUploadProgress(0);
      return;
    }

    const steps = [18, 34, 52, 68, 81, 90, 95];
    let index = 0;
    setUploadProgress(10);
    const timer = window.setInterval(() => {
      setUploadProgress(steps[Math.min(index, steps.length - 1)]);
      index += 1;
    }, 650);

    return () => window.clearInterval(timer);
  }, [uploadMutation.isPending]);

  const updateMutation = useMutation({
    mutationFn: async (variables: {
      id: number;
      planType: PlanType;
      updates: PlanEditDraft;
      cavityUpdate?: { recordKey: string; partNos: string[]; cavityPattern: string };
    }) => {
      const normalizedUpdate = {
        machine_name: variables.updates.machine_name || null,
        part_no: variables.updates.part_no || null,
        model_name: variables.updates.model_name || null,
        lot_no: variables.updates.lot_no || null,
        planned_quantity: Number(variables.updates.planned_quantity) || 0,
      };

      if (isViewingLocalSample) {
        const source = localSamplePlan?.plans[variables.planType].find((record) => record.id === variables.id);
        if (!source) throw new Error(copy.rowUpdateError);
        return {
          ...source,
          ...normalizedUpdate,
          id: variables.id,
          updated_at: new Date().toISOString(),
        } as ProductionPlanRecord;
      }

      const updatedPlan = await updateProductionPlanItem(selectedDate, variables.planType, variables.id, {
        ...normalizedUpdate,
      });
      if (!updatedPlan) throw new Error(copy.rowUpdateError);

      if (variables.cavityUpdate) {
        await updateProductionPartCavityGroup(
          variables.cavityUpdate.partNos,
          variables.cavityUpdate.cavityPattern,
        );
      }

      return updatedPlan;
    },
    onSuccess: async (updatedPlan, variables) => {
      setEditingRowId(null);
      setRowEditError("");
      if (variables.cavityUpdate) {
        setCavityRowDrafts((current) => {
          const next = { ...current };
          delete next[variables.cavityUpdate!.recordKey];
          return next;
        });
      }

      if (isViewingLocalSample) {
        setLocalSamplePlan((current) => {
          if (!current || current.date !== selectedDate) return current;
          const plans = { ...current.plans };
          plans[variables.planType] = plans[variables.planType].map((record) => (
            record.id === variables.id ? updatedPlan : record
          ));
          if (variables.planType === "injection" && variables.cavityUpdate) {
            plans.injection = applyCavityPatternToPlanRecords(
              plans.injection,
              variables.cavityUpdate.partNos,
              variables.cavityUpdate.cavityPattern,
            );
          }
          return { ...current, plans };
        });
        return;
      }

      queryClient.setQueryData<ProductionPlanRecord[]>(
        ["production", "plan-items", selectedDate, variables.planType],
        (records) => (records ?? []).map((record) => (record.id === variables.id ? updatedPlan : record)),
      );
      if (variables.planType === "injection" && variables.cavityUpdate) {
        queryClient.setQueryData<ProductionPlanRecord[]>(
          ["production", "plan-items", selectedDate, "injection"],
          (records) => applyCavityPatternToPlanRecords(
            records ?? [],
            variables.cavityUpdate!.partNos,
            variables.cavityUpdate!.cavityPattern,
          ),
        );
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["production"] }),
        queryClient.invalidateQueries({ queryKey: ["production-plan-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["production", "plan-change-logs"] }),
        queryClient.invalidateQueries({ queryKey: ["production-mes-report-stats"] }),
      ]);
    },
    onError: (error) => {
      setRowEditError(getErrorMessage(error, copy.rowUpdateError));
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (variables: { orderKey: string; planType: PlanType; records: ProductionPlanRecord[] }) => {
      if (isViewingLocalSample) return;
      await Promise.all(
        variables.records.map((record, index) => {
          if (!record.id) return Promise.resolve(null);
          return updateProductionPlanItem(selectedDate, variables.planType, record.id, {
            sequence: index + 1,
          });
        }),
      );
    },
    onSuccess: async (_data, variables) => {
      setPendingOrders((current) => {
        const next = { ...current };
        delete next[variables.orderKey];
        return next;
      });

      if (isViewingLocalSample) {
        setLocalSamplePlan((current) => {
          if (!current || current.date !== selectedDate) return current;
          const orderMap = new Map(variables.records.map((record, index) => [record.id, index + 1]));
          return {
            ...current,
            plans: {
              ...current.plans,
              [variables.planType]: current.plans[variables.planType].map((record) => ({
                ...record,
                sequence: record.id ? orderMap.get(record.id) ?? record.sequence : record.sequence,
              })),
            },
          };
        });
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["production"] }),
        queryClient.invalidateQueries({ queryKey: ["production-plan-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["production", "plan-change-logs"] }),
        queryClient.invalidateQueries({ queryKey: ["production-mes-report-stats"] }),
      ]);
    },
  });

  const injectionItems = isViewingLocalSample ? localSamplePlan?.plans.injection ?? [] : injectionItemsQuery.data ?? [];
  const machiningItems = isViewingLocalSample ? localSamplePlan?.plans.machining ?? [] : machiningItemsQuery.data ?? [];
  const totalInjectionQty = injectionItems.reduce((sum, row) => sum + (Number(row.planned_quantity) || 0), 0);
  const totalMachiningQty = machiningItems.reduce((sum, row) => sum + (Number(row.planned_quantity) || 0), 0);
  const injectionMachineGroups = buildMachineGroups(injectionItems, copy.unsetMachine, "injection");
  const machiningMachineGroups = buildMachineGroups(machiningItems, copy.unsetMachine, "machining");
  const totalPlanQty = totalInjectionQty + totalMachiningQty;
  const totalMachines = injectionMachineGroups.length + machiningMachineGroups.length;
  const totalRows = injectionItems.length + machiningItems.length;
  const latestPlanUpdate = changeLogsQuery.data?.latest_updated_at
    || [...injectionItems, ...machiningItems]
      .map((row) => row.updated_at)
      .filter(Boolean)
      .sort()
      .reverse()[0]
    || null;
  const changeLogs = changeLogsQuery.data?.logs ?? [];

  function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadStatus(null);
    uploadMutation.mutate();
  }

  function handleLoadLocalSample() {
    const sample = buildLocalSamplePlan(getSeoulDateString());
    setLocalSamplePlan(sample);
    setSelectedDate(sample.date);
    setIsDateCalendarOpen(false);
    setIsUploadModalOpen(false);
    setInjectionFile(null);
    setMachiningFile(null);
    setFileInputKey((value) => value + 1);
    setUploadChangeReport(null);
    setUploadStatus({ tone: "success", message: copy.localSampleLoaded });
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>, planType: PlanType) {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    if (planType === "injection") {
      setInjectionFile(file);
      return;
    }

    setMachiningFile(file);
  }

  function startEditingPlanRow(
    row: ProductionPlanRecord,
    recordKey: string,
    records: ProductionPlanRecord[],
  ) {
    if (!row.id) return;
    setRowEditError("");
    setEditingRowId(row.id);
    setCavityRowDrafts((current) => ({
      ...current,
      [recordKey]: getDefaultCavityDraft(row, records),
    }));
    setEditDraft({
      machine_name: row.machine_name || "",
      part_no: row.part_no || "",
      model_name: row.model_name || row.part_spec || "",
      lot_no: row.lot_no || "",
      planned_quantity: String(row.planned_quantity ?? 0),
    });
  }

  function updateEditDraft(key: keyof PlanEditDraft, value: string) {
    setEditDraft((current) => ({ ...current, [key]: value }));
  }

  function cancelEditingPlanRow(recordKey: string) {
    setEditingRowId(null);
    setRowEditError("");
    setCavityRowDrafts((current) => {
      const next = { ...current };
      delete next[recordKey];
      return next;
    });
  }

  function savePlanRow(
    id: number,
    planType: PlanType,
    recordKey: string,
    record: ProductionPlanRecord,
    records: ProductionPlanRecord[],
  ) {
    const cavityState = planType === "injection" ? getCavityEditState(recordKey, record, records) : null;
    if (cavityState?.missingPartners || cavityState?.hasInvalidMachinePartner) return;

    let cavityUpdate: { recordKey: string; partNos: string[]; cavityPattern: string } | undefined;
    if (cavityState) {
      const originalPartNo = getNormalizedPartNo(record);
      const editedPartNo = editDraft.part_no.trim().toUpperCase();
      const partNos = [...new Set(cavityState.partNos.map((partNo) => (
        partNo === originalPartNo ? editedPartNo : partNo
      )).filter(Boolean))];
      cavityUpdate = {
        recordKey,
        partNos,
        cavityPattern: `${cavityState.parts}x${cavityState.cavity}`,
      };
    }

    setRowEditError("");
    updateMutation.mutate({ id, planType, updates: editDraft, cavityUpdate });
  }

  function renderSummaryCard(
    title: string,
    totalValue: string,
    injectionValue: string,
    machiningValue: string,
  ) {
    return (
      <article className="stat-card plan-summary-card">
        <p className="stat-card__title">{title}</p>
        <div className="plan-summary-card__row">
          <strong className="stat-card__value">{totalValue}</strong>
          <div className="plan-summary-card__split">
            <div>
              <span>{copy.injection}</span>
              <strong>{injectionValue}</strong>
            </div>
            <div>
              <span>{copy.machining}</span>
              <strong>{machiningValue}</strong>
            </div>
          </div>
        </div>
      </article>
    );
  }

  function getRecordKey(record: ProductionPlanRecord, index = 0) {
    return record.id ? `id:${record.id}` : `draft:${record.machine_name}:${record.part_no}:${record.lot_no}:${index}`;
  }

  function getOrderKey(planType: PlanType, groupKey: string) {
    return `${planType}:${groupKey}`;
  }

  function getBaseOrderedRecords(records: ProductionPlanRecord[]) {
    return records.map((record, index) => ({ index, record })).sort((left, right) => {
      const leftSequence = left.record.sequence ?? Number.POSITIVE_INFINITY;
      const rightSequence = right.record.sequence ?? Number.POSITIVE_INFINITY;
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return left.index - right.index;
    }).map(({ record }) => record);
  }

  function getOrderedRecords(records: ProductionPlanRecord[], orderKey: string) {
    const baseRecords = getBaseOrderedRecords(records);
    const pendingOrder = pendingOrders[orderKey];
    if (!pendingOrder) return baseRecords;

    const recordMap = new Map(baseRecords.map((record, index) => [getRecordKey(record, index), record]));
    const ordered = pendingOrder.flatMap((recordKey) => {
      const record = recordMap.get(recordKey);
      return record ? [record] : [];
    });
    const orderedKeys = new Set(pendingOrder);
    const remaining = baseRecords.filter((record, index) => !orderedKeys.has(getRecordKey(record, index)));
    return [...ordered, ...remaining];
  }

  function getChangedRecordKeys(records: ProductionPlanRecord[], orderKey: string) {
    const pendingOrder = pendingOrders[orderKey];
    if (!pendingOrder) return new Set<string>();

    const baseKeys = getBaseOrderedRecords(records).map((record, index) => getRecordKey(record, index));
    return new Set(
      pendingOrder.filter((recordKey, index) => recordKey !== baseKeys[index]),
    );
  }

  function moveRecordInGroup(
    orderKey: string,
    records: ProductionPlanRecord[],
    targetRecordKey: string,
    position: "before" | "after",
  ) {
    if (!draggedJob || draggedJob.orderKey !== orderKey || draggedJob.recordKey === targetRecordKey) return;

    const currentOrder = getOrderedRecords(records, orderKey).map((record, index) => getRecordKey(record, index));
    const fromIndex = currentOrder.indexOf(draggedJob.recordKey);
    const toIndex = currentOrder.indexOf(targetRecordKey);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextOrder = [...currentOrder];
    const [movedKey] = nextOrder.splice(fromIndex, 1);
    let insertIndex = position === "after" ? toIndex + 1 : toIndex;
    if (fromIndex < insertIndex) insertIndex -= 1;
    if (fromIndex === insertIndex) return;
    nextOrder.splice(insertIndex, 0, movedKey);

    const orderSignature = `${orderKey}:${nextOrder.join("|")}`;
    if (lastAnimatedOrderRef.current === orderSignature) return;
    lastAnimatedOrderRef.current = orderSignature;
    animateOrderChange(orderKey, () => {
      setPendingOrders((current) => ({ ...current, [orderKey]: nextOrder }));
    });
  }

  function getOrderContainer(orderKey: string) {
    return [...document.querySelectorAll<HTMLElement>("[data-order-key]")]
      .find((element) => element.dataset.orderKey === orderKey) ?? null;
  }

  function animateOrderChange(orderKey: string, updateOrder: () => void) {
    const container = getOrderContainer(orderKey);
    const beforeRects = new Map<string, DOMRect>();
    container?.querySelectorAll<HTMLElement>("[data-record-key]").forEach((element) => {
      const recordKey = element.dataset.recordKey;
      if (recordKey) beforeRects.set(recordKey, element.getBoundingClientRect());
    });

    updateOrder();

    requestAnimationFrame(() => {
      const nextContainer = getOrderContainer(orderKey);
      nextContainer?.querySelectorAll<HTMLElement>("[data-record-key]").forEach((element) => {
        const recordKey = element.dataset.recordKey;
        const before = recordKey ? beforeRects.get(recordKey) : null;
        if (!before) return;

        const after = element.getBoundingClientRect();
        const deltaX = before.left - after.left;
        const deltaY = before.top - after.top;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

        element.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)`, filter: "brightness(1.05)" },
            { transform: "translate(0, 0)", filter: "brightness(1)" },
          ],
          {
            duration: 220,
            easing: "cubic-bezier(0.2, 0.85, 0.22, 1)",
          },
        );
      });
    });
  }

  function createDragPreview(event: DragEvent<HTMLLIElement>) {
    const preview = event.currentTarget.cloneNode(true) as HTMLElement;
    preview.classList.add("schedule-drag-preview");
    preview.style.width = `${event.currentTarget.offsetWidth}px`;
    document.body.appendChild(preview);
    event.dataTransfer.setDragImage(preview, 24, 22);
    window.setTimeout(() => preview.remove(), 0);
  }

  function saveOrderChanges(orderKey: string, planType: PlanType, records: ProductionPlanRecord[]) {
    reorderMutation.mutate({ orderKey, planType, records: getOrderedRecords(records, orderKey) });
  }

  function getNormalizedPartNo(record: ProductionPlanRecord | undefined) {
    return String(record?.part_no ?? "").trim().toUpperCase();
  }

  function getRecordCavityGroupKey(record: ProductionPlanRecord | undefined) {
    if (!record) return "";
    const parsed = parseCavityPattern(record.cavity_pattern ?? null, Number(record.cavity ?? 1), Number(record.parts_per_shot ?? 1));
    const partNo = getNormalizedPartNo(record);
    const groupKey = String(record.cavity_group ?? "").trim().toUpperCase();
    if (parsed.partsPerShot <= 1 || !groupKey || groupKey === partNo) return "";
    return groupKey;
  }

  function getCavityGroupPartNos(record: ProductionPlanRecord, records: ProductionPlanRecord[]) {
    const groupKey = getRecordCavityGroupKey(record);
    const currentPartNo = getNormalizedPartNo(record);
    if (!groupKey) return [];
    const partNosFromGroupKey = groupKey
      .split("+")
      .map((partNo) => partNo.trim().toUpperCase())
      .filter((partNo) => partNo && partNo !== currentPartNo);
    if (partNosFromGroupKey.length) {
      return [...new Set(partNosFromGroupKey)];
    }
    return [
      ...new Set(
        records
          .filter((candidate) => getRecordCavityGroupKey(candidate) === groupKey)
          .map(getNormalizedPartNo)
          .filter((partNo) => partNo && partNo !== currentPartNo),
      ),
    ];
  }

  function getDefaultCavityDraft(record: ProductionPlanRecord, records: ProductionPlanRecord[]): CavityRowDraft {
    const parsed = parseCavityPattern(record.cavity_pattern ?? null, Number(record.cavity ?? 1), Number(record.parts_per_shot ?? 1));
    return {
      parts: String(parsed.partsPerShot),
      cavity: String(parsed.cavity),
      partners: getCavityGroupPartNos(record, records),
    };
  }

  function getCavityDraft(recordKey: string, record: ProductionPlanRecord, records: ProductionPlanRecord[]) {
    return cavityRowDrafts[recordKey] ?? getDefaultCavityDraft(record, records);
  }

  function updateCavityDraft(recordKey: string, patch: Partial<CavityRowDraft>, baseDraft?: CavityRowDraft) {
    setCavityRowDrafts((current) => ({
      ...current,
      [recordKey]: {
        ...(current[recordKey] ?? baseDraft ?? { parts: "1", cavity: "1", partners: [] }),
        ...patch,
      },
    }));
  }

  function normalizeCavityNumber(value: string) {
    return value.replace(/[^\d]/g, "").slice(0, 2);
  }

  function getCavityPartOptions(record: ProductionPlanRecord, records: ProductionPlanRecord[]) {
    const currentPartNo = getNormalizedPartNo(record);
    const seen = new Set<string>();
    return records.flatMap((candidate) => {
      const partNo = getNormalizedPartNo(candidate);
      if (!partNo || partNo === currentPartNo || seen.has(partNo)) return [];
      seen.add(partNo);
      return [{
        partNo,
        label: `${candidate.model_name || candidate.part_spec || copy.unsetModel} · ${partNo}`,
      }];
    });
  }

  function getCavityImpactRows(record: ProductionPlanRecord, records: ProductionPlanRecord[], partNos: string[]) {
    const originalPartNo = getNormalizedPartNo(record);
    const editedPartNo = editDraft.part_no.trim().toUpperCase() || originalPartNo;
    const seen = new Set<string>();

    return partNos.flatMap((partNo) => {
      const normalizedPartNo = partNo === originalPartNo ? editedPartNo : partNo.trim().toUpperCase();
      if (!normalizedPartNo || seen.has(normalizedPartNo)) return [];
      seen.add(normalizedPartNo);

      const sourceRecord = normalizedPartNo === editedPartNo
        ? record
        : records.find((candidate) => getNormalizedPartNo(candidate) === normalizedPartNo);
      const quantity = normalizedPartNo === editedPartNo
        ? Number(editDraft.planned_quantity) || 0
        : Number(sourceRecord?.planned_quantity) || 0;

      return [{ partNo: normalizedPartNo, quantity }];
    });
  }

  function getCavityNumbers(draft: CavityRowDraft) {
    const parts = Math.max(1, Number(draft.parts) || 1);
    const cavity = Math.max(1, Number(draft.cavity) || 1);
    return { parts, cavity };
  }

  function getCavitySubmissionPartNos(record: ProductionPlanRecord, records: ProductionPlanRecord[], draft: CavityRowDraft) {
    const currentPartNo = getNormalizedPartNo(record);
    const { parts } = getCavityNumbers(draft);
    if (parts > 1) {
      return [currentPartNo, ...draft.partners.slice(0, parts - 1)].filter(Boolean);
    }

    const groupKey = getRecordCavityGroupKey(record);
    if (!groupKey) return [currentPartNo].filter(Boolean);
    return [...new Set([currentPartNo, ...getCavityGroupPartNos(record, records)].filter(Boolean))];
  }

  function getCavityEditState(
    recordKey: string,
    record: ProductionPlanRecord,
    records: ProductionPlanRecord[],
  ): CavityEditState {
    const draft = getCavityDraft(recordKey, record, records);
    const { parts, cavity } = getCavityNumbers(draft);
    const partNos = getCavitySubmissionPartNos(record, records, draft);
    const requiredPartners = Math.max(0, parts - 1);
    const options = getCavityPartOptions(record, records);
    const validPartNos = new Set(options.map((option) => option.partNo));
    const impactRows = getCavityImpactRows(record, records, partNos);
    const firstQuantity = impactRows[0]?.quantity ?? 0;
    return {
      draft,
      parts,
      cavity,
      partNos,
      impactRows,
      hasQuantityMismatch: parts > 1 && impactRows.length > 1 && impactRows.some((row) => row.quantity !== firstQuantity),
      missingPartners: requiredPartners > 0 && draft.partners.length < requiredPartners,
      hasInvalidMachinePartner: draft.partners.some((partNo) => !validPartNos.has(partNo)),
    };
  }

  function buildCavityGroupColorMap(records: ProductionPlanRecord[]) {
    const counts = new Map<string, number>();
    records.forEach((record) => {
      const groupKey = getRecordCavityGroupKey(record);
      if (groupKey) counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
    });

    const colorMap = new Map<string, string>();
    [...counts.entries()].forEach(([groupKey, count]) => {
      if (count > 1) {
        colorMap.set(groupKey, cavityGroupColors[colorMap.size % cavityGroupColors.length]);
      }
    });
    return colorMap;
  }

  function getCavityGroupColor(record: ProductionPlanRecord, colorMap: Map<string, string>) {
    const groupKey = getRecordCavityGroupKey(record);
    return groupKey ? colorMap.get(groupKey) : undefined;
  }

  function renderCavityInlineEditor(recordKey: string, record: ProductionPlanRecord, records: ProductionPlanRecord[]) {
    const cavityState = getCavityEditState(recordKey, record, records);
    const { draft, parts, cavity, impactRows, hasQuantityMismatch, missingPartners, hasInvalidMachinePartner } = cavityState;
    const requiredPartners = Math.max(0, parts - 1);
    const options = getCavityPartOptions(record, records);
    const patternLabel = `${parts}x${cavity}`;
    const shouldShowImpact = parts > 1 && impactRows.length > 1 && !missingPartners && !hasInvalidMachinePartner;

    return (
      <div className="cavity-inline-editor">
        <div className="cavity-inline-editor__inputs" aria-label={copy.cavity}>
          <input
            aria-label={`${copy.cavity} part count`}
            inputMode="numeric"
            min="1"
            onChange={(event) => {
              const nextParts = normalizeCavityNumber(event.target.value);
              const nextCount = Math.max(1, Number(nextParts) || 1);
              updateCavityDraft(recordKey, {
                parts: nextParts,
                partners: draft.partners.slice(0, Math.max(0, nextCount - 1)),
              }, draft);
            }}
            value={draft.parts}
          />
          <span>x</span>
          <input
            aria-label={`${copy.cavity} count`}
            inputMode="numeric"
            min="1"
            onChange={(event) => updateCavityDraft(recordKey, { cavity: normalizeCavityNumber(event.target.value) }, draft)}
            value={draft.cavity}
          />
        </div>
        {requiredPartners > 0 ? (
          <label className="cavity-inline-editor__partner">
            <span>{cavityCopy.partner}</span>
            <select
              multiple={requiredPartners > 1}
              onChange={(event) => {
                const selected = [...event.currentTarget.selectedOptions].map((option) => option.value).slice(0, requiredPartners);
                updateCavityDraft(recordKey, { partners: selected }, draft);
              }}
              size={requiredPartners > 1 ? Math.min(3, Math.max(2, options.length)) : undefined}
              value={requiredPartners > 1 ? draft.partners : draft.partners[0] ?? ""}
            >
              {requiredPartners === 1 ? <option value="">{cavityCopy.select}</option> : null}
              {options.map((option) => (
                <option key={option.partNo} value={option.partNo}>{option.label}</option>
              ))}
            </select>
            {hasInvalidMachinePartner ? (
              <small className="cavity-inline-editor__warning" role="alert">{cavityCopy.invalidMachine}</small>
            ) : missingPartners ? (
              <small className="cavity-inline-editor__warning" role="alert">{cavityCopy.needPartner}</small>
            ) : null}
          </label>
        ) : null}
        {shouldShowImpact ? (
          <div
            className={`cavity-inline-editor__impact${hasQuantityMismatch ? " cavity-inline-editor__impact--warning" : ""}`}
            role={hasQuantityMismatch ? "alert" : "note"}
          >
            <span>{copy.cavityAutoApply.replace("{pattern}", patternLabel)}</span>
            <div>
              {impactRows.map((row) => (
                <em key={row.partNo}>
                  {row.partNo} · {patternLabel} · {copy.qty} {formatQuantity(row.quantity, language)}
                </em>
              ))}
            </div>
            <small>
              {hasQuantityMismatch ? `${copy.cavityQuantityMismatch} · ${copy.cavityQuantityGuide}` : copy.cavityQuantityGuide}
            </small>
          </div>
        ) : null}
      </div>
    );
  }

  function renderCavitySummary(record: ProductionPlanRecord, records: ProductionPlanRecord[]) {
    const parsed = parseCavityPattern(
      record.cavity_pattern ?? null,
      Number(record.cavity ?? 1),
      Number(record.parts_per_shot ?? 1),
    );
    const partners = getCavityGroupPartNos(record, records);
    const partnerLabel = partners.length ? partners.join(", ") : cavityCopy.needPartner;

    return (
      <div className="schedule-job__cavity-summary">
        <span className="cavity-summary__pattern" aria-label={`${copy.cavity} ${parsed.cavity}`}>
          <span>{copy.cavity}</span>
          <strong>{parsed.cavity}</strong>
        </span>
        {parsed.partsPerShot > 1 ? (
          <span className="cavity-summary__parts">{parsed.partsPerShot} {cavityCopy.partsTogether}</span>
        ) : null}
        {parsed.partsPerShot > 1 ? (
          <span
            className={`cavity-summary__partners${partners.length ? "" : " cavity-summary__partners--warning"}`}
            title={`${cavityCopy.partner}: ${partnerLabel}`}
          >
            <span>{cavityCopy.partner}</span>
            <strong>{partnerLabel}</strong>
          </span>
        ) : null}
      </div>
    );
  }

  function getPlanSegmentColor(
    index: number,
    planType: PlanType,
    record?: ProductionPlanRecord,
    colorMap?: Map<string, string>,
  ) {
    if (record && colorMap) {
      const cavityColor = getCavityGroupColor(record, colorMap);
      if (cavityColor) return cavityColor;
    }
    const injectionColors = ["#008ec3", "#00a65a", "#55b8dd", "#f7b924", "#4d8fb5", "#67c587"];
    const machiningColors = ["#0f9f7a", "#56b991", "#81c9b0", "#f7b924", "#008ec3", "#93b7c9"];
    const colors = planType === "injection" ? injectionColors : machiningColors;
    return colors[index % colors.length];
  }

  function buildPlanPartSegments(records: ProductionPlanRecord[]) {
    const segments = new Map<string, {
      key: string;
      partNo: string;
      modelName: string;
      lotNo: string;
      quantity: number;
      order: number;
    }>();

    getBaseOrderedRecords(records).forEach((record, index) => {
      const partNo = record.part_no || record.model_name || record.part_spec || copy.unsetModel;
      const key = String(partNo).trim().toUpperCase() || `part-${index}`;
      const current = segments.get(key) ?? {
        key,
        partNo,
        modelName: record.model_name || record.part_spec || copy.unsetModel,
        lotNo: record.lot_no || "-",
        quantity: 0,
        order: index,
      };
      current.quantity += Number(record.planned_quantity) || 0;
      segments.set(key, current);
    });

    return [...segments.values()].sort((left, right) => left.order - right.order);
  }

  function renderEquipmentComparison(planType: PlanType, groups: MachinePlanGroup[], totalQty: number) {
    const maxQty = Math.max(...groups.map((group) => group.totalQty), 1);
    if (!groups.length) return null;

    return (
      <section className="plan-equipment-chart">
        <div className="plan-equipment-chart__header">
          <span>{getProcessLabel(planType, language)}</span>
          <em>{groups.length} {copy.activeMachines} · {formatQuantity(totalQty, language)}</em>
        </div>
        <div className="plan-equipment-bars">
          {groups.map((group, index) => {
            const ratio = Math.max(6, (group.totalQty / maxQty) * 100);
            const segments = buildPlanPartSegments(group.records);

            return (
              <div className="plan-equipment-bar-row" key={`${planType}-${group.key}`}>
                <span>{group.machineName}</span>
                <div className="plan-equipment-bar-track">
                  <div
                    className="plan-equipment-bar-stack"
                    style={{
                      width: `${ratio}%`,
                    }}
                  >
                    {segments.map((segment, segmentIndex) => (
                      <span
                        className="plan-equipment-bar-segment"
                        key={`${group.key}-${segment.key}`}
                        style={{
                          backgroundColor: getPlanSegmentColor(index + segmentIndex, planType),
                          flexGrow: Math.max(segment.quantity, 1),
                        }}
                      />
                    ))}
                  </div>
                </div>
                <em>{formatQuantity(group.totalQty, language)}</em>
                <div className="plan-equipment-hover-card">
                  <div>
                    <span>{group.machineName}</span>
                    <em>{formatQuantity(group.totalQty, language)}</em>
                  </div>
                  <ul>
                    {segments.map((segment, segmentIndex) => (
                      <li key={`${group.key}-${segment.key}-card`}>
                        <i style={{ backgroundColor: getPlanSegmentColor(index + segmentIndex, planType) }} />
                        <span>{segment.partNo}</span>
                        <small>{segment.modelName}</small>
                        <em>{formatQuantity(segment.quantity, language)}</em>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function renderPlanTrack(
    records: ProductionPlanRecord[],
    totalQty: number,
    planType: PlanType,
    cavityColorMap: Map<string, string>,
  ) {
    if (!records.length || totalQty <= 0) return null;

    return (
      <div className="schedule-plan-track" aria-label={copy.dashboardMeta}>
        {records.map((record, index) => {
          const quantity = Number(record.planned_quantity) || 0;
          const share = totalQty > 0 ? quantity / totalQty : 0;
          const tooltip = [
            `${copy.sequence} ${index + 1}`,
            `${copy.partNo}: ${record.part_no || "-"}`,
            `${copy.model}: ${record.model_name || record.part_spec || copy.unsetModel}`,
            `${copy.lot}: ${record.lot_no || "-"}`,
            `${copy.qty}: ${formatQuantity(quantity, language)}`,
          ].join("\n");

          return (
            <div
              className="schedule-plan-segment"
              data-tooltip={tooltip}
              key={`${record.id ?? index}-${record.part_no}-${record.lot_no}-segment`}
              style={{
                backgroundColor: getPlanSegmentColor(index, planType, record, cavityColorMap),
                flexGrow: Math.max(quantity, 1),
                minWidth: share > 0.12 ? 54 : 18,
              }}
            >
              {share > 0.16 ? (
                <span>{formatQuantity(quantity, language)}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  function renderEditField(label: string, field: keyof PlanEditDraft, options: { inputMode?: "numeric"; min?: string } = {}) {
    return (
      <label className="schedule-edit-field">
        <span>{label}</span>
        <input
          autoFocus={field === "part_no"}
          className="table-input"
          inputMode={options.inputMode}
          min={options.min}
          onChange={(event) => updateEditDraft(field, event.target.value)}
          value={editDraft[field]}
        />
      </label>
    );
  }

  function renderScheduleJob(
    item: ProductionPlanRecord,
    planType: PlanType,
    index: number,
    orderKey: string,
    changedRecordKeys: Set<string>,
    groupRecords: ProductionPlanRecord[],
    cavityColorMap: Map<string, string>,
  ) {
    const isEditing = item.id === editingRowId;
    const recordKey = getRecordKey(item, index);
    const isOrderChanged = changedRecordKeys.has(recordKey);
    const isDropTarget = dropPreview?.orderKey === orderKey && dropPreview.recordKey === recordKey;
    const cavityColor = planType === "injection" ? getCavityGroupColor(item, cavityColorMap) : undefined;
    const isCavityGrouped = parseCavityPattern(
      item.cavity_pattern ?? null,
      Number(item.cavity ?? 1),
      Number(item.parts_per_shot ?? 1),
    ).partsPerShot > 1;
    const cavityEditState = isEditing && planType === "injection"
      ? getCavityEditState(recordKey, item, groupRecords)
      : null;
    const isSaveDisabled = updateMutation.isPending
      || !editDraft.part_no.trim()
      || Boolean(cavityEditState?.missingPartners)
      || Boolean(cavityEditState?.hasInvalidMachinePartner);
    const rowStyle = cavityColor ? ({ "--cavity-group-color": cavityColor } as CSSProperties) : undefined;

    return (
      <li
        className={[
          "schedule-job",
          isEditing ? "schedule-job--editing" : "",
          isOrderChanged ? "schedule-job--changed" : "",
          isCavityGrouped ? "schedule-job--cavity-grouped" : "",
          draggedJob?.recordKey === recordKey ? "schedule-job--dragging" : "",
          isDropTarget ? `schedule-job--drop-${dropPreview.position}` : "",
        ].filter(Boolean).join(" ")}
        style={rowStyle}
        draggable={!isEditing && Boolean(item.id)}
        onDragEnter={(event) => {
          if (!draggedJob || draggedJob.orderKey !== orderKey) return;
          event.preventDefault();
        }}
        onDragOver={(event) => {
          if (!draggedJob || draggedJob.orderKey !== orderKey) {
            event.dataTransfer.dropEffect = "none";
            return;
          }

          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
          setDropPreview({ orderKey, recordKey, position });
          moveRecordInGroup(orderKey, groupRecords, recordKey, position);
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", recordKey);
          createDragPreview(event);
          setDraggedJob({ orderKey, recordKey });
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dropPreview?.orderKey === orderKey) {
            moveRecordInGroup(orderKey, groupRecords, recordKey, dropPreview.position);
          }
          setDraggedJob(null);
          setDropPreview(null);
        }}
        onDragEnd={() => {
          setDraggedJob(null);
          setDropPreview(null);
        }}
        key={`${item.id ?? index}-${item.part_no}-${item.lot_no}`}
        data-record-key={recordKey}
      >
        <span className="schedule-job__drag" aria-hidden="true" title={copy.dragHint}>⋮⋮</span>
        {isEditing ? (
          <div className="schedule-job__edit">
            <div className="schedule-job__edit-fields">
              {renderEditField(copy.partNo, "part_no")}
              {renderEditField(copy.model, "model_name")}
              {renderEditField(copy.lot, "lot_no")}
              {renderEditField(copy.qty, "planned_quantity", { inputMode: "numeric" })}
            </div>
            <div className="schedule-job__edit-footer">
              {planType === "injection" ? (
                <div className="schedule-job__edit-cavity">
                  <span>{copy.cavitySettings}</span>
                  {renderCavityInlineEditor(recordKey, item, groupRecords)}
                </div>
              ) : <span />}
              <div className="plan-row-actions">
                <button
                  className="button button--mini button--ghost"
                  disabled={updateMutation.isPending}
                  onClick={() => cancelEditingPlanRow(recordKey)}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                  {copy.cancel}
                </button>
                <button
                  aria-busy={updateMutation.isPending}
                  className="button button--mini button--primary"
                  disabled={isSaveDisabled}
                  onClick={() => item.id && savePlanRow(item.id, planType, recordKey, item, groupRecords)}
                  type="button"
                >
                  <Check aria-hidden="true" size={14} />
                  {updateMutation.isPending ? cavityCopy.saving : copy.save}
                </button>
              </div>
            </div>
            {rowEditError ? <p className="schedule-job__edit-error" role="alert">{rowEditError}</p> : null}
          </div>
        ) : (
          <>
            <div className="schedule-job__main">
              <div className="schedule-job__model-line">
                <strong>{item.model_name || item.part_spec || copy.unsetModel}</strong>
                {isCavityGrouped ? <small className="cavity-group-chip">{cavityCopy.linked}</small> : null}
                {isOrderChanged ? <small>{copy.orderChanged}</small> : null}
              </div>
              <span>{item.part_no || "-"}</span>
              {planType === "injection" ? renderCavitySummary(item, groupRecords) : null}
            </div>
            <div className="schedule-job__meta">
              <span>
                {copy.lot} {item.lot_no || "-"}
              </span>
              <div className="schedule-job__quantity">
                <span>{copy.qty}</span>
                <strong>{formatQuantity(item.planned_quantity, language)}</strong>
              </div>
            </div>
            <button
              aria-label={copy.edit}
              className="schedule-job__edit-trigger"
              disabled={!item.id || editingRowId !== null}
              onClick={() => startEditingPlanRow(item, recordKey, groupRecords)}
              title={copy.edit}
              type="button"
            >
              <Pencil aria-hidden="true" size={15} strokeWidth={2} />
            </button>
          </>
        )}
      </li>
    );
  }

  function renderProcessColumn(planType: PlanType, groups: MachinePlanGroup[], totalQty: number, rowCount: number) {
    return (
      <section className="process-column">
        <div className="process-column__header">
          <div>
            <p className="panel-card__eyebrow">{getProcessLabel(planType, language)}</p>
            <h3 className="panel__title">{formatQuantity(totalQty, language)}</h3>
          </div>
          <span>{groups.length} {copy.activeMachines} · {rowCount} {copy.planRows}</span>
        </div>

        <div className="machine-group-list">
          {groups.length ? (
            groups.map((group) => {
              const orderKey = getOrderKey(planType, group.key);
              const orderedRecords = getOrderedRecords(group.records, orderKey);
              const changedRecordKeys = getChangedRecordKeys(group.records, orderKey);
              const hasOrderChanges = changedRecordKeys.size > 0;
              const cavityColorMap = planType === "injection" ? buildCavityGroupColorMap(orderedRecords) : new Map<string, string>();

              return (
                <article
                  className={`schedule-machine-card${draggedJob?.orderKey === orderKey ? " schedule-machine-card--drag-active" : ""}`}
                  data-order-key={orderKey}
                  key={orderKey}
                >
                  <div className="schedule-machine-card__header">
                    <div>
                      <strong>{group.machineName}</strong>
                      <span>{group.records.length} {copy.planRows}</span>
                    </div>
                    <strong>{formatQuantity(group.totalQty, language)}</strong>
                  </div>
                  {renderPlanTrack(orderedRecords, group.totalQty, planType, cavityColorMap)}
                  <ol className="schedule-job-list" aria-label={`${group.machineName} ${copy.sequence}`}>
                    {orderedRecords.map((row, index) => (
                      renderScheduleJob(row, planType, index, orderKey, changedRecordKeys, group.records, cavityColorMap)
                    ))}
                  </ol>
                  {hasOrderChanges ? (
                    <div className="schedule-order-actions">
                      <span>{copy.orderChanged}</span>
                      <button
                        className="button button--mini button--primary"
                        disabled={reorderMutation.isPending}
                        onClick={() => saveOrderChanges(orderKey, planType, group.records)}
                        type="button"
                      >
                        {reorderMutation.isPending ? copy.savingOrder : copy.saveOrder}
                      </button>
                      <button
                        className="button button--mini button--ghost"
                        disabled={reorderMutation.isPending}
                        onClick={() => setPendingOrders((current) => {
                          const next = { ...current };
                          delete next[orderKey];
                          return next;
                        })}
                        type="button"
                      >
                        {copy.cancel}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })
          ) : (
            <div className="notice notice--neutral">{copy.noMachineData}</div>
          )}
        </div>
      </section>
    );
  }

  function formatDelta(value: number) {
    if (value === 0) return "0";
    const prefix = value > 0 ? "+" : "";
    return `${prefix}${formatQuantity(value, language)}`;
  }

  function getChangeKindLabel(kind: PlanChangeKind) {
    if (kind === "added") return copy.added;
    if (kind === "removed") return copy.removed;
    if (kind === "changed") return copy.changed;
    return copy.unchanged;
  }

  function getChangeRowLabel(item: PlanChangeItem) {
    const row = item.after ?? item.before;
    if (!row) return "-";
    if (row.partNo !== "-") return row.partNo;
    const lotText = row.lotNo === "-" ? "" : ` · ${copy.lot} ${row.lotNo}`;
    return `${row.modelName}${lotText}`;
  }

  function renderPartNoWithHighlight(value: string) {
    const match = value.match(/^(.*)(\d{2})(\D*)$/);
    if (!match) return value;

    return (
      <>
        {match[1]}
        <mark className="part-no-highlight">{match[2]}</mark>
        {match[3]}
      </>
    );
  }

  function renderChangeItem(item: PlanChangeItem) {
    const partNo = getChangeRowLabel(item);
    return (
      <tr className={`change-report-row change-report-row--${item.kind}`} key={`${item.kind}-${item.machineName}-${partNo}`}>
        <td>{item.machineName}</td>
        <td>{renderPartNoWithHighlight(partNo)}</td>
        <td>{item.before?.modelName ?? item.after?.modelName ?? "-"}</td>
        <td>{item.before?.lotNo ?? item.after?.lotNo ?? "-"}</td>
        <td>{formatQuantity(item.beforeQty, language)}</td>
        <td>{formatQuantity(item.afterQty, language)}</td>
        <td className={item.deltaQty === 0 ? "change-delta--zero" : item.deltaQty > 0 ? "change-delta--up" : "change-delta--down"}>
          {formatDelta(item.deltaQty)}
        </td>
        <td>
          <span>{getChangeKindLabel(item.kind)}</span>
        </td>
      </tr>
    );
  }

  function renderProcessChange(process: ProcessChangeSummary) {
    const totalChanges = process.machines.reduce((sum, machine) => {
      return sum + machine.added + machine.removed + machine.changed;
    }, 0);

    return (
      <article className="change-process-card" key={process.planType}>
        <div className="change-process-card__header">
          <div>
            <p className="panel-card__eyebrow">{getProcessLabel(process.planType, language)}</p>
            <h4>{formatQuantity(process.afterTotal, language)}</h4>
          </div>
          <div className="change-process-card__totals">
            <span>{copy.before} {formatQuantity(process.beforeTotal, language)}</span>
            <strong>{copy.delta} {formatDelta(process.deltaTotal)}</strong>
          </div>
        </div>

        {process.machines.length ? (
          <div className="change-table-wrap">
            <div className="change-table-summary">
              <span className="change-badge change-badge--added">{copy.added} {process.machines.reduce((sum, machine) => sum + machine.added, 0)}</span>
              <span className="change-badge change-badge--changed">{copy.changed} {process.machines.reduce((sum, machine) => sum + machine.changed, 0)}</span>
              <span className="change-badge change-badge--removed">{copy.removed} {process.machines.reduce((sum, machine) => sum + machine.removed, 0)}</span>
              {totalChanges === 0 ? <span className="change-badge change-badge--unchanged">{copy.unchanged}</span> : null}
            </div>
            <table className="change-report-table">
              <thead>
                <tr>
                  <th>{copy.machine}</th>
                  <th>{copy.partRow}</th>
                  <th>{copy.model}</th>
                  <th>{copy.lot}</th>
                  <th>{copy.beforeQty}</th>
                  <th>{copy.afterQty}</th>
                  <th>{copy.delta}</th>
                  <th>{copy.changed}</th>
                </tr>
              </thead>
              <tbody>
                {process.machines.flatMap((machine) => machine.items.map(renderChangeItem))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="notice notice--neutral">{copy.noChanges}</div>
        )}
      </article>
    );
  }

  return (
    <section className="page page--production-plans">
      <section className="page-header plan-hero">
        <div className="plan-hero__copy">
          <PageHeaderIcon icon="plan" />
          <div>
            <h1 className="page-header__title">{copy.title}</h1>
            <p className="page-header__description">{copy.description}</p>
          </div>
        </div>

        <div className="plan-hero__controls">
          <div className="plan-hero__meta">
            <span>{copy.lastUpdate}</span>
            <div className="plan-hero__meta-row">
              <strong>{latestPlanUpdate ? formatDateTime(latestPlanUpdate, language) : copy.noLastUpdate}</strong>
              <button className="button button--ghost button--mini" onClick={() => setIsChangeLogOpen(true)} type="button">
                {copy.changeLog}
              </button>
            </div>
          </div>
          <div className="field plan-hero__date" ref={dateCalendarRef}>
            <span>{copy.planDate}</span>
            <button
              aria-expanded={isDateCalendarOpen}
              aria-haspopup="dialog"
              aria-label={language === "ko" ? "생산계획 기준일 달력 열기" : "打开生产计划基准日历"}
              className="plan-date-trigger"
              onClick={() => setIsDateCalendarOpen((current) => !current)}
              type="button"
            >
              <CalendarDays aria-hidden="true" />
              <strong>{formatPlanDateLabel(selectedDate, language)}</strong>
            </button>
            {isDateCalendarOpen ? (
              <div
                aria-label={language === "ko" ? "생산계획 기준일 선택" : "选择生产计划基准日"}
                className="plan-date-popover"
                role="dialog"
              >
                <DayPicker
                  components={{ Chevron: CalendarChevron }}
                  defaultMonth={parsePlanDate(selectedDate)}
                  disabled={(date) => !dateOptionSet.has(formatPlanDate(date))}
                  locale={language === "ko" ? ko : zhCN}
                  mode="single"
                  modifiers={{ hasPlan: (date) => dateOptionSet.has(formatPlanDate(date)) }}
                  modifiersClassNames={{ hasPlan: "plan-date-calendar__has-plan" }}
                  onDayClick={(date, modifiers) => {
                    if (modifiers.disabled) return;
                    setSelectedDate(formatPlanDate(date));
                    setIsDateCalendarOpen(false);
                  }}
                  onSelect={(date) => {
                    if (!date) return;
                    setSelectedDate(formatPlanDate(date));
                  }}
                  required
                  selected={parsePlanDate(selectedDate)}
                  showOutsideDays
                  className="plan-date-calendar"
                />
                <p className="plan-date-popover__hint">
                  {language === "ko"
                    ? "계획이 등록된 날짜를 선택할 수 있습니다."
                    : "可选择已有生产计划的日期。"}
                </p>
              </div>
            ) : null}
          </div>
          <div className="plan-hero__actions">
            {canLoadLocalSample ? (
              <button
                className="button button--ghost plan-hero__sample"
                onClick={handleLoadLocalSample}
                type="button"
              >
                <FileSpreadsheet aria-hidden="true" size={15} strokeWidth={1.9} />
                {copy.loadLocalSample}
              </button>
            ) : null}
            <Link className="button button--ghost plan-hero__link" to="/production">
              {copy.goDashboard}
            </Link>
            <button
              className="button button--primary"
              onClick={() => {
                setUploadStatus(null);
                setIsUploadModalOpen(true);
              }}
              type="button"
            >
              {copy.openUpload}
            </button>
          </div>
        </div>
      </section>

      {uploadStatus ? (
        <div className={`notice ${uploadStatus.tone === "success" ? "notice--success" : "notice--warning"}`}>
          {uploadStatus.message}
        </div>
      ) : null}

      {!isViewingLocalSample && (datesQuery.isLoading || injectionItemsQuery.isLoading || machiningItemsQuery.isLoading) ? (
        <LoadingBlock label={language === "ko" ? "생산 계획을 불러오는 중입니다." : "正在加载生产计划。"} />
      ) : null}

      <div className="stats-grid">
        {renderSummaryCard(
          copy.plannedQty,
          formatQuantity(totalPlanQty, language),
          formatQuantity(totalInjectionQty, language),
          formatQuantity(totalMachiningQty, language),
        )}
        {renderSummaryCard(
          copy.activeMachines,
          String(totalMachines),
          String(injectionMachineGroups.length),
          String(machiningMachineGroups.length),
        )}
        {renderSummaryCard(
          copy.planRows,
          String(totalRows),
          String(injectionItems.length),
          String(machiningItems.length),
        )}
      </div>

      <section className="panel">
        <div className="plan-table-header plan-table-header--compact">
          <h3 className="panel__title">{selectedDate} {copy.dashboardTitle}</h3>
        </div>

        <div className="plan-equipment-overview">
          <div className="plan-equipment-overview__title">
            <span>{copy.equipmentCompare}</span>
          </div>
          {renderEquipmentComparison("injection", injectionMachineGroups, totalInjectionQty)}
          {renderEquipmentComparison("machining", machiningMachineGroups, totalMachiningQty)}
        </div>

        <div className="process-plan-grid">
          {renderProcessColumn("injection", injectionMachineGroups, totalInjectionQty, injectionItems.length)}
          {renderProcessColumn("machining", machiningMachineGroups, totalMachiningQty, machiningItems.length)}
        </div>
      </section>

      {isUploadModalOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" aria-modal="true" role="dialog">
            <div className="modal-card__header">
              <div>
                <p className="panel-card__eyebrow">{copy.uploadSection}</p>
                <h3 className="panel__title">{copy.uploadTitle}</h3>
              </div>
              <button
                className="button button--ghost"
                onClick={() => setIsUploadModalOpen(false)}
                type="button"
              >
                {copy.close}
              </button>
            </div>

            <form className="plan-upload-form" onSubmit={handleUpload}>
              <div className="plan-update-summary">
                <div>
                  <span>{copy.updateTarget}</span>
                  <strong>{copy.latestSheetRule} · {copy.injection} / {copy.machining}</strong>
                </div>
                <div>
                  <span>{copy.updateMethod}</span>
                  <strong>{copy.replaceRule}</strong>
                </div>
              </div>

              <label className="field plan-file-field">
                <span>{copy.injectionFile}</span>
                <input
                  accept=".xlsx,.xls"
                  key={`injection-${fileInputKey}`}
                  onChange={(event) => setInjectionFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <div
                  className={`plan-file-field__drop${dragTarget === "injection" ? " plan-file-field__drop--active" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragTarget("injection");
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    setDragTarget(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragTarget("injection");
                  }}
                  onDrop={(event) => handleFileDrop(event, "injection")}
                >
                  <strong>{injectionFile?.name || copy.chooseFile}</strong>
                  <span>{dragTarget === "injection" ? copy.dropFile : copy.fileHint}</span>
                </div>
              </label>

              <label className="field plan-file-field">
                <span>{copy.machiningFile}</span>
                <input
                  accept=".xlsx,.xls"
                  key={`machining-${fileInputKey}`}
                  onChange={(event) => setMachiningFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <div
                  className={`plan-file-field__drop${dragTarget === "machining" ? " plan-file-field__drop--active" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragTarget("machining");
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    setDragTarget(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragTarget("machining");
                  }}
                  onDrop={(event) => handleFileDrop(event, "machining")}
                >
                  <strong>{machiningFile?.name || copy.chooseFile}</strong>
                  <span>{dragTarget === "machining" ? copy.dropFile : copy.fileHint}</span>
                </div>
              </label>

              {uploadStatus?.tone === "error" ? (
                <div className="notice notice--warning">{uploadStatus.message}</div>
              ) : null}

              {uploadMutation.isPending ? (
                <div className="plan-upload-progress" role="status">
                  <div className="plan-upload-progress__header">
                    <span>{copy.uploadProgressTitle}</span>
                    <em>{uploadProgress}%</em>
                  </div>
                  <div className="plan-upload-progress__bar">
                    <span style={{ width: `${uploadProgress}%` }} />
                  </div>
                  <p>{copy.uploadProgressHint}</p>
                </div>
              ) : null}

              <button className="button button--primary button--wide" disabled={uploadMutation.isPending} type="submit">
                {uploadMutation.isPending ? copy.uploading : copy.uploadButton}
              </button>
            </form>
          </section>
        </div>
      ) : null}

      {isChangeLogOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsChangeLogOpen(false)}>
          <section
            className="modal-card plan-change-log-modal"
            aria-modal="true"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="panel-card__eyebrow">{selectedDate}</p>
                <h3 className="panel__title">{copy.changeLogTitle}</h3>
                <p className="change-report-description">{copy.changeLogDescription}</p>
              </div>
              <button className="button button--ghost" onClick={() => setIsChangeLogOpen(false)} type="button">
                {copy.close}
              </button>
            </div>

            <div className="plan-change-log-list">
              {changeLogsQuery.isLoading ? (
                <div className="notice notice--neutral">{language === "ko" ? "변경 로그를 불러오는 중입니다." : "正在加载变更日志。"}</div>
              ) : null}
              {!changeLogsQuery.isLoading && !changeLogs.length ? (
                <div className="notice notice--neutral">{copy.noChangeLogs}</div>
              ) : null}
              {changeLogs.map((log) => (
                <article className="plan-change-log-item" key={log.id}>
                  <div>
                    <span className={`plan-change-log-badge plan-change-log-badge--${log.action}`}>
                      {getChangeActionLabel(log.action, copy)}
                    </span>
                    <strong>{log.summary || `${log.machine_name || "-"} ${log.part_no || log.model_name || ""}`}</strong>
                    <p>
                      {log.plan_type === "injection" ? copy.injection : copy.machining}
                      {log.machine_name ? ` · ${log.machine_name}` : ""}
                      {log.part_no ? ` · ${copy.partNo} ${log.part_no}` : ""}
                    </p>
                  </div>
                  <div className="plan-change-log-meta">
                    <strong>{formatDateTime(log.created_at, language)}</strong>
                    <span>{copy.changedBy}: {log.changed_by_name || "-"}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {uploadChangeReport ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card upload-change-modal" aria-modal="true" role="dialog">
            <div className="modal-card__header">
              <div>
                <p className="panel-card__eyebrow">{copy.changeReportEyebrow}</p>
                <h3 className="panel__title">{copy.changeReportTitle}</h3>
                <p className="change-report-description">
                  {uploadChangeReport.date} · {copy.changeReportDescription}
                </p>
              </div>
              <button
                className="button button--ghost"
                onClick={() => setUploadChangeReport(null)}
                type="button"
              >
                {copy.closeChangeReport}
              </button>
            </div>

            <div className="change-report-grid">
              {uploadChangeReport.processes.map(renderProcessChange)}
            </div>
          </section>
        </div>
      ) : null}

    </section>
  );
}
