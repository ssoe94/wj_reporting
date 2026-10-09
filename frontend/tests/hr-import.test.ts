import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMPORT_ROWS,
  amountToCents,
  centsToAmount,
  createTemplateCsv,
  getHeaderColumns,
  parseMappedRows,
  readWorkbook,
  suggestColumnMapping,
  sumImportAmounts,
} from "../src/domains/hr/import.ts";
import type { HrImportCell, HrImportMapping } from "../src/domains/hr/import.ts";

const mapping: HrImportMapping = { headerRowIndex: 0, columns: { code: 0, name: 1, title: 2, amount: 3 } };
const headers = ["사번", "성명", "직책", "총인건비"];

test("mapped import preserves formatted employee codes and normalizes one explicit amount column", () => {
  const rows = parseMappedRows([
    headers,
    [{ value: 7, formatted: "0007" }, "김직원", "생산", "12,345.67", "ignored amount 999"],
    ["0008", "李员工", "", 0.1],
    ["", "", "", "", ""],
  ], mapping);
  assert.deepEqual(rows, [
    { code: "0007", name: "김직원", title: "생산", amount: "12345.67" },
    { code: "0008", name: "李员工", title: "", amount: "0.10" },
  ]);
  assert.equal(sumImportAmounts(rows), "12345.77");
});

test("header selection is explicit and only unique recognized headers are suggested", () => {
  const sheet = { name: "工资", rows: [["2026年9月"], ["工号", "姓名", "岗位", "人工成本"]] };
  const columns = getHeaderColumns(sheet, 1);
  assert.deepEqual(suggestColumnMapping(columns), { code: 0, name: 1, title: 2, amount: 3 });
  assert.deepEqual(parseMappedRows([...sheet.rows, ["0001", "李员工", "生产", "10.00"]], {
    headerRowIndex: 1, columns: { code: 0, name: 1, title: 2, amount: 3 },
  }), [{ code: "0001", name: "李员工", title: "生产", amount: "10.00" }]);
  assert.equal(suggestColumnMapping([{ index: 0, label: "사번" }, { index: 1, label: "사번" }]).code, null);
  assert.throws(() => getHeaderColumns(sheet, 4), /제목 행/);
});

test("title can be unmapped but code, name, and amount remain required", () => {
  assert.deepEqual(parseMappedRows([["code", "name", "amount"], ["001", "직원", "500"]], {
    headerRowIndex: 0, columns: { code: 0, name: 1, title: null, amount: 2 },
  }), [{ code: "001", name: "직원", title: "", amount: "500.00" }]);
  for (const row of [["", "직원", "", 10], ["001", "", "", 10], ["001", "직원", "", ""]]) {
    assert.throws(() => parseMappedRows([headers, row], mapping), /2행:/);
  }
});

test("all nonblank malformed rows reject without quietly skipping or merging people", () => {
  assert.throws(() => parseMappedRows([headers, ["001", "A", "", 10], ["001", "B", "", 20]], mapping), /3행: 중복 사번/);
  assert.throws(() => parseMappedRows([headers, [" 001 ", "A", "", 10], ["001", "B", "", 20]], mapping), /중복 사번/);
  assert.throws(() => parseMappedRows([headers, ["", "", "", "", "unmapped content"]], mapping), /2행: 사번/);
  assert.throws(() => parseMappedRows([headers, ["", "", "", { value: undefined, formula: "A1+B1" }]], mapping), /2행:/);
  assert.throws(() => parseMappedRows([headers, ["001", "A", "", true]], mapping), /숫자/);
  assert.throws(() => parseMappedRows([headers, ["001", "A", "", 10]], {
    ...mapping, columns: { ...mapping.columns, amount: 1 },
  }), /서로 다른 열/);
});

test("money input accepts exact cents and conventional commas while rejecting rounding and negative values", () => {
  for (const value of [-1, "-0.01", NaN, Infinity, "NaN", "1.001", 1.001, "1,23", "1,000,00", "1e3", "", "$10", "(10)"]) {
    assert.throws(() => amountToCents(value), undefined, String(value));
  }
  assert.equal(amountToCents("1,234,567.89"), 123456789);
  assert.equal(amountToCents("00012.3"), 1230);
  assert.equal(centsToAmount(1230), "12.30");
  assert.equal(sumImportAmounts([{ amount: "0.10" }, { amount: "0.20" }]), "0.30");
  assert.throws(() => amountToCents("90071992547409.92"), /범위/);
  assert.throws(() => sumImportAmounts([{ amount: "90071992547409.91" }, { amount: "0.01" }]), /범위/);
});

test("native formula cells require numeric cached results and never calculate a formula", () => {
  assert.deepEqual(parseMappedRows([headers, ["001", "직원", "", { value: 1250.25, formula: "SUM(E2:G2)" }]], mapping), [
    { code: "001", name: "직원", title: "", amount: "1250.25" },
  ]);
  for (const cell of [
    { value: undefined, formula: "SUM(E2:G2)" },
    { value: "1250.25", formula: "SUM(E2:G2)" },
    { value: 42, formula: "SUM(E2:G2)", error: true },
    { value: 42, error: true },
  ]) {
    assert.throws(() => parseMappedRows([headers, ["001", "직원", "", cell]], mapping), /2행:/);
  }
});

test("employee text and amount limits match the persistent server contract", () => {
  const limitRow = ["C".repeat(64), "N".repeat(100), "T".repeat(100), "999999999.99"];
  assert.equal(parseMappedRows([headers, limitRow], mapping)[0].amount, "999999999.99");
  for (const row of [
    ["C".repeat(65), "Name", "Title", "1"],
    ["Code", "N".repeat(101), "Title", "1"],
    ["Code", "Name", "T".repeat(101), "1"],
    ["Code", "Name", "Title", "1000000000.00"],
  ]) {
    assert.throws(() => parseMappedRows([headers, row], mapping), /2행:/);
  }
  assert.equal(sumImportAmounts(Array.from({ length: MAX_IMPORT_ROWS }, () => ({ amount: "999999999.99" }))), "4999999999950.00");
});

test("employee count is bounded and empty sheets cannot produce an accepted import", () => {
  const employees: HrImportCell[][] = Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => [`E${index}`, "직원", "", "1.00"]);
  assert.equal(parseMappedRows([headers, ...employees], mapping).length, MAX_IMPORT_ROWS);
  assert.throws(() => parseMappedRows([headers, ...employees, ["overflow", "직원", "", "1.00"]], mapping), /5000명/);
  assert.throws(() => parseMappedRows([headers, ["", "", "", ""]], mapping), /가져올 직원/);
  const csv = createTemplateCsv();
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("code,name,title,amount\r\n0001,"));
});

test("real XLSX and UTF-8 CSV files keep zero-padded employee codes", async () => {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, [7, "李员工", "生产", 1234.5]]);
  sheet.A2.z = "0000";
  XLSX.utils.book_append_sheet(workbook, sheet, "工资");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const imported = await readWorkbook(new File([buffer], "工资.xlsx"));
  assert.equal(parseMappedRows(imported.sheets[0].rows, mapping)[0].code, "0007");

  const csv = await readWorkbook(new File([createTemplateCsv()], "인건비.csv"));
  const row = parseMappedRows(csv.sheets[0].rows, mapping)[0];
  assert.equal(row.code, "0001");
  assert.equal(row.name, "홍길동");
  assert.equal(row.amount, "10000.00");
  await assert.rejects(() => readWorkbook(new File(["x"], "payroll.xls")), /XLSX 또는 CSV/);
  await assert.rejects(() => readWorkbook(new File([], "payroll.xlsx")), /빈 파일/);
});
