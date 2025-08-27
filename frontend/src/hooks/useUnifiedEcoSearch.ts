import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';
import type { Eco } from '@/hooks/useEcos';

/**
 * 통합 ECO 검색 Hook
 * ECO编号, 适用型号, Part no. 중 아무거나 입력해서 검색 가능
 * 와일드카드 지원: ACQ301548** 입력시 ACQ301548로 시작하는 모든 Part No. 검색
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
      
      // 와일드카드 패턴 처리 (** → *)
      const isWildcard = trimmedKeyword.includes('**');
      const searchKeyword = isWildcard ? trimmedKeyword.replace(/\*\*/g, '') : trimmedKeyword;
      
      try {
        let allEcos: any[] = [];

        // 1. ECO 검색 (eco_no, change_reason, change_details, customer, eco_model)
        const ecoResponse = await api.get('/ecos/', { 
          params: { search: searchKeyword }
        });
        let ecos = Array.isArray(ecoResponse.data) ? ecoResponse.data : ecoResponse.data.results;
        allEcos = [...ecos];

        // 2. Part No 검색
        try {
          if (isWildcard) {
            // 와일드카드인 경우: prefix로 시작하는 모든 part들을 찾아서 각각의 ECO를 가져옴
            const partSpecResponse = await api.get('/eco-part-specs/', {
              params: { search: searchKeyword, limit: 100 }
            });
            const partSpecs = Array.isArray(partSpecResponse.data) ? partSpecResponse.data : partSpecResponse.data.results;
            
            // 각 part no에 대해 ECO 검색
            for (const partSpec of partSpecs) {
              if (partSpec.part_no && partSpec.part_no.startsWith(searchKeyword)) {
                try {
                  const partEcoResponse = await api.get('/ecos/by-part/', {
                    params: { part_no: partSpec.part_no }
                  });
                  const partEcos = Array.isArray(partEcoResponse.data) ? partEcoResponse.data : partEcoResponse.data.results;
                  allEcos = [...allEcos, ...partEcos];
                } catch (error) {
                  console.warn(`Failed to fetch ECOs for part ${partSpec.part_no}:`, error);
                }
              }
            }
          } else {
            // 일반 검색
            const partResponse = await api.get('/ecos/by-part/', {
              params: { part_no: searchKeyword }
            });
            const partEcos = Array.isArray(partResponse.data) ? partResponse.data : partResponse.data.results;
            allEcos = [...allEcos, ...partEcos];
          }
        } catch (partError) {
          console.warn('Part search failed:', partError);
        }

        // 3. 중복 제거하여 병합 (ID 기준)
        const uniqueEcos = allEcos.filter((eco, index, self) => 
          index === self.findIndex(e => e.id === eco.id)
        );

        return uniqueEcos;
      } catch (error) {
        console.error('Unified search error:', error);
        throw error;
      }
    },
    enabled: true, // 항상 활성화하되 keyword가 없으면 최근 데이터 반환
  });
}