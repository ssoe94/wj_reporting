import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClassificationReference, parseCompanyPayroll } from '../src/domains/hr/workbook-import.ts';
import { readWorkbook } from '../src/domains/hr/import.ts';
import type { HrImportCell, HrWorkbook } from '../src/domains/hr/import.ts';
import type { HrEmploymentType } from '../src/domains/hr/workbook-types.ts';

const contractHeaders = ['2026年', '工号', '姓名', '职务', '部门', '应发工资', '实发工资'];
const hourlyHeaders = ['2026年', '部门', '工号', '姓名', '小时数', '应发工资'];
const referenceHeaders = ['序号', '分类', '姓名', '部门', '雇用性质', '工号'];
const book = (rows: HrImportCell[][], filename = 'synthetic.xlsx', sheet = '工资'): HrWorkbook => ({
  filename, sheets: [{ name: sheet, rows }],
});
const source = (rows: HrImportCell[][], id = 'contract', employment: HrEmploymentType = 'contract') => ({
  id, book: book(rows, `${id}.xlsx`), employment_type: employment,
});
const contract = (month: HrImportCell = '1月', code: HrImportCell = '00011', name: HrImportCell = '合成员工甲', amount: HrImportCell = '10.00'): HrImportCell[] =>
  [month, code, name, '合成职务', '合成部门', amount, '999.00'];

test('two explicit employment files split seven months and retain source facts without target classification', () => {
  const contractRows = [contractHeaders, ...Array.from({ length: 7 }, (_, i) => contract(`${i + 1}月`))];
  const hourlyRows = [hourlyHeaders, ...Array.from({ length: 7 }, (_, i) => [`${i + 1}月`, '合成部门', '00245', '合成员工乙', 20, '0.20'])];
  const result = parseCompanyPayroll([source(contractRows), source(hourlyRows, 'hourly', 'hourly')]);
  assert.deepEqual(result.months.map(({ month }) => month), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
  assert.deepEqual(result.files, [
    { id: 'contract', filename: 'contract.xlsx', employment_type: 'contract' },
    { id: 'hourly', filename: 'hourly.xlsx', employment_type: 'hourly' },
  ]);
  assert.equal(result.months[0].rows.length, 2);
  assert.deepEqual(result.months[0].rows[0], { code: '00011', name: '合成员工甲', title: '合成职务',
    amount: '10.00', period: '2026-01', source_department: '合成部门', employment_type: 'contract',
    source_file: 'contract', source_sheet: '工资', source_row: 2, original_code: '00011' });
  assert.equal(result.months[0].rows[1].title, '');
  assert.ok(result.months.flatMap(({ rows }) => rows).every((row) => !Object.hasOwn(row, 'department_id')));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings, []);
});

test('header detection accepts first twenty rows and newline aliases but always selects 应发工资', () => {
  const headers = ['2026\n年', '工\n号', '姓\n名', '职务', '部门', '应发\n工资', '实发工资'];
  const result = parseCompanyPayroll([source([...Array.from({ length: 19 }, () => ['合成标题']), headers, contract()])]);
  assert.equal(result.months[0].rows[0].source_row, 21);
  assert.equal(result.months[0].rows[0].amount, '10.00');
  assert.throws(() => parseCompanyPayroll([source([...Array.from({ length: 20 }, () => ['合成标题']), contractHeaders, contract()])]), /20행/);
  assert.throws(() => parseCompanyPayroll([source([['2026年', '工号', '姓名', '职务', '部门', '实发工资'], contract()])]), /应发工资/);
  assert.throws(() => parseCompanyPayroll([source([[...contractHeaders, '应发工资'], [...contract(), 10]])]), /应发工资/);
});

test('ambiguous known title headers reject without dropping either value, while hourly files may omit title', () => {
  for (const titles of [['职务', '岗位'], ['职务', '职务'], ['직무', 'job\n title']]) {
    const headers = ['2026年', '工号', '姓名', ...titles, '部门', '应发工资'];
    const input = source([['合成标题'], headers,
      ['1月', '00011', 'PRIVATE_SYNTHETIC_NAME', 'PRIVATE_TITLE_ONE', 'PRIVATE_TITLE_TWO', '部门', '10.00']]);
    assert.throws(() => parseCompanyPayroll([input]), (error: Error) =>
      error.message.includes('contract.xlsx / 工资 / 2행: 직무 제목이 여러 개')
      && !error.message.includes('PRIVATE_SYNTHETIC_NAME') && !error.message.includes('PRIVATE_TITLE'));
  }
  const noTitle = parseCompanyPayroll([source([hourlyHeaders,
    ['1月', '部门', '00245', '合成员工乙', 20, '0.20']], 'hourly', 'hourly')]);
  assert.equal(noTitle.months[0].rows[0].title, '');
  assert.equal(noTitle.months[0].rows[0].amount, '0.20');
  assert.deepEqual(noTitle.issues, []);
  assert.deepEqual(noTitle.warnings, []);
});

test('months must come from the source and never borrow the current or selected year', () => {
  const headers = ['月份', ...contractHeaders.slice(1)];
  assert.equal(parseCompanyPayroll([source([headers, contract('2025/12')])]).months[0].month, '2025-12');
  for (const month of ['1月', '', '2026-13', '2026-00', '2026-01-02', 'invalid']) {
    assert.throws(() => parseCompanyPayroll([source([headers, contract(month)])]), /2행:/);
  }
  assert.throws(() => parseCompanyPayroll([source([[...contractHeaders, '2027年'], [...contract(), '1月']])]), /제목/);
});

test('formatted keys retain leading zeroes, monthly duplicate and display collisions keep every problem row', () => {
  const padded = parseCompanyPayroll([source([contractHeaders, contract('1月', { value: 11, formatted: '00011' })])]);
  assert.equal(padded.months[0].rows[0].original_code, '00011');
  const collision = parseCompanyPayroll([source([contractHeaders, contract('1月', '11'), contract('1月', '00011', '合成员工乙')])]);
  assert.deepEqual(collision.months[0].rows.map(({ code }) => code), ['11', '00011']);
  assert.equal(collision.issues.length, 2);
  assert.ok(collision.issues.every(({ message }) => message.includes('화면 표시 사번')));
  const duplicate = parseCompanyPayroll([source([contractHeaders, contract(), contract('1月', '00011')])]);
  assert.equal(duplicate.months[0].rows.length, 2);
  assert.equal(duplicate.issues.length, 2);
  assert.ok(duplicate.issues.every(({ message }) => message.includes('같은 월')));
  assert.equal(parseCompanyPayroll([source([contractHeaders, contract(), contract('2月')])]).issues.length, 0);
});

test('missing code is reviewable with a unique other-month suggestion and corrections preserve its source', () => {
  const inputs = [source([contractHeaders, contract('1月', ''), contract('2月', '00011')])];
  const result = parseCompanyPayroll(inputs);
  assert.equal(result.months[0].rows.length, 1);
  assert.deepEqual(result.issues.map(({ key, code, suggested_code }) => ({ key, code, suggested_code })), [
    { key: 'contract:0:2', code: '', suggested_code: '00011' },
  ]);
  const corrected = parseCompanyPayroll(inputs, { 'contract:0:2': ' 00011 ' });
  assert.deepEqual(corrected.issues, []);
  assert.equal(corrected.months[0].rows[0].code, '00011');
  assert.equal(corrected.months[0].rows[0].original_code, '');
  assert.equal(inputs[0].book.sheets[0].rows[1][1], '');
});

test('one code linked to different names across months blocks all involved rows and explicit correction resolves it', () => {
  const inputs = [source([contractHeaders, contract('1月', '00011', '合成员工甲'), contract('2月', '00011', '合成员工乙')])];
  const initial = parseCompanyPayroll(inputs);
  assert.equal(initial.issues.length, 2);
  assert.ok(initial.issues.every(({ message }) => message.includes('서로 다른 성명')));
  assert.ok(initial.issues.every(({ message }) => !message.includes('合成员工')));
  const resolved = parseCompanyPayroll(inputs, { 'contract:0:3': '00245' });
  assert.deepEqual(resolved.issues, []);
  assert.equal(resolved.months[1].rows[0].original_code, '00011');
  assert.equal(resolved.months[1].rows[0].code, '00245');
});

test('different codes for one identity across months warn without guessing or changing either key', () => {
  const result = parseCompanyPayroll([source([contractHeaders, contract('1月', '00011'), contract('2月', '00245')])]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.months.map(({ rows }) => rows[0].code), ['00011', '00245']);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => !warning.includes('合成员工甲')));
  const ambiguous = parseCompanyPayroll([source([contractHeaders, contract('1月', ''), contract('2月', '00011'), contract('3月', '00245')])]);
  assert.equal(ambiguous.issues[0].suggested_code, undefined);
});

test('formula results are read from numeric caches; error and missing-cache cells fail at the source row', () => {
  const cached = parseCompanyPayroll([source([contractHeaders, contract('1月', '00011', '合成员工甲', { value: 0.3, formula: 'SUM(H2:I2)' })])]);
  assert.equal(cached.months[0].rows[0].amount, '0.30');
  for (const amount of [
    { value: undefined, formula: 'SUM(H2:I2)' }, { value: '10.00', formula: 'SUM(H2:I2)' },
    { value: 10, formula: 'SUM(H2:I2)', error: true }, { value: 10, error: true },
  ]) {
    assert.throws(() => parseCompanyPayroll([source([contractHeaders, contract('1月', '00011', 'PRIVATE_SYNTHETIC_NAME', amount)])]),
      (error: Error) => error.message.includes('contract.xlsx / 工资 / 2행:') && !error.message.includes('PRIVATE_SYNTHETIC_NAME'));
  }
});

test('text formulas accept saved strings, including an optional empty title, without weakening amount caches', () => {
  const row = contract();
  row[2] = { value: '合成员工甲', formula: 'VLOOKUP(B2,名单!A:B,2,FALSE)' };
  row[3] = { value: '合成职务', formula: 'VLOOKUP(B2,名单!A:C,3,FALSE)' };
  row[4] = { value: '合成部门', formula: 'VLOOKUP(B2,名单!A:D,4,FALSE)' };
  const result = parseCompanyPayroll([source([contractHeaders, row])]);
  assert.equal(result.months[0].rows[0].name, '合成员工甲');
  assert.equal(result.months[0].rows[0].title, '合成职务');
  assert.equal(result.months[0].rows[0].source_department, '合成部门');
  assert.equal(parseCompanyPayroll([source([contractHeaders, [...row.slice(0, 3), { value: '', formula: 'IF(A1,"","")' }, ...row.slice(4)]])])
    .months[0].rows[0].title, '');
  for (const cell of [{ value: undefined, formula: 'A1' }, { value: null, formula: 'A1' },
    { value: true, formula: 'A1' }, { value: '合成职务', formula: 'A1', error: true }]) {
    assert.throws(() => parseCompanyPayroll([source([contractHeaders, [...row.slice(0, 3), cell, ...row.slice(4)]])]), /2행:/);
  }
  assert.throws(() => parseCompanyPayroll([source([contractHeaders,
    contract('1月', '00011', '合成员工甲', { value: '10.00', formula: 'SUM(H2:I2)' })])]), /저장된 숫자 결과/);
});

test('name and numeric-code comparison matches backend normalization while preserving source spelling', () => {
  const same = parseCompanyPayroll([source([contractHeaders,
    contract('1月', '000011', '\u1100\u1161 합성'), contract('2月', '11', '가\n합 성')])]);
  assert.deepEqual(same.issues, []);
  assert.deepEqual(same.warnings, []);
  assert.deepEqual(same.months.map(({ rows }) => rows[0].code), ['000011', '11']);
  assert.deepEqual(same.months.map(({ rows }) => rows[0].name), ['\u1100\u1161 합성', '가\n합 성']);
  const conflicting = parseCompanyPayroll([source([contractHeaders,
    contract('1月', '000011', '合成甲'), contract('2月', '11', '合成乙')])]);
  assert.equal(conflicting.issues.length, 2);
  assert.ok(conflicting.issues.every(({ message }) => message.includes('서로 다른 성명')));
  assert.deepEqual(parseCompanyPayroll([source([contractHeaders,
    contract('1月', '000011', '合成甲'), contract('2月', '11', '合成乙')])], { 'contract:0:3': '245' }).issues, []);
  const duplicate = parseCompanyPayroll([source([contractHeaders,
    contract('1月', '000011'), contract('1月', '00011')])]);
  assert.equal(duplicate.issues.length, 2);
  assert.ok(duplicate.issues.every(({ message }) => message.includes('같은 월')));
  const missing = parseCompanyPayroll([source([contractHeaders,
    contract('1月', '', '合成 甲'), contract('2月', '00011', '合成甲')])]);
  assert.equal(missing.issues[0].suggested_code, '00011');
});

test('only numeric cached values with a close two-decimal Excel display may use displayed cents', () => {
  for (const [value, formatted, expected] of [[1234.567, '1,234.57', '1234.57'], [1.005, '1.01', '1.01'], [0.0049, '0.00', '0.00']] as const) {
    const result = parseCompanyPayroll([source([contractHeaders, contract('1月', '00011', '合成员工甲', { value, formatted, formula: 'SUM(H2:I2)' })])]);
    assert.equal(result.months[0].rows[0].amount, expected);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Excel 표시 금액/);
    assert.ok(!result.warnings[0].includes('合成员工甲'));
  }
  for (const amount of ['1.005', 1.005, { value: '1.005', formatted: '1.01' },
    { value: 1.005, formatted: '1.01x' }, { value: 1.005, formatted: '1.010' },
    { value: 1.005, formatted: '1.02' }, { value: -0.001, formatted: '0.00' },
    { value: NaN, formatted: '0.00' }]) {
    assert.throws(() => parseCompanyPayroll([source([contractHeaders, contract('1月', '00011', '合成员工甲', amount)])]), /2행:/);
  }
  assert.deepEqual(parseCompanyPayroll([source([contractHeaders, contract('1月', '00011', '合成员工甲', { value: 10.25, formatted: '10.00' })])]).warnings, []);
});

test('nonblank malformed rows are never omitted and explicit zero differs from a missing wage', () => {
  for (const row of [contract('1月', '00011', '', 10), contract('1月', '00011', '合成员工甲', ''),
    ['1月', '', '', '', '', '', 'unmapped nonblank'], contract('1月', '00011', '合成员工甲', -1)]) {
    assert.throws(() => parseCompanyPayroll([source([contractHeaders, row])]), /2행:/);
  }
  assert.equal(parseCompanyPayroll([source([contractHeaders, [], ['', '', '', '', '', ''], contract('1月', '00011', '合成员工甲', 0)])]).months[0].rows[0].amount, '0.00');
  assert.throws(() => parseCompanyPayroll([source([contractHeaders])]), /가져올 직원/);
});

test('reference parser preserves source labels and separates same name by employment while rejecting same-type ambiguity', () => {
  const rows = [referenceHeaders, [1, '合成分类', '合成员工甲', '合成部门', '合同工', '00011'],
    [2, '第二分类', '合成员工甲', '第二部门', '小时工', '00245']];
  const result = parseClassificationReference(book(rows, 'reference.xlsx', '名单'));
  assert.deepEqual(result, { filename: 'reference.xlsx', rows: [
    { code: '00011', name: '合成员工甲', employment_type: 'contract', source_department: '合成部门', source_function: '合成分类', source_row: 2 },
    { code: '00245', name: '合成员工甲', employment_type: 'hourly', source_department: '第二部门', source_function: '第二分类', source_row: 3 },
  ] });
  assert.ok(result.rows.every((row) => !Object.hasOwn(row, 'department_id')));
  assert.throws(() => parseClassificationReference(book([referenceHeaders, rows[1], [3, '分类', '合成员工甲', '部门', '合同工', '00399']])), /같은 성명·고용 형태/);
  assert.throws(() => parseClassificationReference(book([referenceHeaders, rows[1], [3, '分类', '合成员工乙', '部门', '小时工', '00011']])), /중복 사번/);
  assert.equal(parseClassificationReference(book([referenceHeaders.slice(0, 5), rows[1].slice(0, 5)])).rows[0].code, undefined);
  assert.throws(() => parseClassificationReference(book([[...referenceHeaders, 'code'], [...rows[1], '00245']])), /사번 제목이 여러 개/);
  for (const row of [[1, '', 'PRIVATE_SYNTHETIC_NAME', '部门', '合同工'], [1, '分类', '', '部门', '合同工'],
    [1, '分类', 'PRIVATE_SYNTHETIC_NAME', '', '合同工'], [1, '分类', 'PRIVATE_SYNTHETIC_NAME', '部门', '未知']]) {
    assert.throws(() => parseClassificationReference(book([referenceHeaders, row])),
      (error: Error) => error.message.includes('2행:') && !error.message.includes('PRIVATE_SYNTHETIC_NAME'));
  }
});

test('reference rejects normalized name or numeric-code duplicates and multiple nonempty sheets', () => {
  assert.throws(() => parseClassificationReference(book([referenceHeaders,
    [1, '分类', '\u1100\u1161 합성', '部门', '合同工', '11'], [2, '分类', '가\n합 성', '部门', '合同工', '245']])), /같은 성명·고용 형태/);
  assert.throws(() => parseClassificationReference(book([referenceHeaders,
    [1, '分类', '合成甲', '部门', '合同工', '000011'], [2, '分类', '合成乙', '部门', '小时工', '11']])), /중복 사번/);
  assert.throws(() => parseClassificationReference(book([referenceHeaders,
    [1, '分类', '合成甲', '部门', '合同工', '00000'], [2, '分类', '合成乙', '部门', '小时工', '0']])), /중복 사번/);
  const one = book([referenceHeaders, [1, '分类', '合成甲', '部门', '合同工', '11']]);
  assert.throws(() => parseClassificationReference({ ...one, sheets: [...one.sheets,
    { name: '名单2', rows: [referenceHeaders, [2, '分类', '合成乙', '部门', '小时工', '245']] }] }), /시트 한 개/);
  assert.equal(parseClassificationReference({ ...one, sheets: [...one.sheets, { name: '空白', rows: [[], ['']] }] }).rows.length, 1);
});

test('at most twenty-four source months and five hundred original-code characters are accepted', () => {
  const rows = Array.from({ length: 24 }, (_, i) => contract(`${2025 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`));
  assert.equal(parseCompanyPayroll([source([contractHeaders, ...rows])]).months.length, 24);
  assert.throws(() => parseCompanyPayroll([source([contractHeaders, ...rows, contract('2027-01')])]), /24개월/);
  const longCode = 'C'.repeat(500);
  const result = parseCompanyPayroll([source([contractHeaders, contract('1月', longCode)])], { 'contract:0:2': '00011' });
  assert.deepEqual(result.issues, []);
  assert.equal(result.months[0].rows[0].original_code, longCode);
  assert.throws(() => parseCompanyPayroll([source([contractHeaders, contract('1月', 'C'.repeat(501))])],
    { 'contract:0:2': '00011' }), /원본 사번은 500자/);
});

test('physical rows, monthly employees, total employees, files and text/amount bounds enforce the shared contract', () => {
  const uniqueRows = Array.from({ length: 5000 }, (_, index) => contract('1月', `C${index}`, `合成${index}`, '999999999.99'));
  assert.equal(parseCompanyPayroll([source([contractHeaders, ...uniqueRows])]).months[0].rows.length, 5000);
  assert.throws(() => parseCompanyPayroll([source([contractHeaders, ...uniqueRows, contract('1月', 'overflow')])]), /5000명/);
  assert.throws(() => parseCompanyPayroll([source([contractHeaders, ...Array.from({ length: 5100 }, () => [])])]), /5100행/);
  assert.throws(() => parseCompanyPayroll(Array.from({ length: 11 }, (_, i) => source([contractHeaders, contract()], `F${i}`))), /10개/);
  assert.throws(() => parseCompanyPayroll([source([contractHeaders, contract()]), source([contractHeaders, contract()])]), /식별자/);
  const batch = Array.from({ length: 6 }, (_, i) => source([contractHeaders,
    ...uniqueRows.map((row) => [`${i + 1}月`, ...row.slice(1)])], `F${i}`));
  assert.throws(() => parseCompanyPayroll(batch), /25000행/);
  for (const row of [contract('1月', '00011', 'N'.repeat(101)), contract('1月', '00011', '合成员工甲', '1000000000'),
    ['1月', '00011', '合成员工甲', 'T'.repeat(101), '部门', 10], ['1月', '00011', '合成员工甲', '', 'D'.repeat(101), 10]]) {
    assert.throws(() => parseCompanyPayroll([source([contractHeaders, row])]), /2행:/);
  }
  assert.equal(parseCompanyPayroll([source([contractHeaders, contract('1月', 'C'.repeat(65))])]).issues.length, 1);
  assert.throws(() => parseClassificationReference(book([referenceHeaders, ...Array.from({ length: 5001 }, (_, i) =>
    [i, '分类', `合成${i}`, '部门', '合同工', `C${i}`])])), /5000명/);
});

test('synthetic SheetJS workbook preserves padded keys and cached display precision through readWorkbook', async () => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([contractHeaders, contract('1月', 11, '合成员工甲', 1234.567)]);
  sheet.B2.z = '00000';
  sheet.F2.z = '#,##0.00';
  sheet.F2.f = 'SUM(H2:I2)';
  sheet.D2.f = 'VLOOKUP(B2,名单!A:C,3,FALSE)';
  sheet.E2.f = 'VLOOKUP(B2,名单!A:D,4,FALSE)';
  XLSX.utils.book_append_sheet(workbook, sheet, '工资');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseCompanyPayroll([{ id: 'synthetic', employment_type: 'contract',
    book: await readWorkbook(new File([buffer], 'synthetic.xlsx')) }]);
  assert.equal(parsed.months[0].rows[0].code, '00011');
  assert.equal(parsed.months[0].rows[0].original_code, '00011');
  assert.equal(parsed.months[0].rows[0].amount, '1234.57');
  assert.equal(parsed.months[0].rows[0].title, '合成职务');
  assert.equal(parsed.months[0].rows[0].source_department, '合成部门');
  assert.equal(parsed.warnings.length, 1);
});
