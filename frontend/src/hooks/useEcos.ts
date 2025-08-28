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
  prepared_date: string;
  issued_date: string;
  eco_model: string;
  change_reason: string;
  change_details: string;
  applicable_models: string;
  applicable_work_order: string;
  storage_action: string;
  inventory_finished: number | null;
  inventory_material: number | null;
  applicable_date: string;
  form_type: 'REGULAR' | 'TEMP';
  details?: any[];
}

export function useEcos(keyword = ''): UseQueryResult<Eco[]> {
  return useQuery({
    queryKey: ['ecos', keyword],
    queryFn: async () => {
      const params: Record<string, any> = { include_details: 'true' };
      if (keyword.trim()) params.search = keyword.trim();
      const { data } = await api.get('/ecos/', { params });
      return Array.isArray(data) ? data : data.results;
    },
  });
} 