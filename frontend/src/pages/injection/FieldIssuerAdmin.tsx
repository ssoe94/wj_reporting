import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  assignFieldIssuer, downloadFieldIssuerPolicy, fieldIssuerAssignments, releaseFieldIssuer, stopFieldIssuer,
} from '@/domains/field-monitoring/api';
import { fieldText, formatFieldTime } from '@/domains/field-monitoring/labels';
import type { Tx } from '@/domains/field-monitoring/labels';
import type {
  FieldIssuerAssignment, FieldIssuerDraft, FieldSerialCeiling, FieldStation,
} from '@/domains/field-monitoring/model';
import { FieldBadge, FieldLoadError, FieldNotice, panelClass, selectClass } from './FieldMonitoringViews';

const muted = 'text-[var(--wj-muted)]';
const reasonLimit = 240;
const ceilingLimit = 34 ** 4 - 1;
const ceilingRowsLimit = 4096;
const sourceDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function issuerError(error: unknown, tx: Tx) {
  if (axios.isAxiosError(error)) {
    const code: unknown = error.response?.data?.code;
    switch (code) {
      case 'issuer_conflict':
        return tx('이 품번의 기존 배정이 남아 있습니다. 기존 배정을 해제한 뒤 다시 배정해 주세요.', '此料号仍有现有分配。请先解除原分配，再分配新主体。');
      case 'issuer_stop_required':
        return tx('기존 주체의 발급을 먼저 중지해 주세요.', '请先停止原主体发号。');
      case 'issuer_heartbeat_required':
        return tx('기존 PC에 제외 설정을 적용한 뒤 중앙에서 새 하트비트를 확인해 주세요.', '请先在原电脑应用移除该料号的设置，再等待中央收到新心跳。');
      case 'issuer_ceiling_required':
        return tx('예약·취소·불확실 인쇄를 포함한 날짜별 마지막 예약 번호를 확인해 주세요.', '请核对每天的最后预留号码，包含取消和打印结果未确认的记录。');
      case 'issuer_work_pending':
        return tx('기존 PC의 진행 중 작업과 미전송 기록을 먼저 정리해 주세요.', '请先处理原电脑正在进行的工作和待发送记录。');
      case 'issuer_station_required':
        return tx('중량·라벨 앱이 등록된 사용 중인 PC를 선택해 주세요.', '请选择已启用且已登记称重与标签程序的电脑。');
      case 'issuer_policy_limit':
        return tx('이 PC의 발급 품번 등록 한도에 도달했습니다.', '此电脑已达到可分配的发号料号上限。');
      default:
        if (error.response?.status === 403) return tx('발급 주체를 관리할 권한이 없습니다.', '没有管理发号主体的权限。');
        if (error.response?.status === 400) return tx('품번, 날짜, 번호, 사유 등 입력값을 확인해 주세요.', '请检查料号、日期、号码和原因等输入。');
        if (error.response?.status === 409) return tx('배정 상태가 달라졌습니다. 목록을 확인해 주세요.', '分配状态已变化。请检查列表。');
    }
  }
  return tx('요청 결과를 확인하지 못했습니다. 목록을 확인한 뒤 다시 시도해 주세요.', '无法确认请求结果。请查看列表后重试。');
}

function releasedCeilingMinimums(error: unknown): FieldSerialCeiling[] {
  if (!axios.isAxiosError(error) || error.response?.data?.code !== 'issuer_ceiling_required') return [];
  const rows: unknown = error.response.data.minimums;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, ceilingRowsLimit).flatMap(row => {
    const day: unknown = row?.print_date;
    const floor: unknown = row?.serial_floor;
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
      && typeof floor === 'number' && Number.isInteger(floor) && floor >= 0 && floor <= ceilingLimit) {
      return [{ print_date: day, serial_floor: floor }];
    }
    return [];
  });
}

function IssuerField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 text-sm">
    <span className="mb-1 block font-medium">{label}</span>
    {children}
  </label>;
}

function AssignmentForm({ stations, busy, tx, onSave, onCancel }: {
  stations: FieldStation[];
  busy: boolean;
  tx: Tx;
  onSave: (draft: FieldIssuerDraft) => void;
  onCancel: () => void;
}) {
  const [external, setExternal] = useState(false);
  const [draft, setDraft] = useState({ namespace: 'CWJ', part_no: '', station_id: '', program: '', pc_note: '', reason: '' });
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  const kindLabel = tx('발급 주체 유형', '发号主体类型');
  const stationLabel = tx('발급 PC', '发号电脑');

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = draft.reason.trim();
    if (!reason) return;
    onSave({
      namespace: draft.namespace.trim(), part_no: draft.part_no.trim(), reason,
      station_id: external ? null : draft.station_id,
      program: external ? draft.program.trim() : 'weigh_label',
      pc_note: external ? draft.pc_note.trim() : '',
    });
  }

  return <form className="border-t border-[var(--wj-border)] p-4" onSubmit={save}>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <IssuerField label={tx('네임스페이스', '命名空间')}>
        <Input value={draft.namespace} onChange={event => setDraft({ ...draft, namespace: event.target.value.toUpperCase() })}
          required maxLength={3} pattern="[A-Z0-9]{3}" spellCheck={false} autoComplete="off" />
      </IssuerField>
      <IssuerField label={tx('품번', '料号')}>
        <Input ref={fieldRef} value={draft.part_no} onChange={event => setDraft({ ...draft, part_no: event.target.value.toUpperCase() })}
          required maxLength={32} pattern="[A-Z0-9][A-Z0-9_.\-]{0,31}" spellCheck={false} autoComplete="off" />
      </IssuerField>
      <IssuerField label={kindLabel}>
        <select aria-label={kindLabel} className={selectClass} value={external ? 'external' : 'station'} onChange={event => setExternal(event.target.value === 'external')}>
          <option value="station">{tx('현장 PC의 중량·라벨 앱', '现场电脑的称重与标签程序')}</option>
          <option value="external">{tx('외부 프로그램', '外部程序')}</option>
        </select>
      </IssuerField>
      {external ? <>
        <IssuerField label={tx('프로그램 이름', '程序名称')}>
          <Input value={draft.program} onChange={event => setDraft({ ...draft, program: event.target.value })} required maxLength={80} />
        </IssuerField>
        <IssuerField label={tx('PC 메모', '电脑备注')}>
          <Input value={draft.pc_note} onChange={event => setDraft({ ...draft, pc_note: event.target.value })} required maxLength={120} />
        </IssuerField>
      </> : <IssuerField label={stationLabel}>
        <select aria-label={stationLabel} className={selectClass} value={draft.station_id} onChange={event => setDraft({ ...draft, station_id: event.target.value })} required>
          <option value="">{tx('PC 선택', '选择电脑')}</option>
          {stations.filter(station => station.enabled && station.apps.includes('weigh_label')).map(station =>
            <option key={station.station_id} value={station.station_id}>{station.display_name} · {station.station_id}</option>)}
        </select>
      </IssuerField>}
      <IssuerField label={tx('배정 사유', '分配原因')}>
        <Input value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} required maxLength={reasonLimit} />
      </IssuerField>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={!draft.reason.trim() || (external && (!draft.program.trim() || !draft.pc_note.trim()))}>
          {tx('배정 저장', '保存分配')}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{tx('취소', '取消')}</Button>
      </div>
    </fieldset>
  </form>;
}

type Transition = 'stop' | 'release';
type CeilingDraft = { id: number; print_date: string; serial_floor: string };

function TransitionForm({ row, action, busy, error, minimums, tx, onSave, onCancel }: {
  row: FieldIssuerAssignment;
  action: Transition;
  busy: boolean;
  error: string;
  minimums: FieldSerialCeiling[];
  tx: Tx;
  onSave: (reason: string, ceilings: FieldSerialCeiling[]) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [ceilings, setCeilings] = useState<CeilingDraft[]>(() => [
    { id: 0, print_date: sourceDay.format(new Date()), serial_floor: '' },
  ]);
  const nextId = useRef(1);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  const release = action === 'release';
  const duplicateDates = new Set(ceilings.map(item => item.print_date)).size !== ceilings.length;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim() || (release && duplicateDates)) return;
    if (release && ceilings.some(item => !item.print_date || !item.serial_floor)) return;
    const values = release ? ceilings.map(({ print_date, serial_floor }) => ({
      print_date, serial_floor: Number(serial_floor),
    })) : [];
    onSave(reason.trim(), values);
  }

  function updateCeiling(id: number, key: 'print_date' | 'serial_floor', value: string) {
    setCeilings(prev => prev.map(item => item.id === id ? { ...item, [key]: value } : item));
  }

  return <form className="mt-3 border-t border-[var(--wj-border)] pt-3" onSubmit={save}>
    <fieldset disabled={busy} className="grid gap-3">
      <p className={`text-sm ${muted}`}>{release
        ? tx('취소·불확실 인쇄를 포함해 원장의 마지막 예약 번호를 날짜별로 입력하세요. 발급 이력이 없는 날짜만 0으로 입력합니다.', '按日期输入台账中的最后预留号码，包含取消及打印结果未确认的记录。仅在确认当天未发号时填写 0。')
        : row.station_id
          ? tx('작업을 마치고 발급을 멈춘 뒤 이 PC에 품번을 제외한 새 설정을 적용하세요.', '完成作业并停止发号后，请在此电脑应用移除该料号的新设置。')
          : tx('외부 프로그램의 작업을 마치고 해당 품번의 발급을 중지했는지 현장에서 확인하세요.', '请在现场确认外部程序的作业已完成，且已停止该料号发号。')}</p>
      <IssuerField label={release ? tx('해제 사유', '解除原因') : tx('중지 사유', '停止原因')}>
        <Input ref={fieldRef} value={reason} onChange={event => setReason(event.target.value)} required maxLength={reasonLimit} />
      </IssuerField>
      {release && <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-medium">{tx('날짜별 마지막 예약 번호', '每日最后预留号码')}</legend>
        {minimums.length > 0 && <div role="status" className={`mb-3 text-sm ${muted}`}>
          <p>{tx('중앙에서 확인한 날짜별 최소 입력값입니다. 원장과 대조하세요.', '以下为中央系统确认的每日最低值。请与台账核对。')}</p>
          <ul className="mt-1 flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto tabular-nums">
            {minimums.map(value => <li key={value.print_date}>{value.print_date} · {value.serial_floor}</li>)}
          </ul>
        </div>}
        <div className="grid gap-2">
          {ceilings.map((item, index) => <div key={item.id} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <IssuerField label={tx(`발급 날짜 ${index + 1} (UTC+8)`, `发号日期 ${index + 1} (UTC+8)`)}>
              <Input type="date" max={sourceDay.format(new Date())} value={item.print_date} onChange={event => updateCeiling(item.id, 'print_date', event.target.value)} required />
            </IssuerField>
            <IssuerField label={tx(`마지막 예약 번호 ${index + 1}`, `最后预留号码 ${index + 1}`)}>
              <Input type="number" inputMode="numeric" min={0} max={ceilingLimit} step={1} value={item.serial_floor}
                onChange={event => updateCeiling(item.id, 'serial_floor', event.target.value)} required />
            </IssuerField>
            {ceilings.length > 1 && <Button type="button" variant="secondary" onClick={() => {
              setCeilings(prev => prev.filter(value => value.id !== item.id));
            }}>{tx(`날짜 ${index + 1} 제거`, `删除日期 ${index + 1}`)}</Button>}
          </div>)}
        </div>
        {duplicateDates && <p role="alert" className="my-2 text-sm text-[var(--wj-danger)]">{tx('같은 날짜는 한 번만 입력하세요.', '同一日期只需填写一次。')}</p>}
        <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={ceilings.length >= ceilingRowsLimit} onClick={() => {
          const id = nextId.current++;
          setCeilings(prev => [...prev, { id, print_date: '', serial_floor: '' }]);
        }}>{tx('날짜 추가', '添加日期')}</Button>
      </fieldset>}
      {error && <p role="alert" className="text-sm text-[var(--wj-danger)]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={!reason.trim() || (release && duplicateDates)}>
          {release ? tx('배정 해제 확인', '确认解除分配') : tx('발급 중지 확인', '确认停止发号')}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{tx('취소', '取消')}</Button>
      </div>
    </fieldset>
  </form>;
}

function IssuerRecord({ row, station, tx }: { row: FieldIssuerAssignment; station?: FieldStation; tx: Tx }) {
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <strong className="break-all">{row.namespace} · {row.part_no}</strong>
      <FieldBadge tone={row.released_at ? 'neutral' : row.stopped_at ? 'warning' : 'success'}>
        {row.released_at ? tx('해제됨', '已解除') : row.stopped_at ? tx('이전 준비 중', '等待交接') : tx('배정됨', '已分配')}
      </FieldBadge>
    </div>
    <p className="mt-1 break-words text-sm">
      {row.station_id ? [station?.display_name, row.station_id, fieldText(row.program, tx)].filter(Boolean).join(' · ')
        : [tx('외부 프로그램', '外部程序'), row.program, row.pc_note].filter(Boolean).join(' · ')}
    </p>
    <dl className={`mt-1 grid gap-y-0.5 break-words text-sm ${muted}`}>
      <div><dt className="inline font-medium">{tx('배정', '分配')}</dt> <dd className="inline">{formatFieldTime(row.assigned_at)} · {row.reason}</dd></div>
      {row.stopped_at && <div><dt className="inline font-medium">{tx('중지', '停止')}</dt> <dd className="inline">{formatFieldTime(row.stopped_at)} · {row.stop_reason}</dd></div>}
      {row.released_at && <div><dt className="inline font-medium">{tx('해제', '解除')}</dt> <dd className="inline">{formatFieldTime(row.released_at)} · {row.release_reason}</dd></div>}
      {!!row.ceilings.length && <div><dt className="inline font-medium">{tx('마지막 번호', '最后号码')}</dt> <dd className="inline">
        {row.ceilings.map(value => `${value.print_date} · ${value.serial_floor}`).join(' / ')}
      </dd></div>}
    </dl>
  </>;
}

export default function FieldIssuerAdmin({ tx, authSessionId, stations }: {
  tx: Tx;
  authSessionId: string | null;
  stations: FieldStation[];
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['field-monitoring', authSessionId, 'issuer-assignments'],
    queryFn: ({ signal }) => fieldIssuerAssignments({ authSessionId, signal }),
    retry: false,
  });
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [minimums, setMinimums] = useState<FieldSerialCeiling[]>([]);
  const [message, setMessage] = useState('');
  const [editor, setEditor] = useState<'assign' | { id: number; action: Transition }>();
  useEffect(() => () => active.current?.abort(), []);

  function choose(next: typeof editor) {
    setError('');
    setMinimums([]);
    setMessage('');
    setEditor(next);
  }

  async function run(task: (signal: AbortSignal) => Promise<string>, refresh = true) {
    if (active.current) return;
    const operation = new AbortController();
    active.current = operation;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await task(operation.signal);
      if (!operation.signal.aborted) {
        setMessage(result);
        if (refresh) setEditor(undefined);
      }
    } catch (error) {
      if (!operation.signal.aborted) {
        setError(issuerError(error, tx));
        if (refresh) setMinimums(releasedCeilingMinimums(error));
      }
    } finally {
      active.current = null;
      if (!operation.signal.aborted) {
        setBusy(false);
        if (refresh) void queryClient.invalidateQueries({ queryKey: ['field-monitoring', authSessionId] });
      }
    }
  }

  function download(station: string) {
    void run(async signal => {
      await downloadFieldIssuerPolicy(station, { authSessionId, signal });
      return tx('발급 설정 파일을 내려받았습니다. 지정된 PC에 적용하세요.', '已下载发号设置文件。请在指定电脑上应用。');
    }, false);
  }

  const rows = query.data ?? [];
  const current = rows.filter(row => !row.released_at);
  const history = rows.filter(row => row.released_at);
  const globalError = (editor === 'assign' || !editor) ? error : '';
  return <section aria-labelledby="field-issuer-heading" className={`${panelClass} min-w-0`}>
    <header className="flex flex-wrap items-center justify-between gap-2 p-4">
      <h2 id="field-issuer-heading" className="font-semibold">{tx('발급 품번', '发号料号')}</h2>
      <Button type="button" size="sm" disabled={busy || !query.isSuccess || editor === 'assign'} onClick={() => choose('assign')}>
        {tx('발급 주체 배정', '分配发号主体')}
      </Button>
    </header>
    {(message || globalError) && <div className="px-4 pb-3"><FieldNotice role={globalError ? 'alert' : 'status'}>{globalError || message}</FieldNotice></div>}
    {editor === 'assign' && <AssignmentForm busy={busy} tx={tx} stations={stations} onCancel={() => choose(undefined)} onSave={draft => {
      void run(async signal => {
        await assignFieldIssuer(draft, { authSessionId, signal });
        return tx('발급 주체를 배정했습니다.', '已分配发号主体。');
      });
    }} />}
    {query.isPending && <div className="px-4 pb-3"><FieldNotice>{tx('배정 목록을 불러오는 중입니다.', '正在加载分配列表。')}</FieldNotice></div>}
    {query.isError && <div className="px-4 pb-3"><FieldLoadError tx={tx} retry={() => void query.refetch()} /></div>}
    {query.isSuccess && !current.length && <p className={`px-4 pb-3 text-sm ${muted}`}>{tx('현재 배정된 품번이 없습니다.', '暂无已分配的料号。')}</p>}
    {!!current.length && <ul className="divide-y divide-[var(--wj-border)] border-t border-[var(--wj-border)]">
      {current.map(row => <li key={row.id} className="px-4 py-3">
        <IssuerRecord row={row} station={stations.find(value => value.station_id === row.station_id)} tx={tx} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => choose({ id: row.id, action: row.stopped_at ? 'release' : 'stop' })}>
            {row.stopped_at ? tx('배정 해제', '解除分配') : tx('발급 중지', '停止发号')}
          </Button>
          {row.station_id && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => download(row.station_id!)}>
            {tx('발급 설정 다운로드', '下载发号设置')}
          </Button>}
        </div>
        {editor && editor !== 'assign' && editor.id === row.id &&
          <TransitionForm key={editor.action} row={row} action={editor.action} busy={busy} error={error} minimums={minimums} tx={tx} onCancel={() => choose(undefined)} onSave={(reason, ceilings) => {
            void run(async signal => {
              const request = { authSessionId, signal };
              if (editor.action === 'stop') {
                await stopFieldIssuer(row.id, reason, request);
                return row.station_id
                  ? tx('중지를 등록했습니다. 기존 PC에 새 설정을 적용하세요.', '已登记暂停。请在原电脑应用新设置。')
                  : tx('외부 발급 주체의 중지를 등록했습니다.', '已登记外部发号主体停止。');
              }
              await releaseFieldIssuer(row.id, reason, ceilings, request);
              return tx('발급 배정을 해제했습니다.', '已解除发号分配。');
            });
          }} />}
      </li>)}
    </ul>}
    {!!history.length && <details className="border-t border-[var(--wj-border)]">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{tx('해제 이력', '解除记录')}</summary>
      <ul className="divide-y divide-[var(--wj-border)]">
        {history.map(row => <li key={row.id} className="px-4 py-3">
          <IssuerRecord row={row} station={stations.find(value => value.station_id === row.station_id)} tx={tx} />
          {row.station_id && <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => download(row.station_id!)}>
            {tx('발급 설정 다운로드', '下载发号设置')}
          </Button>}
        </li>)}
      </ul>
    </details>}
  </section>;
}
