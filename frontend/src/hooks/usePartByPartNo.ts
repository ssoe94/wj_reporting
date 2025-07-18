import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { PartSpec } from './usePartSpecs';

export function usePartByPartNo(partNo: string) {
  return useQuery<PartSpec | null>({
    queryKey: ['part-by-partno', partNo],
    enabled: !!partNo.trim(),
    queryFn: async () => {
      if (!partNo.trim()) return null;
      const { data } = await api.get('parts/', {
        params: { 
          search: partNo.trim(),
          page_size: 1 
        },
      });
      const results = Array.isArray(data) ? data : data.results;
      return results.length > 0 ? results[0] : null;
    },
    staleTime: 60_000,
  });
} 