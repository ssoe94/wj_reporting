import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';

export interface Eco {
  id: number;
  eco_no: string;
  customer: string;
  description: string;
  received_date: string;  // YYYY-MM-DD
  due_date: string;
  close_date: string | null;
  status: string; // OPEN / CLOSED / WIP
  note: string;
}

export function useEcos(keyword = ''): UseQueryResult<Eco[]> {
  return useQuery({
    queryKey: ['ecos', keyword],
    queryFn: async () => {
      const params: Record<string, any> = {};
      if (keyword.trim()) params.search = keyword.trim();
      const { data } = await api.get('/ecos/', { params });
      return Array.isArray(data) ? data : data.results;
    },
  });
} 