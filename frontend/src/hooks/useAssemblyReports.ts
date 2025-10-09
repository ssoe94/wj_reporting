import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  AssemblyReport,
  AssemblyReportFilters,
  AssemblyReportSummary,
  AssemblyReportListResponse
} from '../types/assembly';

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
      return response.data;
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
      return response.data as string[];
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
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
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
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
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
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
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
