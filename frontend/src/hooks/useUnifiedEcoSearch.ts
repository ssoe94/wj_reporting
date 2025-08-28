import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';
import type { Eco } from '@/hooks/useEcos';

/**
 * 통합 ECO 검색 Hook
 * ECO编号, 适用型号, Part no. 중 아무거나 입력해서 검색 가능
 * 와일드카드 지원: ACQ301548** 입력시 ACQ301548로 시작하는 모든 Part No. 검색
 */
export function useUnifiedEcoSearch(
  keywordOrParts: string | string[] = '',
  searchType: 'eco' | 'part' | 'model' | 'all' = 'all',
  enabled = true,
): UseQueryResult<Eco[]> {
  return useQuery({
    queryKey: [
      'unified-eco-search',
      Array.isArray(keywordOrParts) ? keywordOrParts.join(',') : (keywordOrParts || ''),
      searchType,
    ],
    queryFn: async () => {
      // Part 검색 처리 (명시적 배열 기반)
      if (searchType === 'part') {
        const parts = Array.isArray(keywordOrParts)
          ? keywordOrParts.filter(Boolean)
          : (keywordOrParts ? [keywordOrParts] : []);
        if (!parts.length) return [];

        const { data } = await api.get('/ecos/unified-search/', {
          params: { type: 'part', part_numbers: parts.join(',') },
        });
        return Array.isArray(data) ? data : data.results;
      }

      // 문자열 키워드 검색 처리 (eco | model | all)
      const raw = Array.isArray(keywordOrParts) ? '' : (keywordOrParts || '');
      const keyword = raw.trim();

      if (!keyword) {
        const { data } = await api.get('/ecos/', { params: { ordering: '-prepared_date' } });
        return Array.isArray(data) ? data : data.results;
      }

      const { data } = await api.get('/ecos/unified-search/', {
        params: { keyword, type: searchType },
      });
      return Array.isArray(data) ? data : data.results;
    },
    enabled,
  });
}