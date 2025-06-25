import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';

export interface Product {
  id: number;
  model: string;
  type: string;
  fg_part_no: string;
  wip_part_no: string;
}

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export function useProductSearch(query: string): UseQueryResult<Product[]> {
  return useQuery({
    queryKey: ['products', query],
    queryFn: async () => {
      const { data } = await api.get<Paginated<Product>>('/products/', {
        params: { search: query },
      });
      return data.results;
    },
    enabled: query.trim().length > 0,
    staleTime: 1000 * 60 * 10,
  });
} 