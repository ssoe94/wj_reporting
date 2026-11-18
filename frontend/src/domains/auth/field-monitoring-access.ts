export const FIELD_MONITORING_PATH = '/injection/field-monitoring';

export function isFieldMonitoringRoute(route: string) {
  try {
    const path = decodeURIComponent(route.split(/[?#]/)[0]);
    return path.replace(/\/+$/, '').toLowerCase() === FIELD_MONITORING_PATH;
  } catch {
    return false;
  }
}

type FieldMonitoringUser = {
  is_active?: boolean;
  is_superuser?: boolean;
  can_access_field_monitoring?: boolean;
};

export function canAccessFieldMonitoring(user: FieldMonitoringUser | null | undefined) {
  return !!user && user.is_active !== false && (
    user.is_superuser === true || user.can_access_field_monitoring === true
  );
}
