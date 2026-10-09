import { amountToCents, centsToAmount } from "./import.ts";
import { validateAssignments } from "./layout.ts";
import type { HrDepartment, HrEmployee } from "./types.ts";

export type HrMovePreviewGroup = {
  id: string | null;
  beforeCount: number;
  afterCount: number;
  beforeAmount: string | null;
  afterAmount: string | null;
};

export type HrMovePreview = {
  employeeCode: string;
  fromId: string | null;
  toId: string | null;
  fromGroupId: string | null;
  toGroupId: string | null;
  groups: HrMovePreviewGroup[];
  changes: boolean;
};

/** Display only: callers must keep the original code for selection and writes. */
export function formatEmployeeCode(code: string): string {
  return code.length > 0 && !/[^0-9]/.test(code) ? code.padStart(5, "0") : code;
}

/** Original keys whose display codes are shared by distinct original keys. */
export function getEmployeeCodeCollisions(codes: readonly string[]): Set<string> {
  const originalsByDisplay = new Map<string, Set<string>>();
  for (const code of codes) {
    const display = formatEmployeeCode(code);
    const originals = originalsByDisplay.get(display) ?? new Set<string>();
    originals.add(code);
    originalsByDisplay.set(display, originals);
  }
  return new Set(codes.filter((code) => originalsByDisplay.get(formatEmployeeCode(code))!.size > 1));
}

type GroupTotal = { count: number; cents: number; missing: number };

function addEmployee(total: GroupTotal, employee: HrEmployee): void {
  total.count += 1;
  if (employee.amount === null) {
    total.missing += 1;
    return;
  }
  const updated = total.cents + amountToCents(employee.amount);
  if (!Number.isSafeInteger(updated)) throw new Error("인건비 합계가 처리 가능한 범위를 초과했습니다.");
  total.cents = updated;
}

function totalAmount(total: GroupTotal): string | null {
  return total.missing > 0 ? null : centsToAmount(total.cents);
}

export type HrCostBucket = { count: number; amount: string | null; knownAmount: string; missingCount: number };
export type HrDepartmentCostBreakdown = { management: HrCostBucket; operations: HrCostBucket; total: HrCostBucket };

/** A group's direct assignments are managers; every descendant is work within that group. */
export function getDepartmentCostBreakdowns(departments: HrDepartment[], employees: HrEmployee[], groupIds: string[]): Map<string, HrDepartmentCostBreakdown> {
  validateAssignments(employees, departments);
  const byId = new Map(departments.map((department) => [department.id, department]));
  const empty = (): GroupTotal => ({ count: 0, cents: 0, missing: 0 });
  const groups = new Map(groupIds.filter((id) => byId.has(id)).map((id) => [id, { management: empty(), operations: empty(), total: empty() }]));
  for (const employee of employees) {
    let id = employee.department_id;
    while (id !== null) {
      const group = groups.get(id);
      if (group) {
        addEmployee(group.total, employee);
        addEmployee(employee.department_id === id ? group.management : group.operations, employee);
      }
      id = byId.get(id)!.parent_id;
    }
  }
  const bucket = (value: GroupTotal): HrCostBucket => ({ count: value.count, amount: totalAmount(value), knownAmount: centsToAmount(value.cents), missingCount: value.missing });
  return new Map([...groups].map(([id, value]) => [id, { management: bucket(value.management), operations: bucket(value.operations), total: bucket(value.total) }]));
}

/**
 * Draft-only preview for the affected root groups, including unassigned staff.
 * A null total means at least one employee's amount remains unentered.
 */
export function getMovePreview(
  departments: HrDepartment[],
  employees: HrEmployee[],
  code: string,
  target: string | null,
): HrMovePreview | null {
  try {
    validateAssignments(employees, departments);
    const employee = employees.find((item) => item.code === code);
    const byId = new Map(departments.map((department) => [department.id, department]));
    if (!employee || (target !== null && !byId.has(target))) return null;

    const roots = new Map<string, string>();
    for (const department of departments) {
      let root = department;
      while (root.parent_id !== null) root = byId.get(root.parent_id)!;
      roots.set(department.id, root.id);
    }
    const groupId = (id: string | null): string | null => id === null ? null : roots.get(id)!;
    const fromGroupId = groupId(employee.department_id);
    const toGroupId = groupId(target);
    const affectedIds = fromGroupId === toGroupId ? [fromGroupId] : [fromGroupId, toGroupId];
    const before = new Map(affectedIds.map((id) => [id, { count: 0, cents: 0, missing: 0 }]));
    const after = new Map(affectedIds.map((id) => [id, { count: 0, cents: 0, missing: 0 }]));

    for (const item of employees) {
      const originalGroup = groupId(item.department_id);
      const movedGroup = item.code === code ? toGroupId : originalGroup;
      const originalTotal = before.get(originalGroup);
      const movedTotal = after.get(movedGroup);
      if (originalTotal) addEmployee(originalTotal, item);
      if (movedTotal) addEmployee(movedTotal, item);
    }

    return {
      employeeCode: employee.code,
      fromId: employee.department_id,
      toId: target,
      fromGroupId,
      toGroupId,
      groups: affectedIds.map((id) => ({
        id,
        beforeCount: before.get(id)!.count,
        afterCount: after.get(id)!.count,
        beforeAmount: totalAmount(before.get(id)!),
        afterAmount: totalAmount(after.get(id)!),
      })),
      changes: employee.department_id !== target,
    };
  } catch {
    // Invalid drafts cannot produce a trustworthy movement preview.
    return null;
  }
}
