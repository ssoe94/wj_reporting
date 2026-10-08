import type { InspectionRoleCandidate, InspectionRoleSetting } from './roleModel';
import { createInspectionKey } from './workflow';

export const SHIFT_TIMEZONE = 'Asia/Shanghai';
export type RoleShiftDraft = {
  code: string; label: string; timezone: string; start_time: string; end_time: string;
  effective_from_local: string; effective_until_local: string;
  appearance_assignee: string; dimension_assignee: string; active: boolean; reason: string;
};
export type RoleShiftPreset = 'day' | 'night' | 'custom';
export function roleShiftPresetTimes(preset: 'day' | 'night') {
  return { timezone: SHIFT_TIMEZONE, start_time: preset === 'day' ? '08:00' : '20:00', end_time: preset === 'day' ? '20:00' : '08:00' };
}

const localFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: SHIFT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function localParts(value: Date) {
  return Object.fromEntries(localFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
export function roleShiftLocalDateTime(utc: string | null | undefined): string {
  if (!utc || !Number.isFinite(Date.parse(utc))) return '';
  const parts = localParts(new Date(utc));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** Wall time is parsed in Shanghai, independently of the browser's timezone. */
export function roleShiftLocalInstant(local: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (year < 1 || year >= 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wall = new Date(0); wall.setUTCFullYear(year, month - 1, day); wall.setUTCHours(hour, minute, 0, 0);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) return null;
  let guess = wall.getTime() - 8 * 3_600_000;
  const parts = localParts(new Date(guess));
  const observed = new Date(0); observed.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day)); observed.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
  guess += wall.getTime() - observed.getTime();
  // Like the server, reject ambiguous historical overlaps and missing wall times.
  const choices = [guess - 3_600_000, guess, guess + 3_600_000].filter((instant) => {
    const candidate = localParts(new Date(instant));
    return `${candidate.year}-${candidate.month}-${candidate.day}T${candidate.hour}:${candidate.minute}` === local && candidate.second === '00';
  });
  return choices.length === 1 ? choices[0] : null;
}
export function createRoleShiftDraft(createKey = createInspectionKey, now = new Date()): RoleShiftDraft {
  const parts = localParts(now);
  return { code: `SHIFT-${parts.year}${parts.month}${parts.day}-${createKey()}`, label: '', ...roleShiftPresetTimes('day'), effective_from_local: '', effective_until_local: '', appearance_assignee: '', dimension_assignee: '', active: false, reason: '' };
}
export function roleShiftSettingDraft(setting: InspectionRoleSetting): RoleShiftDraft {
  return { code: setting.code, label: setting.label, timezone: setting.timezone, start_time: setting.start_time?.slice(0, 5) || '', end_time: setting.end_time?.slice(0, 5) || '',
    effective_from_local: setting.effective_from_local ?? roleShiftLocalDateTime(setting.effective_from), effective_until_local: setting.effective_until_local ?? roleShiftLocalDateTime(setting.effective_until),
    appearance_assignee: setting.appearance_assignee === null ? '' : String(setting.appearance_assignee), dimension_assignee: setting.dimension_assignee === null ? '' : String(setting.dimension_assignee), active: setting.active, reason: '' };
}
export function roleShiftDraftError(draft: RoleShiftDraft, candidates: InspectionRoleCandidate[]): string | null {
  if (!draft.label.trim() || draft.timezone !== SHIFT_TIMEZONE) return 'setting_invalid';
  if ([draft.start_time, draft.end_time].some((time) => time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return 'clock_invalid';
  const from = draft.effective_from_local ? roleShiftLocalInstant(draft.effective_from_local) : null;
  const until = draft.effective_until_local ? roleShiftLocalInstant(draft.effective_until_local) : null;
  if ((draft.effective_from_local && from === null) || (draft.effective_until_local && until === null)) return 'local_datetime_invalid';
  if (from !== null && until !== null && until <= from) return 'period_order';
  if ([draft.appearance_assignee, draft.dimension_assignee].some((value) => value && !candidates.some((actor) => String(actor.id) === value))) return 'actor_ineligible';
  if (draft.active) {
    if (!draft.start_time || !draft.end_time || draft.start_time === draft.end_time || !draft.appearance_assignee || !draft.dimension_assignee || draft.appearance_assignee === draft.dimension_assignee) return 'active_assignment_required';
    if (from === null) return 'effective_from_required';
    if (draft.effective_from_local.slice(11) !== draft.start_time) return 'effective_from_alignment';
    if (until !== null && ![draft.start_time, draft.end_time].includes(draft.effective_until_local.slice(11))) return 'effective_until_alignment';
  }
  return null;
}
export function roleShiftSettingPayload(draft: RoleShiftDraft, selected: InspectionRoleSetting | null): Record<string, unknown> {
  return { ...(selected ? { version: selected.version, reason: draft.reason.trim() } : { code: draft.code }), label: draft.label.trim(), timezone: SHIFT_TIMEZONE,
    start_time: draft.start_time || null, end_time: draft.end_time || null,
    effective_from_local: draft.effective_from_local || null, effective_until_local: draft.effective_until_local || null,
    appearance_assignee: draft.appearance_assignee ? Number(draft.appearance_assignee) : null, dimension_assignee: draft.dimension_assignee ? Number(draft.dimension_assignee) : null, active: draft.active };
}
/** Every minute of the selected daily/overnight shift must fit the stored period. */
export function roleShiftDateCovered(setting: InspectionRoleSetting, shiftDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate) || setting.timezone !== SHIFT_TIMEZONE || !setting.active || !setting.start_time || !setting.end_time || !setting.effective_from) return false;
  const start = setting.start_time.slice(0, 5); const end = setting.end_time.slice(0, 5);
  const from = roleShiftLocalInstant(`${shiftDate}T${start}`);
  if (from === null || start === end) return false;
  let endDate = shiftDate;
  if (end < start) {
    const next = new Date(`${shiftDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); endDate = next.toISOString().slice(0, 10);
  }
  const until = roleShiftLocalInstant(`${endDate}T${end}`);
  const effectiveFrom = Date.parse(setting.effective_from);
  const effectiveUntil = setting.effective_until ? Date.parse(setting.effective_until) : null;
  return until !== null && Number.isFinite(effectiveFrom) && from >= effectiveFrom && (effectiveUntil === null || (Number.isFinite(effectiveUntil) && until <= effectiveUntil));
}
export function roleShiftActorLabel(actor: InspectionRoleCandidate, lang: 'ko' | 'zh'): string {
  const username = actor.username || (lang === 'ko' ? '계정 식별 미확인' : '账号标识未确认');
  const mes = actor.mes_user_id || (lang === 'ko' ? '연결 미확인' : '关联未确认');
  return `${actor.name} · WJ ${username} (#${actor.id}) · MES USER ${mes}`;
}
