type GrantActor = { is_superuser?: boolean; is_active?: boolean } | null | undefined;
type GrantTarget = { is_superuser?: boolean; can_manage_hr?: boolean };

export function canSetHrPermission(actor: GrantActor): boolean {
  return actor?.is_superuser === true && actor.is_active !== false;
}

/** Never submit a disabled or unchanged HR toggle alongside routine account edits. */
export function hrPermissionPayload<T extends { can_manage_hr: boolean }>(permissions: T, actor: GrantActor, target?: GrantTarget): Omit<T, 'can_manage_hr'> & { can_manage_hr?: boolean } {
  const { can_manage_hr, ...ordinary } = permissions;
  if (!canSetHrPermission(actor) || target?.is_superuser || (target && can_manage_hr === Boolean(target.can_manage_hr))) return ordinary;
  return { ...ordinary, can_manage_hr };
}
