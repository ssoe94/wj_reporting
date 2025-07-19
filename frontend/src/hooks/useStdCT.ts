import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { PartSpec } from './usePartSpecs';

export function useStdCT(partNos: string[]) {
  return useQuery<{ [partNo: string]: number }>({
    queryKey: ['std-ct', partNos.sort().join(',')],
    enabled: partNos.length > 0,
    queryFn: async () => {
      const unique = Array.from(new Set(partNos.filter(Boolean)));
      if (!unique.length) return {};
      const param = unique.join(',');
      const { data } = await api.get<any>('/parts/', {
        params: { 'part_no__in': param, page_size: unique.length },
      });
      const list: any[] = Array.isArray(data) ? data : data.results;
      const map: { [k: string]: number } = {};
      list.forEach((p) => {
        if (p?.part_no) map[p.part_no] = p.cycle_time_sec ?? p.ct ?? 0;
      });
      return map;
    },
    staleTime: 1000 * 60 * 10,
  });
} 