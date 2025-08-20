import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { PartSpec } from './usePartSpecs';

export function useEcoPartSearch(keyword: string) {
  return useQuery<PartSpec[]>({
    queryKey: ['eco-parts-search', keyword],
    enabled: !!keyword.trim(),
    queryFn: async () => {
      const { data } = await api.get('eco-parts/', {
        params: { search: keyword, page_size: 100 },
      });
      return Array.isArray(data) ? data : data.results;
    },
    staleTime: 60_000,
  });
} 