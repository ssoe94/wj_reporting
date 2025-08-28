import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

interface PartEcoCount {
  part_no: string;
  description: string;
  count: number;
}

export function usePartEcoCount(keyword: string) {
  return useQuery<PartEcoCount[]>({
    queryKey: ['part-eco-count', keyword],
    queryFn: async () => {
      if (!keyword.trim()) return [];
      const { data } = await api.get('eco-parts/with-eco-count/', {
        params: { search: keyword.trim() },
      });
      return data;
    },
    enabled: keyword.trim().length > 0,
  });
} 