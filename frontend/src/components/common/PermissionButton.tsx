import React from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import type { UserPermissions } from '../../contexts/AuthContext';
import { toast } from 'react-toastify';

interface PermissionButtonProps {
  permission?: keyof UserPermissions;
  requiredPermissions?: (keyof UserPermissions)[];
  requireAll?: boolean; // true면 모든 권한 필요, false면 하나라도 있으면 됨
  onlyStaff?: boolean; // true면 관리자(스태프)만 허용
  children: ReactNode;
  className?: string;
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  showTooltip?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

const PermissionButton: React.FC<PermissionButtonProps> = ({
  permission,
  requiredPermissions = [],
  requireAll = false,
  onlyStaff = false,
  children,
  className = '',
  onClick,
  disabled = false,
  showTooltip = true,
  type = 'button',
}) => {
  const { hasPermission, user } = useAuth();

  // 권한 확인
  const checkPermissions = (): boolean => {
    // 관리자 전용
    if (onlyStaff) return !!user?.is_staff;

    // 스태프는 모든 권한 허용
    if (user?.is_staff) return true;

    const allPermissions = permission ? [permission, ...requiredPermissions] : requiredPermissions;
    
    if (allPermissions.length === 0) return true;

    if (requireAll) {
      return allPermissions.every(perm => hasPermission(perm));
    } else {
      return allPermissions.some(perm => hasPermission(perm));
    }
  };

  const hasRequiredPermission = checkPermissions();
  const lacksPermission = !hasRequiredPermission;
  const isDisabled = disabled || lacksPermission;

  const handleClick = (e?: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) {
      // 폼 제출 차단
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      // 권한이 없어서 비활성화된 경우에만 토스트 노출
      if (lacksPermission) {
        const message = user?.username?.includes('chinese') || user?.department?.includes('中')
          ? '您没有执行此操作的权限'
          : '이 작업을 수행할 권한이 없습니다';
        toast.error(message);
      }
      return;
    }
    onClick?.(e);
  };

  // 기본 스타일과 사용자 정의 스타일 병합
  const getButtonClassName = () => {
    if (className) {
      // 사용자 정의 클래스가 있으면 권한 상태에 따라서만 수정
      return isDisabled 
        ? className.replace(/bg-\w+-\d+/g, 'bg-gray-400')
                  .replace(/text-\w+-\d+/g, 'text-white')
                  .replace(/hover:bg-\w+-\d+/g, '')
                  .replace(/hover:text-\w+-\d+/g, '') + ' cursor-not-allowed opacity-60'
        : className;
    } else {
      // 기본 스타일
      return `px-4 py-2 rounded-md font-medium transition-all duration-200 ease-in-out ${
        isDisabled 
          ? 'bg-gray-400 text-white cursor-not-allowed opacity-60' 
          : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 cursor-pointer'
      }`;
    }
  };

  return (
    <button
      type={type}
      className={getButtonClassName() + ' inline-flex items-center justify-center'}
      onClick={handleClick}
      // HTML disabled를 쓰면 클릭 이벤트가 발생하지 않아 토스트가 안 뜬다
      aria-disabled={isDisabled}
      tabIndex={isDisabled ? -1 : 0}
      title={showTooltip && !hasRequiredPermission ?
        (user?.username?.includes('chinese') || user?.department?.includes('中')
          ? '您没有执行此操作的权限'
          : '이 작업을 수행할 권한이 없습니다'
        ) : undefined}
    >
      {children}
    </button>
  );
};

export default PermissionButton;