import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  fieldServerOrigin, fieldStations, issueFieldToken, registerFieldStation, revokeFieldToken, updateFieldStation,
} from '@/domains/field-monitoring/api';
import { fieldText, formatFieldTime } from '@/domains/field-monitoring/labels';
import type { Tx } from '@/domains/field-monitoring/labels';
import { FIELD_APPS, FIELD_ASSEMBLY_LINES, fieldStationBinding } from '@/domains/field-monitoring/model';
import type { FieldAssemblyLine, FieldProductionProcess, FieldStation, FieldStationDraft, IssuedToken } from '@/domains/field-monitoring/model';
import { FieldBadge, FieldLoadError, FieldNotice, panelClass, selectClass } from './FieldMonitoringViews';
import FieldIssuerAdmin from './FieldIssuerAdmin';

const blankStation: FieldStationDraft = {
  station_id: '', display_name: '', apps: [], location: '', line_note: '', ...fieldStationBinding({}), enabled: true,
};
const injectionMachineNumbers = Array.from({ length: 17 }, (_, index) => index + 1);
const muted = 'text-[var(--wj-muted)]';

function productionBindingLabel(station: FieldStation, tx: Tx) {
  const { production_process: process, injection_machine_number: machine, assembly_line: line } = fieldStationBinding(station);
  if (process === 'injection') return tx('사출', '注塑') + ' · ' + (
    machine == null ? tx('호기 미연결', '未关联机台') : tx(`${machine}호기`, `${machine}号机`)
  );
  if (process === 'assembly') return tx('조립', '组装') + ' · ' + (
    line == null ? tx('라인 미연결', '未关联产线') : tx(`${line} 라인`, `${line} 线`)
  );
  return tx('공정 미연결', '未关联工序');
}

function stationError(error: unknown, tx: Tx) {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 403) return tx('현장 PC를 변경할 권한이 없습니다.', '没有修改现场电脑的权限。');
    if (error.response?.status === 409) return tx('PC ID가 이미 등록되어 있거나 상태가 바뀌었습니다. 목록을 확인해 주세요.', '电脑 ID 已登记或状态已变化。请检查列表。');
    if (error.response?.status === 400) return tx('PC ID, 이름, 앱 등 입력값을 확인해 주세요.', '请检查电脑 ID、名称、程序等输入。');
  }
  return tx('요청 결과를 확인하지 못했습니다. 다시 시도하기 전에 목록에서 상태를 확인해 주세요.', '无法确认请求结果。重试前请检查列表中的状态。');
}

function IssuedTokenPanel({ issued, tx, onClose }: { issued: IssuedToken; tx: Tx; onClose: () => void }) {
  const [copyStatus, setCopyStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const connection = JSON.stringify({
    server: fieldServerOrigin(),
    station_id: issued.station_id,
    token: issued.token,
  }, null, 2);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(tx('복사했습니다.', '已复制。'));
    } catch {
      setCopyStatus(tx('자동 복사를 사용할 수 없습니다. 아래 연결 JSON을 선택해 복사해 주세요.', '无法自动复制。请选取下方连接 JSON 并复制。'));
    }
  }

  return <section aria-labelledby="field-issued-token" className={`${panelClass} grid gap-3 p-4`}>
    <div>
      <h2 id="field-issued-token" tabIndex={-1} ref={heading} className="font-semibold">
        {tx('새 장비 토큰', '新设备令牌')} · {issued.station_id}
      </h2>
      <p className={`text-sm ${muted}`}>{tx('이 화면을 닫으면 토큰을 다시 볼 수 없습니다. 지정된 현장 PC에 보관해 주세요.', '关闭此页面后无法再次查看令牌。请保存在指定的现场电脑。')}</p>
    </div>
    <div className="text-sm">
      <label htmlFor="field-connection-json" className="mb-1 block font-medium">{tx('연결 JSON', '连接 JSON')}</label>
      <textarea id="field-connection-json" readOnly rows={6} spellCheck={false} className="ui-input block w-full px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-[var(--wj-accent)]" value={connection} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" onClick={() => void copy(connection)}>{tx('연결 JSON 복사', '复制连接 JSON')}</Button>
      <Button type="button" variant="secondary" onClick={() => void copy(issued.token)}>{tx('토큰 복사', '复制令牌')}</Button>
      <Button type="button" variant="ghost" onClick={onClose}>{tx('닫기', '关闭')}</Button>
      <span role="status" className={`text-sm ${muted}`}>{copyStatus}</span>
    </div>
  </section>;
}

export default function FieldStationAdmin({ tx, authSessionId }: { tx: Tx; authSessionId: string | null }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(blankStation);
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedToken>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryKey: ['field-monitoring', authSessionId, 'stations'],
    queryFn: ({ signal }) => fieldStations({ authSessionId, signal }),
    retry: false,
  });

  useEffect(() => () => active.current?.abort(), []);

  function reset() {
    setDraft(blankStation);
    setEditing('');
  }

  function edit(station: FieldStation) {
    setIssued(undefined);
    setError('');
    setMessage('');
    setEditing(station.station_id);
    setDraft({
      station_id: station.station_id, display_name: station.display_name, apps: station.apps,
      location: station.location, line_note: station.line_note, enabled: station.enabled,
      ...fieldStationBinding(station),
    });
    formHeading.current?.focus();
  }

  async function run(task: (signal: AbortSignal) => Promise<string>) {
    if (active.current) return;
    const operation = new AbortController();
    active.current = operation;
    setBusy(true);
    setError('');
    setMessage('');
    setIssued(undefined);
    try {
      const status = await task(operation.signal);
      if (!operation.signal.aborted) setMessage(status);
    } catch (error) {
      if (!operation.signal.aborted) setError(stationError(error, tx));
    } finally {
      active.current = null;
      if (!operation.signal.aborted) {
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: ['field-monitoring', authSessionId] });
      }
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const next = {
      ...draft,
      station_id: draft.station_id.trim(),
      display_name: draft.display_name.trim(),
      location: draft.location.trim(),
      line_note: draft.line_note.trim(),
    };
    if (!next.station_id || !next.display_name || !next.apps.length) return;
    void run(async signal => {
      const request = { authSessionId, signal };
      if (editing) await updateFieldStation(editing, next, request);
      else await registerFieldStation(next, request);
      if (!signal.aborted) reset();
      return editing ? tx('현장 PC를 수정했습니다.', '已更新现场电脑。') : tx('현장 PC를 등록했습니다.', '已登记现场电脑。');
    });
  }

  function issue(station: FieldStation) {
    if (station.credential_active && !window.confirm(tx(
      `${station.display_name}의 기존 토큰을 회수하고 새 토큰을 발급합니까?`,
      `是否撤销 ${station.display_name} 的现有令牌并签发新令牌？`,
    ))) return;
    void run(async signal => {
      const result = await issueFieldToken(station.station_id, { authSessionId, signal });
      if (!signal.aborted) setIssued(result);
      return tx('새 장비 토큰을 발급했습니다.', '已签发新设备令牌。');
    });
  }

  function revoke(station: FieldStation) {
    if (!window.confirm(tx(
      `${station.display_name}의 토큰을 회수합니까?`, `是否撤销 ${station.display_name} 的令牌？`,
    ))) return;
    void run(async signal => {
      await revokeFieldToken(station.station_id, { authSessionId, signal });
      return tx('장비 토큰을 회수했습니다.', '已撤销设备令牌。');
    });
  }

  return <div className="grid gap-3">
    {message && <FieldNotice>{message}</FieldNotice>}
    {error && <FieldNotice role="alert">{error}</FieldNotice>}
    {issued && <IssuedTokenPanel key={issued.station_id} issued={issued} tx={tx} onClose={() => setIssued(undefined)} />}
    <form className={`${panelClass} p-4`} onSubmit={save}>
      <h2 tabIndex={-1} ref={formHeading} className="mb-3 font-semibold">
        {editing ? tx('현장 PC 수정', '修改现场电脑') : tx('현장 PC 등록', '登记现场电脑')}
      </h2>
      <fieldset disabled={busy} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('PC ID', '电脑 ID')}</span>
          <Input value={draft.station_id} onChange={event => setDraft({ ...draft, station_id: event.target.value })} required readOnly={!!editing} autoComplete="off" maxLength={64} pattern="[A-Za-z0-9_\-]{1,64}" />
        </label>
        <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('표시 이름', '显示名称')}</span>
          <Input value={draft.display_name} onChange={event => setDraft({ ...draft, display_name: event.target.value })} required maxLength={120} />
        </label>
        <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('설치 위치', '安装位置')}</span>
          <Input value={draft.location} onChange={event => setDraft({ ...draft, location: event.target.value })} maxLength={120} />
        </label>
        <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('호기·라인 메모', '机台与产线备注')}</span>
          <Input value={draft.line_note} onChange={event => setDraft({ ...draft, line_note: event.target.value })} maxLength={160} />
        </label>
        <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('생산 공정', '生产工序')}</span>
          <select name="production_process" className={selectClass} value={draft.production_process ?? ''} onChange={event => {
            const process = event.target.value as FieldProductionProcess | '';
            setDraft({ ...draft, ...fieldStationBinding({ production_process: process || null }) });
          }}>
            <option value="">{tx('연결 안 함', '不关联')}</option>
            <option value="injection">{tx('사출', '注塑')}</option>
            <option value="assembly">{tx('조립', '组装')}</option>
          </select>
        </label>
        {draft.production_process === 'injection' && <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('사출 호기', '注塑机台')}</span>
          <select name="injection_machine_number" className={selectClass} value={draft.injection_machine_number ?? ''} onChange={event => {
            const value = event.target.value;
            setDraft({ ...draft, injection_machine_number: value === '' ? null : Number(value) });
          }}>
            <option value="">{tx('연결 안 함', '不关联')}</option>
            {injectionMachineNumbers.map(number => <option key={number} value={number}>{number}{tx('호기', '号机')}</option>)}
          </select>
        </label>}
        {draft.production_process === 'assembly' && <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('조립 라인', '组装产线')}</span>
          <select name="assembly_line" className={selectClass} value={draft.assembly_line ?? ''} onChange={event => {
            const line = event.target.value as FieldAssemblyLine | '';
            setDraft({ ...draft, assembly_line: line || null });
          }}>
            <option value="">{tx('연결 안 함', '不关联')}</option>
            {FIELD_ASSEMBLY_LINES.map(line => <option key={line} value={line}>{tx(`${line} 라인`, `${line} 线`)}</option>)}
          </select>
        </label>}
        <fieldset className="min-w-0 text-sm sm:col-span-2">
          <legend className="mb-1 font-medium">{tx('사용 앱', '使用的程序')}</legend>
          <div className="flex flex-wrap gap-x-4">
            {[...new Set([...FIELD_APPS, ...draft.apps])].map(app => <label key={app} className="flex min-h-10 items-center gap-2">
              <input type="checkbox" name="apps" className="size-4 accent-[var(--wj-accent)]" checked={draft.apps.includes(app)} onChange={event => {
                const apps = event.target.checked ? [...draft.apps, app] : draft.apps.filter(value => value !== app);
                setDraft({ ...draft, apps });
              }} />
              {fieldText(app, tx)}
            </label>)}
          </div>
        </fieldset>
        <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="size-4 accent-[var(--wj-accent)]" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
          {tx('사용 중', '启用')}
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" disabled={!draft.station_id.trim() || !draft.display_name.trim() || !draft.apps.length}>
            {editing ? tx('저장', '保存') : tx('등록', '登记')}
          </Button>
          {editing && <Button type="button" variant="secondary" onClick={reset}>{tx('수정 취소', '取消修改')}</Button>}
        </div>
      </fieldset>
    </form>
    <FieldIssuerAdmin tx={tx} authSessionId={authSessionId} stations={query.data ?? []} />
    {query.isPending && <FieldNotice>{tx('현장 PC 목록을 불러오는 중입니다.', '正在加载现场电脑列表。')}</FieldNotice>}
    {query.isError && <FieldLoadError tx={tx} retry={() => void query.refetch()} />}
    {query.data?.length === 0 && <FieldNotice>{tx('등록된 현장 PC가 없습니다.', '暂无已登记的现场电脑。')}</FieldNotice>}
    {Boolean(query.data?.length) && <ul className={`${panelClass} divide-y divide-[var(--wj-border)]`}>
      {query.data?.map(station => <li key={station.station_id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="break-all">{station.display_name} · {station.station_id}</strong>
            <FieldBadge>{station.enabled ? tx('사용 중', '启用') : tx('사용 중지', '停用')}</FieldBadge>
            <FieldBadge>{productionBindingLabel(station, tx)}</FieldBadge>
            <FieldBadge>{station.credential_active ? tx('유효한 토큰', '有效令牌') : tx('유효한 토큰 없음', '无有效令牌')}</FieldBadge>
          </div>
          <p className={`mt-1 break-words ${muted}`}>{[station.location, station.line_note, ...station.apps.map(app => fieldText(app, tx))].filter(Boolean).join(' · ')}</p>
          <p className={`tabular-nums ${muted}`}>{tx('수정', '更新')} {formatFieldTime(station.updated_at)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => edit(station)}>{tx('수정', '修改')}</Button>
          <Button type="button" variant="secondary" disabled={busy || !station.enabled} onClick={() => issue(station)}>
            {station.credential_active ? tx('토큰 재발급', '重新签发令牌') : tx('토큰 발급', '签发令牌')}
          </Button>
          {station.credential_active && <Button type="button" variant="danger" disabled={busy} onClick={() => revoke(station)}>
            {tx('토큰 회수', '撤销令牌')}
          </Button>}
        </div>
      </li>)}
    </ul>}
  </div>;
}
