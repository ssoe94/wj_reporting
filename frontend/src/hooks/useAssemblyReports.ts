import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  AssemblyReport,
  AssemblyReportFilters,
  AssemblyReportSummary,
  AssemblyReportListResponse
} from '../types/assembly';

const emptyAssemblyPage = (): AssemblyReportListResponse => ({
  count: 0,
  next: null,
  previous: null,
  results: [],
});

const normalizeAssemblyPage = (value: unknown): AssemblyReportListResponse => {
  if (Array.isArray(value)) {
    return { ...emptyAssemblyPage(), count: value.length, results: value };
  }

  if (value && typeof value === 'object') {
    const page = value as Partial<AssemblyReportListResponse>;
    if (Array.isArray(page.results)) {
      return {
        count: typeof page.count === 'number' ? page.count : page.results.length,
        next: typeof page.next === 'string' ? page.next : null,
        previous: typeof page.previous === 'string' ? page.previous : null,
        results: page.results,
      };
    }
  }

  return emptyAssemblyPage();
};

export const useAssemblyReports = (filters: AssemblyReportFilters = {}) => {
  return useQuery<AssemblyReportListResponse>({
    queryKey: ['assembly-reports', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          params.append(key, value.toString());
        }
      });

      const response = await api.get<AssemblyReportListResponse>(`/assembly/reports/?${params}`);
      return normalizeAssemblyPage(response.data);
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
};

export const useAssemblyReportsTrendData = () => {
  return useQuery<AssemblyReport[]> ({
    queryKey: ['assembly-reports-trend-data'],
    queryFn: async () => {
      const response = await api.get<AssemblyReport[]>('/assembly/reports/trend-data/');
      return Array.isArray(response.data) ? response.data : [];
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
};

export const useAssemblyReportDates = () => {
  return useQuery({
    queryKey: ['assembly-report-dates'],
    queryFn: async () => {
      const response = await api.get('/assembly/reports/dates/');
      return Array.isArray(response.data) ? response.data as string[] : [];
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
};

export const useAssemblyReportsSummary = (date?: string) => {
  return useQuery({
    queryKey: ['assembly-reports-summary', date],
    queryFn: async () => {
      const params = date ? `?date=${date}` : '';
      const response = await api.get(`/assembly/reports/summary/${params}`);
      return response.data as AssemblyReportSummary;
    },
  });
};

export const useCreateAssemblyReport = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: Omit<AssemblyReport, 'id'>) => {
      const response = await api.post('/assembly/reports/', data);
      return response.data;
    },
    onSuccess: () => {
      // 모든 관련 쿼리 무효화하여 캘린더와 상세기록 자동 업데이트
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-report-dates'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-trend-data'] });
    },
  });
};

export const useUpdateAssemblyReport = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<AssemblyReport> }) => {
      const response = await api.patch(`/assembly/reports/${id}/`, data);
      return response.data;
    },
    onSuccess: () => {
      // 모든 관련 쿼리 무효화하여 캘린더와 상세기록 자동 업데이트
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-report-dates'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-trend-data'] });
    },
  });
};

export const useDeleteAssemblyReport = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/assembly/reports/${id}/`);
    },
    onSuccess: () => {
      // 모든 관련 쿼리 무효화하여 캘린더와 상세기록 자동 업데이트
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-report-dates'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-trend-data'] });
    },
  });
};

export const useExportAssemblyReports = () => {
  return useMutation({
    mutationFn: async (filters: AssemblyReportFilters = {}) => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          params.append(key, value.toString());
        }
      });
      
      const response = await api.get(`/assembly/reports/export/?${params}`, {
        responseType: 'blob',
      });
      
      // CSV 파일 다운로드
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `assembly_reports_${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      window.URL.revokeObjectURL(url);
    },
  });
};

export const useBulkCreateAssemblyReports = () => {
  return useMutation({
    mutationFn: async (rows: any[]) => {
      const response = await api.post('/api/assembly/reports/bulk-create/', { rows });
      return response.data as { created_reports: number; errors: string[]; success: boolean };
    },
  });
};
