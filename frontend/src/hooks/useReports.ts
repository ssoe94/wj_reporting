import { useQuery, UseQueryResult } from '@tanstack/react-query';
import axios from 'axios';

export interface Report {
  id: number;
  date: string;      // 'YYYY-MM-DD'
  tonnage: string;   // '850T'
  model: string;
  planQty: number;
  actualQty: number;
  // ...필드 계속
}

export function useReports(): UseQueryResult<Report[]> {
  return useQuery({
    queryKey: ['reports'],
    queryFn: async () => {
      const { data } = await axios.get<Report[]>('/api/reports/');
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5분
  });
} 