import { useAuth } from '../contexts/AuthContext';
import { useLang } from '../i18n';
import { Button } from './ui/button';

// Outside route/modal content so a failed logout is visible on field terminals
// and the mandatory password-change screen as well as the regular app shell.
export default function LogoutFeedback() {
  const { logoutError, isLoggingOut, logout } = useAuth();
  const { lang } = useLang();
  if (!logoutError) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-1/2 z-[150] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-xl border border-red-200 bg-white p-4 text-slate-900 shadow-xl">
      <p className="text-sm">{lang === 'ko'
        ? '로그아웃 완료를 확인할 수 없습니다. 로그인 상태가 유지됩니다. 다시 시도해 주세요.'
        : '无法确认是否已退出登录。当前登录状态仍保留，请重试。'}</p>
      <Button type="button" variant="secondary" size="sm" className="mt-3" disabled={isLoggingOut}
        onClick={async () => { await logout(); }}>
        {lang === 'ko' ? '로그아웃 다시 시도' : '重试退出登录'}
      </Button>
    </div>
  );
}
