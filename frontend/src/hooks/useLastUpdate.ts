import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

export const useLastUpdate = () => {
  return useQuery({
    queryKey: ['lastUpdate'],
    queryFn: async () => {
      const response = await api.get('/mes/inventory/last-update/');
      return response.data;
    },
    refetchInterval: 30000, // 30초마다 갱신
  });
}; 