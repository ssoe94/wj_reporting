import { useState } from 'react';
import { useLang } from '../../i18n';
import { updateHrRoster } from '../../domains/hr/api';
import type { HrRosterEntry } from '../../domains/hr/workbook-types';
import { isHrConflict } from './hrCommon';

type Props = {
  month: string; entries: HrRosterEntry[]; onUpdated: (entries: HrRosterEntry[]) => void;
  error: boolean; onRetry: () => void; disabled: boolean;
};

export default function HrRosterPanel({ month, entries, onUpdated, error, onRetry, disabled }: Props) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<HrRosterEntry | null>(null);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [nextStatus, setNextStatus] = useState<HrRosterEntry['status']>('active');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const query = search.trim().normalize('NFC').toLowerCase();
  const visible = entries.filter((item) => (!kind || item.employment_type === kind) && (!status || item.status === status)
    && [item.code, item.name, ...item.previous_codes].some((value) => value.toLowerCase().includes(query)));
  const active = ko ? '재직' : '在职';
  const departed = ko ? '퇴사' : '离职';
  const changed = Boolean(editing && (code.trim() !== editing.code || nextStatus !== editing.status));
  async function save() {
    if (!editing || busy || disabled || !changed || !code.trim() || !reason.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const updated = await updateHrRoster(month, editing.id, {
        version: editing.version, reason: reason.trim(),
        ...(nextStatus !== editing.status ? { status: nextStatus } : {}),
        ...(code.trim() !== editing.code ? { code: code.trim() } : {}),
      });
      onUpdated(updated);
      setEditing(null);
    } catch (failure) {
      if (isHrConflict(failure)) {
        onRetry();
        setMessage(ko ? '명부가 변경되었습니다. 최신 내용을 확인한 뒤 편집을 다시 시작하세요.' : '名册已更新，请确认最新资料后重新编辑。');
      } else setMessage(ko ? '명부를 저장하지 못했습니다. 사번·상태와 사유를 확인해 주세요.' : '无法保存名册，请确认工号、状态和原因。');
    } finally { setBusy(false); }
  }
  return <details className="hr-panel hr-disclosure">
    <summary>{ko ? '인원 명부' : '人员名册'} ({entries.length})</summary>
    {error && <div role="alert">{ko ? '명부를 불러오지 못했습니다.' : '无法加载人员名册。'} <button className="hr-button" onClick={onRetry}>{ko ? '다시 시도' : '重试'}</button></div>}
    <div className="hr-compact-toolbar">
      <input aria-label={ko ? '사번·이름 검색' : '搜索工号或姓名'} placeholder={ko ? '사번·이름 검색' : '搜索工号或姓名'} value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label={ko ? '고용 형태' : '用工类型'} value={kind} onChange={(event) => setKind(event.target.value)}><option value="">{ko ? '모든 고용 형태' : '全部用工类型'}</option><option value="contract">{ko ? '계약직' : '合同工'}</option><option value="hourly">{ko ? '시간제' : '小时工'}</option></select>
      <select aria-label={ko ? '재직 상태' : '在职状态'} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{ko ? '모든 상태' : '全部状态'}</option><option value="active">{active}</option><option value="departed">{departed}</option></select>
    </div>
    {message && <p role="alert">{message}</p>}
    {editing && <form className="hr-compact-toolbar" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <strong>{editing.name}</strong>
      <label>{ko ? '사번' : '工号'} <input required maxLength={64} value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <label>{ko ? '상태' : '状态'} <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value as HrRosterEntry['status'])}><option value="active">{active}</option><option value="departed">{departed}</option></select></label>
      {changed && <label>{ko ? '변경 사유' : '变更原因'} <input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
      <button className="hr-button is-primary" disabled={busy || disabled || !changed || !code.trim() || !reason.trim()}>{ko ? '저장' : '保存'}</button>
      <button className="hr-button" type="button" disabled={busy} onClick={() => setEditing(null)}>{ko ? '취소' : '取消'}</button>
    </form>}
    <div className="hr-table-scroll"><table>
      <thead><tr>{(ko ? ['사번', '이름', '고용 형태', '부서', '상태', '처음 확인', '마지막 확인', '이달 급여', '편집'] : ['工号', '姓名', '用工类型', '部门', '状态', '首次确认', '最后确认', '本月工资', '编辑']).map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{visible.map((item) => <tr key={item.id}>
        <td>{item.code}</td><td>{item.name}</td><td>{item.employment_type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시간제' : '小时工')}</td><td>{item.department || '—'}</td><td>{item.status === 'active' ? active : departed}</td><td>{item.first_month}</td><td>{item.last_month}</td><td>{item.in_month ? (ko ? '포함' : '已列入') : (ko ? '이번 달 급여에 없음' : '未列入本月工资表')}</td>
        <td><button className="hr-button" disabled={busy || disabled} onClick={() => { setEditing(item); setCode(item.code); setNextStatus(item.status); setReason(''); setMessage(''); }}>{ko ? '편집' : '编辑'}</button></td>
      </tr>)}</tbody>
    </table></div>
    {!visible.length && !error && <p className="hr-muted">{ko ? '표시할 직원이 없습니다.' : '没有可显示的员工。'}</p>}
  </details>;
}
