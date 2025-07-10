import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { PartSpec } from './usePartSpecs';

export function usePartSearch(keyword: string) {
  return useQuery<PartSpec[]>({
    queryKey: ['parts-search', keyword],
    enabled: !!keyword.trim(),
    queryFn: async () => {
      const { data } = await api.get('parts/', {
        params: { search: keyword, page_size: 20 },
      });
      return Array.isArray(data) ? data : data.results;
    },
    staleTime: 60_000,
  });
} 