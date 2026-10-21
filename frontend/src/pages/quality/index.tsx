import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BrainCircuit, ClipboardList, FileText, History } from 'lucide-react';
import { useLang } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import QualityReportForm from './QualityReportForm';
import QualityReportHistory from './QualityReportHistory';
import QualityExcelImport from './QualityExcelImport';
import QualityRecentReports from './QualityRecentReports';
import QualityClassificationReview from './QualityClassificationReview';
import type { QualityReportHistoryScope } from './importTypes';

export default function QualityPage() {
  const { lang, t } = useLang();
  const { user, hasPermission } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const excelSectionRef = useRef<HTMLDivElement | null>(null);
  const [historyScope, setHistoryScope] = useState<QualityReportHistoryScope | null>(null);
  const canEditQuality = Boolean(user?.is_staff || hasPermission('can_edit_quality'));
  const isReviewView = canEditQuality && location.hash === '#review';
  const isHistoryView = !canEditQuality || ['#stats', '#history'].includes(location.hash);
  const isWorkspaceView = canEditQuality && !isHistoryView && !isReviewView;

  useEffect(() => {
    if (!canEditQuality || location.hash !== '#import') return;
    const frame = window.requestAnimationFrame(() => {
      excelSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canEditQuality, location.hash]);

  const openWorkspace = () => {
    navigate('/quality#report');
  };

  const openAllHistory = () => {
    setHistoryScope(null);
    navigate('/quality#history');
  };

  const openClassificationReview = () => {
    navigate('/quality#review');
  };

  const openImportedReports = (scope: QualityReportHistoryScope) => {
    setHistoryScope(scope);
    navigate('/quality#history');
  };

  return (
    <div className={`mx-auto w-full space-y-5 py-5 md:py-6 ${isHistoryView ? 'max-w-[1680px]' : 'max-w-7xl px-4 md:px-8'}`}>
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-xl bg-[var(--wj-accent-strong)] p-2 text-[var(--wj-on-accent)] shadow-sm">
            <ClipboardList className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-[var(--wj-text)]">{t('brand_quality')}</h1>
            <p className="mt-0.5 text-sm text-[var(--wj-muted)]">
              {lang === 'zh' ? '登记、Excel 导入与最近履历集中管理' : '등록, Excel 가져오기, 최근 이력을 한곳에서 관리합니다.'}
            </p>
          </div>
        </div>

        <nav
          aria-label={lang === 'zh' ? '品质管理页面' : '품질 관리 화면'}
          className={`grid w-full rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-1 shadow-sm sm:w-auto ${canEditQuality ? 'grid-cols-3' : 'grid-cols-1'}`}
        >
          {canEditQuality && (
            <button
              type="button"
              onClick={openWorkspace}
              aria-current={isWorkspaceView ? 'page' : undefined}
              className={`inline-flex min-w-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                isWorkspaceView
                  ? 'bg-[var(--wj-accent-strong)] text-[var(--wj-on-accent)] shadow-sm'
                  : 'text-[var(--wj-muted)] hover:bg-[var(--wj-bg-strong)] hover:text-[var(--wj-accent-strong)]'
              }`}
            >
              <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{lang === 'zh' ? '品质登记' : '품질 등록'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={openAllHistory}
            aria-current={isHistoryView ? 'page' : undefined}
            className={`inline-flex min-w-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
              isHistoryView
                ? 'bg-indigo-600 text-[var(--wj-on-accent)] shadow-sm'
                : 'text-[var(--wj-muted)] hover:bg-indigo-50 hover:text-indigo-700'
            }`}
          >
            <History className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{lang === 'zh' ? '全部报告履历' : '전체 보고 이력'}</span>
          </button>
          {canEditQuality && (
            <button
              type="button"
              onClick={openClassificationReview}
              aria-current={isReviewView ? 'page' : undefined}
              className={`inline-flex min-w-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                isReviewView
                  ? 'bg-violet-600 text-[var(--wj-on-accent)] shadow-sm'
                  : 'text-[var(--wj-muted)] hover:bg-violet-50 hover:text-violet-700'
              }`}
            >
              <BrainCircuit className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{lang === 'zh' ? 'AI 分类审核' : 'AI 분류 검토'}</span>
            </button>
          )}
        </nav>
      </header>

      <div className="flex justify-end"><Link className="inline-flex items-center gap-2 rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] px-4 py-2 text-sm font-semibold text-[var(--wj-accent-strong)] hover:bg-[var(--wj-bg-strong)]" to="/quality/analysis">{lang === 'zh' ? '查看独立不良分析报告 →' : '불량 통계 분석 보고서 보기 →'}</Link></div>

      {canEditQuality && (
        <motion.div
          className={isWorkspaceView ? 'space-y-5' : 'hidden'}
          initial={false}
          animate={{ opacity: isWorkspaceView ? 1 : 0 }}
        >
          <section className="overflow-hidden rounded-2xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] shadow-sm" aria-labelledby="quality-registration-workspace-title">
            <div className="flex items-center gap-3 border-b border-[var(--wj-border)] bg-gradient-to-r from-[var(--wj-bg-strong)] via-[var(--wj-surface-solid)] to-[var(--wj-bg-strong)] px-4 py-4 md:px-5">
              <span className="rounded-xl bg-[var(--wj-accent-strong)] p-2.5 text-[var(--wj-on-accent)] shadow-sm">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="quality-registration-workspace-title" className="text-lg font-bold text-[var(--wj-text)]">
                  {lang === 'zh' ? '品质报告登记' : '품질 보고 등록'}
                </h2>
                <p className="mt-0.5 text-sm text-[var(--wj-muted)]">
                  {lang === 'zh' ? '直接输入单件报告，或从 Excel 批量登记。' : '개별 보고서를 직접 입력하거나 Excel로 여러 건을 등록합니다.'}
                </p>
              </div>
            </div>

            <QualityReportForm embedded />

            <div ref={excelSectionRef} id="quality-excel-import-section" className="scroll-mt-5">
              <QualityExcelImport embedded onPostProcess={openImportedReports} />
            </div>
          </section>

          <QualityRecentReports onViewAll={openAllHistory} />
        </motion.div>
      )}

      {isHistoryView && (
        <motion.div
          key="quality-full-history"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <QualityReportHistory
            reportScope={historyScope}
            onClearReportScope={() => setHistoryScope(null)}
          />
        </motion.div>
      )}

      {isReviewView && (
        <motion.div
          key="quality-classification-review"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <QualityClassificationReview />
        </motion.div>
      )}
    </div>
  );
}
