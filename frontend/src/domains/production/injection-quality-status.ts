/** Public, redacted board contract only. Never accepts MES IDs or grants editing. */
export interface ExpectedInjectionQualityScope {
  businessDate: string;
  machineNumber: number;
  currentPlanId: number | null;
  planVersion: string;
}

export type QualityCheckStatus = 'unknown' | 'waiting' | 'in_progress' | 'passed' | 'failed';
export type QualityFreshness = 'unavailable' | 'fresh' | 'stale' | 'fixture';
export type QualityWarning = 'snapshot_type_unverified' | 'duplicate_qc_evidence' |
  'plan_name_type_mismatch' | 'current_task_binding_unresolved' | 'read_scope_mismatch' |
  'periodic_series_unresolved' | 'quality_projection_unavailable';
export interface PublicQualityCheck {
  kind: 'first' | 'periodic' | 'production' | 'unknown';
  status: QualityCheckStatus;
  checked_at: string | null;
  warnings: QualityWarning[];
}
export interface PublicQualityGroup {
  status: QualityCheckStatus;
  last_known_status: QualityCheckStatus;
  checks: PublicQualityCheck[];
}
export interface PublicInjectionQuality {
  schema_version: 'injection-quality-status.v1';
  machine_number: number;
  business_date: string;
  current_plan_id: number | null;
  plan_version: string;
  binding_generation: number | null;
  read_generation: number;
  binding_status: 'verified' | 'unresolved';
  availability: 'ok' | 'error' | 'unavailable';
  freshness: QualityFreshness;
  fresh_until: string | null;
  last_attempt_started_at: string | null;
  last_attempt_completed_at: string | null;
  last_success_at: string | null;
  observed_at: string | null;
  refresh_after_seconds: number | null;
  complete: boolean;
  first: PublicQualityGroup;
  periodic: PublicQualityGroup & {
    last_checked_at: string | null;
    last_result: QualityCheckStatus;
    next_due_at: string | null;
    schedule_status: 'unverified' | 'unknown' | 'scheduled' | 'overdue';
  };
  other_checks: PublicQualityCheck[];
  warnings: QualityWarning[];
}

export interface InjectionQualityState {
  readonly scopeKey: string | null;
  readonly maxReadGeneration: number | null;
  readonly maxBindingGeneration: number | null;
  readonly data: PublicInjectionQuality | null;
}
export interface InjectionQualityView {
  data: PublicInjectionQuality | null;
  freshness: QualityFreshness;
  availability: PublicInjectionQuality['availability'];
  firstStatus: QualityCheckStatus;
  periodicStatus: QualityCheckStatus;
  scheduleStatus: PublicInjectionQuality['periodic']['schedule_status'];
  /** Counts are observations, not an assertion that historical failures remain current. */
  counts: Record<QualityCheckStatus, number>;
  historical: boolean;
}

const STATUSES = new Set(['unknown', 'waiting', 'in_progress', 'passed', 'failed']);
const WARNINGS = new Set(['snapshot_type_unverified', 'duplicate_qc_evidence',
  'plan_name_type_mismatch', 'current_task_binding_unresolved', 'read_scope_mismatch',
  'periodic_series_unresolved', 'quality_projection_unavailable']);
const VERSION = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;
const stamp = (value: unknown): value is string | null => value === null ||
  (typeof value === 'string' && ISO.test(value) && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value)));
const status = (value: unknown): value is QualityCheckStatus => typeof value === 'string' && STATUSES.has(value);
const day = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function injectionQualityScopeKey(scope: ExpectedInjectionQualityScope): string | null {
  if (!scope || !day(scope.businessDate) || !positive(scope.machineNumber) || scope.machineNumber > 17 ||
      (scope.currentPlanId !== null && !positive(scope.currentPlanId)) || !VERSION.test(scope.planVersion ?? '')) return null;
  return JSON.stringify([scope.businessDate, scope.machineNumber, scope.currentPlanId, scope.planVersion]);
}

function warnings(value: unknown): QualityWarning[] | null {
  return Array.isArray(value) && value.length <= 10 && value.every(item => typeof item === 'string' && WARNINGS.has(item))
    ? [...value] as QualityWarning[] : null;
}

function checks(value: unknown, kind?: 'first' | 'periodic'): PublicQualityCheck[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const parsed: PublicQualityCheck[] = [];
  for (const item of value) {
    if (!record(item) || !['first', 'periodic', 'production', 'unknown'].includes(String(item.kind)) ||
        (kind !== undefined && item.kind !== kind) || !status(item.status) || !stamp(item.checked_at)) return null;
    const alerts = warnings(item.warnings);
    if (alerts === null || ((item.status === 'passed' || item.status === 'failed') && item.checked_at === null)) return null;
    parsed.push({ kind: item.kind as PublicQualityCheck['kind'], status: item.status,
      checked_at: item.checked_at, warnings: alerts });
  }
  return parsed;
}

function group(value: unknown, kind: 'first' | 'periodic'): PublicQualityGroup | null {
  if (!record(value) || !status(value.status) || !status(value.last_known_status)) return null;
  const entries = checks(value.checks, kind);
  return entries === null ? null : { status: value.status, last_known_status: value.last_known_status, checks: entries };
}

/** Copies an explicit allowlist. Extra upstream properties never reach the view. */
export function parseInjectionQuality(payload: unknown, expected: ExpectedInjectionQualityScope): PublicInjectionQuality | null {
  if (!injectionQualityScopeKey(expected) || !record(payload) ||
      payload.schema_version !== 'injection-quality-status.v1' || payload.business_date !== expected.businessDate ||
      payload.machine_number !== expected.machineNumber || payload.current_plan_id !== expected.currentPlanId ||
      payload.plan_version !== expected.planVersion || !natural(payload.read_generation) ||
      (payload.binding_generation !== null && !natural(payload.binding_generation)) ||
      !['verified', 'unresolved'].includes(String(payload.binding_status)) ||
      !['ok', 'error', 'unavailable'].includes(String(payload.availability)) ||
      !['unavailable', 'fresh', 'stale', 'fixture'].includes(String(payload.freshness)) ||
      typeof payload.complete !== 'boolean' ||
      (payload.refresh_after_seconds !== null && (!positive(payload.refresh_after_seconds) || payload.refresh_after_seconds > 86400))) return null;
  const times = ['fresh_until', 'last_attempt_started_at', 'last_attempt_completed_at', 'last_success_at', 'observed_at'] as const;
  if (times.some(key => !stamp(payload[key]))) return null;
  const completed = payload.last_attempt_completed_at as string | null;
  const started = payload.last_attempt_started_at as string | null;
  const succeeded = payload.last_success_at as string | null;
  const projectionUnavailable = Array.isArray(payload.warnings) && payload.warnings.includes('quality_projection_unavailable') &&
    payload.binding_status === 'unresolved' && payload.freshness === 'unavailable' && !payload.complete && started === null && succeeded === null;
  if (payload.availability === 'ok' && completed === null) return null;
  if (payload.availability === 'error' && completed === null && !projectionUnavailable) return null;
  if (started !== null && (completed === null || Date.parse(started) > Date.parse(completed))) return null;
  if (succeeded !== null && (completed === null || Date.parse(succeeded) > Date.parse(completed))) return null;
  if (payload.availability === 'ok' && (succeeded === null || completed === null || Date.parse(succeeded) !== Date.parse(completed))) return null;
  const first = group(payload.first, 'first');
  const periodic = group(payload.periodic, 'periodic');
  const other = checks(payload.other_checks);
  const alerts = warnings(payload.warnings);
  if (first === null || periodic === null || other === null || alerts === null || !record(payload.periodic) ||
      first.checks.length + periodic.checks.length + other.length > 50 ||
      other.some(item => item.kind === 'first' || item.kind === 'periodic') ||
      !stamp(payload.periodic.last_checked_at) || !stamp(payload.periodic.next_due_at) ||
      !status(payload.periodic.last_result) ||
      !['unverified', 'unknown', 'scheduled', 'overdue'].includes(String(payload.periodic.schedule_status))) return null;
  if (payload.freshness === 'fresh' && (payload.binding_status !== 'verified' || payload.binding_generation === null ||
      payload.availability !== 'ok' || payload.fresh_until === null || payload.observed_at === null || payload.last_success_at === null)) return null;
  if (payload.binding_status === 'verified' && (expected.currentPlanId === null || payload.binding_generation === null)) return null;
  if (payload.binding_status === 'unresolved' && (first.checks.length || periodic.checks.length || other.length || payload.complete)) return null;
  if ((payload.periodic.schedule_status === 'scheduled' || payload.periodic.schedule_status === 'overdue') &&
      (payload.periodic.next_due_at === null || periodic.checks.length !== 1 || !payload.complete)) return null;
  return {
    schema_version: 'injection-quality-status.v1', business_date: expected.businessDate,
    machine_number: expected.machineNumber, current_plan_id: expected.currentPlanId, plan_version: expected.planVersion,
    binding_generation: payload.binding_generation as number | null, read_generation: payload.read_generation,
    binding_status: payload.binding_status as PublicInjectionQuality['binding_status'],
    availability: payload.availability as PublicInjectionQuality['availability'],
    freshness: payload.freshness as QualityFreshness, fresh_until: payload.fresh_until as string | null,
    last_attempt_started_at: payload.last_attempt_started_at as string | null,
    last_attempt_completed_at: payload.last_attempt_completed_at as string | null,
    last_success_at: payload.last_success_at as string | null, observed_at: payload.observed_at as string | null,
    refresh_after_seconds: payload.refresh_after_seconds as number | null, complete: payload.complete,
    first, periodic: { ...periodic, last_checked_at: payload.periodic.last_checked_at,
      last_result: payload.periodic.last_result, next_due_at: payload.periodic.next_due_at,
      schedule_status: payload.periodic.schedule_status as PublicInjectionQuality['periodic']['schedule_status'] },
    other_checks: other, warnings: alerts,
  };
}

/** Keep one state per machine. Invalid payload clears display but preserves this scope's high-water mark. */
export function reduceInjectionQuality(previous: InjectionQualityState | null | undefined, payload: unknown,
  expected: ExpectedInjectionQualityScope): InjectionQualityState {
  const scopeKey = injectionQualityScopeKey(expected);
  const prior = scopeKey !== null && previous?.scopeKey === scopeKey ? previous : null;
  const next = parseInjectionQuality(payload, expected);
  if (next === null) return { scopeKey, maxReadGeneration: prior?.maxReadGeneration ?? null,
    maxBindingGeneration: prior?.maxBindingGeneration ?? null, data: null };
  // A newer binding invalidates the old relation even if a collector violates
  // its monotonic read-generation contract. Quarantine instead of retaining an
  // old binding's fresh pass, and do not let a delayed old binding restore it.
  if (prior && prior.maxReadGeneration !== null && prior.maxBindingGeneration !== null &&
      next.binding_generation !== null && next.binding_generation > prior.maxBindingGeneration &&
      next.read_generation <= prior.maxReadGeneration) {
    return { scopeKey, maxReadGeneration: prior.maxReadGeneration,
      maxBindingGeneration: next.binding_generation, data: null };
  }
  // Each completed read generation is immutable; ties cannot overwrite its result.
  if (prior?.maxReadGeneration !== null && prior?.maxReadGeneration !== undefined && next.read_generation <= prior.maxReadGeneration) return prior;
  if (next.binding_generation !== null && prior?.maxBindingGeneration !== null && prior?.maxBindingGeneration !== undefined &&
      next.binding_generation < prior.maxBindingGeneration) return prior;
  return { scopeKey, maxReadGeneration: next.read_generation,
    maxBindingGeneration: next.binding_generation ?? prior?.maxBindingGeneration ?? null, data: next };
}

/** Expiry is derived from the server deadline; no client-side freshness interval is invented. */
export function deriveInjectionQuality(state: InjectionQualityState | null | undefined,
  expected: ExpectedInjectionQualityScope, nowMs: number, options: { transportError?: boolean } = {}): InjectionQualityView {
  const key = injectionQualityScopeKey(expected);
  const data = key !== null && state?.scopeKey === key ? state.data : null;
  const counts: InjectionQualityView['counts'] = { unknown: 0, waiting: 0, in_progress: 0, passed: 0, failed: 0 };
  if (data === null || !Number.isFinite(nowMs)) return { data: null, freshness: 'unavailable', availability: options.transportError ? 'error' : 'unavailable',
    firstStatus: 'unknown', periodicStatus: 'unknown', scheduleStatus: 'unverified', counts, historical: true };
  const fresh = !options.transportError && data.freshness === 'fresh' && data.fresh_until !== null && nowMs < Date.parse(data.fresh_until);
  const freshness = data.freshness === 'fresh' && !fresh ? 'stale' : data.freshness;
  for (const check of [...data.first.checks, ...data.periodic.checks, ...data.other_checks]) counts[check.status] += 1;
  // Even a malformed semantic aggregate must not promote incomplete/ambiguous evidence to a pass.
  const safeStatus = (value: PublicQualityGroup, multiplePeriodic = false): QualityCheckStatus => {
    if (!fresh || multiplePeriodic) return 'unknown';
    if (value.checks.some(check => check.status === 'failed')) return 'failed';
    if (!data.complete || !value.checks.length || value.checks.some(check => check.status === 'unknown')) return 'unknown';
    if (value.status === 'passed' && value.checks.some(check => check.status !== 'passed')) return 'unknown';
    return value.status;
  };
  let scheduleStatus = data.periodic.schedule_status;
  if (!fresh && (scheduleStatus === 'scheduled' || scheduleStatus === 'overdue')) scheduleStatus = 'unknown';
  else if (scheduleStatus === 'scheduled' && data.periodic.next_due_at && nowMs >= Date.parse(data.periodic.next_due_at)) scheduleStatus = 'overdue';
  return { data, freshness, availability: options.transportError ? 'error' : data.availability, firstStatus: safeStatus(data.first),
    periodicStatus: safeStatus(data.periodic, data.periodic.checks.length > 1), scheduleStatus, counts, historical: !fresh };
}
