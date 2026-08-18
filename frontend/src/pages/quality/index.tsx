import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useLang } from '../../i18n';
import QualityReportForm from './QualityReportForm';
import QualityReportHistory from './QualityReportHistory';
import QualityExcelImport from './QualityExcelImport';
import type { QualityReportHistoryScope } from './importTypes';
import { ClipboardList, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

type QualityTab = 'report' | 'import' | 'history';

export default function QualityPage() {
  const { t } = useLang();
  const { user, hasPermission } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<QualityTab>('report');
  const [historyScope, setHistoryScope] = useState<QualityReportHistoryScope | null>(null);
  const canEditQuality = Boolean(user?.is_staff || hasPermission('can_edit_quality'));

  useEffect(() => {
    if (location.hash === '#stats') {
      setActiveTab('history');
    } else if (location.hash === '#import' && canEditQuality) {
      setActiveTab('import');
    } else if (canEditQuality) {
      setActiveTab('report');
    } else {
      setActiveTab('history');
    }
  }, [canEditQuality, location.hash]);

  const selectTab = (tab: QualityTab) => {
    if (!canEditQuality && tab !== 'history') return;
    if (tab === 'history') setHistoryScope(null);
    const hash = tab === 'history' ? 'stats' : tab;
    setActiveTab(tab);
    navigate(`/quality#${hash}`);
  };

  const openImportedReports = (scope: QualityReportHistoryScope) => {
    setHistoryScope(scope);
    setActiveTab('history');
    navigate('/quality#stats');
  };

  const tabVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
    exit: { opacity: 0, y: -20, transition: { duration: 0.2 } }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 space-y-6">
      {/* 페이지 제목과 토글을 같은 줄에 배치 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
        <div className="flex items-center gap-3">
          <ClipboardList className="h-7 w-7 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">{t('brand_quality')}</h1>
        </div>
        <div className={`grid w-full rounded-lg border border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-1 sm:ml-2 sm:inline-flex sm:w-auto ${canEditQuality ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {canEditQuality && (
            <>
              <button
                onClick={() => selectTab('report')}
                aria-selected={activeTab === 'report'}
                className={`min-w-0 px-2 py-2 text-sm font-medium transition-all duration-200 sm:px-6 sm:text-base ${
                  activeTab === 'report'
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-gray-600 hover:text-blue-600'
                }`}
              >
                {t('quality.report_tab')}
              </button>
              <button
                onClick={() => selectTab('import')}
                aria-selected={activeTab === 'import'}
                className={`inline-flex min-w-0 items-center justify-center gap-1 px-2 py-2 text-sm font-medium transition-all duration-200 sm:gap-2 sm:px-6 sm:text-base ${
                  activeTab === 'import'
                    ? 'bg-cyan-600 text-white shadow-md'
                    : 'text-gray-600 hover:text-cyan-700'
                }`}
              >
                <FileSpreadsheet className="hidden h-4 w-4 shrink-0 min-[420px]:block" aria-hidden="true" />
                <span className="truncate">{t('quality.import_tab')}</span>
              </button>
            </>
          )}
          <button
            onClick={() => selectTab('history')}
            aria-selected={activeTab === 'history'}
            className={`min-w-0 px-2 py-2 text-sm font-medium transition-all duration-200 sm:px-6 sm:text-base ${
              activeTab === 'history'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-gray-600 hover:text-indigo-600'
            }`}
          >
            {t('quality.history_tab')}
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {canEditQuality && activeTab === 'report' && (
          <motion.div
            key="report"
            variants={tabVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <QualityReportForm />
          </motion.div>
        )}
        {activeTab === 'history' && (
          <motion.div
            key="history"
            variants={tabVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <QualityReportHistory
              reportScope={historyScope}
              onClearReportScope={() => setHistoryScope(null)}
            />
          </motion.div>
        )}
        {canEditQuality && activeTab === 'import' && (
          <motion.div
            key="import"
            variants={tabVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <QualityExcelImport onPostProcess={openImportedReports} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
