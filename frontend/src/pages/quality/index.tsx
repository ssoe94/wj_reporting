import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useLang } from '../../i18n';
import QualityReportForm from './QualityReportForm';
import QualityReportHistory from './QualityReportHistory';
import { ClipboardList } from 'lucide-react';

export default function QualityPage() {
  const { t } = useLang();
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'report' | 'history'>('report');

  useEffect(() => {
    setActiveTab(location.hash === '#stats' ? 'history' : 'report');
  }, [location.hash]);

  const selectTab = (tab: 'report' | 'history') => {
    const hash = tab === 'history' ? 'stats' : 'report';
    setActiveTab(tab);
    navigate(`/quality#${hash}`);
  };

  const tabVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
    exit: { opacity: 0, y: -20, transition: { duration: 0.2 } }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 space-y-6">
      {/* 페이지 제목과 토글을 같은 줄에 배치 */}
      <div className="flex items-center gap-4">
        <ClipboardList className="w-7 h-7 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900">{t('brand_quality')}</h1>
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 p-1 ml-2 rounded-lg inline-flex">
          <button
            onClick={() => selectTab('report')}
            aria-selected={activeTab === 'report'}
            className={`px-6 py-2 rounded-md font-medium transition-all duration-200 ${
              activeTab === 'report'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-600 hover:text-blue-600'
            }`}
          >
            {t('quality.report_tab')}
          </button>
          <button
            onClick={() => selectTab('history')}
            aria-selected={activeTab === 'history'}
            className={`px-6 py-2 rounded-md font-medium transition-all duration-200 ${
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
        {activeTab === 'report' && (
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
            <QualityReportHistory />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
