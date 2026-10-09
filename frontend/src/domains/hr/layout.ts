import type { HrAssignment, HrDepartment, HrEmployee } from "./types.ts";

export const MAX_DEPARTMENTS = 200;
export const MAX_DEPARTMENT_DEPTH = 8;
export type HrDepartmentNode = { department: HrDepartment; children: HrDepartmentNode[] };

export function validateDepartments(departments: HrDepartment[]): void {
  if (departments.length > MAX_DEPARTMENTS) throw new Error(`부서는 ${MAX_DEPARTMENTS}개까지 만들 수 있습니다.`);
  const ids = new Set<string>();
  for (const department of departments) {
    if (!department.id || ids.has(department.id)) throw new Error("부서 ID는 비어 있거나 중복될 수 없습니다.");
    if (!department.name.trim()) throw new Error("부서명을 입력해 주세요.");
    if (department.id.length > 64 || department.name.length > 100 || department.function.length > 500) {
      throw new Error("부서 ID는 64자, 부서명은 100자, 기능은 500자까지 입력해 주세요.");
    }
    ids.add(department.id);
  }
  const byId = new Map(departments.map((department) => [department.id, department]));
  for (const department of departments) {
    const visited = new Set([department.id]);
    let parentId = department.parent_id;
    while (parentId !== null) {
      if (!ids.has(parentId)) throw new Error("상위 부서를 찾을 수 없습니다.");
      if (visited.has(parentId)) throw new Error("부서 계층을 순환하도록 배치할 수 없습니다.");
      visited.add(parentId);
      if (visited.size > MAX_DEPARTMENT_DEPTH) throw new Error(`부서 계층은 ${MAX_DEPARTMENT_DEPTH}단계까지 만들 수 있습니다.`);
      parentId = byId.get(parentId)!.parent_id;
    }
  }
}

export function getDepartmentTree(departments: HrDepartment[]): HrDepartmentNode[] {
  validateDepartments(departments);
  const nodes = new Map(departments.map((department) => [department.id, { department, children: [] } as HrDepartmentNode]));
  const roots: HrDepartmentNode[] = [];
  // Input order is persisted and stable across rendering and saves.
  for (const department of departments) {
    const node = nodes.get(department.id)!;
    if (department.parent_id === null) roots.push(node);
    else nodes.get(department.parent_id)!.children.push(node);
  }
  return roots;
}

export function flattenDepartments(departments: HrDepartment[]): { department: HrDepartment; depth: number }[] {
  const result: { department: HrDepartment; depth: number }[] = [];
  const append = (nodes: HrDepartmentNode[], depth: number) => {
    for (const node of nodes) {
      result.push({ department: node.department, depth });
      append(node.children, depth + 1);
    }
  };
  append(getDepartmentTree(departments), 0);
  return result;
}

export function getDescendantIds(departments: HrDepartment[], id: string): Set<string> {
  const roots = getDepartmentTree(departments);
  const result = new Set<string>();
  const find = (nodes: HrDepartmentNode[]): HrDepartmentNode | undefined => {
    for (const node of nodes) {
      if (node.department.id === id) return node;
      const child = find(node.children);
      if (child) return child;
    }
    return undefined;
  };
  const parent = find(roots);
  if (!parent) throw new Error("부서를 찾을 수 없습니다.");
  const append = (nodes: HrDepartmentNode[]) => {
    for (const node of nodes) {
      result.add(node.department.id);
      append(node.children);
    }
  };
  append(parent.children);
  return result;
}

export function moveDepartment(departments: HrDepartment[], id: string, parentId: string | null): HrDepartment[] {
  validateDepartments(departments);
  if (!departments.some((department) => department.id === id)) throw new Error("부서를 찾을 수 없습니다.");
  const updated = departments.map((department) => department.id === id ? { ...department, parent_id: parentId } : department);
  validateDepartments(updated);
  return updated;
}

export function validateAssignments(employees: HrEmployee[], departments: HrDepartment[]): void {
  validateDepartments(departments);
  const departmentIds = new Set(departments.map((department) => department.id));
  const codes = new Set<string>();
  for (const employee of employees) {
    if (!employee.code || codes.has(employee.code)) throw new Error("직원 사번은 비어 있거나 중복될 수 없습니다.");
    if (employee.department_id !== null && !departmentIds.has(employee.department_id)) {
      throw new Error("직원에게 배치된 부서를 찾을 수 없습니다.");
    }
    codes.add(employee.code);
  }
}

export function moveEmployee(
  employees: HrEmployee[],
  code: string,
  departmentId: string | null,
  departments: HrDepartment[],
): HrEmployee[] {
  validateAssignments(employees, departments);
  if (!employees.some((employee) => employee.code === code)) throw new Error("직원을 찾을 수 없습니다.");
  const updated = employees.map((employee) => employee.code === code ? { ...employee, department_id: departmentId } : employee);
  validateAssignments(updated, departments);
  return updated;
}

export function buildAssignments(employees: HrEmployee[]): HrAssignment[] {
  const seen = new Set<string>();
  return employees.map(({ code, department_id }) => {
    if (!code || seen.has(code)) throw new Error("직원 사번은 비어 있거나 중복될 수 없습니다.");
    seen.add(code);
    return { code, department_id };
  });
}
