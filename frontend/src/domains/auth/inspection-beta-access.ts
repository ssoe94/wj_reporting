export const INSPECTION_BETA_PATH = '/quality/inspection-requests';

export function isInspectionBetaRoute(route: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(route.split(/[?#]/)[0]).toLowerCase();
  } catch {
    return false;
  }
  return path === INSPECTION_BETA_PATH || path.startsWith(`${INSPECTION_BETA_PATH}/`);
}

export function canUseInspectionBeta(user: { is_superuser?: boolean; is_active?: boolean } | null | undefined): boolean {
  return user?.is_superuser === true && user.is_active !== false;
}
