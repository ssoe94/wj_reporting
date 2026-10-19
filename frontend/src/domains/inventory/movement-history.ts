export interface HistoryFilters {
  start_date: string;
  end_date: string;
  search: string;
  direction: 'all' | 'in' | 'out';
  ordering: 'asc' | 'desc';
}

export function businessDate(now = new Date()): string {
  // Shifting eight hours makes the Shanghai business boundary local midnight.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now.getTime() - 8 * 3600000));
  const part = (type: string) => parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function offsetDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

export function historyFilters(params: URLSearchParams, now = new Date()): HistoryFilters {
  const end = offsetDate(businessDate(now), -1);
  return {
    start_date: params.get('start_date') ?? offsetDate(end, -6),
    end_date: params.get('end_date') ?? end,
    search: params.get('search') ?? '',
    direction: (params.get('direction') ?? 'all') as HistoryFilters['direction'],
    ordering: (params.get('ordering') ?? 'asc') as HistoryFilters['ordering'],
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value !== '9999-12-31';
}

export function validHistoryFilters(filters: HistoryFilters): boolean {
  if (!validDate(filters.start_date) || !validDate(filters.end_date)) return false;
  const days = (Date.parse(filters.end_date) - Date.parse(filters.start_date)) / 86400000;
  return days >= 0 && days < 366 && filters.search.trim().length <= 100
    && ['all', 'in', 'out'].includes(filters.direction)
    && ['asc', 'desc'].includes(filters.ordering);
}

export function quantity(value: string): string {
  // Preserve the API's decimal precision, including totals above Number.MAX_SAFE_INTEGER.
  const [whole, fraction] = value.split('.');
  const trimmed = (fraction ?? '').replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (trimmed ? `.${trimmed}` : '');
}

export function historyTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
}
