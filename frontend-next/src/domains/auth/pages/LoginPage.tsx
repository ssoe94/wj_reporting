import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getLoginFailureReason, type LoginFailureReason } from "@/domains/auth/auth-api";
import { useAuth } from "@/domains/auth/auth-context";
import { devLoginHint } from "@/domains/auth/dev-session";
import { type AppLanguage, setStoredLanguage, useStoredLanguage } from "@/shared/i18n/language";

const publicAssetBase = import.meta.env.BASE_URL.replace(/\/$/, "");
const wjLogoUrl = `${publicAssetBase}/wjlogo.png`;

type LocationState = {
  from?: string;
};

const loginCopy = {
  ko: {
    title: "로그인",
    username: "아이디",
    password: "비밀번호",
    submit: "로그인",
    submitting: "로그인 중",
    errors: {
      invalidCredentials: "로그인에 실패했습니다. 계정 또는 비밀번호를 확인해주세요.",
      network: "로그인 서버에 연결할 수 없습니다. API 서버가 실행 중인지 확인해주세요.",
      server: "로그인 서버에서 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      unknown: "로그인 중 알 수 없는 오류가 발생했습니다. 다시 시도해주세요.",
    },
    ariaLabel: "로그인",
  },
  zh: {
    title: "登录",
    username: "账号",
    password: "密码",
    submit: "登录",
    submitting: "登录中",
    errors: {
      invalidCredentials: "登录失败。请确认账号或密码。",
      network: "无法连接登录服务器。请确认 API 服务器是否正在运行。",
      server: "登录服务器发生错误。请稍后再试。",
      unknown: "登录时发生未知错误。请再试一次。",
    },
    ariaLabel: "登录",
  },
};

function getErrorMessage(
  errors: Record<LoginFailureReason, string>,
  error: unknown,
) {
  return errors[getLoginFailureReason(error)];
}

export function LoginPage() {
  const location = useLocation();
  const { isAuthenticated, login } = useAuth();
  const [language, setLanguage] = useStoredLanguage();
  const [username, setUsername] = useState(import.meta.env.DEV ? devLoginHint.username : "");
  const [password, setPassword] = useState(import.meta.env.DEV ? devLoginHint.password : "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const copy = loginCopy[language];

  const state = location.state as LocationState | null;
  const redirectTo = state?.from || "/production";

  if (isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(username, password);
    } catch (loginError) {
      setError(getErrorMessage(copy.errors, loginError));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleLanguageChange(nextLanguage: AppLanguage) {
    setLanguage(nextLanguage);
    setStoredLanguage(nextLanguage);
  }

  return (
    <div className="login login--work">
      <div className="login__aurora login__aurora--blue" />
      <div className="login__aurora login__aurora--green" />
      <div className="login__aurora login__aurora--gold" />
      <main className="login__main">
        <section className="login__panel" aria-label={copy.ariaLabel}>
          <div className="login-card">
            <div className="login-card__header">
              <img alt="WJ company logo" className="login-card__logo" src={wjLogoUrl} />
              <div className="language-switch" aria-label="Language">
                <button
                  className={language === "ko" ? "language-switch__item language-switch__item--active" : "language-switch__item"}
                  onClick={() => handleLanguageChange("ko")}
                  type="button"
                >
                  한국어
                </button>
                <button
                  className={language === "zh" ? "language-switch__item language-switch__item--active" : "language-switch__item"}
                  onClick={() => handleLanguageChange("zh")}
                  type="button"
                >
                  中文
                </button>
              </div>
            </div>

            <h1>{copy.title}</h1>

            <form className="login__form" onSubmit={handleSubmit}>
              <label className="field">
                <span>{copy.username}</span>
                <input
                  autoComplete="username"
                  className="input"
                  onChange={(event) => setUsername(event.target.value)}
                  value={username}
                />
              </label>

              <label className="field">
                <span>{copy.password}</span>
                <input
                  autoComplete="current-password"
                  className="input"
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </label>

              {error ? <p className="form-error">{error}</p> : null}

              <button className="button button--primary button--wide" disabled={isSubmitting} type="submit">
                {isSubmitting ? copy.submitting : copy.submit}
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
