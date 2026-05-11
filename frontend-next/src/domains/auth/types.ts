export type AppCapability =
  | "analysis.read"
  | "production.read"
  | "production.write"
  | "injection.read"
  | "injection.write"
  | "assembly.read"
  | "assembly.write"
  | "quality.read"
  | "quality.write"
  | "inventory.read"
  | "inventory.write"
  | "eco.read"
  | "eco.write"
  | "admin.users.manage"
  | "field.station.access";

export type UserPermissions = {
  can_view_injection: boolean;
  can_view_assembly: boolean;
  can_view_quality: boolean;
  can_view_sales: boolean;
  can_view_development: boolean;
  can_edit_injection: boolean;
  can_edit_assembly: boolean;
  can_edit_quality: boolean;
  can_edit_sales: boolean;
  can_edit_development: boolean;
  is_admin: boolean;
  can_edit_machining?: boolean;
  can_edit_eco?: boolean;
  can_edit_inventory?: boolean;
};

export type CurrentUser = {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  groups: string[];
  department?: string;
  is_using_temp_password?: boolean;
  password_reset_required?: boolean;
  permissions?: UserPermissions;
};

export type LoginPayload = {
  username: string;
  password: string;
};

export type TokenPair = {
  access: string;
  refresh: string;
};
