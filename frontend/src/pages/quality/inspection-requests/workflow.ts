export type InspectionAction = 'create' | 'save' | 'submit' | 'approve' | 'reject' | 'reinspect' | 'refresh' | 'sync' | 'mes-save' | 'mes-finish' | 'mes-reconcile' | 'review-failure';

export type MutationAttempt = {
  action: InspectionAction;
  payload: Record<string, unknown>;
  key: string;
};

const actions: InspectionAction[] = ['create', 'save', 'submit', 'approve', 'reject', 'reinspect', 'refresh', 'sync', 'mes-save', 'mes-finish', 'mes-reconcile', 'review-failure'];

export function createInspectionKey(randomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = randomBytes(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeInspectionEvidenceUrl(value: string): string | null {
  try {
    if (value.length > 500 || /\s/.test(value)) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function mutationFingerprint(action: InspectionAction, payload: Record<string, unknown>): string {
  return JSON.stringify([action, stableValue(payload)]);
}

/** A retry returns the original key AND body. Changed payloads are a deliberate new request. */
export function inspectionMutationAttempt(
  previous: MutationAttempt | null,
  action: InspectionAction,
  payload: Record<string, unknown>,
  createKey: () => string,
): MutationAttempt {
  if (previous && mutationFingerprint(previous.action, previous.payload) === mutationFingerprint(action, payload)) return previous;
  return { action, payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>, key: createKey() };
}

export type InspectionError = { conflict: boolean; uncertain: boolean; reconciliation_required: boolean; message: string };

export function inspectionError(error: unknown, fallback: string, expectedRequestId?: number): InspectionError {
  const response = error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { status?: number; data?: unknown } }).response : undefined;
  const data = response?.data;
  const messages: string[] = [];
  const fields = ['detail', 'message', 'reason', 'non_field_errors', 'version', 'evidence', 'measurements', 'inspection_items', 'judgement', 'inspected_quantity', 'accepted_quantity', 'rejected_quantity', 'notes', 'work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'inspection_type', 'target_quantity', 'uom', 'warehouse_ref', 'lot_ref', 'work_started_at', 'require_evidence', 'quantity_mode', 'judgement_policy', 'required', 'options', 'kind', 'minimum', 'maximum', 'idempotency_key', 'item_id', 'value', 'evidence_url', 'label', 'url'];
  const collect = (value: unknown, path: string, depth: number) => {
    if (messages.length >= 20 || depth > 4) return;
    if (typeof value === 'string' && value.length <= 500) messages.push(!path || path === 'detail' || path === 'message' ? value : `${path}: ${value}`);
    else if (Array.isArray(value)) value.slice(0, 20).forEach((child, index) => collect(child, typeof child === 'string' ? path : `${path}[${index + 1}]`, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([field, child]) => { if (fields.includes(field)) collect(child, path ? `${path}.${field}` : field, depth + 1); });
  };
  collect(data, '', 0);
  const disabled = data && typeof data === 'object' && 'code' in data && data.code === 'mes_contract_unverified';
  const recordedOperation = data && typeof data === 'object' && 'code' in data && ['mes_outcome_unknown', 'mes_stage_blocked', 'operation_pending'].includes(String(data.code)) && 'operation_id' in data && typeof data.operation_id === 'number' && Number.isSafeInteger(data.operation_id) && data.operation_id > 0 && 'request' in data && data.request && typeof data.request === 'object' && 'id' in data.request && expectedRequestId !== undefined && data.request.id === expectedRequestId;
  return { conflict: response?.status === 409, uncertain: !response?.status || (response.status === 202 && !recordedOperation) || (response.status >= 500 && !disabled && !recordedOperation), reconciliation_required: Boolean(recordedOperation), message: messages.join('\n') || fallback };
}

export function inspectionRecoveryKey(userId: number, requestId: number): string {
  return `wj-inspection-draft:v1:${userId}:${requestId}`;
}

export type InspectionRecovery<T> = {
  schema: 1; user_id: number; request_id: number; version: number; saved_at: number;
  draft: T; attempt: MutationAttempt | null; reconciliation_required?: boolean;
};

export function parseInspectionRecovery<T>(raw: string | null, userId: number, requestId: number, now = Date.now()): InspectionRecovery<T> | null {
  if (!raw) return null;
  try {
    const item = JSON.parse(raw) as InspectionRecovery<T>;
    if (item.schema !== 1 || item.user_id !== userId || item.request_id !== requestId || !Number.isSafeInteger(item.version) || item.version < 0 || !Number.isFinite(item.saved_at) || item.saved_at > now || (!item.attempt && !item.reconciliation_required && now - item.saved_at > 24 * 60 * 60 * 1000) || !item.draft || typeof item.draft !== 'object' || (item.reconciliation_required !== undefined && typeof item.reconciliation_required !== 'boolean')) return null;
    if (item.attempt && (!actions.includes(item.attempt.action) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.attempt.key) || !item.attempt.payload || typeof item.attempt.payload !== 'object' || Array.isArray(item.attempt.payload))) return null;
    return item;
  } catch {
    return null;
  }
}
