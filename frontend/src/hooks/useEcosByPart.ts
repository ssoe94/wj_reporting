import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { Eco } from './useEcos';

export function useEcosByPart(partNo: string) {
  return useQuery({
    queryKey: ['ecos-by-part', partNo],
    queryFn: async () => {
      if(!partNo.trim()) return [] as Eco[];
      const { data } = await api.get('ecos/by-part/', { params:{ part_no: partNo.trim() }});
      return Array.isArray(data) ? data : data.results;
    },
    enabled: !!partNo.trim(),
  });
} 