import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DEPARTMENTS,
  MAX_DEPARTMENT_DEPTH,
  buildAssignments,
  flattenDepartments,
  getDepartmentTree,
  getDescendantIds,
  moveDepartment,
  moveEmployee,
  validateAssignments,
  validateDepartments,
} from "../src/domains/hr/layout.ts";
import type { HrDepartment, HrEmployee } from "../src/domains/hr/types.ts";

const departments: HrDepartment[] = [
  { id: "company", name: "회사", parent_id: null, function: "경영" },
  { id: "production", name: "생산", parent_id: "company", function: "생산 운영" },
  { id: "injection", name: "사출", parent_id: "production", function: "성형" },
  { id: "admin", name: "총무", parent_id: "company", function: "지원" },
];
const employees: HrEmployee[] = [
  { code: "001", name: "직원 A", title: "작업자", amount: "100.10", department_id: "injection" },
  { code: "002", name: "직원 B", title: "담당자", amount: "200.20", department_id: null },
];

test("hierarchy uses stable input order and exposes descendants with exact depth", () => {
  assert.deepEqual(flattenDepartments(departments).map(({ department, depth }) => [department.id, depth]), [
    ["company", 0], ["production", 1], ["injection", 2], ["admin", 1],
  ]);
  assert.deepEqual([...getDescendantIds(departments, "production")], ["injection"]);
  assert.equal(getDepartmentTree(departments)[0].children.length, 2);
  assert.throws(() => getDescendantIds(departments, "missing"), /찾을 수/);
});

test("department moves reject self-parent, descendants, missing parents and ambiguous IDs", () => {
  assert.throws(() => moveDepartment(departments, "company", "injection"), /순환/);
  assert.throws(() => moveDepartment(departments, "production", "production"), /순환/);
  assert.throws(() => moveDepartment(departments, "production", "missing"), /상위 부서/);
  assert.throws(() => moveDepartment(departments, "missing", null), /찾을 수/);
  assert.throws(() => validateDepartments([...departments, departments[0]]), /중복/);
  const moved = moveDepartment(departments, "injection", "admin");
  assert.equal(moved.find((department) => department.id === "injection")?.parent_id, "admin");
  assert.equal(departments[2].parent_id, "production");
});

test("assignment moves retain every employee and amount exactly once", () => {
  const moved = moveEmployee(employees, "001", "admin", departments);
  assert.equal(moved.length, employees.length);
  assert.equal(moved[0].department_id, "admin");
  assert.deepEqual(moved.map(({ code, amount }) => ({ code, amount })), employees.map(({ code, amount }) => ({ code, amount })));
  assert.equal(employees[0].department_id, "injection");
  const unassigned = moveEmployee(moved, "001", null, departments);
  assert.deepEqual(buildAssignments(unassigned), [{ code: "001", department_id: null }, { code: "002", department_id: null }]);
});

test("missing or duplicate employee assignments cannot be submitted", () => {
  assert.throws(() => moveEmployee(employees, "001", "missing", departments), /부서를 찾을 수/);
  assert.throws(() => moveEmployee(employees, "missing", null, departments), /직원을 찾을 수/);
  assert.throws(() => validateAssignments([...employees, employees[0]], departments), /중복/);
  assert.throws(() => buildAssignments([...employees, employees[0]]), /중복/);
  assert.throws(() => validateAssignments([{ ...employees[0], department_id: "missing" }], departments), /부서를 찾을 수/);
});

test("department count and required names are bounded", () => {
  assert.throws(() => validateDepartments([{ ...departments[0], name: " " }]), /부서명/);
  assert.throws(() => validateDepartments(Array.from({ length: MAX_DEPARTMENTS + 1 }, (_, index) => ({
    id: `d-${index}`, name: `부서 ${index}`, parent_id: null, function: "",
  }))), /200개/);
});

test("department text limits and eight-level hierarchy match the server contract", () => {
  validateDepartments([{ id: "I".repeat(64), name: "N".repeat(100), parent_id: null, function: "F".repeat(500) }]);
  for (const department of [
    { ...departments[0], id: "I".repeat(65) },
    { ...departments[0], name: "N".repeat(101) },
    { ...departments[0], function: "F".repeat(501) },
  ]) {
    assert.throws(() => validateDepartments([department]), /까지 입력/);
  }
  const chain = Array.from({ length: MAX_DEPARTMENT_DEPTH }, (_, index) => ({
    id: `level-${index}`, name: `부서 ${index}`, parent_id: index === 0 ? null : `level-${index - 1}`, function: "",
  }));
  validateDepartments(chain);
  assert.throws(() => validateDepartments([...chain, {
    id: "too-deep", name: "초과 부서", parent_id: chain.at(-1)!.id, function: "",
  }]), /8단계/);
});
