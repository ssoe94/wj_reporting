import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';

/**
 * Inventory qty 조회 훅
 * @param partIds PartSpec id 배열
 * @returns { data: Record<number, number>, isLoading, ... }
 */
export function useInventory(partIds: number[]): UseQueryResult<Record<number, number>> {
  const idsStr = (partIds ?? []).sort((a,b)=>a-b).join(',');
  return useQuery({
    queryKey: ['inventory', idsStr],
    queryFn: async () => {
      if(!partIds?.length) return {};
      const params = partIds.map((id)=>['part_ids', id]);
      // convert to URLSearchParams manually to keep duplicates
      const search = new URLSearchParams(params as any);
      const { data } = await api.get<Record<number, number>>('/api/inventory/', {
        params: search,
        paramsSerializer: () => search.toString(),
      });
      return data || {};
    },
    enabled: partIds.length > 0,
    staleTime: 1000*60*5,
  });
} 