import { useState } from 'react';
import { Button } from './ui/button';
import { api } from '../lib/api';
import { useLang } from '../i18n';

interface PasswordChangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  isRequired?: boolean; // 필수 변경인지 (임시 비밀번호 사용자)
  onLogout?: () => Promise<boolean>;
  onSuccess?: () => void | Promise<boolean | void>;
  isLoggingOut?: boolean;
}

export default function PasswordChangeModal({ 
  isOpen, 
  onClose, 
  isRequired = false,
  onLogout,
  onSuccess,
  isLoggingOut = false,
}: PasswordChangeModalProps) {
  const { t } = useLang();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError(t('password_mismatch'));
      return;
    }

    if (newPassword.length < 8) {
      setError(t('password_min_length'));
      return;
    }

    setLoading(true);
    try {
      await api.post('/user/change-password/', {
        current_password: currentPassword,
        new_password: newPassword,
      });

      alert(t('password_change_success'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onClose();
      if (onSuccess) await onSuccess();
    } catch (error: any) {
      const data = error?.response?.data;
      let msg = t('save_fail');
      if (data && typeof data === 'object') {
        if (typeof (data as any).detail === 'string' && (data as any).detail) {
          msg = (data as any).detail;
        } else {
          const keys = Object.keys(data as any);
          if (keys.length > 0) {
            const firstKey = keys[0];
            const val = (data as any)[firstKey];
            msg = Array.isArray(val) ? (val[0] || msg) : (val || msg);
          }
        }
      } else if (error?.message) {
        msg = error.message;
      }
      setError(String(msg));
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
    <div className="fixed inset-0 bg-[var(--wj-surface-solid)] bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-[var(--wj-surface-solid)] rounded-lg p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-4">
          {isRequired ? t('password_change_required') : t('password_change')}
        </h3>
        
        {isRequired && (
          <div className="mb-4 p-3 bg-[var(--wj-warning-bg)] border border-[var(--wj-warning-border)] rounded">
            <p className="text-sm text-[var(--wj-warning)]">{t('temp_password_notice')}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--wj-text)] mb-1">{t('current_password')}</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--wj-border)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--wj-accent)]"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--wj-text)] mb-1">{t('new_password_label')}</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--wj-border)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--wj-accent)]"
              required
              minLength={8}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--wj-text)] mb-1">{t('new_password_confirm')}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--wj-border)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--wj-accent)]"
              required
              minLength={8}
            />
          </div>

          {error && (
            <div className="p-3 bg-[var(--wj-danger-bg)] border border-[var(--wj-danger-border)] rounded">
              <p className="text-sm text-[var(--wj-danger)]">{error}</p>
            </div>
          )}

          <div className="flex gap-2 pt-4">
            <Button
              type="submit"
              disabled={loading || isLoggingOut}
              className="flex-1"
            >
              {loading ? t('changing') : t('password_change')}
            </Button>
            {!isRequired && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleClose}
                className="flex-1"
              >
                {t('cancel')}
              </Button>
            )}
            {isRequired && onLogout && (
              <Button
                type="button"
                variant="secondary"
                disabled={loading || isLoggingOut}
                onClick={async () => { await onLogout(); }}
                className="flex-1"
              >
                {t('logout')}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
