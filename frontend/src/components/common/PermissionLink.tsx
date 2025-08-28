import React, { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { UserPermissions } from '../../contexts/AuthContext';

interface PermissionLinkProps {
  to: string;
  permission?: keyof UserPermissions;
  requiredPermissions?: (keyof UserPermissions)[];
  requireAll?: boolean;
  children: ReactNode;
  className?: string;
  activeClassName?: string;
  showTooltip?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}

const PermissionLink: React.FC<PermissionLinkProps> = ({
  to,
  permission,
  requiredPermissions = [],
  requireAll = false,
  children,
  className = '',
  activeClassName = '',
  showTooltip = true,
  onClick,
}) => {
  const { hasPermission, user, canAccessRoute } = useAuth();
  const navigate = useNavigate();

  // 권한 확인
  const checkPermissions = (): boolean => {
    if (user?.is_staff) return true;

    const allPermissions = permission ? [permission, ...requiredPermissions] : requiredPermissions;
    
    if (allPermissions.length === 0) return canAccessRoute(to);

    if (requireAll) {
      return allPermissions.every(perm => hasPermission(perm));
    } else {
      return allPermissions.some(perm => hasPermission(perm));
    }
  };

  const hasRequiredPermission = checkPermissions();

  const handleClick = (e: React.MouseEvent) => {
    if (!hasRequiredPermission) {
      e.preventDefault();
      const message = user?.username?.includes('chinese') || user?.department?.includes('中') 
        ? '您没有访问此页面的权限' 
        : '이 페이지에 접근할 권한이 없습니다';
      alert(message);
      return;
    }
    onClick?.(e);
  };

  // 스타일 적용
  const linkClassName = `
    ${hasRequiredPermission 
      ? `${className} ${activeClassName}` 
      : `${className.replace(/text-\w+-\d+/g, 'text-gray-400')} cursor-not-allowed opacity-60`
    }
    transition-all duration-200 ease-in-out
  `;

  if (!hasRequiredPermission) {
    return (
      <span 
        className={linkClassName}
        onClick={handleClick}
        title={showTooltip ? 
          (user?.username?.includes('chinese') || user?.department?.includes('中') 
            ? '您没有访问此页面的权限' 
            : '이 페이지에 접근할 권한이 없습니다'
          ) : undefined}
      >
        {children}
      </span>
    );
  }

  return (
    <Link 
      to={to} 
      className={linkClassName}
      onClick={handleClick}
    >
      {children}
    </Link>
  );
};

export default PermissionLink;