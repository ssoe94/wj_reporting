import type {
  PlanType,
  ProductionPlanDatesResponse,
  ProductionPlanRecord,
  ProductionPlanSummaryResponse,
  ProductionPlanUploadResponse,
} from "@/domains/production/api";
import { getSeoulDateString } from "@/shared/utils/date";
import * as XLSX from "xlsx";

const today = getSeoulDateString();
const yesterday = new Date(`${today}T00:00:00+09:00`);
yesterday.setDate(yesterday.getDate() - 1);
const yDate = yesterday.toISOString().slice(0, 10);

const mockPlanItems: Record<string, Record<PlanType, ProductionPlanRecord[]>> = {
  [today]: {
    injection: [
      { id: 1, machine_name: "1호기", part_no: "WJ-ABS-1101", model_name: "EB-110", lot_no: "A01", planned_quantity: 2400, cavity: 2, sequence: 1 },
      { id: 2, machine_name: "1호기", part_no: "WJ-ABS-1102", model_name: "EB-120", lot_no: "A02", planned_quantity: 1800, cavity: 2, sequence: 2 },
      { id: 3, machine_name: "3호기", part_no: "WJ-ABS-2201", model_name: "EB-220", lot_no: "B11", planned_quantity: 3200, cavity: 4, sequence: 1 },
      { id: 4, machine_name: "5호기", part_no: "WJ-ABS-3105", model_name: "EB-310", lot_no: "C03", planned_quantity: 2100, cavity: 2, sequence: 1 },
    ],
    machining: [
      { id: 11, machine_name: "가공 A", part_no: "WJ-ASSY-1101", model_name: "EB-110", lot_no: "M01", planned_quantity: 1200, sequence: 1 },
      { id: 12, machine_name: "가공 B", part_no: "WJ-ASSY-2201", model_name: "EB-220", lot_no: "M04", planned_quantity: 1500, sequence: 1 },
      { id: 13, machine_name: "가공 C", part_no: "WJ-ASSY-3105", model_name: "EB-310", lot_no: "M06", planned_quantity: 900, sequence: 1 },
    ],
  },
  [yDate]: {
    injection: [
      { id: 21, machine_name: "2호기", part_no: "WJ-ABS-1101", model_name: "EB-110", lot_no: "Y01", planned_quantity: 2200, cavity: 2, sequence: 1 },
      { id: 22, machine_name: "4호기", part_no: "WJ-ABS-2201", model_name: "EB-220", lot_no: "Y07", planned_quantity: 2800, cavity: 4, sequence: 1 },
    ],
    machining: [
      { id: 31, machine_name: "가공 A", part_no: "WJ-ASSY-1101", model_name: "EB-110", lot_no: "YM1", planned_quantity: 1000, sequence: 1 },
      { id: 32, machine_name: "가공 D", part_no: "WJ-ASSY-2201", model_name: "EB-220", lot_no: "YM8", planned_quantity: 1100, sequence: 1 },
    ],
  },
};

function summarize(records: ProductionPlanRecord[], planDate: string) {
  const machineMap = new Map<string, number>();
  const modelMap = new Map<string, number>();

  for (const row of records) {
    const machineKey = row.machine_name || "미지정 설비";
    const modelKey = row.model_name || row.part_spec || "모델 미지정";
    machineMap.set(machineKey, (machineMap.get(machineKey) || 0) + row.planned_quantity);
    modelMap.set(modelKey, (modelMap.get(modelKey) || 0) + row.planned_quantity);
  }

  return {
    records,
    machine_summary: [...machineMap.entries()].map(([machine_name, plan_qty]) => ({
      machine_name,
      plan_qty,
      plan_date: planDate,
    })),
    model_summary: [...modelMap.entries()].map(([model_name, plan_qty]) => ({
      model_name,
      plan_qty,
      plan_date: planDate,
    })),
    daily_totals: [
      {
        date: planDate,
        plan_qty: records.reduce((sum, row) => sum + row.planned_quantity, 0),
      },
    ],
  };
}

function normalizeHeader(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

function getHeaderIndex(headers: unknown[], candidates: string[]) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return headers.findIndex((header) => normalizedCandidates.includes(normalizeHeader(header)));
}

function getCell(row: unknown[], headers: unknown[], candidates: string[]) {
  const index = getHeaderIndex(headers, candidates);
  return index >= 0 ? row[index] : undefined;
}

function toText(value: unknown) {
  return String(value ?? "").trim();
}

function toNumber(value: unknown) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

type DayColumn = {
  dayNumber: number;
  index: number;
};

function extractDayColumns(headers: unknown[]) {
  return headers.reduce<DayColumn[]>((columns, header, index) => {
    const normalized = normalizeHeader(header);
    if (/^\d+$/.test(normalized)) {
      const dayNumber = Number(normalized);
      if (dayNumber >= 1 && dayNumber <= 31) {
        columns.push({ dayNumber, index });
      }
    }
    return columns;
  }, []);
}

function buildDayMap(dayColumns: DayColumn[], targetDate: string) {
  const target = new Date(`${targetDate}T00:00:00+09:00`);
  let currentYear = target.getFullYear();
  let currentMonth = target.getMonth() + 1;
  let previousDay: number | null = null;
  const dayMap = new Map<number, string>();

  for (const column of dayColumns) {
    const dayNumber = column.dayNumber;

    if (previousDay !== null && dayNumber < previousDay) {
      currentMonth += 1;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear += 1;
      }
    }

    const date = new Date(Date.UTC(currentYear, currentMonth - 1, dayNumber));
    dayMap.set(column.index, date.toISOString().slice(0, 10));
    previousDay = dayNumber;
  }

  return dayMap;
}

function isValidMachineRow(planType: PlanType, machineName: string) {
  if (planType === "injection") {
    return /^\d+T-\d+$/.test(machineName);
  }
  return machineName.trim().length > 0;
}

function createEmptyPlanEntry() {
  return {
    injection: [],
    machining: [],
  } satisfies Record<PlanType, ProductionPlanRecord[]>;
}

function readSheetRows(sheet: XLSX.WorkSheet) {
  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);
  const rows: unknown[][] = [];

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: unknown[] = [];
    for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
      row.push(sheet[cellAddress]?.v ?? "");
    }
    rows.push(row);
  }

  return rows;
}

function resolveLatestDateSheetName(sheetNames: string[], targetDate: string) {
  const target = new Date(`${targetDate}T00:00:00+09:00`);
  const targetYear = target.getFullYear();
  const candidates = sheetNames
    .map((sheetName) => {
      const match = sheetName.match(/^\s*(\d{1,2})-(\d{1,2})\s*$/);
      if (!match) return null;
      const month = Number(match[1]);
      const day = Number(match[2]);
      const sheetDate = new Date(Date.UTC(targetYear, month - 1, day));
      if (Number.isNaN(sheetDate.getTime())) return null;
      return {
        sheetName,
        sheetDate,
        sheetDateString: sheetDate.toISOString().slice(0, 10),
      };
    })
    .filter((candidate): candidate is { sheetName: string; sheetDate: Date; sheetDateString: string } => Boolean(candidate))
    .sort((left, right) => right.sheetDate.getTime() - left.sheetDate.getTime());

  return candidates[0] ?? null;
}

async function parseProductionPlanWorkbook(file: File, planType: PlanType, targetDate: string) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const latestDateSheet = resolveLatestDateSheetName(workbook.SheetNames, targetDate);
  if (!latestDateSheet) {
    throw new Error("날짜 형식의 계획 시트를 찾을 수 없습니다. 예: 5-8");
  }

  const sheetName = latestDateSheet.sheetName;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`${sheetName} 시트를 읽을 수 없습니다.`);
  }

  const sheetRows = readSheetRows(sheet);
  const headers = sheetRows[2] ?? [];
  const rows = sheetRows.slice(3);
  const dayColumns = extractDayColumns(headers);
  const dayMap = buildDayMap(dayColumns, latestDateSheet.sheetDateString);
  const recordsByDate: Record<string, ProductionPlanRecord[]> = {};
  const groupedRecords = new Map<string, ProductionPlanRecord>();

  rows.forEach((row, rowIndex) => {
    const machineName = toText(getCell(row, headers, ["設  備  ", "設備", "설비", "machine"]));
    if (!isValidMachineRow(planType, machineName)) return;

    const lotNo = toText(getCell(row, headers, ["LOT NO", "lot_no", "lot"]));
    if (!lotNo) return;

    const modelName = toText(getCell(row, headers, ["MODEL ", "model", "모델"]));
    const partSpec = toText(
      getCell(row, headers, planType === "injection" ? ["SPEC", "part_spec"] : ["SUFFIX", "SPEC", "part_spec"]),
    );
    const partNo = toText(
      getCell(
        row,
        headers,
        planType === "injection"
          ? ["成品 P/N", "成品PN", "PART NO", "part_no"]
          : ["PART NO", "成品 P/N", "成品PN", "part_no"],
      ),
    ).toUpperCase();

    for (const column of dayColumns) {
      const planDate = dayMap.get(column.index);
      if (!planDate) continue;

      const plannedQuantity = toNumber(row[column.index]);
      if (plannedQuantity <= 0) continue;

      const groupKey = [
        planDate,
        machineName,
        lotNo,
        modelName,
        partSpec,
        partNo,
      ].join("|");
      const current = groupedRecords.get(groupKey);

      if (current) {
        current.planned_quantity += plannedQuantity;
        continue;
      }

      groupedRecords.set(groupKey, {
        id: Date.now() + groupedRecords.size,
        machine_name: machineName || null,
        lot_no: lotNo || null,
        model_name: modelName || null,
        part_spec: partSpec || null,
        part_no: partNo || null,
        planned_quantity: plannedQuantity,
        sequence: rowIndex + 1,
      });
    }
  });

  for (const [groupKey, record] of groupedRecords) {
    const planDate = groupKey.split("|")[0];
    recordsByDate[planDate] = recordsByDate[planDate] ?? [];
    recordsByDate[planDate].push(record);
  }

  return {
    availableDays: [...new Set([...dayMap.values()])],
    recordsByDate,
    sheetDate: latestDateSheet.sheetDateString,
    sheetName,
  };
}

export function getMockPlanDates(): ProductionPlanDatesResponse {
  const dates = Object.keys(mockPlanItems).sort().reverse();
  return {
    injection: dates.filter((date) => mockPlanItems[date].injection.length > 0),
    machining: dates.filter((date) => mockPlanItems[date].machining.length > 0),
  };
}

export function getMockPlanSummary(planDate: string): ProductionPlanSummaryResponse {
  const entry = mockPlanItems[planDate] || mockPlanItems[today];
  return {
    plan_date: planDate,
    injection: summarize(entry.injection, planDate),
    machining: summarize(entry.machining, planDate),
  };
}

export function getMockPlanItems(planDate: string, planType: PlanType) {
  const entry = mockPlanItems[planDate] || mockPlanItems[today];
  return entry[planType];
}

export async function mockUploadProductionPlanFile(
  file: File,
  planType: PlanType,
  targetDate: string,
): Promise<ProductionPlanUploadResponse> {
  const fallbackDate = targetDate || today;
  const parsed = await parseProductionPlanWorkbook(file, planType, fallbackDate);

  for (const availableDay of parsed.availableDays) {
    mockPlanItems[availableDay] = mockPlanItems[availableDay] ?? createEmptyPlanEntry();
    mockPlanItems[availableDay][planType] = parsed.recordsByDate[availableDay] ?? [];
  }

  const primaryDate = parsed.availableDays[0] || parsed.sheetDate || fallbackDate;
  const primaryRecords = mockPlanItems[primaryDate]?.[planType] ?? [];

  return {
    plan_type: planType,
    plan_date: parsed.sheetDate,
    target_date: parsed.sheetDate,
    available_days: parsed.availableDays,
    records: primaryRecords,
    plan_long: [],
    machine_summary: summarize(primaryRecords, primaryDate).machine_summary,
    model_summary: summarize(primaryRecords, primaryDate).model_summary,
  };
}

export function mockUpdateProductionPlanItem(
  planDate: string,
  planType: PlanType,
  id: number,
  updates: Partial<ProductionPlanRecord>,
) {
  const entry = mockPlanItems[planDate];
  if (!entry) return null;

  const index = entry[planType].findIndex((row) => row.id === id);
  if (index < 0) return null;

  const updated = {
    ...entry[planType][index],
    ...updates,
    planned_quantity: Number(updates.planned_quantity ?? entry[planType][index].planned_quantity) || 0,
  };
  entry[planType][index] = updated;
  return updated;
}
