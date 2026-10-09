import type { HrImportRow } from "./types.ts";
import { resolveClassification } from './company-structure.ts';

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
  period: number | null;
  source_department: number | null;
  classification_group: number | null;
  classification_function: number | null;
  classification_code: number | null;
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
    amount: ["amount", "employer total", "labor cost", "인건비", "총인건비", "회사부담총액", "회사 부담 총액", "人工成本", "公司负担总额", '应发工资'],
    period: ['month', 'period', '월', '년월', '月份', '年月', '工资月份'],
    source_department: ['部门', '原始部门', '원본부서', '원래부서', '부서'],
    classification_group: ['可视化部门', '可视化部門', '시각화부문', '시각화부서'],
    classification_function: ['可视化职能', '可视化功能', '시각화기능', '시각화 기능'],
    classification_code: ['可视化编码', '可视化代码', '시각화코드', '시각화 박스 코드'],
  };
  const mapping: HrColumnMapping = { code: null, name: null, title: null, amount: null, period: null, source_department: null, classification_group: null, classification_function: null, classification_code: null };
  for (const field of Object.keys(aliases) as (keyof HrColumnMapping)[]) {
    const normalize = (value: string) => value.replace(/\s+/g, '').toLowerCase();
    const candidates = headers.filter(({ label }) => aliases[field].map(normalize).includes(normalize(label)) || (field === 'period' && /^(19|20|21)\d{2}年$/.test(label.trim())));
    // A duplicate matching header requires an explicit choice.
    if (candidates.length === 1) mapping[field] = candidates[0].index;
  }
  return mapping;
}

export type HrPayrollMapping = { headerRowIndex: number; columns: HrColumnMapping; targetMonth: string; classificationMode: 'preserve' | 'file'; allowMissingCost: boolean };
export type HrPayrollParseResult = { rows: HrImportRow[]; excluded_row_count: number; missing_cost_count: number };

export function parsePayrollPeriod(value: string, targetMonth: string, header: string): string {
  const text = value.replace(/\s+/g, '');
  const full = text.match(/^((?:19|20|21)\d{2})[-/年](\d{1,2})月?$/);
  const short = text.match(/^(\d{1,2})月?$/);
  const year = full?.[1] ?? header.match(/((?:19|20|21)\d{2})年/)?.[1] ?? targetMonth.slice(0, 4);
  const month = Number(full?.[2] ?? short?.[1]);
  if ((!full && !short) || month < 1 || month > 12 || !Number.isInteger(month)) throw new Error('급여 월을 확인해 주세요.');
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Each file row has its own payroll month. Filter before employee-code uniqueness. */
export function parsePayrollRows(rows: HrImportCell[][], mapping: HrPayrollMapping): HrPayrollParseResult {
  const { headerRowIndex, columns, targetMonth, classificationMode, allowMissingCost } = mapping;
  if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(targetMonth)) throw new Error('대상 월을 정확하게 선택해 주세요.');
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < 0 || headerRowIndex >= rows.length) throw new Error('제목 행을 선택해 주세요.');
  if (rows.length > MAX_WORKSHEET_ROWS) throw new Error(`시트는 ${MAX_WORKSHEET_ROWS}행까지 읽을 수 있습니다.`);
  if (columns.code === null || columns.name === null || (columns.amount === null && !allowMissingCost)) throw new Error('사번, 이름, 인건비 열을 선택해 주세요.');
  if (classificationMode === 'file' && columns.classification_code == null && (columns.classification_group == null || columns.classification_function == null)) throw new Error('시각화 부문과 기능 열을 모두 선택해 주세요.');
  const activeColumns = [columns.code, columns.name, columns.title, columns.amount, columns.period, columns.source_department,
    ...(classificationMode === 'file' ? columns.classification_code != null ? [columns.classification_code] : [columns.classification_group, columns.classification_function] : [])].filter((index): index is number => index != null);
  if (activeColumns.some((index) => !Number.isInteger(index) || index < 0 || index >= MAX_IMPORT_COLUMNS) || new Set(activeColumns).size !== activeColumns.length) throw new Error('각 항목은 서로 다른 열을 선택해 주세요.');
  const result: HrImportRow[] = []; const codes = new Set<string>(); let excluded = 0; let missing = 0;
  const periodHeader = columns.period == null ? '' : cellText(rows[headerRowIndex][columns.period]);
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.every(isBlankCell)) continue;
    try {
      const period = columns.period == null ? targetMonth : parsePayrollPeriod(cellText(row[columns.period]), targetMonth, periodHeader);
      if (period !== targetMonth) { excluded += 1; continue; }
      if (result.length >= MAX_IMPORT_ROWS) throw new Error(`직원은 ${MAX_IMPORT_ROWS}명까지 올릴 수 있습니다.`);
      const code = cellText(row[columns.code!]); const name = cellText(row[columns.name!]);
      const title = columns.title == null ? '' : cellText(row[columns.title]);
      const sourceDepartment = columns.source_department == null ? '' : cellText(row[columns.source_department]);
      if (!code) throw new Error('사번이 비어 있습니다.');
      if (!name) throw new Error('이름이 비어 있습니다.');
      if (code.length > 64 || name.length > 100 || title.length > 100 || sourceDepartment.length > 100) throw new Error('사번은 64자, 이름과 직책 및 원본 부서는 100자까지 사용할 수 있습니다.');
      if (codes.has(code)) throw new Error('같은 월에 중복 사번이 있습니다.');
      let amount: string | null = null;
      if (columns.amount != null && !isBlankCell(row[columns.amount])) {
        const cell = details(row[columns.amount]); assertUsableCell(cell);
        const cents = amountToCents(cell.value);
        if (cents > MAX_EMPLOYEE_AMOUNT_CENTS) throw new Error('직원 한 명의 인건비는 999999999.99까지 입력할 수 있습니다.');
        amount = centsToAmount(cents);
      } else if (!allowMissingCost) throw new Error('인건비가 비어 있습니다. 인원 명단만 먼저 가져오려면 금액 미입력 허용을 선택해 주세요.');
      if (amount === null) missing += 1;
      const departmentId = classificationMode === 'file' ? resolveClassification({
        code: columns.classification_code == null ? '' : cellText(row[columns.classification_code]),
        group: columns.classification_group == null ? '' : cellText(row[columns.classification_group]),
        function: columns.classification_function == null ? '' : cellText(row[columns.classification_function]),
      }) : undefined;
      codes.add(code);
      result.push({ code, name, title, amount, period, source_department: sourceDepartment, ...(classificationMode === 'file' ? {department_id: departmentId} : {}) });
    } catch (failure) { throw new Error(`${rowIndex + 1}행: ${failure instanceof Error ? failure.message : '입력값을 확인해 주세요.'}`); }
  }
  if (!result.length) throw new Error('선택한 월에 가져올 직원이 없습니다.');
  return { rows: result, excluded_row_count: excluded, missing_cost_count: missing };
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
  if (!/\.(xlsx|csv|tsv|txt)$/i.test(file.name)) throw new Error("XLSX, CSV 또는 TSV/TXT 파일을 선택해 주세요.");
  if (file.size > MAX_IMPORT_BYTES) throw new Error("파일은 10MB까지 올릴 수 있습니다.");
  if (file.size === 0) throw new Error("빈 파일은 올릴 수 없습니다.");
  const [buffer, XLSX] = await Promise.all([file.arrayBuffer(), import("xlsx")]);
  let workbook;
  try {
    // raw preserves leading zeros in CSV; XLSX formatted text is kept per cell below.
    const textFile = /\.(csv|tsv|txt)$/i.test(file.name);
    const input = textFile ? new TextDecoder('utf-8', { fatal: true }).decode(buffer) : buffer;
    workbook = XLSX.read(input, {
      type: textFile ? 'string' : 'array', cellFormula: true, cellText: true, raw: true,
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
  return '\uFEFF月份,工号,姓名,职务,部门,应发工资,可视化部门,可视化职能\r\n2026-01,0001,样例员工,职员,注塑,10000.00,注塑管理,操作工\r\n';
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
