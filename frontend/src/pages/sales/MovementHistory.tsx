import { Fragment, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useLang } from '../../i18n';
import api from '../../lib/api';
import { historyFilters, validHistoryFilters, historyTime, quantity, businessDate, offsetDate } from '../../domains/inventory/movement-history';
import type { HistoryFilters } from '../../domains/inventory/movement-history';

const labels = {
  ko: {
    title: '입·출고 이력', description: '기간과 모델별로 완성품 창고의 입고·출고 흐름을 조회합니다.',
    expand: '번호별 보기', collapse: '접기', identifier: 'MES 식별번호(물류·대차)', trolley: '대차번호', label: '라벨번호', missing: '번호 없음', identifiers: '식별번호', missingDates: '미수집 날짜', pendingDates: '마감 전 날짜', events: '시간순 내역', both: '일별 행은 입고·출고를 함께 표시합니다.',
    modelColumn: '모델', start: '시작일', end: '종료일', model: '모델 검색', placeholder: '모델 코드·이름·규격',
    direction: '입출고 구분', all: '전체', in: '입고', out: '출고', ordering: '정렬',
    asc: '오래된 순', desc: '최신 순', search: '조회', week: '최근 7일', month: '최근 30일',
    invalid: '유효한 날짜를 최대 366일 범위로 선택하고 검색어를 100자 이내로 입력해 주세요.',
    source: '완성품 창고 · 마감일 기준 상하이 08:00~다음 날 08:00. 행을 펼치면 번호별 입·출고를 볼 수 있습니다.',
    updated: '최근 수집 시각',
    quantity: '구분·수량', action: '작업 유형', batch: '배치', operator: '담당자', unknown: '방향 미확인', rangeError: '조회량이 많습니다. 기간을 줄여 다시 조회해 주세요.', expired: 'MES 이력이 갱신되었습니다. 처음부터 다시 조회해 주세요.',
    period: '기준일', unit: '단위', net: '순변동',
    rows: '일별·모델별 항목', shown: '표시', total: '수집된 이력 합계', more: '이어서 보기', loading: '불러오는 중…',
    error: '입·출고 이력을 불러오지 못했습니다.', retry: '다시 시도', empty: '조건에 맞는 입출고 이력이 없습니다.',
  },
  zh: {
    title: '出入库履历', description: '按期间及型号查看成品仓库的出入库变化。',
    expand: '查看编号', collapse: '收起', identifier: 'MES标识码（物流·台车）', trolley: '台车号', label: '标签号', missing: '无编号', identifiers: '标识码', missingDates: '未采集日期', pendingDates: '未结束日期', events: '按时间查看', both: '每日行同时显示入库和出库。',
    modelColumn: '型号', start: '开始日期', end: '结束日期', model: '型号搜索', placeholder: '型号编码·名称·规格',
    direction: '出入库类型', all: '全部', in: '入库', out: '出库', ordering: '排序',
    asc: '从早到晚', desc: '从新到旧', search: '查询', week: '最近7天', month: '最近30天',
    invalid: '请选择有效日期，范围不超过366天，搜索词不超过100字。',
    source: '成品仓库 · 已结束业务日：上海08:00至次日08:00。展开查看各编号的出入库。',
    updated: '最近采集时间',
    quantity: '类型·数量', action: '操作类型', batch: '批次', operator: '操作人', unknown: '方向不明', rangeError: '查询数据过多，请缩短日期范围后重试。', expired: 'MES记录已更新，请从头重新查询。',
    period: '业务日期', unit: '单位', net: '净变化',
    rows: '日期·型号项目', shown: '已显示', total: '已采集记录合计', more: '继续查看', loading: '加载中…',
    error: '出入库履历加载失败。', retry: '重试', empty: '没有符合条件的出入库记录。',
  },
};
type Text = typeof labels['ko'];
type Amounts = { unit: string; total_in: string; total_out: string; net_change: string };
type HistoryRow = Amounts & {
  id: number; business_date: string; material_code: string; material_name: string; specification: string;
  warehouse_name: string; identifier_count: number; missing_identifier_count: number; revision: number;
};
type IdentifierRow = {
  qr_code: string; trolley_code: string; label_code: string; total_in: string; total_out: string;
  first_at: string; last_at: string;
  events: { id: string; occurred_at: string; direction: 'in' | 'out'; quantity: string; action_label: string; storage_location: string; batch_no: string }[];
};
interface HistoryPage {
  count: number; page: number; page_size: number; totals: Amounts[]; snapshot_token: string;
  source: { fetched_at: string | null; missing_dates: string[]; pending_dates: string[]; business_day: string };
  results: HistoryRow[];
}

const fieldClass = 'min-w-0 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500';
const buttonClass = 'rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50';

function FilterForm({ initial, text, apply }: { initial: HistoryFilters; text: Text; apply: (filters: HistoryFilters) => void }) {
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const change = (key: keyof HistoryFilters, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  return <form className="rounded-lg border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-4 space-y-3" onSubmit={event => {
    event.preventDefault();
    if (!validHistoryFilters(draft)) { setInvalid(true); return; }
    setInvalid(false);
    apply({ ...draft, search: draft.search.trim() });
  }}>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
      <label className="min-w-0 space-y-1 text-sm">{text.start}<input aria-label={text.start} type="date" required value={draft.start_date} onChange={e => change('start_date', e.target.value)} className={fieldClass} /></label>
      <label className="min-w-0 space-y-1 text-sm">{text.end}<input aria-label={text.end} type="date" required value={draft.end_date} onChange={e => change('end_date', e.target.value)} className={fieldClass} /></label>
      <label className="min-w-0 col-span-2 space-y-1 text-sm">{text.model}<input aria-label={text.model} type="search" value={draft.search} maxLength={100} placeholder={text.placeholder} onChange={e => change('search', e.target.value)} className={fieldClass} /></label>
      <label className="min-w-0 space-y-1 text-sm">{text.direction}<select aria-label={text.direction} value={draft.direction} onChange={e => change('direction', e.target.value)} className={fieldClass}>
        <option value="all">{text.all}</option><option value="in">{text.in}</option><option value="out">{text.out}</option>
      </select></label>
      <label className="min-w-0 space-y-1 text-sm">{text.ordering}<select aria-label={text.ordering} value={draft.ordering} onChange={e => change('ordering', e.target.value)} className={fieldClass}>
        <option value="asc">{text.asc}</option><option value="desc">{text.desc}</option>
      </select></label>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="submit" className="rounded-md bg-[var(--wj-accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--wj-on-accent)] hover:bg-[var(--wj-accent-strong)] focus-visible:outline-2 focus-visible:outline-blue-600">{text.search}</button>
      {[7, 30].map(days => <button key={days} type="button" className={buttonClass} onClick={() => {
        const end = offsetDate(businessDate(), -1);
        setDraft(previous => ({ ...previous, start_date: offsetDate(end, 1 - days), end_date: end }));
      }}>{days === 7 ? text.week : text.month}</button>)}
    </div>
    {invalid && <p role="alert" className="text-sm text-[var(--wj-danger)]">{text.invalid}</p>}
  </form>;
}

function IdentifierDetails({ row, direction, text }: { row: HistoryRow; direction: HistoryFilters['direction']; text: Text }) {
  const query = useQuery({
    queryKey: ['finished-goods-history-detail', row.id, direction],
    queryFn: async ({ signal }) => (await api.get<{ id: number; results: IdentifierRow[] }>(`/inventory/finished-goods/history/${row.id}/`, { params: { direction }, signal })).data,
    retry: false,
  });
  if (query.isPending) return <p role="status" className="p-4">{text.loading}</p>;
  if (query.isError) return <div role="alert" className="p-4 text-[var(--wj-danger)]">{text.error} <button type="button" className={buttonClass} onClick={() => query.refetch()}>{text.retry}</button></div>;
  return <div className="p-3 space-y-2" data-testid="identifier-details">
    <p className="font-semibold">{text.identifier} · {row.unit}</p>
    {query.data.results.map((item, index) => <details key={index} className="rounded border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] px-3 py-2">
      <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600">
        <span className="inline-flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <strong>{item.qr_code || item.trolley_code || item.label_code || text.missing}</strong>
          {item.trolley_code && <span>{text.trolley}: {item.trolley_code}</span>}
          {item.label_code && <span>{text.label}: {item.label_code}</span>}
          <span className="text-[var(--wj-success)]">{text.in} {quantity(item.total_in)}</span>
          <span className="text-[var(--wj-danger)]">{text.out} {quantity(item.total_out)}</span>
          <span className="text-[var(--wj-muted)]">{text.events}</span>
        </span>
      </summary>
      <table className="mt-3 w-full text-sm"><thead className="text-[var(--wj-muted)]"><tr>
        {[text.quantity, text.events, text.action, text.batch].map(title => <th key={title} scope="col" className="p-2 text-left font-medium">{title}</th>)}
      </tr></thead><tbody>{item.events.map(event => <tr key={event.id} className="border-t border-[var(--wj-border)]">
        <td className={`p-2 tabular-nums ${event.direction === 'in' ? 'text-[var(--wj-success)]' : 'text-[var(--wj-danger)]'}`}>{text[event.direction]} {quantity(event.quantity)} {row.unit}</td>
        <td className="p-2">{historyTime(event.occurred_at)}</td>
        <td className="p-2">{event.action_label || '—'}{event.storage_location && ` · ${event.storage_location}`}</td>
        <td className="p-2">{event.batch_no || '—'}</td>
      </tr>)}</tbody></table>
    </details>)}
  </div>;
}

function DailyRows({ rows, text, direction }: { rows: HistoryRow[]; text: Text; direction: HistoryFilters['direction'] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return <tbody className="divide-y divide-[var(--wj-border)]">{rows.map(row => <Fragment key={row.id}>
    <tr className="hover:bg-[var(--wj-surface-solid)]" data-testid="daily-row">
      <td className="px-4 py-3"><button type="button" aria-expanded={expanded.has(row.id)} aria-controls={`history-detail-${row.id}`} aria-label={`${expanded.has(row.id) ? text.collapse : text.expand} ${row.business_date} ${row.material_code}`} className={buttonClass} onClick={() => setExpanded(previous => {
        const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next;
      })}>{expanded.has(row.id) ? '−' : '+'}</button></td>
      <td className="px-4 py-3">{row.business_date}<div className="text-[var(--wj-muted)]">{row.warehouse_name}</div></td>
      <td className="px-4 py-3"><div className="font-medium">{row.material_code}</div><div className="text-[var(--wj-muted)]">{[row.material_name, row.specification].filter(Boolean).join(' · ')}</div></td>
      <td className="px-4 py-3 text-right tabular-nums font-semibold text-[var(--wj-success)]">{quantity(row.total_in)}</td>
      <td className="px-4 py-3 text-right tabular-nums font-semibold text-[var(--wj-danger)]">{quantity(row.total_out)}</td>
      <td className="px-4 py-3">{row.unit || '—'}</td>
      <td className="px-4 py-3 text-right tabular-nums">{row.identifier_count}{row.missing_identifier_count > 0 && <div className="text-[var(--wj-muted)]">{text.missing}: {row.missing_identifier_count}</div>}</td>
    </tr>
    {expanded.has(row.id) && <tr><td colSpan={7} id={`history-detail-${row.id}`} className="bg-[var(--wj-surface-solid)]"><IdentifierDetails row={row} text={text} direction={direction} /></td></tr>}
  </Fragment>)}</tbody>;
}

export default function MovementHistoryPage() {
  const { lang } = useLang();
  const text = labels[lang];
  const [params, setParams] = useSearchParams();
  const filters = historyFilters(params);
  const valid = validHistoryFilters(filters);
  const query = useInfiniteQuery({
    queryKey: ['finished-goods-history', filters],
    initialPageParam: { page: 1, snapshot_token: '' },
    enabled: valid,
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.get<HistoryPage>('/inventory/finished-goods/history/', { params: { ...filters, ...pageParam, page_size: 50 }, signal });
      return response.data;
    },
    getNextPageParam: page => page.page * page.page_size < page.count ? { page: page.page + 1, snapshot_token: page.snapshot_token } : undefined,
    retry: false,
  });
  const data = query.data?.pages[0];
  const rows = query.data?.pages.flatMap(page => page.results) ?? [];
  const errorCode = (query.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  const apply = (next: HistoryFilters) => setParams(new URLSearchParams({ ...next }));
  return <main className="p-4 md:p-6 space-y-4 text-[var(--wj-text)]">
    <div><h1 className="text-2xl font-semibold">{text.title}</h1><p className="mt-1 text-sm text-[var(--wj-muted)]">{text.description}</p></div>
    <FilterForm key={JSON.stringify(filters)} initial={filters} text={text} apply={apply} />
    <p className="text-sm text-[var(--wj-muted)]">{text.source}</p>
    {!valid && <p role="alert" className="text-sm text-[var(--wj-danger)]">{text.invalid}</p>}
    {valid && query.isPending && <p role="status" className="rounded-lg border bg-[var(--wj-surface-solid)] p-6 text-center">{text.loading}</p>}
    {query.isError && <div role="alert" className="rounded-lg border border-[var(--wj-danger-border)] bg-[var(--wj-surface-solid)] p-4 text-sm text-[var(--wj-danger)]">
      {errorCode === 'history_range_too_large' ? text.rangeError : errorCode === 'history_query_expired' ? text.expired : text.error} <button type="button" className={buttonClass} onClick={() => query.isFetchNextPageError && errorCode !== 'history_query_expired' ? query.fetchNextPage() : query.refetch()}>{text.retry}</button>
    </div>}
    {valid && data && <>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-[var(--wj-muted)]" aria-live="polite">
        <span>{text.updated}: {historyTime(data.source.fetched_at)}</span>
      </div>
      {data.source.missing_dates.length > 0 && <details className="rounded-lg border border-[var(--wj-warning-border)] bg-[var(--wj-surface-solid)] p-3 text-sm text-[var(--wj-warning)]"><summary className="cursor-pointer">{text.missingDates}: {data.source.missing_dates.length}</summary><p className="mt-2 break-words">{data.source.missing_dates.join(', ')}</p></details>}
      {data.source.pending_dates.length > 0 && <details className="text-sm text-[var(--wj-muted)]"><summary className="cursor-pointer">{text.pendingDates}: {data.source.pending_dates.length}</summary><p className="mt-2 break-words">{data.source.pending_dates.join(', ')}</p></details>}
      {data.totals.length > 0 && <section aria-label={text.total} className="rounded-lg border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-4">
        <h2 className="mb-2 text-sm font-semibold">{text.total}{filters.direction !== 'all' && ` · ${text[filters.direction]}`}</h2>
        {data.totals.map(total => <div key={total.unit} className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
          <span className="font-semibold">{total.unit || '—'}</span>
          <span>{text.in}: <strong className="text-[var(--wj-success)]">{quantity(total.total_in)}</strong></span>
          <span>{text.out}: <strong className="text-[var(--wj-danger)]">{quantity(total.total_out)}</strong></span>
          <span>{text.net}: <strong>{quantity(total.net_change)}</strong></span>
        </div>)}
      </section>}
      {filters.direction !== 'all' && <p className="text-sm text-[var(--wj-muted)]">{text.both}</p>}
      <section className="overflow-hidden rounded-lg border border-[var(--wj-border)] bg-[var(--wj-surface-solid)]">
        <div className="border-b px-4 py-3 text-sm">{text.rows}: <strong>{data.count.toLocaleString()}</strong> · {text.shown}: {rows.length.toLocaleString()}</div>
        {rows.length === 0 ? <p className="p-8 text-center text-sm text-[var(--wj-muted)]">{text.empty}</p> : <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={text.title}>
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-[var(--wj-surface-solid)] text-[var(--wj-muted)]"><tr>
              {[text.expand, text.period, text.modelColumn, text.in, text.out, text.unit, text.identifiers].map((title, i) => <th key={title} scope="col" className={`px-4 py-3 font-semibold ${[3, 4, 6].includes(i) ? 'text-right' : 'text-left'}`}>{title}</th>)}
            </tr></thead>
            <DailyRows key={JSON.stringify(filters)} rows={rows} text={text} direction={filters.direction} />
          </table>
        </div>}
        {query.hasNextPage && <div className="p-4 text-center"><button type="button" className={buttonClass} disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? text.loading : text.more}</button></div>}
      </section>
    </>}
  </main>;
}
