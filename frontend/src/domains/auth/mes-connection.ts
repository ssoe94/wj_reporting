// Metadata and an in-memory launch ticket only. Never persist or log a ticket.
export const MES_SESSION_SUBMIT_URL = 'https://wj-reporting-backend.onrender.com/integrations/blacklake/session/';

export type MesLoginHint = {
  factory_number: string;
  account_name: string;
  prefill_supported: false;
};

// Fixed server reason vocabulary only. Provider text and unknown future values
// must never become UI text, diagnostic codes, or retained status metadata.
const reasonCategories = {
  connection_missing: 'normal', metadata_valid: 'normal',
  connection_disabled: 'disabled', continuity_disabled: 'disabled', storage_disabled: 'disabled',
  new_login_required: 'wjLogin', local_login_required: 'wjLogin', login_unavailable: 'wjLogin',
  legacy_login_required: 'legacyLogin',
  http_scheme_untrusted: 'securePath', secure_origin_required: 'securePath',
  debug_enabled: 'security', insecure_session_cookie: 'security', insecure_csrf_cookie: 'security',
  session_cookie_httponly_required: 'security', session_cookie_samesite_invalid: 'security',
  session_cookie_domain_invalid: 'security', csrf_cookie_domain_invalid: 'security',
  session_backend_invalid: 'security',
  connection_configuration_unreviewed: 'configuration', callback_origin_unverified: 'configuration',
  provider_origin_unverified: 'configuration', app_credential_missing: 'configuration',
  oauth_configuration_unreviewed: 'configuration',
  account_unavailable: 'accountOrSecurity',
  admin_staff_required: 'adminRole', account_role_required: 'role',
  account_inactive: 'inactive', restricted_identity: 'restricted',
  user_profile_required: 'actor', actor_unavailable: 'actor', actor_invalid: 'actor', actor_ineligible: 'actor',
  password_change_required: 'passwordChange',
  identity_mapping_unverified: 'mapping', identity_mismatch: 'identityMismatch',
  identity_unverified: 'identityUnverified',
  storage_policy_unreviewed: 'policy', policy_invalid: 'policy', policy_unreviewed: 'policy',
  expiry_contract_unverified: 'expiryPolicy', expiry_value_invalid: 'expiryPolicy',
  vault_key_unavailable: 'storage',
  operation_unapproved: 'operation',
  clock_invalid: 'clock', connection_clock_invalid: 'clock', exchange_clock_invalid: 'clock',
  connection_invalid: 'connection', credential_invalid: 'connection', credential_unreadable: 'connection',
  connection_revoked: 'revoked', session_changed: 'session', authorization_changed: 'authorization',
  review_changed: 'review',
  provider_token_expired: 'expired', consent_expired: 'expired', connection_expired: 'expired',
  credential_expired: 'expired', connection_idle: 'idle',
  provider_temporarily_unavailable: 'provider',
  connection_unavailable: 'unknown', unknown: 'unknown',
} as const;

export type MesConnectionReason = keyof typeof reasonCategories;

function parseMesConnectionReason(value: unknown): MesConnectionReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(reasonCategories, value)
    ? value as MesConnectionReason : 'unknown';
}

const reasonMessages = {
  disabled: ['MES 연결 기능이 현재 꺼져 있습니다. 관리자에게 연결 설정을 확인해 주세요.', 'MES 连接功能当前未启用。请联系管理员检查连接设置。'],
  wjLogin: ['현재 WJ 로그인으로 MES 연결을 시작할 수 없습니다. WJ에 다시 로그인한 뒤 상태를 확인해 주세요.', '当前 WJ 登录无法用于建立 MES 连接。请重新登录 WJ 后检查状态。'],
  legacyLogin: ['현재 WJ 로그인에 MES 연결용 세션 정보가 없습니다. 본인 WJ 계정으로 새로 로그인한 뒤 연결 상태를 확인해 주세요.', '当前 WJ 登录缺少连接 MES 所需的会话信息。请使用本人的 WJ 账号重新登录后检查连接状态。'],
  securePath: ['안전한 접속 경로를 서버에서 확인하지 못했습니다. 관리자에게 접속 보안 설정을 확인해 주세요.', '服务器无法确认安全的访问路径。请联系管理员检查访问安全设置。'],
  security: ['MES 연결에 필요한 서버 보안 설정이 충족되지 않았습니다. 관리자에게 설정 확인을 요청해 주세요.', '服务器未满足 MES 连接所需的安全设置。请联系管理员检查设置。'],
  configuration: ['MES 로그인 서버 설정을 확인할 수 없습니다. 관리자에게 연결 설정 확인을 요청해 주세요.', '无法确认 MES 登录服务设置。请联系管理员检查连接设置。'],
  accountOrSecurity: ['현재 WJ 계정 또는 접속 보안 조건을 확인할 수 없습니다. 관리자에게 확인을 요청해 주세요.', '无法确认当前 WJ 账号或访问安全条件。请联系管理员检查。'],
  adminRole: ['현재 WJ 관리자 계정에 MES 연결에 필요한 권한 설정이 빠져 있습니다. 관리자에게 계정 권한을 확인해 주세요.', '当前 WJ 管理员账号缺少连接 MES 所需的权限设置。请联系管理员检查账号权限。'],
  role: ['현재 WJ 계정이 MES 연결에 허용된 관리자 또는 검사 담당자 조건을 충족하지 않습니다. 관리자에게 계정 권한을 확인해 주세요.', '当前 WJ 账号不满足已批准的管理员或检验员连接条件。请联系管理员检查账号权限。'],
  inactive: ['현재 WJ 계정이 활성 상태가 아닙니다. 관리자에게 계정 상태를 확인해 주세요.', '当前 WJ 账号未处于启用状态。请联系管理员检查账号状态。'],
  restricted: ['현재 WJ 계정은 MES 연결이 제한된 계정입니다. 관리자에게 계정 상태를 확인해 주세요.', '当前 WJ 账号的 MES 连接受到限制。请联系管理员检查账号状态。'],
  actor: ['현재 WJ 계정의 MES 연결 조건을 확인할 수 없습니다. 관리자에게 계정 설정을 확인해 주세요.', '无法确认当前 WJ 账号是否满足 MES 连接条件。请联系管理员检查账号设置。'],
  passwordChange: ['현재 WJ 계정의 비밀번호 변경이 필요합니다. WJ에서 비밀번호를 변경한 뒤 연결 상태를 확인해 주세요.', '当前 WJ 账号需要修改密码。请在 WJ 修改密码后检查连接状态。'],
  mapping: ['현재 WJ 계정에 연결할 MES 계정을 확인할 수 없습니다. 관리자에게 계정 연결 설정을 확인해 주세요.', '无法确认与当前 WJ 账号对应的 MES 账号。请联系管理员检查账号关联设置。'],
  identityMismatch: ['저장된 MES 계정이 현재 WJ 계정의 연결 정보와 일치하지 않습니다. 관리자에게 계정 연결 설정을 확인해 주세요.', '已保存的 MES 账号与当前 WJ 账号的关联信息不一致。请联系管理员检查账号关联设置。'],
  identityUnverified: ['MES 계정 확인이 완료되지 않았습니다. 관리자에게 연결 상태를 확인해 주세요.', 'MES 账号验证尚未完成。请联系管理员检查连接状态。'],
  policy: ['MES 연결 유지·만료 정책을 확인할 수 없습니다. 관리자에게 정책 설정을 확인해 주세요.', '无法确认 MES 连接保持及有效期策略。请联系管理员检查策略设置。'],
  expiryPolicy: ['MES 연결의 유효기간 기준을 확인할 수 없습니다. 관리자에게 만료 정책을 확인해 주세요.', '无法确认 MES 连接的有效期规则。请联系管理员检查过期策略。'],
  storage: ['MES 연결 정보를 안전하게 보관하는 설정을 확인할 수 없습니다. 관리자에게 확인을 요청해 주세요.', '无法确认安全保存 MES 连接信息所需的设置。请联系管理员检查。'],
  operation: ['이 작업에 MES 연결을 사용할 권한이 확인되지 않았습니다. 관리자에게 확인을 요청해 주세요.', '尚未确认在此操作中使用 MES 连接的权限。请联系管理员检查。'],
  clock: ['MES 연결의 시간 정보를 확인할 수 없습니다. 관리자에게 서버 시간과 연결 기록을 확인해 주세요.', '无法确认 MES 连接的时间信息。请联系管理员检查服务器时间和连接记录。'],
  connection: ['저장된 MES 연결 정보를 확인할 수 없습니다. 관리자에게 연결 상태를 확인해 주세요.', '无法确认已保存的 MES 连接信息。请联系管理员检查连接状态。'],
  revoked: ['이 MES 연결은 해제되었습니다. MES 계정을 다시 연결해 주세요.', '此 MES 连接已断开。请重新连接 MES 账号。'],
  session: ['현재 WJ 로그인에 MES 계정을 다시 연결해야 합니다. MES 연결을 준비해 주세요.', '需要为当前 WJ 登录重新连接 MES 账号。请准备 MES 连接。'],
  authorization: ['WJ 계정 권한이 변경되어 MES 계정을 다시 연결해야 합니다.', 'WJ 账号权限已变更，需要重新连接 MES 账号。'],
  review: ['MES 연결 정책이 변경되어 MES 계정을 다시 연결해야 합니다.', 'MES 连接策略已变更，需要重新连接 MES 账号。'],
  expired: ['MES 연결이 만료되었거나 곧 만료됩니다. MES 계정을 다시 연결해 주세요.', 'MES 连接已过期或即将过期。请重新连接 MES 账号。'],
  idle: ['MES 연결의 미사용 유효시간이 지났거나 곧 종료됩니다. MES 계정을 다시 연결해 주세요.', 'MES 连接的闲置有效期已结束或即将结束。请重新连接 MES 账号。'],
  provider: ['MES 응답을 확인할 수 없습니다. 잠시 후 상태를 다시 확인해 주세요.', '无法确认 MES 响应。请稍后重新检查状态。'],
  unknown: ['MES 연결의 상세 사유를 확인할 수 없습니다. 상태를 다시 확인하고 문제가 계속되면 진단코드를 관리자에게 전달해 주세요.', '无法确认 MES 连接的具体原因。请重新检查状态；若问题持续，请将诊断代码提供给管理员。'],
} as const;

export function mesConnectionDiagnostic(reason: unknown, lang: 'ko' | 'zh') {
  const safeReason = parseMesConnectionReason(reason);
  const category = reasonCategories[safeReason];
  if (category === 'normal') return null;
  return {
    code: `MES-CONN-${safeReason.toUpperCase().replaceAll('_', '-')}`,
    message: reasonMessages[category][lang === 'ko' ? 0 : 1],
  };
}

export type MesConnectionStatus = {
  enabled: boolean;
  status: 'disabled' | 'disconnected' | 'connected' | 'reconnect_required' | 'blocked';
  reason: MesConnectionReason;
  expires_at: string | null;
  can_connect: boolean;
  can_disconnect: boolean;
  mode: 'identity_only' | 'stored_identity';
  live_ready: false;
  login_hint: MesLoginHint | null;
};

// Display/copy metadata only. It never selects an actor or enters the launch
// request; the server still verifies the provider identity against its mapping.
export function parseMesLoginHint(value: unknown): MesLoginHint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hint = value as Record<string, unknown>;
  if (typeof hint.factory_number !== 'string' || !/^[0-9]{1,20}$/.test(hint.factory_number)
    || typeof hint.account_name !== 'string' || !/^[A-Za-z0-9._@-]{1,80}$/.test(hint.account_name)
    || hint.prefill_supported !== false) return null;
  return { factory_number: hint.factory_number, account_name: hint.account_name, prefill_supported: false };
}

export type MesLaunch = {
  ticket: string;
  submitUrl: string;
  sessionId: string;
  expiresAt: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid MES connection response');
  }
  return value as Record<string, unknown>;
}

export function parseMesConnectionStatus(value: unknown): MesConnectionStatus {
  const data = record(value);
  if (typeof data.enabled !== 'boolean'
    || typeof data.status !== 'string'
    || !['disabled', 'disconnected', 'connected', 'reconnect_required', 'blocked'].includes(data.status)
    || typeof data.reason !== 'string' || data.reason.length > 128
    || typeof data.can_connect !== 'boolean' || typeof data.can_disconnect !== 'boolean'
    || typeof data.mode !== 'string' || !['identity_only', 'stored_identity'].includes(data.mode)
    || data.live_ready !== false
    || !(data.expires_at === null || (typeof data.expires_at === 'string'
      && data.expires_at.length <= 64 && Number.isFinite(Date.parse(data.expires_at))))) {
    throw new Error('Invalid MES connection response');
  }
  return {
    enabled: data.enabled, status: data.status as MesConnectionStatus['status'],
    reason: parseMesConnectionReason(data.reason), expires_at: data.expires_at as string | null,
    can_connect: data.can_connect, can_disconnect: data.can_disconnect,
    mode: data.mode as MesConnectionStatus['mode'], live_ready: false,
    login_hint: parseMesLoginHint(data.login_hint),
  };
}

export function parseMesLaunch(value: unknown, sessionId: string, startedAt: number): MesLaunch {
  const data = record(value);
  if (data.submit_url !== MES_SESSION_SUBMIT_URL
    || typeof data.ticket !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(data.ticket)
    || !Number.isInteger(data.expires_in) || (data.expires_in as number) < 1 || (data.expires_in as number) > 60
    || typeof sessionId !== 'string' || !sessionId
    || !Number.isFinite(startedAt) || startedAt < 0) {
    throw new Error('Invalid MES connection response');
  }
  const expiresAt = startedAt + (data.expires_in as number) * 1000;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid MES connection response');
  return { ticket: data.ticket, submitUrl: MES_SESSION_SUBMIT_URL, sessionId, expiresAt };
}

export function isMesLaunchUsable(launch: MesLaunch | null, currentSessionId: string | null, now: number): boolean {
  return Boolean(launch && currentSessionId && launch.sessionId === currentSessionId
    && launch.submitUrl === MES_SESSION_SUBMIT_URL
    && Number.isFinite(now) && now >= launch.expiresAt - 60_000 && now < launch.expiresAt);
}

export function isDisconnectConfirmed(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).disconnected === true);
}
