import type { ClosedWeekMetric, ClosedWeekSummary } from '@/domains/boards/overview/types';
import { formatQuantity as q, type Translate } from './presentation';

export function ClosedPeriodSummary({ data, pending, failed, tx, lang }: {
  data?: ClosedWeekSummary; pending: boolean; failed: boolean; tx: Translate; lang: string;
}) {
  const metric = (v: ClosedWeekMetric) => {
    if (v.status === 'unavailable' || v.status === 'pending') return tx('자료 없음', '无资料');
    if (v.status === 'no_plan') return tx('계획 없음', '无计划');
    return `${q(v.actualQuantity, lang)} / ${q(v.plannedQuantity, lang)} ea · ${q(v.completionRate, lang, 1)}%${v.status === 'partial' ? tx(' · 부분 집계', ' · 部分汇总') : ''}`;
  };
  return <section className="analysis-panel analysis-closed" aria-labelledby="analysis-closed-title">
    <h2 id="analysis-closed-title">{tx('마감 실적 비교', '已结业务日比较')}</h2>
    {failed || !data ? <p className="analysis-caption" role="status">{pending ? tx('마감 자료 확인 중', '正在获取已结资料') : tx('마감 자료 조회 실패', '已结资料获取失败')}</p>
      : <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('기간', '期间')}</th><th>{tx('사출 · 실적 / 계획 · 달성', '注塑 · 实绩 / 计划 · 达成')}</th><th>{tx('조립 · 실적 / 계획 · 달성', '组装 · 实绩 / 计划 · 达成')}</th></tr></thead><tbody>
        <tr><th scope="row">{tx('전일', '前一日')} <small>{data.previousDay.businessDate}</small></th><td>{metric(data.previousDay.injection)}</td><td>{metric(data.previousDay.assembly)}</td></tr>
        <tr><th scope="row">{tx('선택 주 마감 누계', '所选周已结累计')} <small>{data.week.startDate} → {data.week.endDate ?? '—'}</small></th><td>{metric(data.week.injection)}</td><td>{metric(data.week.assembly)}</td></tr>
      </tbody></table><p className="analysis-caption">{tx(`마감 ${data.week.closedDayCount}일 · 자료 미확인 ${data.week.unavailableDays}일 · 진행 중 업무일 제외`, `已结${data.week.closedDayCount}天 · 资料未确认${data.week.unavailableDays}天 · 不含进行中的业务日`)}</p></div>}
  </section>;
}
