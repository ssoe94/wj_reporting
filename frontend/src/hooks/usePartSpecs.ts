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
      const pageSize = 100;
      let page = 1;
      let all: PartSpec[] = [];
      if (!query.trim()) return all;
      while (true) {
        const { data } = await api.get<Paginated<PartSpec>>('/parts/', {
          params: { search: query, page, page_size: pageSize },
        });
        all = all.concat(data.results);
        if (!data.next) break;
        page += 1;
      }
      return all;
    },
    enabled: query.trim().length > 0,
    staleTime: 1000 * 60 * 10,
  });
}

// 모든 PartSpec 전체 리스트를 가져오는 훅 (최대 1000개, 필요 시 페이지네이션 확장)
export function usePartSpecs(): UseQueryResult<PartSpec[]> {
  return useQuery({
    queryKey: ['parts-all'],
    queryFn: async () => {
      const { data } = await api.get<Paginated<PartSpec>>('/parts/', {
        params: { page_size: 100 },
      });
      return data.results;
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function usePartListByModel(modelCode: string | undefined): UseQueryResult<PartSpec[]> {
  return useQuery({
    queryKey: ['parts-model', modelCode],
    queryFn: async () => {
      // 페이지네이션 처리: 해당 모델의 모든 PartSpec 로드
      const pageSize = 100;
      let page = 1;
      let all: PartSpec[] = [];
      if (!modelCode) return all;
      while (true) {
        const { data } = await api.get<Paginated<PartSpec>>('/parts/', {
          params: { model_code: modelCode, page, page_size: pageSize },
        });
        all = all.concat(data.results);
        if (!data.next) break;
        page += 1;
      }
      return all;
    },
    enabled: !!modelCode,
    staleTime: 1000 * 60 * 10,
  });
}
