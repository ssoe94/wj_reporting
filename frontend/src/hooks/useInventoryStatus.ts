import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

export interface InventoryItem {
  qr_code?: string;
  label_code?: string;
  material_id: number;
  material_code: string;
  material_name: string;
  specification?: string;
  warehouse_code: string;
  warehouse_name: string;
  location_name?: string;
  quantity: number;
  unit: string;
  updated_at: string;
}

export interface InventoryResponse {
  page: number;
  size: number;
  total: number;
  results: InventoryItem[];
}

export function useInventoryStatus(params: Record<string, any>) {
  return useQuery<InventoryResponse>({
    queryKey: ['inventories', params],
    queryFn: async () => {
      const { data } = await api.get('/mes/inventory/', { params });
      // DRF pagination response: {count,next,previous,results}
      return {
        page: params.page || 1,
        size: params.size || 100,
        total: data.total ?? data.count ?? data.results?.length ?? 0,
        results: data.results ?? data,
      };
    },
  });
} 