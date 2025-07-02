import { createContext, useContext, useState, useEffect } from 'react';
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

    total_prod: '총 생산 건수',
    avg_ach: '평균 달성률',
    avg_def: '평균 불량률',
    csv_upload: 'CSV 업로드',
    csv_save: 'CSV 저장',
    new_rec_title: '신규 생산 기록 등록',
    report_date: '보고일자',
    machine: '사출기',
    model_search: '모델 검색',
    plan_qty: '계획수량*',
    actual_qty: '양품수량*',
    reported_defect: '불량수량(보고)*',
    actual_defect: '불량수량(실제)',
    start_dt: '시작일시',
    end_dt: '종료일시',
    total_time: '총시간',
    idle_time: '부동시간(분)',
    idle_note: '부동시간 비고',
    run_time: '가동시간',
    cancel: '취소',
    save: '저장',
    saving: '저장중...',
    edit: '수정',
    new_model: '+ 새 모델',
    search_placeholder: '모델 또는 Part 검색...',
    add_model: '새 모델 추가',
    edit_model: '모델 수정',
    brand: '사출생산관리',
    records_title: '생산 기록',
    no_data: '데이터가 없습니다.',
    loading: '로딩 중…',
    select: '선택',
    save_record: '저장하기',
    confirm_delete: '정말 삭제하시겠습니까?',
    prod_time: '생산 시간',
    prod_report: '생산 보고',
    total_pieces: '총 사출수량',
    shot_ct: '사출기 C/T(초)',
    good_ct: '양품기준 C/T(초)',
    reset: '초기화',
  },
  zh: {
    title: '注塑生产管理系统',
    modelsTitle: '型号管理',
    nav_summary: '现况概要',
    nav_records: '生产记录',
    nav_new: '新增登记',
    nav_models: '型号管理',
    dashboard: '仪表板',

    total_prod: '总生产件数',
    avg_ach: '平均达成率',
    avg_def: '平均不良率',
    csv_upload: '上传CSV',
    csv_save: '保存CSV',
    new_rec_title: '新增生产记录登记',
    report_date: '报告日期',
    machine: '注塑机',
    model_search: '型号搜索',
    plan_qty: '计划数量*',
    actual_qty: '良品数量*',
    reported_defect: '不良数量(报)*',
    actual_defect: '不良数量(实)',
    start_dt: '开始时间',
    end_dt: '结束时间',
    total_time: '总时间',
    idle_time: '停机时间(分)',
    idle_note: '停机备注',
    run_time: '运行时间',
    cancel: '取消',
    save: '保存',
    saving: '保存中...',
    edit: '编辑',
    new_model: '+ 新型号',
    search_placeholder: '搜索型号或部件...',
    add_model: '新增型号',
    edit_model: '编辑型号',
    brand: '注塑计划生产实际',
    records_title: '生产记录',
    no_data: '暂无数据',
    loading: '加载中…',
    select: '选择',
    save_record: '保存',
    confirm_delete: '确定要删除吗？',
    prod_time: '生产时间',
    prod_report: '生产报告',
    total_pieces: '总射出数',
    shot_ct: '注塑机 C/T(秒)',
    good_ct: '良品基准 C/T(秒)',
    reset: '重置',
  },
};

const LangContext = createContext<LangContextValue>({
  lang: 'ko',
  setLang: () => {},
  t: (k) => k,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<'ko' | 'zh'>(()=> (localStorage.getItem('lang') as 'ko'|'zh') || 'ko');
  useEffect(()=>{
    localStorage.setItem('lang', lang);
  },[lang]);
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