import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLang } from '../../i18n';
import { flattenDepartments } from '../../domains/hr/layout';
import { hrDepartmentLabel, hrGroupLabel } from '../../domains/hr/labels';
import { getDepartmentCostBreakdowns } from '../../domains/hr/visualization';
import type { HrDepartment, HrEmployee } from '../../domains/hr/types';
import HrAllocationBoard from './HrAllocationBoard';
import HrCostRibbon from './HrCostRibbon';
import CompanyOrganizationChart from './CompanyOrganizationChart';
import { HrLoadState, HrShell, HrSource, currentHrMonth, money, useHrWorkspace } from './hrCommon';

const EMPTY_DEPARTMENTS: HrDepartment[] = [];
const EMPTY_EMPLOYEES: HrEmployee[] = [];

export default function LaborCostPage() {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [month, setMonth] = useState(currentHrMonth);
  const { workspace, loading, error, allowed, refresh } = useHrWorkspace(month);
  const departments = workspace?.departments ?? EMPTY_DEPARTMENTS;
  const employees = workspace?.employees ?? EMPTY_EMPLOYEES;
  const summary = workspace?.summary;
  const flattened = useMemo(() => flattenDepartments(departments), [departments]);
  const totals = useMemo(() => new Map(summary?.departments.map((entry) => [entry.id, entry]) ?? []), [summary]);
  const roleTotals = useMemo(() => getDepartmentCostBreakdowns(departments, employees, workspace?.company_structure.classification.groups.map((group) => group.id) ?? []), [departments, employees, workspace]);
  function changeMonth(next: string) { setMonth(next); }

  return <HrShell page="labor-cost" month={month} onMonthChange={changeMonth}>
    {!allowed || loading || error || !workspace || !summary ? <HrLoadState loading={loading} error={error} allowed={allowed} retry={refresh} /> : <>
      {!workspace.source && <div className="hr-empty-intake">{ko ? '이 월에 가져온 급여표가 없습니다.' : '本月尚未导入工资表。'} <Link to={`/hr/personnel?month=${month}`}>{ko ? '자료 올리기' : '上传资料'}</Link></div>}
      <HrCostRibbon departments={departments} employees={employees} currency={workspace.currency} basis={workspace.cost_basis === 'gross_salary' ? (ko ? '세전 급여' : '应发工资') : workspace.cost_basis === 'employer_total' ? (ko ? '회사 부담 총액' : '公司承担总额') : workspace.cost_basis_label} hasSource={Boolean(workspace.source)} />
      <HrAllocationBoard key={month} departments={departments} employees={employees} summary={summary} currency={workspace.currency} catalog={workspace.company_structure.classification} />
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
    </>}
  </HrShell>;
}
