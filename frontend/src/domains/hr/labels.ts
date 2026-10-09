import { COMPANY_CLASSIFICATION, COMPANY_ORGANIZATION } from './company-catalog.ts';

// Initial Korean wording. Keep translations separate from source names and stable IDs.
export const HR_CLASSIFICATION_KO: Record<string, string> = {
  'board-chairman': '회장',
  'business-gm': '사업 총괄',
  'technical-gm': '생산기술 총괄',
  quality: '품질관리',
  'quality-patrol': '순회검사',
  'quality-oqc': '출하검사',
  'quality-cs': '고객대응',
  injection: '사출관리',
  'injection-operator': '작업자',
  'injection-mold-change': '금형교체',
  'injection-5s': '5S 관리',
  'injection-feeding': '재료투입·입고',
  machining: '가공관리',
  'machining-operator': '작업자',
  sales: '영업관리',
  'sales-warehouse': '창고·물류',
  'sales-cs': '고객대응',
  'sales-support': '업무지원',
  materials: '자재관리',
  'materials-raw': '원자재',
  'materials-secondary': '부자재',
  'materials-crushing': '분쇄',
  'mold-maintenance': '금형·공무',
  'mold-worker': '금형작업자',
  'maintenance-worker': '공무작업자',
  administration: '관리부문',
  'admin-finance': '재무',
  'admin-hr': '인사·총무',
};

const ORGANIZATION_KO: Record<string, string> = {
  chairman: '회장', qa: '품질보증팀', business: '사업관리\n부총경리', technical: '생산기술\n부총경리',
  esh: '환경·안전·보건', office: '관리실장', 'sales-operations': '영업운영부장', development: '연구개발',
  production: '생산부장', hr: '총무·인사', finance: '재무', 'production-management': '생산관리',
  purchasing: '구매', injection: '사출', machining: '가공', mold: '금형', maintenance: '공무',
};

export function hrDepartmentLabel(id: string, sourceName: string | undefined, lang: string): string {
  const canonical = COMPANY_CLASSIFICATION.nodes.find((node) => node.id === id);
  const leader = COMPANY_CLASSIFICATION.leaders.find((node) => node.id === id);
  // Management labels remain generic so imported private identities cannot leak.
  const name = leader?.label ?? sourceName ?? canonical?.name ?? id;
  // A user's later rename takes precedence over the initial translation.
  return lang === 'ko' && name === canonical?.name ? HR_CLASSIFICATION_KO[id] ?? name : name;
}

export function hrOrganizationLabel(id: string, sourceLabel: string, lang: string): string {
  const canonical = COMPANY_ORGANIZATION.nodes.find((node) => node.id === id);
  return lang === 'ko' && sourceLabel === canonical?.label ? ORGANIZATION_KO[id] ?? sourceLabel : sourceLabel;
}
