export const HR_PERSONNEL_PATH = '/hr/personnel';
export const HR_DAILY_WORK_PATH = '/hr/daily-work';
export const HR_ROSTER_PATH = '/hr/roster';
export const HR_LABOR_STANDARDS_PATH = '/hr/labor-standards';
export const HR_LABOR_COST_PATH = '/hr/labor-cost';

export function isHrRoute(route: string): boolean {
  try {
    const path = decodeURIComponent(route.split(/[?#]/)[0]).toLowerCase();
    return path === '/hr' || path.startsWith('/hr/');
  } catch {
    return false;
  }
}

export function canAccessHr(user: { is_superuser?: boolean; can_access_hr?: boolean; is_active?: boolean } | null | undefined): boolean {
  return Boolean(user && user.is_active !== false && (user.is_superuser === true || user.can_access_hr === true));
}
