import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AssemblyReport, AssemblyReportFilters, AssemblyReportSummary } from '../types/assembly';

export const useAssemblyReports = (filters: AssemblyReportFilters = {}) => {
  return useQuery({
    queryKey: ['assembly-reports', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          params.append(key, value.toString());
        }
      });
      
      const response = await api.get(`/assembly/api/reports/?${params}`);
      return response.data;
    },
  });
};

export const useAssemblyReportsSummary = (date?: string) => {
  return useQuery({
    queryKey: ['assembly-reports-summary', date],
    queryFn: async () => {
      const params = date ? `?date=${date}` : '';
      const response = await api.get(`/assembly/api/reports/summary/${params}`);
      return response.data as AssemblyReportSummary;
    },
  });
};

export const useCreateAssemblyReport = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: Omit<AssemblyReport, 'id'>) => {
      const response = await api.post('/assembly/api/reports/', data);
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
      const response = await api.patch(`/assembly/api/reports/${id}/`, data);
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
      await api.delete(`/assembly/api/reports/${id}/`);
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
      
      const response = await api.get(`/assembly/api/reports/export/?${params}`, {
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