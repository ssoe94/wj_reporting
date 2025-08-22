import { useState } from 'react';
import { Button } from './ui/button';
import { api } from '../lib/api';

interface PasswordChangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  isRequired?: boolean; // 필수 변경인지 (임시 비밀번호 사용자)
  onSuccess?: () => void;
}

export default function PasswordChangeModal({ 
  isOpen, 
  onClose, 
  isRequired = false,
  onSuccess 
}: PasswordChangeModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('새 비밀번호가 일치하지 않습니다.');
      return;
    }

    if (newPassword.length < 8) {
      setError('새 비밀번호는 최소 8자 이상이어야 합니다.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/user/change-password/', {
        current_password: currentPassword,
        new_password: newPassword,
      });

      alert('비밀번호가 성공적으로 변경되었습니다.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onClose();
      if (onSuccess) onSuccess();
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || error?.message || '비밀번호 변경 중 오류가 발생했습니다.';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (isRequired) {
      // 필수 변경인 경우 닫기 불가
      return;
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-4">
          {isRequired ? '비밀번호 변경 필수' : '비밀번호 변경'}
        </h3>
        
        {isRequired && (
          <div className="mb-4 p-3 bg-yellow-100 border border-yellow-400 rounded">
            <p className="text-sm text-yellow-800">
              임시 비밀번호를 사용 중입니다. 보안을 위해 새로운 비밀번호로 변경해주세요.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              현재 비밀번호
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              새 비밀번호 (최소 8자)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              minLength={8}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              새 비밀번호 확인
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              minLength={8}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-100 border border-red-400 rounded">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div className="flex gap-2 pt-4">
            <Button
              type="submit"
              disabled={loading}
              className="flex-1"
            >
              {loading ? '변경 중...' : '비밀번호 변경'}
            </Button>
            {!isRequired && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleClose}
                className="flex-1"
              >
                취소
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}