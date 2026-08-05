import { useLang } from '@/i18n';

export type AppLanguage = 'ko' | 'zh';

const LANGUAGE_STORAGE_KEYS = ['lang', 'wj_next_language', 'wj_next_login_language'] as const;

export function setStoredLanguage(language: AppLanguage) {
  LANGUAGE_STORAGE_KEYS.forEach((key) => window.localStorage.setItem(key, language));
}

export function useStoredLanguage() {
  const { lang, setLang } = useLang();

  const setLanguage = (language: AppLanguage) => {
    setStoredLanguage(language);
    setLang(language);
  };

  return [lang, setLanguage] as const;
}
