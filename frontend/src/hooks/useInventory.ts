import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

export function useInventory(partIds: number[]) {
  return useQuery<Record<number, number>>({
    queryKey: ['inventory', partIds.sort().join(',')],
    enabled: partIds.length > 0,
    queryFn: async () => {
      const params = new URLSearchParams();
      partIds.forEach(id => params.append('part_ids', String(id)));
      const { data } = await api.get('inventory/', { params });
      return data as Record<number, number>;
    },
    staleTime: 300_000,
  });
} 