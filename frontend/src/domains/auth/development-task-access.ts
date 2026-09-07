export const DEVELOPMENT_TASK_PATH = '/admin/development-tasks';

export function isDevelopmentTaskRoute(route: string): boolean {
  let path: string;
  try {
    // Match React Router's decoded, case-insensitive paths before broad admin grants.
    path = decodeURIComponent(route.split(/[?#]/)[0]).toLowerCase();
  } catch {
    return false;
  }
  return path === DEVELOPMENT_TASK_PATH || path.startsWith(`${DEVELOPMENT_TASK_PATH}/`);
}

export function canManageDevelopmentTasks(user: { is_superuser?: boolean } | null | undefined): boolean {
  return user?.is_superuser === true;
}
