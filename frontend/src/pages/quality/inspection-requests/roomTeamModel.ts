import type { InspectionRoleSetting } from './roleModel';
import { roleShiftDateCovered, roleShiftLocalDateTime, roleShiftLocalInstant } from './roleShiftSettingsModel.ts';

/** Show only currently effective Shanghai shifts, including yesterday's night shift. */
export function currentInspectionShifts(settings: InspectionRoleSetting[], now: Date): InspectionRoleSetting[] {
  if (!Number.isFinite(now.getTime())) return [];
  const today = roleShiftLocalDateTime(now.toISOString()).slice(0, 10);
  const prior = new Date(`${today}T12:00:00Z`); prior.setUTCDate(prior.getUTCDate() - 1);
  return settings.filter((setting) => [today, prior.toISOString().slice(0, 10)].some((date) => {
    if (!roleShiftDateCovered(setting, date)) return false;
    const start = setting.start_time!.slice(0, 5); const end = setting.end_time!.slice(0, 5);
    const next = new Date(`${date}T12:00:00Z`); if (end < start) next.setUTCDate(next.getUTCDate() + 1);
    const from = roleShiftLocalInstant(`${date}T${start}`);
    const until = roleShiftLocalInstant(`${next.toISOString().slice(0, 10)}T${end}`);
    return from !== null && until !== null && now.getTime() >= from && now.getTime() < until;
  }));
}
