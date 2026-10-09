import assert from "node:assert/strict";
import test from "node:test";
import { formatEmployeeCode, getDepartmentCostBreakdowns, getEmployeeCodeCollisions, getMovePreview } from "../src/domains/hr/visualization.ts";
import { moveEmployee } from "../src/domains/hr/layout.ts";
import { hrAssignmentPath, hrGroupLabel } from "../src/domains/hr/labels.ts";
import type { HrDepartment, HrEmployee } from "../src/domains/hr/types.ts";

const departments: HrDepartment[] = [
  { id: "quality", name: "품질", parent_id: null, function: "품질 관리" },
  { id: "quality-cs", name: "CS", parent_id: "quality", function: "고객 품질" },
  { id: "quality-oqc", name: "OQC", parent_id: "quality", function: "출하 검사" },
  { id: "sales", name: "영업", parent_id: null, function: "영업 관리" },
  { id: "sales-cs", name: "CS", parent_id: "sales", function: "고객 대응" },
  { id: "board-chairman", name: "경영", parent_id: null, function: "경영" },
  { id: "custom", name: "추가 조직", parent_id: null, function: "지원" },
  { id: "custom-child", name: "추가 기능", parent_id: "custom", function: "지원 업무" },
];
const employees: HrEmployee[] = [
  { code: "11", name: "직원 A", title: "", amount: "100.10", department_id: "quality-cs" },
  { code: "245", name: "직원 B", title: "", amount: "0.20", department_id: "quality" },
  { code: "A-03", name: "직원 C", title: "", amount: "200.25", department_id: "sales-cs" },
  { code: "00004", name: "직원 D", title: "", amount: "50.05", department_id: null },
];

test("employee code formatting pads only digit codes without changing source keys", () => {
  assert.equal(formatEmployeeCode("11"), "00011");
  assert.equal(formatEmployeeCode("245"), "00245");
  assert.equal(formatEmployeeCode("00011"), "00011");
  assert.equal(formatEmployeeCode("000011"), "000011");
  assert.equal(formatEmployeeCode("123456"), "123456");
  for (const code of ["", "A11", "A-11", "11 ", " 11", "11\n", "１１", "-11", "11.0"]) {
    assert.equal(formatEmployeeCode(code), code);
  }
  assert.equal(employees[0].code, "11");
});

test("display collisions identify every distinct original code while retaining original input keys", () => {
  const codes = Object.freeze(["11", "245", "00011", "0011", "00245", "A11", "000011"]);
  assert.deepEqual(getEmployeeCodeCollisions(codes), new Set(["11", "245", "00011", "0011", "00245"]));
  assert.deepEqual(codes, ["11", "245", "00011", "0011", "00245", "A11", "000011"]);
});

test("repeated identical raw codes are not display collisions and unrelated displays stay untouched", () => {
  assert.deepEqual(getEmployeeCodeCollisions(["11", "11", "245", "A11", "000011"]), new Set());
  assert.deepEqual(getEmployeeCodeCollisions([]), new Set());
  assert.deepEqual(getEmployeeCodeCollisions(["11", "11", "00011", "00011"]), new Set(["11", "00011"]));
});

test("cross-group preview changes both group counts and exact decimal amounts without moving employees", () => {
  const snapshot = structuredClone(employees);
  assert.deepEqual(getMovePreview(departments, employees, "11", "sales-cs"), {
    employeeCode: "11", fromId: "quality-cs", toId: "sales-cs", fromGroupId: "quality", toGroupId: "sales", changes: true,
    groups: [
      { id: "quality", beforeCount: 2, afterCount: 1, beforeAmount: "100.30", afterAmount: "0.20" },
      { id: "sales", beforeCount: 1, afterCount: 2, beforeAmount: "200.25", afterAmount: "300.35" },
    ],
  });
  assert.deepEqual(employees, snapshot);
});

test("a same-group function move reports a change while the root group stays stable", () => {
  const preview = getMovePreview(departments, employees, "11", "quality-oqc")!;
  assert.equal(preview.changes, true);
  assert.equal(preview.fromGroupId, "quality");
  assert.equal(preview.toGroupId, "quality");
  assert.deepEqual(preview.groups, [{ id: "quality", beforeCount: 2, afterCount: 2, beforeAmount: "100.30", afterAmount: "100.30" }]);
  const sameCell = getMovePreview(departments, employees, "11", "quality-cs")!;
  assert.equal(sameCell.changes, false);
  assert.deepEqual(sameCell.groups, preview.groups);
});

test("unassigned staff has its own null group on moves in either direction", () => {
  assert.deepEqual(getMovePreview(departments, employees, "00004", "quality-oqc")!.groups, [
    { id: null, beforeCount: 1, afterCount: 0, beforeAmount: "50.05", afterAmount: "0.00" },
    { id: "quality", beforeCount: 2, afterCount: 3, beforeAmount: "100.30", afterAmount: "150.35" },
  ]);
  assert.deepEqual(getMovePreview(departments, employees, "11", null)!.groups, [
    { id: "quality", beforeCount: 2, afterCount: 1, beforeAmount: "100.30", afterAmount: "0.20" },
    { id: null, beforeCount: 1, afterCount: 2, beforeAmount: "50.05", afterAmount: "150.15" },
  ]);
  assert.equal(getMovePreview(departments, employees, "00004", null)!.changes, false);
});

test("unknown wages keep totals null until the last missing employee leaves that group", () => {
  const missing = employees.map((employee) => employee.code === "11" ? { ...employee, amount: null } : employee);
  const preview = getMovePreview(departments, missing, "11", "sales-cs")!;
  assert.deepEqual(preview.groups, [
    { id: "quality", beforeCount: 2, afterCount: 1, beforeAmount: null, afterAmount: "0.20" },
    { id: "sales", beforeCount: 1, afterCount: 2, beforeAmount: "200.25", afterAmount: null },
  ]);
  const groupHasMissing = [...employees, { code: "unknown", name: "직원 E", title: "", amount: null, department_id: "quality-oqc" }];
  assert.deepEqual(getMovePreview(departments, groupHasMissing, "11", "sales-cs")!.groups[0], {
    id: "quality", beforeCount: 3, afterCount: 2, beforeAmount: null, afterAmount: null,
  });
});

test("leaders and added custom roots remain independent groups", () => {
  const staff: HrEmployee[] = [
    { code: "leader", name: "직원 A", title: "", amount: "1.00", department_id: "board-chairman" },
    { code: "custom-staff", name: "직원 B", title: "", amount: "2.00", department_id: "custom-child" },
  ];
  const preview = getMovePreview(departments, staff, "leader", "custom-child")!;
  assert.equal(preview.fromGroupId, "board-chairman");
  assert.equal(preview.toGroupId, "custom");
  assert.deepEqual(preview.groups, [
    { id: "board-chairman", beforeCount: 1, afterCount: 0, beforeAmount: "1.00", afterAmount: "0.00" },
    { id: "custom", beforeCount: 1, afterCount: 2, beforeAmount: "2.00", afterAmount: "3.00" },
  ]);
});

test("display aliases cannot merge distinct real employee codes", () => {
  const staff: HrEmployee[] = [
    { code: "11", name: "직원 A", title: "", amount: "1.10", department_id: "quality-cs" },
    { code: "00011", name: "직원 B", title: "", amount: "5.00", department_id: "quality-cs" },
  ];
  assert.equal(formatEmployeeCode(staff[0].code), formatEmployeeCode(staff[1].code));
  const first = getMovePreview(departments, staff, "11", "sales-cs")!;
  const second = getMovePreview(departments, staff, "00011", "sales-cs")!;
  assert.equal(first.employeeCode, "11");
  assert.equal(second.employeeCode, "00011");
  assert.equal(first.groups[0].afterAmount, "5.00");
  assert.equal(second.groups[0].afterAmount, "1.10");
  assert.deepEqual(staff.map((employee) => employee.code), ["11", "00011"]);
});

test("invalid targets, missing employees, duplicate keys and invalid source assignments reject previews", () => {
  assert.equal(getMovePreview(departments, employees, "missing", "sales"), null);
  assert.equal(getMovePreview(departments, employees, "11", "missing"), null);
  assert.equal(getMovePreview(departments, employees, "11", ""), null);
  assert.equal(getMovePreview(departments, [...employees, employees[0]], "11", "sales"), null);
  assert.equal(getMovePreview(departments, [{ ...employees[0], department_id: "missing" }], "11", "sales"), null);
});

test("cycles and missing ancestor links cannot loop or masquerade as unassigned groups", () => {
  const cycle = departments.map((department) => department.id === "quality" ? { ...department, parent_id: "quality-cs" } : department);
  assert.equal(getMovePreview(cycle, employees, "11", "sales"), null);
  const orphan = departments.map((department) => department.id === "quality-cs" ? { ...department, parent_id: "missing" } : department);
  assert.equal(getMovePreview(orphan, employees, "11", "sales"), null);
  assert.equal(getMovePreview([...departments, departments[0]], employees, "11", "sales"), null);
});

test("frozen source objects and arrays are supported without mutation", () => {
  const staff = employees.map((employee) => Object.freeze({ ...employee }));
  const units = departments.map((department) => Object.freeze({ ...department }));
  Object.freeze(staff); Object.freeze(units);
  assert.equal(getMovePreview(units, staff, "11", "sales-cs")!.employeeCode, "11");
});

test("department manager and work buckets partition direct and all descendant assignments exactly once", () => {
  const nested = [...departments, { id: 'quality-cs-sub', name: '하위 작업', parent_id: 'quality-cs', function: '' }];
  const staff = [...employees, { code: 'deep', name: '추가 직원', title: '관리자', amount: '10.05', department_id: 'quality-cs-sub' }];
  const result = getDepartmentCostBreakdowns(nested, staff, ['quality', 'sales']).get('quality')!;
  assert.deepEqual(result.management, { count: 1, amount: '0.20', knownAmount: '0.20', missingCount: 0 });
  assert.deepEqual(result.operations, { count: 2, amount: '110.15', knownAmount: '110.15', missingCount: 0 });
  assert.deepEqual(result.total, { count: 3, amount: '110.35', knownAmount: '110.35', missingCount: 0 });
  assert.equal(staff[staff.length - 1].department_id, 'quality-cs-sub');
});

test("missing management cost does not make known work costs unknown, and vice versa", () => {
  const managersMissing = employees.map((person) => person.code === '245' ? { ...person, amount: null } : person);
  const first = getDepartmentCostBreakdowns(departments, managersMissing, ['quality']).get('quality')!;
  assert.equal(first.management.amount, null);
  assert.equal(first.operations.amount, '100.10');
  assert.equal(first.total.amount, null);
  const workersMissing = employees.map((person) => person.code === '11' ? { ...person, amount: null } : person);
  const second = getDepartmentCostBreakdowns(departments, workersMissing, ['quality']).get('quality')!;
  assert.equal(second.management.amount, '0.20');
  assert.equal(second.operations.amount, null);
  assert.equal(second.operations.missingCount, 1);
});

test("same-department manager-to-work moves change role costs while retaining department and company totals", () => {
  const before = getDepartmentCostBreakdowns(departments, employees, ['quality']).get('quality')!;
  const moved = moveEmployee(employees, '245', 'quality-cs', departments);
  const after = getDepartmentCostBreakdowns(departments, moved, ['quality']).get('quality')!;
  assert.deepEqual(after.management, { count: 0, amount: '0.00', knownAmount: '0.00', missingCount: 0 });
  assert.equal(after.operations.amount, '100.30');
  assert.deepEqual(after.total, before.total);
  assert.deepEqual(getDepartmentCostBreakdowns(departments, moveEmployee(moved, '245', 'quality', departments), ['quality']).get('quality'), before);
});

test("unassigned and executive employees do not leak into department role totals; empty manager cells stay zero", () => {
  const staff = [...employees, { code: 'exec', name: '경영', title: '', amount: '900.00', department_id: 'board-chairman' }];
  const result = getDepartmentCostBreakdowns(departments, staff, ['quality', 'sales', 'missing']);
  assert.equal(result.size, 2);
  assert.equal(result.get('sales')!.management.amount, '0.00');
  assert.equal(result.get('sales')!.total.amount, '200.25');
  assert.equal(result.get('quality')!.total.amount, '100.30');
});

test("invalid assignment graphs reject role breakdowns instead of producing partial or looping totals", () => {
  assert.throws(() => getDepartmentCostBreakdowns(departments, [...employees, employees[0]], ['quality']));
  assert.throws(() => getDepartmentCostBreakdowns(departments, [{ ...employees[0], department_id: 'missing' }], ['quality']));
  const cycle = departments.map((department) => department.id === 'quality' ? { ...department, parent_id: 'quality-cs' } : department);
  assert.throws(() => getDepartmentCostBreakdowns(cycle, employees, ['quality']));
});

test("department totals and assignment paths distinguish manager placement from work without changing IDs", () => {
  assert.equal(hrGroupLabel('injection', '注塑管理', 'ko'), '사출');
  assert.equal(hrGroupLabel('injection', '注塑管理', 'zh'), '注塑');
  assert.equal(hrAssignmentPath('injection', [], 'ko'), '사출 › 관리자');
  assert.equal(hrAssignmentPath('injection-operator', [], 'ko'), '사출 › 작업·실무 › 작업자');
  assert.equal(hrAssignmentPath('quality-cs', departments, 'ko'), '품질 › 작업·실무 › 고객대응');
  assert.equal(hrAssignmentPath('sales-cs', departments, 'ko'), '영업 › 작업·실무 › 고객대응');
  assert.equal(hrGroupLabel('injection', '사용자 수정 부서', 'ko'), '사용자 수정 부서');
});
