import { useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { downloadFieldEvents, fieldEvents } from '@/domains/field-monitoring/api';
import { clockMinutes, fieldDeviceText, fieldText, formatFieldTime } from '@/domains/field-monitoring/labels';
import type { Tx } from '@/domains/field-monitoring/labels';
import { FIELD_APPS, FIELD_MODES, FIELD_RESULTS, FIELD_TYPES } from '@/domains/field-monitoring/model';
import type { FieldEvent, FieldException, FieldFilterKey, FieldFilters, FieldOverviewStation, FieldOverviewSummary } from '@/domains/field-monitoring/model';

export const panelClass = 'rounded-lg border border-[var(--wj-border)] bg-[var(--wj-surface)]';
export const selectClass = 'ui-input block min-h-10 w-full min-w-0 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--wj-accent)]';
const muted = 'text-[var(--wj-muted)]';
const th = 'px-3 py-2.5 text-left font-semibold';

export function FieldNotice({ children, role = 'status' }: { children: React.ReactNode; role?: 'status' | 'alert' }) {
  return <div role={role} className={`${panelClass} p-4 text-sm ${role === 'alert' ? 'text-[var(--wj-danger)]' : muted}`}>{children}</div>;
}

export function FieldLoadError({ tx, retry }: { tx: Tx; retry: () => void }) {
  return <FieldNotice role="alert">
    <div className="flex flex-wrap items-center gap-3">
      <span>{tx('자료를 불러오지 못했습니다.', '无法加载资料。')}</span>
      <Button type="button" size="sm" variant="secondary" onClick={retry}>{tx('다시 시도', '重试')}</Button>
    </div>
  </FieldNotice>;
}

const tones = {
  success: 'border-[var(--wj-success-border)] bg-[var(--wj-success-bg)] text-[var(--wj-success)]',
  warning: 'border-[var(--wj-warning-border)] bg-[var(--wj-warning-bg)] text-[var(--wj-warning)]',
  danger: 'border-[var(--wj-danger-border)] bg-[var(--wj-danger-bg)] text-[var(--wj-danger)]',
  neutral: 'border-[var(--wj-border)] bg-[var(--wj-surface-muted)] text-[var(--wj-muted)]',
} as const;

export function FieldBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: keyof typeof tones }) {
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-sm font-medium ${tones[tone]}`}>{children}</span>;
}

function resultTone(result: string): keyof typeof tones {
  if (result === 'ok' || result === 'online' || result === 'connected') return 'success';
  if (result === 'error' || result === 'fault' || result === 'offline') return 'danger';
  if (result === 'ng' || result === 'stale' || result === 'disconnected') return 'warning';
  return 'neutral';
}

export function FieldStationSelect({ stations, value, onChange, tx }: {
  stations: Pick<FieldOverviewStation, 'station_id' | 'display_name'>[];
  value: string;
  onChange: (value: string) => void;
  tx: Tx;
}) {
  return <label className="block min-w-0 text-sm">
    <span className="mb-1 block font-medium">{tx('현장 PC', '现场电脑')}</span>
    <select className={selectClass} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{tx('전체 PC', '全部电脑')}</option>
      {value && !stations.some(station => station.station_id === value) && <option value={value}>{value}</option>}
      {stations.map(station => <option key={station.station_id} value={station.station_id}>
        {station.display_name} · {station.station_id}
      </option>)}
    </select>
  </label>;
}

function OverviewSummary({ summary, tx }: { summary: FieldOverviewSummary; tx: Tx }) {
  const items = [
    { label: tx('등록 PC', '已登记电脑'), value: summary.registered_pc_count },
    { label: tx('접속 중', '在线'), value: summary.online_pc_count },
    { label: tx('끊김/미접속', '断开/未连接'), value: summary.disconnected_pc_count },
    { label: tx('선택 업무일 예외', '所选业务日异常'), value: summary.exception_count,
      title: tx('선택 업무일의 예외와 현재 접속·장치 경고', '所选业务日的异常及当前连接和设备告警') },
  ];
  return <dl aria-label={tx('현황 요약', '状态摘要')} className={`${panelClass} flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 text-sm tabular-nums`}>
    {items.map(({ label, value, title }) => <div key={label} className="flex gap-1.5" title={title}>
      <dt className={muted}>{label}</dt><dd className="font-semibold">{value}</dd>
    </div>)}
  </dl>;
}

export function FieldOverviewView({ stations, summary, tx }: {
  stations: FieldOverviewStation[];
  summary: FieldOverviewSummary;
  tx: Tx;
}) {
  return <div className="grid gap-3">
    <OverviewSummary summary={summary} tx={tx} />
    {!stations.length && <FieldNotice>{tx('등록된 현장 PC가 없습니다.', '暂无已登记的现场电脑。')}</FieldNotice>}
    <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
      {stations.map(station => <StationOverviewCard key={station.station_id} station={station} tx={tx} />)}
    </div>
  </div>;
}

function StationOverviewCard({ station, tx }: { station: FieldOverviewStation; tx: Tx }) {
  return <article className={`${panelClass} min-w-0`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--wj-border)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-semibold">{station.display_name}</h2>
          <p className={`break-words text-sm ${muted}`}>
            {[station.station_id, station.location, station.line_note].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!station.enabled && <FieldBadge>{tx('사용 중지', '停用')}</FieldBadge>}
          <FieldBadge tone={resultTone(station.connection)}>{fieldText(station.connection, tx)}</FieldBadge>
        </div>
      </header>
      <div className="grid gap-3 p-4 text-sm">
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div><dt className={muted}>{tx('마지막 접속', '最后连接')}</dt><dd className="tabular-nums">{formatFieldTime(station.last_heartbeat_at)}</dd></div>
          <div>
            <dt className={muted}>{tx('미전송', '待发送')}</dt>
            <dd className="tabular-nums">
              {station.outbox
                ? `${station.outbox.pending_count ?? '—'} · ${fieldText(station.outbox.state, tx)}`
                : '—'}
            </dd>
            {station.outbox?.oldest_occurred_at && <dd className={muted}>
              {tx('가장 오래된 기록', '最早记录')} {formatFieldTime(station.outbox.oldest_occurred_at)}
            </dd>}
          </div>
        </dl>
        {station.warnings.length > 0 && <ul aria-label={tx('PC 경고', '电脑告警')} className="flex flex-wrap gap-2">
          {station.warnings.map(code => <li key={code}><FieldBadge tone="warning">
            {fieldText(code, tx)}
            {code === 'clock_offset' && station.clock_offset_seconds !== null
              ? ` ${clockMinutes(station.clock_offset_seconds)} ${tx('분', '分钟')}` : ''}
          </FieldBadge></li>)}
        </ul>}
        <div>
          <h3 className="mb-1.5 font-medium">{tx('앱과 마지막 작업', '程序与最后作业')}</h3>
          <ul className="divide-y divide-[var(--wj-border)]">
            {[...new Set([...station.apps, ...station.app_status.map(item => item.app)])].map(app => {
              const status = station.app_status.find(item => item.app === app);
              return <li key={app} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1.5">
                <span className="break-words">{fieldText(app, tx)}{status?.version ? ` · ${status.version}` : ''}</span>
                <span className={muted}>{status
                  ? [fieldText(status.state, tx), fieldText(status.mode, tx), formatFieldTime(status.last_work_at)].join(' · ')
                  : tx('상태 미수신', '尚未收到状态')}</span>
              </li>;
            })}
          </ul>
        </div>
        {station.devices.length > 0 && <div>
          <h3 className="mb-1 font-medium">{tx('장치와 마지막 실제 입력', '设备与最后实际输入')}</h3>
          <ul className="divide-y divide-[var(--wj-border)]">
            {station.devices.map(item => <li key={`${item.app}/${item.device}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
              <span className="break-words">{fieldText(item.app, tx)} · <span title={item.device}>{fieldDeviceText(item.device, tx)}</span></span>
              <span className={`flex flex-wrap items-center gap-2 ${muted}`}>
                {formatFieldTime(item.last_input_at)}
                <FieldBadge tone={resultTone(item.state)}>{fieldText(item.state, tx)}</FieldBadge>
              </span>
            </li>)}
          </ul>
        </div>}
        <div className="border-t border-[var(--wj-border)] pt-2">
          <h3 className="mb-1.5 font-medium">{tx('앱별 기록 · 선택 업무일', '各程序记录 · 所选业务日')}</h3>
          <ul className="divide-y divide-[var(--wj-border)]">
            {station.app_counts.map(app => <li key={app.app} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1.5">
              <span className="break-words">{fieldText(app.app, tx)}</span>
              <dl className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                {FIELD_RESULTS.map(result => <div key={result} className="flex gap-1">
                  <dt className={muted}>{fieldText(result, tx)}</dt><dd className="font-semibold">{app.production_counts[result]}</dd>
                </div>)}
                <div className="flex gap-1"><dt className={muted}>{tx('비생산', '非生产')}</dt><dd>{app.non_production_count}</dd></div>
              </dl>
            </li>)}
          </ul>
        </div>
      </div>
  </article>;
}

export function FieldExceptionsView({ rows, onSearch, tx }: {
  rows: FieldException[];
  onSearch: (row: FieldException) => void;
  tx: Tx;
}) {
  if (!rows.length) return <FieldNotice>{tx('선택한 범위에서 확인된 예외가 없습니다.', '所选范围内无已识别的异常。')}</FieldNotice>;
  return <ul className={`${panelClass} divide-y divide-[var(--wj-border)]`}>
    {rows.map((row, index) => <li key={`${row.station_id}/${row.reason}/${index}`}>
      <button type="button" className="grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto] gap-2 px-4 py-2 text-left hover:bg-[var(--wj-surface-muted)] focus-visible:outline-2 focus-visible:outline-[var(--wj-accent)] focus-visible:outline-offset-[-2px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" onClick={() => onSearch(row)}>
        <span className="min-w-0 break-words text-sm font-semibold">
          {fieldText(row.reason, tx)}
          {(row.filters.job_id || row.filters.cycle_id) && <span className={`mt-1 block break-all font-mono font-normal ${muted}`}>
            {row.filters.job_id || row.filters.cycle_id}
          </span>}
        </span>
        <span className={`row-start-2 min-w-0 break-words text-sm ${muted} sm:row-start-auto`}>
          <span className="block">{row.display_name} · {row.station_id}</span>
          <span className="block">
            {row.filters.app ? fieldText(row.filters.app, tx) : tx('PC 공통', '电脑通用')}
            {row.filters.mode && row.filters.mode !== 'production' && ` · ${fieldText(row.filters.mode, tx)}`}
          </span>
        </span>
        <span className="col-start-2 row-start-1 tabular-nums text-sm sm:col-start-auto sm:row-start-auto">
          {row.count} <span className={muted}>{tx('건', '条')}</span> <span aria-hidden>›</span>
        </span>
      </button>
    </li>)}
  </ul>;
}

function TextFilter({ label, value, onChange, maxLength = 128 }: {
  label: string; value: string; onChange: (value: string) => void; maxLength?: number;
}) {
  return <label className="block min-w-0 text-sm">
    <span className="mb-1 block font-medium">{label}</span>
    <Input className="min-h-10" value={value} onChange={event => onChange(event.target.value)} maxLength={maxLength} autoComplete="off" />
  </label>;
}

function SelectFilter({ label, value, onChange, options, tx }: {
  label: string; value: string; onChange: (value: string) => void; options: readonly string[]; tx: Tx;
}) {
  return <label className="block min-w-0 text-sm">
    <span className="mb-1 block font-medium">{label}</span>
    <select className={selectClass} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{tx('전체', '全部')}</option>
      {value && !options.includes(value) && <option value={value}>{fieldText(value, tx)}</option>}
      {options.map(code => <option key={code} value={code}>{fieldText(code, tx)}</option>)}
    </select>
  </label>;
}

async function csvErrorText(error: unknown, tx: Tx) {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const payload = JSON.parse(await error.response.data.text());
      if (payload.code === 'csv_limit_exceeded') {
        return tx('CSV는 최대 10,000건입니다. 기간이나 필터 범위를 줄여 주세요.', 'CSV 最多 10,000 条。请缩小日期或筛选范围。');
      }
    } catch {
      // Render a localized error without exposing server response content.
    }
  }
  return tx('CSV를 내려받지 못했습니다.', '无法下载 CSV。');
}

function FieldEventTime({ row, tx }: { row: FieldEvent; tx: Tx }) {
  return <div className="tabular-nums">
    <div>{formatFieldTime(row.occurred_at)}</div>
    {row.clock_suspect && <FieldBadge tone="warning">{tx('시계 이상 · 집계 보류', '时钟异常 · 暂缓汇总')}</FieldBadge>}
    <div className={muted}>{tx('수신', '接收')} {formatFieldTime(row.received_at)}</div>
  </div>;
}

function FieldEventOutcome({ row, tx }: { row: FieldEvent; tx: Tx }) {
  return <div>
    <FieldBadge tone={resultTone(row.result)}>{fieldText(row.result, tx)}</FieldBadge>
    <div className="break-words">{fieldText(row.reason, tx)}</div>
    {row.detail?.seen_before_reset === true &&
      <FieldBadge tone="warning">{fieldText('barcode_seen_before_reset', tx)}</FieldBadge>}
    {row.status_raw && <div className={`break-words ${muted}`}>{tx('원천', '原始')} {row.status_raw}</div>}
  </div>;
}

function FieldEventIdentifiers({ row }: { row: FieldEvent }) {
  const refs = [...new Set([row.ref?.job_id, row.ref?.cycle_id, row.ref?.pair_id, row.ref?.batch_id, row.ref?.capture_id].filter((id): id is string => typeof id === 'string'))];
  return <div className="break-all font-mono">
    {row.barcode && <div>{row.barcode}</div>}
    {refs.length > 0 && <div className={muted}>{refs.join(' · ')}</div>}
    {(row.serial || row.part_no) && <div className={muted}>{[row.serial, row.part_no].filter(Boolean).join(' · ')}</div>}
    {!row.barcode && refs.length === 0 && !row.serial && !row.part_no && '—'}
  </div>;
}

export function FieldRecordsView({ tx, stations, applied, onApply, authSessionId }: {
  tx: Tx;
  stations: FieldOverviewStation[];
  applied: FieldFilters;
  onApply: (filters: FieldFilters) => void;
  authSessionId: string | null;
}) {
  const [draft, setDraft] = useState(applied);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['field-monitoring', authSessionId, 'events', applied],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => fieldEvents(applied, pageParam, { authSessionId, signal }),
    getNextPageParam: page => page.next_cursor || undefined,
    retry: false,
  });
  const rows = query.data?.pages.flatMap(page => page.results) ?? [];
  const update = (key: FieldFilterKey) => (value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const invalidDates = !draft.from || !draft.to || draft.from > draft.to;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalidDates) return;
    setDownloadError('');
    onApply(draft);
    if (JSON.stringify(draft) === JSON.stringify(applied)) void query.refetch();
  }

  async function download() {
    setDownloading(true);
    setDownloadError('');
    try {
      await downloadFieldEvents(applied, { authSessionId });
    } catch (error) {
      setDownloadError(await csvErrorText(error, tx));
    } finally {
      setDownloading(false);
    }
  }

  const label = tx('현장 기록', '现场记录');
  return <div className="grid min-w-0 gap-3">
    <form className={`${panelClass} grid grid-cols-2 gap-3 p-3 md:grid-cols-4`} onSubmit={submit}>
      <label className="block min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('시작 업무일', '开始业务日')}</span>
        <Input type="date" className="min-h-10" required value={draft.from} onChange={event => update('from')(event.target.value)} />
      </label>
      <label className="block min-w-0 text-sm"><span className="mb-1 block font-medium">{tx('종료 업무일', '结束业务日')}</span>
        <Input type="date" className="min-h-10" required value={draft.to} min={draft.from} onChange={event => update('to')(event.target.value)} />
      </label>
      <FieldStationSelect stations={stations} value={draft.station ?? ''} onChange={update('station')} tx={tx} />
      <SelectFilter tx={tx} options={FIELD_APPS} label={tx('앱', '程序')} value={draft.app ?? ''} onChange={update('app')} />
      <SelectFilter tx={tx} options={FIELD_TYPES} label={tx('이벤트', '事件')} value={draft.type ?? ''} onChange={update('type')} />
      <SelectFilter tx={tx} options={FIELD_RESULTS} label={tx('결과', '结果')} value={draft.result ?? ''} onChange={update('result')} />
      <SelectFilter tx={tx} options={FIELD_MODES} label={tx('모드', '模式')} value={draft.mode ?? ''} onChange={update('mode')} />
      <TextFilter label={tx('사유 코드', '原因代码')} value={draft.reason ?? ''} onChange={update('reason')} maxLength={64} />
      <TextFilter label={tx('바코드', '条码')} value={draft.barcode ?? ''} onChange={update('barcode')} maxLength={256} />
      <TextFilter label={tx('시리얼', '序列号')} value={draft.serial ?? ''} onChange={update('serial')} />
      <TextFilter label={tx('품번', '料号')} value={draft.part_no ?? ''} onChange={update('part_no')} />
      <TextFilter label={tx('작업 ID', '作业 ID')} value={draft.job_id ?? ''} onChange={update('job_id')} />
      <TextFilter label={tx('사이클 ID', '周期 ID')} value={draft.cycle_id ?? ''} onChange={update('cycle_id')} />
      <label className="flex min-h-10 items-center gap-2 self-end text-sm">
        <input type="checkbox" checked={draft.seen_before_reset === 'true'}
          onChange={event => update('seen_before_reset')(event.target.checked ? 'true' : '')} />
        {fieldText('barcode_seen_before_reset', tx)}
      </label>
      <div className="flex flex-wrap items-center gap-2 col-span-2 md:col-span-4">
        <Button type="submit" disabled={invalidDates}>{tx('검색', '查询')}</Button>
        <Button type="button" variant="secondary" disabled={downloading || query.isPending || query.isError} onClick={download}>
          {downloading ? tx('CSV 준비 중', '正在准备 CSV') : tx('CSV 내려받기', '下载 CSV')}
        </Button>
        <span className={`text-sm ${muted}`}>
          {tx('업무일은 상하이 08:00부터입니다. CSV는 마지막으로 검색한 조건을 사용합니다.', '业务日从上海时间 08:00 开始。CSV 使用上一次查询条件。')}
        </span>
      </div>
    </form>
    {downloadError && <FieldNotice role="alert">{downloadError}</FieldNotice>}
    {query.isPending && <FieldNotice>{tx('기록을 불러오는 중입니다.', '正在加载记录。')}</FieldNotice>}
    {query.isError && <FieldLoadError tx={tx} retry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} />}
    {query.isSuccess && rows.length === 0 && <FieldNotice>{tx('조건에 맞는 기록이 없습니다.', '没有符合条件的记录。')}</FieldNotice>}
    {rows.length > 0 && <>
      <ul aria-label={label} className="grid gap-2 text-sm md:hidden">
        {rows.map(row => <li key={row.id} className={`${panelClass} min-w-0 p-3`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <strong className="break-words">{fieldText(row.app, tx)} · {fieldText(row.type, tx)}</strong>
            <span className={muted}>{row.station_id} · {fieldText(row.mode, tx)}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <FieldEventTime row={row} tx={tx} />
            <FieldEventOutcome row={row} tx={tx} />
          </div>
          <div className="mt-2 border-t border-[var(--wj-border)] pt-2"><FieldEventIdentifiers row={row} /></div>
        </li>)}
      </ul>
      <div className={`${panelClass} hidden min-w-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-[var(--wj-accent)] md:block`} role="region" aria-label={label} tabIndex={0}>
        <table className="w-full min-w-[960px] table-auto text-left text-sm">
          <caption className="sr-only">{label}</caption>
          <thead className="bg-[var(--wj-surface-muted)]">
            <tr>
              {[
                tx('발생 시각 (UTC+8)', '发生时间 (UTC+8)'), tx('현장 PC', '现场电脑'), tx('앱·이벤트', '程序与事件'),
                tx('결과·사유', '结果与原因'), tx('모드', '模式'), tx('바코드·시리얼·품번', '条码、序列号与料号'),
              ].map(value => <th key={value} scope="col" className={th}>{value}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wj-border)]">
            {rows.map(row => <tr key={row.id}>
              <td className="px-3 py-2.5"><FieldEventTime row={row} tx={tx} /></td>
              <td className="max-w-48 break-words px-3 py-2.5">{row.station_id}</td>
              <td className="px-3 py-2.5">
                <div>{fieldText(row.app, tx)}</div><div className={muted}>{fieldText(row.type, tx)}</div>
              </td>
              <td className="px-3 py-2.5"><FieldEventOutcome row={row} tx={tx} /></td>
              <td className="px-3 py-2.5">{fieldText(row.mode, tx)}</td>
              <td className="max-w-96 px-3 py-2.5"><FieldEventIdentifiers row={row} /></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </>}
    {query.hasNextPage && <div><Button type="button" variant="secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
      {query.isFetchingNextPage ? tx('불러오는 중', '正在加载') : tx('더 보기', '加载更多')}
    </Button></div>}
  </div>;
}
