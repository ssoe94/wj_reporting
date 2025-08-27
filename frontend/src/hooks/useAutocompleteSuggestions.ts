import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

export interface AutocompleteSuggestion {
  id: string;
  label: string;
  type: 'eco_no' | 'eco_model' | 'part_no' | 'customer';
  value: string;
  description?: string;
}

/**
 * 자동완성 제안 Hook
 * ECO编号, 适用型号, Part no., 고객사 자동완성 제공
 * 와일드카드 지원: ACQ301548** 입력시 해당 prefix로 시작하는 Part들을 그룹으로 제안
 */
export function useAutocompleteSuggestions(query: string, enabled = true) {
  return useQuery({
    queryKey: ['autocomplete-suggestions', query],
    queryFn: async (): Promise<AutocompleteSuggestion[]> => {
      if (!query || query.length < 2) {
        return [];
      }

      const suggestions: AutocompleteSuggestion[] = [];

      try {
        // 1. ECO 번호 및 모델, 고객사 검색
        const ecoResponse = await api.get('/ecos/', {
          params: { search: query, limit: 5 }
        });
        const ecos = Array.isArray(ecoResponse.data) ? ecoResponse.data : ecoResponse.data.results;
        
        ecos.forEach((eco: any) => {
          // ECO 번호
          if (eco.eco_no && eco.eco_no.toLowerCase().includes(query.toLowerCase())) {
            suggestions.push({
              id: `eco-${eco.id}`,
              label: eco.eco_no,
              type: 'eco_no',
              value: eco.eco_no,
              description: eco.change_reason ? eco.change_reason.slice(0, 50) + '...' : undefined
            });
          }
          
          // ECO 모델 (적용형호)
          if (eco.eco_model && eco.eco_model.toLowerCase().includes(query.toLowerCase())) {
            suggestions.push({
              id: `model-${eco.id}`,
              label: eco.eco_model,
              type: 'eco_model',
              value: eco.eco_model,
              description: `적용형호: ${eco.eco_no}`
            });
          }
          
          // 고객사
          if (eco.customer && eco.customer.toLowerCase().includes(query.toLowerCase())) {
            suggestions.push({
              id: `customer-${eco.id}`,
              label: eco.customer,
              type: 'customer',
              value: eco.customer,
              description: `고객: ${eco.eco_no}`
            });
          }
        });

        // 2. Part No 검색
        try {
          const partResponse = await api.get('/eco-part-specs/', {
            params: { search: query, limit: 20 }
          });
          const parts = Array.isArray(partResponse.data) ? partResponse.data : partResponse.data.results;
          
          // 와일드카드 패턴 검출
          const isWildcardQuery = query.includes('**');
          const searchPrefix = isWildcardQuery ? query.replace(/\*\*/g, '') : query;
          
          if (isWildcardQuery && searchPrefix.length >= 3) {
            // 와일드카드인 경우: prefix로 시작하는 part들의 개수를 세어서 그룹 제안
            const matchingParts = parts.filter((part: any) => 
              part.part_no && part.part_no.startsWith(searchPrefix)
            );
            
            if (matchingParts.length > 0) {
              suggestions.push({
                id: `part-wildcard-${searchPrefix}`,
                label: `${searchPrefix}** (${matchingParts.length}개 Part)`,
                type: 'part_no',
                value: `${searchPrefix}**`,
                description: `${searchPrefix}로 시작하는 모든 Part No. (${matchingParts.length}개)`
              });
              
              // 개별 part들도 보여주기 (최대 5개)
              matchingParts.slice(0, 5).forEach((part: any) => {
                suggestions.push({
                  id: `part-${part.id}`,
                  label: part.part_no,
                  type: 'part_no',
                  value: part.part_no,
                  description: part.description || `${searchPrefix} 시리즈`
                });
              });
            }
          } else {
            // 일반 검색
            parts.forEach((part: any) => {
              if (part.part_no && part.part_no.toLowerCase().includes(query.toLowerCase())) {
                suggestions.push({
                  id: `part-${part.id}`,
                  label: part.part_no,
                  type: 'part_no',
                  value: part.part_no,
                  description: part.description || 'Part No'
                });
              }
            });
          }
        } catch (partError) {
          console.warn('Part search failed:', partError);
        }

        // 중복 제거 (동일한 value 기준)
        const uniqueSuggestions = suggestions.filter((suggestion, index, self) => 
          index === self.findIndex(s => s.value === suggestion.value && s.type === suggestion.type)
        );

        // 타입별로 정렬하고 최대 15개로 제한
        return uniqueSuggestions
          .sort((a, b) => {
            const typeOrder = ['eco_no', 'eco_model', 'part_no', 'customer'];
            return typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type);
          })
          .slice(0, 15);

      } catch (error) {
        console.error('Autocomplete error:', error);
        return [];
      }
    },
    enabled: enabled && query.length >= 2,
    staleTime: 30000, // 30초간 캐시
  });
}