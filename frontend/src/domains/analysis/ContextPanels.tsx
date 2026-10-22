import type { ReactNode } from 'react';
import type { OverviewBoardModel } from '@/domains/boards/overview/types';
import PermissionLink from '@/components/common/PermissionLink';
import { getContextEvidence } from './model';
import { formatQuantity as q, formatTime as time, type Translate } from './presentation';

type Props = { model: OverviewBoardModel; refreshFailed: boolean; tx: Translate; lang: string };
function Stat({ label, value, unit = '' }: { label: string; value: string; unit?: string }) {
  return <div><dt>{label}</dt><dd>{value}<small>{unit}</small></dd></div>;
}
function Panel({ id, title, note, children, link }: { id: string; title: string; note: string; children: ReactNode; link?: ReactNode }) {
  return <section className="analysis-panel analysis-context-panel" aria-labelledby={id}>
    <div className="analysis-section-heading"><h2 id={id}>{title}</h2>{link}</div>
    <p className="analysis-caption analysis-scope">{note}</p>{children}
  </section>;
}
export function ContextPanels({ model: m, refreshFailed, tx, lang }: Props) {
  const energy = getContextEvidence(m, 'energy', refreshFailed);
  const mould = getContextEvidence(m, 'moulds', refreshFailed);
  const quality = getContextEvidence(m, 'quality_history', refreshFailed);
  const inventoryAvailable = Boolean(m.inventory.snapshotDate) && !m.warnings.includes('inventory_snapshot_missing') && !m.warnings.includes('inventory_snapshot_unavailable');
  const out = m.inventory.outboundPerformance;
  const outAvailable = out.status !== 'unavailable';
  const sourceNote = (key: string) => {
    const e = getContextEvidence(m, key, refreshFailed);
    return !e.available ? tx('자료 없음', '无资料') : `${e.current ? tx('최근 자료', '最近资料') : tx('부분·지연·이전 자료', '部分、延迟或此前资料')} · ${time(e.source?.sourceLatestAt, lang)} UTC+8`;
  };
  const energyValue = (v: number | null) => q(energy.available ? v : null, lang, 1);
  const mouldValue = (v: number | null) => q(mould.available ? v : null, lang);
  const hours = m.energy.hourlyTrend;
  const maxHour = Math.max(1, ...hours.map(p => p.usageKwh ?? 0));
  const service = m.moulds.serviceTrend;
  const hasService = mould.available && ['ok', 'partial', 'stale'].includes(service.status);
  const currentOut = out.periods.today;
  return <>
    <div className="analysis-context-grid">
      <Panel id="analysis-energy" title={tx('전력과 설비 사용', '电力与设备用电')} note={`${tx('선택 업무일 누계', '所选业务日累计')} · ${sourceNote('energy')}`}>
        <dl className="analysis-stat-row"><Stat label={tx('사용 전력', '用电量')} value={energyValue(m.energy.usageValue)} unit=" kWh" /><Stat label={tx('1,000샷당 전력', '每千模用电')} value={energyValue(m.energy.energyPer1000ShotsKwh)} unit=" kWh" /><Stat label={tx('전력 수집 설비', '电表采集设备')} value={energyValue(m.energy.meteredMachineCount)} unit={tx('대', '台')} /></dl>
        {energy.available && hours.some(p => p.usageKwh !== null) ? <figure className="analysis-hourly"><figcaption>{tx('최근 24시간 전력 · 완료된 시간 구간', '近24小时用电 · 完整小时区间')} <small>0–{q(maxHour, lang, 1)} kWh</small></figcaption>
          <div className="analysis-hour-bars">{hours.map((p, i) => <div key={`${p.timestamp}-${i}`} className={p.isCurrentBusinessDay ? 'is-current' : ''} title={`${time(p.timestamp, lang)} · ${q(p.usageKwh, lang, 1)} kWh · ${q(p.coverageMachineCount, lang)}${tx('대', '台')}`}>
            <span className={p.usageKwh === null ? 'is-missing' : ''} style={{ height: p.usageKwh === null ? 2 : `${Math.max(0, p.usageKwh / maxHour * 100)}%` }} /><small>{i % 4 === 0 || i === hours.length - 1 ? p.label : ''}</small>
          </div>)}</div>
          <details className="analysis-disclosure"><summary>{tx('시간별 수치·수집 범위', '每小时数值及采集范围')}</summary><div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('시각 UTC+8', '时间 UTC+8')}</th><th className="is-number">kWh</th><th className="is-number">{tx('수집 설비', '采集设备')}</th></tr></thead><tbody>{hours.map((p, i) => <tr key={i}><th scope="row">{time(p.timestamp, lang)}</th><td className="is-number">{q(p.usageKwh, lang, 1)}</td><td className="is-number">{q(p.coverageMachineCount, lang)}</td></tr>)}</tbody></table></div></details>
        </figure> : <p className="analysis-caption">{tx('시간별 전력 자료 없음', '无每小时用电资料')}</p>}
        {energy.available && m.energy.usageByMachine.length > 0 && <details className="analysis-disclosure"><summary>{tx('설비별 전력 사용량', '各设备用电量')}</summary><div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('설비', '设备')}</th><th className="is-number">kWh</th></tr></thead><tbody>{m.energy.usageByMachine.map((r, i) => <tr key={i}><th scope="row">{r.label}</th><td className="is-number">{q(r.value, lang, 1)}</td></tr>)}</tbody></table></div></details>}
        <p className="analysis-caption">{tx('효율 산출 설비', '能效计算设备')}: {q(energy.available ? m.energy.efficiencyMeteredMachineCount : null, lang)}{tx('대', '台')}</p>
        <p className="analysis-caption">{tx('누적 전력계 증가분 기준. 천 샷당 전력은 전력·샷 계수가 모두 있는 설비만 포함합니다. 흐린 막대는 전 업무일, 점선은 자료 없음입니다.', '按累计电表增量汇总。每千模用电仅含电力及模次计数均可用的设备。浅色柱为前一业务日，虚线表示无资料。')}</p>
      </Panel>
      <Panel id="analysis-inventory" title={tx('재고와 창고', '库存与仓库')} note={`${tx('재고 스냅샷 기준일', '库存快照日期')} · ${m.inventory.snapshotDate ?? '—'}${m.inventory.snapshotDate && m.inventory.snapshotDate !== m.businessDate ? tx(' · 선택일과 다름', ' · 与所选日期不同') : ''}`} link={<PermissionLink className="analysis-link" to="/sales/inventory-status">{tx('상세', '明细')}</PermissionLink>}>
        <dl className="analysis-stat-row"><Stat label={tx('완제품·반제품', '成品及半成品')} value={q(inventoryAvailable ? m.inventory.finishedAndSemifinishedQuantity : null, lang)} unit=" ea" /><Stat label={tx('재고 품목 행', '库存品目行')} value={q(inventoryAvailable ? m.inventory.skuCount : null, lang)} /><Stat label={tx('대차', '台车')} value={q(inventoryAvailable ? m.inventory.totalCarts : null, lang)} /></dl>
        {inventoryAvailable ? <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('창고', '仓库')}</th><th className="is-number">{tx('품목 행', '品目行')}</th><th className="is-number">{tx('수량 ea', '数量 ea')}</th><th className="is-number">{tx('대차', '台车')}</th></tr></thead><tbody>{m.inventory.warehouses.map(w => <tr key={w.label}><th scope="row">{w.label}</th><td className="is-number">{q(w.skuCount, lang)}</td><td className="is-number">{q(w.quantity, lang)}</td><td className="is-number">{q(w.carts, lang)}</td></tr>)}</tbody></table></div> : <p className="analysis-caption">{tx('재고 스냅샷 없음 · 재고 0을 뜻하지 않습니다.', '无库存快照，不代表库存为0。')}</p>}
        <p className="analysis-caption">{tx('완제품 입출고 스냅샷', '成品出入库快照')}: {time(m.inventory.shippingSnapshotAt, lang)} UTC+8 · {tx('입고 / 출고', '入库 / 出库')} {q(m.inventory.shippingSnapshotAt ? m.inventory.shippingInbound : null, lang)} / {q(m.inventory.shippingSnapshotAt ? m.inventory.shippingOutbound : null, lang)} ea</p>
      </Panel>
      <Panel id="analysis-outbound" title={tx('JIT · CSKD 출고 이행', 'JIT · CSKD 出库履行')} note={`${m.businessDate} · ${tx('선택일 출고 계획 집단', '所选日期出库计划群组')} · ${time(currentOut.startAt, lang)} → ${time(currentOut.endAt, lang)} UTC+8 · ${tx('조회', '获取')} ${time(out.fetchedAt, lang)}${out.status !== 'ok' || refreshFailed ? tx(' · 부분·이전 자료', ' · 部分或此前资料') : ''}`}>
        <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('구분 / 기간', '分类 / 期间')}</th><th className="is-number">{tx('목표', '目标')}</th><th className="is-number">{tx('이행', '履行')}</th><th className="is-number">%</th></tr></thead><tbody>{(['today', 'previousWeek', 'previousMonth'] as const).flatMap(period => (['jit', 'cskd'] as const).map(category => {
          const v = out.periods[period][category];
          return <tr key={`${period}-${category}`}><th scope="row">{category.toUpperCase()} <small>{({ today: tx('선택일', '所选日期'), previousWeek: tx('선택일 기준 전주', '所选日期的上周'), previousMonth: tx('선택일 기준 전월', '所选日期的上月') })[period]}</small></th><td className="is-number">{q(outAvailable ? v.targetQuantity : null, lang)} {v.unit}</td><td className="is-number">{q(outAvailable ? v.fulfilledQuantity : null, lang)} {v.unit}</td><td className="is-number">{q(outAvailable ? v.completionRate : null, lang, 1)}</td></tr>;
        }))}</tbody></table></div>
        {outAvailable && out.todayPriorityItems.length > 0 && <details className="analysis-disclosure"><summary>{tx(`선택일 우선 확인 ${out.todayPriorityItems.length}행`, `所选日期优先核对${out.todayPriorityItems.length}行`)}</summary><div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('출고 / 품번', '出库单 / 品号')}</th><th className="is-number">{tx('미이행', '未履行')}</th><th>{tx('상태', '状态')}</th></tr></thead><tbody>{out.todayPriorityItems.map((r, i) => <tr key={`${r.outboundOrderId}-${r.materialId}-${i}`}><th scope="row">{r.outboundOrderCode}<small>{r.materialCode}</small></th><td className="is-number">{q(r.remainingQuantity, lang)} {r.unit}</td><td>{({pending: tx('대기', '待履行'), complete: tx('완료', '已完成'), over: tx('초과', '超额'), unknown: tx('미확인', '未确认')})[r.fulfillmentState]}</td></tr>)}</tbody></table></div></details>}
        {outAvailable && <p className="analysis-caption">{tx('집계 / 제외 / 미분류 행', '纳入 / 排除 / 未分类行')}: {q(out.acceptedLineCount, lang)} / {q(out.excludedLineCount, lang)} / {q(out.unclassified.lineCount, lang)}</p>}
        <p className="analysis-caption">{tx('계획 기간에 속한 출고행의 현재 이행량입니다. 과거 기간도 현재 누적값이며 납기 준수율이 아닙니다. 단위가 맞는 행만 집계합니다.', '按计划期间所属出库行统计当前履行量；历史期间同样为当前累计值，非准时交付率。仅汇总单位符合的行。')}{!outAvailable && tx(' 출고 자료 없음.', ' 无出库资料。')}</p>
      </Panel>
      <Panel id="analysis-mould" title={tx('금형 상태와 보전', '模具状态与保全')} note={`${tx('최근 스냅샷 · 선택일 당시 상태 아님', '最近快照 · 非所选日期当时状态')} · ${sourceNote('moulds')}`}>
        <dl className="analysis-stat-row"><Stat label={tx('등록 금형', '登记模具')} value={mouldValue(m.moulds.total)} /><Stat label={tx('생산 연결', '关联生产')} value={mouldValue(m.moulds.producing)} /><Stat label={tx('수리 중', '维修中')} value={mouldValue(m.moulds.repairCurrent)} /></dl>
        <dl className="analysis-inline-metrics"><div><dt>{tx('장착 / 보관', '装机 / 存放')}</dt><dd>{mouldValue(m.moulds.mounted)} / {mouldValue(m.moulds.stored)}</dd></div><div><dt>{tx('확인 필요 / 충돌', '待确认 / 冲突')}</dt><dd>{mouldValue(m.moulds.confirmationRequired)} / {mouldValue(m.moulds.conflicts)}</dd></div><div><dt>{tx('최근 30일 / 이전 30일 보전', '近30天 / 前30天保全')}</dt><dd>{q(hasService ? service.last30d : null, lang)} / {q(hasService ? service.previous30d : null, lang)}</dd></div></dl>
        <details className="analysis-disclosure"><summary>{tx('주별 보양·수리 기록', '每周保养及维修记录')}</summary>{hasService && service.weekly.length ? <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('주 시작', '周起始')}</th><th className="is-number">{tx('보양', '保养')}</th><th className="is-number">{tx('수리', '维修')}</th></tr></thead><tbody>{service.weekly.map((w, i) => <tr key={i}><th scope="row">{w.weekStart ?? '—'}</th><td className="is-number">{q(w.maintenance, lang)}</td><td className="is-number">{q(w.repair, lang)}</td></tr>)}</tbody></table></div> : <p className="analysis-caption">{tx('보전 이력 없음', '无保全记录')}</p>}</details>
        <p className="analysis-caption">{tx('보전 이력 수집 / 전체 금형', '保全记录采集 / 全部模具')} {q(hasService ? service.coveredMoulds : null, lang)} / {q(hasService ? service.totalMoulds : null, lang)} · {tx('90일 반복 보전 금형', '90天重复保全模具')} {q(hasService ? service.repeatMoulds90d : null, lang)}</p>
      </Panel>
    </div>
    <Panel id="analysis-quality-history" title={tx('생산 품번의 과거 품질 이력', '生产品号的历史质量记录')} note={`${tx('연결 기준일', '关联参考日期')} ${m.quality.businessDate ?? '—'} · ${tx('과거 이력 연결 · 선택 업무일 불량 아님', '历史记录关联 · 非所选业务日不良')} · ${sourceNote('quality_history')}`} link={<PermissionLink className="analysis-link" to="/quality/analysis">{tx('불량 분석', '不良分析')}</PermissionLink>}>
      {quality.available && m.quality.items.length ? <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx('설비', '设备')}</th><th>{tx('모델 / 품번', '型号 / 品号')}</th><th>{tx('관측 현상', '观测现象')}</th><th className="is-number">{tx('보고 수', '报告数')}</th><th>{tx('최근 보고', '最近报告')}</th></tr></thead><tbody>{m.quality.items.map(r => <tr key={r.id}><th scope="row">{r.machineLabel}</th><td>{r.modelLabel}<small>{r.partNumber ?? '—'}</small></td><td className="analysis-wrap-cell">{r.phenomena.join(' · ') || '—'}</td><td className="is-number">{q(r.reportCount, lang)}</td><td>{r.latestReportDate ?? '—'}</td></tr>)}</tbody></table></div> : <p className="analysis-caption">{quality.available ? tx('연결된 과거 이력 없음 · 현재 불량 0을 뜻하지 않습니다.', '无已关联历史记录，不代表当前不良为0。') : tx('과거 품질 원천 조회 불가', '历史质量数据源不可用')}</p>}
      <p className="analysis-caption">{m.quality.disclaimer ?? tx('보고 수는 불량 수량·불량률과 다릅니다.', '报告数不同于不良数量或不良率。')}</p>
    </Panel>
    <div className="analysis-weather-line">{tx('관측 환경', '观测环境')} · {m.weather.location} · {q(m.weather.status === 'unavailable' ? null : m.weather.temperatureC, lang, 1)}°C · {tx('습도', '湿度')} {q(m.weather.status === 'unavailable' ? null : m.weather.relativeHumidityPercent, lang)}% · {time(m.weather.validAt, lang)} UTC+8 {m.weather.status !== 'ok' && tx(' · 자료 지연·미확인', ' · 资料延迟或未确认')}</div>
  </>;
}
