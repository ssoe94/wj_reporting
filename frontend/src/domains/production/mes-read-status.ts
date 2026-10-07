export const MES_READ_STATUS_SCHEMA = 'production-mes-read-status/v1';

export type MesReadState = 'verified' | 'partial' | 'not_queried' | 'permission_required' | 'connection_required' | 'unavailable';
export type MesStageState = 'unknown' | 'waiting' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
export type MesNextActionTarget = 'MES' | 'WJ_QC' | 'NONE';

export interface MesReadStage {
  state: MesStageState;
  label: string;
  reported_quantity?: string;
  quantity?: string;
  unit_name?: string;
}

export interface MesReadWorkOrder {
  id: string;
  code: string;
  material_code?: string;
  resource_name?: string;
  production_order: MesReadStage;
  production: MesReadStage;
  inbound: MesReadStage;
  qc?: MesReadStage;
  next_action: { code: string; target: MesNextActionTarget; label: string };
}

export interface MesReadStatus {
  schema_version: typeof MES_READ_STATUS_SCHEMA;
  business_date: string;
  /** Local request provenance, retained even when the response has no rows. */
  requested_work_order_code: string;
  read_only: true;
  live_writes_enabled: false;
  state: MesReadState;
  observed_at: string | null;
  fresh_until: string | null;
  work_orders: MesReadWorkOrder[];
  required_read_permissions?: Array<{ name: string; state: 'unverified' }>;
}

const READ_STATES = new Set<unknown>(['verified', 'partial', 'not_queried', 'permission_required', 'connection_required', 'unavailable']);
const STAGE_STATES = new Set<unknown>(['unknown', 'waiting', 'in_progress', 'completed', 'blocked', 'cancelled']);
const TARGETS = new Set<unknown>(['MES', 'WJ_QC', 'NONE']);
const CONTROL = /[\u0000-\u001f\u007f]/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maxLength = 120): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !CONTROL.test(value);
}

function calendarDate(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return !!parts && calendarDate(parts[1]) && Number(parts[2]) <= 23 && Number(parts[3]) <= 59
    && Number(parts[4]) <= 59 && Number.isFinite(Date.parse(value));
}

export function isExistingMesWorkOrderCode(value: string) {
  return text(value, 100) && value === value.trim();
}

function quantity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function stage(value: unknown): MesReadStage {
  if (!record(value) || !STAGE_STATES.has(value.state) || !text(value.label)) throw new Error('mes_read_status_invalid');
  for (const key of ['reported_quantity', 'quantity'] as const) {
    if (value[key] !== undefined && !quantity(value[key])) throw new Error('mes_read_status_invalid');
  }
  const hasQuantity = value.quantity !== undefined || value.reported_quantity !== undefined;
  if ((value.unit_name !== undefined && !text(value.unit_name, 80)) || (hasQuantity && (value.state === 'unknown' || !text(value.unit_name, 80)))) {
    throw new Error('mes_read_status_invalid');
  }
  return {
    state: value.state as MesStageState,
    label: value.label,
    ...(value.reported_quantity === undefined ? {} : { reported_quantity: value.reported_quantity as string }),
    ...(value.quantity === undefined ? {} : { quantity: value.quantity as string }),
    ...(value.unit_name === undefined ? {} : { unit_name: value.unit_name as string }),
  };
}

/** Select only the display contract, retaining exact IDs and decimal quantities. */
export function parseMesReadStatus(value: unknown, businessDate: string, workOrderCode: string): MesReadStatus {
  if (!calendarDate(businessDate) || !record(value) || value.schema_version !== MES_READ_STATUS_SCHEMA || value.business_date !== businessDate
    || value.read_only !== true || value.live_writes_enabled !== false || !READ_STATES.has(value.state)
    || !Array.isArray(value.work_orders) || value.work_orders.length > 1
    || !(value.observed_at === null || timestamp(value.observed_at))
    || !(value.fresh_until === null || timestamp(value.fresh_until))) throw new Error('mes_read_status_invalid');
  const hasEvidence = value.state === 'verified' || value.state === 'partial';
  if ((!hasEvidence && value.work_orders.length > 0)
    || (hasEvidence && (!timestamp(value.observed_at) || !timestamp(value.fresh_until)))
    || (value.observed_at === null) !== (value.fresh_until === null)
    || (timestamp(value.observed_at) && timestamp(value.fresh_until)
      && (Date.parse(value.fresh_until) <= Date.parse(value.observed_at)
        || Date.parse(value.fresh_until) - Date.parse(value.observed_at) > 300_000))) throw new Error('mes_read_status_invalid');
  const workOrders = value.work_orders.map((row: unknown): MesReadWorkOrder => {
    if (!record(row) || !text(row.id, 19) || !/^[1-9]\d*$/.test(row.id)
      || (row.id.length === 19 && row.id > '9223372036854775807') || row.code !== workOrderCode || !isExistingMesWorkOrderCode(workOrderCode)
      || (row.material_code !== undefined && !text(row.material_code, 100))
      || (row.resource_name !== undefined && !text(row.resource_name, 120))
      || !record(row.next_action) || !text(row.next_action.code, 80) || !TARGETS.has(row.next_action.target)
      || !text(row.next_action.label, 200)) throw new Error('mes_read_status_invalid');
    return {
      id: row.id,
      code: workOrderCode,
      ...(row.material_code === undefined ? {} : { material_code: row.material_code as string }),
      ...(row.resource_name === undefined ? {} : { resource_name: row.resource_name as string }),
      production_order: stage(row.production_order),
      production: stage(row.production),
      inbound: stage(row.inbound),
      ...(row.qc === undefined ? {} : { qc: stage(row.qc) }),
      next_action: { code: row.next_action.code, target: row.next_action.target as MesNextActionTarget, label: row.next_action.label },
    };
  });
  let permissions: MesReadStatus['required_read_permissions'];
  if (value.required_read_permissions !== undefined) {
    if (!Array.isArray(value.required_read_permissions) || value.required_read_permissions.length > 12) throw new Error('mes_read_status_invalid');
    permissions = value.required_read_permissions.map((item: unknown) => {
      if (!record(item) || !text(item.name, 150) || item.state !== 'unverified') throw new Error('mes_read_status_invalid');
      return { name: item.name, state: 'unverified' as const };
    });
  }
  return {
    schema_version: MES_READ_STATUS_SCHEMA,
    business_date: businessDate,
    requested_work_order_code: workOrderCode,
    read_only: true,
    live_writes_enabled: false,
    state: value.state as MesReadState,
    observed_at: value.observed_at as string | null,
    fresh_until: value.fresh_until as string | null,
    work_orders: workOrders,
    ...(permissions === undefined ? {} : { required_read_permissions: permissions }),
  };
}

export type MesReadDisplayState = MesReadState | 'loading' | 'stale';

/** A failed refresh, different scope or expired observation cannot retain current completion badges. */
export function deriveMesReadStatus(
  data: MesReadStatus | undefined,
  businessDate: string,
  workOrderCode: string,
  options: { pending?: boolean; failed?: boolean; nowMs?: number } = {},
): { state: MesReadDisplayState; row: MesReadWorkOrder | null; observedAt: string | null } {
  if (options.pending) return { state: 'loading', row: null, observedAt: null };
  if (options.failed) return { state: 'unavailable', row: null, observedAt: null };
  if (!data || data.business_date !== businessDate || data.requested_work_order_code !== workOrderCode
    || data.work_orders.some(row => row.code !== workOrderCode)) {
    return { state: 'not_queried', row: null, observedAt: null };
  }
  const now = options.nowMs ?? Date.now();
  if ((data.state === 'verified' || data.state === 'partial')
    && (!data.observed_at || !data.fresh_until || Date.parse(data.observed_at) > now || Date.parse(data.fresh_until) <= now)) {
    return { state: 'stale', row: null, observedAt: data.observed_at };
  }
  return { state: data.state, row: data.work_orders[0] ?? null, observedAt: data.observed_at };
}
