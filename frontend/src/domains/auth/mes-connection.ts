// Metadata and an in-memory launch ticket only. Never persist or log a ticket.
export const MES_SESSION_SUBMIT_URL = 'https://wj-reporting-backend.onrender.com/integrations/blacklake/session/';

export type MesLoginHint = {
  factory_number: string;
  account_name: string;
  prefill_supported: false;
};

export type MesConnectionStatus = {
  enabled: boolean;
  status: 'disabled' | 'disconnected' | 'connected' | 'reconnect_required' | 'blocked';
  reason: string;
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
    reason: data.reason, expires_at: data.expires_at as string | null,
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
