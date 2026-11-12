import {
  MAX_EMPLOYEE_AMOUNT_CENTS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  amountToCents,
  centsToAmount,
  getHeaderColumns,
  normalizeHrJobTitle,
  parsePayrollPeriod,
  suggestColumnMapping,
} from './import.ts';
import type { HrHeaderColumn, HrImportCell, HrWorkbook, HrWorkbookSheet } from './import.ts';
import { getEmployeeCodeCollisions } from './visualization.ts';
import type {
  HrClassificationReference,
  HrEmploymentType,
  HrPayrollSource,
  HrReferenceRow,
  HrWorkbookIssue,
  HrWorkbookMonth,
  HrWorkbookRow,
  HrRosterEntry,
  HrCodeReview,
} from './workbook-types.ts';

const MAX_SOURCE_ROWS = 5100;
const MAX_SOURCE_FILES = 10;
const MAX_BATCH_ROWS = 25000;
const MAX_BATCH_MONTHS = 24;
const HEADER_SEARCH_ROWS = 20;
const CODE_HEADERS = ['code', 'employee code', 'employee id', '사번', '직원번호', '인원코드', '员工编号', '工号'];
const TITLE_HEADERS = ['title', 'job title', '직책', '직급', '직무', '职位', '职务', '岗位'];

type CellDetails = { value: unknown; formatted?: string; formula?: string; error?: boolean };
type Location = { file: string; sheet: string; row: number };
const FIXED_PAY = ['基本工资', '技能工资', '职务工资', '岗位工资', '工龄工资'];
const PAYROLL_ADJUSTMENTS = [
  ['weekday_overtime', '平时加班费'], ['weekend_overtime', '周末加班费'], ['holiday_overtime', '节日加班费'],
  ['personal_leave', '事假'], ['sick_leave', '病假'], ['absence', '缺勤工资'],
] as const;

type PayrollHeader = {
  index: number; code: number; name: number; title: number | null;
  department: number; amount: number; period: number; periodHeader: string; fixedPay: number[];
  baseSalary: number | null; fixedOvertime: number | null;
  adjustments: { field: typeof PAYROLL_ADJUSTMENTS[number][0]; label: string; column: number | null }[];
};
type ReferenceHeader = {
  index: number; code: number | null; name: number; department: number;
  sourceFunction: number; employment: number;
};
type ParsedRow = { key: string; location: Location; row: HrWorkbookRow; fixedPay: number | null };

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function nameIdentity(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, '');
}

function codeKey(value: string): string {
  return /^[0-9]+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
}

function details(cell: HrImportCell): CellDetails {
  return cell && typeof cell === 'object' && 'value' in cell
    ? cell as CellDetails : { value: cell };
}

function assertUsableCell(cell: CellDetails, numericCacheOnly = false): void {
  if (cell.error) throw new Error('오류 셀을 수정해 주세요.');
  const validNumber = typeof cell.value === 'number' && Number.isFinite(cell.value);
  if (cell.formula && !validNumber && (numericCacheOnly || typeof cell.value !== 'string')) {
    throw new Error(numericCacheOnly
      ? '수식의 저장된 숫자 결과가 없습니다. Excel에서 계산 후 저장해 주세요.'
      : '수식의 저장된 문자 또는 숫자 결과가 없습니다. Excel에서 계산 후 저장해 주세요.');
  }
}

function cellText(cell: HrImportCell): string {
  const item = details(cell);
  assertUsableCell(item);
  if (item.value == null) return '';
  if (typeof item.value !== 'string' && typeof item.value !== 'number') {
    throw new Error('문자 또는 숫자 셀을 사용해 주세요.');
  }
  if (typeof item.value === 'number' && !Number.isFinite(item.value)) {
    throw new Error('유효한 숫자 셀을 사용해 주세요.');
  }
  return (item.formatted ?? String(item.value)).trim();
}

function isBlankRow(row: HrImportCell[]): boolean {
  return row.every((cell) => {
    const item = details(cell);
    return !item.error && !item.formula && (item.value == null
      || (typeof item.value === 'string' && item.value.trim() === ''));
  });
}

function context(location: Location, code?: string): string {
  return `${location.file} / ${location.sheet} / ${location.row}행${code ? ` / 사번 ${code}` : ''}`;
}

function at(location: Location, error: unknown): never {
  throw new Error(`${context(location)}: ${error instanceof Error ? error.message : '행을 읽을 수 없습니다.'}`);
}

function requiredText(cell: HrImportCell, label: string, maximum: number): string {
  const text = cellText(cell);
  if (!text) throw new Error(`${label} 값이 없습니다.`);
  if (text.length > maximum) throw new Error(`${label}은 ${maximum}자까지 입력할 수 있습니다.`);
  return text;
}

function validateBook(book: HrWorkbook): void {
  if (!book.sheets.length || book.sheets.length > 50) throw new Error('파일의 시트 수를 확인해 주세요.');
  let physicalRows = 0;
  for (const sheet of book.sheets) {
    physicalRows += sheet.rows.length;
    if (physicalRows > MAX_SOURCE_ROWS) {
      throw new Error(`${book.filename}: 원본은 파일당 ${MAX_SOURCE_ROWS}행까지 읽을 수 있습니다.`);
    }
    const wideRow = sheet.rows.findIndex((row) => row.length > MAX_IMPORT_COLUMNS);
    if (wideRow >= 0) {
      at({ file: book.filename, sheet: sheet.name, row: wideRow + 1 },
        new Error(`열은 ${MAX_IMPORT_COLUMNS}개까지 읽을 수 있습니다.`));
    }
  }
}

function uniqueColumn(headers: HrHeaderColumn[], aliases: readonly string[]): number | null {
  const labels = new Set(aliases.map(normalizeHeader));
  const matches = headers.filter(({ label }) => labels.has(normalizeHeader(label)));
  return matches.length === 1 ? matches[0].index : null;
}

function headerCandidates(sheet: HrWorkbookSheet): { index: number; headers: HrHeaderColumn[] }[] {
  const candidates: { index: number; headers: HrHeaderColumn[] }[] = [];
  for (let index = 0; index < Math.min(HEADER_SEARCH_ROWS, sheet.rows.length); index += 1) {
    // Preamble cells are not employee records. A damaged actual header cannot match
    // the required unique columns and is rejected by the caller below.
    try { candidates.push({ index, headers: getHeaderColumns(sheet, index) }); } catch { /* inspect the next candidate */ }
  }
  return candidates;
}

function payrollHeader(sheet: HrWorkbookSheet): PayrollHeader {
  for (const { index, headers } of headerCandidates(sheet)) {
    const mapping = suggestColumnMapping(headers);
    const amount = uniqueColumn(headers, ['应发工资']);
    // Normalize newlines in a year-labelled period column before suggesting it.
    const periodMapping = suggestColumnMapping(headers.map((header) => ({ ...header, label: normalizeHeader(header.label) })));
    if (mapping.code != null && mapping.name != null && mapping.source_department != null
      && amount != null && periodMapping.period != null) {
      return { index, code: mapping.code, name: mapping.name, title: mapping.title,
        department: mapping.source_department, amount, fixedPay: FIXED_PAY.map((label) => uniqueColumn(headers, [label])).filter((column) => column !== null), period: periodMapping.period,
        baseSalary: uniqueColumn(headers, ['基本工资']), fixedOvertime: uniqueColumn(headers, ['固定平时加班']),
        adjustments: PAYROLL_ADJUSTMENTS.map(([field, label]) => ({ field, label, column: uniqueColumn(headers, [label]) })),
        periodHeader: normalizeHeader(headers.find((header) => header.index === periodMapping.period)?.label ?? '') };
    }
  }
  throw new Error('첫 20행에서 월·사번·성명·부서·应发工资 제목을 찾을 수 없습니다.');
}

function referenceHeader(sheet: HrWorkbookSheet): ReferenceHeader {
  for (const { index, headers } of headerCandidates(sheet)) {
    const mapping = suggestColumnMapping(headers);
    const sourceFunction = uniqueColumn(headers, ['分类', '분류', 'classification']);
    const employment = uniqueColumn(headers, ['雇用性质', '고용형태', 'employment_type', 'employment type']);
    if (mapping.name != null && mapping.source_department != null && sourceFunction != null && employment != null) {
      if (mapping.code == null && headers.some(({ label }) => CODE_HEADERS.some((alias) => normalizeHeader(alias) === normalizeHeader(label)))) {
        throw new Error('기준표의 사번 제목이 여러 개입니다. 한 열만 남겨 주세요.');
      }
      return { index, code: mapping.code, name: mapping.name, department: mapping.source_department, sourceFunction, employment };
    }
  }
  throw new Error('첫 20행에서 分类·姓名·部门·雇用性质 제목을 찾을 수 없습니다.');
}

function employmentType(value: string): HrEmploymentType {
  if (value === '合同工' || value === 'contract') return 'contract';
  if (value === '小时工' || value === 'hourly') return 'hourly';
  throw new Error('고용 형태는 合同工 또는 小时工이어야 합니다.');
}

/** Reads reference labels as source facts; department IDs are resolved by the server. */
export function parseClassificationReference(book: HrWorkbook): HrClassificationReference {
  validateBook(book);
  if (book.sheets.filter((sheet) => !sheet.rows.every(isBlankRow)).length !== 1) {
    throw new Error('분류 기준표는 내용이 있는 시트 한 개만 사용해 주세요.');
  }
  const rows: HrReferenceRow[] = [];
  const identities = new Set<string>();
  const codes = new Set<string>();
  for (const sheet of book.sheets) {
    if (sheet.rows.every(isBlankRow)) continue;
    let header: ReferenceHeader;
    try { header = referenceHeader(sheet); } catch (error) { at({ file: book.filename, sheet: sheet.name, row: 1 }, error); }
    for (let index = header.index + 1; index < sheet.rows.length; index += 1) {
      const values = sheet.rows[index];
      if (isBlankRow(values)) continue;
      const location = { file: book.filename, sheet: sheet.name, row: index + 1 };
      try {
        const name = requiredText(values[header.name], '성명', 100);
        const employment = employmentType(requiredText(values[header.employment], '고용 형태', 20));
        const sourceDepartment = requiredText(values[header.department], '원본 부서', 100);
        const sourceFunction = requiredText(values[header.sourceFunction], '원본 분류', 100);
        const code = header.code == null ? '' : cellText(values[header.code]);
        if (code.length > 64) throw new Error('사번은 64자까지 입력할 수 있습니다.');
        const identity = JSON.stringify([nameIdentity(name), employment]);
        if (identities.has(identity)) throw new Error('같은 성명·고용 형태의 행이 여러 개여서 기준을 확정할 수 없습니다.');
        if (code && codes.has(codeKey(code))) throw new Error(`중복 사번 ${code}을 확인해 주세요.`);
        identities.add(identity);
        if (code) codes.add(codeKey(code));
        rows.push({ ...(code ? { code } : {}), name, employment_type: employment,
          source_department: sourceDepartment, source_function: sourceFunction, source_row: index + 1 });
        if (rows.length > MAX_IMPORT_ROWS) throw new Error(`기준표는 ${MAX_IMPORT_ROWS}명까지 읽을 수 있습니다.`);
      } catch (error) { at(location, error); }
    }
  }
  if (!rows.length) throw new Error('기준표에 가져올 직원 행이 없습니다.');
  return { filename: book.filename, rows };
}

function payrollMonth(cell: HrImportCell, header: string): string {
  const text = requiredText(cell, '급여 월', 30).replace(/\s+/g, '');
  const fullYear = text.match(/^((?:19|20|21)\d{2})[-/年]\d{1,2}月?$/)?.[1];
  const headerYear = header.match(/^((?:19|20|21)\d{2})年$/)?.[1];
  if (!fullYear && !headerYear) throw new Error('급여 연도가 명확하지 않습니다. 원본 월에 연도를 포함해 주세요.');
  // The existing helper may otherwise fall back to targetMonth's year. Supply it
  // only after proving that the source row or its period header gives the year.
  return parsePayrollPeriod(text, `${fullYear ?? headerYear}-01`, header);
}

function payrollAmount(cell: HrImportCell, label = '应发工资'): { amount: string; rounded: boolean } {
  const item = details(cell);
  assertUsableCell(item, true);
  let cents: number;
  let rounded = false;
  try { cents = amountToCents(item.value); } catch (error) {
    if (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0
      || typeof item.formatted !== 'string'
      || !/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(item.formatted.trim())) throw error;
    const displayCents = amountToCents(item.formatted.trim());
    const displayed = displayCents / 100;
    const floatingTolerance = Math.max(1e-12, Number.EPSILON * Math.max(item.value, displayed, 1) * 4);
    if (Math.abs(item.value - displayed) > 0.005 + floatingTolerance) throw error;
    cents = displayCents;
    rounded = true;
  }
  if (cents > MAX_EMPLOYEE_AMOUNT_CENTS) throw new Error(`${label}는 999999999.99 이하로 입력해 주세요.`);
  return { amount: centsToAmount(cents), rounded };
}

function optionalPayrollAmount(cell: HrImportCell, label: string): { amount: string | null; rounded: boolean } {
  const item = details(cell);
  assertUsableCell(item, true);
  if (item.value == null || (typeof item.value === 'string' && item.value.trim() === '')) {
    return { amount: null, rounded: false };
  }
  return payrollAmount(cell, label);
}

export function parseCompanyPayroll(
  inputs: { id: string; book: HrWorkbook; employment_type: HrEmploymentType }[],
  corrections: Record<string, string> = {},
  roster: HrRosterEntry[] = [],
): { files: HrPayrollSource[]; months: HrWorkbookMonth[]; issues: HrWorkbookIssue[]; warnings: string[]; codeReviews: HrCodeReview[] } {
  if (!inputs.length || inputs.length > MAX_SOURCE_FILES) throw new Error(`급여 파일은 1개부터 ${MAX_SOURCE_FILES}개까지 선택해 주세요.`);
  if (new Set(inputs.map(({ id }) => id)).size !== inputs.length || inputs.some(({ id }) => !id.trim())) {
    throw new Error('급여 파일의 식별자가 중복되거나 비어 있습니다.');
  }
  const files: HrPayrollSource[] = [];
  const parsed: ParsedRow[] = [];
  const byMonth = new Map<string, ParsedRow[]>();
  const monthRows = new Map<string, HrWorkbookRow[]>();
  const warnings = new Set<string>();
  for (const input of inputs) {
    if (input.employment_type !== 'contract' && input.employment_type !== 'hourly') throw new Error('파일의 고용 형태를 선택해 주세요.');
    validateBook(input.book);
    files.push({ id: input.id, filename: input.book.filename, employment_type: input.employment_type });
    for (let sheetIndex = 0; sheetIndex < input.book.sheets.length; sheetIndex += 1) {
      const sheet = input.book.sheets[sheetIndex];
      if (sheet.rows.every(isBlankRow)) continue;
      let header: PayrollHeader;
      try { header = payrollHeader(sheet); } catch (error) { at({ file: input.book.filename, sheet: sheet.name, row: 1 }, error); }
      const titleColumns = getHeaderColumns(sheet, header.index).filter(({ label }) =>
        TITLE_HEADERS.some((alias) => normalizeHeader(alias) === normalizeHeader(label)));
      if (titleColumns.length > 1) {
        at({ file: input.book.filename, sheet: sheet.name, row: header.index + 1 },
          new Error('직무 제목이 여러 개입니다. 직무 열을 한 개만 남겨 주세요.'));
      }
      if (input.employment_type === 'contract') {
        const headers = getHeaderColumns(sheet, header.index);
        for (const label of ['基本工资', '固定平时加班', ...PAYROLL_ADJUSTMENTS.map(([, label]) => label)]) {
          if (headers.filter((column) => normalizeHeader(column.label) === label).length > 1) {
            at({ file: input.book.filename, sheet: sheet.name, row: header.index + 1 },
              new Error(`${label} 제목이 여러 개입니다. 원본 열을 한 개만 남겨 주세요.`));
          }
        }
      }
      for (let index = header.index + 1; index < sheet.rows.length; index += 1) {
        const values = sheet.rows[index];
        if (isBlankRow(values)) continue;
        const location = { file: input.book.filename, sheet: sheet.name, row: index + 1 };
        const key = `${input.id}:${sheetIndex}:${index + 1}`;
        try {
          const period = payrollMonth(values[header.period], header.periodHeader);
          const name = requiredText(values[header.name], '성명', 100);
          const sourceDepartment = requiredText(values[header.department], '원본 부서', 100);
          const title = header.title == null ? '' : normalizeHrJobTitle(cellText(values[header.title]));
          if (title.length > 100) throw new Error('직무는 100자까지 입력할 수 있습니다.');
          const originalCode = cellText(values[header.code]);
          if (originalCode.length > 500) throw new Error('원본 사번은 500자까지 읽을 수 있습니다. 원본 파일을 확인해 주세요.');
          const correction = Object.hasOwn(corrections, key) ? corrections[key] : undefined;
          if (correction !== undefined && typeof correction !== 'string') throw new Error('수정 사번은 문자로 입력해 주세요.');
          const code = correction === undefined ? originalCode : correction.trim();
          const { amount, rounded } = payrollAmount(values[header.amount]);
          const row: HrWorkbookRow = { code, name, title, amount, period,
            source_department: sourceDepartment, employment_type: input.employment_type,
            source_file: input.id, source_sheet: sheet.name, source_row: index + 1, original_code: originalCode };
          if (input.employment_type === 'contract') {
            const base = optionalPayrollAmount(header.baseSalary == null ? undefined : values[header.baseSalary], '基本工资');
            const fixed = optionalPayrollAmount(header.fixedOvertime == null ? undefined : values[header.fixedOvertime], '固定平时加班');
            row.payroll_components = { base_salary: base.amount, fixed_overtime: fixed.amount };
            for (const [label, component] of [['基本工资', base], ['固定平时加班', fixed]] as const) {
              if (component.rounded) warnings.add(`${context(location, code)}: ${label} 저장된 소수 금액 대신 Excel 표시 금액(소수 두 자리)을 사용했습니다.`);
            }
            for (const { field, label, column } of header.adjustments) {
              // An absent column is not an observed zero. Leave old source
              // snapshots distinguishable from a supplied but blank cell.
              if (column == null) continue;
              const component = optionalPayrollAmount(values[column], label);
              row.payroll_components[field] = component.amount;
              if (component.rounded) warnings.add(`${context(location, code)}: ${label} 저장된 소수 금액 대신 Excel 표시 금액(소수 두 자리)을 사용했습니다.`);
            }
          }
          let fixedPay: number | null = null;
          if (input.employment_type === 'contract' && header.fixedPay.length === FIXED_PAY.length) {
            try {
              fixedPay = header.fixedPay.reduce((total, column) => {
                const cell = details(values[column]);
                assertUsableCell(cell, true);
                return total + (cell.value == null || cell.value === '' ? 0 : amountToCents(payrollAmount(values[column]).amount));
              }, 0);
            } catch { /* Unusable fixed pay supplies no corroborating evidence. */ }
          }
          const item = { key, location, row, fixedPay };
          parsed.push(item);
          if (parsed.length > MAX_BATCH_ROWS) throw new Error(`급여 직원 행은 전체 ${MAX_BATCH_ROWS}행까지 읽을 수 있습니다.`);
          const rows = monthRows.get(period) ?? [];
          rows.push(row);
          monthRows.set(period, rows);
          if (monthRows.size > MAX_BATCH_MONTHS) throw new Error(`급여 월은 한 번에 ${MAX_BATCH_MONTHS}개월까지 읽을 수 있습니다.`);
          const items = byMonth.get(period) ?? [];
          items.push(item);
          byMonth.set(period, items);
          if (rows.length > MAX_IMPORT_ROWS) throw new Error(`한 달은 ${MAX_IMPORT_ROWS}명까지 읽을 수 있습니다.`);
          if (rounded) warnings.add(`${context(location, code)}: 저장된 소수 금액 대신 Excel 표시 금액(소수 두 자리)을 사용했습니다.`);
        } catch (error) { at(location, error); }
      }
    }
  }
  if (!parsed.length) throw new Error('급여 파일에 가져올 직원 행이 없습니다.');

  const issueMessages = new Map<string, Set<string>>();
  const addIssue = (item: ParsedRow, message: string): void => {
    const messages = issueMessages.get(item.key) ?? new Set<string>();
    messages.add(message);
    issueMessages.set(item.key, messages);
  };
  const identityKey = (name: string, employment: HrEmploymentType) => JSON.stringify([nameIdentity(name), employment]);
  const rowIdentity = ({ row }: ParsedRow) => identityKey(row.name, row.employment_type);
  const byIdentity = new Map<string, ParsedRow[]>();
  const sightings = new Map<string, Map<string, Set<string>>>();
  for (const item of parsed) {
    const { code, period } = item.row;
    const identity = rowIdentity(item);
    const people = byIdentity.get(identity) ?? [];
    people.push(item);
    byIdentity.set(identity, people);
    if (!code) addIssue(item, '사번이 없습니다. 원본 근거를 확인하고 사번을 입력해 주세요.');
    if (code.length > 64) addIssue(item, '사번은 64자까지 입력할 수 있습니다.');
    if (!code || code.length > 64) continue;
    const key = codeKey(code);
    const owners = sightings.get(key) ?? new Map<string, Set<string>>();
    const owner = nameIdentity(item.row.name);
    const months = owners.get(owner) ?? new Set<string>();
    months.add(period);
    owners.set(owner, months);
    sightings.set(key, owners);
  }
  const registeredOwners = new Map(roster.flatMap((entry) =>
    [entry.code, ...entry.previous_codes].map((code) => [codeKey(code), nameIdentity(entry.name)] as const)));
  const ownerOf = (code: string): string | undefined => {
    const key = codeKey(code);
    if (registeredOwners.has(key)) return registeredOwners.get(key);
    const ranked = [...(sightings.get(key) ?? [])].sort((a, b) => b[1].size - a[1].size);
    if (ranked[0] && (!ranked[1] || ranked[0][1].size > ranked[1][1].size)) return ranked[0][0];
    return undefined;
  };
  for (const item of parsed) {
    if (item.row.code && item.row.code.length <= 64 && ownerOf(item.row.code) !== nameIdentity(item.row.name)) {
      addIssue(item, '같은 사번이 서로 다른 성명에 연결되어 있습니다.');
    }
  }
  for (const items of byMonth.values()) {
    const remaining = items.filter((item) => item.row.code && (!ownerOf(item.row.code) || ownerOf(item.row.code) === nameIdentity(item.row.name)));
    const counts = new Map<string, number>();
    for (const { row } of remaining) counts.set(codeKey(row.code), (counts.get(codeKey(row.code)) ?? 0) + 1);
    const collisions = getEmployeeCodeCollisions(remaining.map(({ row }) => row.code));
    for (const item of remaining) {
      if ((counts.get(codeKey(item.row.code)) ?? 0) > 1) addIssue(item, '같은 월에 같은 사번이 여러 번 있습니다.');
      if (collisions.has(item.row.code)) addIssue(item, '다른 원본 사번과 화면 표시 사번이 같습니다. 원본 근거를 확인해 주세요.');
    }
  }
  const validByIdentity = new Map([...byIdentity].map(([identity, items]) =>
    [identity, items.filter((item) => !issueMessages.has(item.key))]));
  // Only a shared exact code/name connects identities across employment types.
  // Keep the original type-specific groups for missing-code recommendations.
  const aliases = new Map<string, string>();
  const canonical = (key: string): string => {
    const parent = aliases.get(key);
    if (!parent || parent === key) return key;
    const root = canonical(parent);
    aliases.set(key, root);
    return root;
  };
  const codePeople = new Map<string, string>();
  const connect = (name: string, employment: HrEmploymentType, code: string) => {
    const key = identityKey(name, employment);
    const evidence = JSON.stringify([nameIdentity(name), codeKey(code)]);
    const owner = codePeople.get(evidence) ?? key;
    aliases.set(canonical(key), canonical(owner));
    codePeople.set(evidence, owner);
  };
  for (const entry of roster) for (const code of [entry.code, ...entry.previous_codes]) connect(entry.name, entry.employment_type, code);
  for (const items of validByIdentity.values()) for (const { row } of items) connect(row.name, row.employment_type, row.code);
  const reviewGroups = new Map<string, ParsedRow[]>();
  for (const [key, items] of validByIdentity) {
    const group = canonical(key);
    reviewGroups.set(group, [...(reviewGroups.get(group) ?? []), ...items]);
  }
  const codeReviews: HrCodeReview[] = [];
  for (const [identity, items] of reviewGroups) {
    const observed = new Map<string, { code: string; months: Set<string> }>();
    for (const { row } of items) {
      const key = codeKey(row.code);
      const entry = observed.get(key) ?? { code: row.code, months: new Set<string>() };
      entry.months.add(row.period);
      observed.set(key, entry);
    }
    const registered = roster.find((entry) => canonical(identityKey(entry.name, entry.employment_type)) === identity);
    if (registered && [...observed.keys()].some((code) => !registeredOwners.has(code))) {
      const key = codeKey(registered.code);
      if (!observed.has(key)) observed.set(key, { code: registered.code, months: new Set() });
    }
    const codes = [...observed.values()].map(({ code, months }) => ({ code, months: [...months].sort() }));
    const row = items.reduce<HrWorkbookRow | undefined>((latest, item) => !latest || item.row.period > latest.period ? item.row : latest, undefined);
    const hasConcurrentCodes = new Set(items.map(({ row }) => row.period)).size !== items.length;
    const employmentMonths = new Map<HrEmploymentType, Set<string>>();
    for (const { row: entry } of items) {
      const months = employmentMonths.get(entry.employment_type) ?? new Set<string>();
      months.add(entry.period);
      employmentMonths.set(entry.employment_type, months);
    }
    if (registered && !employmentMonths.has(registered.employment_type)) employmentMonths.set(registered.employment_type, new Set());
    const employmentChanged = row && employmentMonths.size > 1 && (!registered
      || (row.period >= registered.last_month && row.employment_type !== registered.employment_type));
    const codeChanged = codes.length > 1 && (registered || new Set(codes.flatMap(({ months }) => months)).size > 1)
      && (!registered || codes.some(({ code }) => ![registered.code, ...registered.previous_codes].some((known) => codeKey(known) === codeKey(code))));
    if (row && !hasConcurrentCodes && (codeChanged || employmentChanged)) {
      codeReviews.push({ key: identity, name: row.name, employment_type: row.employment_type, codes,
        ...(employmentChanged ? { employment_types: [...employmentMonths].map(([employment_type, months]) => ({ employment_type, months: [...months].sort() })) } : {}) });
    }
  }
  const monthIndex = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5));
  const issues: HrWorkbookIssue[] = [];
  for (const item of parsed) {
    const messages = issueMessages.get(item.key);
    if (!messages) continue;
    const identity = rowIdentity(item);
    const targetMonth = monthIndex(item.row.period);
    const candidates = new Map<string, NonNullable<HrWorkbookIssue['evidence']>>();
    const registered = roster.filter((entry) => identityKey(entry.name, entry.employment_type) === identity);
    for (const entry of registered) {
      if (item.row.employment_type === 'hourly' && nameIdentity(entry.department) !== nameIdentity(item.row.source_department ?? '')) continue;
      if (ownerOf(entry.code) === nameIdentity(item.row.name)) candidates.set(codeKey(entry.code), { code: entry.code, months: [], roster: true });
    }
    for (const other of validByIdentity.get(identity) ?? []) {
      const distance = Math.abs(monthIndex(other.row.period) - targetMonth);
      if (distance === 0 || ownerOf(other.row.code) !== nameIdentity(item.row.name)) continue;
      const sameDepartment = nameIdentity(other.row.source_department ?? '') === nameIdentity(item.row.source_department ?? '');
      if (item.row.employment_type === 'hourly' && (!sameDepartment || distance !== 1)) continue;
      const delta = item.fixedPay !== null && other.fixedPay !== null ? item.fixedPay - other.fixedPay : null;
      const key = codeKey(other.row.code);
      const evidence = candidates.get(key) ?? { code: other.row.code, months: [] };
      if (!evidence.months.some((month) => month.period === other.row.period && month.fixedPayDifference === delta)) {
        evidence.months.push({ period: other.row.period, fixedPayDifference: delta });
      }
      candidates.set(key, evidence);
    }
    const corroborated = [...candidates.values()].filter((value) =>
      value.roster || value.months.some((month) => month.fixedPayDifference === 0));
    const available = corroborated.length ? corroborated : [...candidates.values()];
    for (const value of available) value.months.sort((a, b) => Math.abs(monthIndex(a.period) - targetMonth) - Math.abs(monthIndex(b.period) - targetMonth));
    const evidence = available.length === 1 && (available[0].roster || available[0].months.some((month) => Math.abs(monthIndex(month.period) - targetMonth) === 1)) && codeKey(available[0].code) !== codeKey(item.row.code) ? available[0] : undefined;
    issues.push({ key: item.key, file: item.location.file, sheet: item.location.sheet,
      row: item.location.row, month: item.row.period, code: item.row.code,
      ...(evidence ? { suggested_code: evidence.code, evidence } : {}), message: [...messages].join(' ') });
  }
  return { files, months: [...monthRows].sort(([a], [b]) => a.localeCompare(b)).map(([month, rows]) => ({ month, rows })),
    issues, codeReviews, warnings: [...warnings] };
}
