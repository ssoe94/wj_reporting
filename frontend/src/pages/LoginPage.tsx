import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLang } from '../i18n';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSignupModal, setShowSignupModal] = useState(false);
  
  // 가입 요청 상태
  const [signupForm, setSignupForm] = useState({
    fullName: '',
    department: '',
    email: ''
  });
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState('');
  
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t, lang, setLang } = useLang();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    const success = await login(username, password);
    
    if (success) {
      navigate('/');
    } else {
      setError('로그인에 실패했습니다. 사용자명과 비밀번호를 확인해주세요.');
    }
    
    setIsLoading(false);
  };

  const handleSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignupLoading(true);
    setSignupError('');

    // 이메일 도메인 검증
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
      console.log('Sending request data:', requestData); // 디버그 로그
      
      const response = await fetch('/api/signup-request/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData),
      });

      if (response.ok) {
        alert(t('signup_request_success'));
        setShowSignupModal(false);
        setSignupForm({ fullName: '', department: '', email: '' });
      } else {
        const errorData = await response.json();
        console.log('Error response:', errorData); // 오류 상세 정보 출력
        setSignupError(t('signup_request_error'));
      }
    } catch (error) {
      setSignupError(t('signup_request_error'));
    }
    
    setSignupLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-6">
        
        <div>
          <img
            className="mx-auto h-12 w-auto"
            src="/logo.jpg"
            alt="Logo"
          />
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            {t('login_title')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            {t('login_subtitle')}
          </p>
        </div>
        
        <Card>
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
            
            {/* 가입요청 버튼 */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <Button
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
        
        {/* 언어 토글 */}
        <div className="flex justify-center">
          <div className="inline-flex rounded-lg border border-gray-300 bg-white p-1">
            <button
              onClick={() => setLang('ko')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                lang === 'ko'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-700 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              한국어
            </button>
            <button
              onClick={() => setLang('zh')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                lang === 'zh'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-700 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              中文
            </button>
          </div>
        </div>
        
        {/* 가입요청 모달 */}
        {showSignupModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold">{t('signup_request')}</h3>
                <button
                  onClick={() => setShowSignupModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
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