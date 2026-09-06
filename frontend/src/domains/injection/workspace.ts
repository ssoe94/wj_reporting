/** Shared read context for injection reports and equipment diagnostics. */
export type InjectionScope = { date: string; machineNumber: number | null };

export function resolveInjectionScope(search: string, currentDate: string): InjectionScope {
  const params = new URLSearchParams(search);
  const requested = params.get('date');
  const parsed = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? new Date(`${requested}T00:00:00Z`) : null;
  const date = requested && parsed && Number.isFinite(parsed.getTime())
    && !requested.startsWith('0000') && parsed.toISOString().slice(0, 10) === requested && requested <= currentDate ? requested : currentDate;
  const machine = params.get('machine');
  return { date, machineNumber: machine && /^(?:[1-9]|1[0-7])$/.test(machine) ? Number(machine) : null };
}

export function buildInjectionLink(path: string, scope: InjectionScope, hash = '') {
  const params = new URLSearchParams({ date: scope.date });
  if (scope.machineNumber !== null) params.set('machine', String(scope.machineNumber));
  return `${path}?${params}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
}

/** Prevent spreadsheet formula execution while preserving zero and missing values. */
export function injectionCsvCell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function createInjectionCsv(rows: Array<Array<string | number | null | undefined>>) {
  return `\uFEFF${rows.map((row) => row.map(injectionCsvCell).join(',')).join('\r\n')}\r\n`;
}
