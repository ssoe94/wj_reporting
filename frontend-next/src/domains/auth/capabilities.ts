import type { AppCapability, CurrentUser, UserPermissions } from "@/domains/auth/types";

function parseFieldTerminalUser(username?: string | null): boolean {
  const value = (username || "").trim().toLowerCase();
  return /^imm\d{2}$/.test(value) || /^assy\d{2}$/.test(value);
}

function hasPermission(
  permissions: UserPermissions | undefined,
  key: keyof UserPermissions,
): boolean {
  return Boolean(permissions?.[key]);
}

export function deriveCapabilities(user: CurrentUser | null): AppCapability[] {
  if (!user) return [];

  const capabilities = new Set<AppCapability>();
  const permissions = user.permissions;

  if (parseFieldTerminalUser(user.username)) {
    capabilities.add("field.station.access");
    return [...capabilities];
  }

  capabilities.add("analysis.read");
  capabilities.add("production.read");

  if (user.is_staff) {
    capabilities.add("production.write");
    capabilities.add("injection.read");
    capabilities.add("injection.write");
    capabilities.add("assembly.read");
    capabilities.add("assembly.write");
    capabilities.add("quality.read");
    capabilities.add("quality.write");
    capabilities.add("inventory.read");
    capabilities.add("inventory.write");
    capabilities.add("eco.read");
    capabilities.add("eco.write");
    capabilities.add("admin.users.manage");
    return [...capabilities];
  }

  if (hasPermission(permissions, "can_view_injection")) capabilities.add("injection.read");
  if (hasPermission(permissions, "can_edit_injection")) capabilities.add("injection.write");
  if (hasPermission(permissions, "can_view_assembly")) capabilities.add("assembly.read");
  if (hasPermission(permissions, "can_edit_assembly")) capabilities.add("assembly.write");
  if (hasPermission(permissions, "can_view_quality")) capabilities.add("quality.read");
  if (hasPermission(permissions, "can_edit_quality")) capabilities.add("quality.write");
  if (hasPermission(permissions, "can_view_sales")) capabilities.add("inventory.read");
  if (hasPermission(permissions, "can_edit_sales")) capabilities.add("inventory.write");
  if (hasPermission(permissions, "can_view_development")) capabilities.add("eco.read");
  if (hasPermission(permissions, "can_edit_development")) capabilities.add("eco.write");
  if (hasPermission(permissions, "is_admin")) capabilities.add("admin.users.manage");

  return [...capabilities];
}
