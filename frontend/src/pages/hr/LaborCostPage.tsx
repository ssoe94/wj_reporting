import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLang } from '../../i18n';
import { flattenDepartments } from '../../domains/hr/layout';
import { hrFlowHref } from '../../domains/hr/flow';
import { hrDepartmentLabel, hrGroupLabel } from '../../domains/hr/labels';
import { getDepartmentCostBreakdowns } from '../../domains/hr/visualization';
import type { HrDepartment, HrEmployee, HrWorkspace } from '../../domains/hr/types';
import HrCostRibbon from './HrCostRibbon';
import CompanyOrganizationChart from './CompanyOrganizationChart';
import { HrSource, layoutSummary, money } from './hrCommon';

function shareOfTotal(part: number | null, total: number | null) {
  if (part === null || total === null || total <= 0) return null;
  const denominator = BigInt(total);
  const hundredths = (BigInt(part) * 20000n + denominator) / (denominator * 2n);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

export default function LaborCostPage({ workspace, departments, employees, dirty }: {
  workspace: HrWorkspace;
  departments: HrDepartment[];
  employees: HrEmployee[];
  dirty: boolean;
}) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  const metrics = useMemo(() => layoutSummary(departments, employees), [departments, employees]);
  const totals = useMemo(() => new Map(departments.map(department => {
    const total = metrics.totals.get(department.id)!;
    return [department.id, {
      direct_count: total.directCount, direct_total: total.direct, total: total.total,
      share: shareOfTotal(total.total, metrics.total),
    }];
  })), [departments, metrics]);
  const flattened = useMemo(() => flattenDepartments(departments), [departments]);
  const groups = workspace.company_structure.classification.groups;
  const roleTotals = useMemo(() => getDepartmentCostBreakdowns(
    departments, employees, groups.map(group => group.id),
  ), [departments, employees, groups]);

  return <section aria-label={ko ? '인건비 집계' : '人工成本汇总'}>
    {dirty && <p className="hr-draft-indicator" role="status">
      {ko ? '저장 전 배치 변경이 있습니다. 합계와 집계표는 현재 초안 기준입니다.' : '配置更改尚未保存，合计和汇总表按当前草稿计算。'}
    </p>}
    {!workspace.source && <div className="hr-empty-intake">
      {ko ? '이 월에 가져온 급여표가 없습니다.' : '本月尚未导入工资表。'}{' '}
      <Link to={hrFlowHref('personnel', 'upload', workspace.month)}>{ko ? '자료 올리기' : '上传资料'}</Link>
    </div>}
    <HrCostRibbon departments={departments} employees={employees} currency={workspace.currency}
      basis={workspace.cost_basis === 'gross_salary' ? (ko ? '세전 급여' : '应发工资')
        : workspace.cost_basis === 'employer_total' ? (ko ? '회사 부담 총액' : '公司承担总额') : workspace.cost_basis_label}
      hasSource={Boolean(workspace.source)} />
    <HrSource workspace={workspace} />
      <div className="hr-secondary-views">
        <details className="hr-disclosure"><summary>{ko ? '관리자·작업 인건비 집계표' : '管理人员·作业成本汇总表'}</summary><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '부서' : '部门'}</th><th className="hr-number">{ko ? '관리자 인원' : '管理人数'}</th><th className="hr-number">{ko ? '관리자 인건비' : '管理成本'}</th><th className="hr-number">{ko ? '작업·실무 인원' : '作业·实务人数'}</th><th className="hr-number">{ko ? '작업·실무 인건비' : '作业·实务成本'}</th><th className="hr-number">{ko ? '부서 합계' : '部门合计'}</th></tr></thead><tbody>{workspace.company_structure.classification.groups.map((group) => {
          const split = roleTotals.get(group.id); const name = hrGroupLabel(group.id, departments.find((department) => department.id === group.id)?.name, lang);
          const cost = (value: string | null | undefined) => value === undefined ? '—' : value === null ? (ko ? '미확정' : '待确认') : money(value, workspace.currency, lang);
          return <tr key={group.id}><td>{name}</td><td className="hr-number">{split?.management.count ?? 0}</td><td className="hr-number">{cost(split?.management.amount)}</td><td className="hr-number">{split?.operations.count ?? 0}</td><td className="hr-number">{cost(split?.operations.amount)}</td><td className="hr-number">{cost(split?.total.amount)}</td></tr>;
        })}</tbody></table></div></details>
        <details className="hr-disclosure"><summary>{ko ? '전체 조직도' : '完整组织图'}</summary><CompanyOrganizationChart organization={workspace.company_structure.organization} /></details>
        <details className="hr-disclosure"><summary>{ko ? '상세 집계표' : '详细汇总表'}</summary><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '부문·기능' : '部门·职能'}</th><th className="hr-number">{ko ? '직접 인원' : '直接人数'}</th><th className="hr-number">{ko ? '직접 비용' : '直接成本'}</th><th className="hr-number">{ko ? '하위 포함 비용' : '含下级成本'}</th><th className="hr-number">{ko ? '비중' : '占比'}</th></tr></thead><tbody>{flattened.map(({department,depth}) => {
          const total = totals.get(department.id);
          return <tr key={department.id}><td style={{paddingInlineStart: `${12 + depth * 12}px`}}><span>{roleTotals.has(department.id) ? hrGroupLabel(department.id, department.name, lang) : hrDepartmentLabel(department.id, department.name, lang)}</span></td><td className="hr-number">{total?.direct_count ?? 0}</td><td className="hr-number">{money(total?.direct_total ?? null,workspace.currency,lang)}</td><td className="hr-number">{money(total?.total ?? null,workspace.currency,lang)}</td><td className="hr-number">{total?.share == null ? '—' : `${total.share}%`}</td></tr>;
        })}</tbody></table></div></details>
      </div>
  </section>;
}
