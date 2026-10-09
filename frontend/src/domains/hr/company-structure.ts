import { COMPANY_CLASSIFICATION, COMPANY_ORGANIZATION } from './company-catalog.ts';
export { COMPANY_CLASSIFICATION, COMPANY_ORGANIZATION };

export const HR_DEPARTMENT_ORDER = ['injection', 'quality', 'machining', 'sales', 'materials', 'mold-maintenance', 'administration', 'development'];

const clean = (value: string) => value.trim().replace(/\s+/g, '').replaceAll('／', '/').toLowerCase();
const GROUP_ALIASES: Record<string, string[]> = {
  quality: ['品质管理', '品质', '품질관리', '품질'], injection: ['注塑管理', '注塑', '사출관리', '사출'],
  machining: ['加工管理', '加工', '가공관리', '가공'], sales: ['营业管理', '营业', '영업관리', '영업'],
  materials: ['资材管理', '资材', '자재관리', '자재'], 'mold-maintenance': ['模具/公务', '금형/공무', '금형·공무'],
  administration: ['管理部门', '管理部', '관리부문', '관리부서'],
  development: ['开发管理', '开发', '开发部', '开发研究', '研发', '研发部', '개발', '개발부문', '개발부', '개발관리', '연구개발'],
};
const FUNCTION_ALIASES: Record<string, string[]> = {
  'quality-patrol': ['巡检', '순회검사'],
  'quality-oqc': ['oqc', 'iqc', 'iqc/oqc', 'iqc·oqc', '进出货检验', '进货检验', '来料检验', '出货检验', '入库检验', '出库检验', '입출고검사', '입고검사', '출고검사', '출하검사'],
  'quality-cs': ['cs'],
  'injection-operator': ['操作工', '작업자'], 'injection-mold-change': ['换模工', '금형교체'],
  'injection-5s': ['5s'], 'injection-feeding': ['加料/入库', '재료투입/입고'],
  'machining-operator': ['操作工', '작업자'], 'sales-warehouse': ['仓库/物流', '창고/물류'],
  'sales-cs': ['cs'], 'sales-support': ['辅助', '보조'], 'materials-raw': ['原材料', '원자재'],
  'materials-secondary': ['副资材', '부자재'], 'materials-crushing': ['粉碎', '분쇄'],
  'mold-worker': ['模具工', '금형작업자'], 'maintenance-worker': ['公务员工', '공무작업자'],
  'admin-finance': ['财务', '재무'], 'admin-hr': ['人事/总务', '人事/总務', '총무/인사', '인사/총무'],
  'development-staff': ['开发人员', '开发研究', '开发', '研发', '研发人员', '개발실무', '개발담당', '개발인원', '개발', '연구개발'],
};

export function getClassificationLabel(id: string | null | undefined): string {
  if (!id) return '미분류 / 未分类';
  const node = COMPANY_CLASSIFICATION.nodes.find((item) => item.id === id);
  if (!node) return id;
  const parent = COMPANY_CLASSIFICATION.nodes.find((item) => item.id === node.parent_id);
  return parent ? `${parent.name} / ${node.name}` : node.name;
}

/** Resolve explicit classification columns only; original 部门/title/name are never inputs. */
export function resolveClassification(value: { group?: string; function?: string; code?: string }): string | null {
  if (value.code?.trim()) {
    const id = value.code.trim();
    if (!COMPANY_CLASSIFICATION.nodes.some((node) => node.id === id)) throw new Error('시각화 박스 코드를 찾을 수 없습니다.');
    return id;
  }
  const group = clean(value.group ?? ''); const fn = clean(value.function ?? '');
  if (!group && !fn) return null;
  // Leadership cells also have explicit two-column values.
  if (['经营管理', '经营层', '경영', '경영진'].map(clean).includes(group)) {
    const roleAliases:Record<string,string> = {'董事长':'board-chairman','회장':'board-chairman','业务管理副总经理':'business-gm','业务管理总经理':'business-gm','사업총괄':'business-gm','生产技术副总经理':'technical-gm','生产技术总经理':'technical-gm','생산기술총괄':'technical-gm'};
    const role = Object.entries(roleAliases).find(([label])=>clean(label)===fn)?.[1];
    if (role) return role;
    const matches = COMPANY_CLASSIFICATION.leaders.filter((node) => [node.id, node.label].map(clean).includes(fn));
    if (matches.length === 1) return matches[0].id;
  }
  const groupMatches = COMPANY_CLASSIFICATION.groups.filter((node) => [node.id, node.label, ...(GROUP_ALIASES[node.id] ?? [])].map(clean).includes(group));
  if (groupMatches.length !== 1) throw new Error('시각화 부문과 기능을 모두 정확하게 입력해 주세요.');
  const selected = groupMatches[0];
  if (['관리', '관리자', '管理', '负责人', selected.label, selected.id].map(clean).includes(fn)) return selected.id;
  const matches = selected.children.filter((id) => [id, ...(FUNCTION_ALIASES[id] ?? [])].map(clean).includes(fn));
  if (matches.length !== 1) throw new Error('시각화 부문과 기능의 조합을 찾을 수 없습니다.');
  return matches[0];
}
