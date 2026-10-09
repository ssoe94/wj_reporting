export const EXACT_DRAFT_CODE = 'WJ-IT-CREATE-20261009-001';
export const EXACT_DRAFT_START = '2026-10-10T08:00:00+08:00';
export const EXACT_DRAFT_END = '2026-10-11T08:00:00+08:00';
export const EXACT_DRAFT_MAX_MS = 30 * 60 * 1000;

export type ExactDraftActor = {
  id?: number; is_superuser?: boolean; is_active?: boolean;
  password_reset_required?: boolean; is_using_temp_password?: boolean;
  groups?: string[];
} | null | undefined;

// Menu visibility is a hint. The endpoint checks the active full WJ session
// and actor on every request, including pilot-token scope restrictions.
export function canUseExactDraftDiagnostic(user: ExactDraftActor): boolean {
  return Boolean(user?.id === 18 && user.is_superuser === true && user.is_active !== false
    && !user.password_reset_required && !user.is_using_temp_password
    && !(Array.isArray(user.groups) && user.groups.some(name => /(?:^|[ _-])pilot(?:$|[ _-])/i.test(name))));
}

export type ExactDraftState = 'unprepared' | 'prepared' | 'sending' | 'uncertain'
  | 'readback_pending' | 'review' | 'draft_observed';
export type ExactDraftSnapshot = {
  code: typeof EXACT_DRAFT_CODE;
  scope: { material_code: '0'; quantity: '1'; unit_name: '个'; status: 0;
    planned_start: typeof EXACT_DRAFT_START; planned_end: typeof EXACT_DRAFT_END;
    resource_assigned: false; inputs_assigned: false; processes_assigned: false };
  state: ExactDraftState; request_uid: string | null; attempt: 0 | 1;
  approval: { reference: string; approved_at: string | null; expires_at: string | null;
    active: boolean; expired: boolean; max_attempts: 1; app_max_attempts: 1; app_attempt: 0 | 1 };
  app_supply: { available: boolean; usable_for_seconds: number; supply_mode: string };
  connection: { status: 'ready' | 'reconnect_required' | 'blocked'; reason: string | null };
  can_prepare: boolean; can_send: boolean; can_recheck: boolean; can_reconnect: boolean;
  blockers: string[]; ordinary_writer_enabled: false;
  result: { work_order_id: string | null; work_order_code: string | null;
    draft_snapshot_matches: boolean; task_count: number | null; inventory_change_count: number | null;
    review_required: boolean; blocker: string | null } | null;
};

const states: ExactDraftState[] = ['unprepared', 'prepared', 'sending', 'uncertain', 'readback_pending', 'review', 'draft_observed'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isExactDraftRequestUid(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostic response');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 200): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid diagnostic response');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid diagnostic response');
  return value;
}
function nullableText(value: unknown): string | null { return value == null ? null : text(value); }
function nullableInstant(value: unknown): string | null {
  const result = nullableText(value);
  if (result && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result)))) {
    throw new Error('Invalid diagnostic instant');
  }
  return result;
}
function count(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid diagnostic count');
  return value as number;
}

export function parseExactDraftSnapshot(raw: unknown): ExactDraftSnapshot {
  const data = object(raw), scope = object(data.scope), approval = object(data.approval);
  const supply = object(data.app_supply), connection = object(data.connection);
  if (data.code !== EXACT_DRAFT_CODE || scope.material_code !== '0' || scope.quantity !== '1'
    || scope.unit_name !== '个' || scope.status !== 0 || scope.planned_start !== EXACT_DRAFT_START
    || scope.planned_end !== EXACT_DRAFT_END || scope.resource_assigned !== false
    || scope.inputs_assigned !== false || scope.processes_assigned !== false
    || data.ordinary_writer_enabled !== false || approval.max_attempts !== 1 || approval.app_max_attempts !== 1
    || ![0, 1].includes(approval.app_attempt as number)
    || !states.includes(data.state as ExactDraftState) || ![0, 1].includes(data.attempt as number)
    || !['ready', 'reconnect_required', 'blocked'].includes(connection.status as string)) {
    throw new Error('Diagnostic scope mismatch');
  }
  const requestUid = data.request_uid === null ? null : text(data.request_uid);
  if ((requestUid && !isExactDraftRequestUid(requestUid)) || (data.state !== 'unprepared' && !requestUid)
    || !Array.isArray(data.blockers) || data.blockers.length > 40
    || typeof supply.usable_for_seconds !== 'number' || !Number.isFinite(supply.usable_for_seconds)
    || supply.usable_for_seconds < 0) throw new Error('Invalid diagnostic state');
  let result: ExactDraftSnapshot['result'] = null;
  if (data.result != null) {
    const item = object(data.result), id = nullableText(item.work_order_id);
    if (id && !/^\d{1,128}$/.test(id)) throw new Error('Invalid MES identifier');
    if (item.work_order_code != null && item.work_order_code !== EXACT_DRAFT_CODE) throw new Error('Mixed diagnostic result');
    result = { work_order_id: id, work_order_code: nullableText(item.work_order_code),
      draft_snapshot_matches: item.draft_snapshot_matches === true,
      task_count: count(item.task_count), inventory_change_count: count(item.inventory_change_count),
      review_required: item.review_required === true, blocker: nullableText(item.blocker) };
  }
  return {
    code: EXACT_DRAFT_CODE,
    scope: { material_code: '0', quantity: '1', unit_name: '个', status: 0,
      planned_start: EXACT_DRAFT_START, planned_end: EXACT_DRAFT_END,
      resource_assigned: false, inputs_assigned: false, processes_assigned: false },
    state: data.state as ExactDraftState, request_uid: requestUid, attempt: data.attempt as 0 | 1,
    approval: { reference: text(approval.reference), approved_at: nullableInstant(approval.approved_at),
      expires_at: nullableInstant(approval.expires_at), active: bool(approval.active), expired: bool(approval.expired),
      max_attempts: 1, app_max_attempts: 1, app_attempt: approval.app_attempt as 0 | 1 },
    app_supply: { available: bool(supply.available), usable_for_seconds: supply.usable_for_seconds,
      supply_mode: text(supply.supply_mode) },
    connection: { status: connection.status as ExactDraftSnapshot['connection']['status'], reason: nullableText(connection.reason) },
    can_prepare: bool(data.can_prepare), can_send: bool(data.can_send), can_recheck: bool(data.can_recheck),
    can_reconnect: bool(data.can_reconnect),
    blockers: data.blockers.map(value => text(value, 120)), ordinary_writer_enabled: false, result,
  };
}

export function exactDraftPermitUsable(data: ExactDraftSnapshot, now: number): boolean {
  const start = Date.parse(data.approval.approved_at || ''), end = Date.parse(data.approval.expires_at || '');
  return data.approval.active && !data.approval.expired && Boolean(data.approval.reference.trim())
    && Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(now)
    && start <= now && now < end && end > start && end - start <= EXACT_DRAFT_MAX_MS;
}

export function exactDraftAttemptKey(sessionId: string, requestUid: string): string {
  return `${sessionId}:${requestUid}`;
}

export function exactDraftActions(data: ExactDraftSnapshot | null, now: number, locallyAttempted: boolean,
  ready: boolean): { prepare: boolean; send: boolean; recheck: boolean; reconnect: boolean } {
  const base = Boolean(data && ready);
  return {
    prepare: Boolean(base && data!.can_prepare && data!.attempt === 0 && !locallyAttempted
      && ['unprepared', 'prepared'].includes(data!.state) && !data!.approval.approved_at
      && !data!.approval.expires_at && !data!.approval.active),
    send: Boolean(base && data!.can_send && data!.state === 'prepared' && data!.request_uid
      && data!.attempt === 0 && !locallyAttempted && exactDraftPermitUsable(data!, now)
      && data!.connection.status === 'ready' && data!.app_supply.available),
    recheck: Boolean(base && data!.can_recheck && data!.request_uid && data!.attempt === 1
      && ['sending', 'uncertain', 'readback_pending', 'review'].includes(data!.state)),
    reconnect: Boolean(base && data!.can_reconnect && data!.request_uid && data!.attempt === 0
      && !locallyAttempted && data!.approval.app_attempt === 0 && exactDraftPermitUsable(data!, now)),
  };
}

export const exactDraftMessages: Record<string, [string, string]> = {
  unprepared: ['permit 준비 전', '尚未准备许可'], prepared: ['단건 전송 준비', '单次发送准备'],
  sending: ['전송 결과 확인 중', '正在核对发送结果'], uncertain: ['결과 불확실 · 재조회 필요', '结果不确定 · 需复查'],
  readback_pending: ['읽기 확인 대기', '等待读回确认'], review: ['결과 검토 필요', '需审核结果'],
  draft_observed: ['MES draft 확인됨', '已核对 MES 草稿'],
  app_supply_missing: ['기존 APP 공급이 필요합니다.', '需要现有 APP 供应。'],
  credential_binding_unverified: ['기존 MES 계정 연결 확인이 필요합니다.', '需要核对现有 MES 账号绑定。'],
  credential_binding_blocked: ['기존 MES 계정 연결 확인이 필요합니다.', '需要核对现有 MES 账号绑定。'],
  app_missing: ['기존 APP 공급이 필요합니다.', '需要现有 APP 供应。'],
  reconnect_required: ['permit 준비 후 정상 MES 연결에서 다시 연결하세요.', '准备许可后，请通过正常 MES 连接重新连接。'],
  permission_denied: ['이 계정의 단건 진단 권한을 확인하세요.', '请确认此账号的单工单诊断权限。'],
  operation_unconfirmed: ['결과를 확인하지 못했습니다. 읽기 상태를 확인하세요.', '未能确认结果。请读取状态。'],
};

export function exactDraftLabel(code: string, language: 'ko' | 'zh'): string {
  return (exactDraftMessages[code] || exactDraftMessages.operation_unconfirmed)[language === 'ko' ? 0 : 1];
}
