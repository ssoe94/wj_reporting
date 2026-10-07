import { useEffect, useState } from 'react';
import InspectionStationDetails from './InspectionStationDetails';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { inspectionStationNumbers, stationDefaultRequest, stationProductionSummary, stationRequests, stationStage } from './stationPickerModel';
import { inspectionRequestStage } from './kanban';
import type { InspectionKanban } from './kanban';
import { stationMesBadgeLabel, stationMesInspectionView } from './mesInspectionSignal';

export default function InspectionStationPicker({ snapshot, date, lang, loading, error, selectedMachine, selectedId, locked, onMachine, onSelect, onDate, onRefresh }: {
  snapshot: InspectionKanban | null; date: string; lang: 'ko' | 'zh'; loading: boolean; error: string; selectedMachine: number | null; selectedId: number | null; locked: boolean;
  onMachine: (machine: number, requestId: number | null) => void; onSelect: (id: number) => void; onDate: (date: string) => void; onRefresh: () => void;
}) {
  const ko = lang === 'ko';
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [snapshot]);
  const labels = ko ? { waiting: '대기', in_progress: '검사 중', completed: '완료 확인', blocked: '확인 필요', empty: '표시 요청 없음', unknown: '조회 미확인' } : { waiting: '待检', in_progress: '检验中', completed: '完成已确认', blocked: '需确认', empty: '无显示申请', unknown: '查询未确认' };
  const evidenceLabels = ko ? { current: 'MES 미확인', unavailable: 'MES 미확인', stale: 'MES 재조회 필요', work_changed: '작업 연결 확인', stopped: '정지 · 검사 확인', unverified: 'MES 확인 필요' }
    : { current: 'MES 未确认', unavailable: 'MES 未确认', stale: 'MES 需刷新', work_changed: '核对任务关联', stopped: '停机 · 核对检验', unverified: 'MES 需确认' };
  const machine = snapshot?.machines.find((row) => row.machine_number === selectedMachine);
  const requests = stationRequests(machine);
  return <section className="inspection-station-picker" aria-label={ko ? '설비별 검사 선택' : '按设备选择检验'} aria-busy={loading}>
    {error && <div className="inspection-message is-error" role="alert">{error}{snapshot && <span> · {ko ? '마지막 조회 결과' : '上次查询结果'}</span>}</div>}
    <div className="inspection-station-grid">{inspectionStationNumbers.map((number) => {
      const station = snapshot?.machines.find((row) => row.machine_number === number);
      const stage = stationStage(station);
      const rows = stationRequests(station);
      const mes = stationMesInspectionView(station, snapshot, nowMs, { transportError: Boolean(error) });
      const production = stationProductionSummary(station, mes, lang);
      const badgeLabel = (item: typeof mes.badges[number]) => item.kind === null ? evidenceLabels[mes.evidence_state] : stationMesBadgeLabel(item, lang);
      const elapsed = mes.badges.filter(item => item.elapsed_minutes !== null).sort((a, b) => b.elapsed_minutes! - a.elapsed_minutes!)[0];
      const elapsedText = elapsed ? (ko ? `요청 후 ${elapsed.elapsed_minutes}분` : `申请后 ${elapsed.elapsed_minutes}分`) : '';
      const label = `${number}${ko ? '호기' : '号机'} · ${production.part} · ${production.product} · ${production.production} · ${mes.badges.map(badgeLabel).join(' · ')}${elapsedText ? ` · ${elapsedText}` : ''}${rows.length ? ` · WJ ${rows.length}${ko ? '건' : '项'}` : ''}`;
      return <button key={number} type="button" className="inspection-station-tile" data-machine={number} data-stage={stage} data-mes-state={mes.evidence_state} data-source-kind={mes.source_kind || 'wj_plan_only'} aria-label={label} title={label} aria-pressed={selectedMachine === number} disabled={!station || locked} onClick={() => onMachine(number, stationDefaultRequest(station, selectedId))}>
        <strong>{number}{ko ? '호기' : '号机'}</strong>
        <span className="inspection-station-part">{production.part}</span>
        <span className="inspection-station-product">{production.product}</span>
        <span className="inspection-station-production" data-source={production.source}>{production.production}</span>
        <span className="inspection-station-signals">{mes.badges.map(item => <span className="inspection-station-signal" data-tone={item.state === 'in_progress' ? 'requested' : item.state} data-inspection-kind={item.kind || 'unknown'} key={item.kind || 'unknown'}>{badgeLabel(item)}</span>)}{rows.length > 0 && <span className="inspection-station-signal" data-tone="local">WJ {rows.length}{ko ? '건' : '项'}</span>}</span>
        {elapsedText && <span className="inspection-station-signal-time">{elapsedText}</span>}
      </button>;
    })}</div>
    {snapshot?.machines.some(row => row.mes_inspection_signal?.source_kind === 'synthetic_contract_fixture') && <p className="inspection-muted inspection-station-source" role="status">{ko ? '합성 MES 예시 · 실제 MES 수신 아님' : '合成 MES 示例 · 非实际 MES 接收'}</p>}
    <div className="inspection-station-context-bar">{machine && <div className="inspection-station-request-choice"><strong>{machine.machine_number}{ko ? '호기' : '号机'}</strong>{requests.length ? <label><span>{ko ? '검사요청' : '检验申请'}</span><select aria-label={ko ? '선택 설비 검사요청' : '所选设备检验申请'} value={requests.some((row) => row.id === selectedId) ? String(selectedId) : ''} disabled={locked} onChange={(event) => { if (event.target.value) onSelect(Number(event.target.value)); }}><option value="" disabled>{ko ? '요청 선택' : '选择申请'}</option>{requests.map((row) => <option value={row.id} key={row.id}>#{row.id} · {row.part_no || row.work_order_ref} · {labels[inspectionRequestStage(row)]}</option>)}</select></label> : <span className="inspection-muted">{ko ? '표시된 WJ 검사요청이 없습니다.' : '没有显示的 WJ 检验申请。'}</span>}</div>}
    <div className="inspection-station-toolbar"><button type="button" className="inspection-button" disabled={!machine} aria-expanded={expanded && Boolean(machine)} aria-controls="inspection-station-detail" onClick={() => setExpanded((value) => !value)}>{ko ? '설비·계획 상세' : '设备·计划详情'}{expanded && machine ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}</button><span>{ko ? '설비별 WJ 요청' : '设备 WJ 申请'}{snapshot && ` · ${snapshot.counts.requests_displayed}`}</span><label>{ko ? '생산일' : '生产日'}<input type="date" value={date} disabled={locked} onChange={(event) => { if (event.target.value) onDate(event.target.value); }} /></label><button type="button" className="inspection-button" disabled={loading} onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />{ko ? '새로고침' : '刷新'}</button></div>
    </div>
    {expanded && machine && snapshot && <InspectionStationDetails machine={machine} snapshot={snapshot} lang={lang} selectedId={selectedId} locked={locked} onSelect={onSelect} />}
    {(snapshot?.requests_truncated || snapshot?.plans_truncated) && <p className="inspection-board-warning" role="status">{ko ? '조회 상한으로 일부 요청이 생략될 수 있습니다.' : '达到查询上限，部分申请可能未显示。'}</p>}
  </section>;
}
