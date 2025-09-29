import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

// API로부터 받는 데이터 타입
interface DefectHistoryResponse {
  processing_defects: string[];
  outsourcing_defects: string[];
}

// 로컬 스토리지 키
const LOCAL_STORAGE_KEY = 'defectHistory';

// 로컬에 저장될 데이터 타입
interface LocalDefectHistory {
  [category: string]: {
    [type: string]: {
      lastUsed: string;
    };
  };
}

/**
 * 로컬 스토리지와 서버 데이터를 결합하여 불량 유형 히스토리를 관리하는 훅
 */
export function useLocalDefectHistory() {
  const queryClient = useQueryClient();

  // 1. 서버로부터 기본 히스토리 데이터 Fetch
  const { data: serverHistory } = useQuery<DefectHistoryResponse>({
    queryKey: ['defectHistory'],
    queryFn: async () => {
      const response = await api.get('/assembly/reports/defect-history/');
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5분
  });

  // 2. 로컬 스토리지에서 데이터 읽기
  const getLocalHistory = (): LocalDefectHistory => {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.error("Failed to parse defect history from localStorage", error);
      return {};
    }
  };

  // 3. 서버 + 로컬 데이터 결합 및 정렬
  const getCombinedHistory = (category: 'processing' | 'outsourcing'): string[] => {
    const localHistory = getLocalHistory();
    const serverList = serverHistory?.[`${category}_defects`] || [];
    const localList = localHistory[category] ? Object.keys(localHistory[category]) : [];

    // Set으로 중복 제거
    const combined = new Set([...localList, ...serverList]);
    
    // 로컬 히스토리의 lastUsed를 기준으로 최신순 정렬
    const sorted = Array.from(combined).sort((a, b) => {
      const aLastUsed = localHistory[category]?.[a]?.lastUsed;
      const bLastUsed = localHistory[category]?.[b]?.lastUsed;
      if (aLastUsed && bLastUsed) return new Date(bLastUsed).getTime() - new Date(aLastUsed).getTime();
      if (aLastUsed) return -1; // a가 최신
      if (bLastUsed) return 1;  // b가 최신
      return 0;
    });

    return sorted;
  };

  const processingDefectHistory = getCombinedHistory('processing');
  const outsourcingDefectHistory = getCombinedHistory('outsourcing');

  // 4. 서버에 사용 기록을 전송하는 Mutation
  const recordUsageMutation = useMutation({
    mutationFn: ({ category, defectType }: { category: string; defectType: string }) =>
      api.post('/assembly/reports/record-defect-usage/', {
        defect_category: category,
        defect_type: defectType,
      }),
    onSuccess: () => {
      // 서버 데이터 갱신이 필요하면 여기서 처리
      // queryClient.invalidateQueries({ queryKey: ['defectHistory'] });
    }
  });

  // 5. 로컬과 서버에 사용 기록을 남기는 함수
  const recordDefectTypeUsage = (category: 'processing' | 'outsourcing', type: string) => {
    if (!type || type.trim() === '') return;

    const trimmedType = type.trim();

    // 로컬 스토리지 업데이트
    const localHistory = getLocalHistory();
    if (!localHistory[category]) {
      localHistory[category] = {};
    }
    localHistory[category][trimmedType] = { lastUsed: new Date().toISOString() };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localHistory));

    // 서버에 기록 (비동기)
    recordUsageMutation.mutate({ category, defectType: trimmedType });
    
    // 상태를 직접 업데이트하기보다, 로컬 스토리지를 변경하고 UI를 리렌더링하는 방식을 사용
    // 이 훅을 사용하는 컴포넌트가 리렌더링되면서 getCombinedHistory가 다시 호출됨
    // 강제 리렌더링이 필요하다면 queryClient를 사용할 수 있음
    queryClient.invalidateQueries({ queryKey: ['defectHistory'] }); // 서버 데이터와 동기화
  };

  return {
    processingDefectHistory,
    outsourcingDefectHistory,
    recordDefectTypeUsage,
  };
}
