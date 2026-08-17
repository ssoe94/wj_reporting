import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLang } from '../i18n';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { api } from '../lib/api';
import { parseFieldTerminalUser } from '../lib/fieldTerminal';
import { X } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSignupModal, setShowSignupModal] = useState(false);
  
  // Signup request modal state.
  const [signupForm, setSignupForm] = useState({
    fullName: '',
    department: '',
    email: ''
  });
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState('');
  const signupDialogRef = useRef<HTMLDivElement>(null);
  const signupTriggerRef = useRef<HTMLButtonElement>(null);
  
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang, setLang } = useLang();

  useEffect(() => {
    if (!showSignupModal) return;

    const previousOverflow = document.body.style.overflow;
    const dialog = signupDialogRef.current;
    const trigger = signupTriggerRef.current;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    document.body.style.overflow = 'hidden';
    dialog?.querySelector<HTMLInputElement>('#fullName')?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowSignupModal(false);
        return;
      }

      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [showSignupModal]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    const success = await login(username, password);
    
    if (success) {
      const requestedReturnTo = new URLSearchParams(location.search).get('returnTo');
      const safeReturnTo = requestedReturnTo?.startsWith('/') && !requestedReturnTo.startsWith('//')
        ? requestedReturnTo
        : '/';
      navigate(parseFieldTerminalUser(username) ? '/field' : safeReturnTo, { replace: true });
    } else {
      setError('로그인에 실패했습니다. 아이디와 비밀번호를 확인하세요.');
    }
    
    setIsLoading(false);
  };

  const handleSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignupLoading(true);
    setSignupError('');

    if (!signupForm.email.endsWith('@njwanjia.com')) {
      setSignupError(t('email_domain_error'));
      setSignupLoading(false);
      return;
    }

    try {
      const requestData = {
        full_name: signupForm.fullName,
        department: signupForm.department,
        email: signupForm.email
      };
      console.log('Sending request data:', requestData);
      
      const response = await api.post('/signup-request/', requestData, { skipAuth: true });

      if (response.status === 200 || response.status === 201) {
        alert(t('signup_request_success'));
        setShowSignupModal(false);
        setSignupForm({ fullName: '', department: '', email: '' });
      } else {
        console.log('Error response:', response.data);
        setSignupError(t('signup_request_error'));
      }
    } catch (_error) {
      setSignupError(t('signup_request_error'));
    }
    
    setSignupLoading(false);
  };

  return (
    <div className="main-login">
      <div className="main-login__panel">
        
        <div className="main-login__brand">
          <img
            src="/logo-transparent.png"
            alt="WJ DATA CENTER"
          />
          <h2>
            {t('login_title')}
          </h2>
          <p>
            {t('login_subtitle')}
          </p>
        </div>
        
        <Card className="main-login__card">
          <CardContent className="p-6">
            <form className="space-y-6" onSubmit={handleSubmit}>
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                  {error}
                </div>
              )}
              
              <div>
                <Label htmlFor="username">{t('username')}</Label>
                <Input
                  autoComplete="username"
                  id="username"
                  name="username"
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-1"
                  placeholder={t('username_placeholder')}
                />
              </div>

              <div>
                <Label htmlFor="password">{t('password')}</Label>
                <Input
                  autoComplete="current-password"
                  id="password"
                  name="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1"
                  placeholder={t('password_placeholder')}
                />
              </div>

              <div>
                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full"
                >
                  {isLoading ? t('logging_in') : t('login')}
                </Button>
              </div>
            </form>
            
            {/* Signup request */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <Button
                ref={signupTriggerRef}
                type="button"
                variant="secondary"
                onClick={() => setShowSignupModal(true)}
                className="w-full"
              >
                {t('request_signup')}
              </Button>
            </div>
          </CardContent>
        </Card>
        
        {/* Language selector */}
        <div className="main-login__language">
          <div className="main-language-switch" aria-label={lang === 'ko' ? '언어' : '语言'}>
            <button
              aria-pressed={lang === 'ko'}
              onClick={() => setLang('ko')}
              className={`main-language-switch__button${lang === 'ko' ? ' is-active' : ''}`}
            >
              KOR
            </button>
            <button
              aria-pressed={lang === 'zh'}
              onClick={() => setLang('zh')}
              className={`main-language-switch__button${lang === 'zh' ? ' is-active' : ''}`}
            >
              中文
            </button>
          </div>
        </div>
        
        {/* Signup modal */}
        {showSignupModal && (
          <div className="main-modal-backdrop">
            <div ref={signupDialogRef} className="main-modal-card" role="dialog" aria-modal="true" aria-labelledby="signup-request-title">
              <div className="flex justify-between items-center mb-4">
                <h3 id="signup-request-title" className="text-lg font-semibold">{t('signup_request')}</h3>
                <button
                  aria-label={lang === 'ko' ? '닫기' : '关闭'}
                  onClick={() => setShowSignupModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>
              
              <form onSubmit={handleSignupSubmit} className="space-y-4">
                {signupError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                    {signupError}
                  </div>
                )}
                
                <div>
                  <Label htmlFor="fullName">{t('full_name')}</Label>
                  <Input
                    id="fullName"
                    type="text"
                    required
                    value={signupForm.fullName}
                    onChange={(e) => setSignupForm({...signupForm, fullName: e.target.value})}
                    className="mt-1"
                  />
                </div>
                
                <div>
                  <Label htmlFor="department">{t('department')}</Label>
                  <Input
                    id="department"
                    type="text"
                    required
                    value={signupForm.department}
                    onChange={(e) => setSignupForm({...signupForm, department: e.target.value})}
                    className="mt-1"
                  />
                </div>
                
                <div>
                  <Label htmlFor="email">{t('email')}</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={signupForm.email}
                    onChange={(e) => setSignupForm({...signupForm, email: e.target.value})}
                    placeholder="name@njwanjia.com"
                    className="mt-1"
                  />
                </div>
                
                
                <div className="flex gap-3 pt-4">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setShowSignupModal(false)}
                    className="flex-1"
                  >
                    {t('cancel')}
                  </Button>
                  <Button
                    type="submit"
                    disabled={signupLoading}
                    className="flex-1"
                  >
                    {signupLoading ? t('saving') : t('submit_request')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
} 
