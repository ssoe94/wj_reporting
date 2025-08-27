import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';
import type { Eco } from '@/hooks/useEcos';

/**
 * 통합 ECO 검색 Hook
 * ECO编号, 适用型号, Part no. 중 아무거나 입력해서 검색 가능
 */
export function useUnifiedEcoSearch(keyword = ''): UseQueryResult<Eco[]> {
  return useQuery({
    queryKey: ['unified-eco-search', keyword],
    queryFn: async () => {
      if (!keyword.trim()) {
        // 키워드가 없으면 최근 데이터 반환
        const { data } = await api.get('/ecos/', { params: { ordering: '-prepared_date' } });
        return Array.isArray(data) ? data : data.results;
      }

      const trimmedKeyword = keyword.trim();
      
      try {
        // 1. 먼저 ECO 검색 (eco_no, change_reason, change_details, customer, eco_model)
        const ecoResponse = await api.get('/ecos/', { 
          params: { search: trimmedKeyword }
        });
        let ecos = Array.isArray(ecoResponse.data) ? ecoResponse.data : ecoResponse.data.results;

        // 2. Part No로도 검색 (별도 API 사용)
        try {
          const partResponse = await api.get('/ecos/by-part/', {
            params: { part_no: trimmedKeyword }
          });
          const partEcos = Array.isArray(partResponse.data) ? partResponse.data : partResponse.data.results;
          
          // 3. 중복 제거하여 병합 (ID 기준)
          const existingIds = new Set(ecos.map((eco: Eco) => eco.id));
          const uniquePartEcos = partEcos.filter((eco: Eco) => !existingIds.has(eco.id));
          
          ecos = [...ecos, ...uniquePartEcos];
        } catch (partError) {
          // Part 검색 실패해도 ECO 검색 결과는 반환
          console.warn('Part search failed:', partError);
        }

        return ecos;
      } catch (error) {
        console.error('Unified search error:', error);
        throw error;
      }
    },
    enabled: true, // 항상 활성화하되 keyword가 없으면 최근 데이터 반환
  });
}