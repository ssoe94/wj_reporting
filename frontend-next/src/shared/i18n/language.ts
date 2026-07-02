import { useEffect, useState } from "react";

export type AppLanguage = "ko" | "zh";

export const LANGUAGE_STORAGE_KEY = "wj_next_language";
const LEGACY_APP_LANGUAGE_KEY = "lang";
const LEGACY_LOGIN_LANGUAGE_KEY = "wj_next_login_language";
const LANGUAGE_CHANGE_EVENT = "wj_next_language_change";

function isAppLanguage(value: string | null): value is AppLanguage {
  return value === "ko" || value === "zh";
}

export function getStoredLanguage(): AppLanguage {
  const legacyAppStored = window.localStorage.getItem(LEGACY_APP_LANGUAGE_KEY);
  if (isAppLanguage(legacyAppStored)) return legacyAppStored;

  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (isAppLanguage(stored)) return stored;

  const legacyStored = window.localStorage.getItem(LEGACY_LOGIN_LANGUAGE_KEY);
  if (isAppLanguage(legacyStored)) return legacyStored;

  return "ko";
}

export function setStoredLanguage(language: AppLanguage) {
  window.localStorage.setItem(LEGACY_APP_LANGUAGE_KEY, language);
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  window.localStorage.setItem(LEGACY_LOGIN_LANGUAGE_KEY, language);
  window.dispatchEvent(new CustomEvent<AppLanguage>(LANGUAGE_CHANGE_EVENT, { detail: language }));
}

export function useStoredLanguage() {
  const [language, setLanguage] = useState<AppLanguage>(getStoredLanguage);

  useEffect(() => {
    function handleLanguageChange(event: Event) {
      const nextLanguage = event instanceof CustomEvent ? event.detail : getStoredLanguage();
      if (nextLanguage === "ko" || nextLanguage === "zh") {
        setLanguage(nextLanguage);
      }
    }

    function handleStorageChange(event: StorageEvent) {
      if (
        event.key === LEGACY_APP_LANGUAGE_KEY ||
        event.key === LANGUAGE_STORAGE_KEY ||
        event.key === LEGACY_LOGIN_LANGUAGE_KEY
      ) {
        setLanguage(getStoredLanguage());
      }
    }

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  useEffect(() => {
    setStoredLanguage(language);
  }, [language]);

  return [language, setLanguage] as const;
}
