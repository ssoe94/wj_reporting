import { useAuth as useMainAuth } from '@/contexts/AuthContext';
import type { AppCapability } from '@/domains/auth/types';

export function useAuth() {
  const auth = useMainAuth();

  const hasCapability = (capability: AppCapability) => {
    if (auth.user?.is_staff || auth.hasPermission('is_admin')) return true;

    switch (capability) {
      case 'injection.write':
        return auth.hasPermission('can_edit_injection');
      case 'mould.confirm':
        return auth.hasPermission('can_confirm_moulds');
      case 'inventory.write':
        return auth.hasPermission('can_edit_inventory');
      case 'assembly.write':
        return auth.hasPermission('can_edit_assembly');
      case 'quality.write':
        return auth.hasPermission('can_edit_quality');
      case 'eco.write':
        return auth.hasPermission('can_edit_eco');
      case 'admin.users.manage':
        return auth.hasPermission('is_admin');
      default:
        return Boolean(auth.user);
    }
  };

  return { ...auth, hasCapability };
}
