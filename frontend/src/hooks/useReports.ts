import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
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
  start_datetime: string;
  end_datetime: string;
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

export function useReports(filters: { date?: string } = {}): UseQueryResult<Paginated<Report>> {
  return useQuery({
    queryKey: ['reports', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.date) {
        params.append('date', filters.date);
      }
      const response = await api.get<Paginated<Report>>(`/reports/?${params.toString()}`);
      return response.data;
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function useAllReports(): UseQueryResult<Report[]> {
  return useQuery({
    queryKey: ['reports', 'all'],
    queryFn: async () => {
      const all: Report[] = [];
      let url: string | null = '/reports/';

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
        const response = await api.get<Paginated<Report>>(url);
        const page: Paginated<Report> = response.data;
        all.push(...page.results);
        url = page.next ? rel(page.next) : null;
      }
      return all;
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function useReportDates() {
  return useQuery({
    queryKey: ['report-dates'],
    queryFn: async () => {
      const response = await api.get<string[]>('/reports/dates/');
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

export function useReportSummary(date?: string): UseQueryResult<Summary> {
  return useQuery({
    queryKey: ['reports-summary', date],
    queryFn: async () => {
      const { data } = await api.get<Summary>(`/reports/summary/`, {
        params: date ? { date } : {},
      });
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });
} 
