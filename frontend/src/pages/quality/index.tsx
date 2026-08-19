import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ClipboardList, FileText, History } from 'lucide-react';
import { useLang } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import QualityReportForm from './QualityReportForm';
import QualityReportHistory from './QualityReportHistory';
import QualityExcelImport from './QualityExcelImport';
import QualityRecentReports from './QualityRecentReports';
import type { QualityReportHistoryScope } from './importTypes';

export default function QualityPage() {
  const { lang, t } = useLang();
  const { user, hasPermission } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const excelSectionRef = useRef<HTMLDivElement | null>(null);
  const [historyScope, setHistoryScope] = useState<QualityReportHistoryScope | null>(null);
  const canEditQuality = Boolean(user?.is_staff || hasPermission('can_edit_quality'));
  const isHistoryView = !canEditQuality || location.hash === '#stats';

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
    navigate('/quality#stats');
  };

  const openImportedReports = (scope: QualityReportHistoryScope) => {
    setHistoryScope(scope);
    navigate('/quality#stats');
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 md:px-8 md:py-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-xl bg-blue-600 p-2 text-white shadow-sm">
            <ClipboardList className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-950">{t('brand_quality')}</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {lang === 'zh' ? '登记、Excel 导入与最近履历集中管理' : '등록, Excel 가져오기, 최근 이력을 한곳에서 관리합니다.'}
            </p>
          </div>
        </div>

        <nav
          aria-label={lang === 'zh' ? '品质管理页面' : '품질 관리 화면'}
          className={`grid w-full rounded-xl border border-blue-200 bg-white/80 p-1 shadow-sm sm:w-auto ${canEditQuality ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {canEditQuality && (
            <button
              type="button"
              onClick={openWorkspace}
              aria-current={!isHistoryView ? 'page' : undefined}
              className={`inline-flex min-w-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                !isHistoryView
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-blue-50 hover:text-blue-700'
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
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'
            }`}
          >
            <History className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{lang === 'zh' ? '全部报告履历' : '전체 보고 이력'}</span>
          </button>
        </nav>
      </header>

      {canEditQuality && (
        <motion.div
          className={isHistoryView ? 'hidden' : 'space-y-5'}
          initial={false}
          animate={{ opacity: isHistoryView ? 0 : 1 }}
        >
          <section className="overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-sm" aria-labelledby="quality-registration-workspace-title">
            <div className="flex items-center gap-3 border-b border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 px-4 py-4 md:px-5">
              <span className="rounded-xl bg-blue-600 p-2.5 text-white shadow-sm">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="quality-registration-workspace-title" className="text-lg font-bold text-slate-950">
                  {lang === 'zh' ? '品质报告登记' : '품질 보고 등록'}
                </h2>
                <p className="mt-0.5 text-sm text-slate-500">
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
    </div>
  );
}
