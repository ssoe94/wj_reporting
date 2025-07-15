import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { Eco } from './useEcos';

export function useEcosByParts(parts: string[]) {
  return useQuery<Eco[]>({
    queryKey: ['ecos-by-parts', parts.sort().join(',')],
    queryFn: async () => {
      if (!parts.length) return [];
      const tasks = parts.map((p) => api.get('ecos/by-part/', { params: { part_no: p } }));
      const responses = await Promise.all(tasks);
      const ecoMap = new Map<number, Eco>();
      responses.forEach((r) => {
        const arr = Array.isArray(r.data) ? r.data : r.data.results;
        arr.forEach((eco: any) => {
          if (!ecoMap.has(eco.id)) {
            ecoMap.set(eco.id, { ...eco });
          } else {
            // 이미 있는 ECO라면 details 를 병합 (중복 제거)
            const existing = ecoMap.get(eco.id) as any;
            const prevDetails = existing.details || [];
            const newDetails = eco.details || [];
            const mergedDetails = [...prevDetails, ...newDetails].reduce((acc:any[], d:any)=>{
              if(!acc.some((x)=>x.id===d.id)) acc.push(d);
              return acc;
            }, []);
            existing.details = mergedDetails;
            ecoMap.set(eco.id, existing);
          }
        });
      });
      return Array.from(ecoMap.values());
    },
    enabled: parts.length > 0,
  });
} 