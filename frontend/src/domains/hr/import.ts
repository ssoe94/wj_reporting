import type { HrImportRow } from "./types.ts";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_COLUMNS = 200;
export const MAX_EMPLOYEE_AMOUNT_CENTS = 99_999_999_999;
const MAX_WORKSHEET_ROWS = MAX_IMPORT_ROWS + 100;

export type HrImportCell = unknown | {
  value: unknown;
  formatted?: string;
  formula?: string;
  error?: boolean;
};

export type HrWorkbookSheet = { name: string; rows: HrImportCell[][] };
export type HrWorkbook = { filename: string; sheets: HrWorkbookSheet[] };
export type HrHeaderColumn = { index: number; label: string };
export type HrColumnMapping = {
  code: number | null;
  name: number | null;
  title: number | null;
  amount: number | null;
};
export type HrImportMapping = {
  headerRowIndex: number;
  columns: { code: number; name: number; title: number | null; amount: number };
};

type CellDetails = {
  value: unknown;
  formatted?: string;
  formula?: string;
  error?: boolean;
};

function details(cell: HrImportCell): CellDetails {
  if (cell && typeof cell === "object" && "value" in cell) {
    return cell as CellDetails;
  }
  return { value: cell };
}

function assertUsableCell(cell: CellDetails): void {
  if (cell.error) throw new Error("오류 셀을 수정해 주세요.");
  if (cell.formula && (typeof cell.value !== "number" || !Number.isFinite(cell.value))) {
    throw new Error("수식의 저장된 숫자 결과가 없습니다. Excel에서 계산 후 저장하거나 값으로 붙여 넣어 주세요.");
  }
}

function cellText(cell: HrImportCell): string {
  const item = details(cell);
  assertUsableCell(item);
  if (item.value === null || item.value === undefined) return "";
  if (typeof item.value !== "string" && typeof item.value !== "number") {
    throw new Error("문자 또는 숫자 셀을 사용해 주세요.");
  }
  if (typeof item.value === "number" && !Number.isFinite(item.value)) {
    throw new Error("유효한 숫자 셀을 사용해 주세요.");
  }
  return (item.formatted ?? String(item.value)).trim();
}

function isBlankCell(cell: HrImportCell): boolean {
  const item = details(cell);
  return !item.formula && !item.error
    && (item.value === null || item.value === undefined
      || (typeof item.value === "string" && item.value.trim() === ""));
}

/** Converts decimal input to integer cents; it never rounds payroll values. */
export function amountToCents(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("인건비는 0 이상의 숫자여야 합니다.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("인건비는 유효한 숫자여야 합니다.");
  }
  const text = String(value).trim();
  // Commas are accepted only as complete thousands groups.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("인건비는 0 이상의 숫자이며 소수점은 두 자리까지 입력해 주세요.");
  }
  const [whole, fraction = ""] = text.replaceAll(",", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("인건비가 처리 가능한 범위를 초과했습니다.");
  }
  return Number(cents);
}

export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("유효한 인건비 합계가 아닙니다.");
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function sumImportAmounts(rows: Pick<HrImportRow, "amount">[]): string {
  let total = 0;
  for (const row of rows) {
    total += amountToCents(row.amount);
    if (!Number.isSafeInteger(total)) throw new Error("인건비 합계가 처리 가능한 범위를 초과했습니다.");
  }
  return centsToAmount(total);
}

export function getHeaderColumns(sheet: HrWorkbookSheet, headerRowIndex: number): HrHeaderColumn[] {
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < 0 || headerRowIndex >= sheet.rows.length) {
    throw new Error("제목 행을 선택해 주세요.");
  }
  return sheet.rows[headerRowIndex].map((cell, index) => ({
    index,
    label: cellText(cell) || `열 ${index + 1}`,
  }));
}

export function suggestColumnMapping(headers: HrHeaderColumn[]): HrColumnMapping {
  const aliases = {
    code: ["code", "employee code", "employee id", "사번", "직원번호", "인원코드", "员工编号", "工号"],
    name: ["name", "employee name", "성명", "이름", "직원명", "姓名", "员工姓名"],
    title: ["title", "job title", "직책", "직급", "직무", "职位", "职务", "岗位"],
    amount: ["amount", "employer total", "labor cost", "인건비", "총인건비", "회사부담총액", "회사 부담 총액", "人工成本", "公司负担总额"],
  };
  const mapping: HrColumnMapping = { code: null, name: null, title: null, amount: null };
  for (const field of Object.keys(aliases) as (keyof HrColumnMapping)[]) {
    const candidates = headers.filter(({ label }) => aliases[field].includes(label.trim().toLowerCase()));
    // A duplicate matching header requires an explicit choice.
    if (candidates.length === 1) mapping[field] = candidates[0].index;
  }
  return mapping;
}

export function parseMappedRows(rows: HrImportCell[][], mapping: HrImportMapping): HrImportRow[] {
  if (!Number.isInteger(mapping.headerRowIndex) || mapping.headerRowIndex < 0
    || mapping.headerRowIndex >= rows.length) throw new Error("제목 행을 선택해 주세요.");
  if (rows.length > MAX_WORKSHEET_ROWS) throw new Error(`시트는 제목 행을 포함해 ${MAX_WORKSHEET_ROWS}행까지 읽을 수 있습니다.`);
  const indices = Object.values(mapping.columns).filter((index): index is number => index !== null);
  if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= MAX_IMPORT_COLUMNS)) {
    throw new Error("사번, 이름, 인건비 열을 올바르게 선택해 주세요.");
  }
  if (new Set(indices).size !== indices.length) throw new Error("각 항목은 서로 다른 열을 선택해 주세요.");
  const result: HrImportRow[] = [];
  const codes = new Set<string>();
  for (let rowIndex = mapping.headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length > MAX_IMPORT_COLUMNS) throw new Error(`${rowIndex + 1}행: 열은 ${MAX_IMPORT_COLUMNS}개까지 사용할 수 있습니다.`);
    if (row.every(isBlankCell)) continue;
    if (result.length >= MAX_IMPORT_ROWS) throw new Error(`직원은 ${MAX_IMPORT_ROWS}명까지 올릴 수 있습니다.`);
    try {
      const code = cellText(row[mapping.columns.code]);
      const name = cellText(row[mapping.columns.name]);
      const title = mapping.columns.title === null ? "" : cellText(row[mapping.columns.title]);
      if (!code) throw new Error("사번이 비어 있습니다.");
      if (!name) throw new Error("이름이 비어 있습니다.");
      if (code.length > 64 || name.length > 100 || title.length > 100) {
        throw new Error("사번은 64자, 이름과 직책은 100자까지 사용할 수 있습니다.");
      }
      if (codes.has(code)) throw new Error("중복 사번이 있습니다. 사번은 한 번씩만 입력해 주세요.");
      const amountCell = details(row[mapping.columns.amount]);
      assertUsableCell(amountCell);
      const cents = amountToCents(amountCell.value);
      if (cents > MAX_EMPLOYEE_AMOUNT_CENTS) throw new Error("직원 한 명의 인건비는 999999999.99까지 입력할 수 있습니다.");
      const amount = centsToAmount(cents);
      codes.add(code);
      result.push({ code, name, title, amount });
    } catch (error) {
      throw new Error(`${rowIndex + 1}행: ${error instanceof Error ? error.message : "입력값을 확인해 주세요."}`);
    }
  }
  if (result.length === 0) throw new Error("가져올 직원이 없습니다. 제목 행과 열 선택을 확인해 주세요.");
  sumImportAmounts(result);
  return result;
}

export async function readWorkbook(file: File): Promise<HrWorkbook> {
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error("XLSX 또는 CSV 파일을 선택해 주세요.");
  if (file.size > MAX_IMPORT_BYTES) throw new Error("파일은 10MB까지 올릴 수 있습니다.");
  if (file.size === 0) throw new Error("빈 파일은 올릴 수 없습니다.");
  const [buffer, XLSX] = await Promise.all([file.arrayBuffer(), import("xlsx")]);
  let workbook;
  try {
    // raw preserves leading zeros in CSV; XLSX formatted text is kept per cell below.
    workbook = XLSX.read(buffer, {
      type: "array", cellFormula: true, cellText: true, raw: true,
      sheetRows: MAX_WORKSHEET_ROWS + 1,
    });
  } catch {
    throw new Error("파일을 읽을 수 없습니다. XLSX 또는 UTF-8 CSV 형식을 확인해 주세요.");
  }
  if (workbook.SheetNames.length > 50) throw new Error("시트는 50개까지 읽을 수 있습니다.");
  const sheets = workbook.SheetNames.map((name): HrWorkbookSheet => {
    const sheet = workbook.Sheets[name];
    if (!sheet["!ref"]) return { name, rows: [] };
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    if (range.e.r >= MAX_WORKSHEET_ROWS || range.e.c >= MAX_IMPORT_COLUMNS) {
      throw new Error(`${name}: 시트는 ${MAX_WORKSHEET_ROWS}행, ${MAX_IMPORT_COLUMNS}열까지 읽을 수 있습니다.`);
    }
    const rows: HrImportCell[][] = [];
    for (let rowIndex = 0; rowIndex <= range.e.r; rowIndex += 1) {
      const row: HrImportCell[] = [];
      for (let colIndex = 0; colIndex <= range.e.c; colIndex += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })];
        if (!cell) {
          row.push("");
          continue;
        }
        row.push({
          value: cell.v,
          formatted: cell.w ?? XLSX.utils.format_cell(cell),
          formula: cell.f,
          error: cell.t === "e",
        });
      }
      rows.push(row);
    }
    return { name, rows };
  });
  if (!sheets.some((sheet) => sheet.rows.some((row) => !row.every(isBlankCell)))) {
    throw new Error("파일에 데이터가 없습니다.");
  }
  return { filename: file.name, sheets };
}

export function createTemplateCsv(): string {
  return "\uFEFFcode,name,title,amount\r\n0001,홍길동,생산 담당,10000.00\r\n";
}

export function downloadTemplate(): void {
  const url = URL.createObjectURL(new Blob([createTemplateCsv()], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "인건비_업로드_양식.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
