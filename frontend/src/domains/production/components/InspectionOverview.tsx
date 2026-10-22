import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProductionStatus } from '../api';
import { deriveInjectionQuality, reduceInjectionQuality, type InjectionQualityState } from '../injection-quality-status';
import { injectionQualityAttention } from '../injection-quality-attention';
import { InjectionQualityStatus } from './InjectionQualityStatus';

/** Optional quality read is independent of every production KPI query. */
export default function InspectionOverview({ date, language }: { date: string; language: 'ko' | 'zh' }) {
  const query = useQuery({ queryKey: ['inspection-overview', date], queryFn: () => getProductionStatus(date),
    retry: 1, refetchInterval: 60_000, staleTime: 30_000, refetchOnWindowFocus: false });
  const generations = useRef(new Map<number, InjectionQualityState>());
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const tx = (ko: string, zh: string) => language === 'ko' ? ko : zh;
  const machines = Array.from({ length: 17 }, (_, index) => {
    const number = index + 1;
    const matches = query.data?.injection.filter(row => row.machine_number === number) ?? [];
    const row = matches.length === 1 ? matches[0] : undefined;
    const input = row?.inspection_scope;
    const valid = input?.business_date === date && input.machine_number === number
      && input.current_plan_id !== null && row?.parts.filter(part => part.plan_id === input.current_plan_id).length === 1;
    const scope = { businessDate: date, machineNumber: number,
      currentPlanId: valid ? input.current_plan_id : null, planVersion: valid ? input.plan_version : '0'.repeat(64) };
    const state = reduceInjectionQuality(generations.current.get(number) ?? null, valid ? row?.inspection_status : null, scope);
    generations.current.set(number, state);
    const view = deriveInjectionQuality(state, scope, now, { transportError: query.isError });
    return { number, scope, state, attention: injectionQualityAttention(view) };
  });
  const known = machines.filter(row => row.attention.verified);
  const total = (key: 'failed' | 'overdue') => known.length ? String(known.filter(row => row.attention[key]).length) : '—';
  return <section className="analysis-panel inspection-overview" aria-label={tx('검사·불량조치 현황', '检验与不合格处置概览')}>
    <h2>{tx('검사·불량조치 현황', '检验与不合格处置概览')}</h2>
    <p>{query.isError ? tx('품질 조회 실패 · 생산 수치는 별도 유지됩니다.', '质量查询失败，生产数值独立保留。')
      : tx(`현재계획 연결·최신 상태 확인 ${known.length}/17호기`, `当前计划关联及最新状态已核对 ${known.length}/17 台`)}</p>
    <dl className="analysis-inspection-metrics">
      <div><dt>{tx('타임체크 지연 호기', '巡检逾期设备')}</dt><dd>{total('overdue')}</dd></div>
      <div><dt>{tx('불합격 관측 호기', '观测到不合格的设备')}</dt><dd>{total('failed')}</dd></div>
    </dl>
    <p>{tx('처분 승인·불량조치 지연은 미연동입니다. 검사 완료와 불량조치 종결은 별도입니다.', '处置审批及不合格处置逾期尚未关联。检验完成与处置关闭相互独立。')}</p>
    <details><summary>{tx('호기별 초품·타임체크 / 마지막 동기화', '各设备首检、巡检与最后同步')}</summary>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {machines.map(row => <div key={row.number}><strong>{row.number}{tx('호기', '号机')}</strong>
          <InjectionQualityStatus state={row.state} expectedScope={row.scope} language={language} transportError={query.isError} nowMs={now} />
        </div>)}
      </div>
    </details>
  </section>;
}
