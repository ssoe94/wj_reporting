import { Fragment, useEffect, useState } from 'react';
import { useLang } from '../../i18n';
import { getHrRosterHistory, updateHrRoster } from '../../domains/hr/api';
import { filterRoster, rosterCounts, rosterHistoryChanges } from '../../domains/hr/roster';
import type { HrRosterEntry, HrRosterHistory } from '../../domains/hr/workbook-types';
import { isHrConflict } from './hrCommon';

type Props = {
  month: string; entries: HrRosterEntry[]; onUpdated: (entries: HrRosterEntry[]) => void;
  error: boolean; onRetry: () => void; disabled: boolean;
  onEditChange?: (editing: boolean) => void; onBusyChange?: (busy: boolean) => void;
};

export function HrRosterHistoryList({ history, ko }: { history: HrRosterHistory[]; ko: boolean }) {
  const labels = { code: ko ? '사번' : '工号', status: ko ? '상태' : '状态', employment_type: ko ? '고용형태' : '用工类型', department: ko ? '부서' : '部门' };
  function value(field: string, item: string) {
    if (field === 'status') return item === 'active' ? (ko ? '재직' : '在职') : item === 'departed' ? (ko ? '퇴사' : '离职') : '—';
    if (field === 'employment_type') return item === 'contract' ? (ko ? '계약직' : '合同工') : item === 'hourly' ? (ko ? '시간제' : '小时工') : '—';
    return item || '—';
  }
  return <ol className="hr-roster-history-list">{history.map((item) => <li key={item.id}>
    <div className="hr-roster-history-meta"><time dateTime={item.created_at}>{new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.created_at))}</time><span>{ko ? '실행자' : '操作人'}: {item.actor_label || '—'}</span></div>
    <ul>{rosterHistoryChanges(item).map((change) => <li key={change.field}><strong>{labels[change.field]}</strong> {value(change.field, change.before)} → {value(change.field, change.after)}</li>)}</ul>
    <p><strong>{ko ? '사유' : '原因'}:</strong> {item.reason}</p>
  </li>)}</ol>;
}

function RosterHistory({ month, employee, ko }: { month: string; employee: HrRosterEntry; ko: boolean }) {
  const [history, setHistory] = useState<HrRosterHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false); setHistory([]);
    getHrRosterHistory(month, employee.id, controller.signal).then((entries) => {
      if (!controller.signal.aborted) setHistory(entries);
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, employee.id, employee.version, reload]);
  return <section className="hr-roster-history" aria-label={`${employee.name} ${ko ? '변경 이력' : '变更记录'}`}>
    <h3>{ko ? '변경 이력' : '变更记录'} <span>{ko ? '최근 20건' : '最近 20 条'}</span></h3>
    {loading ? <p role="status">{ko ? '이력을 불러오는 중입니다.' : '正在加载变更记录。'}</p>
      : error ? <div role="alert" className="hr-alert is-error">{ko ? '이력을 불러오지 못했습니다.' : '无法加载变更记录。'} <button className="hr-button" onClick={() => setReload((count) => count + 1)}>{ko ? '다시 시도' : '重试'}</button></div>
      : history.length ? <HrRosterHistoryList history={history} ko={ko} /> : <p className="hr-muted">{ko ? '변경 이력이 없습니다.' : '暂无变更记录。'}</p>}
  </section>;
}

export default function HrRosterPanel({ month, entries, onUpdated, error, onRetry, disabled, onEditChange, onBusyChange }: Props) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [absent, setAbsent] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<HrRosterEntry | null>(null);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [nextStatus, setNextStatus] = useState<HrRosterEntry['status']>('active');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  useEffect(() => { onEditChange?.(Boolean(editing)); return () => onEditChange?.(false); }, [editing, onEditChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const visible = filterRoster(entries, { search, kind, status, absent });
  const counts = rosterCounts(entries);
  const active = ko ? '재직' : '在职'; const departed = ko ? '퇴사' : '离职';
  const changed = Boolean(editing && (code.trim() !== editing.code || nextStatus !== editing.status));
  function summaryFilter(selected: 'active' | 'departed' | 'absent') {
    setSearch(''); setKind(''); setStatus(selected === 'absent' ? '' : selected); setAbsent(selected === 'absent');
  }
  async function save() {
    if (!editing || busy || disabled || conflict || !changed || !code.trim() || !reason.trim()) return;
    setBusy(true); setMessage('');
    try {
      const updated = await updateHrRoster(month, editing.id, {
        version: editing.version, reason: reason.trim(),
        ...(nextStatus !== editing.status ? { status: nextStatus } : {}),
        ...(code.trim() !== editing.code ? { code: code.trim() } : {}),
      });
      onUpdated(updated); setEditing(null);
    } catch (failure) {
      if (isHrConflict(failure)) {
        setConflict(true); onRetry();
        setMessage(ko ? '명부가 변경되었습니다. 초안은 유지됩니다. 최신 내용을 확인하고 취소한 뒤 편집을 다시 시작하세요.' : '名册已更新，草稿已保留。请确认最新资料，取消后重新编辑。');
      } else setMessage(ko ? '명부를 저장하지 못했습니다. 사번·상태와 사유를 확인해 주세요.' : '无法保存名册，请确认工号、状态和原因。');
    } finally { setBusy(false); }
  }
  return <section className="hr-panel hr-roster-page-panel" aria-labelledby="hr-roster-title">
    <div className="hr-section-heading"><h2 id="hr-roster-title">{ko ? '인원 명부' : '人员名册'}</h2><span className="hr-muted">{ko ? '전체' : '共'} {entries.length}{ko ? '명' : '人'}</span></div>
    {error && <div role="alert" className="hr-alert is-error">{ko ? '명부를 불러오지 못했습니다.' : '无法加载人员名册。'} <button className="hr-button" onClick={onRetry}>{ko ? '다시 시도' : '重试'}</button></div>}
    <div className="hr-summary-strip hr-roster-summary" aria-label={ko ? '명부 요약 필터' : '名册汇总筛选'}>
      <button aria-pressed={status === 'active' && !absent} onClick={() => summaryFilter('active')}><span>{active}</span><strong>{counts.active}<small>{ko ? '명' : '人'}</small></strong></button>
      <button aria-pressed={status === 'departed' && !absent} onClick={() => summaryFilter('departed')}><span>{departed}</span><strong>{counts.departed}<small>{ko ? '명' : '人'}</small></strong></button>
      <button aria-pressed={absent && !status} onClick={() => summaryFilter('absent')}><span>{ko ? '이번 달 급여 미포함' : '本月工资未列入'}</span><strong>{counts.absent}<small>{ko ? '명' : '人'}</small></strong></button>
    </div>
    <div className="hr-roster-filters">
      <label className="hr-field">{ko ? '직원 검색' : '搜索员工'}<input type="search" aria-label={ko ? '사번·이름·이전 사번 검색' : '搜索工号、姓名或原工号'} placeholder={ko ? '사번·이름·이전 사번' : '工号、姓名或原工号'} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="hr-field">{ko ? '고용형태' : '用工类型'}<select aria-label={ko ? '고용형태' : '用工类型'} value={kind} onChange={(event) => setKind(event.target.value)}><option value="">{ko ? '전체' : '全部'}</option><option value="contract">{ko ? '계약직' : '合同工'}</option><option value="hourly">{ko ? '시간제' : '小时工'}</option></select></label>
      <label className="hr-field">{ko ? '상태' : '状态'}<select aria-label={ko ? '재직 상태' : '在职状态'} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{ko ? '전체' : '全部'}</option><option value="active">{active}</option><option value="departed">{departed}</option></select></label>
      <label className="hr-checkbox hr-roster-absent"><input type="checkbox" checked={absent} onChange={(event) => setAbsent(event.target.checked)} />{ko ? '이번 달 미포함만' : '仅本月未列入'}</label>
      <button className="hr-button" onClick={() => { setSearch(''); setKind(''); setStatus(''); setAbsent(false); }}>{ko ? '초기화' : '重置'}</button>
    </div>
    {message && <p className="hr-alert is-error" role="alert">{message}</p>}
    {editing && <form className="hr-roster-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <strong>{editing.name} · {ko ? '편집 중' : '编辑中'}</strong>
      <label className="hr-field">{ko ? '사번' : '工号'}<input required maxLength={64} disabled={busy} value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <label className="hr-field">{ko ? '상태' : '状态'}<select aria-label={ko ? '상태' : '状态'} disabled={busy} value={nextStatus} onChange={(event) => setNextStatus(event.target.value as HrRosterEntry['status'])}><option value="active">{active}</option><option value="departed">{departed}</option></select></label>
      {changed && <label className="hr-field hr-roster-reason">{ko ? '변경 사유' : '变更原因'}<input required maxLength={500} disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
      <div className="hr-actions"><button className="hr-button is-primary" disabled={busy || disabled || conflict || !changed || !code.trim() || !reason.trim()}>{ko ? '저장' : '保存'}</button><button className="hr-button" type="button" disabled={busy} onClick={() => { setEditing(null); setConflict(false); setMessage(''); }}>{ko ? '취소' : '取消'}</button></div>
    </form>}
    <p className="hr-roster-result-count" role="status">{ko ? '검색 결과' : '筛选结果'} {visible.length}{ko ? '명' : '人'}</p>
    <div className="hr-table-scroll hr-roster-table" tabIndex={0} role="region" aria-label={ko ? '직원 명부 표' : '员工名册表'}><table>
      <thead><tr>{(ko ? ['사번', '이름', '고용형태', '부서', '상태', '처음 확인 월', '마지막 확인 월', '이번 달 급여', '편집'] : ['工号', '姓名', '用工类型', '部门', '状态', '首次确认月份', '最后确认月份', '本月工资', '编辑']).map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{visible.map((item) => <Fragment key={item.id}><tr>
        <td><button className="hr-roster-expand" aria-expanded={expanded === item.id} aria-controls={`hr-roster-history-${item.id}`} aria-label={`${item.code} ${item.name} ${ko ? '변경 이력' : '变更记录'}`} onClick={() => setExpanded(expanded === item.id ? null : item.id)}><span aria-hidden="true">{expanded === item.id ? '▾' : '▸'}</span>{item.code}</button></td>
        <td>{item.name}</td><td>{item.employment_type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시간제' : '小时工')}</td><td>{item.department || '—'}</td><td>{item.status === 'active' ? active : departed}</td><td>{item.first_month}</td><td>{item.last_month}</td><td>{item.in_month ? (ko ? '포함' : '已列入') : (ko ? '미포함' : '未列入')}</td>
        <td><button className="hr-button" disabled={busy || disabled || Boolean(editing)} onClick={() => { setEditing(item); setCode(item.code); setNextStatus(item.status); setReason(''); setMessage(''); setConflict(false); }}>{ko ? '편집' : '编辑'}</button></td>
      </tr>{expanded === item.id && <tr id={`hr-roster-history-${item.id}`}><td colSpan={9}><RosterHistory month={month} employee={item} ko={ko} /></td></tr>}</Fragment>)}</tbody>
    </table></div>
    {!visible.length && !error && <p className="hr-state hr-muted">{entries.length ? (ko ? '조건에 맞는 직원이 없습니다.' : '没有符合条件的员工。') : (ko ? '등록된 직원이 없습니다.' : '暂无已登记员工。')}</p>}
  </section>;
}
