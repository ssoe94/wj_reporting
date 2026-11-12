import type { HrRosterEntry, HrRosterHistory } from './workbook-types.ts';

export type RosterFilter = { search: string; kind: string; status: string; absent: boolean };
export function filterRoster(entries: HrRosterEntry[], filter: RosterFilter) {
  const normalized = (value: string) => value.trim().normalize('NFC').toLowerCase();
  const query = normalized(filter.search);
  return entries.filter((item) => (!filter.kind || item.employment_type === filter.kind)
    && (!filter.status || item.status === filter.status) && (!filter.absent || !item.in_month)
    && [item.code, item.name, ...item.previous_codes].some((value) => normalized(value).includes(query)));
}
export function rosterCounts(entries: HrRosterEntry[]) {
  return { active: entries.filter((item) => item.status === 'active').length,
    departed: entries.filter((item) => item.status === 'departed').length,
    absent: entries.filter((item) => !item.in_month).length };
}
export function rosterHistoryChanges(item: HrRosterHistory) {
  return (['code', 'status', 'employment_type', 'department'] as const).flatMap((field) => {
    const before = item[`previous_${field}`]; const after = item[`new_${field}`];
    return before !== after ? [{ field, before, after }] : [];
  });
}
