import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import api from '@/lib/api';

export interface Report {
  id: number;
  date: string;      // 'YYYY-MM-DD'
  tonnage: string;   // '850T'
  model: string;
  section: string;
  plan_qty: number;
  actual_qty: number;
  reported_defect: number;
  actual_defect: number;
  operation_time: number;
  total_time: number;
  idle_time?: number; // optional: may be derived or stored
  part_no: string;
  note: string;
  machine_no: number;
  start_datetime: string | null;
  end_datetime: string | null;
  achievement_rate?: number; // optional calculated field
  cycle_time_deviation?: number | null; // optional analytics field
  // ...필드 계속
}

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

const emptyPage = <T,>(): Paginated<T> => ({
  count: 0,
  next: null,
  previous: null,
  results: [],
});

const normalizePage = <T,>(value: unknown): Paginated<T> => {
  if (Array.isArray(value)) {
    return { ...emptyPage<T>(), count: value.length, results: value as T[] };
  }

  if (value && typeof value === 'object') {
    const page = value as Partial<Paginated<T>>;
    if (Array.isArray(page.results)) {
      return {
        count: typeof page.count === 'number' ? page.count : page.results.length,
        next: typeof page.next === 'string' ? page.next : null,
        previous: typeof page.previous === 'string' ? page.previous : null,
        results: page.results,
      };
    }
  }

  throw new Error('Invalid injection report response');
};

export function useReports(filters: { date?: string; machineNo?: number | null } = {}): UseQueryResult<Paginated<Report>> {
  return useQuery({
    queryKey: ['reports', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.date) {
        params.append('date', filters.date);
      }
      if (filters.machineNo != null) params.append('machine_no', String(filters.machineNo));
      const results: Report[] = [];
      let url: string | null = `/injection/reports/?${params.toString()}`;
      const visited = new Set<string>();
      while (url) {
        if (visited.has(url)) throw new Error('Repeated injection report page');
        visited.add(url);
        const response: AxiosResponse<Paginated<Report>> = await api.get(url);
        const page = normalizePage<Report>(response.data);
        if (page.results.some(row => (filters.date && row.date !== filters.date)
          || (filters.machineNo != null && row.machine_no !== filters.machineNo))) {
          throw new Error('Injection reports do not match the requested scope');
        }
        results.push(...page.results);
        url = null;
        if (page.next) {
          const next = new URL(page.next, 'https://reports.invalid');
          const path = next.pathname.replace(/^\/api\//, '/');
          if (path !== '/injection/reports/') throw new Error('Invalid injection report page');
          if (filters.date) next.searchParams.set('date', filters.date);
          if (filters.machineNo != null) next.searchParams.set('machine_no', String(filters.machineNo));
          url = `${path}${next.search}`;
        }
      }
      return { count: results.length, next: null, previous: null, results };
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function useAllReports(): UseQueryResult<Report[]> {
  return useQuery({
    queryKey: ['reports', 'all'],
    queryFn: async () => {
      const all: Report[] = [];
      let url: string | null = '/injection/reports/';

      const rel = (u: string) => {
        // Convert absolute links from the paginated API into relative /reports/ paths for the axios baseURL.
        if (u.startsWith('http')) {
          const obj = new URL(u);
          let p = obj.pathname + obj.search; // '/api/reports/?page=2'
          if (p.startsWith('/api/')) {
            p = p.replace('/api', ''); // '/reports/?page=2'
          }
          return p.startsWith('/') ? p : `/${p}`;
        }
        return u.startsWith('/') ? u : `/${u}`;
      };

      while (url) {
        const response: AxiosResponse<Paginated<Report>> = await api.get<Paginated<Report>>(url);
        const page: Paginated<Report> = normalizePage<Report>(response.data);
        all.push(...page.results);
        url = page.next ? rel(page.next) : null;
      }
      return all;
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function useReportDates(machineNo?: number | null) {
  return useQuery({
    queryKey: ['report-dates', machineNo ?? null],
    queryFn: async () => {
      const response = await api.get<string[]>('/injection/reports/dates/', {
        params: machineNo != null ? { machine_no: machineNo } : {},
      });
      if (!Array.isArray(response.data)) throw new Error('Invalid injection report dates');
      return response.data;
    },
    staleTime: 1000 * 60 * 5,
  });
}

export interface Summary {
  total_count: number;
  total_plan_qty: number;
  total_actual_qty: number;
  total_defect_qty: number;
  achievement_rate: number; // percentage
  defect_rate: number; // percentage
}

export function useReportSummary(date?: string, machineNo?: number | null): UseQueryResult<Summary> {
  return useQuery({
    queryKey: ['reports-summary', date, machineNo ?? null],
    queryFn: async () => {
      const { data } = await api.get<Summary>(`/injection/reports/summary/`, {
        params: { ...(date ? { date } : {}), ...(machineNo != null ? { machine_no: machineNo } : {}) },
      });
      if (!data || typeof data !== 'object' || ![
        data.total_count, data.total_plan_qty, data.total_actual_qty,
        data.total_defect_qty, data.achievement_rate, data.defect_rate,
      ].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
        throw new Error('Invalid injection report summary');
      }
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });
} 
