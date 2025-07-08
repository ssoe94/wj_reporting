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
  part_no: string;
  note: string;
  machine_no: number;
  start_datetime: string;
  end_datetime: string;
  // ...필드 계속
}

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export function useReports(): UseQueryResult<Report[]> {
  return useQuery({
    queryKey: ['reports'],
    queryFn: async () => {
      const { data } = await api.get<Paginated<Report>>('/reports/');
      return data.results;
    },
    staleTime: 1000 * 60 * 5, // 5분
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