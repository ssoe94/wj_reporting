import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, ChevronRight, ClipboardList, ExternalLink, Factory, FileCheck2, LockKeyhole, Plus, Search, Square, Users } from 'lucide-react';
import api from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import {
  checklistProgress, developmentTaskCompletionIssues, developmentTaskPayload, editableTaskFields, filterDevelopmentTasks,
  developmentTaskRecoveryKey, formatDevelopmentTaskError, newDevelopmentTask, nextDevelopmentTask, parseDevelopmentTaskRecovery, pendingHumanRequirements, safeDevelopmentTaskUrl,
  type CompletionIssue, type DevelopmentTask, type DevelopmentTaskDetailResponse, type DevelopmentTaskRecovery, type DevelopmentTasksResponse, type RequirementKind, type TaskFilter, type TaskStatus,
} from './developmentTasks';
import './DevelopmentTasksPage.css';

const copy = {
  ko: {
    eyebrow: 'WJ DATA CENTER · 개발 계획', title: '개발 과제', admin: 'SUPERUSER 전용',
    description: '필요한 근거부터 한 단계씩. 요구 사항, 확인 기준, 구현 위치를 함께 정리합니다.',
    principle: 'MES에서 확인할 수 있는 자료는 다시 입력하지 않고, 부족한 현장 근거와 판단만 사람에게 요청합니다.',
    all: '전체 과제', active: '계획·진행 중', human: '사람 확인·자료', review: '검증 대기', done: '완료',
    needed: '확보 필요', requested: '요청 중', ready: '확보 완료',
    search: '과제, 담당 역할, 필요한 자료 검색', listTitle: '개발 순서', tasksUnit: '개 과제',
    selected: '선택한 과제', goal: '목표', phase: '단계', priority: '우선순위', owner: '담당 역할 제안', due: '기한', noDue: '미정',
    dependencies: '선행 과제', noDependencies: '선행 완료 조건 없음', unknownDependency: '연결 과제 확인 필요',
    requirements: '필요한 자료와 결정', mes: 'MES에서 확인', humanGroup: '사람이 확인·취합', decision: '업무 기준 결정',
    pending: '확보·결정 대기', requirementUnit: '건', evidence: '확인 근거', noEvidence: '아직 기록된 근거가 없습니다.',
    checklist: '완료 확인 기준', checked: '항목 확인', noChecklist: '완료 기준이 아직 없습니다.',
    implementation: '구현 위치와 검증 기록', referenceNote: '기존 참고 위치가 있다고 과제가 완료된 것은 아닙니다. 구현·서비스 반영·현장 인수를 각각 확인합니다.',
    completion: '구현·완료 기록', noCompletion: '완료 기록이 없습니다.', verification: '검증 내용', noVerification: '검증 기록이 없습니다.',
    locations: '구현·참고 위치', noLocations: '아직 연결된 구현 위치가 없습니다.', unsafeLink: '유효하지 않은 링크',
    screen: '화면', code: '코드', doc: '문서', unreleased: '서비스 미반영', code_available: '기반 코드 있음 · 인수 확인 필요', deployed: '서비스 반영 기록 있음',
    next: '검토와 함께 준비할 다음 과제', nextDetail: '진행 중인 과제를 우선하고, 선행 완료 조건이 충족된 계획을 개발 순서대로 제안합니다.', open: '과제 보기',
    loading: '개발 계획을 불러오는 중입니다.', error: '개발 과제를 불러오지 못했습니다.', denied: '개발 과제는 superuser만 조회할 수 있습니다.', retry: '다시 불러오기',
    empty: '조건에 맞는 과제가 없습니다.', reset: '필터 초기화', catalog: '계획 기준', bodyLanguage: '',
  },
  zh: {
    eyebrow: 'WJ DATA CENTER · 开发计划', title: '开发任务', admin: '仅限 SUPERUSER',
    description: '从必要依据开始逐步推进，统一整理需求、验收标准与实现位置。',
    principle: 'MES 可提供的资料无需重复录入，仅向相关人员请求缺失的现场依据与业务判断。',
    all: '全部任务', active: '计划与进行中', human: '人工确认与资料', review: '待验证', done: '已完成',
    needed: '待获取', requested: '已请求', ready: '已齐备',
    search: '搜索任务、负责角色或所需资料', listTitle: '开发顺序', tasksUnit: '项任务',
    selected: '所选任务', goal: '目标', phase: '阶段', priority: '优先级', owner: '建议负责角色', due: '期限', noDue: '待定',
    dependencies: '前置任务', noDependencies: '无前置完成条件', unknownDependency: '需确认关联任务',
    requirements: '所需资料与决策', mes: '从 MES 确认', humanGroup: '人工确认与收集', decision: '业务标准决策',
    pending: '待获取或决策', requirementUnit: '项', evidence: '确认依据', noEvidence: '尚未记录依据。',
    checklist: '完成验收标准', checked: '项已确认', noChecklist: '尚未制定完成标准。',
    implementation: '实现位置与验证记录', referenceNote: '现有参考位置不代表任务已完成。需分别确认代码实现、服务发布与现场验收。',
    completion: '实现与完成记录', noCompletion: '暂无完成记录。', verification: '验证内容', noVerification: '暂无验证记录。',
    locations: '实现与参考位置', noLocations: '尚未关联实现位置。', unsafeLink: '无效链接',
    screen: '页面', code: '代码', doc: '文档', unreleased: '尚未发布', code_available: '已有基础代码 · 待验收', deployed: '已有服务发布记录',
    next: '可与审阅同步准备的下一任务', nextDetail: '优先建议进行中的任务，再按开发顺序选择已满足前置完成条件的计划。', open: '查看任务',
    loading: '正在加载开发计划。', error: '无法加载开发任务。', denied: '仅 superuser 可查看开发任务。', retry: '重新加载',
    empty: '没有符合条件的任务。', reset: '重置筛选', catalog: '计划基准', bodyLanguage: '详细需求保留韩文原文。',
  },
};

const statusLabels: Record<'ko' | 'zh', Record<TaskStatus, string>> = {
  ko: { planned: '계획', in_progress: '진행 중', blocked: '진행 보류', review: '검증 대기', done: '완료' },
  zh: { planned: '计划', in_progress: '进行中', blocked: '暂缓', review: '待验证', done: '已完成' },
};
const phaseLabels = {
  ko: ['기반 검토', '데이터 근거 보존', '생산 작업 연결', '품질·조치', '재고·납기', '효율·원가'],
  zh: ['基础审阅', '保留数据依据', '关联生产作业', '质量与措施', '库存与交期', '效率与成本'],
};
const requirementKinds: RequirementKind[] = ['mes', 'human', 'decision'];
const filterKeys: TaskFilter[] = ['all', 'active', 'human', 'review', 'done'];

const editorCopy = {
  ko: {
    create: '새 과제', edit: '과제 편집', save: '변경 저장', saving: '저장 중…', cancel: '편집 취소',
    init: '기본 개발 계획 등록', initHint: '검토한 개발 계획의 미등록 과제를 추가합니다. 기존 과제와 기록은 유지됩니다.',
    readOnly: '현재 서버는 조회만 지원합니다. 저장 가능한 서버 버전이 필요합니다.',
    dirty: '저장하지 않은 변경이 있습니다.', discard: '저장하지 않은 변경을 버리고 이동할까요?', discardLatest: '작성 중인 변경을 버리고 서버의 최신 내용을 불러올까요?',
    saved: '변경 내용과 이력을 저장했습니다.', initialized: '기본 개발 계획을 등록했습니다.', failure: '저장하지 못했습니다. 작성 내용은 유지됩니다.',
    conflict: '다른 사용자가 먼저 변경했습니다. 작성 내용은 유지됩니다. 필요한 내용을 복사한 뒤 최신 내용을 불러와 다시 편집해 주세요.', latest: '최신 내용 불러오기',
    changeNote: '변경 사유', changeHint: '확인한 자료, 변경한 이유 또는 재개 사유를 적어 주세요.',
    slug: '과제 주소 ID', slugHint: '영문 소문자·숫자와 - 또는 _를 사용합니다. 등록 후 바꿀 수 없습니다.',
    titleKo: '과제명 (한국어)', titleZh: '과제명 (중국어 · 선택)', objective: '목표와 요구 사항', basics: '과제 정보',
    status: '진행 상태', owner: '담당자 또는 담당 역할', due: '목표 기한', phase: '단계', priority: '우선순위', order: '정렬 순서',
    release: '서비스 반영 상태', dependencies: '선행 과제', dependenciesHint: '선행 과제가 모두 완료되어야 이 과제를 완료할 수 있습니다.',
    requirements: '필요한 자료와 결정', addRequirement: '요구사항 추가', kind: '자료 구분', requirementText: '필요한 자료·결정', evidence: '확인 근거', requirementStatus: '자료 상태',
    checklist: '완료 확인 기준', addCheck: '확인 항목 추가', checkText: '확인할 내용', checked: '확인 완료',
    locations: '구현·참고 위치', addLocation: '위치 추가', locationLabel: '위치 설명', locationKind: '위치 구분', locationUrl: '화면 경로 또는 HTTPS 링크',
    completion: '구현·완료 기록', verification: '검증 내용', completionHint: '해결한 내용과 실제 구현 범위를 기록합니다. 서비스 반영 여부는 별도로 표시합니다.',
    remove: '항목 삭제', noItems: '등록된 항목이 없습니다.', completionIssues: '완료하기 전에 확인할 내용',
    history: '변경 이력', noHistory: '아직 변경 이력이 없습니다.', historyLoading: '이력을 불러오는 중입니다.', historyFailure: '이력을 불러오지 못했습니다.', older: '이전 이력 더 보기',
    reopen: '진행 재개', complete: '완료 내용 검토', updated: '최근 저장', completed: '완료 기록 시각', unsavedNew: '새 과제 작성',
    createAction: '과제 등록', initializeAction: '기본 계획 등록', updateAction: '내용 변경', completeAction: '완료', reopenAction: '재개',
    noChange: '변경할 내용을 입력해 주세요.', historyFields: '변경 항목', refresh: '새로고침',
    recoveryTitle: '이 탭에 저장하지 않은 초안이 있습니다.', recoveryHint: '이 계정의 임시 복구본입니다(이 탭에서 최대 24시간). 복구해도 서버에는 저장하지 않으며, 작성 당시 버전으로 변경 충돌을 확인합니다.',
    restore: '초안 복구', discardRecovery: '임시 복구본 삭제', replaceRecovery: '남아 있는 임시 복구본을 버리고 새로 편집할까요?',
    temporarySaved: '이 탭에 임시 복구 중 · 서버에는 변경 저장이 필요합니다.', temporaryFailed: '이 탭의 임시 복구본을 만들지 못했습니다. 작성 내용은 현재 화면에 유지됩니다.',
    recoveryChanged: '서버 내용이 작성 당시와 달라졌습니다. 초안 내용을 확인한 뒤 최신 내용과 비교해 주세요.',
  },
  zh: {
    create: '新建任务', edit: '编辑任务', save: '保存更改', saving: '正在保存…', cancel: '取消编辑',
    init: '登记基础开发计划', initHint: '添加已审阅计划中尚未登记的任务，保留现有任务和记录。',
    readOnly: '当前服务器仅支持查询，需要支持保存的服务器版本。',
    dirty: '存在尚未保存的更改。', discard: '放弃尚未保存的更改并离开吗？', discardLatest: '放弃当前更改并加载服务器最新内容吗？',
    saved: '已保存更改和历史记录。', initialized: '已登记基础开发计划。', failure: '保存失败，填写内容已保留。',
    conflict: '其他用户已先行修改，当前填写内容已保留。请复制需要保留的内容，再加载最新版本重新编辑。', latest: '加载最新内容',
    changeNote: '更改原因', changeHint: '请记录确认资料、更改原因或重新开始的理由。',
    slug: '任务地址 ID', slugHint: '使用小写英文字母、数字、- 或 _，登记后不可更改。',
    titleKo: '任务名称（韩文）', titleZh: '任务名称（中文，可选）', objective: '目标与要求', basics: '任务信息',
    status: '进度状态', owner: '负责人或负责角色', due: '目标期限', phase: '阶段', priority: '优先级', order: '排序',
    release: '服务发布状态', dependencies: '前置任务', dependenciesHint: '所有前置任务完成后才能完成此任务。',
    requirements: '所需资料与决策', addRequirement: '添加需求', kind: '资料类别', requirementText: '所需资料或决策', evidence: '确认依据', requirementStatus: '资料状态',
    checklist: '完成验收标准', addCheck: '添加检查项', checkText: '检查内容', checked: '已确认',
    locations: '实现与参考位置', addLocation: '添加位置', locationLabel: '位置说明', locationKind: '位置类别', locationUrl: '页面路径或 HTTPS 链接',
    completion: '实现与完成记录', verification: '验证内容', completionHint: '记录解决内容与实际实现范围，另行标明服务发布状态。',
    remove: '删除项目', noItems: '暂无项目。', completionIssues: '完成前需要确认',
    history: '更改历史', noHistory: '暂无更改历史。', historyLoading: '正在加载历史。', historyFailure: '无法加载历史。', older: '加载更早记录',
    reopen: '重新开始', complete: '审阅完成内容', updated: '最近保存', completed: '完成记录时间', unsavedNew: '正在新建任务',
    createAction: '登记任务', initializeAction: '登记基础计划', updateAction: '修改内容', completeAction: '完成', reopenAction: '重新开始',
    noChange: '请输入需要更改的内容。', historyFields: '更改项目', refresh: '刷新',
    recoveryTitle: '此标签页中存在未保存的草稿。', recoveryHint: '这是此账号的临时恢复副本（本标签页中最多保留24小时）。恢复不会写入服务器，保存时仍按编写时的版本检查冲突。',
    restore: '恢复草稿', discardRecovery: '删除临时副本', replaceRecovery: '放弃现有临时副本并重新编辑吗？',
    temporarySaved: '正在此标签页保留临时副本，仍需保存更改到服务器。', temporaryFailed: '无法创建临时恢复副本，填写内容仍保留在当前页面。',
    recoveryChanged: '服务器内容已发生变化，请检查草稿并与最新内容比较。',
  },
};
const completionIssueCopy: Record<'ko' | 'zh', Record<CompletionIssue, string>> = {
  ko: {
    checklist: '완료 기준을 하나 이상 정하고 모두 확인해 주세요.', requirements: '모든 자료·결정을 확보 완료로 표시하고 확인 근거를 적어 주세요.',
    owner: '담당자 또는 담당 역할을 적어 주세요.', completion_note: '해결한 내용과 구현 범위를 적어 주세요.', verification_note: '실제로 검증한 결과를 적어 주세요.',
    locations: '유효한 구현 화면·코드·문서 위치를 하나 이상 연결해 주세요.', dependencies: '선행 과제를 모두 완료해 주세요.',
  },
  zh: {
    checklist: '至少制定一个完成标准，并全部确认。', requirements: '将全部资料与决策标记为齐备，并填写确认依据。',
    owner: '请填写负责人或角色。', completion_note: '请记录解决内容与实现范围。', verification_note: '请记录实际验证结果。',
    locations: '请至少关联一个有效的页面、代码或文档位置。', dependencies: '请先完成所有前置任务。',
  },
};
const taskApi = '/analytics/development-tasks/';
const itemId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default function DevelopmentTasksPage() {
  const { lang } = useLang();
  const { user } = useAuth();
  const text = copy[lang];
  const editText = editorCopy[lang];
  const [response, setResponse] = useState<DevelopmentTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'load' | 'denied' | null>(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState('');
  const [draft, setDraft] = useState<DevelopmentTask | null>(null);
  const [original, setOriginal] = useState<DevelopmentTask | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<DevelopmentTaskDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const [recovery, setRecovery] = useState<DevelopmentTaskRecovery | null>(null);
  const [temporaryFailed, setTemporaryFailed] = useState(false);
  const userId = user?.id;
  const username = user?.username;
  const recoveryKey = user?.is_superuser === true ? developmentTaskRecoveryKey(user.id, user.username) : null;
  const draftOwnerKey = useRef<string | null>(null);
  const historyRequest = useRef(0);
  const dirty = Boolean(draft && (isNew || !original || changeNote.trim()
    || JSON.stringify(editableTaskFields(draft)) !== JSON.stringify(editableTaskFields(original))));

  useEffect(() => {
    setRecovery(null); setDraft(null); setOriginal(null); setIsNew(false); setChangeNote(''); setSaveError(null);
    draftOwnerKey.current = null;
    if (!recoveryKey || userId === undefined || username === undefined) return;
    try {
      const raw = sessionStorage.getItem(recoveryKey);
      const recovered = parseDevelopmentTaskRecovery(raw, userId, username, Date.now());
      setRecovery(recovered);
      if (raw && !recovered) sessionStorage.removeItem(recoveryKey);
    } catch { setTemporaryFailed(true); }
  }, [recoveryKey, userId, username]);

  useEffect(() => {
    if (!dirty || !draft || !recoveryKey || draftOwnerKey.current !== recoveryKey || userId === undefined || username === undefined) return;
    const value: DevelopmentTaskRecovery = {
      schema: 1, user_id: userId, username, slug: draft.slug, base_version: draft.version,
      saved_at: Date.now(), draft, original, is_new: isNew, change_note: changeNote,
    };
    try { sessionStorage.setItem(recoveryKey, JSON.stringify(value)); setTemporaryFailed(false); }
    catch { setTemporaryFailed(true); }
  }, [dirty, draft, original, isNew, changeNote, recoveryKey, userId, username]);

  useEffect(() => {
    if (!dirty && !saving) return;
    const onUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')
        || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname
        && destination.search === window.location.search) return;
      if (saving || !window.confirm(editText.discard)) { event.preventDefault(); event.stopImmediatePropagation(); }
      else {
        if (recoveryKey) { try { sessionStorage.removeItem(recoveryKey); } catch { /* Navigation is already confirmed. */ } }
        window.removeEventListener('beforeunload', onUnload);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onLink, true);
    return () => { window.removeEventListener('beforeunload', onUnload); document.removeEventListener('click', onLink, true); };
  }, [dirty, saving, editText.discard, recoveryKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<DevelopmentTasksResponse>(taskApi, { signal: controller.signal })
      .then(({ data }) => {
        if (!Array.isArray(data.tasks)) throw new Error('Invalid development task response');
        if (!controller.signal.aborted) setResponse(data);
      })
      .catch((failure: { response?: { status?: number } }) => {
        if (!controller.signal.aborted) {
          setResponse(null);
          setError(failure.response?.status === 403 || failure.response?.status === 401 ? 'denied' : 'load');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const tasks = useMemo(() => response?.tasks ?? [], [response]);
  const filtered = useMemo(() => filterDevelopmentTasks(tasks, filter, search), [tasks, filter, search]);
  const selected = filtered.find((task) => task.slug === selectedSlug) ?? filtered[0] ?? null;
  const currentSlug = selected?.slug;
  useEffect(() => {
    historyRequest.current += 1;
    setOlderLoading(false);
    if (!currentSlug || isNew) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(false);
    api.get<DevelopmentTaskDetailResponse>(`${taskApi}${encodeURIComponent(currentSlug)}/`, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setDetail((previous) => previous?.task.slug === data.task.slug && previous.task.version > data.task.version ? previous : data);
        setResponse((previous) => previous ? { ...previous, tasks: previous.tasks.map((task) => task.slug === data.task.slug && task.version <= data.task.version ? data.task : task) } : previous);
      })
      .catch(() => { if (!controller.signal.aborted) setDetailError(true); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [currentSlug, detailReload, isNew]);

  const nextTask = useMemo(() => nextDevelopmentTask(tasks), [tasks]);
  const title = (task: DevelopmentTask) => lang === 'zh' ? task.title_zh || task.title : task.title;
  const filterCounts = Object.fromEntries(filterKeys.map((key) => [key, filterDevelopmentTasks(tasks, key, '').length]));
  const removeRecovery = () => {
    if (recoveryKey) { try { sessionStorage.removeItem(recoveryKey); } catch { setTemporaryFailed(true); } }
    setRecovery(null);
  };
  const clearEditor = () => { if (draft) removeRecovery(); draftOwnerKey.current = null; setDraft(null); setOriginal(null); setIsNew(false); setChangeNote(''); setSaveError(null); };
  const canLeave = () => !saving && (!dirty || window.confirm(editText.discard));
  const navigateTasks = (action: () => void) => { if (!canLeave()) return; clearEditor(); setNotice(''); action(); };
  const openTask = (slug: string) => navigateTasks(() => { setFilter('all'); setSearch(''); setSelectedSlug(slug); });
  const changeFilter = (value: TaskFilter) => navigateTasks(() => setFilter(value));
  const startEdit = (status?: TaskStatus, checkId?: string) => {
    if (!selected || saving || response?.read_only) return;
    if (recovery && !window.confirm(editText.replaceRecovery)) return;
    removeRecovery(); draftOwnerKey.current = recoveryKey;
    const next = { ...selected, ...editableTaskFields(selected) };
    if (status) next.status = status;
    if (checkId) next.checklist = next.checklist.map((item) => item.id === checkId ? { ...item, done: !item.done } : item);
    setOriginal(selected); setDraft(next); setIsNew(false); setChangeNote(''); setSaveError(null); setNotice('');
  };
  const createTask = () => {
    if (recovery && !window.confirm(editText.replaceRecovery)) return;
    navigateTasks(() => {
    removeRecovery();
    draftOwnerKey.current = recoveryKey;
    setOriginal(null); setDraft(newDevelopmentTask(Math.max(0, ...tasks.map((task) => task.sort_order)) + 10)); setIsNew(true);
    });
  };
  const restoreRecovery = () => {
    if (!recovery || saving || draft || !response || response.read_only) return;
    const source = recovery;
    draftOwnerKey.current = recoveryKey;
    setFilter('all'); setSearch(''); setSelectedSlug(source.slug); setOriginal(source.original);
    setDraft(source.draft); setIsNew(source.is_new); setChangeNote(source.change_note); setRecovery(null);
    const current = tasks.find((task) => task.slug === source.slug);
    setSaveError(!source.is_new && (!current || current.version !== source.base_version)
      ? { conflict: true, message: editText.recoveryChanged } : null);
  };
  const saveTask = async () => {
    if (!draft || saving || response?.read_only) return;
    setSaving(true); setSaveError(null); setNotice('');
    try {
      const payload = developmentTaskPayload(draft, isNew, changeNote);
      const { data } = isNew
        ? await api.post<DevelopmentTaskDetailResponse>(taskApi, payload)
        : await api.patch<DevelopmentTaskDetailResponse>(`${taskApi}${encodeURIComponent(draft.slug)}/`, payload);
      setResponse((previous) => previous ? { ...previous, tasks: [...previous.tasks.filter((task) => task.slug !== data.task.slug), data.task] } : previous);
      setSelectedSlug(data.task.slug); setFilter('all'); setSearch(''); setDetail(data); clearEditor(); setNotice(editText.saved);
    } catch (failure) { setSaveError(formatDevelopmentTaskError(failure, editText.failure)); }
    finally { setSaving(false); }
  };
  const initialize = async () => {
    if (!canLeave() || response?.read_only) return;
    clearEditor(); setSaving(true); setSaveError(null); setNotice('');
    try { const { data } = await api.post<DevelopmentTasksResponse>(`${taskApi}initialize/`); setResponse(data); setNotice(editText.initialized); }
    catch (failure) { setSaveError(formatDevelopmentTaskError(failure, editText.failure)); }
    finally { setSaving(false); }
  };
  const loadLatest = async () => {
    if (!draft || isNew || saving || !window.confirm(editText.discardLatest)) return;
    setSaving(true);
    try {
      const { data } = await api.get<DevelopmentTaskDetailResponse>(`${taskApi}${encodeURIComponent(draft.slug)}/`);
      setResponse((previous) => previous ? { ...previous, tasks: previous.tasks.map((task) => task.slug === data.task.slug ? data.task : task) } : previous);
      removeRecovery(); setOriginal(data.task); setDraft({ ...data.task, ...editableTaskFields(data.task) }); setChangeNote(''); setDetail(data); setSaveError(null);
    } catch (failure) { setSaveError({ ...formatDevelopmentTaskError(failure, editText.failure), conflict: true }); }
    finally { setSaving(false); }
  };
  const loadOlder = async () => {
    if (!selected || !detail?.next_history_before || olderLoading) return;
    const slug = selected.slug;
    const request = historyRequest.current;
    setOlderLoading(true); setDetailError(false);
    try {
      const { data } = await api.get<DevelopmentTaskDetailResponse>(`${taskApi}${encodeURIComponent(slug)}/`, { params: { history_before: detail.next_history_before } });
      setDetail((previous) => previous?.task.slug === slug ? { ...previous, history: [...previous.history, ...data.history.filter((item) => !previous.history.some((entry) => entry.id === item.id))], next_history_before: data.next_history_before } : previous);
    } catch { if (request === historyRequest.current) setDetailError(true); }
    finally { if (request === historyRequest.current) setOlderLoading(false); }
  };
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(lang === 'ko' ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai' });
  };
  const progress = selected ? checklistProgress(selected) : null;
  const pendingCount = selected ? selected.requirements.filter((requirement) => requirement.status !== 'ready').length : 0;

  return (
    <div className="development-tasks-page">
      <header className="development-tasks-hero">
        <div>
          <div className="development-tasks-eyebrow">{text.eyebrow}</div>
          <div className="development-tasks-heading"><h1>{text.title}</h1><span className="development-tasks-admin"><LockKeyhole size={12} aria-hidden="true" />{text.admin}</span></div>
          <p>{text.description}</p>
        </div>
        <ClipboardList className="development-tasks-hero-icon" size={48} aria-hidden="true" />
        <p className="development-tasks-principle"><Factory size={16} aria-hidden="true" />{text.principle}</p>
      </header>

      <div className="development-tasks-page-actions"><span>{dirty ? editText.dirty : response ? `${text.catalog} ${response.catalog_version}` : ''}</span><div><button type="button" disabled={saving || loading} onClick={() => navigateTasks(() => setReload((value) => value + 1))}>{editText.refresh}</button><button type="button" className="development-task-primary" disabled={saving || loading || !response || response.read_only} onClick={createTask}><Plus size={16} aria-hidden="true" />{editText.create}</button></div></div>
      {response?.read_only && <p className="development-tasks-preview" role="note">{editText.readOnly}</p>}
      {response?.needs_initialization && <div className="development-tasks-initialize"><p>{editText.initHint}</p><button type="button" disabled={saving || response.read_only} onClick={initialize}>{saving ? editText.saving : editText.init}</button></div>}
      {recovery && !draft && response && !loading && <aside className="development-tasks-recovery"><div><strong>{editText.recoveryTitle}</strong><p>{recovery.draft.title || editText.unsavedNew} · {formatDate(new Date(recovery.saved_at).toISOString())}</p><p>{editText.recoveryHint}</p></div><div><button type="button" disabled={saving || response.read_only} onClick={restoreRecovery}>{editText.restore}</button><button type="button" disabled={saving} onClick={removeRecovery}>{editText.discardRecovery}</button></div></aside>}
      {notice && <p className="development-tasks-notice" role="status">{notice}</p>}
      {!draft && saveError && <p className="development-task-save-error" role="alert">{saveError.message}</p>}

      {loading ? <p className="development-tasks-state" role="status">{text.loading}</p> : error ? (
        <div className="development-tasks-state" role="alert"><p>{error === 'denied' ? text.denied : text.error}</p><button type="button" onClick={() => setReload((value) => value + 1)}>{text.retry}</button></div>
      ) : (
        <>
          <div className="development-tasks-summary" aria-label={text.all}>
            {(['all', 'active', 'review', 'done'] as const).map((key) => <button type="button" key={key} onClick={() => changeFilter(key)} aria-pressed={filter === key}><span>{text[key]}</span><strong>{filterCounts[key]}</strong></button>)}
          </div>

          {nextTask && <aside className="development-tasks-next"><div><span>{text.next}</span><strong>{title(nextTask)}</strong><p>{text.nextDetail}</p></div><button type="button" onClick={() => openTask(nextTask.slug)}>{text.open}<ArrowRight size={16} aria-hidden="true" /></button></aside>}

          <section className="development-tasks-workspace" aria-label={text.listTitle}>
            <div className="development-tasks-toolbar">
              <div className="development-tasks-filters" aria-label={text.listTitle}>{filterKeys.map((key) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => changeFilter(key)}>{text[key]}<span>{filterCounts[key]}</span></button>)}</div>
              <label className="development-tasks-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={text.search} placeholder={text.search} value={search} onChange={(event) => { const value = event.target.value; navigateTasks(() => setSearch(value)); }} /></label>
            </div>
            <div className="development-tasks-columns">
              <nav className="development-tasks-list" aria-label={text.listTitle}>
                <div className="development-tasks-list-heading"><h2>{text.listTitle}</h2><span aria-live="polite">{filtered.length} {text.tasksUnit}</span></div>
                {filtered.length === 0 ? <div className="development-tasks-empty"><p>{text.empty}</p><button type="button" onClick={() => navigateTasks(() => { setFilter('all'); setSearch(''); })}>{text.reset}</button></div> : (
                  <ol>{filtered.map((task) => {
                    const itemProgress = checklistProgress(task);
                    const needsHuman = pendingHumanRequirements(task).length;
                    return <li key={task.slug}><button type="button" className={`development-task-option ${!isNew && task.slug === selected?.slug ? 'is-selected' : ''}`} aria-current={!isNew && task.slug === selected?.slug ? 'true' : undefined} onClick={() => navigateTasks(() => setSelectedSlug(task.slug))}>
                      <span className="development-task-option-top"><span>{text.phase} {task.phase} · {task.priority}</span><span className={`development-task-status is-${task.status}`}>{statusLabels[lang][task.status]}</span></span>
                      <strong>{title(task)}</strong>
                      <span className="development-task-option-bottom"><span>{itemProgress.done}/{itemProgress.total} {text.checked}</span>{needsHuman > 0 && <span><Users size={12} aria-hidden="true" />{needsHuman}</span>}<ChevronRight size={15} aria-hidden="true" /></span>
                    </button></li>;
                  })}</ol>
                )}
              </nav>

              {draft && <TaskEditor draft={draft} tasks={tasks} isNew={isNew} lang={lang} saving={saving} dirty={dirty} temporaryFailed={temporaryFailed} changeNote={changeNote} onChangeNote={setChangeNote} onChange={setDraft} onSave={saveTask} onCancel={() => navigateTasks(() => undefined)} error={saveError} onLatest={loadLatest} />}
              {!draft && selected && progress && <article className="development-task-detail" aria-label={text.selected}>
                <div className="development-task-detail-heading"><div><span className="development-tasks-eyebrow">{text.phase} {selected.phase} · {phaseLabels[lang][selected.phase] ?? ''}</span><h2>{title(selected)}</h2></div><span className={`development-task-status is-${selected.status}`}>{statusLabels[lang][selected.status]}</span></div>
                <div className="development-task-detail-actions"><button type="button" className="development-task-primary" disabled={saving || response?.read_only} onClick={() => startEdit()}>{editText.edit}</button><button type="button" disabled={saving || response?.read_only} onClick={() => startEdit(selected.status === 'done' ? 'in_progress' : 'done')}>{selected.status === 'done' ? editText.reopen : editText.complete}</button></div>
                {text.bodyLanguage && <p className="development-tasks-muted">{text.bodyLanguage}</p>}
                <p className="development-task-goal" lang="ko">{selected.objective}</p>
                <dl className="development-task-meta"><div><dt>{text.priority}</dt><dd>{selected.priority}</dd></div><div><dt>{text.owner}</dt><dd lang="ko">{selected.owner}</dd></div><div><dt>{text.due}</dt><dd>{selected.due_date ?? text.noDue}</dd></div></dl>
                <div className="development-task-dependencies"><span>{text.dependencies}</span>{selected.dependencies.length ? selected.dependencies.map((slug) => {
                  const dependency = tasks.find((task) => task.slug === slug);
                  return dependency ? <button type="button" key={slug} onClick={() => openTask(slug)}>{title(dependency)}<ArrowRight size={13} aria-hidden="true" /></button> : <span key={slug}>{text.unknownDependency}</span>;
                }) : <p>{text.noDependencies}</p>}</div>

                <section className="development-task-section" aria-labelledby="development-task-requirements"><div className="development-task-section-heading"><h3 id="development-task-requirements">{text.requirements}</h3><span className="development-task-pending">{text.pending} {pendingCount}{text.requirementUnit}</span></div>
                  {requirementKinds.map((kind) => {
                    const requirements = selected.requirements.filter((requirement) => requirement.kind === kind);
                    if (!requirements.length) return null;
                    const Icon = kind === 'mes' ? Factory : kind === 'human' ? Users : FileCheck2;
                    return <div key={kind} className={`development-task-requirement-group is-${kind}`}><h4><Icon size={16} aria-hidden="true" />{kind === 'human' ? text.humanGroup : text[kind]}<span>{requirements.length}</span></h4><ul>{requirements.map((requirement) => <li key={requirement.id}><div><p lang="ko">{requirement.text}</p><span className={`development-requirement-status is-${requirement.status}`}>{text[requirement.status]}</span></div><p className="development-task-evidence"><span>{text.evidence}: </span><span lang={requirement.evidence ? 'ko' : lang}>{requirement.evidence || text.noEvidence}</span></p></li>)}</ul></div>;
                  })}
                </section>

                <section className="development-task-section" aria-labelledby="development-task-checklist"><div className="development-task-section-heading"><h3 id="development-task-checklist">{text.checklist}</h3><span>{progress.done}/{progress.total} {text.checked}</span></div><progress max={100} value={progress.percent} aria-label={text.checklist} />
                  {selected.checklist.length ? <ul className="development-task-checklist">{selected.checklist.map((item) => <li key={item.id}><button type="button" role="checkbox" aria-checked={item.done} disabled={saving || response?.read_only} onClick={() => startEdit(undefined, item.id)}>{item.done ? <CheckCircle2 size={18} aria-hidden="true" /> : <Square size={18} aria-hidden="true" />}<span lang="ko">{item.text}</span></button></li>)}</ul> : <p className="development-tasks-muted">{text.noChecklist}</p>}
                </section>

                <section className="development-task-section" aria-labelledby="development-task-implementation"><div className="development-task-section-heading"><h3 id="development-task-implementation">{text.implementation}</h3></div><span className={`development-task-release is-${selected.release_state}`}><CheckCircle2 size={14} aria-hidden="true" />{text[selected.release_state]}</span><p className="development-tasks-muted">{text.referenceNote}</p>
                  <div className="development-task-record"><h4>{text.completion}</h4><p lang={selected.completion_note ? 'ko' : lang}>{selected.completion_note || text.noCompletion}</p><h4>{text.verification}</h4><p lang={selected.verification_note ? 'ko' : lang}>{selected.verification_note || text.noVerification}</p></div>
                  <h4 className="development-task-locations-title">{text.locations}</h4>
                  {selected.locations.length ? <ul className="development-task-locations">{selected.locations.map((location, index) => {
                    const url = safeDevelopmentTaskUrl(location.url);
                    return <li key={`${location.kind}-${index}`}><span>{text[location.kind]}</span><div>{url ? <a href={url} target={url.startsWith('https://') ? '_blank' : undefined} rel={url.startsWith('https://') ? 'noopener noreferrer' : undefined}><span lang="ko">{location.label}</span><ExternalLink size={13} aria-hidden="true" /></a> : <span>{text.unsafeLink}</span>}{location.note && <p lang="ko">{location.note}</p>}</div></li>;
                  })}</ul> : <p className="development-tasks-muted">{text.noLocations}</p>}
                </section>
                <section className="development-task-section" aria-labelledby="development-task-history"><div className="development-task-section-heading"><h3 id="development-task-history">{editText.history}</h3></div>
                  {selected.updated_at && <p className="development-tasks-muted">{editText.updated}: {formatDate(selected.updated_at)} · Asia/Shanghai</p>}
                  {selected.completed_at && <p className="development-tasks-muted">{editText.completed}: {formatDate(selected.completed_at)} · Asia/Shanghai</p>}
                  {detailLoading ? <p role="status">{editText.historyLoading}</p> : detail?.task.slug === selected.slug && detail.history.length ? <ol className="development-task-history">{detail.history.map((entry) => <li key={entry.id}><div><strong>{({ create: editText.createAction, initialize: editText.initializeAction, update: editText.updateAction, complete: editText.completeAction, reopen: editText.reopenAction } as Record<string, string>)[entry.action] ?? entry.action}</strong><span>{entry.actor}</span></div><time dateTime={entry.created_at}>{formatDate(entry.created_at)}</time>{entry.change_note && <p>{entry.change_note}</p>}{entry.changed_fields.length > 0 && <p className="development-tasks-muted">{editText.historyFields}: {entry.changed_fields.map((field) => ({ title: editText.titleKo, title_zh: editText.titleZh, objective: editText.objective, phase: editText.phase, priority: editText.priority, status: editText.status, owner: editText.owner, due_date: editText.due, dependencies: editText.dependencies, requirements: editText.requirements, checklist: editText.checklist, locations: editText.locations, completion_note: editText.completion, verification_note: editText.verification, release_state: editText.release, sort_order: editText.order } as Record<string, string>)[field] ?? field).join(', ')}</p>}</li>)}</ol> : !detailError && <p className="development-tasks-muted">{editText.noHistory}</p>}
                  {detailError && <div role="alert"><p>{editText.historyFailure}</p><button type="button" onClick={() => setDetailReload((value) => value + 1)}>{text.retry}</button></div>}
                  {detail?.task.slug === selected.slug && detail.next_history_before && <button type="button" disabled={olderLoading || detailLoading} onClick={loadOlder}>{olderLoading ? editText.historyLoading : editText.older}</button>}
                </section>
              </article>}
            </div>
          </section>
          <footer className="development-tasks-footer">{text.catalog} {response?.catalog_version}</footer>
        </>
      )}
    </div>
  );
}

interface TaskEditorProps {
  draft: DevelopmentTask;
  tasks: DevelopmentTask[];
  isNew: boolean;
  lang: 'ko' | 'zh';
  saving: boolean;
  dirty: boolean;
  temporaryFailed: boolean;
  changeNote: string;
  onChangeNote: (value: string) => void;
  onChange: (value: DevelopmentTask) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  error: { message: string; conflict: boolean } | null;
  onLatest: () => Promise<void>;
}

function TaskEditor({ draft, tasks, isNew, lang, saving, dirty, temporaryFailed, changeNote, onChangeNote, onChange, onSave, onCancel, error, onLatest }: TaskEditorProps) {
  const text = editorCopy[lang];
  const read = copy[lang];
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); formRef.current?.focus({ preventScroll: true }); }, []);
  const update = (fields: Partial<DevelopmentTask>) => onChange({ ...draft, ...fields });
  const issues = developmentTaskCompletionIssues(draft, tasks);
  const cannotComplete = draft.status === 'done' && issues.length > 0;
  const requirementTitle = (kind: RequirementKind) => kind === 'human' ? read.humanGroup : read[kind];

  return <form ref={formRef} tabIndex={-1} aria-label={isNew ? text.create : text.edit} aria-busy={saving} className="development-task-detail development-task-editor" onSubmit={(event) => { event.preventDefault(); if (!cannotComplete && !saving) void onSave(); }}>
    <div className="development-task-detail-heading"><div><span className="development-tasks-eyebrow">{isNew ? text.unsavedNew : text.edit}</span><h2>{draft.title || text.create}</h2></div></div>
    <p className="development-tasks-muted">{dirty ? text.dirty : text.noChange}</p>
    {dirty && <p className={temporaryFailed ? 'development-task-invalid' : 'development-tasks-muted'}>{temporaryFailed ? text.temporaryFailed : text.temporarySaved}</p>}
    <fieldset disabled={saving} className="development-task-editor-fields">
      <section className="development-task-section"><h3>{text.basics}</h3><div className="development-task-form-grid">
        {isNew && <label className="development-task-form-full">{text.slug}<input required pattern="[a-z0-9]+((-|_)[a-z0-9]+)*" maxLength={100} value={draft.slug} onChange={(event) => update({ slug: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} /><small>{text.slugHint}</small></label>}
        <label className="development-task-form-full">{text.titleKo}<input required maxLength={200} value={draft.title} onChange={(event) => update({ title: event.target.value })} /></label>
        <label className="development-task-form-full">{text.titleZh}<input maxLength={200} value={draft.title_zh} onChange={(event) => update({ title_zh: event.target.value })} /></label>
        <label className="development-task-form-full">{text.objective}<textarea required rows={3} maxLength={6000} value={draft.objective} onChange={(event) => update({ objective: event.target.value })} /></label>
        <label>{text.status}<select value={draft.status} onChange={(event) => update({ status: event.target.value as TaskStatus })}>{Object.entries(statusLabels[lang]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>{text.phase}<select value={draft.phase} onChange={(event) => update({ phase: Number(event.target.value) })}>{phaseLabels[lang].map((label, index) => <option key={label} value={index}>{index} · {label}</option>)}</select></label>
        <label>{text.priority}<select value={draft.priority} onChange={(event) => update({ priority: event.target.value as DevelopmentTask['priority'] })}>{['P1', 'P2', 'P3'].map((priority) => <option key={priority}>{priority}</option>)}</select></label>
        <label>{text.order}<input type="number" required min={0} max={10000} step={1} value={draft.sort_order} onChange={(event) => update({ sort_order: Number(event.target.value) })} /></label>
        <label>{text.owner}<input required={draft.status === 'done'} maxLength={200} value={draft.owner} onChange={(event) => update({ owner: event.target.value })} /></label>
        <label>{text.due}<input type="date" value={draft.due_date ?? ''} onChange={(event) => update({ due_date: event.target.value || null })} /></label>
      </div></section>

      <section className="development-task-section"><h3>{text.dependencies}</h3><p className="development-tasks-muted">{text.dependenciesHint}</p><div className="development-task-dependency-options">
        {tasks.filter((task) => task.slug !== draft.slug).map((task) => <label key={task.slug}><input type="checkbox" checked={draft.dependencies.includes(task.slug)} onChange={(event) => update({ dependencies: event.target.checked ? [...draft.dependencies, task.slug] : draft.dependencies.filter((slug) => slug !== task.slug) })} /><span>{lang === 'zh' ? task.title_zh || task.title : task.title}<small>{statusLabels[lang][task.status]}</small></span></label>)}
        {tasks.every((task) => task.slug === draft.slug) && <p className="development-tasks-muted">{text.noItems}</p>}
      </div></section>

      <section className="development-task-section"><div className="development-task-section-heading"><h3>{text.requirements}</h3><button type="button" disabled={draft.requirements.length >= 60} onClick={() => update({ requirements: [...draft.requirements, { id: itemId('requirement'), kind: 'human', text: '', status: 'needed', evidence: '' }] })}><Plus size={15} aria-hidden="true" />{text.addRequirement}</button></div>
        {!draft.requirements.length && <p className="development-tasks-muted">{text.noItems}</p>}
        {draft.requirements.map((requirement, index) => {
          const updateRequirement = (fields: Partial<DevelopmentTask['requirements'][number]>) => update({ requirements: draft.requirements.map((item) => item.id === requirement.id ? { ...item, ...fields } : item) });
          return <fieldset key={requirement.id} className="development-task-edit-row"><legend>{text.requirements} {index + 1}</legend><div className="development-task-form-grid">
            <label>{text.kind}<select value={requirement.kind} onChange={(event) => updateRequirement({ kind: event.target.value as RequirementKind })}>{requirementKinds.map((kind) => <option key={kind} value={kind}>{requirementTitle(kind)}</option>)}</select></label>
            <label>{text.requirementStatus}<select value={requirement.status} onChange={(event) => updateRequirement({ status: event.target.value as DevelopmentTask['requirements'][number]['status'] })}>{(['needed', 'requested', 'ready'] as const).map((status) => <option key={status} value={status}>{read[status]}</option>)}</select></label>
            <label className="development-task-form-full">{text.requirementText}<textarea required rows={2} maxLength={2000} value={requirement.text} onChange={(event) => updateRequirement({ text: event.target.value })} /></label>
            <label className="development-task-form-full">{text.evidence}<textarea required={requirement.status === 'ready'} rows={2} maxLength={4000} value={requirement.evidence} onChange={(event) => updateRequirement({ evidence: event.target.value })} /></label>
          </div><button type="button" className="development-task-remove" aria-label={`${text.remove}: ${text.requirements} ${index + 1}`} onClick={() => update({ requirements: draft.requirements.filter((item) => item.id !== requirement.id) })}>{text.remove}</button></fieldset>;
        })}
      </section>

      <section className="development-task-section"><div className="development-task-section-heading"><h3>{text.checklist}</h3><button type="button" disabled={draft.checklist.length >= 60} onClick={() => update({ checklist: [...draft.checklist, { id: itemId('check'), text: '', done: false }] })}><Plus size={15} aria-hidden="true" />{text.addCheck}</button></div>
        {!draft.checklist.length && <p className="development-tasks-muted">{text.noItems}</p>}
        {draft.checklist.map((item, index) => <fieldset key={item.id} className="development-task-edit-row"><legend>{text.checklist} {index + 1}</legend><label>{text.checkText}<textarea required rows={2} maxLength={2000} value={item.text} onChange={(event) => update({ checklist: draft.checklist.map((entry) => entry.id === item.id ? { ...entry, text: event.target.value } : entry) })} /></label><div className="development-task-edit-row-actions"><label className="development-task-check-label"><input type="checkbox" checked={item.done} onChange={(event) => update({ checklist: draft.checklist.map((entry) => entry.id === item.id ? { ...entry, done: event.target.checked } : entry) })} />{text.checked}</label><button type="button" className="development-task-remove" aria-label={`${text.remove}: ${text.checklist} ${index + 1}`} onClick={() => update({ checklist: draft.checklist.filter((entry) => entry.id !== item.id) })}>{text.remove}</button></div></fieldset>)}
      </section>

      <section className="development-task-section"><div className="development-task-section-heading"><h3>{text.locations}</h3><button type="button" disabled={draft.locations.length >= 30} onClick={() => update({ locations: [...draft.locations, { kind: 'screen', label: '', url: '' }] })}><Plus size={15} aria-hidden="true" />{text.addLocation}</button></div>
        {!draft.locations.length && <p className="development-tasks-muted">{text.noItems}</p>}
        {draft.locations.map((location, index) => {
          const updateLocation = (fields: Partial<DevelopmentTask['locations'][number]>) => update({ locations: draft.locations.map((item, itemIndex) => itemIndex === index ? { ...item, ...fields } : item) });
          return <fieldset key={index} className="development-task-edit-row"><legend>{text.locations} {index + 1}</legend><div className="development-task-form-grid"><label>{text.locationKind}<select value={location.kind} onChange={(event) => updateLocation({ kind: event.target.value as DevelopmentTask['locations'][number]['kind'] })}>{(['screen', 'code', 'doc'] as const).map((kind) => <option value={kind} key={kind}>{read[kind]}</option>)}</select></label><label>{text.locationLabel}<input required maxLength={200} value={location.label} onChange={(event) => updateLocation({ label: event.target.value })} /></label><label className="development-task-form-full">{text.locationUrl}<input required maxLength={2000} value={location.url} onChange={(event) => updateLocation({ url: event.target.value })} placeholder={location.kind === 'screen' ? '/quality/analysis' : 'https://…'} autoCapitalize="none" autoCorrect="off" spellCheck={false} />{location.url && (!safeDevelopmentTaskUrl(location.url) || (location.kind === 'screen' && !location.url.startsWith('/'))) && <small className="development-task-invalid">{read.unsafeLink}</small>}</label></div><button type="button" className="development-task-remove" aria-label={`${text.remove}: ${text.locations} ${index + 1}`} onClick={() => update({ locations: draft.locations.filter((_, itemIndex) => itemIndex !== index) })}>{text.remove}</button></fieldset>;
        })}
      </section>

      <section className="development-task-section"><h3>{read.implementation}</h3><p className="development-tasks-muted">{text.completionHint}</p><div className="development-task-form-grid">
        <label className="development-task-form-full">{text.release}<select value={draft.release_state} onChange={(event) => update({ release_state: event.target.value as DevelopmentTask['release_state'] })}>{(['unreleased', 'code_available', 'deployed'] as const).map((state) => <option key={state} value={state}>{read[state]}</option>)}</select></label>
        <label className="development-task-form-full">{text.completion}<textarea required={draft.status === 'done'} rows={4} maxLength={6000} value={draft.completion_note} onChange={(event) => update({ completion_note: event.target.value })} /></label>
        <label className="development-task-form-full">{text.verification}<textarea required={draft.status === 'done'} rows={4} maxLength={6000} value={draft.verification_note} onChange={(event) => update({ verification_note: event.target.value })} /></label>
      </div></section>

      {!isNew && <section className="development-task-section"><label>{text.changeNote}<textarea required rows={2} maxLength={2000} value={changeNote} onChange={(event) => onChangeNote(event.target.value)} placeholder={text.changeHint} /></label></section>}
      {cannotComplete && <div className="development-task-completion-issues" role="note"><strong>{text.completionIssues}</strong><ul>{issues.map((issue) => <li key={issue}>{completionIssueCopy[lang][issue]}</li>)}</ul></div>}
    </fieldset>
    {error && <div className="development-task-save-error" role="alert"><p>{error.conflict && !isNew ? text.conflict : error.message}</p>{error.conflict && !isNew && <><p>{error.message}</p><button type="button" disabled={saving} onClick={onLatest}>{text.latest}</button></>}</div>}
    <div className="development-task-editor-actions"><span>{saving ? text.saving : dirty ? text.dirty : text.noChange}</span><div><button type="button" disabled={saving} onClick={onCancel}>{text.cancel}</button><button type="submit" className="development-task-primary" disabled={saving || !dirty || cannotComplete || (!isNew && !changeNote.trim())}>{saving ? text.saving : text.save}</button></div></div>
  </form>;
}
