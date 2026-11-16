export const FIELD_APPS = ['barcode', 'weigh_label', 'vision_backcover', 'vision_capture', 'vision_uv'] as const;
export const FIELD_RESULTS = ['ok', 'ng', 'error', 'info'] as const;
export const FIELD_MODES = ['production', 'test', 'demo', 'preview', 'manual', 'unknown'] as const;
export const FIELD_TYPES = [
  'scan.recorded', 'weigh.result', 'label.reserved', 'label.dispatched', 'label.reread',
  'queue.partial_flush', 'vision.cycle', 'vision.batch', 'capture.pair', 'capture.single',
  'app.started', 'app.stopped', 'device.state', 'mode.changed', 'config.applied',
  'operator.action', 'backup.completed', 'backup.failed',
] as const;

export type FieldResult = typeof FIELD_RESULTS[number];
export type FieldFilterKey = typeof FIELD_FILTER_KEYS[number];
export type FieldFilters = Partial<Record<FieldFilterKey, string>> & { from: string; to: string };

const FIELD_FILTER_KEYS = [
  'from', 'to', 'station', 'app', 'type', 'result', 'reason', 'mode', 'barcode', 'serial', 'part_no', 'job_id', 'cycle_id',
] as const;

export function recordParams(filters: FieldFilters) {
  return Object.fromEntries(FIELD_FILTER_KEYS.flatMap((key) => filters[key] ? [[key, filters[key]]] : []));
}

export function exceptionRecordFilters(day: string, station: string, filters: Record<string, string>): FieldFilters {
  const from = filters.from || day;
  const to = filters.to || day;
  return { ...recordParams({ ...filters, from, to }), from, to, station };
}


export type FieldStationDraft = {
  station_id: string;
  display_name: string;
  apps: string[];
  location: string;
  line_note: string;
  enabled: boolean;
};

export type FieldStation = FieldStationDraft & {
  created_at: string;
  updated_at: string;
  credential_active: boolean;
};

export type FieldOverviewStation = FieldStationDraft & {
  connection: 'online' | 'stale' | 'offline' | 'never';
  last_heartbeat_at: string | null;
  app_status: { app: string; version: string; mode: string; state: string; last_work_at: string | null }[];
  devices: { app: string; device: string; state: string; last_input_at: string | null }[];
  outbox: {
    pending_count: number | null;
    oldest_occurred_at: string | null;
    last_ack_at?: string | null;
    state: string;
  } | null;
  production_counts: Record<FieldResult, number>;
  non_production_count: number;
  clock_offset_seconds: number | null;
  warnings: string[];
};

export type FieldOverview = { business_date: string; stations: FieldOverviewStation[] };

export type FieldException = {
  station_id: string;
  display_name: string;
  reason: string;
  count: number;
  filters: Record<string, string>;
};

export type FieldEvent = {
  id: number;
  station_id: string;
  app: string;
  type: string;
  result: FieldResult;
  reason: string;
  mode: string;
  occurred_at: string;
  received_at: string;
  business_date: string;
  barcode: string | null;
  serial: string | null;
  part_no: string | null;
  status_raw: string | null;
  clock_suspect: boolean;
  clock_offset_seconds: number | null;
  ref: Record<string, unknown>;
  detail: Record<string, unknown>;
};

export type IssuedToken = { station_id: string; token: string };
