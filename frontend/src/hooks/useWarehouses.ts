import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

export interface Warehouse {
  warehouse_code: string;
  warehouse_name: string;
}

export function useWarehouses() {
  return useQuery<Warehouse[]>({
    queryKey: ['warehouses'],
    queryFn: async () => {
      const { data } = await api.get('/inventory/warehouses/');
      return data;
    },
    staleTime: 60 * 60 * 1000,
  });
}
