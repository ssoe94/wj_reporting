import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

export interface FinishedGoodsTransactionRow {
  id: number;
  material_code: string;
  material_name: string;
  specification: string;
  warehouse_code: string;
  warehouse_name: string;
  unit: string;
  total_in: number;
  total_out: number;
  net_change: number;
  record_count: number;
  last_in_time: string | null;
  last_out_time: string | null;
  action_breakdown: Record<string, number>;
  created_at: string;
  updated_at: string;
}

export interface FinishedGoodsSnapshot {
  id: number;
  slot: 'morning' | 'evening';
  slot_display: string;
  report_date: string;
  scheduled_at: string;
  range_start: string;
  range_end: string;
  record_count: number;
  total_in: number;
  total_out: number;
  net_change: number;
  warehouse_filter: string[];
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  transactions: FinishedGoodsTransactionRow[];
}

export interface FinishedGoodsSnapshotMap {
  [slot: string]: FinishedGoodsSnapshot | null;
}

const SNAPSHOT_QUERY_KEY = 'finishedGoodsSnapshots';

export function useFinishedGoodsSnapshots(params: Record<string, any> = { latest_per_slot: 1 }) {
  return useQuery<FinishedGoodsSnapshotMap>({
    queryKey: [SNAPSHOT_QUERY_KEY, params],
    queryFn: async () => {
      const { data } = await api.get('/inventory/finished-goods/transactions/', { params });
      const snapshots = data.snapshots;
      if (Array.isArray(snapshots)) {
        const mapped: FinishedGoodsSnapshotMap = {};
        snapshots.forEach((snapshot: FinishedGoodsSnapshot) => {
          mapped[snapshot.slot] = snapshot;
        });
        return mapped;
      }
      return snapshots as FinishedGoodsSnapshotMap;
    },
  });
}

interface RefreshPayload {
  slot?: 'morning' | 'evening';
  date?: string;
  start?: string;
  end?: string;
  force?: boolean;
  dry_run?: boolean;
}

export function useRefreshFinishedGoodsSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: RefreshPayload = {}) => {
      const { data } = await api.post('/inventory/finished-goods/transactions/', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SNAPSHOT_QUERY_KEY] });
    },
  });
}
