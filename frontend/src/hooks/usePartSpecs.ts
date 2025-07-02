import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';

export interface PartSpec {
  id: number;
  part_no: string;
  model_code: string;
  description: string;
  mold_type?: string;
  color?: string;
  resin_type?: string;
  resin_code?: string;
  net_weight_g?: number | null;
  sr_weight_g?: number | null;
  tonnage?: number | null;
  cycle_time_sec?: number | null;
  efficiency_rate?: number | null;
  cavity?: number | null;
  resin_loss_pct?: number | null;
  defect_rate_pct?: number | null;
  valid_from?: string;
}

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export function usePartSpecSearch(query: string): UseQueryResult<PartSpec[]> {
  return useQuery({
    queryKey: ['parts-search', query],
    queryFn: async () => {
      const { data } = await api.get<Paginated<PartSpec>>('/parts/', {
        params: { search: query },
      });
      return data.results;
    },
    enabled: query.trim().length > 0,
    staleTime: 1000 * 60 * 10,
  });
}

export function usePartListByModel(modelCode: string | undefined): UseQueryResult<PartSpec[]> {
  return useQuery({
    queryKey: ['parts-model', modelCode],
    queryFn: async () => {
      const { data } = await api.get<Paginated<PartSpec>>('/parts/', {
        params: { model_code: modelCode },
      });
      return data.results;
    },
    enabled: !!modelCode,
    staleTime: 1000 * 60 * 10,
  });
}
