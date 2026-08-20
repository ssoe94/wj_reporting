import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import {
  AlertTriangle,
  BrainCircuit,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Loader2,
  RefreshCw,
  Save,
  Search,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  X,
  ZoomIn,
} from 'lucide-react';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';

import api from '@/lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';

type LocalizedText = { ko?: string; zh?: string };

type TaxonomyTerm = {
  key: string;
  parent_key?: string | null;
  label: LocalizedText;
  observed_terms?: TaxonomyTerm[];
};

type AuditImageRef = { slot: string; url: string };

type AuditReport = {
  id: number;
  report_dt: string;
  updated_at: string;
  section: string;
  model: string;
  part_no: string;
  phenomenon: string;
  disposition: string;
  action_result: string;
  image_refs: AuditImageRef[];
};

type AuditReview = {
  status: 'accepted' | 'overridden' | 'rejected';
  category_keys: string[];
  product_color_key: string | null;
  product_color_label?: LocalizedText | null;
  exact_part_no: string;
  note: string;
  reviewed_by: string;
  reviewed_at: string;
  unresolved_reason_codes?: string[];
};

type AuditResult = {
  available: boolean;
  reason?: string | null;
  qwen_classification?: {
    candidate_selections?: Array<TaxonomyTerm & { candidate_index: number }>;
    confidence?: 'low' | 'medium' | 'high';
    needs_new_category?: boolean;
  };
  image_observations?: Array<{
    image_index: number;
    slot: string;
    product_visible: boolean;
    body_color_key: string;
    body_color_label: LocalizedText;
    confidence: 'low' | 'medium' | 'high';
    uncertainty_codes: string[];
  }>;
  product_color_suggestion?: {
    exact_part_no: string;
    suggested_color_key: string;
    suggested_color_label: LocalizedText;
    confidence: 'low' | 'medium' | 'high';
    evidence_image_slots: string[];
    status: string;
    match_basis: string;
  };
  master_color_comparison?: {
    status: string;
    master_color_key: string | null;
    master_color_raw: string;
    part_spec_valid_from: string | null;
  };
  review_required?: boolean;
  review_reason_codes?: string[];
  review?: AuditReview | null;
  master_color_application?: {
    part_spec_id: number;
    color_value: string;
    valid_from: string;
  };
};

type AuditCase = {
  report: AuditReport;
  source_revision: string;
  deterministic_classification: TaxonomyTerm[];
  taxonomy_candidates: TaxonomyTerm[];
  part_spec: {
    id: number | null;
    color_raw: string;
    color_key: string | null;
    valid_from: string | null;
    model_code: string;
    match_basis: string;
  };
  queue_status: string;
  job: {
    id: number;
    status: string;
    model_name: string;
    prompt_version: string;
    error_message: string;
    completed_at: string | null;
  } | null;
  result: AuditResult | null;
  exact_part_consensus: {
    report_count: number;
    assessable_photo_report_count: number;
    reviewed_report_count: number;
    qwen_high_confidence_report_count: number;
    dominant_color_key: string;
    dominant_color_label: LocalizedText;
    agreement_pct: number | null;
    color_counts: Record<string, number>;
    match_basis: string;
    confidence_basis: string;
  } | null;
};

type AuditQueue = {
  count: number;
  page: number;
  page_size: number;
  next_page: number | null;
  previous_page: number | null;
  stats: Record<string, number>;
  results: AuditCase[];
  taxonomy_version: string;
  color_match_policy: string;
};

type AuditEnqueueResult = {
  created_count: number;
  remaining_count?: number;
  total_report_count?: number;
};

const COLOR_LABELS: Record<string, LocalizedText> = {
  white: { ko: '백색', zh: '白色' },
  black: { ko: '검정', zh: '黑色' },
  gray: { ko: '회색', zh: '灰色' },
  silver: { ko: '은색', zh: '银色' },
  beige: { ko: '베이지', zh: '米色' },
  transparent: { ko: '투명', zh: '透明' },
  blue: { ko: '파랑', zh: '蓝色' },
  red: { ko: '빨강', zh: '红色' },
  other: { ko: '기타 색상', zh: '其他颜色' },
  undetermined: { ko: '판정 불가', zh: '无法判断' },
};

const CONFIDENCE_LABELS: Record<string, LocalizedText> = {
  high: { ko: '신뢰도 높음', zh: '高置信度' },
  medium: { ko: '신뢰도 보통', zh: '中等置信度' },
  low: { ko: '신뢰도 낮음', zh: '低置信度' },
};

const REVIEW_REASON_LABELS: Record<string, LocalizedText> = {
  dictionary_unclassified: { ko: '사전 미분류', zh: '词典未分类' },
  classification_disagreement: { ko: '사전과 Qwen 분류 불일치', zh: '词典与 Qwen 分类不一致' },
  low_confidence: { ko: '낮은 분류 신뢰도', zh: '分类置信度低' },
  needs_new_category: { ko: '새 분류 후보 필요', zh: '需要新增分类候选' },
  master_color_missing: { ko: '마스터 색상 미등록', zh: '主数据颜色未登记' },
  master_color_mismatch: { ko: '사진 추정색과 마스터 불일치', zh: '照片推测色与主数据不一致' },
  visual_color_uncertain: { ko: '사진 색상 판정 불확실', zh: '照片颜色判断不确定' },
  no_usable_image: { ko: '판독 가능한 사진 없음', zh: '没有可判读照片' },
  partial_image_processing: { ko: '일부 사진 처리 실패', zh: '部分照片处理失败' },
  unversioned_image_reference: { ko: '버전 고정 사진 주소 아님', zh: '照片地址未固定版本' },
};

const UNCERTAINTY_LABELS: Record<string, LocalizedText> = {
  lighting: { ko: '조명 영향', zh: '照明影响' },
  glare: { ko: '반사광', zh: '反光' },
  partial_product: { ko: '제품 일부만 보임', zh: '仅显示产品局部' },
  background_dominant: { ko: '배경 비중 큼', zh: '背景占比过大' },
  defect_mark_only: { ko: '불량 자국만 보임', zh: '仅显示不良痕迹' },
  multiple_products: { ko: '여러 제품이 함께 보임', zh: '同时显示多个产品' },
  conflicting_images: { ko: '사진 간 색상 충돌', zh: '照片间颜色冲突' },
};

function localized(value: LocalizedText | null | undefined, lang: string): string {
  if (!value) return '';
  return String((lang === 'zh' ? value.zh : value.ko) || value.ko || value.zh || '');
}

function deterministicLeafKeys(rows: TaxonomyTerm[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => (
    row.observed_terms?.length ? row.observed_terms.map((leaf) => leaf.key) : [row.key]
  )).filter((key) => key !== 'unclassified' && key !== 'missing')));
}

function taxonomyLabel(term: TaxonomyTerm, lang: string): string {
  if (term.observed_terms?.length) {
    return term.observed_terms.map((leaf) => localized(leaf.label, lang)).filter(Boolean).join('·');
  }
  return localized(term.label, lang);
}

function queueStatusClass(status: string): string {
  if (status === 'reviewed' || status === 'matched') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'needs_review' || status === 'failed') return 'bg-rose-50 text-rose-700 ring-rose-200';
  if (status === 'pending' || status === 'claimed' || status === 'running') return 'bg-amber-50 text-amber-700 ring-amber-200';
  return 'bg-slate-100 text-slate-600 ring-slate-200';
}

export default function QualityClassificationReview() {
  const { lang } = useLang();
  const { hasPermission, user } = useAuth();
  const location = useLocation();
  const canApplyMaster = Boolean(user?.is_staff || hasPermission('can_edit_injection'));
  const [statusFilter, setStatusFilter] = useState<'attention' | 'all'>('attention');
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [deepLinkReportId, setDeepLinkReportId] = useState<number | null>(() => {
    const value = new URLSearchParams(location.search).get('review_report');
    return value && Number.isInteger(Number(value)) ? Number(value) : null;
  });
  const [data, setData] = useState<AuditQueue | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<number | null>(() => {
    const value = new URLSearchParams(location.search).get('review_report');
    return value && Number.isInteger(Number(value)) ? Number(value) : null;
  });
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState<string[]>([]);
  const [selectedColorKey, setSelectedColorKey] = useState<string>('undetermined');
  const [colorConfirmed, setColorConfirmed] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [masterConfirmed, setMasterConfirmed] = useState(false);
  const [activeImage, setActiveImage] = useState<number | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);

  const copy = useMemo(() => (lang === 'zh'
    ? {
        title: 'AI 分类审核', subtitle: 'Qwen3.8 同时核对原文、照片与完整料号。',
        start: '添加接下来100份分析', refresh: '刷新', attention: '待关注', all: '全部',
        search: '搜索报告', searchPlaceholder: '完整料号、机种、原文、分类或颜色',
        empty: '没有符合当前条件的报告。', select: '请选择左侧报告。',
        raw: '报告原文', dictionary: '当前词典分类', qwen: 'Qwen 建议',
        photos: '原始照片', noPhoto: '无照片', productColor: 'Qwen 照片推测产品本体色',
        masterColor: '品目主数据颜色', consensus: '同一完整料号的人工确认颜色',
        exactWarning: '颜色只与报告中的完整料号精确关联。前9位相同的其他料号不参与一致度。',
        visualWarning: '白印、发白、反光或曝光过度不代表产品本体为白色。无法确认时必须选择“无法判断”。',
        categoryDecision: '不良分类确认', colorDecision: '产品颜色确认',
        colorConfirm: '我已直接查看照片并确认产品本体颜色',
        qwenEvidence: '照片判断依据', usedEvidence: '颜色依据', needsCategory: 'Qwen 判断当前候选词典中没有合适分类。请人工选择或保留为词典待补。',
        note: '审核备注', saveReview: '保存审核', reject: '驳回建议', keepGap: '保留为词典待补', enqueueOne: '分析此报告',
        applyMaster: '创建新的颜色主数据版本', confirmMaster: '已确认照片中的产品本体颜色',
        effective: '生效日期', saved: '已保存。', queued: '已加入分析队列。', applied: '已创建新的颜色主数据版本。', failed: '处理失败，请重试。',
        stale: '报告、照片、词典或主数据已变化。请重新分析。', conflict: '该生效日期已有不同颜色版本。请选择其他日期或先核对主数据。',
        approvedColor: '已审核颜色', suggestionOnly: '未审核建议',
        previous: '上一页', next: '下一页', closeImage: '关闭大图',
      }
    : {
        title: 'AI 분류 검토', subtitle: 'Qwen3.8이 원문·사진·전체 품번을 함께 대조합니다.',
        start: '다음 100건 분석 추가', refresh: '새로고침', attention: '확인 필요', all: '전체',
        search: '보고서 검색', searchPlaceholder: '전체 품번·모델·원문·분류·색상 검색',
        empty: '현재 조건에 맞는 보고가 없습니다.', select: '왼쪽에서 보고서를 선택하세요.',
        raw: '보고 원문', dictionary: '현재 사전 분류', qwen: 'Qwen 제안',
        photos: '원본 사진', noPhoto: '사진 없음', productColor: 'Qwen 사진상 제품 본체색',
        masterColor: '품목 마스터 색상', consensus: '동일 전체 품번의 사람 승인 색상',
        exactWarning: '색상은 보고서의 전체 Part No.에만 정확 매칭합니다. 앞 9자리만 같은 다른 품번은 일치도에 포함하지 않습니다.',
        visualWarning: '백색 자국(白印)·백화·반사·과노출은 제품 본체가 백색이라는 뜻이 아닙니다. 확신할 수 없으면 판정 불가로 둡니다.',
        categoryDecision: '불량 분류 확정', colorDecision: '제품 색상 확정',
        colorConfirm: '사진을 직접 보고 제품 본체색을 확인했습니다',
        qwenEvidence: '사진 판단 근거', usedEvidence: '색상 근거', needsCategory: 'Qwen이 현재 사전 후보에서 맞는 분류를 찾지 못했습니다. 직접 선택하거나 사전 보완 대상으로 남기세요.',
        note: '검토 메모', saveReview: '검토 저장', reject: '제안 반려', keepGap: '사전 보완 대상으로 남기기', enqueueOne: '이 보고 분석',
        applyMaster: '새 색상 마스터 버전 생성', confirmMaster: '사진의 제품 본체 색상을 직접 확인했습니다',
        effective: '유효 시작일', saved: '저장했습니다.', queued: '분석 대기열에 추가했습니다.', applied: '새 색상 마스터 버전을 생성했습니다.', failed: '처리하지 못했습니다. 다시 시도하세요.',
        stale: '보고서·사진·사전 또는 품목 마스터가 변경되었습니다. 다시 분석하세요.', conflict: '같은 유효 시작일에 다른 색상 버전이 있습니다. 날짜를 바꾸거나 마스터를 먼저 확인하세요.',
        approvedColor: '검토 승인 색상', suggestionOnly: '미검토 제안',
        previous: '이전', next: '다음', closeImage: '큰 사진 닫기',
      }), [lang]);

  const loadQueue = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const params: Record<string, string | number> = {
        status: statusFilter,
        page,
        page_size: 20,
      };
      if (searchQuery) params.search = searchQuery;
      if (deepLinkReportId) {
        params.report_id = deepLinkReportId;
        params.status = 'all';
      }
      const response = await api.get<AuditQueue>('/quality/classification-audit/', { params });
      setData(response.data);
      setSelectedReportId((current) => {
        if (current && response.data.results.some((row) => row.report.id === current)) return current;
        return response.data.results[0]?.report.id ?? null;
      });
    } catch {
      setError(copy.failed);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [copy.failed, deepLinkReportId, page, searchQuery, statusFilter]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  useEffect(() => {
    if (!data || !(data.stats.pending || data.stats.claimed || data.stats.running)) return undefined;
    const timer = window.setInterval(() => { void loadQueue(true); }, 15_000);
    return () => window.clearInterval(timer);
  }, [data, loadQueue]);

  const selected = useMemo(
    () => data?.results.find((row) => row.report.id === selectedReportId) ?? null,
    [data, selectedReportId],
  );
  const approvedReviewColorKey = selected?.result?.review?.product_color_key ?? null;

  useEffect(() => {
    if (!selected) return;
    const qwenKeys = selected.result?.qwen_classification?.candidate_selections?.map((row) => row.key) ?? [];
    const hasAvailableQwenResult = selected.result?.available === true;
    setSelectedCategoryKeys(
      selected.result?.review?.category_keys
      ?? (hasAvailableQwenResult ? qwenKeys : deterministicLeafKeys(selected.deterministic_classification)),
    );
    setSelectedColorKey(
      selected.result?.review?.product_color_key
      ?? selected.result?.product_color_suggestion?.suggested_color_key
      ?? 'undetermined',
    );
    setReviewNote(selected.result?.review?.note ?? '');
    setColorConfirmed(Boolean(selected.result?.review?.product_color_key));
    setEffectiveDate(dayjs().format('YYYY-MM-DD'));
    setMasterConfirmed(false);
    setActiveImage(null);
  }, [selected]);

  const chooseReport = (reportId: number) => {
    setSelectedReportId(reportId);
    if (window.matchMedia('(max-width: 1279px)').matches) {
      window.requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        detailRef.current?.focus({ preventScroll: true });
      });
    }
  };

  const responseErrorCode = (caught: unknown): string => {
    const response = (caught as { response?: { data?: { code?: string } } })?.response;
    return String(response?.data?.code || '');
  };

  const startAudit = async (reportIds?: number[]) => {
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const response = await api.post<AuditEnqueueResult>('/quality/classification-audit/', {
        ...(reportIds ? { report_ids: reportIds } : {}),
        limit: reportIds ? reportIds.length : 100,
      });
      const createdCount = response.data.created_count ?? 0;
      const remainingCount = response.data.remaining_count ?? 0;
      setNotice(reportIds
        ? copy.queued
        : (lang === 'zh'
          ? `已添加 ${createdCount} 份，尚有 ${remainingCount} 份待加入。`
          : `${createdCount}건을 추가했고 ${remainingCount}건이 아직 대기열 추가 대상입니다.`));
      await loadQueue(true);
    } catch {
      setError(copy.failed);
    } finally {
      setMutating(false);
    }
  };

  const toggleCategory = (key: string) => {
    setSelectedCategoryKeys((current) => (
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
    ));
  };

  const saveReview = async (rejected = false) => {
    if (!selected?.job) return;
    const qwenKeys = selected.result?.qwen_classification?.candidate_selections?.map((row) => row.key).sort() ?? [];
    const chosen = [...selectedCategoryKeys].sort();
    const qwenColor = selected.result?.product_color_suggestion?.suggested_color_key ?? 'undetermined';
    const approvedColor = colorConfirmed ? selectedColorKey : null;
    const classificationMatches = JSON.stringify(qwenKeys) === JSON.stringify(chosen);
    const colorMatches = approvedColor === null || approvedColor === qwenColor;
    const action = rejected
      ? 'rejected'
      : (classificationMatches && colorMatches ? 'accepted' : 'overridden');
    setMutating(true);
    setError('');
    setNotice('');
    try {
      await api.post(`/quality/classification-audit/${selected.job.id}/review/`, {
        action,
        category_keys: rejected ? [] : selectedCategoryKeys,
        product_color_key: rejected ? null : approvedColor,
        note: reviewNote,
      });
      setNotice(copy.saved);
      await loadQueue(true);
    } catch (caught) {
      setError(responseErrorCode(caught) === 'stale_revision' ? copy.stale : copy.failed);
    } finally {
      setMutating(false);
    }
  };

  const applyMasterColor = async () => {
    const approvedColor = selected?.result?.review?.product_color_key;
    if (!selected?.job || !masterConfirmed || !approvedColor) return;
    setMutating(true);
    setError('');
    setNotice('');
    try {
      await api.post(`/quality/classification-audit/${selected.job.id}/apply-color/`, {
        color_key: approvedColor,
        valid_from: effectiveDate,
        confirmation: 'CONFIRM_EXACT_PART_COLOR',
      });
      setNotice(copy.applied);
      await loadQueue(true);
    } catch (caught) {
      const code = responseErrorCode(caught);
      setError(code === 'stale_revision' ? copy.stale : code === 'part_spec_version_conflict' ? copy.conflict : copy.failed);
    } finally {
      setMutating(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDeepLinkReportId(null);
    setPage(1);
    setSearchQuery(searchInput.trim());
  };

  const activeImageUrl = activeImage === null ? null : selected?.report.image_refs[activeImage]?.url ?? null;
  const moveImage = (direction: -1 | 1) => {
    if (!selected || activeImage === null || selected.report.image_refs.length < 2) return;
    const next = (activeImage + direction + selected.report.image_refs.length) % selected.report.image_refs.length;
    setActiveImage(next);
  };

  const statusLabel = (status: string) => {
    const labels: Record<string, LocalizedText> = {
      unprocessed: { ko: '미분석', zh: '未分析' }, pending: { ko: '대기', zh: '等待' },
      total: { ko: '전체 보고', zh: '全部报告' }, with_images: { ko: '사진 있음', zh: '有照片' },
      claimed: { ko: '준비 중', zh: '准备中' }, running: { ko: '분석 중', zh: '分析中' },
      needs_review: { ko: '확인 필요', zh: '需确认' }, failed: { ko: '분석 실패', zh: '分析失败' },
      matched: { ko: '자동 일치', zh: '自动一致' }, reviewed: { ko: '검토 완료', zh: '审核完成' },
    };
    return localized(labels[status], lang) || status;
  };

  return (
    <section className="space-y-4" aria-labelledby="quality-classification-review-title">
      <div className="rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50 via-white to-cyan-50 p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="rounded-xl bg-indigo-600 p-2.5 text-white shadow-sm"><BrainCircuit className="h-5 w-5" /></span>
            <div>
              <h2 id="quality-classification-review-title" className="text-xl font-bold text-slate-950">{copy.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{copy.subtitle}</p>
              <p className="mt-1 text-xs font-medium text-indigo-700">{data?.taxonomy_version ?? '-'}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void startAudit()} disabled={mutating} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50">
              {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{copy.start}
            </button>
            <button type="button" onClick={() => void loadQueue()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{copy.refresh}
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {['total', 'with_images', 'unprocessed', 'pending', 'needs_review', 'matched', 'reviewed'].map((key) => (
            <div key={key} className="rounded-xl border border-white bg-white/80 px-3 py-2 shadow-sm">
              <div className="text-[11px] font-semibold text-slate-500">{statusLabel(key)}</div>
              <div className="mt-0.5 text-lg font-bold text-slate-950">{data?.stats[key] ?? 0}</div>
            </div>
          ))}
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}
      {notice && <div role="status" aria-live="polite" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</div>}

      <div className="grid min-h-[620px] gap-4 xl:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.7fr)]">
        <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="space-y-3 border-b border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded-lg bg-slate-100 p-1">
              {(['attention', 'all'] as const).map((value) => (
                <button key={value} type="button" aria-pressed={statusFilter === value} onClick={() => { setDeepLinkReportId(null); setStatusFilter(value); setPage(1); }} className={`rounded-md px-3 py-1.5 text-xs font-bold ${statusFilter === value ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}>
                  {value === 'attention' ? copy.attention : copy.all}
                </button>
              ))}
              </div>
              <span className="text-xs font-semibold text-slate-500">{data?.count ?? 0}</span>
            </div>
            <form onSubmit={submitSearch} className="flex gap-2" role="search">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">{copy.searchPlaceholder}</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={copy.searchPlaceholder} className="h-10 w-full rounded-xl border border-slate-200 pl-9 pr-3 text-sm" />
              </label>
              <button type="submit" className="rounded-xl bg-slate-900 px-3 text-sm font-bold text-white" aria-label={copy.search}>{copy.search}</button>
            </form>
          </div>
          <div className="max-h-[min(52dvh,520px)] overflow-y-auto p-2 xl:max-h-[720px]">
            {loading && !data ? <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div> : null}
            {!loading && data?.results.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">{copy.empty}</p> : null}
            <div className="space-y-2">
              {data?.results.map((row) => {
                const selectedRow = row.report.id === selectedReportId;
                const qwenLabels = row.result?.qwen_classification?.candidate_selections?.map((term) => localized(term.label, lang)).filter(Boolean) ?? [];
                return (
                          <button key={row.report.id} type="button" aria-pressed={selectedRow} onClick={() => chooseReport(row.report.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedRow ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-100' : 'border-slate-200 bg-white hover:border-indigo-200 hover:bg-slate-50'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-500">{dayjs(row.report.report_dt).format('YYYY-MM-DD')} · {row.report.section}</span>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-bold ring-1 ring-inset ${queueStatusClass(row.queue_status)}`}>{statusLabel(row.queue_status)}</span>
                    </div>
                    <div className="mt-2 truncate text-sm font-bold text-slate-950">{row.report.part_no || '-'}</div>
                    <div className="text-xs font-medium text-slate-600">{row.report.model || '-'}</div>
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-700">{row.report.phenomenon || '-'}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(qwenLabels.length ? qwenLabels : row.deterministic_classification.map((term) => taxonomyLabel(term, lang))).map((label) => (
                        <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{label}</span>
                      ))}
                      {row.report.image_refs.length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold text-cyan-700"><Camera className="h-3 w-3" />{row.report.image_refs.length}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 p-3">
            <button type="button" disabled={!data?.previous_page} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-40">{copy.previous}</button>
            <span className="text-xs font-semibold text-slate-500">{data?.page ?? 1}</span>
            <button type="button" disabled={!data?.next_page} onClick={() => setPage((value) => value + 1)} className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-40">{copy.next}</button>
          </div>
        </aside>

        <article ref={detailRef} tabIndex={-1} className="min-w-0 scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 sm:p-5">
          {!selected ? <div className="flex min-h-[500px] items-center justify-center text-sm text-slate-500">{copy.select}</div> : (
            <div className="space-y-5">
              <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-xs font-bold uppercase tracking-[0.12em] text-indigo-600">Report #{selected.report.id}</div>
                  <h3 className="mt-1 break-words text-xl font-bold text-slate-950">{selected.report.part_no || '-'}</h3>
                  <p className="mt-1 text-sm font-semibold text-slate-600">{selected.report.model || '-'} · {selected.report.section} · {dayjs(selected.report.report_dt).format('YYYY-MM-DD HH:mm')}</p>
                </div>
                <span className={`self-start rounded-full px-3 py-1.5 text-xs font-bold ring-1 ring-inset ${queueStatusClass(selected.queue_status)}`}>{statusLabel(selected.queue_status)}</span>
              </header>

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <h4 className="text-sm font-bold text-slate-900">{copy.raw}</h4>
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">{selected.report.phenomenon || '-'}</p>
                  {(selected.report.disposition || selected.report.action_result) && <div className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-600">{selected.report.disposition}<br />{selected.report.action_result}</div>}
                </section>
                <section className="rounded-xl border border-slate-200 p-4">
                  <h4 className="text-sm font-bold text-slate-900">{copy.photos} <span className="text-slate-400">{selected.report.image_refs.length}</span></h4>
                  {selected.report.image_refs.length ? (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {selected.report.image_refs.map((image, index) => {
                        const observation = selected.result?.image_observations?.find((row) => row.slot === image.slot);
                        const isColorEvidence = selected.result?.product_color_suggestion?.evidence_image_slots?.includes(image.slot);
                        return (
                          <button key={image.slot} type="button" onClick={() => setActiveImage(index)} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200">
                            <img src={image.url} alt={`${selected.report.part_no} ${copy.photos} ${index + 1}`} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
                            {observation && (
                              <span className="absolute bottom-2 left-2 max-w-[75%] truncate rounded-full bg-white/90 px-2 py-1 text-[10px] font-bold text-slate-900 shadow-sm">
                                {localized(observation.body_color_label, lang)} · {localized(CONFIDENCE_LABELS[observation.confidence], lang)}
                              </span>
                            )}
                            {isColorEvidence && <span className="absolute left-2 top-2 rounded-full bg-cyan-700 px-2 py-1 text-[10px] font-bold text-white shadow-sm">{copy.usedEvidence}</span>}
                            <span className="absolute bottom-2 right-2 rounded-full bg-slate-950/70 p-1.5 text-white"><ZoomIn className="h-3.5 w-3.5" /></span>
                          </button>
                        );
                      })}
                    </div>
                  ) : <div className="mt-4 flex items-center gap-2 text-sm text-slate-500"><ImageOff className="h-4 w-4" />{copy.noPhoto}</div>}
                </section>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border border-blue-200 bg-blue-50/60 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-bold text-blue-950"><SearchCheck className="h-4 w-4" />{copy.dictionary}</h4>
                  <div className="mt-3 flex flex-wrap gap-2">{selected.deterministic_classification.map((term) => <span key={term.key} className="rounded-full bg-white px-3 py-1 text-xs font-bold text-blue-700 ring-1 ring-blue-200">{taxonomyLabel(term, lang)}</span>)}</div>
                </section>
                <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-bold text-violet-950"><Sparkles className="h-4 w-4" />{copy.qwen}</h4>
                  {selected.result?.available ? (
                    <>
                      <div className="mt-3 flex flex-wrap gap-2">{selected.result.qwen_classification?.candidate_selections?.map((term) => <span key={term.key} className="rounded-full bg-white px-3 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200">{localized(term.label, lang)}</span>)}</div>
                      <p className="mt-3 text-xs font-semibold text-violet-700">{localized(CONFIDENCE_LABELS[selected.result.qwen_classification?.confidence ?? ''], lang) || '-'}</p>
                      {selected.result.qwen_classification?.needs_new_category && <p className="mt-3 rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs font-semibold leading-5 text-violet-900">{copy.needsCategory}</p>}
                    </>
                  ) : <p className="mt-3 text-sm text-violet-700">{selected.job?.status === 'failed' ? selected.job.error_message : statusLabel(selected.queue_status)}</p>}
                </section>
              </div>

              <section className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-4">
                <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-700" /><div><h4 className="text-sm font-bold text-cyan-950">{copy.productColor}</h4><p className="mt-1 text-xs leading-5 text-cyan-800">{copy.visualWarning}</p></div></div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-white p-3 ring-1 ring-cyan-100"><div className="text-[11px] font-semibold text-slate-500">{copy.productColor}</div><div className="mt-1 text-base font-bold text-slate-950">{localized(selected.result?.product_color_suggestion?.suggested_color_label, lang) || '-'}</div><div className="mt-1 text-xs text-slate-500">{localized(CONFIDENCE_LABELS[selected.result?.product_color_suggestion?.confidence ?? ''], lang) || '-'}</div></div>
                  <div className="rounded-lg bg-white p-3 ring-1 ring-cyan-100"><div className="text-[11px] font-semibold text-slate-500">{copy.masterColor}</div><div className="mt-1 text-base font-bold text-slate-950">{selected.part_spec.color_raw || '-'}</div><div className="mt-1 text-xs text-slate-500">{selected.part_spec.valid_from || '-'}</div></div>
                  <div className="rounded-lg bg-white p-3 ring-1 ring-cyan-100"><div className="text-[11px] font-semibold text-slate-500">{copy.consensus}</div><div className="mt-1 text-base font-bold text-slate-950">{selected.exact_part_consensus ? `${localized(selected.exact_part_consensus.dominant_color_label, lang)} · ${selected.exact_part_consensus.agreement_pct}%` : '-'}</div><div className="mt-1 text-xs text-slate-500">{selected.exact_part_consensus ? `${copy.approvedColor} ${selected.exact_part_consensus.reviewed_report_count ?? 0}` : '-'}</div></div>
                </div>
                <p className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs font-semibold leading-5 text-cyan-900">{copy.exactWarning}</p>
                {(selected.result?.image_observations?.length || selected.result?.review_reason_codes?.length) ? (
                  <div className="mt-3 rounded-lg border border-cyan-100 bg-white/80 p-3">
                    <div className="text-xs font-bold text-cyan-950">{copy.qwenEvidence}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Array.from(new Set(selected.result.image_observations?.flatMap((row) => row.uncertainty_codes) ?? [])).map((code) => (
                        <span key={`uncertainty-${code}`} className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">{localized(UNCERTAINTY_LABELS[code], lang) || code}</span>
                      ))}
                      {selected.result.review_reason_codes?.map((code) => (
                        <span key={`reason-${code}`} className="rounded-full bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-800 ring-1 ring-rose-200">{localized(REVIEW_REASON_LABELS[code], lang) || code}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>

              {selected.job?.status === 'completed' && selected.result?.available ? (
                <section className="rounded-xl border border-slate-200 p-4">
                  <div className="grid gap-5 lg:grid-cols-2">
                    <div>
                      <h4 className="text-sm font-bold text-slate-950">{copy.categoryDecision}</h4>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {selected.taxonomy_candidates.map((term) => {
                          const active = selectedCategoryKeys.includes(term.key);
                          return <button key={term.key} type="button" aria-pressed={active} onClick={() => toggleCategory(term.key)} className={`rounded-full px-3 py-1.5 text-xs font-bold ring-1 ring-inset ${active ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-slate-600 ring-slate-200'}`}>{active && <Check className="mr-1 inline h-3 w-3" />}{localized(term.label, lang)}</button>;
                        })}
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-bold text-slate-950" htmlFor="audit-product-color">{copy.colorDecision}</label>
                      <select id="audit-product-color" value={selectedColorKey} onChange={(event) => { setSelectedColorKey(event.target.value); setColorConfirmed(false); }} className="mt-3 w-full rounded-xl border-slate-300 text-sm">
                        {Object.entries(COLOR_LABELS).map(([key, label]) => <option key={key} value={key}>{localized(label, lang)}</option>)}
                      </select>
                      <label className="mt-3 flex items-start gap-2 text-xs font-semibold leading-5 text-slate-700"><input type="checkbox" checked={colorConfirmed} onChange={(event) => setColorConfirmed(event.target.checked)} className="mt-0.5 rounded border-slate-300" />{copy.colorConfirm}</label>
                    </div>
                  </div>
                  <label className="mt-4 block text-sm font-bold text-slate-950" htmlFor="audit-review-note">{copy.note}</label>
                  <textarea id="audit-review-note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={2} className="mt-2 w-full rounded-xl border-slate-300 text-sm" />
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void saveReview(false)} disabled={mutating || selectedCategoryKeys.length === 0} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"><Save className="h-4 w-4" />{copy.saveReview}</button>
                    <button type="button" onClick={() => void saveReview(true)} disabled={mutating} className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-bold text-rose-700 disabled:opacity-40">{selected.result.qwen_classification?.needs_new_category ? copy.keepGap : copy.reject}</button>
                  </div>
                </section>
              ) : (
                <button type="button" onClick={() => void startAudit([selected.report.id])} disabled={mutating || ['pending', 'claimed', 'running'].includes(selected.queue_status)} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">{mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{copy.enqueueOne}</button>
              )}

              {canApplyMaster && selected.result?.review && selected.result.review.status !== 'rejected' && approvedReviewColorKey && approvedReviewColorKey !== 'undetermined' && approvedReviewColorKey !== 'other' && !selected.result.master_color_application ? (
                <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-bold text-amber-950"><AlertTriangle className="h-4 w-4" />{copy.applyMaster}</h4>
                  <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 text-sm font-bold text-amber-950">{copy.approvedColor}: {selected.result.review.exact_part_no} → {localized(COLOR_LABELS[approvedReviewColorKey], lang)}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <label className="text-xs font-bold text-amber-950">{copy.effective}<input type="date" value={effectiveDate} max={dayjs().format('YYYY-MM-DD')} onChange={(event) => setEffectiveDate(event.target.value)} className="mt-1 block w-full rounded-lg border-amber-300 bg-white text-sm" /></label>
                    <button type="button" onClick={() => void applyMasterColor()} disabled={!masterConfirmed || mutating} className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"><Save className="h-4 w-4" />{copy.applyMaster}</button>
                  </div>
                  <label className="mt-3 flex items-start gap-2 text-xs font-semibold leading-5 text-amber-950"><input type="checkbox" checked={masterConfirmed} onChange={(event) => setMasterConfirmed(event.target.checked)} className="mt-0.5 rounded border-amber-400" />{copy.confirmMaster}: {selected.result.review.exact_part_no} → {localized(COLOR_LABELS[approvedReviewColorKey], lang)}</label>
                </section>
              ) : null}
            </div>
          )}
        </article>
      </div>

      <Dialog open={Boolean(activeImageUrl)} onClose={() => setActiveImage(null)} className="relative z-[100]">
        <DialogBackdrop className="fixed inset-0 bg-slate-950/90" />
        <div className="fixed inset-0 flex items-center justify-center p-3 sm:p-6">
          <DialogPanel className="relative flex h-full w-full max-w-6xl items-center justify-center">
            <DialogTitle className="sr-only">{selected?.report.part_no} {copy.photos}</DialogTitle>
            <button type="button" onClick={() => setActiveImage(null)} aria-label={copy.closeImage} className="absolute right-0 top-0 z-10 rounded-full bg-white/10 p-3 text-white"><X className="h-5 w-5" /></button>
            {selected && selected.report.image_refs.length > 1 && <><button type="button" onClick={() => moveImage(-1)} className="absolute left-0 z-10 rounded-full bg-white/10 p-3 text-white" aria-label={copy.previous}><ChevronLeft className="h-6 w-6" /></button><button type="button" onClick={() => moveImage(1)} className="absolute right-0 z-10 rounded-full bg-white/10 p-3 text-white" aria-label={copy.next}><ChevronRight className="h-6 w-6" /></button></>}
            {activeImageUrl && <img src={activeImageUrl} alt={`${selected?.report.part_no ?? ''} ${copy.photos}`} className="max-h-full max-w-full object-contain" />}
          </DialogPanel>
        </div>
      </Dialog>
    </section>
  );
}
