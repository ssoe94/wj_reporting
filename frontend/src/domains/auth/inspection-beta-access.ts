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

export type InspectionAccess = {
  can_view: boolean; can_manage: boolean; can_submit: boolean; can_review: boolean;
  access_scope: 'all' | 'assigned_only'; can_view_kanban: boolean;
};

export function parseInspectionAccess(value: unknown): InspectionAccess | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (['can_view', 'can_manage', 'can_submit', 'can_review', 'can_view_kanban'].some(key => typeof data[key] !== 'boolean')
    || (data.access_scope !== 'all' && data.access_scope !== 'assigned_only')
    || (data.access_scope === 'assigned_only' && (data.can_view_kanban || data.can_review))) return null;
  return { can_view: data.can_view as boolean, can_manage: data.can_manage as boolean,
    can_submit: data.can_submit as boolean, can_review: data.can_review as boolean,
    access_scope: data.access_scope as InspectionAccess['access_scope'], can_view_kanban: data.can_view_kanban as boolean };
}

export function canUseInspectionBeta(user: { id?: number; is_active?: boolean } | null | undefined, access: InspectionAccess | null = null): boolean {
  return Boolean(user && Number.isSafeInteger(user.id) && Number(user.id) > 0 && user.is_active !== false && parseInspectionAccess(access)?.can_view === true);
}
