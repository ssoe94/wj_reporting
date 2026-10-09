import { useMemo } from 'react';
import { useLang } from '../../i18n';
import type { HrCurrency, HrDepartment, HrEmployee } from '../../domains/hr/types';
import { hrGroupLabel } from '../../domains/hr/labels';
import { compactMoney, layoutSummary } from './hrCommon';
import './hr-cost-ribbon.css';

const ORDER = ['injection', 'quality', 'machining', 'sales', 'materials', 'mold-maintenance', 'administration'];
const COLORS = ['#284c70', '#3c648c', '#4d78a0', '#6288aa', '#7b9ab7', '#94aec5', '#b1c4d5'];

/** Root totals partition employees once; no parent/child double counting. */
export default function HrCostRibbon({ departments, employees, currency, basis, hasSource }: {
  departments: HrDepartment[]; employees: HrEmployee[]; currency: HrCurrency; basis: string; hasSource: boolean;
}) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const summary = useMemo(() => layoutSummary(departments, employees), [departments, employees]);
  const roots = departments.filter((item) => item.parent_id === null).sort((a, b) => {
    const ai = ORDER.indexOf(a.id); const bi = ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const parts = roots.map((item, index) => ({ id: item.id, name: hrGroupLabel(item.id, item.name, lang), cents: summary.totals.get(item.id)?.total ?? null,
    count: summary.totals.get(item.id)?.headcount ?? 0, color: COLORS[index % COLORS.length] }));
  if (summary.unassignedCount) parts.push({ id: '__unassigned', name: ko ? '미배치' : '待配置', cents: summary.unassigned, count: summary.unassignedCount, color: '#697584' });
  const visible = parts.filter((item) => item.count > 0);
  const canShowShares = hasSource && summary.total !== null && summary.total > 0;
  return <section className="hr-cost-ribbon" aria-label={ko ? '전체 인원과 인건비 비중' : '总人数及人工成本占比'}>
    <div className="hr-ribbon-count"><span>{ko ? '전체 인원' : '总人数'}</span><strong>{employees.length}<small>{ko ? '명' : '人'}</small></strong>
      {summary.unassignedCount > 0 && <small>{ko ? '미배치' : '待配置'} {summary.unassignedCount}{ko ? '명' : '人'}</small>}</div>
    <div className="hr-ribbon-total"><span>{ko ? '월 인건비' : '月人工成本'} <small>{basis} · {currency}</small></span><strong>{!hasSource ? '—' : summary.total === null ? (ko ? '미확정' : '待确认') : compactMoney(summary.total, currency, lang)}</strong>
      {summary.missingCostCount > 0 && <small>{ko ? `금액 미입력 ${summary.missingCostCount}명 · 입력분 ` : `${summary.missingCostCount} 人未填金额 · 已填写 `}{compactMoney(summary.knownTotal, currency, lang)}</small>}</div>
    <div className="hr-ribbon-chart">
      {canShowShares ? <>
        <div className="hr-cost-distribution" role="img" aria-label={visible.map((item) => `${item.name}: ${compactMoney(item.cents, currency, lang)}, ${((item.cents ?? 0) / summary.total! * 100).toFixed(1)}%`).join('; ')}>
          {visible.filter((item) => (item.cents ?? 0) > 0).map((item) => {
            const share = (item.cents ?? 0) / summary.total! * 100;
            return <span key={item.id} data-compact-label={share < 15 ? 'hide' : undefined} style={{ width: `${share}%`, background: item.color, color: COLORS.indexOf(item.color) >= 3 ? '#071a2a' : '#fff' }} title={`${item.name} · ${compactMoney(item.cents, currency, lang)} · ${share.toFixed(1)}%`} aria-hidden="true">{share >= 5 ? `${share.toFixed(1)}%` : ''}</span>;
          })}
        </div>
        <div className="hr-cost-legend">{visible.map((item) => <span key={item.id}><i style={{ background: item.color }} aria-hidden="true" />{item.name}</span>)}</div>
      </> : <p className="hr-ribbon-empty">{!hasSource ? (ko ? '급여표를 올리면 부문별 비중을 확인할 수 있습니다.' : '上传工资表后可查看各部门占比。') : summary.total === null ? (ko ? '금액 입력 완료 후 부문별 비중을 표시합니다.' : '金额填写完整后显示各部门占比。') : (ko ? '집계 금액이 0이므로 비용 비중이 없습니다.' : '汇总金额为 0，无成本占比。')}</p>}
    </div>
  </section>;
}
