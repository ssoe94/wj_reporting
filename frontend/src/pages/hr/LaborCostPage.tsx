import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLang } from '../../i18n';
import { flattenDepartments } from '../../domains/hr/layout';
import type { HrDepartment, HrEmployee } from '../../domains/hr/types';
import CompanyClassificationChart from './CompanyClassificationChart';
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
  function changeMonth(next: string) { setMonth(next); }

  return <HrShell page="labor-cost" month={month} onMonthChange={changeMonth}>
    {!allowed || loading || error || !workspace || !summary ? <HrLoadState loading={loading} error={error} allowed={allowed} retry={refresh} /> : <>
      <HrSource workspace={workspace} />
      {!workspace.source && <div className="hr-empty-intake">{ko ? '이 월에 가져온 급여표가 없습니다.' : '本月尚未导入工资表。'} <Link to={`/hr/personnel?month=${month}`}>{ko ? '자료 올리기' : '上传资料'}</Link></div>}
      <section className="hr-summary-strip" aria-label={ko ? '월별 인원과 인건비' : '月度人员与人工成本'}>
        <div><span>{ko ? '월 인건비' : '月人工成本'} <small>{workspace.currency} · {workspace.cost_basis === 'gross_salary' ? '应发工资' : workspace.cost_basis === 'custom' ? workspace.cost_basis_label : (ko ? '회사 총부담' : '公司总负担')}</small></span><strong>{!workspace.source ? '—' : summary.total === null ? (ko ? '미확정' : '待确认') : money(summary.total, workspace.currency, lang)}</strong>
          {summary.total === null && <small>{ko ? '입력분' : '已填写'} {money(summary.known_total, workspace.currency, lang)}</small>}</div>
        <div><span>{ko ? '전체 인원' : '总人数'}</span><strong>{summary.employee_count}<small>{ko ? '명' : '人'}</small></strong><small>{summary.assigned_count} {ko ? '명 배치' : '人已配置'}</small></div>
        <Link className={summary.unassigned_count ? 'is-attention' : ''} to={`/hr/personnel?month=${month}`}><span>{ko ? '미분류' : '未分类'}</span><strong>{summary.unassigned_count}<small>{ko ? '명' : '人'}</small></strong><small>{summary.unassigned_total === null ? (ko ? '금액 미입력 포함' : '含未填写金额') : money(summary.unassigned_total, workspace.currency, lang)}</small></Link>
        <div className={summary.missing_cost_count ? 'is-attention' : ''}><span>{ko ? '금액 미입력' : '金额未填写'}</span><strong>{summary.missing_cost_count}<small>{ko ? '명' : '人'}</small></strong><small>{summary.cost_complete ? (ko ? '금액 확인 완료' : '金额完整') : (ko ? '총계·비중 미확정' : '总计·占比待确认')}</small></div>
      </section>
      <CompanyClassificationChart departments={departments} employees={employees} summary={summary} currency={workspace.currency} catalog={workspace.company_structure.classification} />
      <div className="hr-secondary-views">
        <details className="hr-disclosure"><summary>{ko ? '전체 조직도' : '完整组织图'}</summary><CompanyOrganizationChart organization={workspace.company_structure.organization} /></details>
        <details className="hr-disclosure"><summary>{ko ? '상세 집계표' : '详细汇总表'}</summary><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '부문·기능' : '部门·职能'}</th><th className="hr-number">{ko ? '직접 인원' : '直接人数'}</th><th className="hr-number">{ko ? '직접 비용' : '直接成本'}</th><th className="hr-number">{ko ? '하위 포함 비용' : '含下级成本'}</th><th className="hr-number">{ko ? '비중' : '占比'}</th></tr></thead><tbody>{flattened.map(({department,depth}) => {
          const total = totals.get(department.id);
          return <tr key={department.id}><td style={{paddingInlineStart: `${12 + depth * 12}px`}}><span>{department.name}</span></td><td className="hr-number">{total?.direct_count ?? 0}</td><td className="hr-number">{money(total?.direct_total ?? null,workspace.currency,lang)}</td><td className="hr-number">{money(total?.total ?? null,workspace.currency,lang)}</td><td className="hr-number">{total?.share == null ? '—' : `${total.share}%`}</td></tr>;
        })}</tbody></table></div></details>
      </div>
    </>}
  </HrShell>;
}
