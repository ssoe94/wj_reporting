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
    total_prod_unit: '건',
    detailed_record: '상세 기록',
    minutes_unit: '분',
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
    delete: '삭제',
    close: '닫기',
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
    lite_mode: '경량 모드',
    delete_success: '삭제되었습니다',
    delete_fail: '삭제 실패',
    save_success: '저장되었습니다',
    save_fail: '저장 실패',
    required_error: '필수 항목을 입력해 주세요',
    update_success: '수정되었습니다',
    update_fail: '수정 실패',
    header_model: '생산품',
    header_machine: '사출기번호',
    header_tonnage: '형체력(T)',
    header_plan: '계획생산량',
    header_actual: '양품생산량',
    header_defect: '불량생산량',
    header_start: '시작일시',
    header_end: '종료일시',
    header_run: '가동시간(분)',
    header_note: '비고',
    header_action: '액션',
    modal_edit_title: '기록 수정',
    ct_sec: 'C/T(초)',
    model: '모델',
    machine_no: '사출기번호',
    tonnage: '형체력(T)',
    nav_eco: 'ECO 관리',
    ecoTitle: 'ECO 관리',
    new_eco: '+ 새 ECO',
    edit_eco: 'ECO 수정',
    add_eco: '새 ECO 추가',
    eco_search_placeholder: 'ECO 또는 고객 검색...',
    eco_no: 'ECO 번호',
    customer: '고객사',
    description: '내용',
    received_date: '접수일',
    due_date: '완료 예정일',
    close_date: '완료일',
    status: '상태',
    prepared_date: '제정일',
    issued_date: '발표일',
    eco_model: '적용모델',
    change_reason: '변경 사유',
    change_details: '변경 내용',
    applicable_work_order: '적용 작업지시/시점',
    storage_action: '재고 처리',
    inventory_finished: '완제품 재고',
    inventory_material: '자재 재고',
    applicable_date: '적용일',
    form_type_regular: '정규',
    form_type_temp: '임시',
    delete_confirm: '정말 삭제하시겠습니까?',
    part: 'Part',
    eco: 'ECO',
    part_status: 'Part Status',
    eco_status: 'ECO Status',
    selected_part_eco_details: '선택 Part ECO 상세',
    all: '전체',
    add_directly: '직접 추가',
    part_search_placeholder: 'Part No 검색...',
    eco_count: 'ECO 건수',
    description_edit_prompt: '의 Description을 수정하세요',
    add_new_part: '새 Part 추가',
    description_placeholder: 'Part 설명을 입력하세요',
    direct_input: '직접 입력',
    input_or_select: '입력 또는 선택',
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
    total_prod_unit: '件',
    detailed_record: '详细记录',
    minutes_unit: '分',
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
    delete: '删除',
    close: '关闭',
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
    lite_mode: '简易模式',
    delete_success: '已删除',
    delete_fail: '删除失败',
    save_success: '已保存',
    save_fail: '保存失败',
    required_error: '请填写必填项',
    update_success: '已更新',
    update_fail: '更新失败',
    header_model: '生产品',
    header_machine: '注塑机号',
    header_tonnage: '锁模力(T)',
    header_plan: '计划产量',
    header_actual: '良品产量',
    header_defect: '不良产量',
    header_start: '开始时间',
    header_end: '结束时间',
    header_run: '运行时间(分)',
    header_note: '备注',
    header_action: '操作',
    modal_edit_title: '编辑记录',
    ct_sec: 'C/T(秒)',
    model: '型号',
    machine_no: '注塑机号',
    tonnage: '锁模力(T)',
    nav_eco: 'ECO管理',
    ecoTitle: 'ECO管理',
    new_eco: '+ 新ECO',
    edit_eco: '编辑ECO',
    add_eco: '新增ECO',
    eco_search_placeholder: '搜索ECO或客户...',
    eco_no: 'ECO编号',
    customer: '客户',
    description: '内容',
    received_date: '接收日期',
    due_date: '预计完成日期',
    close_date: '完成日期',
    status: '状态',
    prepared_date: '制定日',
    issued_date: '发布日',
    eco_model: '适用型号',
    change_reason: '变更理由',
    change_details: '变更内容',
    applicable_work_order: '适用工单/时间',
    storage_action: '库存处理',
    inventory_finished: '成品库存',
    inventory_material: '材料库存',
    applicable_date: '适用日期',
    form_type_regular: '正式',
    form_type_temp: '临时',
    delete_confirm: '确定要删除吗?',
    part: '部件',
    eco: 'ECO',
    part_status: '部件状态',
    eco_status: 'ECO状态',
    selected_part_eco_details: '所选部件ECO明细',
    all: '全部',
    add_directly: '直接添加',
    part_search_placeholder: '搜索Part No...',
    eco_count: 'ECO数量',
    description_edit_prompt: '的Description修改',
    add_new_part: '添加新Part',
    description_placeholder: '请输入Part描述',
    direct_input: '直接输入',
    input_or_select: '输入或选择',
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