import React, { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

interface LangContextValue {
  lang: 'ko' | 'zh';
  setLang: (l: 'ko' | 'zh') => void;
  t: (key: string) => string;
}

const translations: Record<'ko' | 'zh', Record<string, string>> = {
  ko: {
    title: '사출 생산관리 시스템',
    modelsTitle: '모델 관리',
    nav_summary: '현황 요약',
    nav_records: '생산 기록',
    nav_new: '신규 등록',
    nav_models: '모델 관리',
    dashboard: '대시보드',
  },
  zh: {
    title: '注塑生产管理系统',
    modelsTitle: '型号管理',
    nav_summary: '现况概要',
    nav_records: '生产记录',
    nav_new: '新增登记',
    nav_models: '型号管理',
    dashboard: '仪表盘',
  },
};

const LangContext = createContext<LangContextValue>({
  lang: 'ko',
  setLang: () => {},
  t: (k) => k,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<'ko' | 'zh'>('ko');
  const t = (key: string) => translations[lang][key] || key;
  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
} 